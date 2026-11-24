// node --test で実行する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addressSearchUrl, normalize, parseAddressResults, searchPlaces } from "../js/places.js";

const places = [
  ["小諸駅", "駅", 36.327, 138.4217, ""],
  ["東小諸駅", "駅", 36.317, 138.4323, "ひがしこもろ"],
  ["小諸市役所", "役所", 36.3274, 138.4256, ""],
  ["小諸公民館", "公民館・集会所", 36.33, 138.43, ""],
];

test("全角・半角、カタカナ・ひらがな、空白の違いをそろえる", () => {
  assert.equal(normalize("ｺﾓﾛ　エキ"), "こもろえき");
  assert.equal(normalize("ＡＢＣ"), "abc");
});

test("名前が同じものを先に、次に名前で始まるもの、名前に含むもの", () => {
  assert.deepEqual(searchPlaces("小諸駅", places).map((p) => p.name), ["小諸駅", "東小諸駅"]);
  assert.deepEqual(searchPlaces("小諸", places).map((p) => p.name), ["小諸駅", "小諸市役所", "小諸公民館", "東小諸駅"]);
});

test("よみでも探せる", () => {
  assert.deepEqual(searchPlaces("ひがし", places).map((p) => p.name), ["東小諸駅"]);
  assert.deepEqual(searchPlaces("ヒガシコモロ", places).map((p) => p.name), ["東小諸駅"]);
});

test("探す言葉が長いとき（小諸駅前）は、名前で始まる場所を拾う", () => {
  assert.equal(searchPlaces("小諸駅前", places)[0].name, "小諸駅");
});

test("掲示場の番号・名前・住所でも探せる。名前を伏せた掲示場は住所で表す", () => {
  const boards = [
    { number: "21-6", name: "旧農協出荷所", address: "滋野甲3076-15", lat: 36.35, lon: 138.38 },
    { number: "11-9", name: "masked", address: "滝原991-1", lat: 36.36, lon: 138.41 },
  ];
  assert.deepEqual(searchPlaces("農協", places, boards), [{ name: "21-6 旧農協出荷所", kind: "掲示場", lat: 36.35, lon: 138.38 }]);
  assert.equal(searchPlaces("滝原", places, boards)[0].name, "11-9 滝原991-1");
  assert.equal(searchPlaces("masked", places, boards).length, 0);
});

test("同じ名前は、先に出るほう（一覧の順で前のもの）だけにする", () => {
  const withBus = [...places, ["小諸駅", "駐車場・バス停", 36.3268, 138.4219, ""]];
  const hits = searchPlaces("小諸駅", withBus);
  assert.equal(hits.filter((p) => p.name === "小諸駅").length, 1);
  assert.equal(hits[0].kind, "駅");
});

test("空の言葉では何も返さない。多くても8件まで", () => {
  assert.deepEqual(searchPlaces("  ", places), []);
  const many = Array.from({ length: 20 }, (_, i) => [`小諸${i}`, "名所", 36.3, 138.4, ""]);
  assert.equal(searchPlaces("小諸", many).length, 8);
});

test("住所検索の URL には市の名前を付ける", () => {
  assert.ok(decodeURIComponent(addressSearchUrl("相生町3-3-3")).endsWith("q=長野県小諸市相生町3-3-3"));
  assert.ok(decodeURIComponent(addressSearchUrl("小諸市相生町")).endsWith("q=小諸市相生町"));
});

test("住所検索の結果は、範囲の中のものを5件まで", () => {
  const f = (title, lon, lat) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { title } });
  const json = [f("長野県小諸市相生町三丁目", 138.4256, 36.3274), f("長野県佐久市", 138.47, 36.24), { bad: 1 }];
  const inKomoro = (p) => p.lat > 36.27;
  assert.deepEqual(parseAddressResults(json, inKomoro), [{ name: "小諸市相生町三丁目", kind: "住所", lat: 36.3274, lon: 138.4256 }]);
  assert.deepEqual(parseAddressResults({ error: "x" }), []);
});

test("同梱の小諸市の場所の一覧に、小諸駅がある", () => {
  const data = JSON.parse(readFileSync(new URL("../data/komoro-places.json", import.meta.url), "utf8"));
  const hit = searchPlaces("小諸駅", data.places)[0];
  assert.equal(hit.name, "小諸駅");
  assert.equal(hit.kind, "駅");
});
