// 画面（準備・ルート・班ごとの巡回・地図・CSV の取り込み）。
import * as C from "./core.js";
import { addressSearchUrl, parseAddressResults, searchPlaces } from "./places.js";
import { insidePolygon } from "./roads.js";
import {
  MAX_TEAMS, MODES, ROAD_FACTOR, estimateMinutes, formatDuration, formatRoadKm, remaining, routeText,
  stopCostMeters, teamColor, teamName,
} from "./plan.js";
import { clear, load, save } from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DEFAULT_SETTINGS = { mode: "walking", workMin: 3, teams: 1, returnToStart: true, endFixed: false, skipDone: true, roads: true };
const CITY = { name: "小諸市", center: [36.3275, 138.4256], zoom: 13 };
const SAMPLE_START = { lat: 36.32653, lon: 138.42554, label: "見本の出発地点" };
const BUSY_TEXT = "ルートを計算しています…";

const saved = load() || {};
const state = {
  list: saved.list || null, // { name, boards: [{ number, name, address, lat, lon }] }
  start: saved.start || null, // { lat, lon, label }
  end: saved.end || null, // 終点（出発地点に戻らず、終点を決めるとき）
  settings: { ...DEFAULT_SETTINGS, ...saved.settings },
  // { routes: [{ numbers, distance, path, fromHere }], start, end, mode, workMin, returnToStart, roads, exact, baseline, unsnapped }
  plan: saved.plan || null,
  done: saved.done || {}, // 番号 → 貼った時刻
  team: saved.team || 0,
};
let view = state.plan ? "plan" : "setup";
let importDraft = null; // { name, table, mapping }
let importReport = null; // { count, issues, outsideJapan }
let pickPoint = null;
let pickTarget = "start"; // 地図で選ぶ地点（"start" か "end"）
let places = []; // 小諸市の場所の一覧（[名前, 種類, 緯度, 経度, よみ]）
const results = { start: [], end: [] }; // 名前で探した結果
let boundary = null; // 市の境界（[[lat, lon], ...] の輪の並び）

/** 市の中か（境界を読めていないときは中として扱う）。 */
const inCity = (p) => !boundary || insidePolygon(p, boundary);
/** 道のりに掛ける係数（道に沿って計算したルートは 1）。 */
const factorOf = (plan) => (plan.roads ? 1 : ROAD_FACTOR);
/** ルートの終点（出発地点に戻るなら出発地点、どこで終えてもよいなら null）。 */
const planEnd = (plan) => (plan.returnToStart ? plan.start : plan.end || null);

function persist() {
  const { list, start, end, settings, plan, done, team } = state;
  if (!save({ list, start, end, settings, plan, done, team })) toast("この端末に保存できませんでした。容量がいっぱいの可能性があります。");
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3000);
}

function setBusy(text) {
  document.body.classList.toggle("busy", !!text);
  $("#busytext").textContent = text || "";
}

function go(next) {
  view = next;
  render();
  window.scrollTo(0, 0);
}

const byNumber = () => new Map((state.list?.boards || []).map((b) => [b.number, b]));
const doneCount = () => (state.list?.boards || []).filter((b) => state.done[b.number]).length;
const navUrl = (stops) => C.googleMapsNavUrl(stops, state.plan?.mode || state.settings.mode);
const fmtLatLon = (p) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

// ---------- 画面 ----------
function setHeader(title, back) {
  $("#htitle").textContent = title;
  const b = $("#hback");
  b.hidden = !back;
  b.onclick = back ? () => go(back) : null;
}

function render() {
  document.body.dataset.view = view;
  const v = $("#view");
  ({ setup: renderSetup, import: renderImport, plan: renderPlan, team: renderTeam, pick: renderPick })[view](v);
  updateMap();
}

const TARGET_LABEL = { start: "出発地点", end: "終点" };

