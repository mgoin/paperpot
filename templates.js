/* PaperPot: flat template geometry, page layout and printable SVG pages.
 * All geometry is in millimetres at wet (template) size. */
const MM_PER_IN = 25.4;
const TAU = Math.PI * 2;

const PAPERS = {
  letter:  { name: 'US Letter', w: 215.9, h: 279.4 },
  a4:      { name: 'A4',        w: 210,   h: 297   },
  legal:   { name: 'US Legal',  w: 215.9, h: 355.6 },
  tabloid: { name: 'Tabloid',   w: 279.4, h: 431.8 },
  a3:      { name: 'A3',        w: 297,   h: 420   },
};
/* ---------- small helpers ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const n3 = v => (Math.round(v * 1000) / 1000).toString();
const pt = p => n3(p[0]) + ' ' + n3(p[1]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = a => Math.hypot(a[0], a[1]);
const norm = a => mul(a, 1 / (len(a) || 1));
const rot = (p, ang) => [p[0] * Math.cos(ang) - p[1] * Math.sin(ang), p[0] * Math.sin(ang) + p[1] * Math.cos(ang)];
const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function polyD(pts) { return 'M' + pts.map(pt).join('L') + 'Z'; }
function lineD(a, b) { return 'M' + pt(a) + 'L' + pt(b); }
function circleD(cx, cy, r) {
  return `M${n3(cx - r)} ${n3(cy)}A${n3(r)} ${n3(r)} 0 1 0 ${n3(cx + r)} ${n3(cy)}A${n3(r)} ${n3(r)} 0 1 0 ${n3(cx - r)} ${n3(cy)}Z`;
}
function densify(pts, step = 2) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const k = Math.max(1, Math.ceil(len(sub(b, a)) / step));
    for (let j = 0; j < k; j++) out.push(add(a, mul(sub(b, a), j / k)));
  }
  return out;
}
function circlePts(cx, cy, r) {
  const n = Math.max(72, Math.ceil(TAU * r / 2));
  const out = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos(TAU * i / n), cy + r * Math.sin(TAU * i / n)]);
  return out;
}
function arcPts(r, a0, a1) {
  const n = Math.max(12, Math.ceil(Math.abs(a1 - a0) * r / 2));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(polar(r, a0 + (a1 - a0) * i / n));
  return out;
}
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function rotPts(pts, deg) { const a = deg * Math.PI / 180; return pts.map(p => rot(p, a)); }
function inPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fmt(mm, units, unit = true) {
  if (units === 'in') return (mm / MM_PER_IN).toFixed(2) + (unit ? '″' : '');
  return (Math.round(mm * 10) / 10).toFixed(1).replace(/\.0$/, '') + (unit ? ' mm' : '');
}

/* ---------- geometry: frustum (tapered wall) ---------- */
/* Rt, Rb: mid-wall radii at top and bottom; h: vertical wall height.
 * Returns the flat annular-sector pattern for the cone frustum. */
function frustum(Rt, Rb, h) {
  const s = Math.hypot(h, Rt - Rb);
  if (Math.abs(Rt - Rb) < 0.5) return { flat: true, s, C: Math.PI * (Rt + Rb) };
  const big = Math.max(Rt, Rb), small = Math.min(Rt, Rb);
  const L = big * s / (big - small);
  const l = L - s;
  const theta = TAU * big / L;
  return { flat: false, s, L, l, theta, topIsOuter: Rt > Rb };
}

/* ---------- pieces ---------- */
let pieceUid = 0;
function newPiece(name, qty = 1) {
  return { uid: ++pieceUid, name, qty, outline: '', pts: [], seam: [], dashed: [], ticks: [], texts: [], area: 0, size: '' };
}
function labelBlock(pc, cx, cy, lines, minDim) {
  const sc = clamp(minDim / 45, 0.55, 1);
  const sizes = lines.map((_, i) => (i === 0 ? 4.4 : 3.1) * sc);
  const total = sizes.reduce((a, b) => a + b * 1.4, 0);
  let y = cy - total / 2;
  lines.forEach((t, i) => {
    y += sizes[i] * 1.4;
    pc.texts.push({ x: cx, y: y - sizes[i] * 0.35, t, size: sizes[i], bold: i === 0, lbl: true });
  });
  pc.labelLines = lines;
}

/* Rectangle wall/slab. opts: allow (hatched overlap zone added on the right),
 * bevel (hatched zones of this width inside both ends), ticks (fractions),
 * tickStart/tickSpan (where the circumference ticks live), inset (dashed inner rect). */
