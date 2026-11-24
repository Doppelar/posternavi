// 道に沿った距離（ブラウザと Node の両方で動く）。
//
// - 道路網（tools/build-komoro.mjs で作った形）を読み込み、移動手段ごとに通れる向きの辺を作る。
// - 掲示場や出発地点は、いちばん近い道の上の点に吸着させる。
// - ダイクストラ法で、点どうしの道に沿った最短距離の表を作る（車は一方通行を守るので、行きと帰りで違うことがある）。
// - ルートが決まったら、区間ごとの道に沿った線を返す（地図に描くため）。

export const CAR_FWD = 1, CAR_BACK = 2, FOOT = 4, BIKE = 8;
/** 道からこれより離れた点は吸着させない（メートル）。 */
export const MAX_SNAP_M = 400;
const CELL = 0.002; // 吸着の検索に使う格子の大きさ（度、約200m）

const RAD = Math.PI / 180;
function haversine(lat1, lon1, lat2, lon2) {
  const dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dl / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 移動手段ごとに、辺 e を a→b（fwd）・b→a（back）に通れるか。 */
export function directions(flags, mode) {
  if (mode === "driving") return { fwd: !!(flags & CAR_FWD), back: !!(flags & CAR_BACK) };
  const bit = mode === "bicycling" ? BIKE : FOOT;
  const ok = !!(flags & bit);
  return { fwd: ok, back: ok };
}

/** 差分で持った座標を戻し、辺ごとの形（点の並びと、a からの距離）を作る。 */
export function loadNetwork(data) {
  const n = data.nodes.length / 2;
  const lat = new Float64Array(n), lon = new Float64Array(n);
  let la = 0, lo = 0;
  for (let i = 0; i < n; i++) {
    la += data.nodes[2 * i]; lo += data.nodes[2 * i + 1];
    lat[i] = la / 1e5; lon[i] = lo / 1e5;
  }
  const { a, b, len, f, g } = data.edges;
  const m = a.length;
  const edges = new Array(m);
  for (let e = 0; e < m; e++) {
    const pts = [[lat[a[e]], lon[a[e]]]];
    if (g[e]) {
      let pla = Math.round(lat[a[e]] * 1e5), plo = Math.round(lon[a[e]] * 1e5);
      for (let k = 0; k < g[e].length; k += 2) {
        pla += g[e][k]; plo += g[e][k + 1];
        pts.push([pla / 1e5, plo / 1e5]);
      }
    }
    pts.push([lat[b[e]], lon[b[e]]]);
    // 形を間引いてあるので、形の上の距離を、本当の長さに合わせて伸ばす
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + haversine(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]));
    const length = len[e] / 10;
    const scale = cum[cum.length - 1] > 0 ? length / cum[cum.length - 1] : 0;
    edges[e] = { a: a[e], b: b[e], length, flags: f[e], pts, cum: cum.map((c) => c * scale) };
  }
  // 吸着の検索用の格子（辺の各区間を、通る格子に登録する）
  const grid = new Map();
  const key = (i, j) => i * 100000 + j;
  edges.forEach((ed, e) => {
    for (let k = 1; k < ed.pts.length; k++) {
      const [y1, x1] = ed.pts[k - 1], [y2, x2] = ed.pts[k];
      const i0 = Math.floor(Math.min(y1, y2) / CELL), i1 = Math.floor(Math.max(y1, y2) / CELL);
      const j0 = Math.floor(Math.min(x1, x2) / CELL), j1 = Math.floor(Math.max(x1, x2) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const kk = key(i, j);
        let list = grid.get(kk);
        if (!list) grid.set(kk, (list = []));
        list.push(e, k);
      }
    }
  });
  return { n, lat, lon, edges, grid, key, graphs: {} };
}

