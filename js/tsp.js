// 巡回ルートの計算（巡回セールスマン問題）。ブラウザと Node の両方で動く。
//
// - 出発地 → 掲示場をすべて1回ずつ → 終点、の道のりを短くする。
//   終点は「出発地に戻る」か「どこで終えてもよい」。
// - 12か所以下は動的計画法（Held-Karp）で最短を厳密に求める。
// - それより多いときは、最近傍法で作った順を 2-opt と Or-opt で縮め、
//   反復局所探索（ダブルブリッジで崩して縮め直す）で時間の許すかぎり良くする。
// - 人数で分けるときは、全体の巡回順を作ってから、いちばん長い班が
//   最短になるように順番のまま切り分け（route-first, cluster-second）、班ごとに縮め直す。
//
// 距離は直線距離（大円距離）。実際の道のりではない。

export const EXACT_LIMIT = 12;
const EPS = 1e-7;

/** 2点の直線距離（メートル）。点は { lat, lon }。 */
export function distance(a, b) {
  const r = 6371000, rad = Math.PI / 180;
  const p1 = a.lat * rad, p2 = b.lat * rad, dp = p2 - p1, dl = (b.lon - a.lon) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 再現できる乱数（mulberry32）。 */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 距離の表を作る。添字 0 = 出発地、1..n = 掲示場、n+1 = 終点。
 * endKind: "start"（出発地に戻る）・"point"（endPoint で終わる）・"free"（どこで終えてもよい。
 * 全点への距離が 0 の仮の点を終点にする）。
 * matrix を渡すと、直線距離の代わりに使う（行 i → 列 j、添字 0..n。"point" のときは n+1 も）。
 * 返り値の D は探索用（向きで違う距離は往復の平均）、Dd は実際の向きの距離。
 */
function buildProblem(start, stops, endKind, endPoint, matrix) {
  const n = stops.length;
  const N = n + 2;
  const pts = [start, ...stops];
  const M = matrix ? Math.round(Math.sqrt(matrix.length)) : 0;
  const dd = matrix ? (i, j) => matrix[i * M + j] : (i, j) => distance(pts[i], pts[j]);
  const toEnd = (i) => {
    if (endKind === "free") return 0;
    if (endKind === "start") return i === 0 ? 0 : dd(i, 0);
    return matrix ? matrix[i * M + n + 1] : distance(pts[i], endPoint);
  };
  const Dd = new Float64Array(N * N);
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) if (i !== j) Dd[i * N + j] = dd(i, j);
    Dd[i * N + n + 1] = toEnd(i);
    Dd[(n + 1) * N + i] = Dd[i * N + n + 1];
  }
  return { N, D: matrix ? symmetrize(Dd, N, n) : Dd, Dd, s: 0, e: n + 1 };
}

/** 探索用に向きをそろえた表（中の点どうしは往復の平均、出発地との辺は出ていく向きの距離）。 */
function symmetrize(Dd, N, n) {
  const D = Dd.slice();
  for (let i = 1; i <= n; i++) {
    for (let j = i + 1; j <= n; j++) D[i * N + j] = D[j * N + i] = (Dd[i * N + j] + Dd[j * N + i]) / 2;
  }
  for (let j = 1; j <= n; j++) D[j * N] = Dd[j];
  return D;
}

/** 道順（ノードの並び）の長さ。 */
function pathLength(D, N, tour) {
  let t = 0;
  for (let i = 1; i < tour.length; i++) t += D[tour[i - 1] * N + tour[i]];
  return t;
}

