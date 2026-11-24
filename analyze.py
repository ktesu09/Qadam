"""
Qadam — ИИ-часть. Читает CSV из data/ и создаёт ai_results.json для сайта.

Запуск (из корня проекта):
    .venv/bin/python analyze.py
    .venv/bin/python analyze.py --perm 0      # без перестановочного теста (быстрее)

Что делает (подробно и простыми словами — в EXPLAIN.md):
  1. Значимые изменения: Verbal и VR против Baseline для каждого ребёнка (тест Манна — Уитни,
     поправка Холма на множественные сравнения).
  2. best_condition: Verbal или VR — что лучше для ребёнка; best_improves_baseline — лучше ли обычной ходьбы.
  3. Нестабильные шаги: робастный z-score (медиана и MAD) по параметрам и по форме кривых.
  4. Классификатор условия по параметрам цикла, проверка Leave-One-Subject-Out.
  5. Тексты для врача и для родителей на русском и казахском — по шаблону, без внешних API.

Все данные остаются на компьютере. ai_results.json публиковать нельзя (он в .gitignore).
"""
import argparse
import json
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import mannwhitneyu, wilcoxon
from sklearn.base import BaseEstimator, TransformerMixin, clone
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore", category=RuntimeWarning)

ROOT = Path(__file__).resolve().parent   # analyze.py лежит в корне проекта, рядом с data/
CONDITIONS = ["Baseline", "Verbal", "VR"]
FEEDBACK = ["Verbal", "VR"]
SEED = 42

# Параметры цикла. better="lower": меньше = ближе к норме (GPS, GVS).
# Для aMinSagH и pctmZeroStSagH направление неоднозначно → нейтрально, изменение в единицах, не в %.
PARAMS = {
    "GPS_a":          {"better": "lower", "unit": "°"},
    "GVS_aSagP":      {"better": "lower", "unit": "°"},
    "GVS_aSagH":      {"better": "lower", "unit": "°"},
    "GVS_aSagK":      {"better": "lower", "unit": "°"},
    "GVS_aSagA":      {"better": "lower", "unit": "°"},
    "aMinSagH":       {"better": None,    "unit": "°"},
    "pctmZeroStSagH": {"better": None,    "unit": "% GC"},
}
DIRECTIONAL = [k for k, v in PARAMS.items() if v["better"] == "lower"]
CURVES = ["aSagP", "aSagH", "aSagK", "aSagA", "mSagH"]

ALPHA = 0.05            # порог значимости после поправки Холма
MIN_PCT = 5.0           # меньшие изменения GPS/GVS не считаем клинически заметными
MIN_ABS = 2.0           # то же для aMinSagH (°) и pctmZeroStSagH (% цикла)
Z_LIMIT = 3.5           # порог робастного z-score для «нестабильного» шага
MAX_CHANGES = 6         # сколько значимых изменений выводить на ребёнка

# ——— Тексты ———
NAME = {
    "ru": {"GPS_a": "GPS", "GVS_aSagP": "таз", "GVS_aSagH": "бедро", "GVS_aSagK": "колено",
           "GVS_aSagA": "голеностоп", "aMinSagH": "наибольшее разгибание бедра",
           "pctmZeroStSagH": "смена момента бедра"},
    "kz": {"GPS_a": "GPS", "GVS_aSagP": "жамбас", "GVS_aSagH": "сан буыны", "GVS_aSagK": "тізе",
           "GVS_aSagA": "тобық", "aMinSagH": "санның ең үлкен жазылуы",
           "pctmZeroStSagH": "сан моментінің ауысуы"},
}
CURVE_NAME = {
    "ru": {"aSagP": "таз", "aSagH": "бедро", "aSagK": "колено", "aSagA": "голеностоп", "mSagH": "момент бедра"},
    "kz": {"aSagP": "жамбас", "aSagH": "сан буыны", "aSagK": "тізе", "aSagA": "тобық", "mSagH": "сан моменті"},
}
UNIT = {"ru": {"°": "°", "% GC": "% цикла", "Нм/кг": "Нм/кг"},
        "kz": {"°": "°", "% GC": "циклдің %", "Нм/кг": "Нм/кг"}}
COND_IN = {"ru": {"Verbal": "при словесной подсказке", "VR": "в VR"},
           "kz": {"Verbal": "ауызша нұсқау кезінде", "VR": "VR кезінде"}}
COND_SHORT = {"ru": {"Baseline": "обычная", "Verbal": "словесная", "VR": "VR"},
              "kz": {"Baseline": "қалыпты", "Verbal": "ауызша", "VR": "VR"}}
PARENT_WITH = {"ru": {"Verbal": "со словесными подсказками",
                      "VR": "с виртуальной реальностью (на экране был его персонаж)"},
               "kz": {"Verbal": "ауызша нұсқаулармен",
                      "VR": "виртуалды шынайылықпен (экранда оның кейіпкері болды)"}}
PARENT_ONE = {"ru": {"Verbal": "словесная подсказка", "VR": "виртуальная реальность"},
              "kz": {"Verbal": "ауызша нұсқау", "VR": "виртуалды шынайылық"}}