/** 出発地点・終点を、名前・住所・地図・現在地・緯度経度で決める部品。 */
function placePicker(target) {
  const p = state[target], label = TARGET_LABEL[target];
  return `
      ${p ? `<p class="chosen"><b>${esc(p.label || label)}</b><br><span class="muted small">${fmtLatLon(p)}</span></p>` : `<p class="muted">まだ決めていません。</p>`}
      ${p && !inCity(p) ? `<p class="warn">${label}が小諸市の外です。道から遠いときは、${label}との距離を直線で見積もります。</p>` : ""}
      <form class="inline" data-form="search" data-target="${target}">
        <input name="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="例: 小諸駅、相生町3" aria-label="${label}を名前や住所で探す">
        <button class="btn small">探す</button>
      </form>
      <ul class="results" id="results-${target}">${resultItems(target)}</ul>
      <div class="row">
        <button class="btn outline small" data-act="pick" data-target="${target}">地図で選ぶ</button>
        <button class="btn outline small" data-act="here" data-target="${target}">現在地を使う</button>
      </div>
      <details class="ll">
        <summary>緯度・経度で入れる</summary>
        <form class="inline" data-form="latlon" data-target="${target}">
          <input name="ll" inputmode="decimal" autocomplete="off" placeholder="例: 36.3265,138.4255" aria-label="${label}の緯度,経度">
          <button class="btn small outline">決める</button>
        </form>
      </details>`;
}

function resultItems(target) {
  return results[target].map((r, i) => `<li><button type="button" class="result" data-act="choose" data-target="${target}" data-i="${i}">
    ${esc(r.name)}<small>${esc(r.kind)}</small></button></li>`).join("");
}

function showResults(target, list, emptyText = "") {
  results[target] = list;
  const ul = document.getElementById(`results-${target}`);
  if (ul) ul.innerHTML = list.length ? resultItems(target) : emptyText ? `<li class="muted small">${esc(emptyText)}</li>` : "";
}

/** 同梱の場所の一覧と、読み込んだ掲示場から探す（打つたびに呼ぶ）。 */
function searchLocal(target, q) {
  showResults(target, searchPlaces(q, places, state.list?.boards || []));
}

/** 「探す」を押したとき: 一覧から探し、住所としても国土地理院の住所検索で探す。 */
async function searchAll(target, q) {
  const local = searchPlaces(q, places, state.list?.boards || []);
  showResults(target, local);
  if (!q.trim()) return;
  try {
    const res = await fetch(addressSearchUrl(q));
    const found = parseAddressResults(await res.json(), (p) => inCity(p));
    const merged = [...local, ...found].slice(0, 10);
    showResults(target, merged, "見つかりませんでした。別の言い方や、地図で選んでください。");
  } catch {
    showResults(target, local, "見つかりませんでした（住所の検索にはネットへの接続が必要です）。");
  }
}

