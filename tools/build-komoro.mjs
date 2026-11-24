// 小諸市の道路網と市の境界（OpenStreetMap）を、アプリで使う形にする。
//   data/komoro.json          道路網（ルートの計算用。Web Worker が読む）
//   data/komoro-boundary.json 市の境界と中心（地図と、市の外かどうかの判定用）
//   data/komoro-places.json   駅・役所・学校・地区名など（出発地点・終点を名前で探す用）
//
//   node tools/build-komoro.mjs <roads.json> <boundary.json> [places.json]
//
// roads.json と boundary.json は Overpass API から取得したもの（下の QUERIES）。
// 道路データは © OpenStreetMap contributors、ODbL 1.0。できたファイルも ODbL で公開する。
import { readFileSync, writeFileSync } from "node:fs";

export const QUERIES = {
  // 小諸市（OSM relation 3594017）の範囲より約1km広い四角の道路
  roads: '[out:json][timeout:180][bbox:36.266,138.352,36.425,138.518];(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|track|road|pedestrian|footway|path|steps|cycleway|bridleway)$"];);out body;>;out skel qt;',
  boundary: "[out:json][timeout:100];rel(3594017);out geom;",
  places: '[out:json][timeout:120][bbox:36.266,138.352,36.425,138.518];(nwr["name"]["railway"~"^(station|halt)$"];nwr["name"]["public_transport"="station"];nwr["name"]["amenity"~"^(townhall|school|community_centre|library|post_office|hospital|clinic|police|fire_station|kindergarten|childcare|place_of_worship|parking|bus_station|social_facility|university|college|marketplace|fuel)$"];nwr["name"]["shop"~"^(supermarket|convenience|department_store|mall|doityourself|hardware)$"];nwr["name"]["leisure"~"^(park|sports_centre|stadium|pitch|playground)$"];nwr["name"]["tourism"];nwr["name"]["historic"];nwr["name"]["office"="government"];nwr["name"]["place"~"^(suburb|neighbourhood|quarter|village|hamlet|locality|isolated_dwelling)$"];nwr["name"]["highway"="bus_stop"];);out center tags;',
};

/** 場所の種類（表示名と、候補に出す順の優先度。小さいほど先）。 */
const KINDS = [
  [(t) => t.railway === "station" || t.railway === "halt" || t.public_transport === "station", "駅", 0],
  [(t) => t.amenity === "townhall" || t.office === "government", "役所", 1],
  [(t) => ["suburb", "neighbourhood", "quarter", "village", "hamlet", "locality", "isolated_dwelling"].includes(t.place), "地区", 2],
  [(t) => t.amenity === "community_centre", "公民館・集会所", 2],
  [(t) => ["school", "kindergarten", "childcare", "university", "college"].includes(t.amenity), "学校・園", 3],
  [(t) => ["library", "post_office", "hospital", "clinic", "police", "fire_station", "social_facility"].includes(t.amenity), "公共施設", 3],
  [(t) => t.leisure, "公園・運動施設", 4],
  [(t) => t.shop || t.amenity === "fuel" || t.amenity === "marketplace", "店", 5],
  [(t) => t.amenity === "parking" || t.amenity === "bus_station" || t.highway === "bus_stop", "駐車場・バス停", 5],
  [(t) => t.amenity === "place_of_worship", "寺社", 6],
  [(t) => t.tourism || t.historic, "名所", 6],
];

/** OpenStreetMap によみが入っていない、よく使う場所のよみ（ひらがなで探せるように）。 */
const READINGS = {
  小諸駅: "こもろえき", 乙女駅: "おとめえき", 三岡駅: "みつおかえき", 御代田駅: "みよたえき",
  小諸市役所: "こもろしやくしょ",
};

