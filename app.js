/* Look Lab UI: filter library, image cards, previews and saving. */
(function () {
  'use strict';
  const E = window.FilterEngine;
  const STORE_KEY = 'looklab.filters.v1';
  const PREVIEW_MAX = 1200;   // long edge of on-screen previews
  const ANALYZE_MAX = 512;    // long edge used to measure a reference

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- Saving files ----------
  // Inside a claude.ai artifact the page must ask the viewer to save; when
  // opened directly from disk, a normal browser download works.
  const downloadsReady = window.claude && window.claude.use
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);

  async function saveFile(filename, blob) {
    const dl = await downloadsReady;
    if (dl) {
      try {
        await dl.save({ filename, data: blob });
        return true;
      } catch (err) {
        if (err && err.code === 'declined') return false;
        if (err && err.code === 'rate_limited') { toast('A save prompt is already open.'); return false; }
        toast('This view can’t save files. Open Look Lab in a browser tab to save.');
        return false;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- Image helpers ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file could not be read as an image.'));
      img.src = src;
    });
  }
  function drawScaled(source, w, h, maxEdge) {
    const s = Math.min(1, maxEdge / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  const pixels = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'filter';
  const rgbCss = ([r, g, b]) => `rgb(${r} ${g} ${b})`;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  // ---------- Starter filters (examples, deletable) ----------
  function starterFilters() {
    const smooth = (p) => p * p * (3 - 2 * p);
    const defs = [
      ['Golden Hour', { curve: (p) => 6 + 88 * Math.pow(p, 0.88), zones: [[5, 12, 9], [7, 20, 12], [4, 24, 10]] }],
      ['Teal & Orange', { curve: (p) => 4 + 90 * (0.35 * p + 0.65 * smooth(p)), zones: [[-9, -12, 10], [5, 10, 12], [9, 22, 11]] }],
      ['Faded Film', { curve: (p) => 15 + 70 * p, zones: [[-3, 5, 6], [1, 6, 7], [3, 9, 6]] }],
      ['Nordic Blue', { curve: (p) => 5 + 91 * Math.pow(p, 1.08), zones: [[-2, -13, 8], [-2, -8, 9], [-1, -3, 7]] }],
    ];
    return defs.map(([name, spec]) => ({ id: 'ex-' + slug(name), name, example: true, thumb: null, stats: E.synthesize(spec) }));
  }

  function loadFilters() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list.filter(validFilter);
      }
    } catch (_) { /* storage unavailable */ }
    return starterFilters();
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.filters)); } catch (_) { /* ignore */ }
  }
  function validFilter(f) {
    return f && typeof f.name === 'string' && f.stats && Array.isArray(f.stats.lq) && f.stats.lq.length > 1 &&
      Array.isArray(f.stats.zones) && f.stats.zones.length === 3 &&
      f.stats.zones.every((z) => ['a', 'b', 'sa', 'sb'].every((k) => Number.isFinite(z[k])));
  }

  const state = {
    filters: loadFilters(),
    images: [],
    draft: null,
    editing: null,     // filter id being renamed
    confirming: null,  // filter id pending delete
  };
  const filterById = (id) => state.filters.find((f) => f.id === id) || null;

  // ---------- Filter library ----------
  function thumbFor(f) {
    if (f.thumb) return el('img', { class: 'filter-thumb', src: f.thumb, alt: '' });
    const c = document.createElement('canvas');
    c.width = c.height = 52;
    c.className = 'filter-thumb';
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 52, 52, 0);
    E.swatches(f.stats).forEach((s, i) => grad.addColorStop(i / 2, rgbCss(s.rgb)));
    g.fillStyle = grad;
    g.fillRect(0, 0, 52, 52);
    return c;
  }
  function swatchRow(stats) {
    return el('div', { class: 'swatches', 'aria-hidden': 'true' },
      ...E.swatches(stats).map((s) => el('span', { class: 'swatch', style: `background:${rgbCss(s.rgb)}`, title: s.name })));
  }

  function renderLibrary() {
    const list = $('filter-list');
    list.replaceChildren();
    if (!state.filters.length) {
      list.append(el('li', { class: 'empty-note', text: 'No filters yet. Choose a reference photo to make your first one.' }));
    }
    for (const f of state.filters) {
      let meta, actions;
      if (state.editing === f.id) {
        const input = el('input', { type: 'text', value: f.name, 'aria-label': 'Filter name', id: 'rename-' + f.id });
        const commit = () => {
          const v = input.value.trim();
          if (v) f.name = v;
          state.editing = null; persist(); renderAll();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { state.editing = null; renderLibrary(); }
        });
        meta = el('div', { class: 'filter-meta' }, input);
        actions = el('div', { class: 'filter-actions' }, el('button', { class: 'btn small', type: 'button', text: 'Save', onclick: commit }));
        setTimeout(() => { input.focus(); input.select(); });
      } else if (state.confirming === f.id) {
        meta = el('div', { class: 'filter-meta' }, el('div', { class: 'confirm' }, `Delete “${f.name}”?`));
        actions = el('div', { class: 'filter-actions' },
          el('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: () => deleteFilter(f.id) }),
          el('button', { class: 'btn small ghost', type: 'button', text: 'Keep', onclick: () => { state.confirming = null; renderLibrary(); } }));
      } else {
        const name = el('div', { class: 'filter-name', title: f.name }, f.name);
        if (f.example) name.append(el('span', { class: 'tag', text: 'Example' }));
        meta = el('div', { class: 'filter-meta' }, name, swatchRow(f.stats));
        actions = el('div', { class: 'filter-actions' },
          el('button', { class: 'btn small ghost', type: 'button', text: 'Rename', 'aria-label': `Rename ${f.name}`, onclick: () => { state.editing = f.id; state.confirming = null; renderLibrary(); } }),
          el('button', { class: 'btn small ghost', type: 'button', text: 'Delete', 'aria-label': `Delete ${f.name}`, onclick: () => { state.confirming = f.id; state.editing = null; renderLibrary(); } }));
      }
      const sub = meta.querySelector('.swatches');
      const row = el('div', { class: 'filter-sub' });
      if (sub) sub.before(row);
      else meta.append(row);
      row.append(sub || el('span'), actions);
      list.append(el('li', { class: 'filter-item' }, thumbFor(f), meta));
    }
    renderDraft();
  }

  function deleteFilter(id) {
    state.filters = state.filters.filter((f) => f.id !== id);
    state.confirming = null;
    for (const img of state.images) if (img.filterId === id) { img.filterId = ''; schedule(img); }
    persist();
    renderAll();
  }

  async function startDraft(file) {
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      const small = drawScaled(img, img.naturalWidth, img.naturalHeight, ANALYZE_MAX);
      const { lq, zones } = E.analyze(pixels(small).data);
      const thumbC = drawScaled(img, img.naturalWidth, img.naturalHeight, 160);
      state.draft = { name: baseName(file.name).replace(/[_-]+/g, ' ').trim() || 'New filter', thumb: thumbC.toDataURL('image/jpeg', 0.8), stats: { lq, zones } };
      renderDraft();
      const input = $('draft-name');
      if (input) { input.focus(); input.select(); }
    } catch (err) {
      toast(err.message || 'That reference could not be read.');
    }
  }

  function renderDraft() {
    const box = $('draft');
    const d = state.draft;
    box.hidden = !d;
    box.replaceChildren();
    if (!d) return;
    const name = el('input', { type: 'text', id: 'draft-name', value: d.name });
    name.addEventListener('input', () => { d.name = name.value; });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDraft(); if (e.key === 'Escape') cancelDraft(); });
    box.append(
      el('div', { class: 'eyebrow', text: 'New filter' }),
      el('div', { class: 'draft-row' }, el('img', { src: d.thumb, alt: 'Reference photo' }), el('label', { for: 'draft-name' }, 'Name', name)),
      el('div', { class: 'zones' }, ...E.swatches(d.stats).map((s) =>
        el('div', { class: 'zone' }, el('span', { style: `background:${rgbCss(s.rgb)}` }), el('span', { text: s.name })))),
      el('div', { class: 'draft-actions' },
        el('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: cancelDraft }),
        el('button', { class: 'btn small primary', type: 'button', text: 'Save filter', onclick: saveDraft })));
  }
  function cancelDraft() { state.draft = null; renderDraft(); }
  function saveDraft() {
    const d = state.draft;
    if (!d) return;
    const f = { id: uid(), name: d.name.trim() || 'New filter', thumb: d.thumb, stats: d.stats, createdAt: new Date().toISOString() };
    state.filters.unshift(f);
    state.draft = null;
    persist();
    renderAll();
    toast(`Saved “${f.name}”.`);
  }

  async function exportFilters() {
    if (!state.filters.length) { toast('There are no filters to export.'); return; }
    const payload = { app: 'look-lab', version: 1, filters: state.filters };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    if (await saveFile('look-lab-filters.json', blob)) toast(`Exported ${state.filters.length} filters.`);
  }
  async function importFilters(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = (Array.isArray(data) ? data : data.filters || []).filter(validFilter);
      if (!list.length) throw new Error();
      const ids = new Set(state.filters.map((f) => f.id));
      for (const f of list) {
        const copy = { id: ids.has(f.id) || !f.id ? uid() : f.id, name: f.name, thumb: typeof f.thumb === 'string' && f.thumb.startsWith('data:image/') ? f.thumb : null, stats: { lq: f.stats.lq, zones: f.stats.zones }, example: !!f.example };
        ids.add(copy.id);
        state.filters.push(copy);
      }
      persist();
      renderAll();
      toast(`Imported ${list.length} ${list.length === 1 ? 'filter' : 'filters'}.`);
    } catch (_) {
      toast('That file isn’t a Look Lab filter export.');
    }
  }

  // ---------- Images ----------
  function filterOptions(select, selected, noneLabel) {
    select.replaceChildren(el('option', { value: '', text: noneLabel }));
    for (const f of state.filters) select.append(el('option', { value: f.id, text: f.name }));
    select.value = filterById(selected) ? selected : '';
  }

  async function addFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) { toast('Those files aren’t images.'); return; }
    // Drop the sample once real images arrive
    state.images.filter((i) => i.sample).forEach(removeImage);
    const defaultFilter = $('apply-all').value || (state.filters[0] && state.filters[0].id) || '';
    for (const file of list) {
      try {
        const url = URL.createObjectURL(file);
        const img = await loadImage(url);
        addImage({ name: file.name, type: file.type, url, source: img, w: img.naturalWidth, h: img.naturalHeight, filterId: defaultFilter });
        await nextFrame();
      } catch (err) {
        toast(`${file.name}: ${err.message}`);
      }
    }
  }

  function addImage({ name, type, url, source, w, h, filterId, sample }) {
    const preview = drawScaled(source, w, h, PREVIEW_MAX);
    const orig = pixels(preview);
    const item = { id: uid(), name, type, url, source, w, h, filterId, sample: !!sample, tone: 100, color: 100, orig, srcStats: E.analyze(orig.data), els: null };
    state.images.push(item);
    buildCard(item);
    schedule(item);
    updateCount();
  }

  function removeImage(item) {
    state.images = state.images.filter((i) => i !== item);
    item.els.card.remove();
    if (item.url) URL.revokeObjectURL(item.url);
    updateCount();
  }

  function buildCard(item) {
    const before = el('canvas', { class: 'before', 'aria-hidden': 'true' });
    const after = el('canvas', { class: 'after', role: 'img', 'aria-label': `${item.name}, filtered preview` });
    for (const c of [before, after]) { c.width = item.orig.width; c.height = item.orig.height; }
    before.getContext('2d').putImageData(item.orig, 0, 0);
    const split = el('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Compare original and filtered', id: 'split-' + item.id });
    const compare = el('div', { class: 'compare' }, after, before, el('div', { class: 'divider' }), el('span', { class: 'chip l', text: 'Original' }), el('span', { class: 'chip r', text: 'Filtered' }), split);
    split.addEventListener('input', () => compare.style.setProperty('--split', split.value + '%'));

    const select = el('select', { id: 'filter-' + item.id, 'aria-label': 'Filter' });
    filterOptions(select, item.filterId, 'None (original)');
    select.addEventListener('change', () => { item.filterId = select.value; syncSliders(item); schedule(item); });

    const slider = (key, label) => {
      const input = el('input', { type: 'range', min: '0', max: '100', value: String(item[key]), id: `${key}-${item.id}` });
      const out = el('output', { for: input.id, text: item[key] + '%' });
      input.addEventListener('input', () => { item[key] = +input.value; out.textContent = input.value + '%'; schedule(item); });
      return { row: el('label', { class: 'field', for: input.id }, el('span', { text: label }), input, out), input };
    };
    const tone = slider('tone', 'Tone');
    const color = slider('color', 'Color');

    const title = el('div', { class: 'card-title' },
      el('span', { class: 'name', title: item.name }, item.name, item.sample ? el('span', { class: 'sample', text: 'Sample' }) : null),
      el('span', { class: 'dims', text: `${item.w} × ${item.h}` }));

    const saveBtn = el('button', { class: 'btn small primary', type: 'button', text: 'Save image', onclick: () => saveOne(item) });
    const card = el('article', { class: 'card' }, compare,
      el('div', { class: 'card-body' }, title,
        el('div', { class: 'field select' }, el('span', { text: 'Filter' }), select),
        tone.row, color.row,
        el('div', { class: 'card-actions' },
          el('button', { class: 'btn small ghost', type: 'button', text: 'Remove', onclick: () => removeImage(item) }),
          saveBtn)));
    item.els = { card, compare, after, select, tone: tone.input, color: color.input, saveBtn };
    syncSliders(item);
    $('grid').append(card);
  }

  function syncSliders(item) {
    const off = !filterById(item.filterId);
    item.els.tone.disabled = off;
    item.els.color.disabled = off;
  }

  // Coalesce preview renders to one per frame
  const pending = new Set();
  let rafId = 0;
  function schedule(item) {
    pending.add(item);
    if (!rafId) rafId = requestAnimationFrame(flush);
  }
  function flush() {
    rafId = 0;
    for (const item of pending) if (state.images.includes(item)) renderPreview(item);
    pending.clear();
  }
  function prepFor(item, srcStats) {
    const f = filterById(item.filterId);
    if (!f) return null;
    return E.prepare(srcStats, f.stats, { tone: item.tone / 100, color: item.color / 100 });
  }
  function renderPreview(item) {
    const prep = prepFor(item, item.srcStats);
    const out = new ImageData(item.orig.width, item.orig.height);
    if (prep) E.apply(item.orig.data, prep, out.data); else out.data.set(item.orig.data);
    item.els.after.getContext('2d').putImageData(out, 0, 0);
  }

  async function renderFull(item) {
    const c = drawScaled(item.source, item.w, item.h, Infinity);
    const g = c.getContext('2d', { willReadFrequently: true });
    const prep = prepFor(item, item.srcStats);
    if (prep) {
      // Process in bands so very large photos don't need a second full copy
      const band = Math.max(1, Math.floor(4000000 / c.width));
      for (let y = 0; y < c.height; y += band) {
        const h = Math.min(band, c.height - y);
        const d = g.getImageData(0, y, c.width, h);
        E.apply(d.data, prep, d.data);
        g.putImageData(d, 0, y);
        await nextFrame();
      }
    }
    const png = item.type === 'image/png';
    const blob = await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.92));
    const f = filterById(item.filterId);
    const filename = `${baseName(item.name)}${f ? '-' + slug(f.name) : ''}.${png ? 'png' : 'jpg'}`;
    return { blob, filename };
  }

  async function withBusy(items, fn) {
    items.forEach((i) => i.els.compare.classList.add('busy'));
    const buttons = [$('save-all'), ...items.map((i) => i.els.saveBtn)];
    buttons.forEach((b) => { b.disabled = true; });
    try { return await fn(); } finally {
      items.forEach((i) => i.els.compare.classList.remove('busy'));
      buttons.forEach((b) => { b.disabled = false; });
      updateCount();
    }
  }

  async function saveOne(item) {
    await withBusy([item], async () => {
      await nextFrame();
      const { blob, filename } = await renderFull(item);
      if (await saveFile(filename, blob)) toast(`Saved ${filename}.`);
    });
  }

  async function saveAll() {
    const items = state.images.slice();
    if (!items.length) { toast('Add images first.'); return; }
    if (items.length === 1) return saveOne(items[0]);
    if (!window.JSZip) { toast('The zip library didn’t load. Save images one at a time.'); return; }
    await withBusy(items, async () => {
      const zip = new window.JSZip();
      const used = new Set();
      for (const item of items) {
        await nextFrame();
        const { blob, filename } = await renderFull(item);
        let name = filename, n = 2;
        while (used.has(name)) name = filename.replace(/(\.[^.]+)$/, `-${n++}$1`);
        used.add(name);
        zip.file(name, blob);
        item.els.compare.classList.remove('busy');
      }
      const out = await zip.generateAsync({ type: 'blob' });
      if (await saveFile('look-lab-images.zip', out)) toast(`Saved ${items.length} images as a zip.`);
    });
  }

  function updateCount() {
    const n = state.images.length;
    $('count').textContent = n ? `${n} ${n === 1 ? 'image' : 'images'}` : '';
    $('save-all').disabled = !n;
    $('save-all').textContent = n > 1 ? 'Save all (.zip)' : 'Save all';
  }

  function renderAll() {
    renderLibrary();
    const all = $('apply-all');
    const prev = all.value;
    filterOptions(all, prev, 'Choose a filter…');
    for (const item of state.images) {
      filterOptions(item.els.select, item.filterId, 'None (original)');
      if (!filterById(item.filterId) && item.filterId) { item.filterId = ''; schedule(item); }
      syncSliders(item);
    }
  }

  // ---------- Sample image so the page opens in a working state ----------
  function sampleCanvas() {
    const W = 1200, H = 800;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 470);
    sky.addColorStop(0, '#5f8fc9'); sky.addColorStop(0.7, '#b9cfe0'); sky.addColorStop(1, '#ece6d8');
    g.fillStyle = sky; g.fillRect(0, 0, W, 470);
    const sun = g.createRadialGradient(840, 330, 10, 840, 330, 170);
    sun.addColorStop(0, 'rgba(255,250,232,1)'); sun.addColorStop(0.25, 'rgba(255,240,205,0.8)'); sun.addColorStop(1, 'rgba(255,240,205,0)');
    g.fillStyle = sun; g.fillRect(600, 120, 480, 400);
    const ridge = (base, amp, freq, phase, color) => {
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) g.lineTo(x, base - amp * (Math.sin(x * freq + phase) * 0.6 + Math.sin(x * freq * 2.7 + phase * 1.3) * 0.4));
      g.lineTo(W, H); g.closePath(); g.fillStyle = color; g.fill();
    };
    ridge(420, 60, 0.006, 1.2, '#7f93a1');
    ridge(470, 45, 0.009, 0.3, '#56745d');
    ridge(520, 35, 0.013, 2.1, '#34553a');
    const lake = g.createLinearGradient(0, 540, 0, H);
    lake.addColorStop(0, '#9fb7c6'); lake.addColorStop(1, '#2b465a');
    g.fillStyle = lake; g.fillRect(0, 540, W, H - 540);
    g.fillStyle = 'rgba(255,245,220,0.35)'; g.fillRect(800, 545, 80, 200);
    ridge(790, 50, 0.01, 4.0, '#2a2521');
    g.fillStyle = '#e9e2d3';
    g.beginPath(); g.moveTo(300, 610); g.lineTo(360, 610); g.lineTo(350, 625); g.lineTo(312, 625); g.closePath(); g.fill();
    g.fillStyle = '#b8412e'; g.fillRect(330, 570, 3, 40);
    g.beginPath(); g.moveTo(333, 572); g.lineTo(358, 604); g.lineTo(333, 604); g.fill();
    const d = g.getImageData(0, 0, W, H);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 10;
    for (let i = 0; i < d.data.length; i += 4) { const n = rnd(); d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
    g.putImageData(d, 0, 0);
    return c;
  }

  // ---------- Wiring ----------
  $('new-filter').addEventListener('click', () => $('ref-input').click());
  $('ref-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) startDraft(f); e.target.value = ''; });
  $('export-filters').addEventListener('click', exportFilters);
  $('import-filters').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importFilters(f); e.target.value = ''; });
  $('add-images').addEventListener('click', () => $('img-input').click());
  $('img-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('save-all').addEventListener('click', saveAll);
  $('apply-all').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return;
    for (const item of state.images) { item.filterId = id; item.els.select.value = id; syncSliders(item); schedule(item); }
  });

  const dz = $('dropzone');
  dz.addEventListener('click', () => $('img-input').click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('img-input').click(); } });
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) dz.classList.remove('over'); }));
  document.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  renderAll();
  const sample = sampleCanvas();
  const tealOrange = state.filters.find((f) => f.id === 'ex-teal-orange') || state.filters[0];
  addImage({ name: 'sample-lake.jpg', type: 'image/jpeg', url: null, source: sample, w: sample.width, h: sample.height, filterId: tealOrange ? tealOrange.id : '', sample: true });
  if (tealOrange) $('apply-all').value = '';
})();