function renderSetup(v) {
  setHeader("ポスターナビ 小諸市", state.plan ? "plan" : null);
  const { list, start, settings } = state;
  const dc = doneCount();
  const outside = list ? list.boards.filter((b) => !inCity(b)).length : 0;
  const endReady = settings.returnToStart || !settings.endFixed || state.end;
  const ready = list?.boards.length && start && endReady;
  const report = importReport
    ? `<div class="note">${importReport.count}か所を取り込みました。${importReport.issues.length ? `取り込めなかった行が${importReport.issues.length}行あります。` : ""}
        ${importReport.outsideJapan ? `<br>日本の外にある掲示場が${importReport.outsideJapan}か所あります。緯度と経度が入れ替わっていないか確かめてください。` : ""}
        ${importReport.issues.length ? `<details><summary>取り込めなかった行</summary><ul>${importReport.issues.slice(0, 50).map((i) => `<li>${i.line}行目: ${esc(i.reason)}</li>`).join("")}</ul></details>` : ""}</div>`
    : "";
  v.innerHTML = `
    <p class="intro">小諸市の道路データ（OpenStreetMap）を使って、道に沿った距離で、掲示場を回る短い順番を探します。</p>
    <section class="card">
      <h2><span class="step">1</span>掲示場の一覧</h2>
      ${list ? `<p><b>${esc(list.name)}</b>　${list.boards.length}か所${dc ? `（貼り終えた ${dc}か所）` : ""}</p>` : `<p class="muted">まだありません。CSV を読み込むか、見本で試してください。</p>`}
      ${report}
      ${outside ? `<p class="warn">小諸市の外にある掲示場が${outside}か所あります。道路データは市の周り約1kmまでなので、遠い掲示場は直線距離で見積もります。</p>` : ""}
      <div class="row">
        <button class="btn" data-act="csv">CSVを読み込む</button>
        <button class="btn outline" data-act="sample">見本を入れる</button>
      </div>
      <p class="hint">CSV の列は「番号・掲示場名・緯度・経度」（設置場所はあれば）。見出しの名前が違っても自動で割り当てます。</p>
    </section>

    <section class="card">
      <h2><span class="step">2</span>出発地点</h2>
      ${placePicker("start")}
    </section>

    <section class="card">
      <h2><span class="step">3</span>終わる場所</h2>
      <label class="check"><input type="checkbox" name="returnToStart" ${settings.returnToStart ? "checked" : ""}> 最後に出発地点へ戻る</label>
      ${settings.returnToStart ? "" : `
        <div class="seg" role="radiogroup" aria-label="終わる場所">
          <label><input type="radio" name="endFixed" value="0" ${settings.endFixed ? "" : "checked"}><span>どこで終えてもよい</span></label>
          <label><input type="radio" name="endFixed" value="1" ${settings.endFixed ? "checked" : ""}><span>終点を決める</span></label>
        </div>
        ${settings.endFixed ? placePicker("end") : `<p class="hint">最後の掲示場で終わる、いちばん短い順を探します。</p>`}`}
    </section>

    <section class="card">
      <h2><span class="step">4</span>回り方</h2>
      <div class="seg" role="radiogroup" aria-label="移動手段">
        ${Object.entries(MODES).map(([k, m]) => `<label><input type="radio" name="mode" value="${k}" ${settings.mode === k ? "checked" : ""}><span>${m.label}</span></label>`).join("")}
      </div>
      <label class="field">1か所の作業時間<span><input type="number" name="workMin" min="0" max="60" step="1" value="${settings.workMin}"> 分</span></label>
      <label class="field">何人（何班）で分けるか<span><input type="number" name="teams" min="1" max="${MAX_TEAMS}" step="1" value="${settings.teams}"> 班</span></label>
      <label class="check"><input type="checkbox" name="roads" ${settings.roads ? "checked" : ""}> 道に沿った距離で計算する（車は一方通行も守る）</label>
      ${dc ? `<label class="check"><input type="checkbox" name="skipDone" ${settings.skipDone ? "checked" : ""}> 貼り終えた${dc}か所は除く</label>` : ""}
    </section>

    <button class="btn big" data-act="solve" ${ready ? "" : "disabled"}>ルートを探す</button>
    ${ready ? "" : `<p class="hint center">掲示場の一覧と出発地点${endReady ? "" : "・終点"}を決めると、探せます。</p>`}

    <details class="card manage">
      <summary>データの管理</summary>
      <div class="row">
        <button class="btn outline small" data-act="clearDone" ${dc ? "" : "disabled"}>貼った記録を消す</button>
        <button class="btn danger small" data-act="clearAll">すべて消す</button>
      </div>
    </details>
    <p class="privacy">🔒 一覧・出発地点・貼った記録は、この端末の中だけに保存します。サーバーには送りません。</p>`;
}

function renderImport(v) {
  setHeader("列の割り当て", "setup");
  const { name, table, mapping } = importDraft;
  const p = C.mappingProblems(mapping);
  const opt = (i, sel) => `<option value="${i}" ${sel ? "selected" : ""}>${esc(table.headers[i] || `${i + 1}列目`)}</option>`;
  v.innerHTML = `
    <section class="card">
      <h2>${esc(name)}</h2>
      <p class="muted">${table.rows.length}行・${table.encoding}</p>
      ${C.FIELDS.map((f) => `
        <label class="field">${f.label}${f.required ? "" : "（任意）"}
          <select data-field="${f.key}">
            <option value="">（使わない）</option>
            ${table.headers.map((_, i) => opt(i, mapping[f.key] === i)).join("")}
          </select>
        </label>`).join("")}
      ${p.missing.length ? `<p class="warn">「${p.missing.join("・")}」の列を選んでください。</p>` : ""}
      ${p.dup.length ? `<p class="warn">「${p.dup.join("・")}」が同じ列になっています。</p>` : ""}
      <div class="row">
        <button class="btn" data-act="doImport" ${p.ok ? "" : "disabled"}>取り込む</button>
        <button class="btn outline" data-act="setup">やめる</button>
      </div>
    </section>`;
}

function planSummary() {
  const plan = state.plan;
  const total = plan.routes.reduce((s, r) => s + r.numbers.length, 0);
  const dist = plan.routes.reduce((s, r) => s + r.distance, 0);
  const gain = plan.baseline && plan.routes.length === 1 ? 1 - plan.routes[0].distance / plan.baseline : 0;
  return { total, dist, gain };
}