function rectPiece(name, w, h, qty, opts = {}) {
  const pc = newPiece(name, qty);
  const a = opts.allow || 0, bz = opts.bevel || 0;
  const W = w + a;
  const corners = [[0, 0], [W, 0], [W, h], [0, h]];
  pc.outline = polyD(corners);
  pc.pts = densify(corners);
  if (a > 0) {
    pc.seam.push(polyD([[w, 0], [W, 0], [W, h], [w, h]]));
    pc.dashed.push(lineD([w, 0], [w, h]));
  }
  if (bz > 0) {
    pc.seam.push(polyD([[0, 0], [bz, 0], [bz, h], [0, h]]));
    pc.seam.push(polyD([[w - bz, 0], [w, 0], [w, h], [w - bz, h]]));
    pc.dashed.push(lineD([bz, 0], [bz, h]), lineD([w - bz, 0], [w - bz, h]));
  }
  if (opts.inset) {
    const i = opts.inset;
    pc.dashed.push(polyD([[i, i], [w - i, i], [w - i, h - i], [i, h - i]]));
  }
  const ts = opts.tickStart || 0, tspan = opts.tickSpan || w;
  const tl = Math.min(5, h / 6);
  for (const f of (opts.ticks || [0.5])) {
    const x = ts + tspan * f;
    pc.ticks.push(lineD([x, 0], [x, tl]), lineD([x, h], [x, h - tl]));
  }
  if (opts.sideTicks !== false) {
    const sl = Math.min(5, w / 6);
    pc.ticks.push(lineD([0, h / 2], [sl, h / 2]), lineD([W, h / 2], [W - sl, h / 2]));
  }
  pc.area = W * h;
  pc.size = `${w + a}×${h}`;
  pc.w = W; pc.h = h;
  return pc;
}

function circlePiece(name, D, qty = 1, opts = {}) {
  const pc = newPiece(name, qty);
  const r = D / 2;
  pc.outline = circleD(r, r, r);
  pc.pts = circlePts(r, r, r);
  pc.area = Math.PI * r * r;
  if (opts.hole) {
    const hr = opts.hole / 2;
    pc.outline += circleD(r, r, hr);
    pc.area -= Math.PI * hr * hr;
  }
  if (opts.dashed) pc.dashed.push(circleD(r, r, opts.dashed / 2));
  const tl = Math.min(5, r / 5);
  for (let i = 0; i < 4; i++) {
    if (opts.hole && i === 3) continue; // keep the top of a ring clear for its label
    const a = i * Math.PI / 2;
    pc.ticks.push(lineD(add([r, r], polar(r, a)), add([r, r], polar(r - tl, a))));
  }
  if (!opts.hole) pc.ticks.push(lineD([r - 3, r], [r + 3, r]), lineD([r, r - 3], [r, r + 3]));
  pc.w = D; pc.h = D;
  return pc;
}

function polygonPiece(name, n, flats, qty = 1, opts = {}) {
  const pc = newPiece(name, qty);
  const ap = flats / 2, R = ap / Math.cos(Math.PI / n);
  const c = [R, R];
  const verts = [];
  for (let i = 0; i < n; i++) verts.push(add(c, polar(R, Math.PI / 2 + Math.PI / n + TAU * i / n)));
  pc.outline = polyD(verts);
  pc.pts = densify(verts);
  pc.area = n * ap * ap * Math.tan(Math.PI / n);
  if (opts.dashedFlats) {
    const R2 = (opts.dashedFlats / 2) / Math.cos(Math.PI / n);
    pc.dashed.push(polyD(verts.map((_, i) => add(c, polar(R2, Math.PI / 2 + Math.PI / n + TAU * i / n)))));
  }
  pc.ticks.push(lineD([R - 3, R], [R + 3, R]), lineD([R, R - 3], [R, R + 3]));
  return pc;
}

/* Annular sector wall for a tapered pot. Centre of the circles at the origin;
 * sector is symmetric about the upward axis (angle -90°). */
