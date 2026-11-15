/* Eardstapa — routes that optimise for beauty, serendipity and aliveness.
   Everything (graph, scores, routing) runs in the browser from a fixed OSM snapshot. */
'use strict';

const CITIES = ['vancouver', 'guelph'];   // add 'metro-vancouver' once data/metro-vancouver.* is built
const CITY_TAB = { vancouver: 'Vancouver', 'metro-vancouver': 'Greater Van', guelph: 'Guelph' };
const F_WALK = 1, F_BIKE_FWD = 2, F_BIKE_BACK = 4, F_DISMOUNT = 8, F_STEPS = 16;
const SPEED = { walk: 4.8 / 3.6, steps: 2.4 / 3.6, bike: 16 / 3.6, dismount: 4.5 / 3.6 };
const K_LADDER = [7, 4.5, 3, 2, 1.2, 0.7, 0.35];
const KIND = {
  lore: ['📌', 'pinned spot', 'pinned spots'],
  view: ['👀', 'viewpoint', 'viewpoints'], art: ['🎨', 'artwork', 'artworks'],
  odd: ['✨', 'curiosity', 'curiosities'], music: ['🎵', 'live music spot', 'live music spots'], park: ['🌳', 'park', 'parks'],
  water: ['🌊', 'waterside', 'watersides'], historic: ['🏛️', 'historic spot', 'historic spots'],
  culture: ['🎭', 'culture spot', 'culture spots'], market: ['🧺', 'market', 'markets'],
  books: ['📚', 'book / vintage shop', 'book & vintage shops'], fountain: ['⛲', 'fountain', 'fountains'],
  maker: ['🛠️', 'maker / brewery', 'makers & breweries'], notable: ['📖', 'notable place', 'notable places'],
  cafe: ['☕', 'café / bakery', 'cafés & bakeries'], food: ['🍽️', 'place to eat or drink', 'places to eat & drink'],
};
const KIND_ORDER = Object.keys(KIND);

const $ = (id) => document.getElementById(id);
const state = {
  city: null, mode: 'walk', budget: 0.35, seed: 0,
  prefs: { nature: true, water: true, life: true, culture: true, calm: true, safe: true, night: false },
  from: null, to: null,           // {lat, lon, label}
};
const cache = {};
let G = null;                     // current city graph
let map, fromMarker, toMarker, routeLayer, poiLayer, heatLayer, pinLayer;
let current = null, steps = [], pins = [], pinMode = false;
const GENERIC_RE = /^(Mural|Sculpture|Statue|Public art|Viewpoint|Fountain|Art installation|Little free library|Street piano|Give box|Chess tables|Ping-pong table|Bandstand|Fire pit|Bird hide|Community garden|Spring|Lighthouse|Obelisk|Windmill|Watermill)$/;

/* ---------------------------------------------------------------- map */
function initMap() {
  map = L.map('map', { zoomControl: false, preferCanvas: true });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  poiLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if (pinMode) { openPinForm(e.latlng); return; }
    const p = { lat: e.latlng.lat, lon: e.latlng.lng, label: null };
    if (!state.from) setEnd('from', p);
    else if (!state.to) setEnd('to', p);
    else { setEnd('to', p); }
  });
  heatLayer = makeHeatLayer();
}

/* ---------------------------------------------------------------- data */
async function loadCity(id) {
  if (cache[id]) return cache[id];
  const [meta, buf] = await Promise.all([
    fetch(`data/${id}.json`).then((r) => r.json()),
    fetch(`data/${id}.bin`).then((r) => r.arrayBuffer()),
  ]);
  const N = meta.nodes, E = meta.edges;
  let o = 0;
  const take = (T, n) => { const a = new T(buf.slice(o, o + n * T.BYTES_PER_ELEMENT)); o += n * T.BYTES_PER_ELEMENT; return a; };
  const lat7 = take(Int32Array, N), lon7 = take(Int32Array, N);
  const ea = take(Uint32Array, E), eb = take(Uint32Array, E), len = take(Float32Array, E);
  const nflag = take(Uint8Array, N), eflag = take(Uint8Array, E);
  const f = {};
  for (const k of ['nature', 'water', 'life', 'culture', 'calmW', 'calmB', 'safeW', 'safeB', 'lit']) f[k] = take(Uint8Array, E);
  const nameIdx = take(Uint16Array, E);

  const lat = new Float64Array(N), lon = new Float64Array(N), mx = new Float64Array(N), my = new Float64Array(N);
  const x = new Float32Array(N), y = new Float32Array(N);       // local metres, for the A* heuristic
  const lat0 = meta.center[0], cos0 = Math.cos(lat0 * Math.PI / 180);
  for (let i = 0; i < N; i++) {
    lat[i] = lat7[i] / 1e7; lon[i] = lon7[i] / 1e7;
    mx[i] = (lon[i] + 180) / 360;                               // web-mercator in [0,1], for drawing
    const s = Math.sin(lat[i] * Math.PI / 180);
    my[i] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    x[i] = (lon[i] - meta.center[1]) * 111320 * cos0;
    y[i] = (lat[i] - lat0) * 110540;
  }

  // CSR adjacency: each edge yields two arcs (arc id = edge*2 + direction)
  const head = new Uint32Array(N + 1);
  for (let e = 0; e < E; e++) { head[ea[e] + 1]++; head[eb[e] + 1]++; }
  for (let i = 0; i < N; i++) head[i + 1] += head[i];
  const fill = head.slice(0, N), arc = new Uint32Array(2 * E);
  for (let e = 0; e < E; e++) { arc[fill[ea[e]]++] = e * 2; arc[fill[eb[e]]++] = e * 2 + 1; }

  // grid for snapping clicks to the network
  const [south, west, north, east] = meta.bbox;
  const gs = 0.002, gw = Math.ceil((east - west) / gs) + 1, gh = Math.ceil((north - south) / gs) + 1;
  const cells = new Map();
  for (let i = 0; i < N; i++) {
    const c = Math.floor((lat[i] - south) / gs) * gw + Math.floor((lon[i] - west) / gs);
    let a = cells.get(c); if (!a) cells.set(c, a = []); a.push(i);
  }
  // grid for points of interest
  const pcells = new Map(), ps = 0.001, pw = Math.ceil((east - west) / ps) + 1;
  meta.poiPts.forEach((p, k) => {
    const c = Math.floor((p[1] - south) / ps) * pw + Math.floor((p[2] - west) / ps);
    let a = pcells.get(c); if (!a) pcells.set(c, a = []); a.push(k);
  });
  meta.placesLower = meta.places.map((p) => p[0].toLowerCase());

  return cache[id] = {
    meta, N, E, lat, lon, mx, my, x, y, ea, eb, len, nflag, eflag, f, head, arc,
    grid: { cells, gs, gw, gh, south, west }, pgrid: { pcells, ps, pw, south, west }, cos0,
    dist: new Float64Array(N), prev: new Int32Array(N), time: {}, alive: new Float32Array(E), nameIdx, pen: new Float32Array(E).fill(1), lore: null,
  };
}