function renderPlan(v) {
  setHeader("ルート", null);
  const plan = state.plan;
  const { total, dist, gain } = planSummary();
  const k = plan.routes.length;
  const boards = byNumber();
  const f = factorOf(plan);
  const how = plan.roads
    ? `道に沿った距離（OpenStreetMap の道路データ${plan.mode === "driving" ? "。一方通行も守る" : ""}）で${plan.exact ? "、最短の順です。" : "、十分に短い順です（最短とは限りません）。"}`
    : `直線距離で${plan.exact ? "、最短の順です。" : "、十分に短い順です（最短とは限りません）。"}道のりは、直線距離の${ROAD_FACTOR}倍で見積もった目安です。`;
  const far = plan.unsnapped?.length
    ? `<p class="warn">道から400m以上離れていた掲示場（${plan.unsnapped.slice(0, 10).map(esc).join("、")}${plan.unsnapped.length > 10 ? " ほか" : ""}）は、直線距離×${ROAD_FACTOR}で見積もりました。緯度・経度を確かめてください。</p>`
    : "";
  const farStart = plan.startUnsnapped ? `<p class="warn">出発地点が道から400m以上離れているため、出発地点からの距離は直線で見積もりました。</p>` : "";
  v.innerHTML = `
    <section class="card">
      <h2>${k > 1 ? `${total}か所を${k}班に分けました` : `${total}か所を回るルート`}</h2>
      <p>道のり ${formatRoadKm(dist, f)}（${MODES[plan.mode]?.label}・1か所${plan.workMin}分）${plan.returnToStart ? "・出発地点に戻る" : plan.end ? `・${esc(plan.end.label || "終点")}で終わる` : "・最後の掲示場で終わる"}</p>
      ${gain > 0.001 ? `<p class="good">一覧の順に回るより <b>${Math.round(gain * 100)}%</b> 短くなりました（${formatRoadKm(plan.baseline, f)} → ${formatRoadKm(plan.routes[0].distance, f)}）</p>` : ""}
      <p class="hint">${how}時間は、${MODES[plan.mode]?.label}${MODES[plan.mode]?.kmh}km/h と作業時間から出した目安です。</p>
      ${far}${farStart}
    </section>
    <ul class="teams">
      ${plan.routes.map((r, i) => {
        const left = remaining(r.numbers, state.done).length;
        const min = estimateMinutes(r.distance, r.fromHere ? left : r.numbers.length, plan.mode, plan.workMin, f);
        const first = boards.get(r.numbers[0]);
        return `<li><button class="team" data-act="team" data-i="${i}" style="--c:${teamColor(i)}">
          <span class="dot"></span>
          <span class="tmain"><b>${teamName(i, k)}</b>　${r.numbers.length}か所・${r.fromHere ? "残り" : ""}${formatRoadKm(r.distance, f)}・${formatDuration(min)}
            <small>${left ? `残り${left}か所` : "すべて貼り終えました"}${first ? `・最初は ${esc(first.number)} ${esc(first.name)}` : ""}</small></span>
          <span class="chev" aria-hidden="true">›</span></button></li>`;
      }).join("")}
    </ul>
    <div class="row">
      <button class="btn outline" data-act="shareAll">${k > 1 ? "全班の順番を送る" : "順番を送る"}</button>
      <button class="btn outline" data-act="setup">条件を変える</button>
    </div>`;
}