function sectorPiece(name, fr, opts = {}) {
  const pc = newPiece(name);
  const { L, l, theta } = fr;
  const p0 = -Math.PI / 2 - theta / 2, p1 = -Math.PI / 2 + theta / 2;
  const large = theta > Math.PI ? 1 : 0;
  const a = opts.allow || 0;
  const I0 = polar(l, p0), O0 = polar(L, p0), O1 = polar(L, p1), I1 = polar(l, p1);
  const nEnd = [-Math.sin(p1), Math.cos(p1)];
  const O1b = add(O1, mul(nEnd, a)), I1b = add(I1, mul(nEnd, a));
  let d = `M${pt(I0)}L${pt(O0)}A${n3(L)} ${n3(L)} 0 ${large} 1 ${pt(O1)}`;
  if (a > 0) d += `L${pt(O1b)}L${pt(I1b)}`;
  d += `L${pt(I1)}A${n3(l)} ${n3(l)} 0 ${large} 0 ${pt(I0)}Z`;
  pc.outline = d;
  pc.pts = [...arcPts(L, p0, p1), ...(a > 0 ? densify([O1b, I1b]).slice(0, -1) : []), ...arcPts(l, p1, p0)];
  if (a > 0) {
    pc.seam.push(polyD([O1, O1b, I1b, I1]));
    pc.dashed.push(lineD(I1, O1));
  }
  if (opts.bevel) {
    const nStart = [-Math.sin(p0), Math.cos(p0)];
    const b = opts.bevel;
    pc.seam.push(polyD([I0, O0, add(O0, mul(nStart, b)), add(I0, mul(nStart, b))]));
    pc.dashed.push(lineD(add(I0, mul(nStart, b)), add(O0, mul(nStart, b))));
  }
  const tl = Math.min(5, (L - l) / 6);
  for (const f of [0.25, 0.5, 0.75]) {
    const ph = p0 + theta * f;
    pc.ticks.push(lineD(polar(L, ph), polar(L - tl, ph)), lineD(polar(l, ph), polar(l + tl, ph)));
  }
  const ph = (p0 + p1) / 2;
  const sl = Math.min(5, l * theta / 6);
  const mr = (L + l) / 2;
  pc.ticks.push(lineD(polar(mr, p0), add(polar(mr, p0), mul([-Math.sin(p0), Math.cos(p0)], sl))));
  pc.ticks.push(lineD(polar(mr, p1), add(polar(mr, p1), mul([Math.sin(p1), -Math.cos(p1)], sl))));
  pc.area = theta / 2 * (L * L - l * l) + a * (L - l);
  pc.textCenter = polar(mr, ph);
  pc.arc = { L, l, theta, p0, p1, topIsOuter: !!opts.topIsOuter };
  return pc;
}

function polyWall(name, n, wt, wb, sh, layout, allow, notes = {}) {
  const B0 = [0, 0], B1 = [wb, 0], T1 = [(wb + wt) / 2, -sh], T0 = [(wb - wt) / 2, -sh];
  const base = [B0, B1, T1, T0];
  const single = layout === 'single';
  const panels = [base];
  if (!single) {
    for (let i = 1; i < n; i++) {
      const prev = panels[i - 1];
      const e = sub(T0, B0), f = sub(prev[2], prev[1]);
      const ang = Math.atan2(f[1], f[0]) - Math.atan2(e[1], e[0]);
      panels.push(base.map(p => add(rot(sub(p, B0), ang), prev[1])));
    }
  }
  const last = panels[panels.length - 1];
  const pc = newPiece(name, single ? n : 1);
  const outline = [panels[0][0], ...panels.map(p => p[1])];
  if (!single && allow > 0) {
    const dir = norm(sub(last[2], last[1]));
    const nn = [-dir[1], dir[0]];
    const a1 = add(last[1], mul(nn, allow)), a2 = add(last[2], mul(nn, allow));
    outline.push(a1, a2);
    pc.seam.push(polyD([last[1], a1, a2, last[2]]));
    pc.dashed.push(lineD(last[1], last[2]));
  }
  outline.push(last[2], ...panels.slice().reverse().map(p => p[3]));
  pc.outline = polyD(outline);
  pc.pts = densify(outline);
  pc.area = panels.length * (wt + wb) / 2 * sh + (single ? 0 : allow * sh);
  panels.forEach((p, i) => {
    if (i < panels.length - 1) pc.dashed.push(lineD(p[1], p[2]));
    const mb = mul(add(p[0], p[1]), 0.5), mt = mul(add(p[2], p[3]), 0.5);
    const dn = norm(sub(mt, mb));
    pc.ticks.push(lineD(mb, add(mb, mul(dn, 4))), lineD(mt, sub(mt, mul(dn, 4))));
  });

  // edge notes along the top and bottom edges, set just inside the piece
  const { note, stacked, inset } = noteSizes(sh, 4);
  const dTop = stacked ? inset + note * 0.8 : note * 1.05 + 0.6, dBot = stacked ? inset + 0.2 : note * 0.45 + 0.6;
  const inward = (top, bottom, d) => add(top, mul(norm(sub(bottom, top)), d));
  const topLine = [inward(panels[0][3], panels[0][0], dTop), ...panels.map(p => inward(p[2], p[1], dTop))];
  const botLine = [inward(panels[0][0], panels[0][3], dBot), ...panels.map(p => inward(p[1], p[2], dBot))];
  const lenOf = pts => pts.slice(1).reduce((a, q, i) => a + len(sub(q, pts[i])), 0);
  edgeNotes(pc, lenOf(topLine), notes.top, notes.bottom, (t, offset, anchor, which) => {
    pc.texts.push({ poly: which === 'top' ? topLine : botLine, offset, anchor, t, size: note });
  });
  // fold label written along the first fold line
  if (!single && n > 1) {
    const a = panels[0][1], b = panels[0][2];
    const d = norm(sub(b, a)), left = [d[1], -d[0]];
    pc.texts.push({ poly: [add(a, mul(left, 0.7)), add(b, mul(left, 0.7))], offset: 0.5, anchor: 'middle', t: 'score and fold', size: Math.min(2.2, note) });
  }
  const mid = panels[Math.floor((panels.length - 1) / 2)];
  const c = mul(add(add(mid[0], mid[1]), add(mid[2], mid[3])), 0.25);
  const lines = single ? [name, `cut ${n}`] : [name];
  labelBlock(pc, c[0], c[1], lines, Math.min(wt, wb, sh) * 1.4);
  return pc;
}