PARENT_NOM = {"ru": {"Verbal": "Словесные подсказки", "VR": "Виртуальная реальность"},
              "kz": {"Verbal": "Ауызша нұсқаулар", "VR": "Виртуалды шынайылық"}}


def fmt(x, digits=1, sign=False):
    """Число по-русски/по-казахски: запятая, настоящий минус."""
    s = f"{abs(x):.{digits}f}".replace(".", ",")
    if x < 0 and float(s.replace(",", ".")) != 0:
        return "−" + s
    return ("+" + s) if sign and float(s.replace(",", ".")) != 0 else s


def fmt_p(p):
    return "p < 0,001" if p < 0.001 else f"p = {fmt(p, 3)}"


# ——— 0. Чтение данных ———
def load():
    disc, kin = {}, {}
    for c in CONDITIONS:
        opts = dict(sep=";", decimal=",", na_values=["NaN", ""], keep_default_na=True)
        d = pd.read_csv(ROOT / "data" / f"Discrete_Parameters_{c}.csv", **opts)
        k = pd.read_csv(ROOT / "data" / f"Kinematics_Kinetics_{c}.csv", **opts)
        assert len(d) == len(k) and (d["subject"].values == k["subject"].values).all(), \
            f"{c}: строки параметров и кривых не совпадают"
        # номер цикла с 1 в порядке строк CSV — так же считает сайт
        for df in (d, k):
            df["cycle"] = df.groupby("subject").cumcount() + 1
            df["condition"] = c
        disc[c], kin[c] = d, k
    return disc, kin


def curve_matrix(k, sig):
    cols = [c for c in k.columns if c.startswith(sig + "_pct_GC_")]
    return k[cols].to_numpy(dtype=float)


# ——— 1. Значимые изменения ———
def holm(pvals):
    """Поправка Холма: защищает от ложных находок, когда тестов много (у нас 14 на ребёнка)."""
    p = np.asarray(pvals, dtype=float)
    order = np.argsort(p)
    m = len(p)
    adj = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[i]))
        adj[i] = running
    return adj


def compare(disc, subj):
    base = disc["Baseline"][disc["Baseline"].subject == subj]
    rows = []
    for c in FEEDBACK:
        cur = disc[c][disc[c].subject == subj]
        for prm, meta in PARAMS.items():
            a, b = base[prm].dropna().to_numpy(), cur[prm].dropna().to_numpy()
            if len(a) < 5 or len(b) < 5:
                continue
            p = mannwhitneyu(b, a, alternative="two-sided").pvalue
            ma, mb = float(a.mean()), float(b.mean())
            pct = (mb - ma) / abs(ma) * 100 if abs(ma) > 1e-9 else None
            rows.append({"parameter": prm, "condition": c, "p_raw": float(p),
                         "mean_baseline": ma, "mean_condition": mb,
                         "change_abs": mb - ma, "change_pct": pct, "unit": meta["unit"]})
    if not rows:
        return []
    for r, pa in zip(rows, holm([r["p_raw"] for r in rows])):
        r["p_value"] = float(pa)
        meta = PARAMS[r["parameter"]]
        big = abs(r["change_pct"]) >= MIN_PCT if meta["better"] else abs(r["change_abs"]) >= MIN_ABS
        r["significant"] = bool(pa < ALPHA and big)
        if meta["better"] == "lower":
            r["direction"] = "better" if r["change_abs"] < 0 else "worse"
        else:
            r["direction"] = "neutral"
    return rows


def public_change(r):
    out = {"parameter": r["parameter"], "condition": r["condition"]}
    if PARAMS[r["parameter"]]["better"] == "lower":
        out["change_pct"] = round(r["change_pct"], 1)   # для углов около нуля % не показываем
    out.update({"change_abs": round(r["change_abs"], 2), "unit": r["unit"],
                "p_value": float(f"{r['p_value']:.2g}"), "p_raw": float(f"{r['p_raw']:.2g}"),
                "direction": r["direction"],
                "mean_baseline": round(r["mean_baseline"], 2),
                "mean_condition": round(r["mean_condition"], 2)})
    return out


# ——— 3. Нестабильные шаги ———
def robust_z(x):
    """Модифицированный z-score (Iglewicz–Hoaglin): 0,6745·(x − медиана) / MAD. Не боится самих выбросов."""
    x = np.asarray(x, dtype=float)
    med = np.nanmedian(x)
    mad = np.nanmedian(np.abs(x - med))
    if not np.isfinite(mad) or mad < 1e-9:
        return np.zeros_like(x), med
    return 0.6745 * (x - med) / mad, med


