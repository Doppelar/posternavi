// node --test test/ で実行する。点はすべて乱数で作った架空のもの。
import assert from "node:assert/strict";
import { test } from "node:test";
import { distance, planRoutes, rng, routeDistance } from "../js/tsp.js";

const randomPoints = (n, seed) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({ lat: 36.4 + r() * 0.1, lon: 139.0 + r() * 0.1 }));
};
const start = { lat: 36.45, lon: 139.05 };

/** すべての並びを試して最短を求める（小さい場合だけ）。 */
function bruteForce(home, stops, returnToStart) {
  let best = Infinity;
  const used = new Array(stops.length).fill(false);
  const walk = (cur, len, count) => {
    if (len >= best) return;
    if (count === stops.length) {
      best = Math.min(best, len + (returnToStart ? distance(cur, home) : 0));
      return;
    }
    for (let i = 0; i < stops.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      walk(stops[i], len + distance(cur, stops[i]), count + 1);
      used[i] = false;
    }
  };
  walk(home, 0, 0);
  return best;
}

const isPermutation = (orders, n) => {
  const all = orders.flat().sort((a, b) => a - b);
  return all.length === n && all.every((v, i) => v === i);
};

/** 参考にした掲示場巡回 PWA と同じ、最近傍法 + 2-opt（比べる相手）。 */
function nearestNeighbor2opt(home, stops) {
  const left = new Set(stops.keys());
  const order = [];
  let cur = home;
  while (left.size) {
    let best = -1, bd = Infinity;
    for (const i of left) { const d = distance(cur, stops[i]); if (d < bd) { bd = d; best = i; } }
    order.push(best); left.delete(best); cur = stops[best];
  }
  const pt = (i) => (i < 0 || i >= order.length ? home : stops[order[i]]);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
      const before = distance(pt(i - 1), pt(i)) + distance(pt(j), pt(j + 1));
      const after = distance(pt(i - 1), pt(j)) + distance(pt(i), pt(j + 1));
      if (after + 1e-9 < before) { order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse()); improved = true; }
    }
  }
  return routeDistance(home, order.map((i) => stops[i]));
}

test("掲示場がないときは空のルート", () => {
  assert.deepEqual(planRoutes(start, []).routes, []);
});

test("1か所なら往復", () => {
  const stops = [{ lat: 36.46, lon: 139.05 }];
  const { routes } = planRoutes(start, stops);
  assert.deepEqual(routes[0].order, [0]);
  assert.ok(Math.abs(routes[0].distance - 2 * distance(start, stops[0])) < 1e-6);
});

for (const returnToStart of [true, false]) {
  test(`8か所までは総当たりと同じ最短（${returnToStart ? "戻る" : "戻らない"}）`, () => {
    for (let seed = 1; seed <= 6; seed++) {
      const stops = randomPoints(3 + seed, seed);
      const { routes, exact } = planRoutes(start, stops, { returnToStart });
      assert.equal(exact, true);
      assert.ok(isPermutation(routes.map((r) => r.order), stops.length));
      const opt = bruteForce(start, stops, returnToStart);
      assert.ok(Math.abs(routes[0].distance - opt) < 1e-6, `seed ${seed}: ${routes[0].distance} vs ${opt}`);
      const along = routeDistance(start, routes[0].order.map((i) => stops[i]), returnToStart ? start : null);
      assert.ok(Math.abs(along - routes[0].distance) < 1e-6, "返した距離は並びどおりの距離");
    }
  });
}

test("近似（反復局所探索）でも、10か所なら厳密解と同じ長さになる", () => {
  for (let seed = 11; seed <= 15; seed++) {
    const stops = randomPoints(10, seed);
    for (const returnToStart of [true, false]) {
      const exact = planRoutes(start, stops, { returnToStart }).routes[0].distance;
      const heur = planRoutes(start, stops, { returnToStart, exactLimit: 0, maxKicks: 300, timeLimitMs: 5000 });
      assert.equal(heur.exact, false);
      assert.ok(Math.abs(heur.routes[0].distance - exact) < 1e-6, `seed ${seed}: ${heur.routes[0].distance} vs ${exact}`);
    }
  }
});

test("200か所: すべてを1回ずつ回り、最近傍法+2-opt より長くならない", () => {
  const stops = randomPoints(200, 7);
  const { routes } = planRoutes(start, stops, { maxKicks: 400, timeLimitMs: 10000 });
  assert.ok(isPermutation([routes[0].order], 200));
  const baseline = nearestNeighbor2opt(start, stops);
  assert.ok(routes[0].distance <= baseline + 1e-6, `${routes[0].distance} > ${baseline}`);
});

test("戻らないルートは、戻るルートより短いか同じ", () => {
  const stops = randomPoints(30, 3);
  const opts = { maxKicks: 200, timeLimitMs: 5000 };
  const back = planRoutes(start, stops, { ...opts, returnToStart: true }).routes[0].distance;
  const open = planRoutes(start, stops, { ...opts, returnToStart: false }).routes[0].distance;
  assert.ok(open <= back + 1e-6);
});

test("3人で分けると、全員で全部を1回ずつ回り、いちばん長い班が1人のときより短い", () => {
  const stops = randomPoints(60, 5);
  const opts = { maxKicks: 200, timeLimitMs: 5000 };
  const one = planRoutes(start, stops, opts).routes[0].distance;
  const { routes } = planRoutes(start, stops, { ...opts, teams: 3 });
  assert.equal(routes.length, 3);
  assert.ok(isPermutation(routes.map((r) => r.order), 60));
  assert.ok(routes.every((r) => r.order.length > 0));
  const longest = Math.max(...routes.map((r) => r.distance));
  assert.ok(longest < one, `${longest} >= ${one}`);
  for (const r of routes) {
    const along = routeDistance(start, r.order.map((i) => stops[i]));
    assert.ok(Math.abs(along - r.distance) < 1e-6);
  }
});

