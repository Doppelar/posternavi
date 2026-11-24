// ルートの計算の入口（Web Worker からも、画面の中からも使う）。
// 道に沿って計算するときは、小諸市の道路網を読み込み、道に沿った距離の表でルートを解き、
// 地図に描く道に沿った線も作る。
import { ROAD_FACTOR } from "./plan.js";
import { distanceMatrix, loadNetwork, routePath } from "./roads.js";
import { planRoutes } from "./tsp.js";

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

export async function solve({ start, stops, options, roads, mode }) {
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