def unstable(disc, kin, subj, cond):
    d = disc[cond][disc[cond].subject == subj].reset_index(drop=True)
    k = kin[cond][kin[cond].subject == subj].reset_index(drop=True)
    found = {}   # cycle -> list of (z, reason_ru, reason_kz)

    for prm in DIRECTIONAL:
        z, med = robust_z(d[prm])
        for i in np.where(np.abs(z) > Z_LIMIT)[0]:
            v = d.at[i, prm]
            hi = z[i] > 0
            u = PARAMS[prm]["unit"]
            name_ru = "GPS" if prm == "GPS_a" else f"Отклонение «{NAME['ru'][prm]}»"
            name_kz = "GPS" if prm == "GPS_a" else f"«{NAME['kz'][prm]}» ауытқуы"
            ru = (f"{name_ru} {fmt(v)}{u} — заметно {'выше' if hi else 'ниже'} обычного для этого условия "
                  f"(медиана {fmt(med)}{u})")
            kz = (f"{name_kz} {fmt(v)}{u} — осы жағдайдағы әдеттегіден айтарлықтай "
                  f"{'жоғары' if hi else 'төмен'} (медиана {fmt(med)}{u})")
            found.setdefault(int(d.at[i, "cycle"]), []).append((abs(z[i]), ru, kz))

    for sig in CURVES:
        m = curve_matrix(k, sig)
        ok = ~np.isnan(m).all(axis=1)
        if ok.sum() < 5:
            continue
        ref = np.nanmedian(m[ok], axis=0)
        dist = np.full(len(m), np.nan)
        dist[ok] = np.sqrt(np.nanmean((m[ok] - ref) ** 2, axis=1))
        # расстояния всегда > 0 и скошены вправо → z-score считаем по логарифму
        z, _ = robust_z(np.log(dist))
        med = float(np.nanmedian(dist))
        u = "Нм/кг" if sig == "mSagH" else "°"
        dg = 2 if sig == "mSagH" else 1
        for i in np.where(z > Z_LIMIT)[0]:   # только «слишком далеко», близость к медиане не проблема
            ru = (f"Кривая «{CURVE_NAME['ru'][sig]}» сильно отличается от остальных шагов "
                  f"(отклонение {fmt(dist[i], dg)} {UNIT['ru'][u]}, обычно {fmt(med, dg)})")
            kz = (f"«{CURVE_NAME['kz'][sig]}» қисығы басқа қадамдардан қатты ерекшеленеді "
                  f"(ауытқу {fmt(dist[i], dg)} {UNIT['kz'][u]}, әдетте {fmt(med, dg)})")
            found.setdefault(int(k.at[i, "cycle"]), []).append((float(z[i]), ru, kz))

    out = []
    for cyc, reasons in found.items():
        reasons.sort(key=lambda r: -r[0])
        top = reasons[:2]
        out.append({"condition": cond, "cycle": cyc,
                    "reason": "; ".join(r[1] for r in top),
                    "reason_kz": "; ".join(r[2] for r in top),
                    "score": round(top[0][0], 1)})
    out.sort(key=lambda r: -r["score"])
    return out, len(d)


# ——— 2а. Шкалы «Эффективность» и «Стабильность» (0–100, 50 = как Baseline) ———
def axis_scores(changes, unst, n_cycles, disc, subj):
    """Эффективность: (значимых улучшений − значимых ухудшений) / 5 параметров GPS/GVS → 0…100.
    Стабильность: коэффициент вариации GPS/GVS между шагами и доля нестабильных шагов, сравнение с Baseline.
      cv_part   = log2(средний CV условия / средний CV Baseline), обрезано до [−1, 1] (вдвое меньше … вдвое больше);
      unst_part = (доля нестабильных − доля в Baseline) / 0,20, обрезано до [−1, 1] (±20 п.п. = край шкалы);
      стабильность = 50 − 25·cv_part − 25·unst_part."""
    def mean_cv(c):
        d = disc[c][disc[c].subject == subj]
        cvs = [d[p].std() / d[p].mean() for p in DIRECTIONAL if d[p].notna().sum() > 2 and d[p].mean() > 0]
        return float(np.mean(cvs)) if cvs else None

    share = {c: len(unst[c]) / n_cycles[c] if n_cycles[c] else 0.0 for c in CONDITIONS}
    cv_base = mean_cv("Baseline")
    eff, stab, detail = {}, {}, {}
    for c in FEEDBACK:
        sig = [r for r in changes if r["condition"] == c and r["significant"] and r["direction"] != "neutral"]
        imp = sum(r["direction"] == "better" for r in sig)
        wor = sum(r["direction"] == "worse" for r in sig)
        eff[c] = round(50 + 50 * (imp - wor) / len(DIRECTIONAL))

        cv_c = mean_cv(c)
        cv_ratio = cv_c / cv_base if cv_c and cv_base else 1.0
        cv_part = float(np.clip(np.log2(cv_ratio), -1, 1))
        unst_part = float(np.clip((share[c] - share["Baseline"]) / 0.20, -1, 1))
        stab[c] = round(50 - 25 * cv_part - 25 * unst_part)
        detail[c] = {"improvements": imp, "worsenings": wor, "cv": round(cv_c, 3) if cv_c else None,
                     "cv_ratio": round(cv_ratio, 2), "unstable_share": round(share[c], 3)}
    detail["Baseline"] = {"cv": round(cv_base, 3) if cv_base else None, "unstable_share": round(share["Baseline"], 3)}
    return eff, stab, detail