/** 12か所以下: Held-Karp で s → interior すべて → e の最短を求める。 */
function solveExact(D, N, s, e, interior) {
  const k = interior.length;
  if (k === 0) return [];
  const full = (1 << k) - 1;
  const dp = new Float64Array((1 << k) * k).fill(Infinity);
  const parent = new Int8Array((1 << k) * k).fill(-1);
  for (let j = 0; j < k; j++) dp[(1 << j) * k + j] = D[s * N + interior[j]];
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < k; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * k + j];
      if (cur === Infinity) continue;
      for (let t = 0; t < k; t++) {
        if (mask & (1 << t)) continue;
        const nm = mask | (1 << t);
        const v = cur + D[interior[j] * N + interior[t]];
        if (v < dp[nm * k + t] - EPS) {
          dp[nm * k + t] = v;
          parent[nm * k + t] = j;
        }
      }
    }
  }
  let best = Infinity, last = -1;
  for (let j = 0; j < k; j++) {
    const v = dp[full * k + j] + D[interior[j] * N + e];
    if (v < best - EPS) { best = v; last = j; }
  }
  const order = [];
  let mask = full, j = last;
  while (j >= 0) {
    order.push(interior[j]);
    const p = parent[mask * k + j];
    mask &= ~(1 << j);
    j = p;
  }
  return order.reverse();
}

/** 各ノードの近い順の候補（自分と出発点・終点の写しは除かない）。 */
function neighborLists(D, N, nodes, K) {
  const lists = new Map();
  for (const a of nodes) {
    const others = nodes.filter((b) => b !== a);
    others.sort((x, y) => D[a * N + x] - D[a * N + y]);
    lists.set(a, others.slice(0, K));
  }
  return lists;
}

/**
 * 端を固定した道順 tour（tour[0] = s, tour[末尾] = e）を、2-opt と Or-opt で縮める。
 * 変わったところの周りだけを調べ直す（queue）。tour は書き換える。
 */