function renderTeam(v) {
  const plan = state.plan;
  const i = Math.min(state.team, plan.routes.length - 1);
  const r = plan.routes[i];
  const k = plan.routes.length;
  setHeader(teamName(i, k), "plan");
  const boards = byNumber();
  const list = r.numbers.map((n) => boards.get(n)).filter(Boolean);
  const rest = list.filter((b) => !state.done[b.number]);
  const next = rest[0];
  const pos = next ? list.indexOf(next) + 1 : 0;
  const batch = rest.slice(0, C.MAX_WAYPOINTS + 1);
  const f = factorOf(plan);
  const min = estimateMinutes(r.distance, r.fromHere ? rest.length : r.numbers.length, plan.mode, plan.workMin, f);
  v.innerHTML = `
    <section class="card next" style="--c:${teamColor(i)}">
      ${next ? `
        <p class="label">次の掲示場（${pos} / ${list.length}）</p>
        <h2>${esc(next.number)}　${esc(next.name)}</h2>
        ${next.address ? `<p class="muted">${esc(next.address)}</p>` : ""}
        <div class="row">
          <a class="btn" href="${esc(navUrl([next]))}" target="_blank" rel="noopener">Google マップで案内</a>
          <button class="btn ok" data-act="done" data-n="${esc(next.number)}">貼った</button>
        </div>
        ${batch.length > 1 ? `<a class="btn outline wide" href="${esc(navUrl(batch))}" target="_blank" rel="noopener">次の${batch.length}か所をまとめて案内</a>` : ""}`
      : `<h2>この班はすべて貼り終えました</h2>
        ${planEnd(plan) ? `<a class="btn wide" href="${esc(navUrl([planEnd(plan)]))}" target="_blank" rel="noopener">${plan.returnToStart ? "出発地点へ戻る" : "終点へ向かう"}案内</a>` : ""}`}
    </section>
    <p class="muted small">${list.length}か所・${r.fromHere ? "現在地から残り" : ""}${formatRoadKm(r.distance, f)}・${formatDuration(min)}・貼った ${list.length - rest.length}か所</p>
    <ol class="stops">
      ${list.map((b, idx) => `
        <li class="${state.done[b.number] ? "done" : ""} ${b === next ? "current" : ""}">
          <label>
            <input type="checkbox" data-n="${esc(b.number)}" ${state.done[b.number] ? "checked" : ""} aria-label="${esc(b.number)} を貼った">
            <span class="num" style="--c:${teamColor(i)}">${idx + 1}</span>
            <span class="sname"><b>${esc(b.number)}　${esc(b.name)}</b>${b.address ? `<small>${esc(b.address)}</small>` : ""}</span>
          </label>
          <a class="go" href="${esc(navUrl([b]))}" target="_blank" rel="noopener" aria-label="${esc(b.name)} へ案内">案内</a>
        </li>`).join("")}
    </ol>
    <div class="row">
      <button class="btn outline" data-act="replan" ${rest.length > 1 ? "" : "disabled"}>残りを現在地から引き直す</button>
      <button class="btn outline" data-act="share">この班の順番を送る</button>
    </div>
    <p class="hint">運転中は操作しないでください。停車してから、または同乗者が操作してください。</p>`;
}

function renderPick(v) {
  const label = TARGET_LABEL[pickTarget];
  setHeader(`${label}を選ぶ`, "setup");
  v.innerHTML = `
    <section class="card pickpanel">
      <p>${pickPoint ? `選んだ地点: ${fmtLatLon(pickPoint)}` : `地図を押して、${label}を選んでください。`}</p>
      <div class="row">
        <button class="btn" data-act="pickOk" ${pickPoint ? "" : "disabled"}>ここを${label}にする</button>
        <button class="btn outline" data-act="setup">やめる</button>
      </div>
    </section>`;
}

// ---------- 地図 ----------
let map = null, layer = null;

