// node --test で実行する。データはすべて架空のもの。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROAD_FACTOR, estimateMinutes, formatDuration, formatRoadKm, remaining, routeText,
  stopCostMeters, teamColor, teamName,
} from "../js/plan.js";

test("所要時間 = 道のり（直線×係数）÷速さ + 作業時間", () => {
  // 徒歩 4km/h で直線 4km（道のり 5.2km）→ 78分、作業 3分×10か所 = 30分
  assert.equal(Math.round(estimateMinutes(4000, 10, "walking", 3)), 78 + 30);
  assert.equal(Math.round(estimateMinutes(12000 / ROAD_FACTOR, 0, "bicycling", 5)), 60);
  assert.equal(estimateMinutes(0, 4, "driving", 2), 8);
});

test("作業時間を距離に換算すると、同じ時間で進める直線距離になる", () => {
  for (const mode of ["walking", "bicycling", "driving"]) {
    const m = stopCostMeters(mode, 6);
    assert.ok(Math.abs(estimateMinutes(m, 0, mode, 0) - 6) < 1e-9);
  }
});

test("時間の表し方（5分単位）", () => {
  assert.equal(formatDuration(0), "約5分");
  assert.equal(formatDuration(42), "約40分");
  assert.equal(formatDuration(60), "約1時間");
  assert.equal(formatDuration(97), "約1時間35分");
});

test("道のりは直線距離の係数倍で表す", () => {
  assert.equal(formatRoadKm(10000), `約${(10 * ROAD_FACTOR).toFixed(1)}km`);
});

test("班の名前と色", () => {
  assert.equal(teamName(0, 1), "ルート");
  assert.equal(teamName(2, 4), "3班");
  const colors = new Set(Array.from({ length: 20 }, (_, i) => teamColor(i)));
  assert.equal(colors.size, 20);
});

test("まだ貼っていないものだけを順に返す", () => {
  assert.deepEqual(remaining(["a", "b", "c"], { b: 1 }), ["a", "c"]);
});

test("送る文字: 見出し・順番・地図のリンク、貼ったものには印", () => {
  const text = routeText({
    title: "1班",
    boards: [
      { number: "A-1", name: "見本1", address: "架空町1", lat: 36.1, lon: 139.1 },
      { number: "A-2", name: "見本2", address: "", lat: 36.2, lon: 139.2 },
    ],
    distance: 1000,
    minutes: 30,
    done: { "A-1": 1 },
  });
  const lines = text.split("\n");
  assert.match(lines[0], /^1班（2か所・約1\.3km・約30分）$/);
  assert.equal(lines[1], "✓ A-1 見本1（架空町1）");
  assert.equal(lines[2], "   https://www.google.com/maps/search/?api=1&query=36.1,139.1");
  assert.equal(lines[3], "2. A-2 見本2");
});
