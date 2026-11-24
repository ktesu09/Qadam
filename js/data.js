/* Qadam — чтение CSV и простая статистика. Всё работает только в браузере. */
(function () {
  const CONDITIONS = ['Baseline', 'Verbal', 'VR'];
  const SIGNALS = ['aSagP', 'aSagH', 'aSagK', 'aSagA', 'mSagH'];
  const POINTS = 51; // 0, 2, 4 … 100 % цикла шага

  // Дискретные параметры. better: 'lower' — меньше = лучше (окрашиваем),
  // null — направление клинически неоднозначно (нейтрально).
  // unit: если задан, изменение показываем в единицах, а не в % (значения около нуля).
  const PARAMS = [
    { key: 'GPS_a',          better: 'lower', unit: null },
    { key: 'GVS_aSagP',      better: 'lower', unit: null },
    { key: 'GVS_aSagH',      better: 'lower', unit: null },
    { key: 'GVS_aSagK',      better: 'lower', unit: null },
    { key: 'GVS_aSagA',      better: 'lower', unit: null },
    { key: 'aMinSagH',       better: null,    unit: '°' },
    { key: 'pctmZeroStSagH', better: null,    unit: '%GC' },
  ];

  // Пропуск = "NaN", пустая строка или мусор. Десятичный разделитель — запятая.
  function num(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (s === '' || /^nan$/i.test(s)) return null;
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function detectCondition(name) {
    const n = name.toLowerCase();
    if (n.includes('baseline')) return 'Baseline';
    if (n.includes('verbal')) return 'Verbal';
    if (/(^|[^a-z])vr([^a-z]|$)/.test(n)) return 'VR';
    return null;
  }

  function detectKind(fields) {
    if (fields.includes('GPS_a')) return 'discrete';
    if (fields.includes('aSagP_pct_GC_0')) return 'kinematics';
    return null;
  }

  // Хранилище: store.discrete.VR = Map(subject -> [цикл, цикл, …])
  const store = {
    discrete: {}, kinematics: {}, files: {}, ai: null,
  };

  function parseFile(file) {
    return new Promise((resolve) => {
      Papa.parse(file, {
        delimiter: ';', header: true, skipEmptyLines: 'greedy',
        complete: (res) => {
          const fields = (res.meta.fields || []).map((f) => f.trim());
          const kind = detectKind(fields);
          const cond = detectCondition(file.name);
          if (!kind) return resolve({ ok: false, name: file.name, error: 'unknownFile' });
          if (!cond) return resolve({ ok: false, name: file.name, error: 'unknownCondition' });
          const bySubject = new Map();
          let missing = 0;
          for (const raw of res.data) {
            const subject = (raw.subject || '').trim();
            if (!subject) continue;
            const row = {
              side: (raw.side || '').trim().toUpperCase(),
              weight: num(raw.weight), height: num(raw.height), leg: num(raw.LegLength),
            };
            if (kind === 'discrete') {
              row.values = {};
              for (const p of PARAMS) {
                row.values[p.key] = num(raw[p.key]);
                if (row.values[p.key] === null) missing++;
              }
            } else {
              row.curves = {};
              for (const s of SIGNALS) {
                const arr = new Array(POINTS);
                for (let i = 0; i < POINTS; i++) arr[i] = num(raw[`${s}_pct_GC_${i * 20}`]);
                row.curves[s] = arr;
              }
            }
            if (!bySubject.has(subject)) bySubject.set(subject, []);
            bySubject.get(subject).push(row);
          }
          store[kind][cond] = bySubject;
          store.files[`${kind}:${cond}`] = { name: file.name, rows: res.data.length, missing };
          resolve({ ok: true, name: file.name, kind, cond });
        },
        error: () => resolve({ ok: false, name: file.name, error: 'readError' }),
      });
    });
  }

  function subjectNumber(id) {
    const m = String(id).match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : Infinity;
  }

  // Сводный список участников из всех загруженных файлов.
  function subjects() {
    const map = new Map();
    for (const kind of ['discrete', 'kinematics']) {
      for (const cond of CONDITIONS) {
        const bySubject = store[kind][cond];
        if (!bySubject) continue;
        for (const [id, rows] of bySubject) {
          if (!map.has(id)) map.set(id, { id, side: rows[0].side, weight: rows[0].weight, height: rows[0].height, cycles: {} });
          const s = map.get(id);
          if (kind === 'discrete' || s.cycles[cond] === undefined) s.cycles[cond] = rows.length;
        }
      }
    }
    return [...map.values()].sort((a, b) => subjectNumber(a.id) - subjectNumber(b.id) || a.id.localeCompare(b.id));
  }

  function stats(values) {
    const v = values.filter((x) => x !== null);
    if (!v.length) return { n: 0, mean: null, sd: null };
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
    return { n: v.length, mean, sd };
  }

  function paramStats(subject, cond, key) {
    const rows = store.discrete[cond] && store.discrete[cond].get(subject);
    if (!rows) return null;
    return stats(rows.map((r) => r.values[key]));
  }

  function meanCurve(subject, cond, signal) {
    const rows = store.kinematics[cond] && store.kinematics[cond].get(subject);
    if (!rows) return null;
    const mean = [], sd = [];
    let n = 0;
    for (let i = 0; i < POINTS; i++) {
      const s = stats(rows.map((r) => r.curves[signal][i]));
      mean.push(s.mean); sd.push(s.sd); n = Math.max(n, s.n);
    }
    return n ? { mean, sd, n } : null;
  }

  // Изменение относительно Baseline: % или разница в единицах.
  function change(param, base, value) {
    if (base === null || value === null || base === undefined || value === undefined) return null;
    const delta = value - base;
    const pct = param.unit || Math.abs(base) < 1e-9 ? null : (delta / Math.abs(base)) * 100;
    let verdict = 'neutral';
    if (param.better === 'lower' && pct !== null && Math.abs(pct) >= 1) verdict = delta < 0 ? 'better' : 'worse';
    return { delta, pct, verdict };
  }

  window.Kadam = Object.assign(window.Kadam || {}, {
    CONDITIONS, SIGNALS, PARAMS, POINTS, store,
    num, parseFile, subjects, paramStats, meanCurve, change, stats,
  });
})();