# ——— 2. Лучшее условие ———
def best_condition(changes, unst, n_cycles, disc, subj, eff, stab):
    share = {c: len(unst[c]) / n_cycles[c] if n_cycles[c] else 0 for c in CONDITIONS}
    sd = {c: float(disc[c][disc[c].subject == subj]["GPS_a"].std()) for c in CONDITIONS}
    scores = {}
    for c in FEEDBACK:
        sig = [r for r in changes if r["condition"] == c and r["significant"] and r["direction"] != "neutral"]
        imp = sum(r["direction"] == "better" for r in sig)
        wor = sum(r["direction"] == "worse" for r in sig)
        gps = next((r for r in changes if r["condition"] == c and r["parameter"] == "GPS_a"), None)
        gps_worse = bool(gps and gps["significant"] and gps["direction"] == "worse")
        # «без потери стабильности» — то же правило, что и на шкале сайта: стабильность ≥ 50 (не хуже Baseline)
        stable = stab[c] >= 50
        # «возможная компенсация» — как на сайте: эффективность > 50, а стабильность < 50
        compensation = eff[c] > 50 and stab[c] < 50
        scores[c] = {"improvements": imp, "worsenings": wor, "net": imp - wor,
                     "stable": bool(stable), "compensation": bool(compensation), "gps_worse": gps_worse,
                     "efficiency_score": eff[c], "stability_score": stab[c],
                     "gps_change_pct": round(gps["change_pct"], 1) if gps else None,
                     "gps_sd": round(sd[c], 2), "unstable_share": round(share[c], 3)}
    # Лучшее выбираем ТОЛЬКО между Verbal и VR — врачу нужно знать, какую подсказку пробовать дальше.
    # Отдельно отмечаем, улучшило ли оно походку по сравнению с обычной ходьбой (improves_baseline).
    eligible = [c for c in FEEDBACK
                if scores[c]["net"] > 0 and scores[c]["stable"] and not scores[c]["gps_worse"]]
    pool = eligible or list(FEEDBACK)
    # Порядок: больше (улучшений − ухудшений) → меньше рост GPS → выше стабильность
    best = max(pool, key=lambda c: (scores[c]["net"], -(scores[c]["gps_change_pct"] or 0), scores[c]["stability_score"]))
    improves = bool(eligible)
    scores["Baseline"] = {"gps_sd": round(sd["Baseline"], 2), "unstable_share": round(share["Baseline"], 3)}
    return best, improves, scores


# ——— 5. Тексты ———
OTHER = {"Verbal": "VR", "VR": "Verbal"}
KZ_ACC = {"Verbal": "Verbal-ды", "VR": "VR-ды"}   # кого/что (табыс септік)
KZ_DAT = {"Verbal": "Verbal-ға", "VR": "VR-ға"}   # кому/чему (барыс септік)


def doctor_text(lang, changes, best, improves, scores, unst_counts, n_cycles):
    by = {(r["condition"], r["parameter"]): r for r in changes}
    # 1) GPS в обоих условиях
    parts = []
    for c in FEEDBACK:
        r = by.get((c, "GPS_a"))
        if not r:
            continue
        sig = fmt_p(r["p_value"]) if r["significant"] else ("незначимо" if lang == "ru" else "маңызды емес")
        parts.append(f"{c} {fmt(r['change_pct'], 1, sign=True)} % ({sig})")
    s1 = (f"Индекс GPS относительно обычной ходьбы: {', '.join(parts)}." if lang == "ru"
          else f"Қалыпты жүріспен салыстырғанда GPS индексі: {', '.join(parts)}.")

    # 2) самые сильные значимые изменения по суставам и разгибанию бедра
    joint = [r for r in changes if r["significant"] and r["parameter"] != "GPS_a"]
    joint.sort(key=lambda r: r["p_value"])
    items = []
    for r in joint[:3]:
        if r["change_pct"] is not None and PARAMS[r["parameter"]]["better"]:
            val = f"{fmt(r['change_pct'], 0, sign=True)} %"
        else:
            u = UNIT[lang][r["unit"]]
            val = f"{fmt(r['change_abs'], 1, sign=True)}{u if u == '°' else ' ' + u}"
        items.append(f"{NAME[lang][r['parameter']]} {COND_IN[lang][r['condition']]} {val}")
    if items:
        s2 = ("Значимые изменения: " if lang == "ru" else "Маңызды өзгерістер: ") \
             + "; ".join(items) + "."
    else:
        s2 = ("Других значимых изменений нет." if lang == "ru"
              else "Басқа маңызды өзгерістер жоқ.")

    # 3) вывод и стабильность
    cnt = " / ".join(str(unst_counts[c]) for c in CONDITIONS)
    comp = [c for c in FEEDBACK if scores[c]["compensation"]]
    o = OTHER[best]

    def example(c):
        """Пример улучшения для условия c: GPS, если он значимо снизился, иначе самый сильный значимый сустав."""
        good = [r for r in changes if r["condition"] == c and r["significant"] and r["direction"] == "better"
                and r["change_pct"] is not None]
        if not good:
            return None
        gps = [r for r in good if r["parameter"] == "GPS_a"]
        r = gps[0] if gps else max(good, key=lambda r: abs(r["change_pct"]))
        arrow = "↓" if r["change_pct"] < 0 else "↑"
        return f"{NAME[lang][r['parameter']]} {arrow} {fmt(abs(r['change_pct']), 1)} %"

    if comp:
        where = (" и " if lang == "ru" else " және ").join(COND_IN[lang][c] for c in comp)
        where = where[0].upper() + where[1:]
        ex = []
        for c in comp:
            e = example(c)
            if e:
                ex.append(f"{e} {COND_IN[lang][c]}" if len(comp) > 1 else e)
        nums = (" и " if lang == "ru" else " және ").join(str(scores[c]["stability_score"]) for c in comp)
    if lang == "ru":
        if improves:
            s3 = f"Больше значимых улучшений без потери стабильности — {COND_IN['ru'][best]}."
        elif comp:
            exs = f" (например, {', '.join(ex)})" if ex else ""
            s3 = (f"{best} переносится лучше, чем {o}. {where} походка стала ближе к норме{exs}, но шаги стали "
                  f"менее стабильными (стабильность {nums} из 100) — возможная компенсация, нужен повторный замер.")
        else:
            s3 = (f"{best} переносится лучше, чем {o}, но за одну сессию ни одно условие не улучшило походку — "
                  f"нужен повторный замер.")
        s4 = f"Нестабильных шагов {cnt} (обычная / словесная / VR)."
    else:
        if improves:
            s3 = f"Тұрақтылықты жоғалтпай ең көп маңызды жақсару — {COND_IN['kz'][best]}."
        elif comp:
            exs = f" (мысалы, {', '.join(ex)})" if ex else ""
            s3 = (f"{KZ_ACC[best]} бала {KZ_DAT[o]} қарағанда жақсырақ көтереді. {where} жүріс нормаға "
                  f"жақындады{exs}, бірақ қадамдар тұрақсыздау болды (тұрақтылық {nums} / 100) — ықтимал "
                  f"компенсация, қайта өлшеу керек.")
        else:
            s3 = (f"{KZ_ACC[best]} бала {KZ_DAT[o]} қарағанда жақсырақ көтереді, бірақ бір сессияда ешбір жағдай "
                  f"жүрісті жақсартпады — қайта өлшеу керек.")
        s4 = f"Тұрақсыз қадамдар {cnt} (қалыпты / ауызша / VR)."
    return " ".join([s1, s2, s3, s4])


