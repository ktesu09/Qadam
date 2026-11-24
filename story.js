/* Qadam — экран участника: «история шага». */
(function () {
  const K = window.Kadam;
  const { t, CONDITIONS, PARAMS, SIGNALS, POINTS } = K;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ROMAN = { Baseline: 'I', Verbal: 'II', VR: 'III' };
  const charts = []; // активные графики Chart.js — уничтожаем при перерисовке

  /* ——— мелкие помощники ——— */
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  function svg(tag, attrs = {}) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }
  function fmt(v, digits = 1) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    // ru-RU для обоих языков: в Казахстане тоже десятичная запятая, а kk-KZ в браузерах иногда даёт точку
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  }
  const MINUS = '−';
  function signed(v, digits = 1) {
    if (v === null || !Number.isFinite(v)) return '—';
    const s = fmt(Math.abs(v), digits);
    return (v > 0.0000001 ? '+' : v < -0.0000001 ? MINUS : '') + s;
  }
  function unitOf(p) { return p.unit === '%GC' ? ` ${t('unitGc')}` : '°'; }
  function secHead(no, title, note) {
    return el('header', { class: 'sec-head' },
      el('div', {}, el('span', { class: 'sec-no', text: no }), el('h2', { text: title })),
      note ? el('p', { class: 'sec-head__note', text: note }) : null);
  }

  /* Текст изменения относительно Baseline */
  function changeNode(p, base, value) {
    const ch = K.change(p, base, value);
    if (!ch) return null; // нет значения — «нет данных» уже написано рядом
    if (p.unit) {
      return el('span', { class: 'chg chg--neutral' }, el('b', { text: `${signed(ch.delta)}${unitOf(p)}` }), ` ${t('vsBaseline')}`);
    }
    if (Math.abs(ch.pct) < 1) return el('span', { class: 'chg chg--neutral' }, el('b', { text: t('noChange') }));
    const arrow = ch.pct < 0 ? '↓' : '↑';
    const word = ch.verdict === 'better' ? t('better') : ch.verdict === 'worse' ? t('worse') : '';
    return el('span', { class: `chg chg--${ch.verdict}` },
      el('b', { text: `${arrow} ${fmt(Math.abs(ch.pct))} %` }),
      word ? el('span', { class: 'chg__word', text: word }) : null);
  }

  /* ——— 1. Шапка участника ——— */
  function head(subject, onBack) {
    const no = (subject.id.match(/(\d+)\s*$/) || [, subject.id])[1];
    const meta = [subject.id];
    if (subject.weight) meta.push(`${fmt(subject.weight, 1)} ${t('kg')}`);
    if (subject.height) meta.push(`${fmt(subject.height, 2)} ${t('m')}`);
    const side = subject.side === 'LEFT' || subject.side === 'RIGHT' ? subject.side : null;

    // плитка как у логотипа: цитрус + тёмный след нужной ноги
    const foot = svg('svg', { viewBox: '0 0 64 64', class: 'side-mark__foot', 'aria-hidden': 'true' });
    foot.append(svg('rect', { width: 64, height: 64, rx: 8 }));
    const use = svg('use', { href: '#foot', x: 18, y: 8, width: 26, height: 48 });
    if (side === 'LEFT') use.setAttribute('transform', 'translate(62 0) scale(-1 1)');
    foot.append(use);

    return el('div', { class: 'p-head' },
      el('div', { class: 'p-head__main' },
        el('a', { href: '#', class: 'back', onclick: (e) => { e.preventDefault(); onBack(); } }, `← ${t('back')}`),
        el('span', { class: 'sec-no', text: `03 · ${t('storyTitle')}` }),
        el('h1', { class: 'p-head__title' }, `${t('participant')} `, el('span', { class: 'p-head__no', text: no })),
        el('p', { class: 'p-head__meta', text: meta.join(' · ') })),
      side ? el('div', { class: `side-mark side-mark--${side.toLowerCase()}`, role: 'note', 'aria-label': `${t('side')}: ${t(side)}` },
        foot,
        el('div', {},
          el('span', { class: 'side-mark__code', text: side }),
          el('span', { class: 'side-mark__word', text: t(side) }))) : null);
  }

  /* ——— 2. Панель отчёта: «Для врача / Для родителей», печать ——— */
  // Вид отчёта помним в браузере (только удобство; без localStorage просто «для врача»)
  let audience = 'doctor';
  try { if (localStorage.getItem('kadam-audience') === 'parents') audience = 'parents'; } catch (e) { /* приватный режим */ }

  function setAudience(root, id, value) {
    audience = value;
    try { localStorage.setItem('kadam-audience', value); } catch (e) { /* ничего */ }
    root.classList.toggle('is-parents', value === 'parents');
    root.querySelectorAll('.seg__btn[data-aud]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aud === value)));
    const old = root.querySelector('#ai-block');
    if (old) old.replaceWith(aiSlot(id));
  }

  function tools(root, id) {
    const seg = (value, label) => el('button', { type: 'button', class: 'seg__btn', 'data-aud': value,
      'aria-pressed': String(audience === value), onclick: () => setAudience(root, id, value), text: t(label) });
    return el('div', { class: 'p-tools' },
      el('div', { class: 'seg', role: 'group', 'aria-label': t('reportFor') },
        seg('doctor', 'forDoctor'), seg('parents', 'forParents')),
      el('button', { type: 'button', class: 'btn btn--primary', onclick: () => window.print(), text: t('print') }),
      el('button', { type: 'button', class: 'btn', disabled: true, text: t('download') }),
      el('span', { class: 'later', text: t('later') }));
  }

  /* ——— 3. История шага: три разворота ——— */
  function spreads(id) {
    const wrap = el('div', { class: 'spreads' });
    for (const cond of CONDITIONS) {
      const rows = K.store.discrete[cond] && K.store.discrete[cond].get(id);
      const kin = K.store.kinematics[cond] && K.store.kinematics[cond].get(id);
      const n = rows ? rows.length : kin ? kin.length : 0;
      const page = el('article', { class: `spread spread--${cond.toLowerCase()}` },
        el('header', { class: 'spread__head' },
          el('span', { class: 'spread__roman', text: ROMAN[cond], 'aria-hidden': 'true' }),
          el('div', {},
            el('h3', { class: 'spread__title', text: t(`cond_${cond}`) }),
            el('p', { class: 'spread__code', text: cond }))),
        el('p', { class: 'spread__cycles' }, el('b', { text: n || '—' }), ` ${t('cyclesOf')}`));
      // метки из заключения ИИ — в контейнере одинаковой высоты, чтобы цифры в разворотах стояли ровно
      const aiPart = aiFor(id);
      const flags = el('div', { class: `spread__flags${aiPart ? ' has-ai' : ''}` });
      if (aiPart && normCond(aiPart.best_condition) === cond) {
        flags.append(el('p', { class: 'spread__ai', text: t(aiPart.best_improves_baseline === false ? 'aiBestMarkSoft' : 'aiBestMark') }));
      }
      if (aiPart && Array.isArray(aiPart.unstable_cycles)) {
        const k = aiPart.unstable_cycles.filter((u) => u && normCond(u.condition) === cond).length;
        if (k) flags.append(el('p', { class: 'spread__unstable', text: `${t('aiUnstableShort')}: ${k}` }));
      }
      page.append(flags);

      if (!rows) {
        page.append(el('p', { class: 'spread__empty', text: t('noData') }));
        wrap.append(page);
        continue;
      }
      // Главная цифра — GPS
      const gps = PARAMS[0];
      const s = K.paramStats(id, cond, gps.key);
      const b = K.paramStats(id, 'Baseline', gps.key);
      page.append(el('div', { class: 'hero' },
        el('p', { class: 'hero__label', text: t('p_GPS_a') }),
        el('p', { class: 'hero__num' }, fmt(s.mean), el('span', { class: 'hero__unit', text: '°' })),
        el('p', { class: 'hero__chg' }, cond === 'Baseline' ? el('span', { class: 'chg chg--ref', text: t('baselineRef') }) : changeNode(gps, b && b.mean, s.mean)),
        el('p', { class: 'hero__hint', text: t('h_GPS_a') })));

      const list = el('dl', { class: 'plist' });
      for (const p of PARAMS.slice(1)) {
        const ps = K.paramStats(id, cond, p.key);
        const pb = K.paramStats(id, 'Baseline', p.key);
        list.append(el('div', { class: 'plist__row' },
          el('dt', { text: t(`p_${p.key}`) }),
          el('dd', { class: 'plist__val' }, ps && ps.n ? `${fmt(ps.mean)}${p.unit === '%GC' ? ' %' : '°'}` : t('noData')),
          el('dd', { class: 'plist__chg' }, cond === 'Baseline' ? '' : changeNode(p, pb && pb.mean, ps && ps.mean))));
      }
      page.append(list);
      wrap.append(page);
    }
    return wrap;
  }

  /* ——— 5. Шкалы «Эффективность» и «Стабильность» (0–100, 50 = как Baseline) из ai_results.json ——— */
  const FEEDBACK = ['Verbal', 'VR'];
  function scoreOf(obj, cond) {
    const v = obj && typeof obj === 'object' ? obj[cond] : null;
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
  }

  function axes(id) {
    const part = aiFor(id);
    const eff = part && part.efficiency_score, stab = part && part.stability_score;
    const has = FEEDBACK.some((c) => scoreOf(eff, c) !== null || scoreOf(stab, c) !== null);
    if (!has) {
      return el('section', { class: 'block axes-block' },
        secHead('05', t('axesTitle'), null),
        el('p', { class: 'placeholder__text', text: t(K.store.ai ? 'axesNoData' : 'axesEmpty') }));
    }

    // Шкала: линия 0–100, Baseline посередине; Verbal — подпись сверху, VR — снизу (не налезают друг на друга)
    const axis = (name, obj) => {
      const track = el('div', { class: 'axis__track' },
        el('span', { class: 'axis__line', 'aria-hidden': 'true' }),
        el('span', { class: 'axis__base', 'aria-hidden': 'true' }));
      const said = [];
      // если отметки почти совпадают — разводим их чуть вверх/вниз, чтобы одна не закрывала другую
      const vals = FEEDBACK.map((c) => scoreOf(obj, c));
      const close = vals.every((v) => v !== null) && Math.abs(vals[0] - vals[1]) < 4;
      for (const c of FEEDBACK) {
        const v = scoreOf(obj, c);
        if (v === null) continue;
        said.push(`${c} ${fmt(v, 0)}`);
        track.append(
          el('span', { class: `axis__mark axis__mark--${c.toLowerCase()}${close ? ' is-split' : ''}`, style: `left:${v}%`, 'aria-hidden': 'true' }),
          // у краёв шкалы подпись прижимаем внутрь, чтобы не вылезала за экран
          el('span', { class: `axis__label axis__label--${c.toLowerCase()}`, 'aria-hidden': 'true',
            style: `left:${v}%;transform:translateX(${v < 12 ? '-12px' : v > 88 ? 'calc(-100% + 12px)' : '-50%'})` },
            `${c} `, el('b', { text: fmt(v, 0) })));
      }
      return el('div', { class: 'axis', role: 'img', 'aria-label': `${name}: ${said.join(', ')}; Baseline 50` },
        el('p', { class: 'axis__name', text: name }),
        track,
        el('p', { class: 'axis__ends', 'aria-hidden': 'true' },
          el('span', { text: `0 · ${t('axisLow')}` }),
          el('span', { class: 'axis__ends-base', text: 'Baseline 50' }),
          el('span', { text: `${t('axisHigh')} · 100` })));
    };

    const sec = el('section', { class: 'block axes-block' },
      secHead('05', t('axesTitle'), t('axesNote')),
      el('div', { class: 'axes' }, axis(t('axisEff'), eff), axis(t('axisStab'), stab)));

    // Эффективность выше 50, а стабильность ниже 50 — возможная компенсация (одно предупреждение на все такие условия)
    const comp = FEEDBACK.filter((c) => {
      const e = scoreOf(eff, c), s = scoreOf(stab, c);
      return e !== null && s !== null && e > 50 && s < 50;
    });
    if (comp.length) {
      sec.append(el('p', { class: 'axes__warn', role: 'note' },
        el('b', { text: `${comp.join(', ')}. ` }), t('axesWarn')));
    }
    sec.append(el('p', { class: 'axes__explain', text: t('axesExplain') }));
    return sec;
  }

  /* ——— 4. Заключение ИИ из ai_results.json. Нет поля — нет блока. ——— */
  function normCond(c) {
    if (typeof c !== 'string') return null;
    return CONDITIONS.find((x) => x.toLowerCase() === c.trim().toLowerCase()) || null;
  }
  function aiFor(id) {
    const ai = K.store.ai;
    if (!ai || typeof ai !== 'object' || !ai.participants || typeof ai.participants !== 'object') return null;
    const p = ai.participants[id];
    return p && typeof p === 'object' ? p : null;
  }
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const condName = (c) => (normCond(c) ? `${t(`cond_${normCond(c)}`)} (${normCond(c)})` : String(c));
  const paramName = (k) => (PARAMS.some((p) => p.key === k) ? t(`p_${k}`) : String(k));

  function modelLine(m) {
    if (!m || typeof m !== 'object') return null;
    const parts = [];
    const kz = K.getLang() === 'kz';
    const name = (kz && m.name_kz) || m.name;
    const validation = (kz && m.validation_kz) || m.validation;
    if (name) parts.push(`${t('aiModel')}: ${name}`);
    if (m.metric && isNum(m.value)) parts.push(`${m.metric} ${fmt(m.value, 2)}`);
    if (validation) parts.push(`${t('aiValidation')}: ${validation}`);
    return parts.length ? parts.join(' · ') : null;
  }

  // Общие метрики модели из ai/analyze.py (Leave-One-Subject-Out по 29 детям).
  // Данных отдельных детей здесь нет — поэтому карточка видна всегда, даже без ai_results.json.
  const MODEL_CARD = { accuracy: 0.556, f1: 0.551, chance: 0.333, permutation_p: 0.0099, cycles: 2606 };

  function modelCard() {
    const m = MODEL_CARD;
    const num = (label, v) => el('div', { class: 'mcard__num' }, el('dt', { text: label }), el('dd', { text: fmt(v, 2) }));
    const p = m.permutation_p < 0.001 ? 'p < 0,001' : `p = ${fmt(m.permutation_p, 3)}`;
    return el('div', { class: 'mcard' },
      el('h3', { text: t('mcTitle') }),
      el('p', { text: t('mcMethod') }),
      el('p', { text: t('mcValidation').replace('{c}', new Intl.NumberFormat('ru-RU').format(m.cycles)) }),
      el('dl', { class: 'mcard__nums' }, num(t('mcAcc'), m.accuracy), num(t('mcF1'), m.f1), num(t('mcChance'), m.chance)),
      el('p', { class: 'mcard__note', text: t('mcNote').replace('{p}', p) }));
  }

  // Демо-файл (mock_ai.json, "demo": true) — крупная пометка, чтобы выдуманные числа не приняли за настоящие
  const isDemo = () => !!(K.store.ai && K.store.ai.demo === true);
  function demoBanner() {
    return el('div', { class: 'ai__demo', role: 'note' }, el('b', { text: t('aiDemo') }), el('span', { text: t('aiDemoText') }));
  }

  function aiSlot(id) {
    if (!K.store.ai) {
      const sec = el('section', { class: 'block ai', id: 'ai-block' }, secHead('04', t('aiTitle'), null));
      if (audience !== 'parents') sec.append(modelCard());
      sec.append(el('p', { class: 'placeholder__text ai__hint', text: t('aiEmpty') }));
      return sec;
    }
    const part = aiFor(id);
    const parents = audience === 'parents';
    const sec = el('section', { class: 'block ai', id: 'ai-block' }, secHead('04', t('aiTitle'), parents ? null : modelLine(K.store.ai.model)));
    if (isDemo()) sec.append(demoBanner());
    if (!part) {
      sec.append(el('p', { class: 'placeholder__text', text: t('aiNoParticipant') }));
      return sec;
    }

    const main = el('div', { class: 'ai__main' });
    const side = el('div', { class: 'ai__side' });

    // Текст для врача или для родителей: на выбранном языке, иначе — на другом с пометкой
    const base = parents ? 'parent_summary' : 'summary';
    const want = `${base}_${K.getLang() === 'kz' ? 'kz' : 'ru'}`;
    const other = want.endsWith('_kz') ? `${base}_ru` : `${base}_kz`;
    const text = typeof part[want] === 'string' && part[want].trim() ? part[want] : typeof part[other] === 'string' && part[other].trim() ? part[other] : null;
    if (text) {
      main.append(el('blockquote', { class: 'ai__summary' }, el('p', { text })));
      if (text !== part[want]) main.append(el('p', { class: 'ai__lang', text: t(other.endsWith('_ru') ? 'aiOnlyRu' : 'aiOnlyKz') }));
    } else if (parents) {
      main.append(el('p', { class: 'placeholder__text', text: t('aiNoParent') }));
    }

    const best = normCond(part.best_condition);
    if (best) {
      main.append(el('div', { class: 'ai__best' },
        el('span', { class: 'ai__best-label', text: t(parents ? 'aiBestParent' : 'aiBest') }),
        el('span', { class: 'ai__best-val' }, el('span', { class: 'spread__roman', text: ROMAN[best], 'aria-hidden': 'true' }), ` ${t(`cond_${best}`)}`),
        part.best_improves_baseline === false ? el('p', { class: 'ai__best-note', text: t('aiNotImproves') }) : null));
    }

    if (parents) {
      // Родителям — только простой текст и лучшее условие: без таблиц, p-value и номеров шагов
      sec.append(main, el('p', { class: 'ai__note', text: t('aiNoteParent') }));
      return sec;
    }

    const changes = Array.isArray(part.significant_changes) ? part.significant_changes.filter((c) => c && c.parameter && (isNum(c.change_pct) || isNum(c.change_abs))) : [];
    if (changes.length) {
      const tbody = el('tbody');
      for (const c of changes) {
        const p = PARAMS.find((x) => x.key === c.parameter);
        let verdict = 'neutral';
        if (p && p.better === 'lower' && isNum(c.change_pct) && Math.abs(c.change_pct) >= 1) verdict = c.change_pct < 0 ? 'better' : 'worse';
        // Для углов и времени (aMinSagH, pctmZeroStSagH) % у нуля взрывается → показываем Δ в единицах
        const val = isNum(c.change_pct) ? c.change_pct : c.change_abs;
        const unit = isNum(c.change_pct) ? ' %' : p ? unitOf(p) : '';
        const pv = isNum(c.p_value) ? (c.p_value < 0.001 ? 'p < 0,001' : `p = ${fmt(c.p_value, 3)}`) : '';
        tbody.append(el('tr', {},
          el('th', { scope: 'row' }, paramName(c.parameter), el('small', { text: c.condition ? normCond(c.condition) || String(c.condition) : '' })),
          el('td', { class: `chg chg--${verdict}` }, el('b', { text: `${val < 0 ? '↓' : '↑'} ${fmt(Math.abs(val))}${unit}` })),
          el('td', { class: 'ai__p', text: pv })));
      }
      side.append(el('div', { class: 'ai__part' },
        el('h3', { text: t('aiChanges') }),
        el('table', { class: 'ai__table' }, tbody)));
    }

    const unstable = Array.isArray(part.unstable_cycles) ? part.unstable_cycles.filter((u) => u && (u.cycle !== undefined || u.reason)) : [];
    if (unstable.length) {
      side.append(el('div', { class: 'ai__part' },
        el('h3', { text: t('aiUnstable') }),
        el('ul', { class: 'ai__list' }, unstable.map((u) => el('li', {},
          el('b', { text: `${u.condition ? normCond(u.condition) || u.condition : ''}${u.cycle !== undefined ? ` · ${t('aiCycle')} ${u.cycle}` : ''}` }),
          (K.getLang() === 'kz' && u.reason_kz) || u.reason ? el('span', { text: String((K.getLang() === 'kz' && u.reason_kz) || u.reason) }) : null)))));
    }

    if (!main.childElementCount && !side.childElementCount) {
      sec.append(el('p', { class: 'placeholder__text', text: t('aiNoParticipant') }));
      return sec;
    }
    sec.append(el('div', { class: 'ai__grid' }, main, side.childElementCount ? side : null),
      el('p', { class: 'ai__note', text: t('aiNote') }));
    return sec;
  }

  /* ——— 6. Параметры: точка = среднее, линия = ± SD ——— */
  const SERIES = {
    Baseline: { color: '#8B909B', dash: [], width: 2 },
    Verbal: { color: '#14213A', dash: [7, 5], width: 2 },
    VR: { color: '#7E8C12', dash: [], width: 3 },
  };

  function dotPlots(id) {
    const box = el('div', { class: 'dots' });
    for (const p of PARAMS) {
      const st = CONDITIONS.map((c) => ({ c, s: K.paramStats(id, c, p.key) })).filter((x) => x.s && x.s.n);
      const row = el('div', { class: 'dots__row' },
        el('div', { class: 'dots__name' }, el('span', { text: t(`p_${p.key}`) }), el('small', { text: p.unit === '%GC' ? t('unitGc') : t('unitAngle') })));
      if (!st.length) { row.append(el('p', { class: 'dots__empty', text: t('noData') })); box.append(row); continue; }
      let lo = Math.min(...st.map((x) => x.s.mean - x.s.sd));
      let hi = Math.max(...st.map((x) => x.s.mean + x.s.sd));
      const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
      // На узком экране: viewBox по ширине экрана (иначе SVG сжимается и подписи ~9px),
      // а подписи ставим над своей линией по центру точки — сбоку они не помещаются
      const narrow = window.innerWidth < 700;
      const W = narrow ? Math.max(320, window.innerWidth - 32) : 600, L = 8, R = 8;
      const x = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
      const labW = (q) => `${q.c} ${fmt(q.s.mean)}`.length * 8.5;   // ширина подписи ~8,5px на знак
      const fitsRight = (q) => x(q.s.mean + q.s.sd) + 8 + labW(q) <= W - R;
      const fitsLeft = (q) => x(q.s.mean - q.s.sd) - 8 - labW(q) >= L;
      // подписи над линиями: на телефоне всегда, на компьютере — если сбоку хоть одна не помещается
      const above = narrow || st.some((q) => !fitsRight(q) && !fitsLeft(q));
      const GAP = above ? 38 : 22, TOP = above ? 32 : 16;
      const H = above ? TOP + GAP * 2 + 34 : 96;
      const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dots__svg', role: 'img',
        'aria-label': `${t(`p_${p.key}`)}: ${st.map((q) => `${q.c} ${fmt(q.s.mean)}`).join(', ')}` });
      g.append(svg('line', { x1: L, x2: W - R, y1: H - 18, y2: H - 18, class: 'dots__axis' }));
      // подписи оси — только края
      [[lo, 'start', L], [hi, 'end', W - R]].forEach(([v, anchor, px]) => {
        const tx = svg('text', { x: px, y: H - 2, 'text-anchor': anchor, class: 'dots__tick' }); tx.textContent = fmt(v); g.append(tx);
      });
      st.forEach((q, i) => {
        const y = TOP + i * GAP;
        const ser = SERIES[q.c];
        g.append(svg('line', { x1: x(q.s.mean - q.s.sd), x2: x(q.s.mean + q.s.sd), y1: y, y2: y, stroke: ser.color, 'stroke-width': 2, 'stroke-dasharray': ser.dash.join(' ') }));
        g.append(svg('circle', { cx: x(q.s.mean), cy: y, r: 6.5, fill: q.c === 'VR' ? '#C7D93B' : ser.color, stroke: '#14213A', 'stroke-width': q.c === 'VR' ? 1.5 : 0 }));
        const text = `${q.c} ${fmt(q.s.mean)}`;
        const lab = svg('text', { x: x(q.s.mean + q.s.sd) + 8, y: y + 5, class: 'dots__lab' });
        lab.textContent = text;
        if (above) {
          // над линией, по центру точки, но не за краями
          const half = labW(q) / 2;
          lab.setAttribute('x', Math.min(W - R - half, Math.max(L + half, x(q.s.mean))));
          lab.setAttribute('y', y - 12);
          lab.setAttribute('text-anchor', 'middle');
        } else if (!fitsRight(q)) {
          // не влезает справа — ставим слева
          lab.setAttribute('x', x(q.s.mean - q.s.sd) - 8); lab.setAttribute('text-anchor', 'end');
        }
        g.append(lab);
      });
      row.append(g);
      box.append(row);
    }
    return el('section', { class: 'block' }, secHead('06', t('paramsTitle'), t('paramsNote')), box);
  }

  /* ——— 7. Средние кривые (Chart.js) с подписями у линий ——— */
  const endLabels = {
    id: 'endLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      const items = [];
      chart.data.datasets.forEach((ds, i) => {
        if (!ds.endLabel || !chart.isDatasetVisible(i)) return;
        const meta = chart.getDatasetMeta(i);
        let pt = null;
        for (let j = meta.data.length - 1; j >= 0; j--) if (ds.data[j] !== null) { pt = meta.data[j]; break; }
        if (pt) items.push({ y: pt.y, text: ds.endLabel, color: ds.borderColor });
      });
      items.sort((a, b) => a.y - b.y);
      for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 17) items[i].y = items[i - 1].y + 17;
      ctx.save();
      ctx.font = '800 14px Nunito, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const it of items) { ctx.fillStyle = it.color === '#7E8C12' ? '#5D680A' : it.color; ctx.fillText(it.text, chartArea.right + 8, it.y); }
      ctx.restore();
    },
  };

  function curves(id) {
    const grid = el('div', { class: 'curves' });
    const labels = Array.from({ length: POINTS }, (_, i) => i * 2);
    for (const sig of SIGNALS) {
      const fig = el('figure', { class: 'curve' },
        el('figcaption', {}, el('b', { text: t(`s_${sig}`) }), el('span', { text: sig === 'mSagH' ? t('unitMoment') : t('unitAngle') })));
      const data = {};
      for (const c of CONDITIONS) data[c] = K.meanCurve(id, c, sig);
      if (!CONDITIONS.some((c) => data[c])) { fig.append(el('p', { class: 'curve__empty', text: t('noData') })); grid.append(fig); continue; }
      const canvas = el('canvas', { role: 'img', 'aria-label': `${t(`s_${sig}`)} — Baseline, Verbal, VR` });
      fig.append(el('div', { class: 'curve__box' }, canvas));
      grid.append(fig);

      const datasets = [];
      const b = data.Baseline;
      if (b) {
        datasets.push({ data: b.mean.map((m, i) => (m === null ? null : m + b.sd[i])), borderWidth: 0, pointRadius: 0, fill: false, backgroundColor: 'rgba(139,144,155,.16)' });
        datasets.push({ data: b.mean.map((m, i) => (m === null ? null : m - b.sd[i])), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(139,144,155,.16)' });
      }
      for (const c of CONDITIONS) {
        if (!data[c]) continue;
        const s = SERIES[c];
        datasets.push({ data: data[c].mean, endLabel: c, borderColor: s.color, borderDash: s.dash, borderWidth: s.width, pointRadius: 0, tension: 0.25, fill: false });
      }
      charts.push({ canvas, sig, config: {
        type: 'line', data: { labels, datasets }, plugins: [endLabels],
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
          layout: { padding: { right: 78, top: 6 } },
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: {
            x: { type: 'linear', min: 0, max: 100, grid: { display: false }, border: { color: '#14213A' },
              ticks: { stepSize: 25, color: '#5A6070', font: { family: 'Nunito', size: 14 }, callback: (v) => `${v}%` } },
            y: { grid: { color: '#ECEEF1', drawTicks: false }, border: { display: false },
              ticks: { maxTicksLimit: 5, color: '#5A6070', padding: 8, font: { family: 'Nunito', size: 14 } } },
          },
        },
      } });
      // Chart.js с линейной осью X ждёт точки {x, y}
      datasets.forEach((ds) => { ds.data = ds.data.map((y, i) => ({ x: labels[i], y })); });
    }
    return el('section', { class: 'block' }, secHead('07', t('curvesTitle'), t('curvesNote')), grid);
  }

  /* ——— Карточка пациента для печати / PDF (на экране скрыта) ——— */
  function cell(p, id, cond) {
    const st = K.paramStats(id, cond, p.key);
    if (!st || !st.n) return el('td', { class: 'pc-na', text: t('noData') });
    const val = `${fmt(st.mean)}${p.unit === '%GC' ? ' %' : '°'}`;
    if (cond === 'Baseline') return el('td', {}, el('b', { text: val }));
    const b = K.paramStats(id, 'Baseline', p.key);
    return el('td', {}, el('b', { text: val }), el('br'), changeNode(p, b && b.mean, st.mean));
  }

  function printCard(subject) {
    const id = subject.id;
    const no = (id.match(/(\d+)\s*$/) || [, id])[1];
    const now = new Date();
    const KZ_MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];
    const date = K.getLang() === 'kz'
      ? `${now.getFullYear()} ж. ${now.getDate()} ${KZ_MONTHS[now.getMonth()]}`   // браузеры плохо знают казахские даты
      : now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const meta = [t(subject.side) || subject.side];
    if (subject.weight) meta.push(`${fmt(subject.weight, 1)} ${t('kg')}`);
    if (subject.height) meta.push(`${fmt(subject.height, 2)} ${t('m')}`);

    // таблица изменений
    const thead = el('thead', {}, el('tr', {}, el('th', { text: t('cardParam') }),
      CONDITIONS.map((c) => el('th', {}, `${ROMAN[c]}. ${t(`cond_${c}`)}`, el('small', { text: c })))));
    const tbody = el('tbody', {},
      el('tr', { class: 'pc-cycles' }, el('th', { text: t('cardCycles') }), CONDITIONS.map((c) => {
        const r = K.store.discrete[c] && K.store.discrete[c].get(id);
        return el('td', { text: r ? String(r.length) : '—' });
      })),
      PARAMS.map((p) => el('tr', {}, el('th', { text: t(`p_${p.key}`) }), CONDITIONS.map((c) => cell(p, id, c)))));

    // заключение ИИ — только если есть
    const part = aiFor(id);
    let ai = null;
    if (part) {
      const want = K.getLang() === 'kz' ? 'summary_kz' : 'summary_ru';
      const text = part[want] || part.summary_ru || part.summary_kz;
      const best = normCond(part.best_condition);
      if (text || best) {
        ai = el('section', { class: 'pc-sec pc-ai' },
          el('h3', { text: t('aiTitle') }),
          isDemo() ? el('p', { class: 'pc-demo' }, el('b', { text: t('aiDemo') }), ` ${t('aiDemoText')}`) : null,
          text ? el('p', { class: 'pc-ai__text', text: String(text) }) : null,
          best ? el('p', {}, el('b', { text: `${t('aiBest')}: ` }), `${ROMAN[best]}. ${t(`cond_${best}`)}`) : null,
          best && part.best_improves_baseline === false ? el('p', { class: 'pc-muted', text: t('aiNotImproves') }) : null,
          modelLine(K.store.ai.model) ? el('p', { class: 'pc-muted', text: modelLine(K.store.ai.model) }) : null,
          el('p', { class: 'pc-muted', text: t('aiNote') }));
      }
    }

    // МКФ: справочная связь, определитель ставит врач от руки
    const icf = (code, name, text) => el('div', { class: 'pc-icf__item' },
      el('p', { class: 'pc-icf__code' }, el('b', { text: code }), ` ${name}`),
      el('p', { class: 'pc-icf__text', text }),
      el('p', { class: 'pc-fill' }, `${t('icfQualifier')}: `, el('span', { class: 'pc-line' })));

    return el('article', { class: 'print-card', 'aria-hidden': 'true' },
      el('header', { class: 'pc-head' },
        el('div', { class: 'pc-brand' },
          el('span', { class: 'pc-brand__name', text: 'Qadam' }),
          el('span', { class: 'pc-brand__sub', text: t('cardTitle') })),
        el('div', { class: 'pc-date' }, el('span', { text: t('cardDate') }), el('b', { text: date }))),
      el('p', { class: 'pc-disclaimer', text: t('disclaimer') }),
      el('section', { class: 'pc-patient' },
        el('h1', {}, `${t('participant')} ${no}`),
        el('p', { class: 'pc-muted', text: `${id} · ${meta.join(' · ')}` })),
      el('section', { class: 'pc-sec' },
        el('h3', { text: t('cardTable') }),
        el('table', { class: 'pc-table' }, thead, tbody),
        el('p', { class: 'pc-muted', text: t('cardTableNote') })),
      el('section', { class: 'pc-sec pc-curves-sec' },
        el('h3', { text: t('curvesTitle') }),
        el('p', { class: 'pc-muted', text: t('cardCurvesNote') }),
        el('div', { class: 'pc-curves' })),   // картинки графиков вставляются перед печатью
      ai,
      el('section', { class: 'pc-sec pc-icf' },
        el('h3', { text: t('icfTitle') }),
        icf('b770', t('icf_b770'), t('icf_b770_text')),
        icf('d450', t('icf_d450'), t('icf_d450_text')),
        el('p', { class: 'pc-muted', text: t('icfNote') })),
      el('footer', { class: 'pc-sign' },
        el('p', {}, `${t('doctor')}: `, el('span', { class: 'pc-line pc-line--long' })),
        el('p', {}, `${t('signature')}: `, el('span', { class: 'pc-line' })),
        el('p', { class: 'pc-muted', text: `${t('privacy')} ${t('source')}` })));
  }

  // Перед печатью превращаем графики в картинки (так они точно попадут в PDF)
  function fillPrintCurves() {
    const box = document.querySelector('.print-card .pc-curves');
    if (!box) return;
    box.innerHTML = '';
    for (const c of charts) {
      if (!c.chart) continue;
      // В виде «для родителей» графики на экране скрыты (размер 0×0) — тогда рисуем копию на невидимом холсте
      const src = c.chart.width > 0 && c.chart.height > 0 ? c.chart.toBase64Image('image/png', 1) : offscreenImage(c.config);
      box.append(el('figure', {},
        el('figcaption', { text: t(`s_${c.sig}`) }),
        el('img', { src, alt: t(`s_${c.sig}`) })));
    }
  }

  function offscreenImage(config) {
    const canvas = el('canvas', { width: 680, height: 400 });
    const holder = el('div', { style: 'position:fixed;left:-10000px;top:0;width:680px;height:400px', 'aria-hidden': 'true' }, canvas);
    document.body.append(holder);
    const copy = {
      ...config,
      data: { labels: config.data.labels, datasets: config.data.datasets.map((d) => ({ ...d, data: d.data.map((p) => ({ ...p })) })) },
      options: { ...config.options, responsive: false, devicePixelRatio: 1 },
    };
    const chart = new Chart(canvas, copy);
    const src = chart.toBase64Image('image/png', 1);
    chart.destroy();
    holder.remove();
    return src;
  }
  window.addEventListener('beforeprint', fillPrintCurves);

  /* ——— Сборка экрана ——— */
  function render(root, id, onBack) {
    while (charts.length) { const c = charts.pop(); if (c.chart) c.chart.destroy(); }
    root.innerHTML = '';
    root.classList.toggle('is-parents', audience === 'parents');
    const subject = K.subjects().find((s) => s.id === id);
    if (!subject) return;
    root.append(
      head(subject, onBack),
      tools(root, id),
      el('section', { class: 'block block--story' }, spreads(id)),
      aiSlot(id),
      // технические разделы: в виде «для родителей» скрыты
      ...[axes(id), dotPlots(id), curves(id)].map((s) => { s.classList.add('for-doctor'); return s; }),
      printCard(subject));
    // графики создаём после вставки в документ, чтобы знать размеры
    for (const c of charts) c.chart = new Chart(c.canvas, c.config);
  }

  K.renderStory = render;
})();