function nearestNode(p) {
  const { cells, gs, gw, gh, south, west } = G.grid;
  const bit = state.mode === 'walk' ? 1 : 2;
  const cy = Math.floor((p.lat - south) / gs), cx = Math.floor((p.lon - west) / gs);
  let best = -1, bd = Infinity;
  for (let r = 0; r < 12; r++) {
    for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
      if (Math.max(Math.abs(yy - cy), Math.abs(xx - cx)) !== r || yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
      const a = cells.get(yy * gw + xx); if (!a) continue;
      for (const i of a) {
        if (!(G.nflag[i] & bit)) continue;
        const dx = (G.lon[i] - p.lon) * G.cos0, dy = G.lat[i] - p.lat, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best >= 0 && r >= 1) break;
  }
  return best;
}

/* ---------------------------------------------------------------- scoring */
// seconds to traverse each edge in the current mode (Infinity = not allowed at all)
function timeArray(mode) {
  if (G.time[mode]) return G.time[mode];
  const t = new Float32Array(G.E);
  for (let e = 0; e < G.E; e++) {
    const fl = G.eflag[e];
    if (mode === 'walk') t[e] = fl & F_WALK ? G.len[e] / (fl & F_STEPS ? SPEED.steps : SPEED.walk) : Infinity;
    else t[e] = fl & (F_BIKE_FWD | F_BIKE_BACK) ? G.len[e] / (fl & F_DISMOUNT ? SPEED.dismount : SPEED.bike) : Infinity;
  }
  return G.time[mode] = t;
}

// 0..1 aliveness of each edge under the current preferences
function computeAlive() {
  const { nature, water, life, culture, calmW, calmB } = G.f, p = state.prefs, a = G.alive;
  const wn = p.nature ? 0.9 / 255 : 0, ww = p.water ? 0.9 / 255 : 0, wl = p.life ? 0.8 / 255 : 0, wc = p.culture ? 0.8 / 255 : 0;
  const calm = state.mode === 'walk' ? calmW : calmB;
  const anyPos = wn || ww || wl || wc;
  let cw = state.mode === 'walk' ? (p.calm ? 0.4 : 0.12) : (p.calm ? 0.55 : 0.3);
  if (!anyPos) cw = 1;
  const safe = state.mode === 'walk' ? G.f.safeW : G.f.safeB, lit = G.f.lit, pen = G.pen, lore = G.lore;
  for (let e = 0; e < G.E; e++) {
    const pos = 1 - (1 - wn * nature[e]) * (1 - ww * water[e]) * (1 - wl * life[e]) * (1 - wc * culture[e]);
    let v = pos * (1 - cw) + (calm[e] / 255) * cw;
    if (lore && lore[e] > v) v = lore[e];
    a[e] = v;
    // extra cost for stretches that feel exposed to traffic, or dark at night
    let q = 1;
    if (p.safe) { const d = 1 - safe[e] / 255; q += 2.5 * d * d; }
    if (p.night) { const d = 1 - lit[e] / 255; q += 4 * d * d; }
    pen[e] = q;
  }
  G.patchesDirty = true;
}

// "Surprise me": whole patches of town (about 400 m across) become more or less inviting,
// so the route shifts by neighbourhoods rather than by single street segments
function buildNoise(seed) {
  const n = G.noise || (G.noise = new Float32Array(G.E)), { x, y, ea, eb } = G, S = 400;
  const corner = (i, j) => hash01((i * 73856093) ^ (j * 19349663), seed);
  for (let e = 0; e < G.E; e++) {
    const fx = (x[ea[e]] + x[eb[e]]) / 2 / S, fy = (y[ea[e]] + y[eb[e]]) / 2 / S;
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const sm = (t) => t * t * (3 - 2 * t), a = sm(u), b = sm(v);
    const val = corner(i, j) * (1 - a) * (1 - b) + corner(i + 1, j) * a * (1 - b) + corner(i, j + 1) * (1 - a) * b + corner(i + 1, j + 1) * a * b;
    n[e] = (0.55 + 1.3 * val) * (0.9 + 0.2 * hash01(e, seed));
  }
}

// how inviting each 300 m patch of town is under the current preferences, with one street point to aim for
function patchScores() {
  if (G.patches && !G.patchesDirty) return G.patches;
  const m = new Map(), time = timeArray(state.mode), { x, y, ea, eb, len, alive } = G;
  for (let e = 0; e < G.E; e++) {
    if (time[e] === Infinity) continue;
    const a = ea[e], key = (Math.floor(x[a] / 300) + 2000) * 4096 + Math.floor(y[a] / 300) + 2000;
    let c = m.get(key); if (!c) m.set(key, c = { key, sum: 0, len: 0, best: -1, node: a });
    c.sum += alive[e] * len[e]; c.len += len[e];
    if (alive[e] > c.best) { c.best = alive[e]; c.node = a; }
  }
  G.patches = [...m.values()].filter((c) => c.len > 300).map((c) => ({ key: c.key, node: c.node, score: c.sum / c.len }));
  G.patchesDirty = false;
  return G.patches;
}

function hash01(e, seed) {
  let h = Math.imul(e ^ (seed * 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* ---------------------------------------------------------------- routing (A*) */
const heap = { k: new Float64Array(1 << 16), v: new Int32Array(1 << 16), n: 0 };
function hpush(key, val) {
  if (heap.n === heap.k.length) {
    const k = new Float64Array(heap.n * 2), v = new Int32Array(heap.n * 2); k.set(heap.k); v.set(heap.v); heap.k = k; heap.v = v;
  }
  let i = heap.n++; const K = heap.k, V = heap.v;
  while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
  K[i] = key; V[i] = val;
}
function hpop() {
  const K = heap.k, V = heap.v, top = V[0], n = --heap.n;
  if (n > 0) {
    const key = K[n], val = V[n]; let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= n) break;
      if (c + 1 < n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c]; V[i] = V[c]; i = c;
    }
    K[i] = key; V[i] = val;
  }
  return top;
}

// K = how strongly dull streets are penalised (0 = fastest route)
function findRoute(src, dst, K, seed, avoid) {
  const { head, arc, ea, eb, eflag, x, y, dist, prev, alive, pen } = G;
  const time = timeArray(state.mode), bike = state.mode === 'bike';
  const vmax = bike ? SPEED.bike : SPEED.walk, noise = G.noise, hk = (seed ? 0.49 : 1) / vmax;
  dist.fill(Infinity); prev.fill(-1); heap.n = 0;
  const tx = x[dst], ty = y[dst];
  dist[src] = 0; hpush(0, src);
  while (heap.n) {
    const u = hpop();
    if (u === dst) break;
    const du = dist[u];
    for (let j = head[u], end = head[u + 1]; j < end; j++) {
      const a = arc[j], e = a >> 1, back = a & 1;
      let c = time[e];
      if (c === Infinity) continue;
      if (bike && !(eflag[e] & (back ? F_BIKE_BACK : F_BIKE_FWD))) continue;
      if (K) { const d = 1 - alive[e]; c *= (1 + K * d * d) * pen[e]; }
      if (seed) c *= noise[e];
      if (avoid && avoid[e]) c *= 2.5;        // discourage walking back the way we came
      const v = back ? ea[e] : eb[e], nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd; prev[v] = a;
        hpush(nd + Math.hypot(x[v] - tx, y[v] - ty) * hk, v);
      }
    }
  }
  if (dist[dst] === Infinity) return null;
  const edges = [], nodes = [dst];
  for (let v = dst; v !== src;) { const a = prev[v], e = a >> 1; edges.push(e); v = a & 1 ? eb[e] : ea[e]; nodes.push(v); }
  nodes.reverse(); edges.reverse();
  return summarise(nodes, edges);
}

function summarise(nodes, edges) {
  const time = timeArray(state.mode), f = G.f, calm = state.mode === 'walk' ? f.calmW : f.calmB;
  const r = { nodes, edges, secs: 0, metres: 0, alive: 0, share: { nature: 0, water: 0, life: 0, culture: 0, calm: 0, safe: 0, lit: 0 } };
  const safe = state.mode === 'walk' ? f.safeW : f.safeB;
  for (const e of edges) {
    const l = G.len[e];
    r.secs += time[e]; r.metres += l; r.alive += G.alive[e] * l;
    if (f.nature[e] > 115) r.share.nature += l;
    if (f.water[e] > 90) r.share.water += l;
    if (f.life[e] > 90) r.share.life += l;
    if (f.culture[e] > 80) r.share.culture += l;
    if (calm[e] > 165) r.share.calm += l;
    if (safe[e] > 175) r.share.safe += l;
    if (f.lit[e] > 165) r.share.lit += l;
  }
  r.alive /= r.metres || 1;
  for (const k in r.share) r.share[k] /= r.metres || 1;
  r.latlngs = nodes.map((n) => [G.lat[n], G.lon[n]]);
  r.cum = new Float32Array(nodes.length);
  edges.forEach((e, i) => { r.cum[i + 1] = r.cum[i] + G.len[e]; });
  return r;
}

function routeHighlights(r) {
  const { pcells, ps, pw, south, west } = G.pgrid, pts = G.meta.poiPts, pois = G.meta.pois;
  const reach = state.mode === 'walk' ? 45 : 60, found = new Map();
  let acc = 0;
  for (let i = 0; i < r.nodes.length; i++) {
    const n = r.nodes[i], la = G.lat[n], lo = G.lon[n];
    if (i) acc += G.len[r.edges[i - 1]];
    const cy = Math.floor((la - south) / ps), cx = Math.floor((lo - west) / ps);
    for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) {
      const a = pcells.get(yy * pw + xx); if (!a) continue;
      for (const k of a) {
        const p = pts[k], d = Math.hypot((p[1] - la) * 110540, (p[2] - lo) * 111320 * G.cos0);
        if (d > reach) continue;
        const cur = found.get(p[0]);
        if (!cur || d < cur.d) found.set(p[0], { i: p[0], d, at: acc, lat: p[1], lon: p[2], kind: pois[p[0]][0], name: pois[p[0]][1] });
      }
    }
  }
  return [...found.values()];
}

