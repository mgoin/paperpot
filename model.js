/* PaperPot: the pot model.
 *
 * A pot is a set of parts joined edge to edge. Every part has a top and a bottom
 * edge. A join always connects the top edge of one part to the bottom edge of
 * another, so a connected group of parts forms a vertical stack.
 *
 * Part kinds
 *   round  wall section, round in plan: dTop, dBot (diameters), h
 *   facet  wall section with n flat sides: n, wTop, wBot (width across flats), h
 *   base   floor slab under a wall. Its size follows the wall it is joined to.
 *   foot   foot ring under a base: dTop (where it meets the base), dBot, h
 *   lid    lid slab on a wall's top edge: overhang, flange, fw (flange width)
 *
 * All stored sizes are finished (fired) millimetres, measured outside unless
 * state.dimMode is 'inside'. Templates are scaled up for shrinkage. */

import {
  TAU, clamp, fmtU, setUnits, bbox, frustum, labelBlock, labelArc, labelStrip, labelCircleLine, rectPiece, circlePiece,
  polygonPiece, sectorPiece, polyWall,
} from './templates.js';

export const WALLS = new Set(['round', 'facet']);
export const isWall = p => WALLS.has(p.kind);
const other = side => (side === 'top' ? 'bottom' : 'top');

export const SETTINGS_DEFAULTS = {
  units: 'mm', shrink: 12, thick: 6, dimMode: 'outside', seam: 'overlap', seamAllow: 12,
  baseFit: 'on', paper: 'letter', orient: 'portrait', margin: 6.35, overlap: 10,
  name: 'Untitled pot', printViews: false,
};

/* Page margin presets (mm). Laser printers can usually print to about 4.2 mm from
 * every edge; many inkjets need more at the bottom; 1/4 in suits nearly all. */
export const MARGIN_PRESETS = [
  ['safe', 'Safe, any printer (10 mm)', 10],
  ['standard', 'Standard (1/4 in, 6.4 mm)', 6.35],
  ['minimal', 'Minimal, most laser printers (4.5 mm)', 4.5],
];

/* ---------- presets ---------- */

export const PRESETS = {
  tumbler: {
    label: 'Tumbler',
    parts: [{ kind: 'round', dTop: 85, dBot: 65, h: 120 }, { kind: 'base' }],
    joins: [[0, 'bottom', 1, 'top']],
  },
  mug: {
    label: 'Mug',
    parts: [{ kind: 'round', dTop: 85, dBot: 85, h: 95 }, { kind: 'base' }],
    joins: [[0, 'bottom', 1, 'top']],
  },
  vase: {
    label: 'Belly vase',
    parts: [
      { kind: 'foot', dTop: 60, dBot: 66, h: 10 },
      { kind: 'base' },
      { kind: 'round', dTop: 130, dBot: 80, h: 70 },
      { kind: 'round', dTop: 60, dBot: 130, h: 70 },
      { kind: 'round', dTop: 70, dBot: 60, h: 35 },
    ],
    joins: [[1, 'bottom', 0, 'top'], [2, 'bottom', 1, 'top'], [3, 'bottom', 2, 'top'], [4, 'bottom', 3, 'top']],
  },
  jar: {
    label: 'Lidded jar',
    parts: [{ kind: 'round', dTop: 90, dBot: 90, h: 100 }, { kind: 'base' }, { kind: 'lid', overhang: 3, flange: true, fw: 8 }],
    joins: [[0, 'bottom', 1, 'top'], [0, 'top', 2, 'bottom']],
  },
  planter: {
    label: 'Hex planter',
    parts: [{ kind: 'facet', n: 6, wTop: 110, wBot: 80, h: 100, layout: 'net' }, { kind: 'base' }],
    joins: [[0, 'bottom', 1, 'top']],
  },
  box: {
    label: 'Square box',
    parts: [{ kind: 'facet', n: 4, wTop: 100, wBot: 100, h: 60, layout: 'single' }, { kind: 'base' }, { kind: 'lid', overhang: 0, flange: false, fw: 8 }],
    joins: [[0, 'bottom', 1, 'top'], [0, 'top', 2, 'bottom']],
  },
};