def parent_text(lang, best, improves, scores, unst_counts, n_cycles):
    s = []
    comp = [c for c in FEEDBACK if scores[c]["compensation"]]
    if improves:
        o = OTHER[best]
        if lang == "ru":
            s.append(f"Когда ребёнок шёл {PARENT_WITH['ru'][best]}, его походка стала ближе к норме.")
            if scores[o]["gps_worse"] or scores[o]["net"] < 0:
                s.append(f"{PARENT_NOM['ru'][o]}, наоборот, не помогли: походка отклонялась от нормы сильнее."
                         if o == "Verbal" else
                         f"{PARENT_NOM['ru'][o]}, наоборот, не помогла: походка отклонялась от нормы сильнее.")
        else:
            s.append(f"Бала {PARENT_WITH['kz'][best]} жүргенде, оның жүрісі нормаға жақындай түсті.")
            if scores[o]["gps_worse"] or scores[o]["net"] < 0:
                s.append(f"{PARENT_NOM['kz'][o]}, керісінше, көмектеспеді: жүріс нормадан көбірек ауытқыды.")
    else:
        # Ни одна подсказка не улучшила походку за одно занятие: говорим, какая из двух далась легче
        if lang == "ru":
            if comp:
                # походка ближе к норме, но шаги неровные — не пишем «не стала лучше», это противоречило бы цифрам
                who = f"Когда ребёнок шёл {PARENT_WITH['ru'][comp[0]]}," if len(comp) == 1 else "С подсказками"
                s.append(f"Из двух подсказок ребёнку легче далась {PARENT_ONE['ru'][best]}.")
                s.append(f"{who} походка стала ближе к норме, но шаги стали менее ровными. "
                         f"Нужен повторный замер.")
            else:
                s.append(f"Из двух подсказок ребёнку легче далась {PARENT_ONE['ru'][best]}, "
                         f"но за одно занятие походка не стала лучше обычной. Нужен повторный замер.")
        else:
            if comp:
                who = f"Бала {PARENT_WITH['kz'][comp[0]]} жүргенде," if len(comp) == 1 else "Нұсқаулармен"
                s.append(f"Екі нұсқаудың ішінде балаға {PARENT_ONE['kz'][best]} оңайырақ болды.")
                s.append(f"{who} жүріс нормаға жақындады, бірақ қадамдар біркелкілігін жоғалтты. "
                         f"Қайта өлшеу керек.")
            else:
                s.append(f"Екі нұсқаудың ішінде балаға {PARENT_ONE['kz'][best]} оңайырақ болды, "
                         f"бірақ бір сабақта жүріс әдеттегіден жақсы болмады. Қайта өлшеу керек.")
    total = sum(unst_counts.values()) / max(1, sum(n_cycles.values()))
    if comp and not improves:
        # про неровные шаги уже сказано выше — не противоречим себе
        s.append("Решение о занятиях примет врач." if lang == "ru"
                 else "Жаттығулар туралы шешімді дәрігер қабылдайды.")
    elif lang == "ru":
        s.append("Большинство шагов были ровными. Решение о занятиях примет врач."
                 if total < 0.1 else
                 "Несколько шагов заметно отличались от остальных — врач посмотрит их отдельно и примет решение.")
    else:
        s.append("Қадамдардың көпшілігі біркелкі болды. Жаттығулар туралы шешімді дәрігер қабылдайды."
                 if total < 0.1 else
                 "Бірнеше қадам басқаларынан айтарлықтай өзгеше болды — дәрігер оларды бөлек қарап, шешім қабылдайды.")
    return " ".join(s)