/* ---------------------------------------------------------------- planning + rendering */
function plan() {
  routeLayer.clearLayers(); poiLayer.clearLayers(); current = null;
  $('result').hidden = true; $('hint').hidden = false;
  writeHash();
  if (!G || !state.from || !state.to) { $('hint').textContent = 'Click the map to drop a start, then a destination. Drag the pins to adjust.'; return; }
  const s = nearestNode(state.from), d = nearestNode(state.to);
  if (s < 0 || d < 0 || s === d) { $('hint').textContent = 'Pick two different spots inside the city.'; return; }
  computeAlive();
  if (state.seed) buildNoise(state.seed);
  const fast = findRoute(s, d, 0, 0);
  if (!fast) { $('hint').textContent = 'No route found between those two points.'; return; }
  let alive = null, usedK = K_LADDER[K_LADDER.length - 1];
  for (const K of K_LADDER) {
    const r = findRoute(s, d, K, state.seed);
    if (r && (r.secs <= fast.secs * (1 + state.budget) + 30 || K === K_LADDER[K_LADDER.length - 1])) { alive = r; usedK = K; break; }
  }
  if (!alive) alive = fast;
  const via = [];
  alive = wanderFurther(s, d, alive, fast, usedK, via);
  alive = viaPins(s, d, alive, fast, usedK, via);
  draw(fast, alive);
}

// pinned spots near the route become stops along it, as long as the detour budget allows
// "A lot" and "Get lost" do not just allow a detour, they go looking for one: head for the most
// inviting patch of town that sits well off the direct line, then carry on to the destination
function wanderFurther(s, d, base, fast, K, via) {
  const stretch = state.budget >= 9 ? 1.0 : state.budget >= 0.7 ? 0.6 : 0;      // extra time we are happy to spend
  if (!stretch || base.secs >= fast.secs * (1 + stretch * 0.6)) return base;
  const { x, y } = G, direct = Math.hypot(x[s] - x[d], y[s] - y[d]);
  let cand = patchScores().filter((c) => {
    const around = Math.hypot(x[c.node] - x[s], y[c.node] - y[s]) + Math.hypot(x[c.node] - x[d], y[c.node] - y[d]);
    return around > direct * (1 + stretch * 0.3) && around < direct * (1 + stretch * 0.85);
  }).sort((a, b) => b.score - a.score).slice(0, 10);
  if (state.seed) cand.sort((a, b) => hash01(a.key, state.seed) - hash01(b.key, state.seed));
  const mark = G.mark || (G.mark = new Uint8Array(G.E));
  for (const c of cand.slice(0, 4)) {
    const mid = nearestNode({ lat: G.lat[c.node], lon: G.lon[c.node] });
    if (mid < 0 || mid === s || mid === d) continue;
    const out = findRoute(s, mid, K, state.seed);
    if (!out) continue;
    mark.fill(0); for (const e of out.edges) mark[e] = 1;
    const back = findRoute(mid, d, K, state.seed, mark);
    if (!back) continue;
    const r = summarise(out.nodes.concat(back.nodes.slice(1)), out.edges.concat(back.edges));
    // never trade a nicer short route for a duller long one
    if (r.secs <= fast.secs * (1 + stretch) + 120 && r.alive >= base.alive - 0.03) { via.push({ node: mid, prog: out.metres }); return r; }
  }
  return base;
}