/** 移動手段ごとの、向きつきの辺の表（CSR）。 */
function graphFor(net, mode) {
  if (net.graphs[mode]) return net.graphs[mode];
  const deg = new Int32Array(net.n + 1);
  const dirs = net.edges.map((ed) => directions(ed.flags, mode));
  net.edges.forEach((ed, e) => { if (dirs[e].fwd) deg[ed.a + 1]++; if (dirs[e].back) deg[ed.b + 1]++; });
  for (let i = 0; i < net.n; i++) deg[i + 1] += deg[i];
  const fill = deg.slice();
  const to = new Int32Array(deg[net.n]), w = new Float64Array(deg[net.n]), arcEdge = new Int32Array(deg[net.n]);
  net.edges.forEach((ed, e) => {
    if (dirs[e].fwd) { const p = fill[ed.a]++; to[p] = ed.b; w[p] = ed.length; arcEdge[p] = e; }
    if (dirs[e].back) { const p = fill[ed.b]++; to[p] = ed.a; w[p] = ed.length; arcEdge[p] = e; }
  });
  const g = { start: deg, to, w, arcEdge, dirs };
  g.main = mainComponent(net.n, g);
  return (net.graphs[mode] = g);
}

/**
 * どの点からどの点へも行き来できる、いちばん大きなまとまり（強連結成分）に入る点の印。
 * 吸着はこの中の道にだけ行う（行き止まりの一方通行などに吸着すると、たどり着けない組ができるため）。
 */
