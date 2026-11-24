/* Qadam — интерфейс. */
(function () {
  const K = window.Kadam;
  const { t, CONDITIONS } = K;
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  };
  const foot = (left) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#foot');
    svg.append(use);
    if (left) svg.style.transform = 'scaleX(-1)';
    return svg;
  };

  const state = { subject: null, messages: [] };

  /* ——— Дорожка следов в шапке: ритм шага ——— */
  function drawTrail() {
    const trail = $('#trail');
    trail.innerHTML = '';
    const w = trail.clientWidth || window.innerWidth;
    const stride = 62;
    const count = Math.ceil(w / stride) + 1;
    for (let i = 0; i < count; i++) {
      const left = i % 2 === 0;
      const f = foot(left);
      f.style.left = `${i * stride + 8}px`;
      f.style.top = left ? '-2px' : '22px';
      f.style.transform = `rotate(90deg)${left ? ' scaleX(-1)' : ''}`;
      // следы постепенно проявляются — ребёнок идёт слева направо
      f.style.opacity = String(Math.min(0.85, 0.1 + (i / count) * 0.75));
      if (i === count - 2) { f.classList.add('is-now'); f.style.opacity = '1'; }
      trail.append(f);
    }
  }

  /* ——— «Пешеход» на фоне: круг в центре экрана оставляет следы при прокрутке ——— */
  function setupWalker() {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const walker = el('div', { id: 'walker', 'aria-hidden': 'true' });
    const layer = el('div', { id: 'bg-prints', 'aria-hidden': 'true' });
    document.body.prepend(walker, layer);

    const STRIDE = 70;     // сколько пикселей прокрутки = один шаг
    const SIDE = 13;       // смещение левой/правой ноги от центральной линии
    const MAX_SHIFT = 90;  // насколько круг может «уйти» от центра
    const EDGE = 30;       // круг у правого края, рядом с полосой прокрутки
    const walkX = () => document.documentElement.clientWidth - EDGE; // clientWidth — без полосы прокрутки
    const place = () => { walker.style.left = `${walkX()}px`; };
    place();
    window.addEventListener('resize', place);
    let lastY = window.scrollY, acc = 0, step = 0;
    let offset = 0, target = 0, lastScroll = 0, running = false;

    function dropPrint(dir) {
      const left = step++ % 2 === 0;
      const f = foot(false);
      f.setAttribute('class', 'print');
      f.style.left = `${walkX() + (left ? -SIDE : SIDE)}px`;
      f.style.top = `${window.scrollY + window.innerHeight / 2 + offset}px`;
      // носок смотрит туда, куда крутим; левая нога — зеркально
      f.style.transform = `translate(-50%, -50%) rotate(${dir > 0 ? 180 : 0}deg)${left ? ' scaleX(-1)' : ''}`;
      layer.append(f);
      setTimeout(() => f.classList.add('is-gone'), 900);   // плавно тает
      setTimeout(() => f.remove(), 2600);
      while (layer.childElementCount > 40) layer.firstChild.remove();
    }

    function tick(now) {
      if (now - lastScroll > 140) target *= 0.82;           // остановились — возвращаемся на место
      offset += (target - offset) * 0.18;
      walker.style.transform = `translate(-50%, -50%) translateY(${offset.toFixed(1)}px)`;
      walker.classList.toggle('is-moving', Math.abs(target) > 4);
      if (Math.abs(offset) > 0.3 || Math.abs(target) > 0.3) requestAnimationFrame(tick);
      else { running = false; offset = target = 0; walker.style.transform = 'translate(-50%, -50%)'; }
    }

    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      if (!dy) return;
      lastScroll = performance.now();
      target = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, target + dy * 0.5));
      acc += Math.abs(dy);
      while (acc >= STRIDE) { acc -= STRIDE; dropPrint(Math.sign(dy)); }
      if (!running) { running = true; requestAnimationFrame(tick); }
    }, { passive: true });
  }


  /* ——— Журнал загрузки ——— */
  function renderLedger() {
    const body = $('#ledger-body');
    body.innerHTML = '';
    for (const kind of ['discrete', 'kinematics']) {
      const tr = el('tr', {}, el('th', { scope: 'row', text: t(kind) }));
      for (const cond of CONDITIONS) {
        const f = K.store.files[`${kind}:${cond}`];
        tr.append(el('td', {},
          el('div', { class: `cell-state${f ? ' cell-state--ok' : ''}` },
            el('span', { class: 'cell-state__dot', 'aria-hidden': 'true' }),
            el('span', { class: 'cell-state__text' },
              f ? t('loaded') : t('waiting'),
              f ? el('small', { text: `${f.rows} ${t('rows')}${kind === 'discrete' ? ` · ${f.missing} ${t('gaps')}` : ''}` }) : null))));
      }
      body.append(tr);
    }
    // после загрузки — тонкая полоса вместо большого блока
    const n = Object.keys(K.store.files).length;
    $('#drop').classList.toggle('is-compact', n > 0);
    $('#screen-load').classList.toggle('is-done', n > 0);
    $('#screen-load').classList.toggle('has-errors', state.messages.some((m) => !m.ok) || !K.store.discrete.Baseline);
    $('#drop-title').dataset.i18n = 'dropTitle';
    K.applyI18n($('#drop'));
    $('#drop-title').textContent = n ? t('loadedCount').replace('{n}', n) : t('dropTitle');
    if (n && K.store.ai) $('#drop-title').append(el('span', { class: 'drop__ai', text: ` + ${t('aiLoadedShort')}` }));
    $('#drop .btn span').textContent = n ? t('addMore') : t('choose');

    const ul = $('#messages');
    ul.innerHTML = '';
    if (n && !K.store.discrete.Baseline) ul.append(el('li', { text: t('needDiscrete') }));
    if (!n && K.store.ai) ul.append(el('li', { class: 'ok', text: t('aiNeedCsv') }));
    for (const m of state.messages.filter((x) => !(x.ok && !n))) ul.append(el('li', { class: m.ok ? 'ok' : '', text: m.ok ? t(m.key) : `${m.name}: ${t('err_' + m.error)}` }));
  }

  /* ——— Таблица участников ——— */
  const fmt1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—'
    : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v));

  function gpsChangeCell(id, cond, base) {
    const st = K.paramStats(id, cond, 'GPS_a');
    const ch = st && base ? K.change(K.PARAMS[0], base.mean, st.mean) : null;
    if (!ch || ch.pct === null) return el('td', { class: 'num pt-muted', text: '—' });
    const arrow = ch.pct < -0.5 ? '↓' : ch.pct > 0.5 ? '↑' : '';
    return el('td', { class: `num chg chg--${Math.abs(ch.pct) < 1 ? 'neutral' : ch.verdict}` },
      el('b', { text: `${arrow} ${fmt1(Math.abs(ch.pct))} %`.trim() }));
  }

  function renderIndex() {
    const list = K.subjects();
    const section = $('#screen-index');
    const body = $('#toc');
    body.innerHTML = '';
    if (!list.length) { section.hidden = true; return; }
    section.hidden = !!state.subject; // пока открыт участник — список скрыт
    const hasAi = !!(K.store.ai && K.store.ai.participants);

    $('#ptable-head').innerHTML = '';
    $('#ptable-head').append(
      el('tr', { class: 'pt-group' },
        el('th', { colspan: 2 }), el('th', { colspan: 3, class: 'pt-hide-sm', text: t('thCycles') }),
        el('th', { colspan: 3, text: t('thGps') }), hasAi ? el('th') : null, el('th')),
      el('tr', {},
        el('th', { scope: 'col', class: 'num', text: '№' }),
        el('th', { scope: 'col', text: t('side') }),
        ['Baseline', 'Verbal', 'VR'].map((c) => el('th', { scope: 'col', class: 'num pt-hide-sm', text: c })),
        el('th', { scope: 'col', class: 'num', text: 'Baseline' }),
        el('th', { scope: 'col', class: 'num', text: 'Verbal' }),
        el('th', { scope: 'col', class: 'num', text: 'VR' }),
        hasAi ? el('th', { scope: 'col', class: 'pt-hide-sm', text: t('thAi') }) : null,
        el('th', { scope: 'col', class: 'pt-open-h' }, el('span', { class: 'sr-only', text: t('open') }))));

    for (const s of list) {
      const no = (s.id.match(/(\d+)\s*$/) || [, s.id])[1];
      const base = K.paramStats(s.id, 'Baseline', 'GPS_a');
      const ai = hasAi && K.store.ai.participants[s.id];
      const open = () => openStory(s.id);
      const tr = el('tr', { onclick: open },
        el('td', { class: 'num pt-no' }, el('span', { text: no }), el('small', { text: s.id })),
        el('td', { class: 'pt-side' }, el('span', { class: 'pt-side__full', text: t(s.side) || s.side }), el('span', { class: 'pt-side__short', text: t(`${s.side}_s`) || s.side })),
        ['Baseline', 'Verbal', 'VR'].map((c) => el('td', { class: 'num pt-hide-sm', text: s.cycles[c] ?? '—' })),
        el('td', { class: 'num' }, el('b', { text: base && base.n ? `${fmt1(base.mean)}°` : '—' })),
        gpsChangeCell(s.id, 'Verbal', base),
        gpsChangeCell(s.id, 'VR', base),
        hasAi ? el('td', { class: 'pt-hide-sm' }, ai ? el('span', { class: 'pt-ai', text: t('thAiYes') }) : el('span', { class: 'pt-muted', text: '—' })) : null,
        el('td', { class: 'pt-open' },
          el('button', { type: 'button', class: 'pt-btn', onclick: (e) => { e.stopPropagation(); open(); }, 'aria-label': `${t('open')}: ${t('participant')} ${no} (${s.id})` }, `${t('open')} →`)));
      body.append(tr);
    }
  }

  /* ——— Приём файлов ——— */
  async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    state.messages = [];
    for (const file of files) {
      if (/\.json$/i.test(file.name)) {
        try {
          const ai = JSON.parse(await file.text());
          if (!ai || typeof ai !== 'object' || !ai.participants || typeof ai.participants !== 'object') {
            state.messages.push({ ok: false, name: file.name, error: 'noParticipants' });
          } else {
            K.store.ai = ai;
            state.messages.push({ ok: true, key: 'aiLoaded' });
          }
        } catch (e) {
          state.messages.push({ ok: false, name: file.name, error: 'badJson' });
        }
        continue;
      }
      const res = await K.parseFile(file);
      if (!res.ok) state.messages.push(res);
    }
    renderLedger();
    renderIndex();
    if (state.subject && !$('#screen-story').hidden) openStory(state.subject, true);
  }

  function setupDrop() {
    const drop = $('#drop');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('is-over'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('is-over'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; drop.classList.remove('is-over');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
    $('#file-input').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); } });
  }

  /* ——— Экран участника ——— */
  function showList() {
    state.subject = null;
    $('#screen-story').hidden = true;
    $('#screen-load').hidden = false;
    renderIndex();
    const idx = $('#screen-index');
    (idx.hidden ? $('#screen-load') : idx).scrollIntoView({ block: 'start' });
  }

  function openStory(id, keepScroll) {
    state.subject = id;
    const story = $('#screen-story');
    $('#screen-load').hidden = true;
    $('#screen-index').hidden = true;
    story.hidden = false;
    K.renderStory(story, id, showList);
    // ошибки загрузки видны и на экране участника (блок загрузки здесь скрыт)
    const errs = state.messages.filter((m) => !m.ok);
    if (errs.length) story.prepend(el('ul', { class: 'messages', 'aria-live': 'polite' }, errs.map((m) => el('li', { text: `${m.name}: ${t('err_' + m.error)}` }))));
    if (!keepScroll) window.scrollTo({ top: 0 });
  }

  function rerender() {
    renderLedger();
    renderIndex();
    if (state.subject && !$('#screen-story').hidden) openStory(state.subject, true);
  }

  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => K.setLang(b.dataset.lang)));
  document.addEventListener('kadam:lang', rerender);
  $('#brand-home').addEventListener('click', (e) => {
    e.preventDefault();
    showList();
    window.scrollTo({ top: 0 });
  });
  window.addEventListener('resize', () => { clearTimeout(drawTrail.t); drawTrail.t = setTimeout(drawTrail, 150); });

  K.applyI18n();
  drawTrail();
  setupWalker();
  setupDrop();
  renderLedger();

  // для отладки и проверки в консоли
  K.ui = { handleFiles, openStory, state };
})();