/* Units used for text printed on pieces (set per render). */
let currentUnits = 'mm';
export function setUnits(u) { currentUnits = u; }
const fmtU = mm => fmt(mm, currentUnits);

/* ---------- labels ----------
 * Wall pieces: the name in the middle, and a short note along the inside of each
 * edge. The top note starts at the left end of the top edge and the bottom note
 * ends at the right end of the bottom edge, so they never sit on top of each
 * other. Long pieces repeat the notes so every tiled sheet gets them.
 * Guide lines (dashed) get their label written along the line itself. */
const NAME = 4.4, NOTE = 2.5;
const textW = (t, size) => t.length * size * 0.55;

/* Sizes for a piece `band` mm tall whose edges carry alignment ticks `tick` mm
 * long. Notes sit just past the ticks so text never crosses them. */
function noteSizes(band, tick = 0) {
  const note = clamp(band * 0.2, 1.5, NOTE);
  const name = clamp(band * 0.3, 1.8, NAME);
  const inset = tick > 0 ? tick + 1 : 0.6;
  // room for: top note, name, bottom note, each clear of the ticks
  const stacked = 2 * (inset + note * 1.1) + name * 1.3 + 2 <= band;
  return { note, name, stacked, inset };
}

function edgeNotes(pc, len, top, bot, place) {
  // place(text, size, offset 0..1, anchor, which) adds one text item
  // start 7 mm in from the cut ends, clear of the end ticks and seam line
  const n = Math.max(1, Math.floor(len / 200));
  const pad = Math.min(0.12, 7 / len);
  for (let k = 0; k < n; k++) {
    if (top) place(top, k / n + pad, 'start', 'top');
    if (bot) place(bot, (k + 1) / n - pad, 'end', 'bottom');
  }
}

function labelArc(pc, name, topNote, botNote) {
  const { L, l, theta, p0, p1, topIsOuter } = pc.arc;
  const band = L - l, mr = (L + l) / 2;
  const { note, name: nameSize, stacked, inset } = noteSizes(band, Math.min(5, band / 6));
  pc.labelLines = [name];
  // Text runs clockwise (left to right), so glyph tops point to the outer arc.
  const outerR = L - inset - note * 0.8, innerR = l + inset + 0.2;
  const rTop = stacked ? (topIsOuter ? outerR : innerR) : mr - note * 0.35;
  const rBot = stacked ? (topIsOuter ? innerR : outerR) : mr - note * 0.35;
  edgeNotes(pc, mr * theta, topNote, botNote, (t, offset, anchor, which) => {
    pc.texts.push({ arc: { r: which === 'top' ? rTop : rBot, a0: p0, a1: p1 }, offset, anchor, t, size: note, bold: false });
  });
  if (stacked && textW(name, nameSize) < l * theta * 0.5) {
    const [cx, cy] = polar(mr, -Math.PI / 2);
    pc.texts.push({ x: cx, y: cy + nameSize * 0.35, t: name, size: nameSize, bold: true, lbl: true });
  } else {
    // thin piece: name in the middle of the centre line, between the two notes
    const n = Math.max(1, Math.floor(mr * theta / 200));
    for (let k = 0; k < n; k++) pc.texts.push({ arc: { r: mr - nameSize * 0.35, a0: p0, a1: p1 }, offset: (k + 0.5) / n, anchor: 'middle', t: name, size: Math.min(nameSize, note * 1.2), bold: true });
  }
}

function labelStrip(pc, w, h, name, topNote, botNote) {
  const { note, name: nameSize, stacked, inset } = noteSizes(h, Math.min(5, h / 6));
  pc.labelLines = [name];
  const yTop = stacked ? inset + note * 0.8 : h / 2 + note * 0.35;
  const yBot = stacked ? h - inset - 0.2 : h / 2 + note * 0.35;
  edgeNotes(pc, w, topNote, botNote, (t, offset, anchor, which) => {
    pc.texts.push({ x: w * offset, y: which === 'top' ? yTop : yBot, anchor, t, size: note });
  });
  if (stacked) pc.texts.push({ x: w / 2, y: h / 2 + nameSize * 0.35, t: name, size: nameSize, bold: true, lbl: true });
  else {
    const n = Math.max(1, Math.floor(w / 200));
    for (let k = 0; k < n; k++) pc.texts.push({ x: w * (k + 0.5) / n, y: h / 2 + note * 0.42, t: name, size: Math.min(nameSize, note * 1.2), bold: true });
  }
}