export const PART_DEFAULTS = {
  round: { dTop: 80, dBot: 80, h: 80 },
  facet: { n: 6, wTop: 80, wBot: 80, h: 80, layout: 'net' },
  base: {},
  foot: { dTop: 60, dBot: 64, h: 10 },
  lid: { overhang: 3, flange: true, fw: 8 },
};

export function newState(presetKey = 'tumbler', settings = {}) {
  const s = { ...SETTINGS_DEFAULTS, ...settings, parts: [], joins: [], nextId: 1 };
  const pr = PRESETS[presetKey] || PRESETS.tumbler;
  const ids = pr.parts.map(p => addPart(s, p.kind, p).id);
  for (const [a, sa, b, sb] of pr.joins) s.joins.push([{ id: ids[a], side: sa }, { id: ids[b], side: sb }]);
  return s;
}

export function addPart(s, kind, props = {}) {
  const p = { id: 'p' + s.nextId++, kind, ...PART_DEFAULTS[kind], ...props };
  delete p.label;
  s.parts.push(p);
  return p;
}

export const getPart = (s, id) => s.parts.find(p => p.id === id);

/* ---------- names ---------- */

export function partNames(s) {
  const names = {};
  let w = 0;
  const count = {};
  for (const p of s.parts) count[p.kind] = (count[p.kind] || 0) + 1;
  const seen = {};
  for (const p of s.parts) {
    if (isWall(p)) { names[p.id] = 'Wall ' + String.fromCharCode(65 + (w++ % 26)); continue; }
    seen[p.kind] = (seen[p.kind] || 0) + 1;
    const base = p.kind[0].toUpperCase() + p.kind.slice(1);
    names[p.id] = count[p.kind] > 1 ? `${base} ${seen[p.kind]}` : base;
  }
  return names;
}

export function describePart(p) {
  if (p.kind === 'round') {
    if (Math.abs(p.dTop - p.dBot) < 0.01) return 'cylinder';
    return p.dTop > p.dBot ? 'taper out' : 'taper in';
  }
  if (p.kind === 'facet') return `${p.n} sides` + (Math.abs(p.wTop - p.wBot) < 0.01 ? '' : p.wTop > p.wBot ? ', taper out' : ', taper in');
  return '';
}

/* ---------- edges and joins ---------- */

/* Which edges a part has that can take part in a join. */
export function edgesOf(p) {
  if (p.kind === 'lid') return ['bottom'];
  return ['top', 'bottom'];
}

export function joinAt(s, id, side) {
  return s.joins.find(([a, b]) => (a.id === id && a.side === side) || (b.id === id && b.side === side)) || null;
}

export function partnerOf(s, id, side) {
  const j = joinAt(s, id, side);
  if (!j) return null;
  return j[0].id === id && j[0].side === side ? j[1] : j[0];
}

/* Shape family of an edge, for compatibility and for the base/lid outline. */
function edgeShape(s, p, side) {
  if (p.kind === 'round' || p.kind === 'foot') return { round: true };
  if (p.kind === 'facet') return { n: p.n };
  if (p.kind === 'base' || p.kind === 'lid') {
    const w = supportWall(s, p);
    if (!w) return { any: true };
    return w.kind === 'facet' ? { n: w.n } : { round: true };
  }
  return { any: true };
}

/* The wall a base or lid is attached to. */
export function supportWall(s, p) {
  const side = p.kind === 'base' ? 'top' : 'bottom';
  const q = partnerOf(s, p.id, side);
  return q ? getPart(s, q.id) : null;
}

