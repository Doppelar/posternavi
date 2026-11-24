// 出発地点・終点を名前で探す（ブラウザと Node の両方で動く）。
// - 同梱の小諸市の場所の一覧（駅・役所・学校・地区名など）と、読み込んだ掲示場から探す。
// - 住所は国土地理院の住所検索（https://msearch.gsi.go.jp/address-search/AddressSearch）の結果を整える。

export const MAX_RESULTS = 8;

/** 比べやすい形にする（全角・半角をそろえ、空白を除き、カタカナをひらがなにする）。 */
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * places: [[名前, 種類, 緯度, 経度, よみ], ...]、boards: 掲示場の一覧。
 * 名前が同じ > 名前が始まる > 名前に含む の順、同じなら一覧の順（駅・役所が先）。
 * 返り値: [{ name, kind, lat, lon }]
 */
export function searchPlaces(query, places, boards = []) {
  const q = normalize(query);
  if (!q) return [];
  const scored = [];
  const score = (name, kana) => {
    const n = normalize(name), k = normalize(kana);
    if (n === q) return 0;
    if (n.startsWith(q) || (k && k.startsWith(q))) return 1;
    if (n.includes(q) || (k && k.includes(q))) return 2;
    // 「小諸駅前」のように、探す言葉のほうが長いときは、場所の名前で始まるものを拾う
    if (n.length >= 2 && q.startsWith(n)) return 3;
    return -1;
  };
  places.forEach(([name, kind, lat, lon, kana], i) => {
    const s = score(name, kana);
    if (s >= 0) scored.push({ s, i, item: { name, kind, lat, lon } });
  });
  boards.forEach((b, i) => {
    // 名前を伏せた掲示場（"masked"）は、番号と住所で表す
    const named = b.name && b.name !== "masked";
    const hits = [b.number, named ? b.name : "", b.address].map((v) => (v ? score(v, "") : -1)).filter((v) => v >= 0);
    if (!hits.length) return;
    const label = `${b.number} ${named ? b.name : b.address || ""}`.trim();
    scored.push({ s: Math.min(...hits) + 0.5, i: places.length + i, item: { name: label, kind: "掲示場", lat: b.lat, lon: b.lon } });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  // 同じ名前（駅とバス停の「小諸駅」など）は、先に出るほうだけにする
  const seen = new Set();
  return scored.filter((x) => !seen.has(x.item.name) && seen.add(x.item.name)).slice(0, MAX_RESULTS).map((x) => x.item);
}

/** 住所検索の問い合わせ URL。市の名前がなければ「長野県小諸市」を前に付ける。 */
export function addressSearchUrl(query, city = "長野県小諸市") {
  const q = String(query).trim();
  const full = q.includes(city.replace(/^長野県/, "")) ? q : `${city}${q}`;
  return `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(full)}`;
}

/** 住所検索の結果（GeoJSON の Feature の並び）を、範囲 inside の中のものだけにする。 */
export function parseAddressResults(json, inside = () => true) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const f of json) {
    const [lon, lat] = f?.geometry?.coordinates || [];
    const title = f?.properties?.title;
    if (typeof lat !== "number" || typeof lon !== "number" || !title) continue;
    if (!inside({ lat, lon })) continue;
    out.push({ name: title.replace(/^長野県/, ""), kind: "住所", lat, lon });
    if (out.length >= 5) break;
  }
  return out;
}