/* Label written along the inside of a circular guide line centred at (cx, cy).
 * 'top' reads across the top of the circle, 'bottom' across the bottom. */
function labelCircleLine(pc, cx, cy, r, t, where = 'top', size = 2.4) {
  if (where === 'top') {
    const span = Math.min(Math.PI * 0.9, (textW(t, size) * 1.3) / r);
    pc.texts.push({ arc: { cx, cy, r: r - size * 1.05, a0: -Math.PI / 2 - span / 2, a1: -Math.PI / 2 + span / 2 }, offset: 0.5, anchor: 'middle', t, size });
  } else {
    const span = Math.min(Math.PI * 0.9, (textW(t, size) * 1.3) / r);
    // counter-clockwise along the bottom keeps the text upright, glyph tops toward the centre
    pc.texts.push({ arc: { cx, cy, r: r - 0.6, a0: Math.PI / 2 + span / 2, a1: Math.PI / 2 - span / 2 }, offset: 0.5, anchor: 'middle', t, size });
  }
}

/* A non-cut item placed on a page, such as 3D preview images. */
function rawPiece(name, w, h, svg) {
  const pc = newPiece(name);
  pc.raw = svg;
  pc.pts = densify([[0, 0], [w, 0], [w, h], [0, h]], 10);
  pc.w = w; pc.h = h;
  return pc;
}

/* ---------- page layout ---------- */
const HDR = 6.5, FTR = 0, GAP = 6;

function pageGeom(s) {
  const P = PAPERS[s.paper] || PAPERS.letter;
  let W = P.w, H = P.h;
  if (s.orient === 'landscape') [W, H] = [H, W];
  const m = clamp(s.margin, 3, 40);
  const cw = W - 2 * m, ch = H - 2 * m - HDR - FTR;
  const ov = clamp(s.overlap, 0, Math.min(cw, ch) / 3);
  return { W, H, m, cw, ch, ov, sx: cw - ov, sy: ch - ov, paperName: P.name };
}

function bestTiling(piece, g) {
  let best = null;
  for (let a = 0; a < 180; a += 5) {
    const rp = rotPts(piece.pts, a);
    const bb = bbox(rp);
    const cols = Math.max(1, Math.ceil((bb.w - g.ov) / g.sx));
    const rows = Math.max(1, Math.ceil((bb.h - g.ov) / g.sy));
    // top-left aligned (2 mm in) so spare room collects in one place for small pieces
    const offX = Math.min((cols * g.sx + g.ov - bb.w) / 2, 2), offY = Math.min((rows * g.sy + g.ov - bb.h) / 2, 2);
    const tp = rp.map(([x, y]) => [x - bb.x + offX, y - bb.y + offY]);
    const tiles = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = c * g.sx, y0 = r * g.sy, x1 = x0 + g.cw, y1 = y0 + g.ch;
      let hit = tp.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
      if (!hit) hit = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]].some(p => inPoly(p, tp));
      if (hit) tiles.push({ c, r });
    }
    const off90 = Math.min(a % 90, 90 - (a % 90));
    const score = tiles.length * 1e4 + cols * rows * 10 + off90 / 10;
    if (!best || score < best.score) best = { score, a, bb, cols, rows, offX, offY, tiles, tp };
  }
  return best;
}

/* Try to put a small piece into empty space on a tiled page: outside the tiled
 * piece, clear of the overlap strips, and away from anything already placed. */
function placeOnTile(pg, it, g) {
  const { cw, ch, ov, sx, sy } = g;
  const ox = pg.tile.c * sx, oy = pg.tile.r * sy;
  const pad = GAP / 2;
  const x0 = ov + 2, y0 = ov + 2, x1 = cw - ov - 2, y1 = ch - ov - 2;
  const { w, h } = it.bb;
  if (w > x1 - x0 || h > y1 - y0) return false;
  // outline points of the tiled piece in this tile's coordinates
  const pts = pg.tp.map(([x, y]) => [x - ox, y - oy]).filter(([x, y]) => x > -pad && x < cw + pad && y > -pad && y < ch + pad);
  const poly = pg.tp.map(([x, y]) => [x - ox, y - oy]);
  const clear = (rx, ry) => {
    const ax = rx - pad, ay = ry - pad, bx = rx + w + pad, by = ry + h + pad;
    for (const [x, y] of pts) if (x > ax && x < bx && y > ay && y < by) return false;
    for (const q of [[rx, ry], [rx + w, ry], [rx, ry + h], [rx + w, ry + h], [rx + w / 2, ry + h / 2]]) if (inPoly(q, poly)) return false;
    for (const e of pg.extras) if (rx < e.x + e.bb.w + GAP && rx + w + GAP > e.x && ry < e.y + e.bb.h + GAP && ry + h + GAP > e.y) return false;
    return true;
  };
  const step = 4;
  for (let ry = y0; ry + h <= y1; ry += step) {
    for (let rx = x0; rx + w <= x1; rx += step) {
      if (clear(rx, ry)) { pg.extras.push({ ...it, x: rx, y: ry }); return true; }
    }
  }
  return false;
}

