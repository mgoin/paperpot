/* PaperPot: 3D preview (three.js, orthographic camera, render on demand). */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { layout, isWall, outerSize, bearing, partnerOf } from './model.js';

const PICK_PX = 9;

export function createView(container, { onHover, onPick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
  camera.position.set(1, 0.7, 1.3).multiplyScalar(500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.97;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8178, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  scene.add(key);
  scene.add(key.target);

  const root = new THREE.Group();
  scene.add(root);
  const overlay = new THREE.Group();
  scene.add(overlay);
  let grid = null;

  let colors = readColors();
  let model = null;          // { s, edges: [...], meshes: [...] }
  let sel = null, hover = null, pending = null;
  let halfH = 100;           // ortho half height before zoom
  let needs = false;

  function readColors() {
    const cs = getComputedStyle(container);
    const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
    return {
      bg: v('--view-bg', '#f2f0ec'), clay: v('--clay', '#d8cab7'), claySel: v('--clay-sel', '#e6b48c'),
      line: v('--view-line', '#4a423c'), accent: v('--accent', '#b5562a'), grid: v('--view-grid', '#dedad3'),
    };
  }

  function render() {
    needs = false;
    key.position.copy(camera.position).add(new THREE.Vector3(-200, 400, 100));
    key.target.position.copy(controls.target);
    renderer.render(scene, camera);
  }
  function requestRender() {
    if (needs) return;
    needs = true;
    requestAnimationFrame(render);
  }
  controls.addEventListener('change', () => { refreshOverlay(); requestRender(); });

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    const a = w / h;
    camera.left = -halfH * a; camera.right = halfH * a; camera.top = halfH; camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    refreshOverlay();
    requestRender();
  }
  new ResizeObserver(resize).observe(container);

  /* ---------- geometry helpers ---------- */

  // plan outline at radius r: round (segments) or polygon (n sides, flat facing +z)
  function ring(r, y, n) {
    const pts = [];
    const segs = n || 96;
    const phi0 = n ? Math.PI / n : 0;
    for (let i = 0; i < segs; i++) {
      const a = phi0 + (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.sin(a), y, r * Math.cos(a)));
    }
    return pts;
  }

  function lathe(p0, p1, n) {
    const g = new THREE.LatheGeometry([new THREE.Vector2(p0[0], p0[1]), new THREE.Vector2(p1[0], p1[1])], n || 96, n ? Math.PI / n : 0);
    return g;
  }

  // Closed solid from a profile of [r, y] points (r = lathe radius)
  function solid(profile, n, mat) {
    const g = new THREE.Group();
    for (let i = 0; i < profile.length; i++) {
      const a = profile[i], b = profile[(i + 1) % profile.length];
      if (a[0] === 0 && b[0] === 0) continue;
      g.add(new THREE.Mesh(lathe(a, b, n), mat));
    }
    return g;
  }

  function lineLoop(pts, mat) {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.LineLoop(g, mat);
  }

  /* ---------- build ---------- */

  function update(s, selection, pendingEdge) {
    sel = selection; pending = pendingEdge;
    root.clear();
    const L = layout(s);
    const t = s.thick;
    const edges = [];
    const meshes = [];
    const lineMat = new THREE.LineBasicMaterial({ color: colors.line });

    for (const p of s.parts) {
      const at = L.pos[p.id];
      if (!at) continue;
      const selected = sel && sel.type === 'part' && sel.id === p.id;
      const mat = new THREE.MeshStandardMaterial({
        color: selected ? colors.claySel : colors.clay, roughness: 0.92, metalness: 0,
        side: THREE.DoubleSide, flatShading: p.kind === 'facet' || (bearingN(s, p) > 0),
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const grp = new THREE.Group();
      grp.position.set(at.x, at.z, 0);
      const n = p.kind === 'facet' ? p.n : bearingN(s, p);
      const R = w => (n ? w / 2 / Math.cos(Math.PI / n) : w / 2);   // across-flats/diameter -> lathe radius
      const inR = w => (n ? (w / 2 - t) / Math.cos(Math.PI / n) : w / 2 - t);
      let edgeDefs = [];

      if (isWall(p) || p.kind === 'foot') {
        const top = p.kind === 'round' ? outerSize(s, p.dTop) : p.kind === 'facet' ? outerSize(s, p.wTop) : p.dTop;
        const bot = p.kind === 'round' ? outerSize(s, p.dBot) : p.kind === 'facet' ? outerSize(s, p.wBot) : p.dBot;
        const h = p.h;
        const prof = [[R(bot), 0], [R(top), h], [Math.max(0.5, inR(top)), h], [Math.max(0.5, inR(bot)), 0]];
        grp.add(solid(prof, n, mat));
        grp.add(lineLoop(ring(R(top), h, n), lineMat), lineLoop(ring(R(bot), 0, n), lineMat), lineLoop(ring(inR(top), h, n), lineMat));
        if (!partnerOf(s, p.id, 'bottom')) grp.add(lineLoop(ring(inR(bot), 0, n), lineMat));
        if (n) {
          const tp = ring(R(top), h, n), bp = ring(R(bot), 0, n);
          const segs = [];
          for (let i = 0; i < n; i++) segs.push(bp[i], tp[i]);
          grp.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), lineMat));
        }
        if (isWall(p)) edgeDefs = [['top', R(top), h], ['bottom', R(bot), 0]];
      } else if (p.kind === 'base') {
        const b = bearing(s, p);
        const w = b ? (b.round ? b.D : b.W) : 80;
        const width = s.baseFit === 'on' || !b ? w : w - 2 * t;
        const r = R(width);
        grp.add(solid([[0, 0], [r, 0], [r, t], [0, t]], n, mat));
        grp.add(lineLoop(ring(r, 0, n), lineMat), lineLoop(ring(r, t, n), lineMat));
        edgeDefs = [['bottom', r, 0]];
        if (!b) edgeDefs.push(['top', r, t]);
      } else if (p.kind === 'lid') {
        const b = bearing(s, p);
        const w = (b ? (b.round ? b.D : b.W) : 80) + 2 * (p.overhang || 0);
        const r = R(w);
        grp.add(solid([[0, 0], [r, 0], [r, t], [0, t]], n, mat));
        grp.add(lineLoop(ring(r, 0, n), lineMat), lineLoop(ring(r, t, n), lineMat));
        if (b && b.round && p.flange) {
          const ro = b.D / 2 - t - 0.75, ri = ro - p.fw;
          if (ri > 0) {
            grp.add(solid([[ri, -t], [ro, -t], [ro, 0], [ri, 0]], 0, mat));
            grp.add(lineLoop(ring(ro, -t, 0), lineMat), lineLoop(ring(ri, -t, 0), lineMat));
          }
        }
        if (!b) edgeDefs = [['bottom', r, 0]];
      }

      grp.traverse(o => { if (o.isMesh) { o.userData.partId = p.id; meshes.push(o); } });
      root.add(grp);
      for (const [side, r, y] of edgeDefs) {
        const pts = ring(r, y, n).map(v => v.add(grp.position));
        edges.push({ id: p.id, side, pts, n, r, y: y + at.z });
      }
    }

    // grid on the ground
    if (grid) { scene.remove(grid); grid.geometry.dispose(); }
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      const ext = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 60);
      const cell = s.units === 'in' ? 12.7 : 10;
      const size = Math.ceil((ext * 1.5) / cell / 2) * 2 * cell;
      grid = new THREE.GridHelper(size, size / cell, colors.grid, colors.grid);
      grid.position.set((box.min.x + box.max.x) / 2, box.min.y - 0.01, 0);
      scene.add(grid);
    }
    model = { s, edges, meshes, box };
    refreshOverlay();
    requestRender();
  }

  function bearingN(s, p) {
    if (p.kind !== 'base' && p.kind !== 'lid') return 0;
    const b = bearing(s, p);
    return b && b.n ? b.n : 0;
  }

  /* ---------- camera ---------- */

  function fit(keepDir = true) {
    if (!model || model.box.isEmpty()) return;
    const box = model.box;
    const c = box.getCenter(new THREE.Vector3());
    const dir = keepDir ? camera.position.clone().sub(controls.target).normalize() : new THREE.Vector3(1, 0.7, 1.3).normalize();
    controls.target.copy(c);
    camera.position.copy(c).add(dir.multiplyScalar(2000));
    camera.up.set(0, 1, 0);
    camera.lookAt(c);
    camera.updateMatrixWorld();
    // fit the projected box
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const inv = camera.matrixWorldInverse;
    let w = 0, h = 0;
    for (const v of corners) { const q = v.clone().applyMatrix4(inv).sub(c.clone().applyMatrix4(inv)); w = Math.max(w, Math.abs(q.x)); h = Math.max(h, Math.abs(q.y)); }
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    halfH = Math.max(h, w / aspect) * 1.18 + 2;
    camera.zoom = 1;
    resize();
    controls.update();
  }

  function setView(name) {
    const c = controls.target.clone();
    const dirs = { iso: [1, 0.7, 1.3], front: [0, 0, 1], side: [1, 0, 0], top: [0, 1, 0.0001], below: [0.0001, -1, 0.6] };
    const d = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
    camera.position.copy(c).add(d.multiplyScalar(2000));
    camera.lookAt(c);
    fit(true);
  }

  /* ---------- picking ---------- */

  const ray = new THREE.Raycaster();
  function screenOf(v) {
    const p = v.clone().project(camera);
    return [(p.x + 1) / 2 * container.clientWidth, (1 - p.y) / 2 * container.clientHeight, p.z];
  }
  function distSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
    return { d: Math.hypot(px - a[0] - u * dx, py - a[1] - u * dy), u };
  }

  function pick(clientX, clientY) {
    if (!model) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const ndc = new THREE.Vector2(x / rect.width * 2 - 1, -(y / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(model.meshes, false);
    const hit = hits[0];
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const depthOf = v => v.clone().sub(camera.position).dot(camDir);
    const hitDepth = hit ? depthOf(hit.point) : Infinity;
    const tol = Math.max(model.s.thick * 2.5, 4);

    let best = null;
    for (const e of model.edges) {
      const sp = e.pts.map(screenOf);
      for (let i = 0; i < sp.length; i++) {
        const a = sp[i], b = sp[(i + 1) % sp.length];
        const r = distSeg(x, y, a, b);
        if (r.d > PICK_PX || (best && r.d >= best.d)) continue;
        const world = e.pts[i].clone().lerp(e.pts[(i + 1) % sp.length], r.u);
        if (depthOf(world) > hitDepth + tol) continue; // hidden behind the pot
        best = { d: r.d, target: { type: 'edge', id: e.id, side: e.side } };
      }
    }
    if (best) return best.target;
    if (hit) return { type: 'part', id: hit.object.userData.partId };
    return null;
  }

  /* ---------- overlay: hovered, selected and pending edges ---------- */

  function worldPerPixel() {
    return (camera.top - camera.bottom) / camera.zoom / Math.max(1, container.clientHeight);
  }

  function tube(e, px, color) {
    const curve = new THREE.CatmullRomCurve3(e.pts, true, 'catmullrom', 0);
    const segs = e.n ? e.n * 8 : 96;
    const g = new THREE.TubeGeometry(curve, segs, px * worldPerPixel(), 6, true);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
  }

  function findEdge(t) {
    return t && t.type === 'edge' && model ? model.edges.find(e => e.id === t.id && e.side === t.side) : null;
  }

  function refreshOverlay() {
    overlay.children.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
    overlay.clear();
    if (!model) return;
    const add = (t, px, col) => { const e = findEdge(t); if (e) { const m = tube(e, px, col); m.renderOrder = 10; overlay.add(m); } };
    if (pending) add(pending, 2.6, colors.accent);
    if (sel && sel.type === 'edge') add(sel, 2.6, colors.accent);
    if (hover && hover.type === 'edge') add(hover, 1.8, colors.accent);
  }

  /* ---------- pointer ---------- */

  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (moved > 4) return;
    onPick(pick(e.clientX, e.clientY), e);
  });
  let hoverQueued = false, lastEv = null;
  renderer.domElement.addEventListener('pointermove', e => {
    lastEv = e;
    if (down || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const h = pick(lastEv.clientX, lastEv.clientY);
      const same = (h && hover && h.type === hover.type && h.id === hover.id && h.side === hover.side) || (!h && !hover);
      if (!same) { hover = h; refreshOverlay(); requestRender(); }
      onHover(h, lastEv);
    });
  });
  renderer.domElement.addEventListener('pointerleave', () => { hover = null; onHover(null); refreshOverlay(); requestRender(); });

  /* ---------- still images for printing ---------- */
  let snapRenderer = null;
  const SNAP_DIRS = { iso: [1, 0.7, 1.3], front: [0, 0, 1], top: [0, 1, 0.0001] };

  function snapshots(px = 520) {
    if (!model || model.box.isEmpty()) return [];
    if (!snapRenderer) {
      snapRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      snapRenderer.setPixelRatio(1);
    }
    snapRenderer.setSize(px, px, false);
    const box = model.box;
    const c = box.getCenter(new THREE.Vector3());
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const prevBg = scene.background;
    const gridVis = grid ? grid.visible : false;
    scene.background = new THREE.Color('#ffffff');
    if (grid) grid.visible = false;
    overlay.visible = false;
    const tinted = [];
    root.traverse(o => { if (o.isMesh) { tinted.push([o.material, o.material.color.getHex()]); o.material.color.set(colors.clay); } });
    const out = [];
    for (const [name, d] of Object.entries(SNAP_DIRS)) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
      cam.position.copy(c).add(new THREE.Vector3(...d).normalize().multiplyScalar(2000));
      cam.lookAt(c);
      cam.updateMatrixWorld();
      const inv = cam.matrixWorldInverse, c0 = c.clone().applyMatrix4(inv);
      let hw = 0;
      for (const v of corners) { const q = v.clone().applyMatrix4(inv).sub(c0); hw = Math.max(hw, Math.abs(q.x), Math.abs(q.y)); }
      hw = hw * 1.18 + 1;
      cam.left = -hw; cam.right = hw; cam.top = hw; cam.bottom = -hw;
      cam.updateProjectionMatrix();
      key.position.copy(cam.position).add(new THREE.Vector3(-200, 400, 100));
      key.target.position.copy(c);
      snapRenderer.render(scene, cam);
      out.push({ name, url: snapRenderer.domElement.toDataURL('image/jpeg', 0.9) });
    }
    for (const [m, hex] of tinted) m.color.setHex(hex);
    scene.background = prevBg;
    if (grid) grid.visible = gridVis;
    overlay.visible = true;
    requestRender();
    return out;
  }

  return {
    update,
    snapshots,
    fit,
    setView,
    setTheme() { colors = readColors(); scene.background = new THREE.Color(colors.bg); requestRender(); },
    init() { colors = readColors(); scene.background = new THREE.Color(colors.bg); resize(); },
  };
}