function ensureMap() {
  if (map || !window.L) return map;
  map = L.map("map", { preferCanvas: true });
  const opts = {
    maxZoom: 18,
    attribution: '出典: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>'
      + ' | 道路: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  };
  const pale = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", opts).addTo(map);
  const std = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", opts);
  L.control.layers({ 淡色地図: pale, 標準地図: std }, null, { position: "topright" }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on("click", (e) => {
    if (view !== "pick") return;
    pickPoint = { lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) };
    render();
  });
  return map;
}

const pointIcon = (text) => L.divIcon({ className: "", html: `<div class="pin start">${text}</div>`, iconSize: [32, 32] });
const startIcon = () => pointIcon("出");
const endIcon = () => pointIcon("終");

function updateMap() {
  const show = ["plan", "team", "pick"].includes(view);
  $("#mapwrap").hidden = !show;
  if (!show) return;
  if (!ensureMap()) { $("#mapwrap").hidden = true; return; }
  layer.clearLayers();
  if (boundary) L.polygon(boundary.map((r) => r.map(([la, lo]) => [la, lo])), { color: "#444", weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(layer);
  const pts = [];
  const plan = state.plan;
  const boards = byNumber();
  if (view === "pick") {
    // 選んでいないほうの地点も、目印として出す
    const other = pickTarget === "start" ? state.end : state.start;
    if (other) L.marker([other.lat, other.lon], { icon: pickTarget === "start" ? endIcon() : startIcon(), opacity: 0.6, interactive: false }).addTo(layer);
    if (pickPoint) L.marker([pickPoint.lat, pickPoint.lon], { icon: pickTarget === "start" ? startIcon() : endIcon() }).addTo(layer);
    for (const b of state.list?.boards || []) {
      L.circleMarker([b.lat, b.lon], { radius: 4, color: "#555", weight: 1, fillOpacity: 0.6, interactive: false }).addTo(layer);
    }
    const around = pickPoint || state[pickTarget] || state.start;
    map.invalidateSize();
    if (around) map.setView([around.lat, around.lon], Math.max(map.getZoom() || 0, 15));
    else if (state.list?.boards.length) map.fitBounds(state.list.boards.map((b) => [b.lat, b.lon]), { padding: [20, 20] });
    else map.setView(CITY.center, CITY.zoom);
    return;
  }
  const end = planEnd(plan);
  const routes = view === "team" ? [state.team] : plan.routes.map((_, i) => i);
  for (const i of routes) {
    const r = plan.routes[i];
    if (!r) continue;
    const list = r.numbers.map((n) => boards.get(n)).filter(Boolean);
    const line = r.path || [plan.start, ...list, ...(end ? [end] : [])].map((p) => [p.lat, p.lon]);
    L.polyline(line, { color: teamColor(i), weight: plan.roads ? 4 : 3, opacity: 0.75 }).addTo(layer);
    const numbered = view === "team" && list.length <= 400;
    list.forEach((b, idx) => {
      const done = !!state.done[b.number];
      const m = numbered
        ? L.marker([b.lat, b.lon], { icon: L.divIcon({ className: "", html: `<div class="pin${done ? " done" : ""}" style="--c:${teamColor(i)}">${idx + 1}</div>`, iconSize: [26, 26] }) })
        : L.circleMarker([b.lat, b.lon], { radius: 5, color: "#fff", weight: 1, fillColor: done ? "#999" : teamColor(i), fillOpacity: 0.95 });
      m.bindPopup(`<b>${idx + 1}. ${esc(b.number)} ${esc(b.name)}</b>${b.address ? `<br>${esc(b.address)}` : ""}<br><a href="${esc(navUrl([b]))}" target="_blank" rel="noopener">Google マップで案内</a>`);
      m.addTo(layer);
      pts.push([b.lat, b.lon]);
    });
  }
  L.marker([plan.start.lat, plan.start.lon], { icon: startIcon(), zIndexOffset: 1000 }).addTo(layer);
  pts.push([plan.start.lat, plan.start.lon]);
  if (plan.end) {
    L.marker([plan.end.lat, plan.end.lon], { icon: endIcon(), zIndexOffset: 900 }).addTo(layer);
    pts.push([plan.end.lat, plan.end.lon]);
  }
  map.invalidateSize();
  map.fitBounds(pts, { padding: [24, 24], maxZoom: 17 });
}

// ---------- 計算 ----------
function solve(request) {
  const inPage = () => import("./solve.js").then((m) => m.solve(request));
  let worker;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch {
    return inPage();
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker.terminate();
      inPage().then(resolve, reject); // module worker が使えないブラウザでは画面の中で計算する
    };
    worker.postMessage(request);
  });
}

/** 道に沿って計算し、道路データを読めなければ直線距離で計算し直す。 */
async function solveWithFallback(request) {
  if (!request.roads) return solve(request);
  try {
    return await solve(request);
  } catch (err) {
    toast(`道路データで計算できなかったので、直線距離で計算しました（${err.message}）。`);
    return solve({ ...request, roads: false });
  }
}

async function solveAll() {
  const { list, start, settings } = state;
  // 終点: 戻るなら出発地点（end を渡さない）、終点を決めたならその地点、どこでもよいなら null
  const endPoint = !settings.returnToStart && settings.endFixed ? state.end : null;
  const stops = settings.skipDone ? list.boards.filter((b) => !state.done[b.number]) : list.boards;
  if (!stops.length) return toast("回る掲示場がありません（すべて貼り終えています）。");
  const teams = Math.max(1, Math.min(MAX_TEAMS, Math.floor(settings.teams) || 1));
  setBusy(settings.roads ? "道路データを読み込んで、ルートを計算しています…" : BUSY_TEXT);
  try {
    const result = await solveWithFallback({
      start, stops, mode: settings.mode, roads: settings.roads,
      options: {
        returnToStart: settings.returnToStart, teams, timeLimitMs: 2500,
        ...(settings.returnToStart ? {} : { end: endPoint }),
        stopCost: stopCostMeters(settings.mode, settings.workMin, settings.roads ? 1 : ROAD_FACTOR),
      },
    });
    const roads = !!result.routes[0]?.path;
    state.plan = {
      createdAt: Date.now(),
      start, end: endPoint, mode: settings.mode, workMin: settings.workMin, returnToStart: settings.returnToStart, roads,
      exact: result.exact,
      baseline: result.routes.length === 1 ? result.listOrderDistance : null,
      unsnapped: (result.unsnapped || []).map((i) => stops[i].number),
      startUnsnapped: !!result.startUnsnapped,
      routes: result.routes.map((r) => ({ numbers: r.order.map((i) => stops[i].number), distance: r.distance, path: r.path || null })),
    };
    state.team = 0;
    persist();
    view = "plan";
  } catch (err) {
    toast(`計算できませんでした: ${err.message}`);
  } finally {
    setBusy(null);
    render();
  }
}

async function replanTeam() {
  const plan = state.plan;
  const r = plan.routes[state.team];
  const boards = byNumber();
  const rest = remaining(r.numbers, state.done).map((n) => boards.get(n)).filter(Boolean);
  if (rest.length < 2) return;
  setBusy("現在地を調べています…");
  let here;
  try {
    here = await currentPosition();
  } catch (err) {
    setBusy(null);
    return toast(err.message);
  }
  setBusy(BUSY_TEXT);
  try {
    const end = planEnd(plan);
    const result = await solveWithFallback({ start: here, stops: rest, mode: plan.mode, roads: plan.roads, options: { end, timeLimitMs: 2500 } });
    const route = result.routes[0];
    const order = route.order.map((i) => rest[i]);
    const doneOnes = r.numbers.filter((n) => state.done[n]);
    r.numbers = [...doneOnes, ...order.map((b) => b.number)];
    // ここからの残りの道のり。線も現在地から引く（直線で計算したときも、出発地点からではなく現在地から）
    // 道路データで計算できず直線になったときは、道のりの目安（直線×係数）にそろえる
    r.distance = route.distance * (plan.roads && !route.path ? ROAD_FACTOR : 1);
    r.fromHere = true;
    r.path = route.path || [here, ...order, ...(end ? [end] : [])].map((p) => [p.lat, p.lon]);
    persist();
    toast("残りの順番を、現在地から引き直しました。");
  } catch (err) {
    toast(`計算できませんでした: ${err.message}`);
  } finally {
    setBusy(null);
    render();
  }
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("この端末では現在地を使えません。"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6) }),
      (e) => reject(new Error(e.code === 1 ? "現在地の利用が許可されていません。ブラウザの設定を確かめてください。" : "現在地を取得できませんでした。")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

// ---------- 取り込み ----------
function confirmReplace() {
  if (!state.list) return true;
  const dc = doneCount();
  return confirm(`今の一覧（${state.list.boards.length}か所${dc ? `・貼った記録${dc}か所` : ""}）と探したルートを置き換えます。よろしいですか？`);
}

function applyList(name, boards, report) {
  state.list = { name, boards };
  state.plan = null;
  state.done = {};
  state.team = 0;
  importReport = report;
  persist();
}

async function readCsv(file) {
  try {
    const table = C.readTable(await file.arrayBuffer());
    const mapping = C.autoMapping(table.headers, table.rows);
    importDraft = { name: file.name.replace(/\.csv$/i, ""), table, mapping };
    go("import");
  } catch (err) {
    toast(err instanceof C.CSVImportError ? err.message : "CSV を読めませんでした。");
  }
}

function doImport() {
  const { name, table, mapping } = importDraft;
  const { boards, issues, outsideJapan } = C.buildBoards(table, mapping);
  if (!boards.length) return toast("取り込める行がありませんでした。列の割り当てを確かめてください。");
  if (!confirmReplace()) return;
  applyList(name, boards, { count: boards.length, issues, outsideJapan });
  importDraft = null;
  go("setup");
}

async function applySample() {
  if (!confirmReplace()) return;
  try {
    const res = await fetch("data/sample.csv");
    const table = C.readTable(await res.arrayBuffer());
    const { boards } = C.buildBoards(table, C.autoMapping(table.headers, table.rows));
    applyList("見本（架空の掲示場）", boards, null);
    if (!state.start || !inCity(state.start)) state.start = SAMPLE_START;
    persist();
    toast("見本を入れました。位置は架空です。");
    render();
  } catch {
    toast("見本を読めませんでした。");
  }
}

// ---------- 送る ----------
function teamText(i) {
  const plan = state.plan;
  const r = plan.routes[i];
  const boards = byNumber();
  return routeText({
    title: teamName(i, plan.routes.length),
    boards: r.numbers.map((n) => boards.get(n)).filter(Boolean),
    distance: r.distance,
    minutes: estimateMinutes(r.distance, r.fromHere ? remaining(r.numbers, state.done).length : r.numbers.length, plan.mode, plan.workMin, factorOf(plan)),
    done: state.done,
    factor: factorOf(plan),
  });
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (err) { if (err?.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("順番をコピーしました。メッセージに貼り付けて送れます。");
  } catch {
    toast("コピーできませんでした。");
  }
}

// ---------- 操作 ----------
function setPlace(target, p) {
  state[target] = p;
  results[target] = [];
  persist();
}

function setDone(number, on) {
  if (on) state.done[number] = Date.now();
  else delete state.done[number];
  persist();
}

const actions = {
  csv: () => $("#csvfile").click(),
  sample: applySample,
  pick: (el) => {
    pickTarget = el.dataset.target;
    const p = state[pickTarget];
    pickPoint = p ? { lat: p.lat, lon: p.lon } : null;
    go("pick");
  },
  pickOk: () => { setPlace(pickTarget, { ...pickPoint, label: "地図で選んだ地点" }); go("setup"); },
  here: async (el) => {
    try {
      setPlace(el.dataset.target, { ...(await currentPosition()), label: "現在地" });
      render();
    } catch (err) { toast(err.message); }
  },
  choose: (el) => {
    const r = results[el.dataset.target][+el.dataset.i];
    if (!r) return;
    setPlace(el.dataset.target, { lat: r.lat, lon: r.lon, label: r.name });
    render();
  },
  solve: solveAll,
  setup: () => go("setup"),
  team: (el) => { state.team = +el.dataset.i; persist(); go("team"); },
  done: (el) => { setDone(el.dataset.n, true); render(); },
  replan: replanTeam,
  share: () => shareText(teamText(state.team)),
  shareAll: () => shareText(state.plan.routes.map((_, i) => teamText(i)).join("\n\n")),
  doImport,
  clearDone: () => {
    if (!confirm("貼った記録をすべて消します。よろしいですか？")) return;
    state.done = {};
    persist();
    render();
  },
  clearAll: () => {
    if (!confirm("一覧・出発地点・ルート・貼った記録をすべて消します。元に戻せません。よろしいですか？")) return;
    clear();
    Object.assign(state, { list: null, start: null, settings: { ...DEFAULT_SETTINGS }, plan: null, done: {}, team: 0 });
    importReport = null;
    go("setup");
  },
};

$("#view").addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  e.preventDefault();
  actions[el.dataset.act]?.(el);
});

