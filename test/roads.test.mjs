// node --test で実行する。小さな架空の道路網と、同梱の小諸市の道路網で確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAR_BACK, CAR_FWD, FOOT, BIKE, distanceMatrix, insidePolygon, loadNetwork, routePath, snap } from "../js/roads.js";
import { distance } from "../js/tsp.js";

const ALL = CAR_FWD | CAR_BACK | FOOT | BIKE;

/** 点と辺から、tools/build-komoro.mjs と同じ形のデータを作る。 */
function makeData(points, edges) {
  const q = (v) => Math.round(v * 1e5);
  const nodes = [];
  let pl = 0, po = 0;
  for (const [lat, lon] of points) { nodes.push(q(lat) - pl, q(lon) - po); pl = q(lat); po = q(lon); }
  const out = { a: [], b: [], len: [], f: [], g: [] };
  for (const [a, b, f] of edges) {
    out.a.push(a); out.b.push(b); out.f.push(f); out.g.push(0);
    const d = distance({ lat: points[a][0], lon: points[a][1] }, { lat: points[b][0], lon: points[b][1] });
    out.len.push(Math.round(d * 10));
  }
  return { nodes, edges: out };
}

// 約1km四方の四角い道（0-1-2-3-0）。上の辺 1→2 は車だけ一方通行（1 から 2 へ）。
const P = [[36.0, 138.0], [36.009, 138.0], [36.009, 138.011], [36.0, 138.011]];
const square = () => loadNetwork(makeData(P, [
  [0, 1, ALL],
  [1, 2, CAR_FWD | FOOT | BIKE],
  [2, 3, ALL],
  [3, 0, ALL],
]));
const side = (a, b) => distance({ lat: P[a][0], lon: P[a][1] }, { lat: P[b][0], lon: P[b][1] });

test("いちばん近い道の上の点に吸着させる", () => {
  const net = square();
  const s = snap(net, { lat: 36.0045, lon: 137.9999 }, "walking"); // 0-1 の辺の真ん中の、少し西
  assert.equal(s.edge, 0);
  assert.ok(Math.abs(s.offset - side(0, 1) / 2) < 2);
  assert.ok(s.dist > 5 && s.dist < 15);
  assert.equal(snap(net, { lat: 36.1, lon: 138.1 }, "walking"), null, "400m より離れていれば吸着しない");
});

test("徒歩は行きと帰りが同じ。距離は道に沿った最短（角を回る）", () => {
  const net = square();
  const pts = [{ lat: 36.0045, lon: 138.0 }, { lat: 36.009, lon: 138.0055 }]; // 左の辺の中央、上の辺の中央
  const { matrix, unsnapped } = distanceMatrix(net, pts, "walking");
  assert.deepEqual(unsnapped, []);
  const expect = side(0, 1) / 2 + side(1, 2) / 2;
  assert.ok(Math.abs(matrix[1] - expect) < 2, `${matrix[1]} vs ${expect}`);
  assert.ok(Math.abs(matrix[2] - matrix[1]) < 1e-6);
  assert.ok(matrix[1] > distance(pts[0], pts[1]), "道に沿った距離は直線より長い");
});

test("車は一方通行を守るので、帰りは遠回りになる", () => {
  const net = square();
  const pts = [{ lat: 36.009, lon: 138.002 }, { lat: 36.009, lon: 138.009 }]; // 上の辺の左寄り → 右寄り
  const { matrix } = distanceMatrix(net, pts, "driving");
  const top = side(1, 2);
  const along = distance({ lat: 36.009, lon: 138.002 }, { lat: 36.009, lon: 138.009 });
  assert.ok(Math.abs(matrix[1] - along) < 2, "行き（一方通行の向き）はまっすぐ");
  const around = top - along + side(2, 3) + side(3, 0) + side(0, 1);
  assert.ok(Math.abs(matrix[2] - around) < 3, `帰りはぐるっと回る: ${matrix[2]} vs ${around}`);
  const walk = distanceMatrix(net, pts, "walking").matrix;
  assert.ok(Math.abs(walk[2] - along) < 2, "徒歩なら帰りもまっすぐ");
});

test("車で一方通行の行き止まりにしか行けない点は、そこに吸着させない", () => {
  // 0-1 の両方向の道と、1 → 2 だけの行き止まり。2 のそばの点は 0-1 に吸着させる
  const pts = [[36.0, 138.0], [36.002, 138.0], [36.002, 138.002]];
  const net = loadNetwork(makeData(pts, [[0, 1, ALL], [1, 2, CAR_FWD | FOOT]]));
  const s = snap(net, { lat: 36.002, lon: 138.0019 }, "driving");
  assert.equal(s.edge, 0);
  assert.equal(snap(net, { lat: 36.002, lon: 138.0019 }, "walking").edge, 1);
});

test("道に沿った線は、出発点から交差点を通って行き先まで続く", () => {
  const net = square();
  const pts = [{ lat: 36.0045, lon: 138.0 }, { lat: 36.009, lon: 138.0055 }];
  const { snaps } = distanceMatrix(net, pts, "walking");
  const line = routePath(net, pts, snaps, "walking");
  assert.deepEqual(line[0], [36.0045, 138.0]);
  assert.deepEqual(line[line.length - 1], [36.009, 138.0055]);
  assert.ok(line.some(([la, lo]) => la === 36.009 && lo === 138.0), "角（点1）を通る");
});

test("多角形の中かどうか", () => {
  const ring = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.equal(insidePolygon({ lat: 5, lon: 5 }, [ring]), true);
  assert.equal(insidePolygon({ lat: 11, lon: 5 }, [ring]), false);
});

test("小諸市の道路網: 読み込めて、市内の2点が道でつながる", () => {
  const net = loadNetwork(JSON.parse(readFileSync(new URL("../data/komoro.json", import.meta.url), "utf8")));
  const boundary = JSON.parse(readFileSync(new URL("../data/komoro-boundary.json", import.meta.url), "utf8"));
  // 小諸駅のあたりと、市の東のあたり（どちらも市内）
  const pts = [{ lat: 36.3270, lon: 138.4250 }, { lat: 36.3330, lon: 138.4700 }];
  assert.ok(pts.every((p) => insidePolygon(p, boundary.rings)));
  for (const mode of ["walking", "bicycling", "driving"]) {
    const { matrix, unsnapped, unreachable } = distanceMatrix(net, pts, mode);
    assert.deepEqual(unsnapped, []);
    assert.equal(unreachable, 0);
    const straight = distance(pts[0], pts[1]);
    assert.ok(matrix[1] > straight && matrix[1] < straight * 2.5, `${mode}: ${matrix[1]} / ${straight}`);
  }
});
