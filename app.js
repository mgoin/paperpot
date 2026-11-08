/* PaperPot: UI. */
import { MM_PER_IN, fmt, n3, layoutPages, pageSVG, colName, FONT, rawPiece } from './templates.js';
import {
  newState, PRESETS, addPart, getPart, partNames, describePart, isWall, joinAt, partnerOf,
  canJoin, join, detach, removePart, syncAll, addAtEdge, buildPieces, layout, problems,
  outerSize, supportWall, encode, decode, SETTINGS_DEFAULTS, MARGIN_PRESETS,
} from './model.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = null;
let sel = null;          // { type: 'part'|'edge', id, side? }
let pending = null;      // edge waiting to be attached: { id, side }
let view = null;
let message = null;      // { text, kind }
const undoStack = [], redoStack = [];

/* ---------- units ---------- */
const U = () => state.units;
const toShow = mm => (U() === 'in' ? +(mm / MM_PER_IN).toFixed(3) : +mm.toFixed(1));
const fromShow = v => (U() === 'in' ? v * MM_PER_IN : v);
const step = () => (U() === 'in' ? 0.125 : 1);
const unitLabel = () => (U() === 'in' ? 'in' : 'mm');
const f = mm => fmt(mm, U());

/* ---------- history ---------- */
function snapshot() { return JSON.stringify(state); }
function commit(before) {
  if (before && before !== snapshot()) { undoStack.push(before); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
}
function mutate(fn, { structural = true } = {}) {
  const before = snapshot();
  const r = fn();
  commit(before);
  refresh({ structural });
  return r;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state = JSON.parse(undoStack.pop());
  fixSelection();
  refresh({ structural: true });
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state = JSON.parse(redoStack.pop());
  fixSelection();
  refresh({ structural: true });
}
function fixSelection() {
  if (sel && !getPart(state, sel.id)) sel = null;
  if (pending && !getPart(state, pending.id)) pending = null;
}

/* ---------- messages ---------- */
function say(text, kind = 'info') { message = text ? { text, kind } : null; renderMessage(); }
function renderMessage() {
  const el = $('#message');
  if (pending) {
    const names = partNames(state);
    el.className = 'message info';
    el.innerHTML = `Attaching <b>${esc(names[pending.id])}, ${pending.side} edge</b>. Click the edge to join it to. <button type="button" data-act="cancel-attach">Cancel</button>`;
    return;
  }
  if (!message) { el.className = 'message'; el.textContent = ''; return; }
  el.className = 'message ' + message.kind;
  el.textContent = message.text;
}

/* ---------- parts list ---------- */
function partSummary(p) {
  if (p.kind === 'round' || p.kind === 'foot') return `⌀ ${f(p.dTop)} / ${f(p.dBot)}, h ${f(p.h)}`;
  if (p.kind === 'facet') return `${f(p.wTop)} / ${f(p.wBot)}, h ${f(p.h)}`;
  if (p.kind === 'base' || p.kind === 'lid') {
    const w = supportWall(state, p);
    return w ? `on ${partNames(state)[w.id]}` : 'not joined';
  }
  return '';
}

function renderParts() {
  const names = partNames(state);
  const L = layout(state);
  // list in stack order: by group, then from the top down
  const order = [];
  for (const g of L.groups) {
    const ids = g.ids.slice().sort((a, b) => L.pos[b].z - L.pos[a].z || kindRank(a) - kindRank(b));
    order.push(ids);
  }
  const bad = new Set(problems(state).map(p => p.id));
  $('#parts').innerHTML = order.map(ids => `<ul class="stack">${ids.map(id => {
    const p = getPart(state, id);
    const active = sel && sel.id === id;
    const desc = describePart(p);
    return `<li><button type="button" class="part${active ? ' active' : ''}${bad.has(id) ? ' bad' : ''}" data-part="${id}">
      <span class="pname">${esc(names[id])}</span><span class="pdesc">${esc(desc)}</span><span class="pdims">${esc(partSummary(p))}</span></button></li>`;
  }).join('')}</ul>`).join('');
}
function kindRank(id) { const k = getPart(state, id).kind; return { lid: 0, round: 1, facet: 1, base: 2, foot: 3 }[k]; }

/* ---------- selection panel ---------- */
function numField(key, label, mm, opts = {}) {
  const isLen = opts.len !== false;
  const val = isLen ? toShow(mm) : mm;
  return `<label class="field"><span>${label}${opts.linked ? ` <em class="linked" title="Shared with ${esc(opts.linked)}">linked to ${esc(opts.linked)}</em>` : ''}</span>
    <span class="input"><input type="number" inputmode="decimal" data-key="${key}" data-len="${isLen ? 1 : 0}" value="${val}" step="${opts.step || (isLen ? step() : 1)}" min="${opts.min ?? 0}"${opts.max != null ? ` max="${opts.max}"` : ''}>${isLen ? `<i>${unitLabel()}</i>` : ''}</span></label>`;
}

function linkedName(p, side) {
  const q = partnerOf(state, p.id, side);
  if (!q) return '';
  const pq = getPart(state, q.id);
  return isWall(pq) ? partNames(state)[q.id] : '';
}

function edgeButtons(p) {
  const sides = p.kind === 'lid' ? ['bottom'] : ['top', 'bottom'];
  return `<div class="edge-chips">${sides.map(side => {
    const j = joinAt(state, p.id, side);
    return `<button type="button" class="chip" data-edge="${p.id}:${side}">${side === 'top' ? 'Top' : 'Bottom'} edge${j ? ' (joined)' : ''}</button>`;
  }).join('')}</div>`;
}

function renderPanel() {
  const el = $('#panel');
  if (!sel) {
    el.innerHTML = `<p class="hint">Click a part or one of its edges in the view, or pick a part from the list.</p>`;
    return;
  }
  const names = partNames(state);
  const p = getPart(state, sel.id);
  if (!p) { sel = null; return renderPanel(); }
  const dimNote = state.dimMode === 'inside' ? 'inside' : 'outside';

  if (sel.type === 'edge') {
    const side = sel.side;
    const j = partnerOf(state, p.id, side);
    let h = `<h3>${esc(names[p.id])}, ${side} edge</h3>`;
    if (p.kind === 'round') h += numField(side === 'top' ? 'dTop' : 'dBot', `Diameter (${dimNote})`, p[side === 'top' ? 'dTop' : 'dBot'], { linked: linkedName(p, side) });
    if (p.kind === 'facet') h += numField(side === 'top' ? 'wTop' : 'wBot', `Width across flats (${dimNote})`, p[side === 'top' ? 'wTop' : 'wBot'], { linked: linkedName(p, side) });
    if (j) {
      h += `<p class="joined">Joined to <b>${esc(names[j.id])}</b>, ${j.side} edge.</p>`;
      h += `<div class="row"><button type="button" data-act="detach">Detach</button><button type="button" data-act="select-part">Edit ${esc(names[p.id])}</button></div>`;
    } else {
      const adds = [];
      if (isWall(p)) {
        const kind = p.kind;
        const lbl = kind === 'facet' ? `${p.n}-sided` : '';
        adds.push([`${kind}:same`, kind === 'round' ? 'Cylinder' : `Straight ${lbl}`]);
        adds.push([`${kind}:out`, 'Taper out']);
        adds.push([`${kind}:in`, 'Taper in']);
        adds.push(side === 'top' ? ['lid', 'Lid'] : ['base', 'Base']);
      } else if (p.kind === 'base' && side === 'bottom') {
        adds.push(['foot', 'Foot ring']);
      }
      if (adds.length) {
        h += `<p class="sub">Add ${side === 'top' ? 'on top' : 'below'}:</p><div class="row wrap">${adds.map(([k, l]) => `<button type="button" data-add="${k}">${l}</button>`).join('')}</div>`;
        if (isWall(p)) h += `<p class="fine">Taper out means wider at the top.</p>`;
      }
      h += `<div class="row"><button type="button" data-act="attach">Attach to another edge</button><button type="button" data-act="select-part">Edit ${esc(names[p.id])}</button></div>`;
    }
    el.innerHTML = h;
    return;
  }

  // part
  let h = `<h3>${esc(names[p.id])} <span class="kind">${esc(describePart(p) || p.kind)}</span></h3>`;
  if (p.kind === 'round') {
    h += numField('dTop', `Top diameter (${dimNote})`, p.dTop, { linked: linkedName(p, 'top') });
    h += numField('dBot', `Bottom diameter (${dimNote})`, p.dBot, { linked: linkedName(p, 'bottom') });
    h += numField('h', 'Height', p.h);
    h += `<div class="row"><button type="button" data-act="invert">Flip taper</button><button type="button" data-act="straight">Make straight</button></div>`;
  } else if (p.kind === 'facet') {
    h += numField('n', 'Sides', p.n, { len: false, min: 3, max: 24, step: 1 });
    h += numField('wTop', `Top width across flats (${dimNote})`, p.wTop, { linked: linkedName(p, 'top') });
    h += numField('wBot', `Bottom width across flats (${dimNote})`, p.wBot, { linked: linkedName(p, 'bottom') });
    h += numField('h', 'Height', p.h);
    h += `<label class="field"><span>Template</span><select data-key="layout"><option value="net"${p.layout === 'net' ? ' selected' : ''}>One piece, fold at corners</option><option value="single"${p.layout === 'single' ? ' selected' : ''}>Single panel, cut ${p.n}</option></select></label>`;
    h += `<div class="row"><button type="button" data-act="invert">Flip taper</button><button type="button" data-act="straight">Make straight</button></div>`;
  } else if (p.kind === 'foot') {
    h += numField('dTop', 'Diameter at the base', p.dTop);
    h += numField('dBot', 'Diameter at the bottom', p.dBot);
    h += numField('h', 'Height', p.h);
    h += `<p class="fine">Foot sizes are outside sizes. The base template shows where the foot goes.</p>`;
  } else if (p.kind === 'base') {
    const w = supportWall(state, p);
    h += `<p class="sub">${w ? `Sized to the bottom of ${esc(names[w.id])}.` : 'Not joined to a wall yet.'}</p>`;
  } else if (p.kind === 'lid') {
    const w = supportWall(state, p);
    h += `<p class="sub">${w ? `Sized to the top of ${esc(names[w.id])}.` : 'Not joined to a wall yet.'}</p>`;
    h += numField('overhang', 'Overhang past the rim', p.overhang);
    h += `<label class="check"><input type="checkbox" data-key="flange"${p.flange ? ' checked' : ''}> Flange ring underneath</label>`;
    if (p.flange) h += numField('fw', 'Flange width', p.fw);
  }
  h += edgeButtons(p);
  const loose = (p.kind === 'base' && !joinAt(state, p.id, 'top')) || (p.kind === 'lid' && !joinAt(state, p.id, 'bottom')) || (p.kind === 'foot' && !joinAt(state, p.id, 'top'));
  h += `<div class="row">`;
  if (loose) h += `<button type="button" data-act="attach-part">Attach to a ${p.kind === 'foot' ? 'base' : 'wall'}</button>`;
  h += `<button type="button" data-act="duplicate">Duplicate</button><button type="button" class="danger" data-act="delete">Delete</button></div>`;
  el.innerHTML = h;
}

/* ---------- settings ---------- */
const SETTINGS = [
  ['Clay', [
    ['shrink', 'Shrinkage', 'num', { unit: '%', len: false, max: 40, step: 0.5, hint: 'Enter finished sizes. Templates are enlarged to allow for shrinkage.' }],
    ['thick', 'Slab thickness', 'num', { step: 0.5 }],
    ['dimMode', 'Sizes are measured', 'select', { options: [['outside', 'Outside'], ['inside', 'Inside']] }],
    ['seam', 'Side seam', 'select', { options: [['overlap', 'Overlap'], ['butt', 'Butt joint'], ['bevel', 'Bevel']] }],
    ['seamAllow', 'Overlap allowance', 'num', { show: s => s.seam === 'overlap' }],
    ['baseFit', 'Walls', 'select', { options: [['on', 'Sit on top of the base'], ['around', 'Wrap around the base']] }],
  ]],
  ['Paper', [
    ['paper', 'Paper', 'select', { options: [['letter', 'US Letter'], ['a4', 'A4'], ['legal', 'US Legal'], ['tabloid', 'Tabloid'], ['a3', 'A3']] }],
    ['orient', 'Orientation', 'select', { options: [['portrait', 'Portrait'], ['landscape', 'Landscape']] }],
    ['marginPreset', 'Margins', 'marginPreset', {}],
    ['margin', 'Margin size', 'num', { step: 0.5, hint: s => (s.margin < 6 ? 'Laser printers can usually print to about 4.2 mm from the edge. Many inkjets need more at the bottom. Print one page and check that nothing is cut off.' : '') }],
    ['overlap', 'Overlap between tiled pages', 'num', { step: 1 }],
    ['printViews', 'Add 3D views to the printout', 'check', {}],
  ]],
];

const hintOf = o => (typeof o.hint === 'function' ? o.hint(state) : o.hint || '');
function renderSettings() {
  $('#settings').innerHTML = SETTINGS.map(([title, fields]) => `<details${title === 'Clay' ? ' open' : ''}><summary>${title}</summary>${fields.map(([key, label, type, o]) => {
    if (o.show && !o.show(state)) return '';
    if (type === 'check') return `<label class="check"><input type="checkbox" data-setting="${key}"${state[key] ? ' checked' : ''}> ${label}</label>`;
    if (type === 'marginPreset') {
      const cur = MARGIN_PRESETS.find(([, , mm]) => Math.abs(mm - state.margin) < 0.01);
      return `<label class="field"><span>${label}</span><select data-setting="marginPreset">${MARGIN_PRESETS.map(([v, l]) => `<option value="${v}"${cur && cur[0] === v ? ' selected' : ''}>${l}</option>`).join('')}<option value="custom"${cur ? '' : ' selected'}>Custom</option></select></label>`;
    }
    if (type === 'select') return `<label class="field"><span>${label}</span><select data-setting="${key}">${o.options.map(([v, l]) => `<option value="${v}"${state[key] === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    const isLen = o.len !== false;
    return `<label class="field"><span>${label}</span><span class="input"><input type="number" inputmode="decimal" data-setting="${key}" data-len="${isLen ? 1 : 0}" value="${isLen ? toShow(state[key]) : state[key]}" step="${isLen ? (U() === 'in' ? 0.0625 : o.step || 0.5) : o.step || 1}" min="0"${o.max ? ` max="${o.max}"` : ''}><i>${o.unit || (isLen ? unitLabel() : '')}</i></span>${hintOf(o) ? `<small class="${key === 'margin' ? 'warn-text' : ''}">${hintOf(o)}</small>` : ''}</label>`;
  }).join('')}</details>`).join('');
  document.querySelectorAll('[data-units]').forEach(b => b.classList.toggle('active', b.dataset.units === state.units));
}

/* ---------- output ---------- */
let lastLayout = null;
function renderOutput() {
  const res = buildPieces(state);
  const pieces = res.pieces.filter(p => p.pts.length);
  if (state.printViews && view && state.parts.length) {
    const vp = viewsPiece(view.snapshots());
    if (vp) pieces.unshift(vp);
  }
  const L = layoutPages(pieces, state);
  lastLayout = { ...L, s: JSON.parse(JSON.stringify(state)) };
  const g = L.g, N = L.pages.length;
  $('#print-size').textContent = `@page { size: ${n3(g.W)}mm ${n3(g.H)}mm; margin: 0; }
    @media print { .page, .page svg { width: ${n3(g.W)}mm !important; height: ${n3(g.H)}mm !important; } }`;

  const lay = layout(state);
  const tall = Math.max(0, ...lay.groups.map(gr => gr.h));
  const wide = Math.max(0, ...lay.groups.map(gr => gr.r * 2));
  $('#overall').textContent = state.parts.length ? `Finished size about ${f(wide)} wide × ${f(tall)} tall` : '';

  const rows = res.pieces.map(p => `<tr data-part="${p.partId}"><td>${esc(p.name)}${p.qty > 1 ? ` <span class="qty">cut ${p.qty}</span>` : ''}</td><td>${esc(p.size)}</td></tr>`).join('');
  $('#summary').innerHTML = `
    <div class="facts"><span><b>${N}</b> page${N === 1 ? '' : 's'}</span><span>templates <b>×${res.k.toFixed(3)}</b> for ${state.shrink}% shrinkage</span><span>about <b>${Math.round(res.weight)} g</b> of clay</span></div>
    ${res.errors.length ? `<ul class="errors">${res.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    <table class="pieces"><thead><tr><th>Template piece</th><th>Size (wet)</th></tr></thead><tbody>${rows}</tbody></table>
    ${res.notes.length ? `<ul class="notes">${res.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;

  $('#pages').innerHTML = L.pages.map((pg, i) => `<div class="page-wrap"><div class="page" style="aspect-ratio:${n3(g.W)}/${n3(g.H)}">${pageSVG(pg, i, N, state, g)}</div><div class="page-caption">Page ${i + 1}${pg.kind === 'tile' ? `, ${esc(pg.pc.name)} ${colName(pg.tile.c)}${pg.tile.r + 1}` : ''}</div></div>`).join('');
}

/* Small 3D previews placed on the printout (opt in). */
function viewsPiece(snaps) {
  if (!snaps.length) return null;
  const S = 46, gap = 4, cap = 4;
  const labels = { iso: '3/4 view', front: 'Front', top: 'Top' };
  let o = '';
  snaps.forEach((v, i) => {
    const x = i * (S + gap);
    o += `<image href="${v.url}" x="${x}" y="0" width="${S}" height="${S}"/>`;
    o += `<text x="${x + S / 2}" y="${S + cap - 0.6}" font-size="2.6" text-anchor="middle" fill="#444">${labels[v.name] || v.name}</text>`;
  });
  const w = snaps.length * S + (snaps.length - 1) * gap;
  return rawPiece('3D views', w, S + cap, o);
}

function downloadSVG() {
  if (!lastLayout) return;
  const { pages, g, s } = lastLayout;
  const gap = 10, N = pages.length;
  const totalH = N * g.H + (N - 1) * gap;
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n3(g.W)}mm" height="${n3(totalH)}mm" viewBox="0 0 ${n3(g.W)} ${n3(totalH)}">`;
  pages.forEach((pg, i) => {
    const inner = pageSVG(pg, i, N, s, g).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    o += `<g transform="translate(0 ${n3(i * (g.H + gap))})" font-family="${FONT}">${inner}</g>`;
  });
  o += `</svg>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([o], { type: 'image/svg+xml' }));
  a.download = 'paperpot-templates.svg';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- refresh ---------- */
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const enc = encode(state);
    try { history.replaceState(null, '', '#s=' + enc); } catch (e) { /* ignore */ }
    try { localStorage.setItem('paperpot-v2', enc); } catch (e) { /* ignore */ }
  }, 250);
}

let prevSig = '';
const structureSig = () => state.parts.length + ':' + state.joins.map(([a, b]) => a.id + a.side + b.id + b.side).join(',') + ':' + state.baseFit;
function refresh({ structural = true, panel = true } = {}) {
  if (panel) renderPanel();
  renderParts();
  if (structural) renderSettings();
  renderMessage();
  if (view) {
    view.update(state, sel, pending);
    const sig = structureSig();
    if (sig !== prevSig) { view.fit(true); prevSig = sig; }
  }
  renderOutput();
  if (document.activeElement?.id !== 'potName') $('#potName').value = state.name || '';
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  persist();
}

/* ---------- actions ---------- */
function select(t) {
  sel = t;
  say(null);
  refresh({ structural: false });
}

function onPick(t) {
  $('#tip').hidden = true;
  if (pending) {
    if (!t || t.type !== 'edge') { say('Click an edge (the rim of a part) to attach to.', 'warn'); return; }
    const src = pending;
    const err = canJoin(state, src, t);
    if (err) { say(err, 'warn'); return; }
    pending = null;
    mutate(() => join(state, src, t));
    sel = { type: 'edge', id: t.id, side: t.side };
    say('Joined.', 'ok');
    refresh({ structural: false });
    return;
  }
  select(t);
}

function onHover(t, ev) {
  const tip = $('#tip');
  if (!t || !ev) { tip.hidden = true; return; }
  const names = partNames(state);
  const p = getPart(state, t.id);
  let text = names[t.id];
  if (t.type === 'edge') {
    text += `, ${t.side} edge`;
    if (p.kind === 'round') text += `, ⌀ ${f(p[t.side === 'top' ? 'dTop' : 'dBot'])}`;
    if (p.kind === 'facet') text += `, ${f(p[t.side === 'top' ? 'wTop' : 'wBot'])} across flats`;
    if (pending) { const err = canJoin(state, pending, t); text += err ? ` (can't join: ${err})` : ' (click to join)'; }
    else if (joinAt(state, t.id, t.side)) text += ' (joined)';
  }
  const r = $('#view').getBoundingClientRect();
  tip.textContent = text;
  tip.hidden = false;
  tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 220) + 'px';
  tip.style.top = (ev.clientY - r.top + 14) + 'px';
}

function addLoose(kind) {
  mutate(() => {
    const p = addPart(state, kind, kind === 'round' ? { dTop: 80, dBot: 80, h: 80 } : {});
    sel = { type: 'part', id: p.id };
  });
  if (kind === 'base' || kind === 'lid' || kind === 'foot') {
    pending = { id: sel.id, side: kind === 'lid' ? 'bottom' : 'top' };
    say(null);
    refresh({ structural: false });
  }
}

function act(name) {
  const p = sel && getPart(state, sel.id);
  switch (name) {
    case 'cancel-attach': pending = null; say(null); refresh({ structural: false }); break;
    case 'attach': pending = { id: sel.id, side: sel.side }; say(null); refresh({ structural: false }); break;
    case 'attach-part': pending = { id: p.id, side: p.kind === 'lid' ? 'bottom' : 'top' }; say(null); refresh({ structural: false }); break;
    case 'detach': mutate(() => detach(state, sel.id, sel.side)); say('Detached.', 'ok'); break;
    case 'select-part': select({ type: 'part', id: sel.id }); break;
    case 'invert': mutate(() => {
      if (p.kind === 'round') [p.dTop, p.dBot] = [p.dBot, p.dTop]; else [p.wTop, p.wBot] = [p.wBot, p.wTop];
      syncAll(state, p.id);
    }); break;
    case 'straight': mutate(() => {
      if (p.kind === 'round') { const top = !!partnerOf(state, p.id, 'bottom') && !partnerOf(state, p.id, 'top'); top ? (p.dTop = p.dBot) : (p.dBot = p.dTop); }
      else { const top = !!partnerOf(state, p.id, 'bottom') && !partnerOf(state, p.id, 'top'); top ? (p.wTop = p.wBot) : (p.wBot = p.wTop); }
      syncAll(state, p.id);
    }); break;
    case 'duplicate': mutate(() => { const { id, ...rest } = p; const q = addPart(state, p.kind, rest); sel = { type: 'part', id: q.id }; }); break;
    case 'delete': mutate(() => { removePart(state, p.id); sel = null; }); break;
  }
}

function addAt(spec) {
  const [kind, variant] = spec.split(':');
  const r = mutate(() => addAtEdge(state, sel.id, sel.side, kind, variant));
  if (r.err) { say(r.err, 'warn'); return; }
  sel = { type: 'part', id: r.part.id };
  refresh({ structural: false });
}

/* ---------- events ---------- */
function bind() {
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.part) select({ type: 'part', id: b.dataset.part });
    else if (b.dataset.edge) { const [id, side] = b.dataset.edge.split(':'); pending ? onPick({ type: 'edge', id, side }) : select({ type: 'edge', id, side }); }
    else if (b.dataset.act) act(b.dataset.act);
    else if (b.dataset.add) addAt(b.dataset.add);
    else if (b.dataset.loose) addLoose(b.dataset.loose);
    else if (b.dataset.view) view && view.setView(b.dataset.view);
    else if (b.dataset.units) mutate(() => { state.units = b.dataset.units; });
  });

  // part fields: live update without rebuilding the panel
  let editBefore = null;
  $('#panel').addEventListener('focusin', () => { editBefore = snapshot(); });
  $('#panel').addEventListener('input', e => {
    const el = e.target, key = el.dataset.key;
    if (!key || !sel) return;
    const p = getPart(state, sel.id);
    if (el.type === 'number') {
      const v = parseFloat(el.value);
      if (!isFinite(v) || v < 0) return;
      p[key] = el.dataset.len === '1' ? fromShow(v) : Math.round(v);
      if (key === 'n') p.n = Math.max(3, Math.min(24, p.n));
      syncAll(state, p.id);
      refresh({ structural: false, panel: false });
    }
  });
  $('#panel').addEventListener('change', e => {
    const el = e.target, key = el.dataset.key;
    if (!key || !sel) return;
    const p = getPart(state, sel.id);
    if (el.type === 'checkbox') p[key] = el.checked;
    else if (el.tagName === 'SELECT') p[key] = el.value;
    else if (key === 'n') {
      // changing the side count breaks joins to walls with a different count
      for (const side of ['top', 'bottom']) {
        const q = partnerOf(state, p.id, side);
        if (q && getPart(state, q.id).kind === 'facet' && getPart(state, q.id).n !== p.n) { detach(state, p.id, side); say(`Detached the ${side} edge: the side counts no longer match.`, 'warn'); }
      }
    }
    commit(editBefore); editBefore = snapshot();
    refresh({ structural: false });
  });

  let setBefore = null;
  $('#settings').addEventListener('focusin', () => { setBefore = snapshot(); });
  $('#settings').addEventListener('input', e => {
    const el = e.target, key = el.dataset.setting;
    if (!key || el.type !== 'number') return;
    const v = parseFloat(el.value);
    if (!isFinite(v) || v < 0) return;
    state[key] = el.dataset.len === '1' ? fromShow(v) : v;
    refresh({ structural: false });
  });
  $('#settings').addEventListener('change', e => {
    const el = e.target, key = el.dataset.setting;
    if (!key) return;
    if (key === 'marginPreset') {
      const pr = MARGIN_PRESETS.find(([v]) => v === el.value);
      if (pr) state.margin = pr[2];
      else { renderSettings(); document.querySelector('[data-setting="margin"]')?.focus(); return; }
    } else if (el.type === 'checkbox') state[key] = el.checked;
    else if (el.tagName === 'SELECT') state[key] = el.value;
    commit(setBefore); setBefore = snapshot();
    refresh({ structural: true });
  });

  $('#preset').addEventListener('change', e => {
    const k = e.target.value;
    if (!k) return;
    e.target.value = '';
    mutate(() => {
      const keep = {};
      for (const key of Object.keys(SETTINGS_DEFAULTS)) keep[key] = state[key];
      state = newState(k, keep);
      sel = null; pending = null;
    });
    prevSig = '';
    refresh();
  });

  let nameBefore = null;
  $('#potName').addEventListener('focus', () => { nameBefore = snapshot(); });
  $('#potName').addEventListener('input', e => { state.name = e.target.value.slice(0, 60); renderOutput(); persist(); });
  $('#potName').addEventListener('change', () => { commit(nameBefore); nameBefore = snapshot(); refresh({ structural: false }); });

  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#printBtn').addEventListener('click', () => window.print());
  $('#svgBtn').addEventListener('click', downloadSVG);
  $('#shareBtn').addEventListener('click', async e => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(location.origin + location.pathname + '#s=' + encode(state)); b.textContent = 'Link copied'; }
    catch (err) { b.textContent = 'Copy from the address bar'; }
    setTimeout(() => { b.textContent = 'Copy link'; }, 1600);
  });

  document.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (typing) return;
    if (e.key === 'Escape') { if (pending) { pending = null; say(null); refresh({ structural: false }); } else if (sel) select(null); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.type === 'part') act('delete');
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => view && view.setTheme());
}

/* ---------- start ---------- */
function load() {
  const m = location.hash.match(/^#s=(.+)$/);
  let s = m ? decode(m[1]) : null;
  if (!s) { try { const ls = localStorage.getItem('paperpot-v2'); if (ls) s = decode(ls); } catch (e) { /* ignore */ } }
  return s || newState('tumbler');
}

async function init() {
  state = load();
  $('#preset').innerHTML = `<option value="">Start from…</option>` + Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  bind();
  refresh();
  try {
    const { createView } = await import('./view3d.js');
    view = createView($('#view'), { onPick, onHover });
    view.init();
    view.update(state, sel, pending);
    view.fit(false);
    prevSig = structureSig();
    window.paperpot = { view, get state() { return state; } }; // handy for debugging in the console
    if (state.printViews) renderOutput();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<p class="view-error">The 3D view could not load (${esc(e.message)}). Templates below still work.</p>`;
  }
}

init();