$("#view").addEventListener("change", (e) => {
  const el = e.target;
  if (el.matches(".stops input[type=checkbox]")) {
    setDone(el.dataset.n, el.checked);
    render();
    return;
  }
  if (el.matches("select[data-field]")) {
    importDraft.mapping[el.dataset.field] = el.value === "" ? undefined : +el.value;
    render();
    return;
  }
  const s = state.settings;
  if (el.name === "mode") s.mode = el.value;
  else if (el.name === "workMin") s.workMin = Math.max(0, Math.min(60, Math.round(+el.value) || 0));
  else if (el.name === "teams") s.teams = Math.max(1, Math.min(MAX_TEAMS, Math.round(+el.value) || 1));
  else if (["returnToStart", "skipDone", "roads"].includes(el.name)) s[el.name] = el.checked;
  else if (el.name === "endFixed") s.endFixed = el.value === "1";
  else return;
  persist();
  if (el.name === "returnToStart" || el.name === "endFixed") render(); // 終点の入力を出し入れする
});

$("#view").addEventListener("submit", (e) => {
  const { form, target } = e.target.dataset;
  if (form === "search") {
    e.preventDefault();
    searchAll(target, e.target.q.value);
    return;
  }
  if (form !== "latlon") return;
  e.preventDefault();
  const p = C.parseLatLon(e.target.ll.value);
  if (!p) return toast("「緯度,経度」の形で入れてください（例: 36.3265,138.4255）。");
  setPlace(target, { ...p, label: "入力した地点" });
  render();
});

$("#view").addEventListener("input", (e) => {
  const form = e.target.closest("form[data-form=search]");
  if (form && e.target.name === "q") searchLocal(form.dataset.target, e.target.value);
});

$("#csvfile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) readCsv(file);
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => { /* オフライン対応なしでも動く */ });
}

fetch("data/komoro-places.json")
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => { if (data?.places) places = data.places; })
  .catch(() => { /* 一覧がなくても、住所・地図・現在地で決められる */ });

fetch("data/komoro-boundary.json")
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => { if (data?.rings) { boundary = data.rings; render(); } })
  .catch(() => { /* 境界がなくても動く（市の外の警告と境界線が出ないだけ） */ });

render();