function mainComponent(n, g) {
  // 逆向きの辺の表
  const rdeg = new Int32Array(n + 1);
  for (let p = 0; p < g.to.length; p++) rdeg[g.to[p] + 1]++;
  for (let i = 0; i < n; i++) rdeg[i + 1] += rdeg[i];
  const fill = rdeg.slice(), rto = new Int32Array(g.to.length);
  for (let v = 0; v < n; v++) for (let p = g.start[v]; p < g.start[v + 1]; p++) rto[fill[g.to[p]]++] = v;
  // Kosaraju: 1回目の深さ優先探索で終わった順を記録し、逆向きの表で大きい順にまとまりを作る
  const seen = new Uint8Array(n), order = [], stack = [], iter = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    if (seen[r]) continue;
    seen[r] = 1; stack.push(r); iter[r] = g.start[r];
    while (stack.length) {
      const v = stack[stack.length - 1];
      if (iter[v] < g.start[v + 1]) {
        const u = g.to[iter[v]++];
        if (!seen[u]) { seen[u] = 1; iter[u] = g.start[u]; stack.push(u); }
      } else { stack.pop(); order.push(v); }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const r = order[k];
    if (comp[r] >= 0) continue;
    let size = 0;
    comp[r] = c; stack.push(r);
    while (stack.length) {
      const v = stack.pop(); size++;
      for (let p = rdeg[v]; p < rdeg[v + 1]; p++) { const u = rto[p]; if (comp[u] < 0) { comp[u] = c; stack.push(u); } }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const main = new Uint8Array(n);
  for (let v = 0; v < n; v++) main[v] = comp[v] === best ? 1 : 0;
  return main;
}

/**
 * 点を、その移動手段で通れるいちばん近い道の上に吸着させる。
 * 返り値: { edge, offset（a からの距離 m）, dist（道までの距離 m）, lat, lon } か、近くに道がなければ null。
 */
export function snap(net, p, mode) {
  const g = graphFor(net, mode);
  const kx = Math.cos(p.lat * RAD) * 111320, ky = 110540;
  const ci = Math.floor(p.lat / CELL), cj = Math.floor(p.lon / CELL);
  const maxRing = Math.ceil(MAX_SNAP_M / 180) + 1;
  let best = null;
  const seen = new Set();
  for (let r = 0; r <= maxRing; r++) {
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
      const list = net.grid.get(net.key(i, j));
      if (!list) continue;
      for (let t = 0; t < list.length; t += 2) {
        const e = list[t], k = list[t + 1];
        const sk = e * 4096 + k;
        if (seen.has(sk)) continue;
        seen.add(sk);
        const d = g.dirs[e];
        const ed = net.edges[e];
        if ((!d.fwd && !d.back) || !g.main[ed.a] || !g.main[ed.b]) continue;
        const [y1, x1] = ed.pts[k - 1], [y2, x2] = ed.pts[k];
        const ax = (x1 - p.lon) * kx, ay = (y1 - p.lat) * ky, bx = (x2 - p.lon) * kx, by = (y2 - p.lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const u = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const dist = Math.hypot(ax + u * dx, ay + u * dy);
        if (dist <= MAX_SNAP_M && (!best || dist < best.dist)) {
          best = {
            edge: e, dist,
            offset: ed.cum[k - 1] + u * (ed.cum[k] - ed.cum[k - 1]),
            lat: y1 + u * (y2 - y1), lon: x1 + u * (x2 - x1),
          };
        }
      }
    }
    // この輪より外の格子は、見つけた道より必ず遠い
    if (best && best.dist < r * CELL * Math.min(kx, ky)) break;
  }
  return best;
}

/** 二分ヒープつきのダイクストラ法。吸着点 src から全点への距離（と、たどった辺）。 */
function dijkstra(net, g, src, withPred = false) {
  const dist = new Float64Array(net.n).fill(Infinity);
  const pred = withPred ? new Int32Array(net.n).fill(-1) : null;
  const heapN = [], heapD = [];
  const push = (v, d) => {
    let i = heapN.length;
    heapN.push(v); heapD.push(d);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= d) break;
      heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p;
    }
    heapN[i] = v; heapD[i] = d;
  };
  const pop = () => {
    const v = heapN[0], d = heapD[0];
    const lv = heapN.pop(), ld = heapD.pop();
    if (heapN.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heapN.length) break;
        if (c + 1 < heapN.length && heapD[c + 1] < heapD[c]) c++;
        if (heapD[c] >= ld) break;
        heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c;
      }
      heapN[i] = lv; heapD[i] = ld;
    }
    return [v, d];
  };
  const ed = net.edges[src.edge], d0 = g.dirs[src.edge];
  if (d0.fwd) { dist[ed.b] = ed.length - src.offset; push(ed.b, dist[ed.b]); if (pred) pred[ed.b] = -2; }
  if (d0.back && src.offset < dist[ed.a]) { dist[ed.a] = src.offset; push(ed.a, src.offset); if (pred) pred[ed.a] = -2; }
  while (heapN.length) {
    const [v, d] = pop();
    if (d > dist[v]) continue;
    for (let p = g.start[v]; p < g.start[v + 1]; p++) {
      const u = g.to[p], nd = d + g.w[p];
      if (nd < dist[u]) { dist[u] = nd; if (pred) pred[u] = p; push(u, nd); }
    }
  }
  return { dist, pred };
}

/** src から tgt（どちらも吸着点）までの距離と、どこから辺に入ったか。 */
function reach(net, g, src, tgt, dist) {
  const ed = net.edges[tgt.edge], d = g.dirs[tgt.edge];
  let best = Infinity, via = null;
  if (src.edge === tgt.edge) {
    if (tgt.offset >= src.offset && d.fwd) { best = tgt.offset - src.offset; via = "same"; }
    if (tgt.offset <= src.offset && d.back && src.offset - tgt.offset < best) { best = src.offset - tgt.offset; via = "same"; }
  }
  if (d.fwd && dist[ed.a] + tgt.offset < best) { best = dist[ed.a] + tgt.offset; via = "a"; }
  if (d.back && dist[ed.b] + ed.length - tgt.offset < best) { best = dist[ed.b] + ed.length - tgt.offset; via = "b"; }
  return { best, via };
}