function localSearch(D, N, tour, neighbors, queueInit) {
  const m = tour.length;
  const pos = new Int32Array(N).fill(-1);
  for (let i = 0; i < m; i++) pos[tour[i]] = i;
  const d = (a, b) => D[a * N + b];
  const inQueue = new Uint8Array(N);
  const queue = [];
  const push = (v) => { if (v >= 0 && !inQueue[v]) { inQueue[v] = 1; queue.push(v); } };
  for (const v of queueInit) push(v);

  const reverse = (i, j) => { // tour[i..j] を逆順にする（1 <= i <= j <= m-2）
    while (i < j) {
      const a = tour[i], b = tour[j];
      tour[i] = b; tour[j] = a; pos[b] = i; pos[a] = j;
      i++; j--;
    }
  };
  const moveSegment = (i, L, k, flip) => { // tour[i..i+L-1] を tour[k] と tour[k+1] の間へ
    const seg = tour.slice(i, i + L);
    if (flip) seg.reverse();
    tour.splice(i, L);
    const at = k < i ? k + 1 : k + 1 - L;
    tour.splice(at, 0, ...seg);
    const lo = Math.min(i, at), hi = Math.max(i + L, at + L);
    for (let t = lo; t < hi; t++) pos[tour[t]] = t;
  };

  const improveNode = (a) => {
    const i = pos[a];
    const cand = neighbors.get(a) || [];
    // 2-opt（後ろの辺）: (a, b)(c, dn) → (a, c)(b, dn)
    if (i <= m - 2) {
      const b = tour[i + 1];
      const dab = d(a, b);
      for (const c of cand) {
        const dac = d(a, c);
        if (dac >= dab - EPS) break;
        const j = pos[c];
        if (j <= i + 1 || j > m - 2) continue;
        const dn = tour[j + 1];
        const gain = dab + d(c, dn) - dac - d(b, dn);
        if (gain > EPS) { reverse(i + 1, j); push(a); push(b); push(c); push(dn); return true; }
      }
    }
    // 2-opt（前の辺）: (b, a) と (dn, c) → (dn, b)(c, a)
    if (i >= 1) {
      const b = tour[i - 1];
      const dab = d(a, b);
      for (const c of cand) {
        const dac = d(a, c);
        if (dac >= dab - EPS) break;
        const j = pos[c];
        if (j < 1 || j >= i - 1) continue;
        const dn = tour[j - 1];
        const gain = d(dn, c) + dab - d(dn, b) - dac;
        if (gain > EPS) { reverse(j, i - 1); push(a); push(b); push(c); push(dn); return true; }
      }
    }
    // Or-opt: a から始まる長さ 1〜3 の区間を、近くの辺の間へ移す（向きはどちらでも）
    if (i >= 1 && i <= m - 2) {
      for (let L = 1; L <= 3; L++) {
        if (i + L - 1 > m - 2) break;
        const first = tour[i], last = tour[i + L - 1];
        const p = tour[i - 1], nx = tour[i + L];
        const removeGain = d(p, first) + d(last, nx) - d(p, nx);
        if (removeGain <= EPS) continue;
        for (const end of L === 1 ? [first] : [first, last]) {
          for (const c of neighbors.get(end) || []) {
            if (d(end, c) >= removeGain - EPS) break;
            const pc = pos[c];
            for (const k of [pc - 1, pc]) { // 辺 (tour[k], tour[k+1])
              if (k < 0 || k > m - 2 || (k >= i - 1 && k <= i + L - 1)) continue;
              const u = tour[k], v = tour[k + 1];
              const duv = d(u, v);
              const keep = d(u, first) + d(last, v) - duv;
              const flip = d(u, last) + d(first, v) - duv;
              const add = Math.min(keep, flip);
              if (removeGain - add > EPS) {
                moveSegment(i, L, k, flip < keep);
                push(p); push(nx); push(u); push(v); push(first); push(last);
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  };

  while (queue.length) {
    const a = queue.pop();
    inQueue[a] = 0;
    while (improveNode(a)) { /* a の周りで縮む限り続ける */ }
  }
}

/** 最近傍法: s から、まだ寄っていないいちばん近い点へ進む。 */
function nearestNeighbor(D, N, s, e, interior) {
  const left = new Set(interior);
  const tour = [s];
  let cur = s;
  while (left.size) {
    let best = -1, bestD = Infinity;
    for (const v of left) {
      const dv = D[cur * N + v];
      if (dv < bestD) { bestD = dv; best = v; }
    }
    tour.push(best); left.delete(best); cur = best;
  }
  tour.push(e);
  return tour;
}

/** ダブルブリッジ: 中の並びを3か所で切って A B C D → A C B D に組み替える。 */
function doubleBridge(tour, rand) {
  const k = tour.length - 2; // 中の点の数
  const cuts = [0, 0, 0].map(() => 1 + Math.floor(rand() * k)).sort((x, y) => x - y);
  const [p1, p2, p3] = cuts;
  if (p1 === p2 || p2 === p3) return { next: tour, touched: [] };
  const next = [
    ...tour.slice(0, p1), ...tour.slice(p2, p3), ...tour.slice(p1, p2), ...tour.slice(p3),
  ];
  const touched = [p1 - 1, p1, p2 - 1, p2, p3 - 1, p3].map((i) => tour[i]);
  return { next, touched };
}

/**
 * s → interior すべて → e の道順を求める。返り値は interior の並び（s と e を含まない）。
 * 厳密に解くときは向きつきの距離 Dd を使い、近似では向きをそろえた D を使う。
 * options: { timeLimitMs, maxKicks, seed, now, exactLimit }
 */
function solvePath(D, N, s, e, interior, options = {}, Dd = D) {
  const exactLimit = Math.min(options.exactLimit ?? EXACT_LIMIT, EXACT_LIMIT);
  if (interior.length <= exactLimit) return { order: solveExact(Dd, N, s, e, interior), exact: true };
  const { timeLimitMs = 1500, maxKicks = Infinity, seed = 1, now = () => Date.now() } = options;
  const nodes = [s, ...interior, e];
  const neighbors = neighborLists(D, N, nodes, Math.min(12, nodes.length - 1));
  let tour = nearestNeighbor(D, N, s, e, interior);
  localSearch(D, N, tour, neighbors, tour);
  let best = tour.slice(), bestLen = pathLength(D, N, tour);
  const rand = rng(seed);
  const deadline = now() + timeLimitMs;
  // 長いあいだ縮まらなければ、時間が残っていても止める
  const stallLimit = Math.max(1000, 20 * interior.length);
  let lastImproved = 0;
  for (let kick = 0; kick < maxKicks && kick - lastImproved < stallLimit && now() < deadline; kick++) {
    const { next, touched } = doubleBridge(best, rand);
    if (!touched.length) continue;
    tour = next;
    localSearch(D, N, tour, neighbors, touched);
    const len = pathLength(D, N, tour);
    if (len < bestLen - EPS) { best = tour; bestLen = len; lastImproved = kick; }
  }
  return { order: best.slice(1, -1), exact: false };
}

/**
 * 順番のまま teams 個に切り分け、いちばん重い班が最小になる切れ目を求める（動的計画法）。
 * order: 中の点の並び。返り値は区間 [from, to) の配列。
 */
function splitOrder(D, N, s, e, order, teams, stopCost) {
  const n = order.length;
  const k = Math.max(1, Math.min(teams, n));
  if (k === 1) return [[0, n]];
  const prefix = new Float64Array(n); // prefix[t] = order[0..t] の中の道のり
  for (let t = 1; t < n; t++) prefix[t] = prefix[t - 1] + D[order[t - 1] * N + order[t]];
  const cost = (i, j) => // order[i..j] を1班で回る重さ
    D[s * N + order[i]] + (prefix[j] - prefix[i]) + D[order[j] * N + e] + stopCost * (j - i + 1);
  let prev = new Float64Array(n).fill(Infinity);
  for (let j = 0; j < n; j++) prev[j] = cost(0, j);
  const cut = [];
  for (let c = 1; c < k; c++) {
    const cur = new Float64Array(n).fill(Infinity);
    const arg = new Int32Array(n).fill(-1);
    for (let j = c; j < n; j++) {
      for (let i = c; i <= j; i++) {
        const v = Math.max(prev[i - 1], cost(i, j));
        if (v < cur[j]) { cur[j] = v; arg[j] = i; }
      }
    }
    cut.push(arg);
    prev = cur;
  }
  const ranges = [];
  let to = n;
  for (let c = k - 1; c >= 1; c--) {
    const from = cut[c - 1][to - 1];
    ranges.push([from, to]);
    to = from;
  }
  ranges.push([0, to]);
  return ranges.reverse();
}

/**
 * ルートを求める。
 * start: { lat, lon }、stops: [{ lat, lon, ... }]
 * options:
 *   returnToStart (true)  出発地に戻るか
 *   end                   終点を出発地以外にするときの地点 { lat, lon }（null ならどこで終えてもよい）。
 *                         指定すると returnToStart より優先する
 *   matrix                道に沿った距離の表など（buildProblem を参照）。なければ直線距離
 *   teams (1)             何人（何班）で分けるか
 *   stopCost (0)          1か所あたりの作業を距離に換算した量（班の重さの釣り合いに使う）
 *   timeLimitMs, maxKicks, seed  計算の打ち切り
 * 返り値: { routes: [{ order: stops の添字の並び, distance }], exact, listOrderDistance（一覧の順に回った道のり） }
 */
export function planRoutes(start, stops, options = {}) {
  const { returnToStart = true, teams = 1, stopCost = 0 } = options;
  const endKind = options.end ? "point" : options.end === null || !returnToStart ? "free" : "start";
  const { matrix } = options;
  const n = stops.length;
  if (!n) return { routes: [], exact: true, listOrderDistance: 0 };
  const { N, D, Dd, s, e } = buildProblem(start, stops, endKind, options.end, matrix);
  const interior = Array.from({ length: n }, (_, i) => i + 1);
  const k = Math.max(1, Math.min(Math.floor(teams) || 1, n));
  // 分けるときは、出発地に戻る輪を作ってから切る（出発地のまわりを扇形に分けた形になる）
  const ringEnd = k > 1 ? buildProblem(start, stops, "start", null, matrix) : null;
  const whole = ringEnd
    ? solvePath(ringEnd.D, ringEnd.N, ringEnd.s, ringEnd.e, interior, options, ringEnd.Dd)
    : solvePath(D, N, s, e, interior, options, Dd);
  const groups = k > 1
    ? splitOrder(D, N, s, e, whole.order, k, stopCost).map(([from, to]) => whole.order.slice(from, to))
    : [whole.order];
  let exact = whole.exact && k === 1;
  const routes = groups.map((group, gi) => {
    const solved = k > 1
      ? solvePath(D, N, s, e, group, { ...options, timeLimitMs: (options.timeLimitMs ?? 1500) / k, seed: (options.seed ?? 1) + gi }, Dd)
      : { order: group };
    let order = solved.order;
    let len = pathLength(Dd, N, [s, ...order, e]);
    if (endKind === "start" && Dd !== D) { // 一方通行があると、逆回りのほうが短いことがある
      const rev = [...order].reverse();
      const revLen = pathLength(Dd, N, [s, ...rev, e]);
      if (revLen < len - EPS) { order = rev; len = revLen; }
    }
    return { order: order.map((v) => v - 1), distance: len };
  });
  return { routes, exact, listOrderDistance: pathLength(Dd, N, [s, ...interior, e]) };
}

/** 決まった順に回ったときの道のり。end は終点（null なら最後の掲示場で終わる）。 */
export function routeDistance(start, stops, end = start) {
  if (!stops.length) return 0;
  let t = distance(start, stops[0]);
  for (let i = 1; i < stops.length; i++) t += distance(stops[i - 1], stops[i]);
  return end ? t + distance(stops[stops.length - 1], end) : t;
}

/**
 * 点 s から stops（添字の並び）をすべて回って e で終わる順（e が null ならどこで終えてもよい）。
 * d(i, j) は点 i → j の距離。返り値は stops の添字の並び。
 */
function solveTeamOrder(d, s, e, stops, options) {
  const m = stops.length;
  if (!m) return [];
  const N = m + 2;
  const ids = [s, ...stops];
  const Dd = new Float64Array(N * N);
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= m; j++) if (i !== j) Dd[i * N + j] = d(ids[i], ids[j]);
    Dd[i * N + m + 1] = Dd[(m + 1) * N + i] = e == null ? 0 : d(ids[i], e);
  }
  const interior = Array.from({ length: m }, (_, i) => i + 1);
  let { order } = solvePath(symmetrize(Dd, N, m), N, 0, m + 1, interior, options, Dd);
  if (e === s) { // 出発地点に戻るときは、逆回りのほうが短ければそちら（一方通行があると違う）
    const rev = [...order].reverse();
    if (pathLength(Dd, N, [0, ...rev, m + 1]) < pathLength(Dd, N, [0, ...order, m + 1]) - EPS) order = rev;
  }
  return order.map((v) => ids[v]);
}

/**
 * 班ごとに出発地点・終点が違うときの班分け（multi-depot）。
 * n: 掲示場の数。d(i, j): 点 i → j の距離（0..n-1 が掲示場、n 以降が班の出発地点・終点）。
 * depots: 班ごとの { s, e }（点の添字。e が null ならどこで終えてもよい）。
 * いちばん重い班（移動 + stopCost × 寄る数）ができるだけ軽くなるように分ける。
 *  1. 今いちばん軽い班が、自分のルートにいちばん安く足せる掲示場を取る、を繰り返す
 *  2. 班ごとに順番を縮める
 *  3. いちばん重い班の掲示場を、ほかの班へ移すと重さの最大が下がるなら移す、を繰り返す
 * 返り値: { routes: [{ order: 掲示場の添字の並び, distance }], exact: false }
 */
export function planMultiDepot(n, d, depots, options = {}) {
  const { stopCost = 0, timeLimitMs = 2500, now = () => Date.now() } = options;
  const k = depots.length;
  const deadline = now() + timeLimitMs;
  const travel = (t, order) => {
    if (!order.length) return 0;
    const { s, e } = depots[t];
    let c = d(s, order[0]);
    for (let i = 1; i < order.length; i++) c += d(order[i - 1], order[i]);
    return c + (e == null ? 0 : d(order[order.length - 1], e));
  };
  const weight = (t, order) => travel(t, order) + stopCost * order.length;
  // 班 t の順 order の位置 p（0..length）に v を入れたときに増える距離
  const insertCost = (t, order, v, p) => {
    const { s, e } = depots[t];
    const prev = p === 0 ? s : order[p - 1];
    const next = p === order.length ? e : order[p];
    if (next == null) return d(prev, v);
    return d(prev, v) + d(v, next) - d(prev, next);
  };
  const bestInsert = (t, order, v) => {
    let best = Infinity, pos = 0;
    for (let p = 0; p <= order.length; p++) {
      const c = insertCost(t, order, v, p);
      if (c < best) { best = c; pos = p; }
    }
    return { cost: best, pos };
  };

  // 1. いちばん軽い班から、安く足せる掲示場を取る
  const routes = depots.map(() => []);
  const load = new Array(k).fill(0);
  const left = new Set(Array.from({ length: n }, (_, i) => i));
  while (left.size) {
    let t = 0;
    for (let i = 1; i < k; i++) if (load[i] < load[t]) t = i;
    let pick = -1, ins = null;
    for (const v of left) {
      const b = bestInsert(t, routes[t], v);
      if (!ins || b.cost < ins.cost) { ins = b; pick = v; }
    }
    routes[t].splice(ins.pos, 0, pick);
    load[t] += ins.cost + stopCost;
    left.delete(pick);
  }

  // 2. 班ごとに順番を縮める
  const teamOpts = (ms) => ({ ...options, timeLimitMs: ms });
  const share = Math.max(50, timeLimitMs / (3 * k));
  for (let t = 0; t < k; t++) routes[t] = solveTeamOrder(d, depots[t].s, depots[t].e, routes[t], teamOpts(share));

  // 3. いちばん重い班から、掲示場を移す
  for (let guard = 0; guard < 20 * n && now() < deadline; guard++) {
    const w = routes.map((r, t) => weight(t, r));
    let L = 0;
    for (let t = 1; t < k; t++) if (w[t] > w[L]) L = t;
    let best = null;
    routes[L].forEach((v, p) => {
      const without = routes[L].filter((_, q) => q !== p);
      const wl = weight(L, without);
      for (let t = 0; t < k; t++) {
        if (t === L) continue;
        const b = bestInsert(t, routes[t], v);
        const wt = w[t] + b.cost + stopCost;
        const worst = Math.max(wl, wt);
        if (worst < w[L] - EPS && (!best || worst < best.worst)) best = { worst, v, p, t, pos: b.pos };
      }
    });
    if (!best) break;
    routes[L].splice(best.p, 1);
    routes[best.t].splice(best.pos, 0, best.v);
    const ms = Math.max(30, Math.min(300, deadline - now()) / 2);
    routes[L] = solveTeamOrder(d, depots[L].s, depots[L].e, routes[L], teamOpts(ms));
    routes[best.t] = solveTeamOrder(d, depots[best.t].s, depots[best.t].e, routes[best.t], teamOpts(ms));
  }
  return { routes: routes.map((order, t) => ({ order, distance: travel(t, order) })), exact: false };
}