function layoutPages(pieces, s) {
  const g = pageGeom(s);
  const fit = [], tiled = [];
  for (const pc of pieces) {
    const b0 = bbox(pc.pts), b90 = bbox(rotPts(pc.pts, 90));
    const f0 = b0.w <= g.cw && b0.h <= g.ch, f90 = b90.w <= g.cw && b90.h <= g.ch;
    if (f0 || f90) {
      const a = f0 ? 0 : 90;
      fit.push({ pc, a, bb: a ? b90 : b0 });
    } else {
      tiled.push(pc);
    }
  }
  const pages = [];
  for (const pc of tiled) {
    const t = bestTiling(pc, g);
    t.tiles.forEach((tile, i) => pages.push({ kind: 'tile', pc, ...t, tile, idx: i + 1, count: t.tiles.length }));
  }
  // first, drop small pieces into empty space on tiled pages
  fit.sort((a, b) => b.bb.h * b.bb.w - a.bb.h * a.bb.w);
  const tilePages = pages.filter(pg => pg.kind === 'tile');
  for (const pg of tilePages) pg.extras = [];
  const rest = [];
  for (const it of fit) {
    if (!tilePages.some(pg => placeOnTile(pg, it, g))) rest.push(it);
  }
  fit.length = 0;
  fit.push(...rest);

  // then first-fit shelf packing across new pages (pieces sorted tallest first)
  fit.sort((a, b) => b.bb.h - a.bb.h || b.bb.w - a.bb.w);
  const packs = [];
  const place = (pk, it) => {
    const { w, h } = it.bb;
    for (const sh of pk.shelves) {
      if (sh.x + w <= g.cw + 1e-6 && h <= sh.h + 1e-6) { pk.items.push({ ...it, x: sh.x, y: sh.y }); sh.x += w + GAP; return true; }
    }
    if (pk.y + h <= g.ch + 1e-6) {
      pk.shelves.push({ y: pk.y, h, x: w + GAP });
      pk.items.push({ ...it, x: 0, y: pk.y });
      pk.y += h + GAP;
      return true;
    }
    return false;
  };
  for (const it of fit) {
    if (packs.some(pk => place(pk, it))) continue;
    const pk = { kind: 'pack', items: [], shelves: [], y: 0 };
    packs.push(pk);
    place(pk, it);
  }
  pages.push(...packs);
  return { g, pages };
}

/* ---------- SVG rendering ---------- */
const FONT = 'Helvetica, Arial, sans-serif';

function pieceSVG(pc, id, skipLabel) {
  if (pc.raw) return pc.raw;
  let o = '';
  for (const d of pc.seam) o += `<path d="${d}" fill="url(#${id}h)" stroke="none"/>`;
  for (const d of pc.dashed) o += `<path d="${d}" fill="none" stroke="#000" stroke-width="0.3" stroke-dasharray="2 1.5"/>`;
  for (const d of pc.ticks) o += `<path d="${d}" fill="none" stroke="#000" stroke-width="0.4"/>`;
  o += `<path d="${pc.outline}" fill="none" stroke="#000" stroke-width="0.5" stroke-linejoin="round" fill-rule="evenodd"/>`;
  for (const t of pc.texts) {
    if (skipLabel && t.lbl) continue;
    if (t.poly) {
      const pid = `${id}a${pc.uid}_${pc.texts.indexOf(t)}`;
      o += `<path id="${pid}" d="M${t.poly.map(pt).join('L')}" fill="none"/>`;
      o += `<text font-size="${n3(t.size)}"${t.bold ? ' font-weight="700"' : ''} fill="#000"><textPath href="#${pid}" startOffset="${n3(t.offset * 100)}%" text-anchor="${t.anchor || 'middle'}">${esc(t.t)}</textPath></text>`;
      continue;
    }
    if (t.arc) {
      const { r, a0, a1, cx = 0, cy = 0 } = t.arc;
      const pid = `${id}a${pc.uid}_${pc.texts.indexOf(t)}`;
      const P = a => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const sweep = a1 > a0 ? 1 : 0, large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
      o += `<path id="${pid}" d="M${pt(P(a0))}A${n3(r)} ${n3(r)} 0 ${large} ${sweep} ${pt(P(a1))}" fill="none"/>`;
      o += `<text font-size="${n3(t.size)}"${t.bold ? ' font-weight="700"' : ''} fill="#000"><textPath href="#${pid}" startOffset="${n3(t.offset * 100)}%" text-anchor="${t.anchor || 'middle'}">${esc(t.t)}</textPath></text>`;
      continue;
    }
    o += `<text x="${n3(t.x)}" y="${n3(t.y)}" font-size="${n3(t.size)}" text-anchor="${t.anchor || 'middle'}"${t.bold ? ' font-weight="700"' : ''}${t.rot ? ` transform="rotate(${n3(t.rot)} ${n3(t.x)} ${n3(t.y)})"` : ''} fill="#000">${esc(t.t)}</text>`;
  }
  return o;
}