/** 名前のある場所を、[名前, 種類, 緯度, 経度, よみ] の並びにする（同じ名前・種類で300m以内のものは1つに）。 */
export function buildPlaces(places) {
  const out = [];
  for (const e of places.elements) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || !t.name) continue;
    const kind = KINDS.find(([test]) => test(t));
    if (!kind) continue;
    let name = t.name.trim();
    if (kind[1] === "駅" && !name.endsWith("駅")) name += "駅";
    const kana = t["name:ja-Hira"] || t["name:ja_kana"] || t["name:ja-Kana"] || READINGS[name] || "";
    const dup = out.find((p) => p[0] === name && p[1] === kind[1] && haversine([p[2], p[3]], [lat, lon]) < 300);
    if (dup) continue;
    out.push([name, kind[1], +lat.toFixed(5), +lon.toFixed(5), kana, kind[2]]);
  }
  out.sort((a, b) => a[5] - b[5] || a[0].localeCompare(b[0], "ja"));
  return out.map((p) => p.slice(0, 5));
}

const CAR_FWD = 1, CAR_BACK = 2, FOOT = 4, BIKE = 8;
const NO = new Set(["no", "private"]);
const YES = new Set(["yes", "designated", "permissive", "destination"]);
const NOT_FOR_CARS = new Set(["footway", "path", "steps", "pedestrian", "cycleway", "bridleway", "track"]);
const MOTORWAYS = new Set(["motorway", "motorway_link"]);

function haversine(a, b) {
  const r = 6371000, rad = Math.PI / 180;
  const dp = (b[0] - a[0]) * rad, dl = (b[1] - a[1]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 道（way）のタグから、車（向き）・徒歩・自転車で通れるかを決める。 */
export function wayFlags(t) {
  if (t.area === "yes" || t.highway === "construction") return 0;
  const hw = t.highway;
  const blocked = NO.has(t.access);
  let flags = 0;
  const foot = !MOTORWAYS.has(hw) && t.foot !== "no" && (!blocked || YES.has(t.foot));
  if (foot) flags |= FOOT;
  const bike = !MOTORWAYS.has(hw) && hw !== "steps" && t.bicycle !== "no" && (!blocked || YES.has(t.bicycle));
  if (bike) flags |= BIKE;
  const carTag = t.motor_vehicle ?? t.motorcar ?? t.vehicle;
  const car = (!NOT_FOR_CARS.has(hw) || YES.has(carTag)) && !NO.has(carTag) && (!blocked || YES.has(carTag));
  if (car) {
    let ow = t.oneway;
    if (ow == null && (MOTORWAYS.has(hw) || t.junction === "roundabout")) ow = "yes";
    if (ow === "-1") flags |= CAR_BACK;
    else if (ow === "yes" || ow === "true" || ow === "1") flags |= CAR_FWD;
    else flags |= CAR_FWD | CAR_BACK;
  }
  return flags;
}

/** Douglas-Peucker で点を間引く（tol はメートル）。 */
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const kx = Math.cos(pts[0][0] * Math.PI / 180) * 111320, ky = 110540;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const ax = pts[i][1] * kx, ay = pts[i][0] * ky, bx = pts[j][1] * kx, by = pts[j][0] * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][1] * kx, py = pts[k][0] * ky;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** 境界の外側の線（outer）をつないで輪にする。 */
function rings(boundary) {
  const rel = boundary.elements.find((e) => e.type === "relation");
  const parts = rel.members.filter((m) => m.type === "way" && m.role === "outer").map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const out = [];
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; !same(ring[0], ring[ring.length - 1]) && guard < 1000; guard++) {
      const end = ring[ring.length - 1];
      const i = parts.findIndex((p) => same(p[0], end) || same(p[p.length - 1], end));
      if (i < 0) throw new Error("境界の線がつながりません");
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(same(p[0], end) ? p.slice(1) : p.reverse().slice(1));
    }
    out.push(simplify(ring, 8));
  }
  return out;
}