/**
 * 点どうしの道に沿った距離の表（m）。行 i → 列 j。
 * 吸着できない点や、たどり着けない組は、直線距離 × fallbackFactor にする。
 * 返り値: { matrix: Float64Array(M*M), snaps, unsnapped: 添字の配列, unreachable: 組の数 }
 */
export function distanceMatrix(net, points, mode, fallbackFactor = 1.3) {
  const g = graphFor(net, mode);
  const M = points.length;
  const snaps = points.map((p) => snap(net, p, mode));
  const matrix = new Float64Array(M * M);
  let unreachable = 0;
  const straight = (i, j) => haversine(points[i].lat, points[i].lon, points[j].lat, points[j].lon) * fallbackFactor;
  for (let i = 0; i < M; i++) {
    const si = snaps[i];
    const run = si ? dijkstra(net, g, si) : null;
    for (let j = 0; j < M; j++) {
      if (i === j) continue;
      const sj = snaps[j];
      let d = Infinity;
      if (run && sj) {
        // 道に乗るまで・道から降りるまでの距離も足す
        d = reach(net, g, si, sj, run.dist).best + si.dist + sj.dist;
        if (d === Infinity) unreachable++;
      }
      matrix[i * M + j] = d === Infinity ? straight(i, j) : d;
    }
  }
  const unsnapped = snaps.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
  return { matrix, snaps, unsnapped, unreachable };
}

/** 辺の上で、a からの距離が from から to までの間にある形の点（進む向きの順）。 */
function between(ed, from, to) {
  const out = [];
  if (to >= from) { for (let k = 0; k < ed.pts.length; k++) if (ed.cum[k] > from && ed.cum[k] < to) out.push(ed.pts[k]); }
  else { for (let k = ed.pts.length - 1; k >= 0; k--) if (ed.cum[k] < from && ed.cum[k] > to) out.push(ed.pts[k]); }
  return out;
}

/**
 * 点の並び（吸着点つき）を、道に沿った線（[lat, lon] の並び）にする。
 * 吸着できない点との区間は、まっすぐ結ぶ。
 */
export function routePath(net, points, snaps, mode) {
  const g = graphFor(net, mode);
  const line = [[points[0].lat, points[0].lon]];
  for (let i = 1; i < points.length; i++) {
    const s = snaps[i - 1], t = snaps[i];
    if (s && t) {
      const { dist, pred } = dijkstra(net, g, s, true);
      const { best, via } = reach(net, g, s, t, dist);
      if (best < Infinity) {
        line.push([s.lat, s.lon]);
        if (via === "same") line.push(...between(net.edges[s.edge], s.offset, t.offset));
        else {
          const te = net.edges[t.edge];
          const enter = via === "a" ? te.a : te.b;
          // enter から逆にたどって、src の辺から出たところまで
          const arcs = [];
          let v = enter;
          while (pred[v] >= 0) { arcs.push(pred[v]); const ed = net.edges[g.arcEdge[pred[v]]]; v = ed.a === v ? ed.b : ed.a; }
          const se = net.edges[s.edge];
          line.push(...between(se, s.offset, v === se.b ? Infinity : -Infinity));
          for (let k = arcs.length - 1; k >= 0; k--) {
            const ed = net.edges[g.arcEdge[arcs[k]]];
            const forward = g.to[arcs[k]] === ed.b;
            const pts = forward ? ed.pts.slice(1) : ed.pts.slice(0, -1).reverse();
            line.push(...pts);
          }
          line.push(...between(te, via === "a" ? -Infinity : Infinity, t.offset));
        }
        line.push([t.lat, t.lon]);
      }
    }
    line.push([points[i].lat, points[i].lon]);
  }
  // 小数5桁（約1m）に丸めて、続けて同じ点は1つにする
  const out = [];
  for (const [la, lo] of line) {
    const p = [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5];
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

/** 点が多角形（[[lat, lon], ...] の輪の並び）の中にあるか。 */
export function insidePolygon(p, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