function crosshair(x, y) {
  return `<g stroke="#000" stroke-width="0.25" fill="none"><circle cx="${n3(x)}" cy="${n3(y)}" r="2.2"/><path d="M${n3(x - 4)} ${n3(y)}H${n3(x + 4)}M${n3(x)} ${n3(y - 4)}V${n3(y + 4)}"/></g>`;
}

/* Label for a tiled piece, placed inside this tile away from the overlap strips. */
function tileLabel(pg, g) {
  const { c, r } = pg.tile, { cw, ch, ov, sx, sy } = g;
  const x0 = c * sx + ov + 4, y0 = r * sy + ov + 4, x1 = c * sx + cw - ov - 4, y1 = r * sy + ch - ov - 4;
  // grid-search the point inside the piece that is farthest from its outline
  let best = null;
  const near = pg.tp.filter(([x, y]) => x > x0 - 80 && x < x1 + 80 && y > y0 - 80 && y < y1 + 80);
  for (let i = 0; i <= 14; i++) for (let j = 0; j <= 18; j++) {
    const p = [x0 + (x1 - x0) * i / 14, y0 + (y1 - y0) * j / 18];
    if (!inPoly(p, pg.tp)) continue;
    let d = Infinity;
    for (const q of near) { const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (dd < d) d = dd; }
    d = Math.min(Math.sqrt(d), p[0] - x0 + 4, x1 + 4 - p[0], p[1] - y0 + 4, y1 + 4 - p[1]);
    if (!best || d > best.d) best = { d, p };
  }
  if (!best || best.d < 12) return '';
  const [cx, cy] = best.p;
  const lines = [...(pg.pc.labelLines || [pg.pc.name]), `sheet ${colName(c)}${r + 1}`];
  const sizes = lines.map((_, i) => (i === 0 ? 4.4 : 3.1));
  const total = sizes.reduce((a, b) => a + b * 1.4, 0);
  let y = cy - total / 2 - r * sy;
  const x = cx - c * sx;
  return lines.map((t, i) => {
    y += sizes[i] * 1.4;
    return `<text x="${n3(x)}" y="${n3(y - sizes[i] * 0.35)}" font-size="${sizes[i]}" text-anchor="middle"${i === 0 ? ' font-weight="700"' : ''} fill="#000">${esc(t)}</text>`;
  }).join('');
}

const colName = c => String.fromCharCode(65 + (c % 26)) + (c >= 26 ? Math.floor(c / 26) : '');