export function build(roads, boundary) {
  const coord = new Map();
  for (const e of roads.elements) if (e.type === "node") coord.set(e.id, [e.lat, e.lon]);
  const ways = [];
  for (const e of roads.elements) {
    if (e.type !== "way") continue;
    const flags = wayFlags(e.tags || {});
    const nodes = e.nodes.filter((id) => coord.has(id));
    if (flags && nodes.length >= 2) ways.push({ nodes, flags });
  }
  // 交差点と道の端だけを点にする
  const uses = new Map();
  for (const w of ways) w.nodes.forEach((id, i) => {
    const end = i === 0 || i === w.nodes.length - 1;
    uses.set(id, (uses.get(id) || 0) + (end ? 2 : 1));
  });
  const isVertex = (id) => uses.get(id) >= 2;
  const edges = [];
  for (const w of ways) {
    let from = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isVertex(w.nodes[i]) && i < w.nodes.length - 1) continue;
      const ids = w.nodes.slice(from, i + 1);
      const pts = ids.map((id) => coord.get(id));
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += haversine(pts[k - 1], pts[k]);
      if (ids[0] !== ids[ids.length - 1] || len > 0) edges.push({ a: ids[0], b: ids[ids.length - 1], len, flags: w.flags, pts });
      from = i;
    }
  }
  // いちばん大きくつながった部分だけを残す（駐車場の中の道など、どこにもつながらない切れ端を除く）
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const e of edges) { if (!parent.has(e.a)) parent.set(e.a, e.a); if (!parent.has(e.b)) parent.set(e.b, e.b); }
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
  const size = new Map();
  for (const id of parent.keys()) { const r = find(id); size.set(r, (size.get(r) || 0) + 1); }
  const main = [...size.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const kept = edges.filter((e) => find(e.a) === main);
  // 点に番号をふり、座標は 1e-5 度（約1m）単位の差分で持つ
  const index = new Map();
  const nodeList = [];
  const q = (v) => Math.round(v * 1e5);
  const idOf = (id) => {
    if (!index.has(id)) { index.set(id, nodeList.length); nodeList.push(coord.get(id)); }
    return index.get(id);
  };
  const out = { a: [], b: [], len: [], f: [], g: [] };
  for (const e of kept) {
    out.a.push(idOf(e.a)); out.b.push(idOf(e.b));
    out.len.push(Math.max(1, Math.round(e.len * 10))); // 0.1m 単位
    out.f.push(e.flags);
    const mid = simplify(e.pts, 2).slice(1, -1);
    if (!mid.length) { out.g.push(0); continue; }
    const flat = [];
    let [plat, plon] = e.pts[0].map(q);
    for (const [lat, lon] of mid) { flat.push(q(lat) - plat, q(lon) - plon); plat = q(lat); plon = q(lon); }
    out.g.push(flat);
  }
  const nodes = [];
  let plat = 0, plon = 0;
  for (const [lat, lon] of nodeList) { nodes.push(q(lat) - plat, q(lon) - plon); plat = q(lat); plon = q(lon); }
  const attribution = "© OpenStreetMap contributors (ODbL)";
  const osmTimestamp = roads.osm3s?.timestamp_osm_base;
  return {
    roads: { v: 1, attribution, osmTimestamp, nodes, edges: out },
    boundary: {
      v: 1, name: "小諸市", attribution, osmTimestamp: boundary.osm3s?.timestamp_osm_base,
      rings: rings(boundary).map((r) => r.map(([lat, lon]) => [+lat.toFixed(5), +lon.toFixed(5)])),
    },
  };
}

if (process.argv[1]?.endsWith("build-komoro.mjs")) {
  const [roadsPath, boundaryPath, placesPath] = process.argv.slice(2);
  if (!roadsPath || !boundaryPath) {
    console.error(`使い方: node tools/build-komoro.mjs <roads.json> <boundary.json>\nOverpass API の問い合わせ:\n${JSON.stringify(QUERIES, null, 2)}`);
    process.exit(1);
  }
  const { roads, boundary } = build(JSON.parse(readFileSync(roadsPath, "utf8")), JSON.parse(readFileSync(boundaryPath, "utf8")));
  const json = JSON.stringify(roads);
  writeFileSync(new URL("../data/komoro.json", import.meta.url), json);
  writeFileSync(new URL("../data/komoro-boundary.json", import.meta.url), JSON.stringify(boundary));
  if (placesPath) {
    const places = buildPlaces(JSON.parse(readFileSync(placesPath, "utf8")));
    writeFileSync(new URL("../data/komoro-places.json", import.meta.url), JSON.stringify({ v: 1, attribution: "© OpenStreetMap contributors (ODbL)", places }));
    console.log(`places ${places.length}`);
  }
  console.log(`nodes ${roads.nodes.length / 2}, edges ${roads.edges.a.length}, ${(json.length / 1024).toFixed(0)}KB`);
}
