// 画面（準備・ルート・班ごとの巡回・地図・CSV の取り込み）。
import * as C from "./core.js";
import { routeDistance } from "./tsp.js";
import {
  MAX_TEAMS, MODES, ROAD_FACTOR, estimateMinutes, formatDuration, formatRoadKm, remaining, routeText,
  stopCostMeters, teamColor, teamName,
} from "./plan.js";
import { clear, load, save } from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DEFAULT_SETTINGS = { mode: "walking", workMin: 3, teams: 1, returnToStart: true, skipDone: true };
const SAMPLE_START = { lat: 36.4485, lon: 139.0105, label: "見本の出発地点" };
const BUSY_TEXT = "ルートを計算しています…";

const saved = load() || {};
const state = {
  list: saved.list || null, // { name, boards: [{ number, name, address, lat, lon }] }
  start: saved.start || null, // { lat, lon, label }
  settings: { ...DEFAULT_SETTINGS, ...saved.settings },
  plan: saved.plan || null, // { routes: [{ numbers, distance }], start, mode, workMin, returnToStart, exact, baseline }
  done: saved.done || {}, // 番号 → 貼った時刻
  team: saved.team || 0,
};
let view = state.plan ? "plan" : "setup";
let importDraft = null; // { name, table, mapping }
let importReport = null; // { count, issues, outsideJapan }
let pickPoint = null;