# ——— 4. Классификатор условия ———
class PerSubjectZ(BaseEstimator, TransformerMixin):
    """Нормировка признаков внутри каждого ребёнка (по всем его шагам, БЕЗ меток условия).
    Убирает «почерк» ребёнка (рост, тяжесть ДЦП), оставляет то, что меняется между условиями.
    Последний столбец X — номер ребёнка; он используется только для группировки и удаляется."""
    def fit(self, X, y=None):
        return self

    def transform(self, X):
        X = np.asarray(X, dtype=float)
        g, F = X[:, -1], X[:, :-1].copy()
        for s in np.unique(g):
            m = g == s
            mu = np.nanmean(F[m], axis=0)
            sd = np.nanstd(F[m], axis=0)
            sd[~np.isfinite(sd) | (sd < 1e-9)] = 1.0
            F[m] = (F[m] - mu) / sd
        return F


class DropLast(BaseEstimator, TransformerMixin):
    def fit(self, X, y=None):
        return self

    def transform(self, X):
        return np.asarray(X, dtype=float)[:, :-1]


def features(disc, kin):
    rows = []
    for c in CONDITIONS:
        d, k = disc[c].reset_index(drop=True), kin[c].reset_index(drop=True)
        f = d[["subject", "cycle", "condition"] + list(PARAMS)].copy()
        for sig in CURVES:
            m = curve_matrix(k, sig)
            f[f"{sig}_mean"] = np.nanmean(m, axis=1)
            f[f"{sig}_min"] = np.nanmin(m, axis=1)
            f[f"{sig}_max"] = np.nanmax(m, axis=1)
        rows.append(f)
    return pd.concat(rows, ignore_index=True)


def run_cv(model, X, y, groups):
    pred = np.empty(len(y), dtype=object)
    for tr, te in LeaveOneGroupOut().split(X, y, groups):
        m = clone(model).fit(X[tr], y[tr])
        pred[te] = m.predict(X[te])
    return pred