test("人数が掲示場より多いときは、掲示場の数までに減らす", () => {
  const stops = randomPoints(3, 9);
  const { routes } = planRoutes(start, stops, { teams: 5 });
  assert.equal(routes.length, 3);
  assert.ok(routes.every((r) => r.order.length === 1));
});

test("終点を別の地点にすると、その地点で終わる道のりになる", () => {
  const stops = randomPoints(9, 31);
  const end = { lat: 36.41, lon: 139.09 };
  const { routes } = planRoutes(start, stops, { end });
  let best = Infinity;
  const perm = (rest, cur, len) => {
    if (!rest.length) { best = Math.min(best, len + distance(cur, end)); return; }
    rest.forEach((p, i) => perm(rest.filter((_, j) => j !== i), p, len + distance(cur, p)));
  };
  perm(stops, start, 0);
  assert.ok(Math.abs(routes[0].distance - best) < 1e-6);
  assert.ok(Math.abs(routeDistance(start, routes[0].order.map((i) => stops[i]), end) - best) < 1e-6);
});

test("同じ seed なら同じ結果", () => {
  const stops = randomPoints(50, 21);
  const opts = { maxKicks: 100, timeLimitMs: 5000, seed: 3 };
  assert.deepEqual(planRoutes(start, stops, opts), planRoutes(start, stops, opts));
});

test("同じ場所に重なった掲示場があっても全部回る", () => {
  const p = { lat: 36.46, lon: 139.06 };
  const stops = [...Array(20)].map((_, i) => (i % 4 === 0 ? { ...p } : randomPoints(1, i + 40)[0]));
  const { routes } = planRoutes(start, stops, { maxKicks: 100 });
  assert.ok(isPermutation([routes[0].order], 20));
});

/** 距離の表（行 → 列）で、すべての並びを試して最短を求める。 */
function bruteForceMatrix(M, n, kind) {
  let best = Infinity;
  const used = new Array(n + 1).fill(false);
  const walk = (cur, len, count) => {
    if (count === n) {
      best = Math.min(best, len + (kind === "start" ? M[cur * (n + 1)] : 0));
      return;
    }
    for (let i = 1; i <= n; i++) {
      if (used[i]) continue;
      used[i] = true;
      walk(i, len + M[cur * (n + 1) + i], count + 1);
      used[i] = false;
    }
  };
  walk(0, 0, 0);
  return best;
}

/** 直線距離に、向きによって違う遠回りを足した表（一方通行のかわり）。 */
function asymmetricMatrix(points, seed) {
  const r = rng(seed);
  const M = points.length;
  const m = new Float64Array(M * M);
  for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) {
    if (i !== j) m[i * M + j] = distance(points[i], points[j]) * (1.1 + r() * 0.8);
  }
  return m;
}

test("向きで違う距離の表でも、8か所までは総当たりと同じ最短", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const stops = randomPoints(4 + seed % 4, seed + 50);
    const matrix = asymmetricMatrix([start, ...stops], seed);
    for (const returnToStart of [true, false]) {
      const { routes } = planRoutes(start, stops, { matrix, returnToStart });
      const opt = bruteForceMatrix(matrix, stops.length, returnToStart ? "start" : "free");
      assert.ok(Math.abs(routes[0].distance - opt) < 1e-6, `seed ${seed}: ${routes[0].distance} vs ${opt}`);
    }
  }
});

test("距離の表を使うと、返す道のりも一覧の順の道のりも表の値で数える", () => {
  const stops = randomPoints(40, 61);
  const matrix = asymmetricMatrix([start, ...stops], 7);
  const res = planRoutes(start, stops, { matrix, maxKicks: 200 });
  const M = stops.length + 1;
  const len = (order) => {
    let t = matrix[order[0] + 1], prev = order[0] + 1;
    for (const i of order.slice(1)) { t += matrix[prev * M + i + 1]; prev = i + 1; }
    return t + matrix[prev * M];
  };
  assert.ok(isPermutation([res.routes[0].order], 40));
  assert.ok(Math.abs(res.routes[0].distance - len(res.routes[0].order)) < 1e-6);
  assert.ok(Math.abs(res.listOrderDistance - len([...Array(40).keys()])) < 1e-6);
  assert.ok(res.routes[0].distance < res.listOrderDistance);
});

test("終点を別の地点にするときは、表の最後（n+1）を終点として使う", () => {
  const stops = randomPoints(6, 71);
  const end = { lat: 36.41, lon: 139.09 };
  const pts = [start, ...stops, end];
  const matrix = asymmetricMatrix(pts, 9);
  const { routes } = planRoutes(start, stops, { matrix, end });
  const M = pts.length;
  let best = Infinity;
  const perm = (rest, cur, len) => {
    if (!rest.length) { best = Math.min(best, len + matrix[cur * M + M - 1]); return; }
    rest.forEach((p, i) => perm(rest.filter((_, j) => j !== i), p, len + matrix[cur * M + p]));
  };
  perm([1, 2, 3, 4, 5, 6], 0, 0);
  assert.ok(Math.abs(routes[0].distance - best) < 1e-6);
});