function persist() {
  const { list, start, settings, plan, done, team } = state;
  if (!save({ list, start, settings, plan, done, team })) toast("この端末に保存できませんでした。容量がいっぱいの可能性があります。");
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

function renderSetup(v) {
  setHeader("ポスターナビ", state.plan ? "plan" : null);
  const { list, start, settings } = state;
  const dc = doneCount();
  const ready = list?.boards.length && start;
  const report = importReport
    ? `<div class="note">${importReport.count}か所を取り込みました。${importReport.issues.length ? `取り込めなかった行が${importReport.issues.length}行あります。` : ""}
        ${importReport.outsideJapan ? `<br>日本の外にある掲示場が${importReport.outsideJapan}か所あります。緯度と経度が入れ替わっていないか確かめてください。` : ""}
        ${importReport.issues.length ? `<details><summary>取り込めなかった行</summary><ul>${importReport.issues.slice(0, 50).map((i) => `<li>${i.line}行目: ${esc(i.reason)}</li>`).join("")}</ul></details>` : ""}</div>`
    : "";
  v.innerHTML = `
    <section class="card">
      <h2><span class="step">1</span>掲示場の一覧</h2>
      ${list ? `<p><b>${esc(list.name)}</b>　${list.boards.length}か所${dc ? `（貼り終えた ${dc}か所）` : ""}</p>` : `<p class="muted">まだありません。CSV を読み込むか、見本で試してください。</p>`}
      ${report}
      <div class="row">
        <button class="btn" data-act="csv">CSVを読み込む</button>
        <button class="btn outline" data-act="sample">見本を入れる</button>
      </div>
      <p class="hint">CSV の列は「番号・掲示場名・緯度・経度」（設置場所はあれば）。見出しの名前が違っても自動で割り当てます。</p>
    </section>

    <section class="card">
      <h2><span class="step">2</span>出発地点</h2>
      ${start ? `<p><b>${esc(start.label || "出発地点")}</b><br><span class="muted">${fmtLatLon(start)}</span></p>` : `<p class="muted">まだ決めていません。</p>`}
      <div class="row">
        <button class="btn" data-act="pick">地図で選ぶ</button>
        <button class="btn outline" data-act="here">現在地を使う</button>
      </div>
      <form class="inline" data-form="latlon">
        <input name="ll" inputmode="decimal" autocomplete="off" placeholder="緯度,経度　例: 36.4485,139.0105" aria-label="緯度,経度">
        <button class="btn small outline">決める</button>
      </form>
    </section>

    <section class="card">
      <h2><span class="step">3</span>回り方</h2>
      <div class="seg" role="radiogroup" aria-label="移動手段">
        ${Object.entries(MODES).map(([k, m]) => `<label><input type="radio" name="mode" value="${k}" ${settings.mode === k ? "checked" : ""}><span>${m.label}</span></label>`).join("")}
      </div>
      <label class="field">1か所の作業時間<span><input type="number" name="workMin" min="0" max="60" step="1" value="${settings.workMin}"> 分</span></label>
      <label class="field">何人（何班）で分けるか<span><input type="number" name="teams" min="1" max="${MAX_TEAMS}" step="1" value="${settings.teams}"> 班</span></label>
      <label class="check"><input type="checkbox" name="returnToStart" ${settings.returnToStart ? "checked" : ""}> 最後に出発地点へ戻る</label>
      ${dc ? `<label class="check"><input type="checkbox" name="skipDone" ${settings.skipDone ? "checked" : ""}> 貼り終えた${dc}か所は除く</label>` : ""}
    </section>

    <button class="btn big" data-act="solve" ${ready ? "" : "disabled"}>ルートを探す</button>
    ${ready ? "" : `<p class="hint center">掲示場の一覧と出発地点を決めると、探せます。</p>`}

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
  v.innerHTML = `
    <section class="card">
      <h2>${k > 1 ? `${total}か所を${k}班に分けました` : `${total}か所を回るルート`}</h2>
      <p>道のり ${formatRoadKm(dist)}（${MODES[plan.mode]?.label}・1か所${plan.workMin}分）${plan.returnToStart ? "・出発地点に戻る" : ""}</p>
      ${gain > 0.001 ? `<p class="good">一覧の順に回るより <b>${Math.round(gain * 100)}%</b> 短くなりました（${formatRoadKm(plan.baseline)} → ${formatRoadKm(plan.routes[0].distance)}）</p>` : ""}
      <p class="hint">${plan.exact ? "直線距離で、最短の順です。" : "直線距離で十分に短い順です（最短とは限りません）。"}道のりと時間は、直線距離の${ROAD_FACTOR}倍で見積もった目安です。</p>
    </section>
    <ul class="teams">
      ${plan.routes.map((r, i) => {
        const left = remaining(r.numbers, state.done).length;
        const min = estimateMinutes(r.distance, r.numbers.length, plan.mode, plan.workMin);
        const first = boards.get(r.numbers[0]);
        return `<li><button class="team" data-act="team" data-i="${i}" style="--c:${teamColor(i)}">
          <span class="dot"></span>
          <span class="tmain"><b>${teamName(i, k)}</b>　${r.numbers.length}か所・${formatRoadKm(r.distance)}・${formatDuration(min)}
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
  const min = estimateMinutes(r.distance, r.numbers.length, plan.mode, plan.workMin);
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
        ${plan.returnToStart ? `<a class="btn wide" href="${esc(navUrl([plan.start]))}" target="_blank" rel="noopener">出発地点へ戻る案内</a>` : ""}`}
    </section>
    <p class="muted small">${list.length}か所・${formatRoadKm(r.distance)}・${formatDuration(min)}・貼った ${list.length - rest.length}か所</p>
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
  setHeader("出発地点を選ぶ", "setup");
  v.innerHTML = `
    <section class="card pickpanel">
      <p>${pickPoint ? `選んだ地点: ${fmtLatLon(pickPoint)}` : "地図を押して、出発地点を選んでください。"}</p>
      <div class="row">
        <button class="btn" data-act="pickOk" ${pickPoint ? "" : "disabled"}>ここを出発地点にする</button>
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
    attribution: '出典: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
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

const startIcon = () => L.divIcon({ className: "", html: '<div class="pin start">出</div>', iconSize: [32, 32] });

function updateMap() {
  const show = ["plan", "team", "pick"].includes(view);
  $("#mapwrap").hidden = !show;
  if (!show) return;
  if (!ensureMap()) { $("#mapwrap").hidden = true; return; }
  layer.clearLayers();
  const pts = [];
  const plan = state.plan;
  const boards = byNumber();
  if (view === "pick") {
    if (pickPoint) L.marker([pickPoint.lat, pickPoint.lon], { icon: startIcon() }).addTo(layer);
    for (const b of state.list?.boards || []) {
      L.circleMarker([b.lat, b.lon], { radius: 4, color: "#555", weight: 1, fillOpacity: 0.6, interactive: false }).addTo(layer);
    }
    const around = pickPoint || state.start;
    map.invalidateSize();
    if (around) map.setView([around.lat, around.lon], Math.max(map.getZoom() || 0, 15));
    else if (state.list?.boards.length) map.fitBounds(state.list.boards.map((b) => [b.lat, b.lon]), { padding: [20, 20] });
    else map.setView([36.39, 139.06], 9);
    return;
  }
  const end = plan.returnToStart ? plan.start : null;
  const routes = view === "team" ? [state.team] : plan.routes.map((_, i) => i);
  for (const i of routes) {
    const r = plan.routes[i];
    if (!r) continue;
    const list = r.numbers.map((n) => boards.get(n)).filter(Boolean);
    const line = [plan.start, ...list, ...(end ? [end] : [])].map((p) => [p.lat, p.lon]);
    L.polyline(line, { color: teamColor(i), weight: 3, opacity: 0.75 }).addTo(layer);
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
  map.invalidateSize();
  map.fitBounds(pts, { padding: [24, 24], maxZoom: 17 });
}

// ---------- 計算 ----------
function solve(start, stops, options) {
  const inPage = () => import("./tsp.js").then((T) => T.planRoutes(start, stops, options));
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
    worker.postMessage({ start, stops, options });
  });
}

async function solveAll() {
  const { list, start, settings } = state;
  const stops = settings.skipDone ? list.boards.filter((b) => !state.done[b.number]) : list.boards;
  if (!stops.length) return toast("回る掲示場がありません（すべて貼り終えています）。");
  const teams = Math.max(1, Math.min(MAX_TEAMS, Math.floor(settings.teams) || 1));
  const end = settings.returnToStart ? start : null;
  setBusy(BUSY_TEXT);
  try {
    const result = await solve(start, stops, {
      end, teams, stopCost: stopCostMeters(settings.mode, settings.workMin), timeLimitMs: 2500,
    });
    state.plan = {
      createdAt: Date.now(),
      start, mode: settings.mode, workMin: settings.workMin, returnToStart: settings.returnToStart,
      exact: result.exact,
      baseline: result.routes.length === 1 ? routeDistance(start, stops, end) : null,
      routes: result.routes.map((r) => ({ numbers: r.order.map((i) => stops[i].number), distance: r.distance })),
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
    const end = plan.returnToStart ? plan.start : null;
    const result = await solve(here, rest, { end, timeLimitMs: 2500 });
    const order = result.routes[0].order.map((i) => rest[i]);
    const doneOnes = r.numbers.filter((n) => state.done[n]);
    r.numbers = [...doneOnes, ...order.map((b) => b.number)];
    r.distance = routeDistance(plan.start, r.numbers.map((n) => boards.get(n)).filter(Boolean), end);
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
    if (!state.start) state.start = SAMPLE_START;
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
    minutes: estimateMinutes(r.distance, r.numbers.length, plan.mode, plan.workMin),
    done: state.done,
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
function setDone(number, on) {
  if (on) state.done[number] = Date.now();
  else delete state.done[number];
  persist();
}

const actions = {
  csv: () => $("#csvfile").click(),
  sample: applySample,
  pick: () => { pickPoint = state.start ? { lat: state.start.lat, lon: state.start.lon } : null; go("pick"); },
  pickOk: () => { state.start = { ...pickPoint, label: "地図で選んだ地点" }; persist(); go("setup"); },
  here: async () => {
    try {
      state.start = { ...(await currentPosition()), label: "現在地" };
      persist();
      render();
    } catch (err) { toast(err.message); }
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
  else if (el.name === "returnToStart" || el.name === "skipDone") s[el.name] = el.checked;
  else return;
  persist();
});

$("#view").addEventListener("submit", (e) => {
  if (e.target.dataset.form !== "latlon") return;
  e.preventDefault();
  const p = C.parseLatLon(e.target.ll.value);
  if (!p) return toast("「緯度,経度」の形で入れてください（例: 36.4485,139.0105）。");
  state.start = { ...p, label: "入力した地点" };
  persist();
  render();
});

$("#csvfile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) readCsv(file);
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => { /* オフライン対応なしでも動く */ });
}

render();