def classifier(disc, kin, n_perm):
    t0 = time.time()
    F = features(disc, kin)
    feat_cols = [c for c in F.columns if c not in ("subject", "cycle", "condition")]
    subj_codes = pd.factorize(F["subject"])[0]
    X = np.column_stack([F[feat_cols].to_numpy(dtype=float), subj_codes])
    y = F["condition"].to_numpy()
    groups = F["subject"].to_numpy()

    rf = lambda: RandomForestClassifier(n_estimators=300, min_samples_leaf=3, random_state=SEED, n_jobs=-1)
    lr = lambda: LogisticRegression(max_iter=2000, C=1.0)
    models = {
        # главная модель объявлена заранее, остальные — для сравнения
        "main": ("Random Forest, признаки нормированы внутри ребёнка",
                 make_pipeline(PerSubjectZ(), SimpleImputer(strategy="constant", fill_value=0.0), rf())),
        "lr_z": ("Логистическая регрессия, признаки нормированы внутри ребёнка",
                 make_pipeline(PerSubjectZ(), SimpleImputer(strategy="constant", fill_value=0.0),
                               StandardScaler(), lr())),
        "rf_raw": ("Random Forest, сырые признаки",
                   make_pipeline(DropLast(), SimpleImputer(strategy="median"), rf())),
        "lr_raw": ("Логистическая регрессия, сырые признаки",
                   make_pipeline(DropLast(), SimpleImputer(strategy="median"), StandardScaler(), lr())),
        "dummy_major": ("Всегда самый частый класс",
                        make_pipeline(DropLast(), DummyClassifier(strategy="most_frequent"))),
        "dummy_random": ("Случайное угадывание с долями классов",
                         make_pipeline(DropLast(), DummyClassifier(strategy="stratified", random_state=SEED))),
    }
    res, preds = {}, {}
    for key, (name, model) in models.items():
        p = run_cv(model, X, y, groups)
        preds[key] = p
        res[key] = {"name": name, "accuracy": round(accuracy_score(y, p), 3),
                    "f1_macro": round(f1_score(y, p, average="macro"), 3)}
        print(f"  {name}: accuracy {res[key]['accuracy']}, F1 {res[key]['f1_macro']}")

    main_pred = preds["main"]
    per_subj = pd.Series(main_pred == y).groupby(groups).mean()
    # Дети независимы друг от друга → сравниваем точность по детям со случайными 1/3 (Уилкоксон)
    w_p = float(wilcoxon(per_subj.values - 1 / 3, alternative="greater").pvalue)

    # Перестановочный тест: перемешиваем метки условий ВНУТРИ каждого ребёнка и смотрим,
    # как часто «модель на мусоре» получает такую же точность
    perm_p = None
    if n_perm > 0:
        rng = np.random.default_rng(SEED)
        fast = make_pipeline(PerSubjectZ(), SimpleImputer(strategy="constant", fill_value=0.0),
                             RandomForestClassifier(n_estimators=100, min_samples_leaf=3,
                                                    random_state=SEED, n_jobs=-1))
        real = accuracy_score(y, run_cv(fast, X, y, groups))
        hits = 0
        for i in range(n_perm):
            yp = y.copy()
            for s in np.unique(groups):
                m = np.where(groups == s)[0]
                yp[m] = rng.permutation(yp[m])
            if accuracy_score(yp, run_cv(fast, X, yp, groups)) >= real:
                hits += 1
            if (i + 1) % 10 == 0:
                print(f"  перестановки: {i + 1}/{n_perm}")
        perm_p = (hits + 1) / (n_perm + 1)

    # Важность признаков (на всех данных — только для объяснения, не для оценки качества)
    full = clone(models["main"][1]).fit(X, y)
    imp = full[-1].feature_importances_
    top = [{"feature": feat_cols[i], "importance": round(float(imp[i]), 3)} for i in np.argsort(-imp)[:8]]

    cm = confusion_matrix(y, main_pred, labels=CONDITIONS)
    acc, f1 = res["main"]["accuracy"], res["main"]["f1_macro"]
    model = {
        "name": "Random Forest (условие по параметрам цикла)",
        "metric": "accuracy",
        "value": acc,
        "name_kz": "Random Forest (қадам параметрлері бойынша жағдай)",
        "validation": (f"Leave-One-Subject-Out: ребёнок из проверки не участвует в обучении; "
                       f"F1 {fmt(f1, 2)}; случайное угадывание {fmt(1 / 3, 2)}"),
        "validation_kz": (f"Leave-One-Subject-Out: тексерудегі бала оқытуға қатыспайды; "
                          f"F1 {fmt(f1, 2)}; кездейсоқ болжау {fmt(1 / 3, 2)}"),
        "f1_macro": f1,
        "chance_accuracy": round(1 / 3, 3),
        "dummy_accuracy": res["dummy_random"]["accuracy"],
        "majority_accuracy": res["dummy_major"]["accuracy"],
        "wilcoxon_p_vs_chance": float(f"{w_p:.2g}"),
        "permutation_p": None if perm_p is None else round(perm_p, 4),
        "permutations": n_perm,
        "per_subject_accuracy": {"min": round(per_subj.min(), 3), "median": round(per_subj.median(), 3),
                                 "max": round(per_subj.max(), 3)},
        "confusion_matrix": {"labels": CONDITIONS, "rows_true_cols_pred": cm.tolist()},
        "n_cycles": int(len(y)), "n_subjects": int(len(np.unique(groups))),
        "features": feat_cols,
        "top_features": top,
        "comparison": [v for k, v in res.items() if k != "main"],
        "note_ru": ("Признаки нормированы внутри каждого ребёнка по всем его шагам без меток условия, "
                    "поэтому модель различает условия у уже обследованного ребёнка, а не по одному шагу "
                    "незнакомого ребёнка. Циклы одного ребёнка никогда не попадают одновременно в обучение "
                    "и в проверку."),
    }
    model["extra"] = extra_analysis(F, feat_cols, models["main"][1])
    print(f"  классификатор: {time.time() - t0:.0f} с")
    return model, per_subj.to_dict()


# ——— 4б. Дополнительный анализ (добавлен ПОСЛЕ основного; главная модель и её метрики не меняются) ———
WINDOW = 5   # шагов в окне для задачи «б»


def score(name, y, pred, labels):
    """accuracy, F1 (macro) и случайный уровень: доля самого частого класса (accuracy «всегда отвечать одно и то же»)
    и 1/число классов для F1 (угадывание с долями классов)."""
    share = pd.Series(y).value_counts(normalize=True)
    r = {"name": name, "n": int(len(y)), "classes": labels,
         "accuracy": round(accuracy_score(y, pred), 3),
         "f1_macro": round(f1_score(y, pred, average="macro"), 3),
         "chance_accuracy": round(float(share.max()), 3),
         "chance_f1": round(1 / len(labels), 3),
         "confusion_matrix": confusion_matrix(y, pred, labels=labels).tolist()}
    print(f"  {name}: accuracy {r['accuracy']}, F1 {r['f1_macro']}, "
          f"случайно {r['chance_accuracy']} / F1 {r['chance_f1']} (n={r['n']})")
    return r


