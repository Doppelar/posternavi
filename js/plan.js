// 所要時間の見積もり・表示用の文字・班の色など（画面に依存しない部分）。

/** 移動手段。速さは信号や駐車も含めたおおよその平均。 */
export const MODES = {
  walking: { label: "徒歩", kmh: 4 },
  bicycling: { label: "自転車", kmh: 12 },
  driving: { label: "車", kmh: 20 },
};

/**
 * 直線距離から道のりを見積もる係数（道は直線より長い）。道に沿って計算したときは 1 を使う。
 * 小諸市の道路網で確かめると、道に沿った距離は直線の平均1.4倍ほどだった。
 */
export const ROAD_FACTOR = 1.3;

export const MAX_TEAMS = 20;

/** 距離（m）と寄る数から、所要時間（分）の目安を出す。factor は距離に掛ける係数。 */
export function estimateMinutes(distanceM, stopCount, mode, workMin, factor = ROAD_FACTOR) {
  const kmh = MODES[mode]?.kmh ?? MODES.walking.kmh;
  return (distanceM * factor) / 1000 / kmh * 60 + stopCount * workMin;
}

/** 1か所の作業時間を、同じ時間で進める距離（m、係数を掛ける前）に換算する。班の釣り合いに使う。 */
export function stopCostMeters(mode, workMin, factor = ROAD_FACTOR) {
  const kmh = MODES[mode]?.kmh ?? MODES.walking.kmh;
  return (workMin / 60) * kmh * 1000 / factor;
}

export function formatDuration(min) {
  const m = Math.max(0, Math.round(min / 5) * 5);
  if (m < 60) return `約${Math.max(5, m)}分`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `約${h}時間${r}分` : `約${h}時間`;
}

/** 距離（m）を、道のり（km）として表す。 */
export function formatRoadKm(distanceM, factor = ROAD_FACTOR) {
  return `約${((distanceM * factor) / 1000).toFixed(1)}km`;
}

const COLORS = ["#145DA0", "#C2185B", "#2E7D32", "#E65100", "#6A1B9A", "#00838F", "#AD1457", "#5D4037"];
export function teamColor(i) {
  return i < COLORS.length ? COLORS[i] : `hsl(${(i * 47) % 360} 65% 38%)`;
}

export function teamName(i, total) {
  return total > 1 ? `${i + 1}班` : "ルート";
}

/** 班のルートを、メッセージで送れる文字にする。 */
export function routeText({ title, boards, distance, minutes, done = {}, factor = ROAD_FACTOR }) {
  const lines = [`${title}（${boards.length}か所・${formatRoadKm(distance, factor)}・${formatDuration(minutes)}）`];
  boards.forEach((b, i) => {
    const place = b.address ? `（${b.address}）` : "";
    lines.push(`${done[b.number] ? "✓" : `${i + 1}.`} ${b.number} ${b.name}${place}`);
    lines.push(`   https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lon}`);
  });
  return lines.join("\n");
}

/** 並び numbers のうち、まだ貼っていないものを順に返す。 */
export function remaining(numbers, done) {
  return numbers.filter((n) => !done[n]);
}