export function componentOf(s, id) {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const [a, b] of s.joins) {
      const nb = a.id === cur ? b.id : b.id === cur ? a.id : null;
      if (nb && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return seen;
}

/* Check whether edge A can be joined to edge B. Returns an error string or null. */
export function canJoin(s, A, B) {
  if (A.id === B.id) return 'Pick an edge on a different part.';
  if (A.side === B.side) return 'Join a top edge to a bottom edge.';
  if (joinAt(s, A.id, A.side) || joinAt(s, B.id, B.side)) return 'One of those edges is already joined. Detach it first.';
  if (componentOf(s, A.id).has(B.id)) return 'Those parts are already connected.';
  const pa = getPart(s, A.id), pb = getPart(s, B.id);
  const [lo, hi] = A.side === 'top' ? [pa, pb] : [pb, pa]; // lo's top meets hi's bottom
  const ok =
    (isWall(lo) && isWall(hi)) ||
    (isWall(lo) && hi.kind === 'lid') ||
    (lo.kind === 'base' && isWall(hi)) ||
    (lo.kind === 'foot' && hi.kind === 'base');
  if (!ok) {
    if (hi.kind === 'base' || lo.kind === 'base') return 'A base goes under the bottom edge of a wall, and a foot goes under a base.';
    if (hi.kind === 'lid' || lo.kind === 'lid') return 'A lid goes on the top edge of a wall.';
    if (lo.kind === 'foot' || hi.kind === 'foot') return 'A foot goes under a base.';
    return 'Those parts cannot be joined.';
  }
  if (isWall(lo) && isWall(hi)) {
    if (lo.kind !== hi.kind) return 'Round and faceted edges cannot be joined.';
    if (lo.kind === 'facet' && lo.n !== hi.n) return `Faceted edges need the same number of sides (${lo.n} vs ${hi.n}).`;
  }
  if (isWall(hi) && lo.kind === 'base' && joinAt(s, lo.id, 'top')) return 'That base already has a wall.';
  return null;
}

/* Join edge A (the part being attached) to edge B (the target). Part A takes the
 * size of the target edge. */
export function join(s, A, B) {
  const err = canJoin(s, A, B);
  if (err) return err;
  s.joins.push([{ ...A }, { ...B }]);
  const pa = getPart(s, A.id), pb = getPart(s, B.id);
  if (isWall(pa) && isWall(pb)) {
    const key = pa.kind === 'round' ? 'd' : 'w';
    const sideKey = side => key + (side === 'top' ? 'Top' : 'Bot');
    pa[sideKey(A.side)] = pb[sideKey(B.side)];
  }
  return null;
}

export function detach(s, id, side) {
  s.joins = s.joins.filter(([a, b]) => !((a.id === id && a.side === side) || (b.id === id && b.side === side)));
}

export function removePart(s, id) {
  s.joins = s.joins.filter(([a, b]) => a.id !== id && b.id !== id);
  s.parts = s.parts.filter(p => p.id !== id);
}

/* Shared edge sizes: after editing one wall edge, copy the size to the wall it
 * is joined to. */
export function syncEdge(s, id, side) {
  const p = getPart(s, id);
  if (!isWall(p)) return;
  const q = partnerOf(s, id, side);
  if (!q) return;
  const pq = getPart(s, q.id);
  if (!isWall(pq) || pq.kind !== p.kind) return;
  const key = p.kind === 'round' ? 'd' : 'w';
  pq[key + (q.side === 'top' ? 'Top' : 'Bot')] = p[key + (side === 'top' ? 'Top' : 'Bot')];
}

export function syncAll(s, id) {
  syncEdge(s, id, 'top');
  syncEdge(s, id, 'bottom');
}

/* Add a new part on a free edge. */
export function addAtEdge(s, id, side, kind, variant) {
  const p = getPart(s, id);
  let props = {};
  if (kind === 'round' || kind === 'facet') {
    const key = kind === 'round' ? 'd' : 'w';
    let d = 80;
    if (isWall(p)) d = p[key + (side === 'top' ? 'Top' : 'Bot')];
    else if (p.kind === 'base' || p.kind === 'lid') {
      const w = supportWall(s, p);
      if (w) d = w[(w.kind === 'round' ? 'd' : 'w') + 'Bot'];
    }
    // "out" = wider at the top, "in" = narrower at the top, whichever end is joined
    const f = variant === 'out' ? 1.25 : variant === 'in' ? 0.8 : 1;
    props = side === 'top'
      ? { [key + 'Bot']: d, [key + 'Top']: Math.round(d * f), h: 60 }
      : { [key + 'Top']: d, [key + 'Bot']: Math.round(d / f), h: 60 };
    if (kind === 'facet') { props.n = p.kind === 'facet' ? p.n : 6; props.layout = p.layout || 'net'; }
  }
  if (kind === 'foot') {
    const w = supportWall(s, p);
    const d = w ? (w.kind === 'round' ? w.dBot : w.wBot) : 80;
    props = { dTop: Math.round(d * 0.75), dBot: Math.round(d * 0.8), h: 10 };
  }
  const np = addPart(s, kind, props);
  const npSide = side === 'top' ? 'bottom' : 'top';
  const err = join(s, { id: np.id, side: npSide }, { id, side });
  if (err) { removePart(s, np.id); return { err }; }
  return { part: np };
}

/* ---------- vertical layout (fired mm, outer sizes) ---------- */

export function partHeight(s, p) {
  if (isWall(p) || p.kind === 'foot') return p.h;
  if (p.kind === 'base') return s.baseFit === 'on' ? s.thick : 0;
  if (p.kind === 'lid') return s.thick;
  return 0;
}

/* Outer size of a wall edge in fired mm (converts inside sizes). */
export function outerSize(s, v) { return s.dimMode === 'inside' ? v + 2 * s.thick : v; }

/* Returns { pos: {id: {x, z}}, groups: [[ids]], bounds } with z = bottom of part. */
export function layout(s) {
  const pos = {};
  const groups = [];
  const done = new Set();
  for (const p of s.parts) {
    if (done.has(p.id)) continue;
    const comp = componentOf(s, p.id);
    const z = { [p.id]: 0 };
    const queue = [p.id];
    while (queue.length) {
      const cur = queue.shift();
      const pc = getPart(s, cur);
      for (const [a, b] of s.joins) {
        let me, nb;
        if (a.id === cur) { me = a; nb = b; } else if (b.id === cur) { me = b; nb = a; } else continue;
        if (nb.id in z) continue;
        const pn = getPart(s, nb.id);
        z[nb.id] = me.side === 'top' ? z[cur] + partHeight(s, pc) : z[cur] - partHeight(s, pn);
        queue.push(nb.id);
      }
    }
    const minZ = Math.min(...Object.values(z));
    for (const id of Object.keys(z)) { z[id] -= minZ; done.add(id); }
    groups.push({ ids: [...comp], z });
  }
  // place groups side by side along x
  let x = 0;
  const out = [];
  for (const g of groups) {
    const r = Math.max(10, ...g.ids.map(id => maxRadius(s, getPart(s, id))));
    x += r;
    for (const id of g.ids) pos[id] = { x, z: g.z[id] };
    out.push({ ids: g.ids, x, r, h: Math.max(...g.ids.map(id => g.z[id] + partHeight(s, getPart(s, id)))) });
    x += r + 30;
  }
  return { pos, groups: out };
}

export function maxRadius(s, p) {
  const o = v => outerSize(s, v);
  if (p.kind === 'round') return Math.max(o(p.dTop), o(p.dBot)) / 2;
  if (p.kind === 'facet') return Math.max(o(p.wTop), o(p.wBot)) / 2 / Math.cos(Math.PI / p.n);
  if (p.kind === 'foot') return Math.max(p.dTop, p.dBot) / 2;
  const w = supportWall(s, p);
  if (w) {
    const r = maxRadius(s, w);
    return p.kind === 'lid' ? r + (p.overhang || 0) : r;
  }
  return 40;
}

/* Plan shape of the edge a base or lid sits against (fired, outer). */
export function bearing(s, p) {
  const w = supportWall(s, p);
  if (!w) return null;
  const side = p.kind === 'base' ? 'Bot' : 'Top';
  if (w.kind === 'round') return { round: true, D: outerSize(s, w['d' + side]) };
  return { n: w.n, W: outerSize(s, w['w' + side]) };
}

/* ---------- validation ---------- */

export function problems(s) {
  const names = partNames(s);
  const out = [];
  const t = s.thick;
  for (const p of s.parts) {
    const nm = names[p.id];
    if (p.kind === 'round') {
      if (outerSize(s, Math.min(p.dTop, p.dBot)) <= 2 * t + 1) out.push({ id: p.id, msg: `${nm}: a diameter is too small for a ${fmtU(t)} slab.` });
      if (p.h <= 0) out.push({ id: p.id, msg: `${nm}: height must be more than 0.` });
    }
    if (p.kind === 'facet') {
      if (outerSize(s, Math.min(p.wTop, p.wBot)) <= 2 * t + 1) out.push({ id: p.id, msg: `${nm}: a width is too small for a ${fmtU(t)} slab.` });
      if (p.h <= 0) out.push({ id: p.id, msg: `${nm}: height must be more than 0.` });
    }
    if (p.kind === 'base' && !supportWall(s, p)) out.push({ id: p.id, msg: `${nm} is not joined to a wall. Select a wall's bottom edge and attach it.` });
    if (p.kind === 'lid' && !supportWall(s, p)) out.push({ id: p.id, msg: `${nm} is not joined to a wall. Select a wall's top edge and attach it.` });
    if (p.kind === 'foot') {
      const q = partnerOf(s, p.id, 'top');
      const base = q && getPart(s, q.id);
      const b = base && bearing(s, base);
      if (!base) out.push({ id: p.id, msg: `${nm} is not joined to a base.` });
      else if (b) {
        const lim = b.round ? b.D : b.W;
        if (p.dTop > lim) out.push({ id: p.id, msg: `${nm} is wider than the base it sits under.` });
      }
      if (p.dTop <= 2 * t + 1 || p.dBot <= 2 * t + 1) out.push({ id: p.id, msg: `${nm}: diameter is too small for the slab.` });
    }
  }
  return out;
}

/* ---------- templates ---------- */

export function buildPieces(s) {
  setUnits(s.units);
  const k = 1 / (1 - clamp(s.shrink, 0, 60) / 100);
  const t = s.thick;
  const names = partNames(s);
  const out = { pieces: [], notes: [], errors: problems(s).map(e => e.msg), k };
  const allowFor = () => (s.seam === 'overlap' ? s.seamAllow : s.seam === 'bevel' ? t : 0);
  const on = s.baseFit === 'on';

  const joinText = (p, side) => {
    const q = partnerOf(s, p.id, side);
    return q ? `joins ${names[q.id]}` : '';
  };

  for (const p of s.parts) {
    const nm = names[p.id];
    try {
      if (p.kind === 'round' || p.kind === 'foot') {
        const isFoot = p.kind === 'foot';
        const Dt = (isFoot ? p.dTop : outerSize(s, p.dTop)) * k;
        const Db = (isFoot ? p.dBot : outerSize(s, p.dBot)) * k;
        const H = p.h * k;
        const Rt = (Dt - t) / 2, Rb = (Db - t) / 2;
        if (Rt <= 0 || Rb <= 0 || H <= 0) continue;
        const fr = frustum(Rt, Rb, H);
        const allow = allowFor();
        const title = isFoot ? `${nm} ring` : `${nm}`;
        const note = (label, len, side) => [label, len, joinText(p, side)].filter(Boolean).join(' · ');
        let pc;
        if (fr.flat) {
          const C = fr.C;
          pc = rectPiece(title, C, fr.s, 1, { allow: s.seam === 'overlap' ? allow : 0, bevel: s.seam === 'bevel' ? t : 0, ticks: [0, 0.25, 0.5, 0.75] });
          labelStrip(pc, C, fr.s, title, note('TOP', fmtU(C), 'top'), note('BOTTOM', '', 'bottom'));
          pc.size = `${fmtU(C + (s.seam === 'overlap' ? allow : 0))} × ${fmtU(fr.s)}`;
        } else {
          pc = sectorPiece(title, fr, { allow: s.seam === 'overlap' ? allow : 0, bevel: s.seam === 'bevel' ? t : 0, topIsOuter: fr.topIsOuter });
          labelArc(pc, title, note('TOP', fmtU(TAU * Rt), 'top'), note('BOTTOM', fmtU(TAU * Rb), 'bottom'));
          const bb = bbox(pc.pts);
          pc.size = `${fmtU(bb.w)} × ${fmtU(bb.h)}, arc ${(fr.theta * 180 / Math.PI).toFixed(1)}°`;
          out.notes.push(`${title}: arcs of radius ${fmtU(fr.L)} and ${fmtU(fr.l)} from one centre, ${(fr.theta * 180 / Math.PI).toFixed(1)}° apart.`);
        }
        pc.partId = p.id;
        out.pieces.push(pc);
      } else if (p.kind === 'facet') {
        const n = clamp(Math.round(p.n), 3, 24);
        const Ft = outerSize(s, p.wTop) * k, Fb = outerSize(s, p.wBot) * k, H = p.h * k;
        const tan = Math.tan(Math.PI / n);
        const aT = (Ft - t) / 2, aB = (Fb - t) / 2;
        if (aT <= 0 || aB <= 0 || H <= 0) continue;
        const wt = 2 * aT * tan, wb = 2 * aB * tan;
        const sh = Math.hypot(H, aT - aB);
        const allow = p.layout === 'net' && s.seam === 'overlap' ? s.seamAllow : 0;
        const fnote = (label, w, side) => [label, `${fmtU(w)} per side`, joinText(p, side)].filter(Boolean).join(' · ');
        const pc = polyWall(p.layout === 'net' ? nm : `${nm} panel`, n, wt, wb, sh, p.layout, allow, { top: fnote('TOP', wt, 'top'), bottom: fnote('BOTTOM', wb, 'bottom') });
        const bb = bbox(pc.pts);
        pc.size = p.layout === 'net' ? `${fmtU(bb.w)} × ${fmtU(bb.h)}` : `${fmtU(Math.max(wt, wb))} × ${fmtU(sh)}`;
        pc.partId = p.id;
        out.pieces.push(pc);
        out.notes.push(`${nm}: corners meet at ${(180 - 360 / n).toFixed(1)}°. Bevel each side edge ${(180 / n).toFixed(1)}° off square, or score and fold.`);
      } else if (p.kind === 'base') {
        const b = bearing(s, p);
        if (!b) continue;
        const footQ = partnerOf(s, p.id, 'bottom');
        const foot = footQ && getPart(s, footQ.id);
        let pc;
        if (b.round) {
          const Do = b.D * k;
          const D = on ? Do : Do - 2 * t;
          const guides = [];
          if (on) guides.push(Do - 2 * t);
          if (foot) guides.push(foot.dTop * k);
          pc = circlePiece(nm, D, 1, { dashed: guides[0] || 0 });
          if (guides[1]) pc.dashed.push(circleOf(D / 2, guides[1] / 2));
          labelBlock(pc, D / 2, D / 2 - D * 0.12, [nm, `⌀ ${fmtU(D)}`], D * 0.6);
          if (on) labelCircleLine(pc, D / 2, D / 2, (Do - 2 * t) / 2, 'inside of wall', 'top');
          if (foot) labelCircleLine(pc, D / 2, D / 2, foot.dTop * k / 2, 'foot ring', 'bottom');
          pc.size = `⌀ ${fmtU(D)}`;
        } else {
          const Fo = b.W * k;
          const F = on ? Fo : Fo - 2 * t;
          pc = polygonPiece(nm, b.n, F, 1, { dashedFlats: on ? Fo - 2 * t : 0 });
          const bbB = bbox(pc.pts);
          if (foot) {
            const cx = bbB.x + bbB.w / 2, cy = bbB.y + bbB.h / 2;
            pc.dashed.push(circleAt(cx, cy, foot.dTop * k / 2));
            labelCircleLine(pc, cx, cy, foot.dTop * k / 2, 'foot ring', 'bottom');
          }
          if (on) labelCircleLine(pc, bbB.x + bbB.w / 2, bbB.y + bbB.h / 2, (Fo - 2 * t) / 2, 'inside of wall', 'top');
          labelBlock(pc, bbB.x + bbB.w / 2, bbB.y + bbB.h / 2 - F * 0.12, [nm, `${fmtU(F)} across flats`], F * 0.6);
          pc.size = `${fmtU(F)} across flats`;
        }
        pc.partId = p.id;
        out.pieces.push(pc);
      } else if (p.kind === 'lid') {
        const b = bearing(s, p);
        if (!b) continue;
        const ov = (p.overhang || 0) * k;
        if (b.round) {
          const Do = b.D * k;
          const Dl = Do + 2 * ov;
          const ringOut = Do - 2 * t - 1.5, ringIn = ringOut - 2 * p.fw * k;
          const flange = p.flange && ringIn > 0;
          const pc = circlePiece(nm, Dl, 1, { dashed: flange ? ringOut : 0 });
          labelBlock(pc, Dl / 2, Dl / 2 - Dl * 0.12, [nm, `⌀ ${fmtU(Dl)}`], Dl * 0.6);
          if (flange) labelCircleLine(pc, Dl / 2, Dl / 2, ringOut / 2, 'flange ring', 'top');
          pc.size = `⌀ ${fmtU(Dl)}`;
          pc.partId = p.id;
          out.pieces.push(pc);
          if (flange) {
            const r = circlePiece(`${nm} flange`, ringOut, 1, { hole: ringIn });
            labelBlock(r, ringOut / 2, ringOut / 2, [`${nm} flange`, `⌀ ${fmtU(ringOut)} / ${fmtU(ringIn)}`], Math.min(p.fw * k * 2.5, ringIn * 0.6));
            r.texts.forEach(tx => { tx.y = tx.y - ringOut / 2 + p.fw * k / 2 + 1; });
            r.size = `⌀ ${fmtU(ringOut)} outside, ${fmtU(ringIn)} inside`;
            r.partId = p.id;
            out.pieces.push(r);
            out.notes.push(`${nm}: join the flange ring under the lid on the dashed circle. It keys into the opening.`);
          } else if (p.flange) {
            out.errors.push(`${nm}: the flange is too wide for the opening.`);
          }
        } else {
          const F = b.W * k + 2 * ov;
          const pc = polygonPiece(nm, b.n, F, 1, {});
          const bbB = bbox(pc.pts);
          labelBlock(pc, bbB.x + bbB.w / 2, bbB.y + bbB.h / 2, [nm, `${fmtU(F)} across flats`], F * 0.6);
          pc.size = `${fmtU(F)} across flats`;
          pc.partId = p.id;
          out.pieces.push(pc);
        }
      }
    } catch (e) {
      out.errors.push(`${nm}: could not build a template (${e.message}).`);
    }
  }
  if (s.seam === 'bevel') out.notes.push('Bevel: cut the hatched strips at 45° on opposite faces, then overlap them.');
  out.weight = out.pieces.reduce((a, p) => a + p.area * p.qty, 0) * t / 1000 * 1.8;
  return out;
}

function circleOf(c, r) { return circleAt(c, c, r); }
function circleAt(cx, cy, r) {
  const f = v => (Math.round(v * 1000) / 1000).toString();
  return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
}

/* ---------- persistence ---------- */

export function encode(s) {
  const o = { ...s };
  const json = JSON.stringify(o);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(str) {
  try {
    const b = str.replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(b))));
    if (!o || !Array.isArray(o.parts) || !Array.isArray(o.joins)) return null;
    const s = { ...SETTINGS_DEFAULTS, ...o };
    s.parts = o.parts.filter(p => p && PART_DEFAULTS[p.kind] && typeof p.id === 'string').map(p => ({ id: p.id, kind: p.kind, ...PART_DEFAULTS[p.kind], ...p }));
    const ids = new Set(s.parts.map(p => p.id));
    s.joins = o.joins.filter(j => Array.isArray(j) && j.length === 2 && ids.has(j[0]?.id) && ids.has(j[1]?.id));
    s.nextId = Math.max(o.nextId || 1, ...s.parts.map(p => parseInt(p.id.slice(1), 10) + 1 || 1));
    if (s.units !== 'mm' && s.units !== 'in') s.units = 'mm';
    return s;
  } catch (e) {
    return null;
  }
}
