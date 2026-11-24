// ルートの計算の入口（Web Worker からも、画面の中からも使う）。
// 道に沿って計算するときは、小諸市の道路網を読み込み、道に沿った距離の表でルートを解き、
// 地図に描く道に沿った線も作る。
import { ROAD_FACTOR } from "./plan.js";
import { distanceMatrix, loadNetwork, routePath } from "./roads.js";
import { distance, planMultiDepot, planRoutes } from "./tsp.js";

let network = null;
function loadRoads() {
  network ??= fetch(new URL("../data/komoro.json", import.meta.url))
    .then((res) => {
      if (!res.ok) throw new Error("道路データを読めませんでした");
      return res.json();
    })
    .then(loadNetwork)
    .catch((err) => { network = null; throw err; });
  return network;
}

/**
 * request: { start, stops, options, roads, mode }
 * options.teamDepots（[{ start, end }]、end が null ならどこで終えてもよい）があれば、
 * 班ごとに出発地点・終点を変えて分ける。
 */
export async function solve(request) {
  if (request.options?.teamDepots) return solveTeams(request);
  const { start, stops, options, roads, mode } = request;
  if (!roads) return planRoutes(start, stops, options);
  const net = await loadRoads();
  const pts = [start, ...stops, ...(options.end ? [options.end] : [])];
  const { matrix, snaps, unsnapped } = distanceMatrix(net, pts, mode, ROAD_FACTOR);
  const result = planRoutes(start, stops, { ...options, matrix });
  // 終点の添字（planRoutes と同じ決め方）
  const endIndex = options.end ? pts.length - 1 : options.end === null || options.returnToStart === false ? null : 0;
  for (const r of result.routes) {
    const idx = [0, ...r.order.map((i) => i + 1), ...(endIndex == null ? [] : [endIndex])];
    r.path = routePath(net, idx.map((i) => pts[i]), idx.map((i) => snaps[i]), mode);
  }
  result.unsnapped = unsnapped.filter((i) => i >= 1 && i <= stops.length).map((i) => i - 1);
  result.startUnsnapped = unsnapped.includes(0);
  return result;
}

/** 班ごとに出発地点・終点が違うとき。点の並びは [掲示場..., 班の出発地点・終点...]。 */
async function solveTeams({ stops, options, roads, mode }) {
  const n = stops.length;
  const pts = [...stops];
  const indexOf = new Map(); // 同じ地点は1つの点にまとめる
  const add = (p) => {
    const key = `${p.lat},${p.lon}`;
    if (!indexOf.has(key)) { indexOf.set(key, pts.length); pts.push(p); }
    return indexOf.get(key);
  };
  const depots = options.teamDepots.map(({ start, end }) => ({ s: add(start), e: end ? add(end) : null }));
  let d, net = null, snaps = null, unsnapped = [];
  if (roads) {
    net = await loadRoads();
    const m = distanceMatrix(net, pts, mode, ROAD_FACTOR);
    const M = pts.length;
    d = (i, j) => (i === j ? 0 : m.matrix[i * M + j]);
    snaps = m.snaps;
    unsnapped = m.unsnapped;
  } else {
    d = (i, j) => distance(pts[i], pts[j]);
  }
  const result = planMultiDepot(n, d, depots, options);
  result.routes.forEach((r, t) => {
    if (!net) return;
    const { s, e } = depots[t];
    const idx = [s, ...r.order, ...(e == null ? [] : [e])];
    r.path = routePath(net, idx.map((i) => pts[i]), idx.map((i) => snaps[i]), mode);
  });
  result.unsnapped = unsnapped.filter((i) => i < n);
  result.startUnsnapped = depots.some(({ s }) => unsnapped.includes(s));
  return result;
}