function viaPins(s, d, base, fast, K, via0) {
  if (!pins.length) return base;
  const limit = fast.secs * (1 + Math.min(state.budget, 1.5)) + 60;
  const near = pins.map((p) => ({ p, node: nearestNode(p), pos: locateOnRoute(base, p.lat, p.lon) }))
    .filter((c) => c.node >= 0 && c.pos.dist > 40 && c.pos.dist < 600)
    .sort((a, b) => a.pos.dist - b.pos.dist).slice(0, 4);
  let via = via0 || [], best = base;
  for (const c of near) {
    const trial = via.concat([{ node: c.node, prog: c.pos.prog }]).sort((a, b) => a.prog - b.prog);
    const pts = [s, ...trial.map((v) => v.node), d];
    let nodes = [s], edges = [], ok = true;
    for (let i = 0; i + 1 < pts.length && ok; i++) {
      const r = findRoute(pts[i], pts[i + 1], K, state.seed);
      if (!r) ok = false; else { nodes = nodes.concat(r.nodes.slice(1)); edges = edges.concat(r.edges); }
    }
    if (!ok) continue;
    const r = summarise(nodes, edges);
    if (r.secs <= limit) { via = trial; best = r; }
  }
  return best;
}

const mins = (s) => Math.max(1, Math.round(s / 60));
const fmtTime = (s) => { const m = mins(s); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const fmtDist = (m) => m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

function draw(fast, alive) {
  const same = fast.edges.length === alive.edges.length && fast.edges.every((e, i) => e === alive.edges[i]);
  if (!same) {
    L.polyline(fast.latlngs, { color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(fast.latlngs, { color: '#e8833a', weight: 5, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer)
      .bindTooltip(`Hurry · ${fmtTime(fast.secs)}`, { permanent: true, className: 'routeLabel fast', direction: 'right', offset: [8, 0] })
      .openTooltip(fast.latlngs[Math.floor(fast.latlngs.length * 0.7)]);
  }
  L.polyline(alive.latlngs, { color: '#fff', weight: 10, opacity: 0.95, interactive: false }).addTo(routeLayer);
  const extra = mins(alive.secs) - mins(fast.secs);
  L.polyline(alive.latlngs, { color: '#2f6fed', weight: 6, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer)
    .bindTooltip(`Wander · ${fmtTime(alive.secs)}${extra > 0 ? ` (+${extra})` : ''}`, { permanent: true, className: 'routeLabel alive', direction: 'left', offset: [-8, 0] })
    .openTooltip(alive.latlngs[Math.floor(alive.latlngs.length * 0.4)]);

  $('aliveTime').textContent = fmtTime(alive.secs) + (extra > 0 ? ` (+${extra} min)` : '');
  $('aliveSub').textContent = `${fmtDist(alive.metres)} · ` + (same ? 'here the direct way is also the wandering way' : extra > 0 ? `${extra} min more to look around` : 'no extra time');
  $('fastTime').textContent = fmtTime(fast.secs);
  $('fastSub').textContent = `${fmtDist(fast.metres)} · the direct way`;

  const rows = [['nature', '🌳 Green'], ['water', '🌊 Waterside'], ['life', '☕ Lively'], ['culture', '🎨 Art & heritage'], ['calm', '🤫 Quiet'], ['safe', '🛡️ Low traffic']];
  if (state.prefs.night) rows.push(['lit', '🌙 Well lit']);
  $('bars').innerHTML = rows.map(([k, label]) => {
    const a = Math.round(alive.share[k] * 100), f = Math.round(fast.share[k] * 100);
    return `<span>${label}</span><span class="bar" title="Wander ${a}% · hurry ${f}%"><b style="width:${a}%"></b><i style="left:${f}%"></i></span><span class="v">${a}%</span>`;
  }).join('') + '<span></span><span class="v" style="font-size:11.5px">bar = wander · tick = hurry</span><span></span>';

  // highlights
  const hs = routeHighlights(alive).concat(pinsNear(alive)).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.at - b.at);
  const chips = [], shown = [];
  for (const kind of KIND_ORDER) {
    const list = hs.filter((h) => h.kind === kind); if (!list.length) continue;
    const [emoji, one, many] = KIND[kind];
    const generic = list.filter((h) => GENERIC_RE.test(h.name));
    const named = list.filter((h) => !generic.includes(h));
    const cap = kind === 'cafe' || kind === 'food' ? 0 : 4;
    named.slice(0, cap).forEach((h) => { chips.push(`<span class="chip" data-i="${shown.length}" title="${esc(h.name)}">${emoji} ${esc(h.name)}</span>`); shown.push(h); });
    const rest = list.length - Math.min(named.length, cap);
    if (rest > 0) chips.push(`<span class="chip count">${emoji} ${cap && named.length ? '+' : ''}${rest} ${rest === 1 ? one : many}</span>`);
    if (!cap) list.slice(0, 3).forEach((h) => shown.push(h)); else generic.slice(0, 3).forEach((h) => shown.push(h));
  }
  $('highlights').innerHTML = chips.join('') || '<span class="chip count">Nothing mapped right along this one — “Get lost” looks further afield</span>';
  const markers = shown.slice(0, 24).map((h) =>
    L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', html: `<div class="poi">${KIND[h.kind][0]}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindTooltip(h.name, { direction: 'top', offset: [0, -12] }).addTo(poiLayer));
  $('highlights').querySelectorAll('[data-i]').forEach((el) => el.addEventListener('click', () => {
    const m = markers[+el.dataset.i]; if (m) { map.panTo(m.getLatLng()); m.openTooltip(); }
  }));

  current = { fast, alive }; renderSteps(alive);
  $('result').hidden = false; $('hint').hidden = true;
  navUpdate();
  if (draw.fit) { map.fitBounds(L.latLngBounds(alive.latlngs.concat(fast.latlngs)), { paddingTopLeft: [innerWidth > 700 ? 370 : 30, 40], paddingBottomRight: [40, innerWidth > 700 ? 40 : innerHeight * 0.5] }); draw.fit = false; }
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------- endpoints + search */
function setEnd(which, p, fit) {
  state[which] = p; state.seed = 0;
  const input = $(which);
  input.value = p ? (p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`) : '';
  let m = which === 'from' ? fromMarker : toMarker;
  if (m) { m.remove(); m = null; }
  if (p) {
    m = L.marker([p.lat, p.lon], { draggable: true, zIndexOffset: 1000, icon: L.divIcon({ className: '', html: `<div class="pin ${which}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
    m.on('dragend', () => { const ll = m.getLatLng(); setEnd(which, { lat: ll.lat, lon: ll.lng, label: null }); });
  }
  if (which === 'from') fromMarker = m; else toMarker = m;
  if (fit) draw.fit = true;
  plan();
}

function wireSearch(which) {
  const input = $(which), box = $(which + 'Suggest');
  let items = [], sel = -1;
  const close = () => { box.classList.remove('open'); sel = -1; };
  const render = () => {
    box.innerHTML = items.map((it, i) => `<div class="${i === sel ? 'sel' : ''}" data-i="${i}">${it.html}</div>`).join('');
    box.classList.toggle('open', items.length > 0);
  };
  const choose = async (it) => {
    close();
    if (it.online) { await onlineSearch(it.q); return; }
    setEnd(which, { lat: it.lat, lon: it.lon, label: it.label }, true);
  };
  const onlineSearch = async (q) => {
    const [s, w, n, e] = G.meta.bbox;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(q)}`).then((r) => r.json());
      items = res.map((r) => ({ lat: +r.lat, lon: +r.lon, label: r.display_name.split(',').slice(0, 2).join(','), html: esc(r.display_name.split(',').slice(0, 3).join(',')) }));
      if (!items.length) items = [{ none: true, html: '<small>Nothing found in this city</small>' }];
    } catch { items = [{ none: true, html: '<small>Address search is unavailable offline</small>' }]; }
    sel = -1; render();
  };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase(); items = []; sel = -1;
    if (q.length >= 2 && G) {
      const P = G.meta.places, low = G.meta.placesLower, starts = [], has = [];
      for (let i = 0; i < low.length && starts.length < 7; i++) {
        const k = low[i].indexOf(q);
        if (k === 0) starts.push(i); else if (k > 0 && has.length < 7) has.push(i);
      }
      items = starts.concat(has).slice(0, 7).map((i) => {
        const [name, lat, lon, kind] = P[i];
        return { lat, lon, label: name, html: `${kind === 'street' ? '🛣️' : KIND[kind][0]} ${esc(name)}` };
      });
      items.push({ online: true, q: input.value.trim(), html: `<small>🔎 Search addresses for “${esc(input.value.trim())}”</small>` });
    }
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && items.length) { const it = items[Math.max(sel, 0)]; if (!it.none) choose(it); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('focus', () => input.select());
  box.addEventListener('mousedown', (e) => {
    const el = e.target.closest('[data-i]'); if (!el) return;
    e.preventDefault(); const it = items[+el.dataset.i]; if (!it.none) choose(it);
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

/* ---------------------------------------------------------------- street aliveness overlay */
function makeHeatLayer() {
  const canvas = L.DomUtil.create('canvas', 'heatCanvas');
  const COLORS = ['#f2c79b', '#e8a04e', '#b9a9c9', '#7fa3e8', '#2f6fed'];
  const layer = {
    on: false,
    redraw() {
      if (!layer.on || !G) return;
      const size = map.getSize(), dpr = window.devicePixelRatio || 1, z = map.getZoom();
      canvas.width = size.x * dpr; canvas.height = size.y * dpr;
      canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
      if (z < 13) return;
      const scale = 256 * Math.pow(2, z), org = map.getPixelBounds().min;
      const { mx, my, ea, eb, alive, E } = G, time = timeArray(state.mode);
      const x0 = org.x / scale, x1 = (org.x + size.x) / scale, y0 = org.y / scale, y1 = (org.y + size.y) / scale;
      const paths = COLORS.map(() => new Path2D());
      for (let e = 0; e < E; e++) {
        const a = ea[e], b = eb[e];
        if (time[e] === Infinity || (mx[a] < x0 && mx[b] < x0) || (mx[a] > x1 && mx[b] > x1) || (my[a] < y0 && my[b] < y0) || (my[a] > y1 && my[b] > y1)) continue;
        const p = paths[Math.min(4, Math.floor(alive[e] * 5.5))];
        p.moveTo(mx[a] * scale - org.x, my[a] * scale - org.y); p.lineTo(mx[b] * scale - org.x, my[b] * scale - org.y);
      }
      ctx.lineCap = 'round'; ctx.globalAlpha = 0.8;
      paths.forEach((p, i) => { ctx.strokeStyle = COLORS[i]; ctx.lineWidth = (z >= 16 ? 3 : z >= 15 ? 2.2 : 1.4) + i * 0.25; ctx.stroke(p); });
    },
    set(on) {
      layer.on = on;
      if (on) { map.getPanes().overlayPane.appendChild(canvas); computeAlive(); layer.redraw(); } else canvas.remove();
      $('legend').hidden = !on;
    },
  };
  map.on('moveend zoomend resize', () => layer.redraw());
  map.on('zoomstart', () => { if (layer.on) canvas.style.visibility = 'hidden'; });
  map.on('zoomend', () => { canvas.style.visibility = ''; });
  return layer;
}

/* ---------------------------------------------------------------- state + UI */
function writeHash() {
  const p = (e) => e ? `${e.lat.toFixed(5)},${e.lon.toFixed(5)}` : '';
  history.replaceState(null, '', `#c=${state.city}&m=${state.mode}&f=${p(state.from)}&t=${p(state.to)}`);
}
function readHash() {
  const h = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  const pt = (s) => { const [a, b] = (s || '').split(',').map(Number); return isFinite(a) && isFinite(b) && s ? { lat: a, lon: b, label: null } : null; };
  return { city: CITIES.includes(h.c) ? h.c : null, mode: h.m === 'bike' ? 'bike' : 'walk', from: pt(h.f), to: pt(h.t) };
}

async function switchCity(id, keep) {
  $('loading').hidden = false;
  state.city = id;
  [...$('cityTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.city === id));
  try { G = await loadCity(id); } catch (err) { $('loading').textContent = 'Could not load city data — run scripts/build_graph.py first.'; throw err; }
  $('loading').hidden = true;
  if (!keep) { setEnd('from', null); setEnd('to', null); map.setView(G.meta.center, G.meta.zoom); }
  $('foot').textContent = `${G.meta.label}: ${G.N.toLocaleString()} points, ${G.E.toLocaleString()} street segments scored from a fixed OpenStreetMap snapshot. No live traffic, closures or hills.`;
  computeLore(); computeAlive(); heatLayer.redraw();
}

function initUI() {
  $('cityTabs').innerHTML = CITIES.map((c) => `<button data-city="${c}">${CITY_TAB[c]}</button>`).join('');
  $('cityTabs').addEventListener('click', (e) => { const c = e.target.dataset.city; if (c && c !== state.city) switchCity(c); });
  $('modeTabs').addEventListener('click', (e) => {
    const m = e.target.dataset.mode; if (!m) return;
    setMode(m); state.seed = 0; computeAlive(); heatLayer.redraw(); plan();
  });
  $('budget').addEventListener('click', (e) => {
    const b = e.target.dataset.b; if (!b) return;
    state.budget = +b; [...$('budget').children].forEach((x) => x.classList.toggle('on', x === e.target)); plan();
  });
  $('prefs').addEventListener('change', (e) => {
    state.prefs[e.target.dataset.pref] = e.target.checked; state.seed = 0; computeAlive(); heatLayer.redraw(); plan();
  });
  $('swap').addEventListener('click', () => { const a = state.from, b = state.to; setEnd('from', b); setEnd('to', a); });
  $('surprise').addEventListener('click', () => { state.seed = 1 + Math.floor(Math.random() * 1e6); plan(); });
  $('heat').addEventListener('change', (e) => heatLayer.set(e.target.checked));
  wireSearch('from'); wireSearch('to');
  initNav(); initPins();
}
function setMode(m) {
  state.mode = m;
  [...$('modeTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}

/* ---------------------------------------------------------------- written directions */
const norm180 = (a) => ((a + 540) % 360) - 180;
const compass = (b) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((b + 360) % 360) / 45) % 8];

// bearing of the route just after (dir=1) or just before (dir=-1) its i-th node, measured over ~20 m
function bearingAt(r, i, dir) {
  const n = r.nodes; let j = i, d = 0;
  while (j + dir >= 0 && j + dir < n.length && d < 20) { d += G.len[r.edges[dir > 0 ? j : j - 1]]; j += dir; }
  const a = n[dir > 0 ? i : j], b = n[dir > 0 ? j : i];
  return Math.atan2(G.x[b] - G.x[a], G.y[b] - G.y[a]) * 180 / Math.PI;
}

function buildSteps(r) {
  const names = G.meta.names, raw = [];
  let at = 0;
  r.cum = new Float32Array(r.nodes.length);
  for (let i = 0; i < r.edges.length; i++) {
    const e = r.edges[i], name = names[G.nameIdx[e]], l = G.len[e];
    let turn = 0, split = i === 0;
    if (i > 0) {
      turn = norm180(bearingAt(r, i, 1) - bearingAt(r, i, -1));
      const node = r.nodes[i], junction = G.head[node + 1] - G.head[node] > 2;
      split = name !== raw[raw.length - 1].name || (junction && Math.abs(turn) > 50);
    }
    if (split) raw.push({ name, turn, len: l, at, i }); else raw[raw.length - 1].len += l;
    at += l; r.cum[i + 1] = at;
  }
  // fold crossings and tiny unnamed links into the street they belong to
  const res = [];
  for (const s of raw) {
    const p = res[res.length - 1], tiny = s.name === '~crossing' || (s.name[0] === '~' && s.len < 15);
    if (p && (tiny || (p.name === s.name && Math.abs(s.turn) <= 50))) { p.len += s.len; continue; }
    res.push(s);
  }
  if (res.length > 1 && (res[0].name === '~crossing' || (res[0].name[0] === '~' && res[0].len < 15))) {
    res[1].len += res[0].len; res[1].at = 0; res[1].i = 0; res.shift();
  }
  // tidy: drop cross-street blips, little jogs and slivers too short to be an instruction
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k < res.length; k++) {
      const p = res[k - 1], s = res[k], n = res[k + 1];
      if (!n) break;
      const blip = n.name === p.name && s.len < 35 && Math.abs(s.turn) <= 50 && Math.abs(n.turn) <= 50;
      const jog = s.name === p.name && n.name === p.name && s.len < 40 && Math.abs(norm180(s.turn + n.turn)) < 40;
      if (blip || jog) { p.len += s.len + n.len; res.splice(k, 2); changed = true; break; }
      if (s.len < 12) {
        n.turn = norm180(bearingAt(r, n.i, 1) - bearingAt(r, s.i, -1)); n.len += s.len; n.at = s.at; n.i = s.i;
        res.splice(k, 1);
        if (n.name === p.name && Math.abs(n.turn) <= 50) { p.len += n.len; res.splice(k, 1); }
        changed = true; break;
      }
    }
  }
  res.forEach((s, k) => {
    const disp = s.name === '~crossing' ? 'the crossing' : s.name[0] === '~' ? s.name.slice(1) : s.name;
    const t = s.turn, a = Math.abs(t), side = t > 0 ? 'right' : 'left';
    s.disp = disp;
    if (k === 0) { s.icon = '⬆️'; s.text = `Head ${compass(bearingAt(r, 0, 1))} on ${disp}`; return; }
    const verb = a < 25 ? 'Continue' : a < 60 ? `Bear ${side}` : a < 140 ? `Turn ${side}` : `Sharp ${side}`;
    s.icon = a < 25 ? '⬆️' : t > 0 ? (a < 60 ? '↗️' : '➡️') : (a < 60 ? '↖️' : '⬅️');
    s.text = s.name === res[k - 1].name ? `${verb} to stay on ${disp}` : a < 25 ? `Continue onto ${disp}` : `${verb} onto ${disp}`;
  });
  res.push({ name: '', disp: '', text: 'Arrive at your destination', icon: '🏁', len: 0, at: r.metres, i: r.nodes.length - 1 });
  return res;
}

function renderSteps(r) {
  steps = buildSteps(r);
  $('dirSum').textContent = `Directions · ${steps.length} steps`;
  $('steps').innerHTML = steps.map((s, k) => `<li data-k="${k}"><span>${s.icon}</span><span>${esc(s.text)}</span><small>${s.len ? fmtDist(s.len) : ''}</small></li>`).join('');
}

/* ---------------------------------------------------------------- GPS following */
const nav = { on: false, watch: null, off: 0, dot: null, ring: null, lock: null, last: null };
const GEO = { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 };
function setNav(text, sub) { $('nav').hidden = false; $('navText').textContent = text; $('navSub').textContent = sub || ''; }
function geoErr(err) {
  setNav('Location unavailable', err && err.code === 1 ? 'Allow location access for this page, then try again.' : 'Could not get a GPS fix. Location needs a secure (https) link.');
}
async function keepAwake() { try { if (navigator.wakeLock) nav.lock = await navigator.wakeLock.request('screen'); } catch { /* not supported */ } }
function onFix(g) { onPos(g.coords.latitude, g.coords.longitude, g.coords.accuracy || 20); }

function startNav() {
  if (!navigator.geolocation) { geoErr(); return; }
  nav.on = true; nav.off = 0;
  $('follow').textContent = '■ Stop following'; $('follow').classList.add('on');
  setNav('Finding you…', '');
  nav.watch = navigator.geolocation.watchPosition(onFix, geoErr, GEO);
  keepAwake();
}
function stopNav() {
  nav.on = false;
  if (nav.watch !== null) navigator.geolocation.clearWatch(nav.watch);
  nav.watch = null;
  if (nav.lock) { nav.lock.release().catch(() => {}); nav.lock = null; }
  $('nav').hidden = true; $('follow').textContent = '📍 Follow me along Wander'; $('follow').classList.remove('on');
  document.querySelectorAll('#steps li.now').forEach((el) => el.classList.remove('now'));
}

function onPos(lat, lon, acc) {
  nav.last = { lat, lon, acc };
  if (!nav.dot) {
    nav.ring = L.circle([lat, lon], { radius: acc, color: '#2f6fed', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    nav.dot = L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2f6fed', fillOpacity: 1, interactive: false }).addTo(map);
  } else { nav.dot.setLatLng([lat, lon]); nav.ring.setLatLng([lat, lon]); nav.ring.setRadius(acc); }
  if (!nav.on) return;
  map.setView([lat, lon], Math.max(map.getZoom(), 17), { animate: true });
  navUpdate();
}

// where am I along the route? project the position onto every segment
function locateOnRoute(r, lat, lon) {
  const px = (lon - G.meta.center[1]) * 111320 * G.cos0, py = (lat - G.meta.center[0]) * 110540;
  let best = Infinity, prog = 0;
  for (let i = 0; i < r.edges.length; i++) {
    const a = r.nodes[i], b = r.nodes[i + 1], ax = G.x[a], ay = G.y[a], dx = G.x[b] - ax, dy = G.y[b] - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
    if (d < best) { best = d; prog = r.cum[i] + t * (r.cum[i + 1] - r.cum[i]); }
  }
  return { dist: best, prog };
}

function navUpdate() {
  if (!nav.on || !nav.last || !G) return;
  const { lat, lon, acc } = nav.last, here = { lat, lon, label: 'My location' };
  const [s, w, n, e] = G.meta.bbox;
  if (lat < s || lat > n || lon < w || lon > e) { setNav('You are outside this map', `Switch city, or head to ${G.meta.label}.`); return; }
  if (!state.to) { setNav('Pick a destination', 'Type one or tap the map.'); return; }
  if (!current) { nav.off = 0; setEnd('from', here); return; }
  const r = current.alive, pos = locateOnRoute(r, lat, lon);
  if (pos.dist > Math.max(45, Math.min(acc, 100))) {
    if (++nav.off >= 3) { nav.off = 0; setEnd('from', here); return; }   // strayed: new route from here
    setNav('Off the route…', 'Finding a new way from where you are.'); return;
  }
  nav.off = 0;
  const left = r.metres - pos.prog;
  if (left < 25) { setNav('🏁 You have arrived', ''); return; }
  let k = 0;
  while (k + 1 < steps.length - 1 && steps[k + 1].at <= pos.prog + 5) k++;
  const next = steps[k + 1];
  setNav(`${next.icon} In ${fmtDist(next.at - pos.prog)}: ${next.text}`, `On ${steps[k].disp} · ${fmtDist(left)} to go, about ${fmtTime(left / r.metres * r.secs)}`);
  document.querySelectorAll('#steps li').forEach((el) => el.classList.toggle('now', +el.dataset.k === k));
}

function initNav() {
  $('follow').addEventListener('click', () => (nav.on ? stopNav() : startNav()));
  $('navStop').addEventListener('click', stopNav);
  $('useLoc').addEventListener('click', () => {
    if (!navigator.geolocation) { geoErr(); return; }
    navigator.geolocation.getCurrentPosition((g) => {
      onFix(g); setEnd('from', { lat: g.coords.latitude, lon: g.coords.longitude, label: 'My location' }, true);
    }, geoErr, GEO);
  });
  $('steps').addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li || !current) return;
    const n = current.alive.nodes[steps[+li.dataset.k].i];
    map.setView([G.lat[n], G.lon[n]], Math.max(map.getZoom(), 17));
  });
  // coming back after the phone was locked or the tab hidden: get a fresh fix, re-route at once if we strayed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !nav.on) return;
    keepAwake(); nav.off = 2;
    navigator.geolocation.getCurrentPosition(onFix, () => {}, GEO);
  });
}

/* ---------------------------------------------------------------- pins: your own local knowledge */
const PIN_EMOJI = ['✨', '🎵', '🎨', '🗣️', '☕', '🌸', '🐕', '📖'];
function loadPins() {
  try { pins = JSON.parse(localStorage.getItem('eardstapa.pins') || '[]').filter(validPin); } catch { pins = []; }
}
const validPin = (p) => p && isFinite(p.lat) && isFinite(p.lon) && typeof p.note === 'string';
function pinsChanged(fromSync) {
  try { localStorage.setItem('eardstapa.pins', JSON.stringify(pins)); } catch { /* storage unavailable */ }
  renderPins(); computeLore(); computeAlive(); heatLayer.redraw(); plan();
  if (!fromSync) syncPins();
}

/* ---------------------------------------------------------------- shared pins (a "circle") */
// Everyone who enters the same circle code sees and adds to the same pins. Only a fingerprint
// of the code leaves the device. Pins dropped outside a circle stay private to this device.
const syncCfg = () => window.EARDSTAPA_SYNC || {};
let circle = null, syncing = false;
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function rpc(fn, body) {
  const { url, key } = syncCfg();
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sync failed (${r.status})`);
  return r.status === 204 ? null : r.json();
}
function showCircle(status) {
  $('circleBtn').textContent = circle ? `👥 Circle “${circle.label}” · leave` : '👥 Share pins with a circle';
  $('circleStatus').textContent = status || '';
}
async function syncPins() {
  if (!circle || !syncCfg().url || syncing) return;
  syncing = true;
  try {
    for (const p of pins.filter((x) => x.circle && !x.id)) {      // pins dropped while offline
      p.id = await rpc('add_pin', { p_circle: circle.hash, p_lat: p.lat, p_lon: p.lon, p_emoji: p.emoji, p_note: p.note });
    }
    const rows = await rpc('get_pins', { p_circle: circle.hash });
    pins = pins.filter((p) => !p.circle).concat(rows.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, emoji: r.emoji, note: r.note, circle: true })));
    showCircle(`${rows.length} shared pin${rows.length === 1 ? '' : 's'}`);
    pinsChanged(true);
  } catch { showCircle('offline — will sync later'); }
  syncing = false;
}
function initCircle() {
  try { circle = JSON.parse(localStorage.getItem('eardstapa.circle') || 'null'); } catch { circle = null; }
  showCircle();
  $('circleBtn').addEventListener('click', () => {
    if (circle) {                                               // leave: shared pins go, private ones stay
      circle = null; localStorage.removeItem('eardstapa.circle');
      pins = pins.filter((p) => !p.circle); showCircle(); pinsChanged(true); return;
    }
    if (!syncCfg().url) { showCircle('Sharing is not set up yet (see config.js)'); return; }
    $('circleForm').hidden = !$('circleForm').hidden;
    if (!$('circleForm').hidden) $('circleCode').focus();
  });
  const join = async () => {
    const code = $('circleCode').value.trim();
    if (code.length < 8) { showCircle('Use at least 8 characters'); return; }
    circle = { hash: await sha256hex('eardstapa:' + code), label: code.slice(0, 3) + '…' };
    localStorage.setItem('eardstapa.circle', JSON.stringify(circle));
    $('circleCode').value = ''; $('circleForm').hidden = true;
    showCircle('joining…'); syncPins();
  };
  $('circleJoin').addEventListener('click', join);
  $('circleCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncPins(); });
  syncPins();
}
function renderPins() {
  pinLayer.clearLayers();
  pins.forEach((p) => {
    const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="poi lore">${esc(p.emoji || '📌')}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(pinLayer);
    m.bindPopup(() => {
      const el = document.createElement('div');
      el.innerHTML = `<b>${esc(p.emoji || '📌')} ${esc(p.note)}</b><br><small>${p.circle ? 'Shared with your circle' : 'Only on this device'}</small><br><button class="pinDel">Remove pin${p.circle ? ' for everyone' : ''}</button>`;
      el.querySelector('.pinDel').onclick = () => {
        pins = pins.filter((x) => x !== p); map.closePopup();
        if (p.id && circle) rpc('delete_pin', { p_circle: circle.hash, p_id: p.id }).catch(() => showCircle('could not remove — try again online')).then(() => pinsChanged());
        else pinsChanged();
      };
      return el;
    });
  });
}
function setPinMode(on) {
  pinMode = on; $('pinBtn').classList.toggle('on', on);
  $('pinBtn').textContent = on ? 'Tap the map to place it…' : '📌 Drop a pin';
}
function openPinForm(latlng) {
  setPinMode(false);
  const el = document.createElement('div'); el.className = 'pinForm';
  el.innerHTML = `<div class="emojis">${PIN_EMOJI.map((e, i) => `<button type="button" class="${i ? '' : 'on'}">${e}</button>`).join('')}</div>
    <input maxlength="140" placeholder="What happens here?"><button type="button" class="save">Save pin</button>`;
  let emoji = PIN_EMOJI[0];
  el.querySelectorAll('.emojis button').forEach((b) => b.addEventListener('click', () => {
    emoji = b.textContent; el.querySelectorAll('.emojis button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  const save = () => {
    pins.push({ lat: +latlng.lat.toFixed(6), lon: +latlng.lng.toFixed(6), emoji, note: el.querySelector('input').value.trim() || 'A good spot', circle: !!circle });
    map.closePopup(); pinsChanged();
  };
  el.querySelector('.save').addEventListener('click', save);
  el.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  L.popup({ closeOnClick: false }).setLatLng(latlng).setContent(el).openOn(map);
  setTimeout(() => el.querySelector('input').focus(), 50);
}
// streets near a pin pull the Wander route towards it, more strongly the closer they are (out to ~250 m)
function computeLore() {
  if (!G) return;
  G.lore = null;
  const [s, w, n, e] = G.meta.bbox, inside = pins.filter((p) => p.lat > s && p.lat < n && p.lon > w && p.lon < e);
  if (!inside.length) return;
  const { cells, gs, gw } = G.grid, nb = new Float32Array(G.N);
  for (const p of inside) {
    const cy = Math.floor((p.lat - s) / gs), cx = Math.floor((p.lon - w) / gs);
    for (let yy = cy - 2; yy <= cy + 2; yy++) for (let xx = cx - 2; xx <= cx + 2; xx++) {
      const a = cells.get(yy * gw + xx); if (!a) continue;
      for (const i of a) {
        const v = 1 - Math.hypot((G.lat[i] - p.lat) * 110540, (G.lon[i] - p.lon) * 111320 * G.cos0) / 250;
        if (v > nb[i]) nb[i] = v;
      }
    }
  }
  const lore = G.lore = new Float32Array(G.E);
  for (let k = 0; k < G.E; k++) lore[k] = Math.max(nb[G.ea[k]], nb[G.eb[k]]);
}
function pinsNear(r) {
  const out = [];
  for (const p of pins) {
    let best = Infinity;
    for (const n of r.nodes) {
      const d = Math.hypot((G.lat[n] - p.lat) * 110540, (G.lon[n] - p.lon) * 111320 * G.cos0);
      if (d < best) best = d;
    }
    if (best < 90) out.push({ kind: 'lore', name: p.note, lat: p.lat, lon: p.lon, at: 0, d: best });
  }
  return out;
}
function initPins() {
  loadPins(); renderPins(); initCircle();
  $('pinBtn').addEventListener('click', () => setPinMode(!pinMode));
  $('pinExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(pins, null, 1)], { type: 'application/json' }));
    a.download = 'eardstapa-pins.json'; a.click();
  });
  $('pinImport').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const add = JSON.parse(await file.text()).filter(validPin);
      const key = (p) => `${p.lat},${p.lon},${p.note}`, have = new Set(pins.map(key));
      pins = pins.concat(add.filter((p) => !have.has(key(p))).map((p) => ({ lat: +p.lat, lon: +p.lon, note: p.note.slice(0, 140), emoji: PIN_EMOJI.includes(p.emoji) ? p.emoji : '✨' })));
      pinsChanged();
    } catch { $('hint').hidden = false; $('hint').textContent = 'That file is not a pins export.'; }
    e.target.value = '';
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async function main() {
  initMap(); initUI();
  const h = readHash();
  setMode(h.mode);
  await switchCity(h.city || CITIES[0], true);
  map.setView(G.meta.center, G.meta.zoom);
  if (h.from) setEnd('from', h.from);
  if (h.to) setEnd('to', h.to, true);
})();