def extra_analysis(F, feat_cols, main_model):
    """Та же модель (Random Forest + нормировка внутри ребёнка), та же проверка Leave-One-Subject-Out."""
    out = {"note_ru": "Дополнительный анализ, добавлен после основного. Главная модель и её метрики не менялись.",
           "note_kz": "Қосымша талдау, негізгі талдаудан кейін қосылды. Негізгі модель мен оның көрсеткіштері өзгерген жоқ."}
    subj_codes = pd.factorize(F["subject"])[0]
    X = np.column_stack([F[feat_cols].to_numpy(dtype=float), subj_codes])
    groups = F["subject"].to_numpy()

    # а) Baseline против подсказки (Verbal + VR вместе)
    yb = np.where(F["condition"].to_numpy() == "Baseline", "Baseline", "Feedback")
    out["binary"] = score("а) Baseline против подсказки (Verbal+VR), один шаг",
                          yb, run_cv(main_model, X, yb, groups), ["Baseline", "Feedback"])

    # б) медиана 5 подряд идущих шагов (окна не пересекаются, остаток < 5 шагов отбрасывается)
    rows = []
    for (s, c), g in F.groupby(["subject", "condition"], sort=False):
        g = g.sort_values("cycle")
        for i in range(len(g) // WINDOW):
            w = g.iloc[i * WINDOW:(i + 1) * WINDOW]
            rows.append({"subject": s, "condition": c, **w[feat_cols].median(skipna=True).to_dict()})
    W = pd.DataFrame(rows)
    Xw = np.column_stack([W[feat_cols].to_numpy(dtype=float), pd.factorize(W["subject"])[0]])
    yw, gw = W["condition"].to_numpy(), W["subject"].to_numpy()
    out["window5"] = score(f"б) медиана {WINDOW} подряд идущих шагов, 3 условия",
                           yw, run_cv(main_model, Xw, yw, gw), CONDITIONS)
    out["window5"]["window"] = WINDOW
    return out


# ——— Сборка ———
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--perm", type=int, default=100, help="число перестановок (0 — пропустить)")
    ap.add_argument("--out", default=str(ROOT / "ai_results.json"))
    args = ap.parse_args()

    print("Читаю данные…")
    disc, kin = load()
    subjects = sorted(disc["Baseline"]["subject"].unique(), key=lambda s: int(s.split("_")[-1]))

    print("Классификатор условия…")
    model, child_acc = classifier(disc, kin, args.perm)

    print("Участники…")
    participants = {}
    for s in subjects:
        changes = compare(disc, s)
        unst, n_cycles = {}, {}
        for c in CONDITIONS:
            unst[c], n_cycles[c] = unstable(disc, kin, s, c)
        counts = {c: len(unst[c]) for c in CONDITIONS}
        eff, stab, axis_detail = axis_scores(changes, unst, n_cycles, disc, s)
        best, improves, scores = best_condition(changes, unst, n_cycles, disc, s, eff, stab)

        sig = sorted([r for r in changes if r["significant"]], key=lambda r: (r["p_value"], -abs(r["change_abs"])))
        participants[s] = {
            "best_condition": best,
            "best_improves_baseline": improves,
            "significant_changes": [public_change(r) for r in sig[:MAX_CHANGES]],
            "unstable_cycles": [u for c in CONDITIONS for u in unst[c]],
            "unstable_counts": counts,
            "cycles": n_cycles,
            "efficiency_score": eff,
            "stability_score": stab,
            "axis_detail": axis_detail,
            "condition_scores": scores,
            "model_accuracy_child": round(float(child_acc[s]), 3),
            "summary_ru": doctor_text("ru", changes, best, improves, scores, counts, n_cycles),
            "summary_kz": doctor_text("kz", changes, best, improves, scores, counts, n_cycles),
            "parent_summary_ru": parent_text("ru", best, improves, scores, counts, n_cycles),
            "parent_summary_kz": parent_text("kz", best, improves, scores, counts, n_cycles),
        }

    out = {
        "generated": time.strftime("%Y-%m-%d"),
        "disclaimer": "Вспомогательный инструмент, не диагноз. Решение принимает врач.",
        "model": model,
        "method": {
            "changes": f"Манн — Уитни по циклам шага, поправка Холма на 14 тестов у ребёнка, p < {ALPHA}, "
                       f"изменение ≥ {int(MIN_PCT)} % (GPS/GVS) или ≥ {int(MIN_ABS)} ед. (aMinSagH, pctmZeroStSagH)",
            "best_condition": "только Verbal или VR: сначала условия, улучшившие походку (улучшения − ухудшения > 0 среди значимых GPS/GVS, "
                              "GPS не ухудшился, stability_score ≥ 50); если таких нет — то, что переносится лучше: "
                              "больше (улучшения − ухудшения), меньше рост GPS, выше стабильность. best_improves_baseline — улучшило ли",
            "efficiency_score": "50 + 50·(значимых улучшений − значимых ухудшений) / 5 параметров GPS/GVS; 50 = как Baseline",
            "stability_score": "50 − 25·clip(log2(CV условия / CV Baseline)) − 25·clip((доля нестабильных − доля Baseline) / 0,2); 50 = как Baseline",
            "unstable": f"робастный z-score (медиана, MAD) > {Z_LIMIT} по GPS/GVS и по отклонению формы кривых",
        },
        "participants": participants,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    bests = pd.Series([p["best_condition"] + (" (лучше Baseline)" if p["best_improves_baseline"] else "") for p in participants.values()]).value_counts().to_dict()
    n_un = sum(sum(p["unstable_counts"].values()) for p in participants.values())
    print(f"\nГотово: {args.out}")
    print(f"  участников: {len(participants)}; лучшее условие: {bests}; нестабильных шагов: {n_un}")
    print(f"  модель: accuracy {model['value']}, F1 {model['f1_macro']}, случайно {model['chance_accuracy']}, "
          f"перестановочный p {model['permutation_p']}")
    for k in ("binary", "window5"):
        e = model["extra"][k]
        print(f"  доп. {e['name']}: accuracy {e['accuracy']}, F1 {e['f1_macro']}, "
              f"случайно {e['chance_accuracy']} / F1 {e['chance_f1']}")


if __name__ == "__main__":
    main()