function pageSVG(pg, i, N, s, g) {
  const { W, H, m, cw, ch, ov, sx, sy } = g;
  const id = 'p' + i;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${n3(W)}mm" height="${n3(H)}mm" viewBox="0 0 ${n3(W)} ${n3(H)}" font-family="${FONT}">`;
  o += `<defs><pattern id="${id}h" width="1.8" height="1.8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1.8" stroke="#000" stroke-width="0.22" stroke-opacity="0.55"/></pattern>`;
  o += `<clipPath id="${id}c"><rect x="0" y="0" width="${n3(cw)}" height="${n3(ch)}"/></clipPath></defs>`;
  o += `<rect width="${n3(W)}" height="${n3(H)}" fill="#fff"/>`;

  // header: one line with the pot name, page number, slab notes and a 2 in scale bar
  const k = 1 / (1 - clamp(s.shrink, 0, 60) / 100);
  const name = String(s.name || 'Untitled pot').slice(0, 48);
  const by = m + 3.6;
  o += `<text x="${n3(m)}" y="${n3(by)}" fill="#000"><tspan font-size="3.2" font-weight="700">${esc(name)}</tspan><tspan font-size="2.4" fill="#444" dx="3">page ${i + 1} of ${N}  ·  ${esc(fmt(s.thick, s.units))} slab  ·  ${s.shrink}% shrinkage, templates ×${k.toFixed(3)}</tspan></text>`;
  const bx = W - m - 50.8;
  for (let q = 0; q < 8; q++) o += `<rect x="${n3(bx + q * 6.35)}" y="${n3(by - 2.2)}" width="6.35" height="1.9" fill="${q % 2 ? '#fff' : '#000'}"/>`;
  o += `<rect x="${n3(bx)}" y="${n3(by - 2.2)}" width="50.8" height="1.9" fill="none" stroke="#000" stroke-width="0.15"/>`;
  o += `<text x="${n3(bx - 2)}" y="${n3(by)}" font-size="2.4" text-anchor="end" fill="#444">bar = 2 in at 100%</text>`;
  o += `<path d="M${n3(m)} ${n3(m + HDR - 1.2)}H${n3(W - m)}" stroke="#000" stroke-width="0.12" stroke-opacity="0.35"/>`;

  // content
  o += `<g transform="translate(${n3(m)} ${n3(m + HDR)})">`;
  if (pg.kind === 'pack') {
    for (const it of pg.items) {
      o += `<g transform="translate(${n3(it.x - it.bb.x)} ${n3(it.y - it.bb.y)}) rotate(${it.a})">${pieceSVG(it.pc, id)}</g>`;
    }
  } else {
    const { c, r } = pg.tile;
    // overlap strips (where a neighbouring page exists)
    const have = new Set(pg.tiles.map(t => t.c + ',' + t.r));
    const strip = (x, y, w, h) => `<rect x="${n3(x)}" y="${n3(y)}" width="${n3(w)}" height="${n3(h)}" fill="#000" fill-opacity="0.045"/>`;
    const dash = (x1, y1, x2, y2) => `<path d="M${n3(x1)} ${n3(y1)}L${n3(x2)} ${n3(y2)}" stroke="#000" stroke-width="0.25" stroke-dasharray="3 2" stroke-opacity="0.6"/>`;
    const lbl = (x, y, t, rotate) => `<text x="${n3(x)}" y="${n3(y)}" font-size="2.2" fill="#555" text-anchor="middle"${rotate ? ` transform="rotate(-90 ${n3(x)} ${n3(y)})"` : ''}>${esc(t)}</text>`;
    if (ov > 0) {
      if (have.has((c + 1) + ',' + r)) { o += strip(cw - ov, 0, ov, ch) + dash(cw - ov, 0, cw - ov, ch) + lbl(cw - ov / 2 + 0.8, ch / 2, `overlaps ${colName(c + 1)}${r + 1}`, true); }
      if (have.has((c - 1) + ',' + r)) { o += strip(0, 0, ov, ch) + dash(ov, 0, ov, ch) + lbl(ov / 2 + 0.8, ch / 2, `overlaps ${colName(c - 1)}${r + 1}`, true); }
      if (have.has(c + ',' + (r + 1))) { o += strip(0, ch - ov, cw, ov) + dash(0, ch - ov, cw, ch - ov) + lbl(cw / 2, ch - ov / 2 + 0.8, `overlaps ${colName(c)}${r + 2}`); }
      if (have.has(c + ',' + (r - 1))) { o += strip(0, 0, cw, ov) + dash(0, ov, cw, ov) + lbl(cw / 2, ov / 2 + 0.8, `overlaps ${colName(c)}${r}`); }
    }
    o += `<rect x="0" y="0" width="${n3(cw)}" height="${n3(ch)}" fill="none" stroke="#000" stroke-width="0.15" stroke-opacity="0.35" stroke-dasharray="1 1.5"/>`;
    o += `<g clip-path="url(#${id}c)"><g transform="translate(${n3(-c * sx)} ${n3(-r * sy)})">`;
    o += `<g transform="translate(${n3(pg.offX - pg.bb.x)} ${n3(pg.offY - pg.bb.y)}) rotate(${pg.a})">${pieceSVG(pg.pc, id, true)}</g>`;
    if (ov > 0) {
      for (let cc = 0; cc < pg.cols - 1; cc++) for (let rr = 0; rr < pg.rows; rr++) {
        const xc = (cc + 1) * sx + ov / 2;
        o += crosshair(xc, rr * sy + ch * 0.3) + crosshair(xc, rr * sy + ch * 0.7);
      }
      for (let rr = 0; rr < pg.rows - 1; rr++) for (let cc = 0; cc < pg.cols; cc++) {
        const yc = (rr + 1) * sy + ov / 2;
        o += crosshair(cc * sx + cw * 0.3, yc) + crosshair(cc * sx + cw * 0.7, yc);
      }
    }
    o += `</g></g>`;
    o += tileLabel(pg, g);
    for (const it of pg.extras || []) {
      o += `<g transform="translate(${n3(it.x - it.bb.x)} ${n3(it.y - it.bb.y)}) rotate(${it.a})">${pieceSVG(it.pc, id)}</g>`;
    }
  }
  o += `</g>`;

  o += `</svg>`;
  return o;
}

export { MM_PER_IN, TAU, PAPERS, clamp, n3, fmt, fmtU, bbox, frustum, newPiece, labelBlock, labelArc, labelStrip, labelCircleLine, rawPiece, rectPiece, circlePiece, polygonPiece, sectorPiece, polyWall, pageGeom, layoutPages, pageSVG, colName, FONT };
