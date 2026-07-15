/* 四天三夜環島 · 行程協作板 */
"use strict";

// ─── 常數與狀態 ───────────────────────────────────────────────
const LS = { data: "ttp.data", user: "ttp.user" };
const TYPE_EMOJI = { spot: "🏞️", meal: "🍜", transport: "🚗", stay: "🏠", prep: "🧳" };
const TYPE_LABEL = { spot: "景點", meal: "餐食", transport: "車程", stay: "住宿/休息", prep: "整備" };

let data = null;          // 行程資料(含 history)
let currentUser = null;
const PROXY = "https://trip-ai-proxy.doug169215.workers.dev"; // 內建代理(AI+同步),金鑰保管在 Cloudflare Worker
let dirty = false;        // 本機有未同步修改
let activeDay = "overview";
let editing = null;       // { dayId, itemId } 或 { dayId, itemId:null }(新增)
let aiFill = null;        // AI 辨識結果暫存
let sortables = [];
let syncTimer = null;     // 自動上傳的 debounce 計時器
let syncing = false;
const proxyUrl = (p) => PROXY + p;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ─── 初始化 ───────────────────────────────────────────────────
async function init() {
  currentUser = localStorage.getItem(LS.user) || null;

  await loadData();
  bindGlobalEvents();
  renderAll();

  if (!currentUser) showLogin();
  if (dirty) scheduleSync();            // 上次沒同步完的本機修改,補傳
  setInterval(pollRemote, 60_000);      // 每 60 秒自動抓團員的最新版本

  fetchWeather().then(renderWeather);   // 天氣預報(Open-Meteo,免金鑰)
  setInterval(() => fetchWeather(true).then(renderWeather), 30 * 60_000); // 每 30 分鐘更新
}

async function loadData() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LS.data) || "null"); } catch {}

  let remote = null;
  try {
    // 優先走代理(即時、無 CDN 快取);失敗再退回站內 data.json
    const res = await fetch(proxyUrl("/data?t=" + Date.now()), { cache: "no-store" });
    if (res.ok) remote = await res.json();
  } catch {}
  if (!remote) {
    try {
      const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) remote = await res.json();
    } catch {}
  }

  if (local && remote) {
    if (new Date(local.updatedAt) > new Date(remote.updatedAt)) { data = local; dirty = true; }
    else { data = remote; localStorage.setItem(LS.data, JSON.stringify(remote)); }
  } else {
    data = local || remote || structuredClone(window.DEFAULT_DATA);
    if (local && !remote) dirty = true;
  }
  migrateTransports(data); // 舊版車程卡(如果還有)折疊為停靠點的 travel 資訊
  normalizeAnchors(data);  // 每天第一張標記為出發錨點
}

// 每天第一個行程點=出發錨點(固定第一、不可拖曳/刪除、只有出發時間);其餘清除標記
function normalizeAnchors(d) {
  for (const day of d.days) {
    day.items.forEach((it, i) => {
      if (i === 0) {
        it.anchor = true;
        delete it.travel;
        const m = String(it.time).match(/\d{1,2}:\d{2}/); // 只保留出發(起始)時間
        if (m) it.time = m[0];
      } else if (it.anchor) delete it.anchor;
    });
  }
}

// ─── 車程卡遷移:transport 卡折疊為下一個停靠點的 travel:{minutes,note} ──
function timeRangeMinutes(t) {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return b > a ? b - a : null;
}

function migrateTransports(d) {
  let changed = false;
  for (const day of d.days) {
    if (!day.items.some((i) => i.type === "transport")) continue;
    const out = [];
    let pending = null; // 待折疊的車程資訊
    for (const it of day.items) {
      if (it.type === "transport") {
        if (!out.length && !it.title.includes("→")) {
          it.type = "prep"; out.push(it); changed = true; continue; // 當天開頭的「出發」卡 → 整備錨點
        }
        const mins = timeRangeMinutes(it.time);
        const note = it.note || "";
        pending = pending
          ? { minutes: (pending.minutes || 0) + (mins || 0) || null, note: [pending.note, note].filter(Boolean).join(";") }
          : { minutes: mins, note };
        changed = true;
        continue;
      }
      if (pending) {
        if (!it.travel) it.travel = { minutes: pending.minutes || undefined, note: pending.note || undefined };
        pending = null;
      }
      out.push(it);
    }
    if (pending) out.push({ id: uid(), time: "", title: "車程", type: "prep", note: pending.note, intro: "" });
    day.items = out;
  }
  return changed;
}

// ─── 修改與紀錄 ───────────────────────────────────────────────
function commit(text) {
  data.updatedAt = new Date().toISOString();
  data.history.unshift({ ts: data.updatedAt, user: currentUser || "訪客", text });
  if (data.history.length > 300) data.history.length = 300;
  dirty = true;
  localStorage.setItem(LS.data, JSON.stringify(data));
  scheduleSync();
}

// ─── 自動同步 ─────────────────────────────────────────────────
function scheduleSync() {
  setSyncStatus("✏️ 已存本機,即將自動上傳…", true);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(autoSync, 2500);
}

async function autoSync() {
  if (syncing) { clearTimeout(syncTimer); syncTimer = setTimeout(autoSync, 2000); return; }
  syncing = true;
  setSyncStatus("☁️ 自動上傳中…", true);
  try {
    const res = await fetch(proxyUrl("/sync"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    dirty = false;
    const t = new Date().toLocaleTimeString("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit" });
    setSyncStatus(`✅ 已自動同步給全團(${t})`, false);
  } catch (e) {
    setSyncStatus(`⚠️ 同步失敗:${e.message},30 秒後自動重試`, true);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { if (dirty) autoSync(); }, 30_000);
  }
  syncing = false;
}

// 定時抓團員的最新版本(自己有未上傳修改時跳過,避免蓋掉)
async function pollRemote() {
  if (dirty || syncing) return;
  try {
    const res = await fetch(proxyUrl("/data?t=" + Date.now()), { cache: "no-store" });
    if (!res.ok) return;
    const remote = await res.json();
    if (new Date(remote.updatedAt) > new Date(data.updatedAt)) {
      data = remote;
      migrateTransports(data); // 團員舊版資料若含車程卡,在本機即時折疊(不回寫)
      normalizeAnchors(data);
      localStorage.setItem(LS.data, JSON.stringify(data));
      renderAll();
      setSyncStatus("⬇️ 已載入團員的最新修改", false);
    }
  } catch {}
}

function setSyncStatus(text, isDirty) {
  const s = $("#sync-status");
  if (s) s.textContent = text;
  const b = $("#sync-badge");
  b.classList.toggle("dirty", !!isDirty);
  b.title = text;
}

function updateSyncBadge() {
  setSyncStatus(dirty ? "✏️ 有本機修改待同步" : "☁️ 自動同步已啟用", dirty);
}

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ─── 渲染 ─────────────────────────────────────────────────────
function renderAll() {
  $("#trip-title").textContent = data.title || "四天三夜環島";
  $("#trip-subtitle").textContent = data.subtitle || "";
  $("#user-name").textContent = currentUser || "未登入";
  renderTabs();
  renderPanels();
  updateSyncBadge();
}

function renderTabs() {
  const nav = $("#day-tabs");
  const tabs = [{ id: "overview", label: "📋 總覽" }].concat(
    data.days.map((d) => ({ id: d.id, label: `${d.name}(${d.weekday})` }))
  );
  nav.innerHTML = tabs.map((t) =>
    `<button class="day-tab ${t.id === activeDay ? "active" : ""}" data-day="${t.id}">${esc(t.label)}</button>`
  ).join("");
  nav.querySelectorAll(".day-tab").forEach((btn) => {
    btn.onclick = () => { activeDay = btn.dataset.day; renderTabs(); renderPanels(); };
  });
}

function renderPanels() {
  normalizeAnchors(data); // 保證每天第一張=出發錨點(只有出發時間、不可拖/刪)
  sortables.forEach((s) => s.destroy());
  sortables = [];
  const main = $("#main-content");
  main.innerHTML = renderOverview() + data.days.map(renderDay).join("");

  // 綁定總覽 checklist
  main.querySelectorAll(".checklist-item input").forEach((cb) => {
    cb.onchange = () => {
      const item = data.preTrip.find((p) => p.id === cb.dataset.id);
      if (!item) return;
      item.done = cb.checked;
      commit(`${cb.checked ? "勾選" : "取消勾選"}行前確認:「${item.text.slice(0, 20)}…」`);
      renderPanels();
    };
  });

  // 綁定編輯按鈕(卡片本身不可點,避免誤觸)
  main.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openItemModal(btn.closest(".item-list").dataset.day, btn.dataset.id);
    };
  });
  main.querySelectorAll(".add-item-btn").forEach((btn) => {
    btn.onclick = () => startQuickAdd(btn);
  });
  main.querySelectorAll(".ai-retime").forEach((btn) => {
    btn.onclick = () => aiRetime(btn.dataset.day);
  });

  renderWeather();

  // 各日路線圖:點開才載入地圖(避免一次抓四張)
  main.querySelectorAll(".route-map-block").forEach((blk) => {
    blk.addEventListener("toggle", () => { if (blk.open) initRouteMap(blk.dataset.day); });
  });

  // 拖曳排序(跨天共用群組;只有停靠點卡片可拖,車程列不可)
  main.querySelectorAll(".item-list").forEach((list) => {
    sortables.push(new Sortable(list, {
      group: "trip-items",
      draggable: ".item-card:not(.anchor-card)",
      onMove: (e) => { // 不可把任何卡片放到出發錨點之前
        const anchor = e.to.querySelector(".anchor-card");
        return !(anchor && e.related === anchor && !e.willInsertAfter);
      },
      handle: ".drag-handle",
      animation: 150,
      forceFallback: true,      // 統一使用滑鼠/觸控模擬,手機拖曳更可靠
      fallbackTolerance: 3,
      delayOnTouchOnly: 150,    // 觸控長按 150ms 才開始拖,避免誤觸捲動
      onEnd: onDragEnd,
    }));
  });
}

// 路線城市/地點 → 座標(用於頁內 Leaflet 路線圖);「南迴」「蘇花」取公路上的代表點
const ROUTE_COORDS = {
  "新竹": [24.80, 120.97], "台中": [24.15, 120.66], "台南": [22.99, 120.21],
  "枋山": [22.26, 120.65], "恆春": [22.00, 120.74],
  "南迴": [22.36, 120.90], "台東": [22.75, 121.15], "台東市": [22.76, 121.14],
  "鹿野": [22.91, 121.13], "小野柳": [22.80, 121.19], "成功": [23.10, 121.37],
  "三仙台": [23.12, 121.41], "石梯坪": [23.49, 121.51],
  "花蓮": [23.98, 121.60], "花蓮市": [23.98, 121.61], "七星潭": [24.03, 121.62],
  "蘇花": [24.30, 121.75], "蘇澳": [24.59, 121.85], "礁溪": [24.83, 121.77],
};

function routeStops(route) {
  return String(route).split(/→|➜|->/).map((s) => s.trim()).filter(Boolean);
}

// 已初始化的地圖(避免重複建立)
const routeMaps = {};

// 點開某天路線圖時建立 Leaflet 地圖:OSM 圖磚 + OSRM 免費路徑(沿道路),失敗則退回直線
async function initRouteMap(dayId) {
  if (routeMaps[dayId] || typeof L === "undefined") return;
  const el = document.getElementById("rmap-" + dayId);
  const day = data.days.find((d) => d.id === dayId);
  if (!el || !day) return;
  const pts = routeStops(day.route).map((s) => [s, ROUTE_COORDS[s]]).filter((x) => x[1]);
  if (pts.length < 2) return;

  const map = L.map(el, { scrollWheelZoom: false });
  routeMaps[dayId] = map;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 17,
  }).addTo(map);
  pts.forEach(([name, c]) => L.marker(c).addTo(map).bindPopup(name));
  const latlngs = pts.map((x) => x[1]);
  map.fitBounds(latlngs, { padding: [30, 30] });
  setTimeout(() => map.invalidateSize(), 60); // details 展開後容器才有尺寸

  // OSRM 沿道路路徑(免金鑰);座標為 lon,lat
  try {
    const coords = pts.map((x) => `${x[1][1]},${x[1][0]}`).join(";");
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
    if (res.ok) {
      const j = await res.json();
      const line = j.routes && j.routes[0] && j.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
      if (line) {
        L.polyline(line, { color: "#1f6f8b", weight: 5, opacity: .85 }).addTo(map);
        const km = Math.round(j.routes[0].distance / 1000);
        const min = Math.round(j.routes[0].duration / 60);
        L.control && addRouteInfo(map, `🚗 約 ${km} 公里 · ${Math.floor(min / 60)} 小時 ${min % 60} 分`);
        map.fitBounds(L.polyline(line).getBounds(), { padding: [30, 30] });
        return;
      }
    }
  } catch {}
  L.polyline(latlngs, { color: "#1f6f8b", weight: 4, dashArray: "6 6", opacity: .7 }).addTo(map); // 退回直線
}

function addRouteInfo(map, text) {
  const c = L.control({ position: "bottomleft" });
  c.onAdd = () => { const d = L.DomUtil.create("div", "route-info"); d.textContent = text; return d; };
  c.addTo(map);
}

function renderOverview() {
  const act = activeDay === "overview" ? "active" : "";
  const summaryRows = data.days.map((d) =>
    `<tr><td><b>${esc(d.name.replace(/^Day\s*/, "D"))}</b><br><small>${esc(d.weekday)}</small></td><td>${esc(d.route)}</td><td>${lodgingHtml(d) || "—"}</td></tr>`
  ).join("");
  return `
  <section class="day-panel ${act}" data-panel="overview">
    <div class="day-head">
      <p class="startdate-row">🗓️ 出發日(Day 1):<b>2026/7/17(週五)</b><small>各天自動顯示對應日期的天氣預報</small></p>
    </div>
    <div class="day-head">
      <h2>行程原則</h2>
      <ul class="overview-principles">${data.principles.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
      <h2>四天路線一覽</h2>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.88rem">
        <thead><tr style="text-align:left;color:var(--ink-soft)"><th style="padding:.3em .5em">天</th><th style="padding:.3em .5em">路線</th><th style="padding:.3em .5em">住宿</th></tr></thead>
        <tbody>${summaryRows}</tbody>
      </table></div>
      <h2 style="margin-top:1em">🗺️ 各日路線圖</h2>
      ${data.days.map((d) => `
        <details class="route-map-block" data-day="${d.id}">
          <summary><b>${esc(d.name.replace(/^Day\s*/, "D"))}</b> ${esc(d.route)}</summary>
          <div class="route-map" id="rmap-${d.id}"></div>
        </details>`).join("")}
    </div>
    <div class="day-head">
      <h2>✅ 行前確認清單</h2>
      ${data.preTrip.filter((p) => p.id !== "auto-daily").map((p) => `
        <label class="checklist-item ${p.done ? "done" : ""}">
          <input type="checkbox" data-id="${p.id}" ${p.done ? "checked" : ""}>
          <span>${esc(p.text)}</span>
        </label>`).join("")}
    </div>
  </section>`;
}

// 住宿文字,有 lodgingUrl 時包成 Google Maps 連結
function lodgingHtml(day) {
  if (!day.lodging) return "";
  return day.lodgingUrl
    ? `<a class="lodging-link" href="${esc(day.lodgingUrl)}" target="_blank" rel="noopener" title="在 Google Maps 開啟">${esc(day.lodging)} 📍</a>`
    : esc(day.lodging);
}

function renderDay(day) {
  const act = activeDay === day.id ? "active" : "";
  return `
  <section class="day-panel ${act}" data-panel="${day.id}">
    <div class="day-head">
      <h2>${esc(day.name)}(${esc(day.weekday)})|${esc(day.title)}</h2>
      <p class="day-route">${esc(day.route)}</p>
      ${day.lodging ? `<p class="day-lodging">🏠 住宿:${lodgingHtml(day)}</p>` : ""}
      ${(day.trafficTips || []).map((t) => `<div class="traffic-tip">🚦 ${esc(t)}</div>`).join("")}
      <div class="weather-row" data-wday="${day.id}"></div>
      <button class="btn btn-ai ai-retime" data-day="${day.id}" title="依目前卡片順序,由 AI 重新計算整天的時段">✨ AI 重排今日時間</button>
    </div>
    <div class="item-list" data-day="${day.id}">
      ${day.items.map((it, i) => (i > 0 ? renderLeg(day, it) : "") + renderItem(it)).join("")}
    </div>
    <button class="add-item-btn" data-day="${day.id}">＋ 新增地點(只填名稱,AI 自動補時間/類型/介紹)</button>
    <div class="day-extras">
      ${renderRestaurants(day)}
      ${renderList("🧭 沿途備選", day.alternates)}
      ${renderList("⏱️ 時間控制", day.timeControls)}
    </div>
  </section>`;
}

// 停靠點之間的車程列(自動生成,不可拖曳)
function renderLeg(day, it) {
  if (retimePending[day.id]) return `<div class="leg">🚗 ⏳ 車程重算中…</div>`;
  if (!it.travel) return "";
  const mins = it.travel.minutes ? `車程約 ${it.travel.minutes} 分` : "車程";
  const note = it.travel.note ? ` · ${esc(it.travel.note)}` : "";
  return `<div class="leg">🚗 ${mins}${note}</div>`;
}

function renderItem(it) {
  // 景點/餐食/可辨識地名的行程點,附 Google Maps 連結(車程與整備不附)
  const mappable = it.type !== "transport" && it.type !== "prep" && (it.type === "spot" || it.type === "meal" || matchPlace(it.title));
  const mapLink = mappable
    ? `<a class="map-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.title)}" target="_blank" rel="noopener" title="在 Google Maps 開啟「${esc(it.title)}」">📍</a>`
    : "";
  return `
  <div class="item-card ${it.anchor ? "anchor-card" : ""}" data-id="${it.id}" data-type="${esc(it.type)}">
    ${it.anchor ? `<span class="drag-handle anchor-pin" title="當天出發點,固定第一、不可移動">🚩</span>` : `<span class="drag-handle" title="拖曳調整順序">⠿</span>`}
    <div class="item-body">
      <div class="item-top">
        <span class="item-time">${esc(it.time)}</span>
        <span class="item-title">${esc(it.title)}</span>${mapLink}
        <span class="type-badge">${it.aiPending ? "🧠 AI 補全中…" : TYPE_LABEL[it.type] || "行程"}</span>
        <span class="item-wx" data-wxitem="${it.id}"></span>
      </div>
      ${it.note ? `<p class="item-note">${esc(it.note)}</p>` : ""}
      ${it.intro ? `<details class="item-intro"><summary>景點介紹</summary>${esc(it.intro)}</details>` : ""}
    </div>
    <button class="edit-btn" data-id="${it.id}" title="編輯這個行程點">✏️</button>
  </div>`;
}

function renderRestaurants(day) {
  if (!day.restaurants || !day.restaurants.length) return "";
  // 每家餐廳附 Google Maps 搜尋連結:店名(冒號/括號前)+ 餐別中的地區關鍵字
  const li = (x, tag, cls, region) => {
    const book = x.startsWith("訂|");           // 「訂|」開頭 → 需訂位標籤
    if (book) x = x.slice(2);
    const name = x.split(":")[0].split("(")[0].trim();
    const url = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(name + " " + region);
    return `<li><span class="resto-tag ${cls}">${tag}</span>${book ? `<span class="resto-tag tag-book">📞需訂位</span>` : ""}${esc(x)}<a class="map-link" href="${url}" target="_blank" rel="noopener" title="在 Google Maps 搜尋「${esc(name)}」">📍</a></li>`;
  };
  const body = day.restaurants.map((r) => {
    const region = (matchPlace(r.meal) || [""])[0];
    return `
    <p class="resto-meal">${esc(r.meal)}</p>
    <ul>
      ${r.first.map((x) => li(x, "首選", "tag-first", region)).join("")}
      ${r.backup.map((x) => li(x, "備案", "tag-backup", region)).join("")}
    </ul>`;
  }).join("");
  return `<div class="extra-block"><h3>🍽️ 餐廳推薦</h3>${body}</div>`;
}

function renderList(title, arr) {
  if (!arr || !arr.length) return "";
  return `<div class="extra-block"><h3>${title}</h3><ul>${arr.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`;
}

// ─── 拖曳 ─────────────────────────────────────────────────────
// 依 DOM 目前的卡片順序重建資料;車程列是衍生畫面,拖曳後自動重算
function onDragEnd(evt) {
  const fromDay = evt.from.dataset.day;
  const toDay = evt.to.dataset.day;
  const itemId = evt.item.dataset.id;

  const from = data.days.find((d) => d.id === fromDay);
  const to = data.days.find((d) => d.id === toDay);
  const moved = from.items.find((i) => i.id === itemId);
  const oldIdx = from.items.indexOf(moved);

  const byId = {};
  data.days.forEach((d) => d.items.forEach((i) => { byId[i.id] = i; }));
  let changed = false;
  for (const dayId of new Set([fromDay, toDay])) {
    const list = document.querySelector(`.item-list[data-day="${dayId}"]`);
    const order = [...list.querySelectorAll(".item-card")].map((c) => byId[c.dataset.id]).filter(Boolean);
    const ai = order.findIndex((i) => i.anchor); // 保險:出發錨點永遠排第一
    if (ai > 0) order.unshift(order.splice(ai, 1)[0]);
    const day = data.days.find((d) => d.id === dayId);
    if (order.map((i) => i.id).join() !== day.items.map((i) => i.id).join()) { day.items = order; changed = true; }
  }
  if (!changed) return;

  const newIdx = to.items.indexOf(moved);
  const msg = fromDay === toDay
    ? `調整「${moved.title}」在 ${to.name} 的順序(第 ${oldIdx + 1} → 第 ${newIdx + 1})`
    : `將「${moved.title}」從 ${from.name} 移到 ${to.name}`;
  commit(msg);
  scheduleRetime(fromDay);
  if (toDay !== fromDay) scheduleRetime(toDay);
  renderPanels();
  toast("已記錄:" + msg + ";車程與時間將自動重算", 4200);
}

// 拖曳後 3 秒自動觸發 AI 重算(連續拖曳只算最後一次)
const retimePending = {};
const retimeTimers = {};
function scheduleRetime(dayId) {
  retimePending[dayId] = true;
  clearTimeout(retimeTimers[dayId]);
  retimeTimers[dayId] = setTimeout(() => aiRetime(dayId), 3000);
}

// 把文字統一轉成台灣慣用繁體中文(簡體或英文都轉;已是繁中則幾乎原樣)。失敗則回原文
async function toTaiwanese(text, ep) {
  text = String(text || "").trim();
  if (!text) return "";
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: ep.headers,
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: `把以下景點介紹改寫成台灣慣用的繁體中文(用語、字形都要台灣化,例如「經濟/發展/台東」而非簡體),語氣自然通順,不要加標題或引號,只回傳結果:\n\n${text}` }],
        temperature: 0.2,
      }),
    });
    if (res.ok) {
      const out = (await res.json()).choices[0].message.content.trim();
      if (out) return out;
    }
  } catch {}
  return text;
}

// ─── 快速新增:只填名稱,AI 補全類型/介紹,拖到位置後自動排時間 ──
function startQuickAdd(btn) {
  const dayId = btn.dataset.day;
  const wrap = document.createElement("div");
  wrap.className = "quick-add";
  wrap.innerHTML = `
    <input type="text" maxlength="40" placeholder="輸入地點名稱(Enter 加入),其餘 AI 自動補全">
    <button class="btn btn-primary">加入</button>
    <button class="btn btn-ghost">取消</button>`;
  btn.replaceWith(wrap);
  const input = wrap.querySelector("input");
  const [ok, cancel] = wrap.querySelectorAll("button");
  ok.onclick = () => {
    const title = input.value.trim();
    if (!title) { toast("請輸入地點名稱"); return; }
    quickAdd(dayId, title);
  };
  cancel.onclick = () => renderPanels();
  input.onkeydown = (e) => {
    if (e.key === "Enter") ok.onclick();
    if (e.key === "Escape") renderPanels();
  };
  input.focus();
}

function quickAdd(dayId, title) {
  const day = data.days.find((d) => d.id === dayId);
  const item = { id: uid(), time: "", title, type: "spot", note: "", intro: "", aiPending: true };
  day.items.push(item);
  commit(`新增「${title}」到 ${day.name}(AI 補全中)`);
  renderPanels();
  toast(`已加入「${title}」,AI 補全中;現在就可以把它拖到想要的位置`, 4200);
  aiComplete(dayId, item.id);
}

async function aiComplete(dayId, itemId) {
  const findItem = () => {
    for (const d of data.days) { const it = d.items.find((i) => i.id === itemId); if (it) return [d, it]; }
    return [null, null];
  };
  let [day, it] = findItem();
  if (!it) return;
  const ep = aiEndpoint("deepseek");

  // 1) DeepSeek:判斷類型與實用提示
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: ep.headers,
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: [
          `台灣旅遊行程助手。${day.name} 路線:${day.route}。新地點:「${it.title}」。`,
          `判斷:1) type 四選一:spot(景點)/meal(餐食)/stay(住宿或休息)/prep(加油、補給等整備)`,
          `2) note:20 字內的實用提示(停車、必點、注意事項擇一重點)`,
          `僅回傳 JSON:{"type":"...","note":"..."}`,
        ].join("\n") }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (res.ok) {
      const out = JSON.parse((await res.json()).choices[0].message.content);
      [day, it] = findItem(); if (!it) return; // 可能已被刪除或拖到別天
      if (TYPE_LABEL[out.type]) it.type = out.type;
      if (out.note && !it.note) it.note = String(out.note).slice(0, 60);
    }
  } catch {}

  // 2) Tavily:景點介紹(英文自動翻中)
  try {
    const tv = aiEndpoint("tavily");
    const res = await fetch(tv.url, {
      method: "POST",
      headers: tv.headers,
      body: JSON.stringify({ query: `台灣 ${it.title} 介紹 特色`, search_depth: "basic", include_answer: true, max_results: 3 }),
    });
    if (res.ok) {
      const j = await res.json();
      let intro = await toTaiwanese(j.answer || "", ep); // 一律轉台灣繁體中文(簡體/英文都轉)
      [day, it] = findItem(); if (!it) return;
      if (intro && !it.intro) it.intro = intro;
    }
  } catch {}

  [day, it] = findItem(); if (!it) return;
  delete it.aiPending;
  commit(`AI 補全「${it.title}」的類型與介紹`);
  renderPanels();
  aiRetime(day.id); // 依目前位置排入時間與車程
}

// ─── AI 重排整天時間與車程(拖曳後自動觸發,也可手動按按鈕) ─────
async function aiRetime(dayId) {
  const day = data.days.find((d) => d.id === dayId);
  if (!day.items.length) { toast("這天還沒有行程點"); return; }
  retimePending[dayId] = true;
  const btn = document.querySelector(`.ai-retime[data-day="${dayId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "🧠 AI 重算時間與車程中…"; }
  try {
    // 只給停留長度、不給舊時間,避免 AI 直接照抄舊時段而不依新順序重算
    const list = day.items.map((it, i) => {
      const stay = timeRangeMinutes(it.time);
      return `${i + 1}. id=${it.id} | ${TYPE_LABEL[it.type] || "行程"} | ${it.title}${stay ? ` | 停留約:${stay}分` : ""}`;
    }).join("\n");
    const firstTime = (String(day.items[0].time).match(/\d{1,2}:\d{2}/) || ["08:00"])[0];
    const prompt = [
      `你是台灣自駕旅遊排程助手。8 人自駕環島,${day.name} 路線:${day.route}。`,
      `行程順序剛被調整過,舊的時間已全部失效。以下是今天「新的順序」:`,
      list,
      `請「嚴格依照這個順序」從頭重新計算每一站的到達與離開時間:`,
      `- 第 1 站從 ${firstTime} 開始;之後每一站的開始時間 = 前一站結束時間 + 車程,整天連貫、不可重疊、不可回到舊時間`,
      `- travel_minutes = 從前一站開車到該站的分鐘數,依兩站實際地點與台灣路況估算;第 1 站為 0;同一地點或步行可達給 0`,
      `- 各站停留長度盡量沿用「停留約」;午餐盡量 11:00-13:30、晚餐 18:00-20:30,可微調停留來配合`,
      `- 時間格式 "HH:MM-HH:MM";最後一站若是抵達/休息可只給起始 "HH:MM"`,
      `- 回傳的 items 必須與上面同樣順序、同樣的 id,一項都不能少`,
      `僅回傳 JSON:{"items":[{"id":"...","time":"...","travel_minutes":數字}]}`,
    ].join("\n");
    const ep = aiEndpoint("deepseek");
    const res = await fetch(ep.url, {
      method: "POST",
      headers: ep.headers,
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = JSON.parse((await res.json()).choices[0].message.content);
    const valid = /^\d{1,2}:\d{2}(-\d{1,2}:\d{2})?$/;
    let changed = 0;
    (out.items || []).forEach((r) => {
      const idx = day.items.findIndex((i) => i.id === r.id);
      if (idx === -1) return;
      const it = day.items[idx];
      if (valid.test(String(r.time || "").trim()) && it.time !== r.time.trim()) { it.time = r.time.trim(); changed++; }
      const mins = Math.round(Number(r.travel_minutes));
      if (idx === 0 || !Number.isFinite(mins) || mins <= 0) {
        if (idx === 0 && it.travel) { delete it.travel; changed++; }
      } else if (!it.travel || it.travel.minutes !== mins) {
        it.travel = { ...(it.travel || {}), minutes: mins };
        changed++;
      }
    });
    retimePending[dayId] = false;
    if (changed) {
      commit(`AI 重排 ${day.name} 時間與車程(更新 ${changed} 處)`);
      toast(`✅ AI 已重排 ${day.name} 的時間與車程`);
    } else {
      toast("AI 認為目前時間與車程已合理,未做修改");
    }
    renderPanels();
  } catch (e) {
    retimePending[dayId] = false;
    toast("⚠️ AI 重排失敗:" + e.message + ",可按「✨ AI 重排今日時間」重試");
    renderPanels();
  }
}

// ─── 行程點編輯 ───────────────────────────────────────────────
function openItemModal(dayId, itemId) {
  editing = { dayId, itemId };
  aiFill = null;
  const day = data.days.find((d) => d.id === dayId);
  const it = itemId ? day.items.find((i) => i.id === itemId) : null;

  $("#item-modal-title").textContent = it ? `編輯行程點(${day.name})` : `新增地點到 ${day.name}`;
  const tm = String(it ? it.time : "").match(/(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?/);
  const pad = (h, m) => `${String(h).padStart(2, "0")}:${m}`;
  $("#item-time-start").value = tm ? pad(tm[1], tm[2]) : "";
  $("#item-time-end").value = tm && tm[3] ? pad(tm[3], tm[4]) : "";
  $("#item-title").value = it ? it.title : "";
  $("#item-type").value = it ? it.type : "spot";
  $("#item-note").value = it ? it.note : "";
  $("#item-intro").value = it ? it.intro : "";
  // 出發錨點:只填出發時間、不可刪除
  const isAnchor = !!(it && it.anchor);
  $("#item-time-end").closest("label").classList.toggle("hidden", isAnchor);
  if (isAnchor) $("#item-time-end").value = "";
  $("#item-delete").classList.toggle("hidden", !it || isAnchor);
  $("#ai-status").classList.add("hidden");
  $("#ai-result").classList.add("hidden");
  $("#item-modal").classList.remove("hidden");
}

function saveItem() {
  const { dayId, itemId } = editing;
  const day = data.days.find((d) => d.id === dayId);
  const vals = {
    time: [$("#item-time-start").value, $("#item-time-end").value].filter(Boolean).join("-"),
    title: $("#item-title").value.trim(),
    type: $("#item-type").value,
    note: $("#item-note").value.trim(),
    intro: $("#item-intro").value.trim(),
  };
  if (!vals.title) { toast("請填寫名稱"); return; }

  if (itemId) {
    const it = day.items.find((i) => i.id === itemId);
    const changes = [];
    if (it.time !== vals.time) changes.push(`時間 ${it.time || "(空)"} → ${vals.time || "(空)"}`);
    if (it.title !== vals.title) changes.push(`名稱「${it.title}」→「${vals.title}」`);
    if (it.type !== vals.type) changes.push(`類型 ${TYPE_LABEL[it.type]} → ${TYPE_LABEL[vals.type]}`);
    if (it.note !== vals.note) changes.push("備註");
    if (it.intro !== vals.intro) changes.push("景點介紹");
    Object.assign(it, vals);
    if (changes.length) commit(`修改 ${day.name}「${vals.title}」:${changes.join("、")}`);
  } else {
    const item = { id: uid(), ...vals };
    const mins = aiFill && Math.round(Number(aiFill.travel_minutes));
    if (day.items.length && Number.isFinite(mins) && mins > 0) item.travel = { minutes: mins }; // AI 估的車程掛到新停靠點
    day.items.push(item);
    commit(`新增「${vals.title}」到 ${day.name}${aiFill ? "(AI 智慧辨識)" : ""}`);
  }
  $("#item-modal").classList.add("hidden");
  renderPanels();
}

function deleteItem() {
  const { dayId, itemId } = editing;
  const day = data.days.find((d) => d.id === dayId);
  const it = day.items.find((i) => i.id === itemId);
  if (!confirm(`確定刪除「${it.title}」?(修改紀錄會保留這筆操作)`)) return;
  day.items = day.items.filter((i) => i.id !== itemId);
  commit(`刪除 ${day.name}「${it.title}」`);
  $("#item-modal").classList.add("hidden");
  renderPanels();
}

// ─── AI 智慧辨識(DeepSeek 車程估算 + Tavily 景點介紹) ────────
// 一律走 Worker 代理,金鑰留在伺服器端
const aiEndpoint = (svc) => ({ url: PROXY + "/" + svc, headers: { "Content-Type": "application/json" } });

async function runAI() {
  const title = $("#item-title").value.trim();
  if (!title) { toast("請先填寫地點名稱"); return; }
  const status = $("#ai-status");
  const result = $("#ai-result");
  status.classList.remove("hidden");
  result.classList.add("hidden");

  const day = data.days.find((d) => d.id === editing.dayId);
  const prevItem = day.items.length ? day.items[day.items.length - 1] : null;
  const parts = [];

  // 1) Tavily:景點介紹
  {
    status.textContent = "🔍 Tavily 搜尋景點介紹中…";
    try {
      const ep = aiEndpoint("tavily");
      const res = await fetch(ep.url, {
        method: "POST",
        headers: ep.headers,
        body: JSON.stringify({ query: `台灣 ${title} 景點介紹 特色`, search_depth: "basic", include_answer: true, max_results: 3 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.answer) {
        status.textContent = "🈶 整理為繁體中文…";
        const intro = await toTaiwanese(j.answer, aiEndpoint("deepseek")); // 一律轉台灣繁體中文
        $("#item-intro").value = intro;
        parts.push("✅ 已取得景點介紹(Tavily)");
      } else parts.push("⚠️ Tavily 沒有回傳摘要");
    } catch (e) {
      parts.push(`⚠️ Tavily 失敗:${e.message}`);
    }
  }

  // 2) DeepSeek:車程與停留時間估算
  {
    status.textContent = "🧠 DeepSeek 估算車程與停留時間中…";
    try {
      const prompt = [
        `你是台灣自駕旅遊規劃助手。8 人自駕環島,${day.name} 路線:${day.route}。`,
        prevItem ? `前一個行程點:「${prevItem.title}」(${prevItem.time})。` : "這是當天第一個行程點。",
        `新地點:「${title}」。`,
        `請估算:1) 從前一站開車到新地點的分鐘數 2) 該地點的建議停留分鐘數 3) 一句 20 字內的排程建議。`,
        `僅回傳 JSON:{"travel_minutes":數字,"stay_minutes":數字,"advice":"字串"}`,
      ].join("\n");
      const ep = aiEndpoint("deepseek");
      const res = await fetch(ep.url, {
        method: "POST",
        headers: ep.headers,
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const out = JSON.parse(j.choices[0].message.content);
      aiFill = out;
      const suggest = suggestTime(prevItem, out.travel_minutes, out.stay_minutes);
      if (suggest && !$("#item-time-start").value) {
        const [s, e] = suggest.split("-");
        $("#item-time-start").value = s || "";
        $("#item-time-end").value = e || "";
      }
      const noteAdd = `車程約 ${out.travel_minutes} 分鐘,建議停留 ${out.stay_minutes} 分鐘`;
      if (!$("#item-note").value.trim()) $("#item-note").value = noteAdd + (out.advice ? ";" + out.advice : "");
      parts.push(`✅ DeepSeek:${noteAdd}${out.advice ? "。" + out.advice : ""}`);
    } catch (e) {
      parts.push(`⚠️ DeepSeek 失敗:${e.message}`);
    }
  }

  status.classList.add("hidden");
  result.innerHTML = parts.map(esc).join("<br>");
  result.classList.remove("hidden");
}

// 依前一站結束時間 + 車程,推算建議時段字串 "HH:MM-HH:MM"
function suggestTime(prevItem, travelMin, stayMin) {
  if (!prevItem || !travelMin) return "";
  const m = String(prevItem.time).match(/(\d{1,2}):(\d{2})\s*$/);
  if (!m) return "";
  let t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + Number(travelMin);
  const fmt = (x) => `${String(Math.floor((x / 60) % 24)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  const start = fmt(t);
  const end = fmt(t + (Number(stayMin) || 30));
  return `${start}-${end}`;
}

// ─── 天氣預報(Open-Meteo · 免金鑰)───────────────────────────
const WEATHER_POINTS = {
  day1: [["新竹", 24.81, 120.97], ["台南", 22.99, 120.20], ["恆春", 22.00, 120.74]],
  day2: [["恆春", 22.00, 120.74], ["台東", 22.75, 121.15], ["鹿野", 22.91, 121.14]],
  day3: [["台東", 22.75, 121.15], ["成功", 23.10, 121.37], ["花蓮", 23.98, 121.60]],
  day4: [["花蓮", 23.98, 121.60], ["蘇澳", 24.59, 121.85], ["新竹", 24.81, 120.97]],
};

// 地名 → 座標(用於行程卡片的逐時天氣;從卡片標題自動辨識)
const PLACES = [
  ["新竹", 24.81, 120.97], ["竹北", 24.84, 121.00], ["台中", 24.16, 120.65],
  ["台南", 22.99, 120.20], ["國華街", 22.99, 120.20], ["西市場", 22.99, 120.20],
  ["枋山", 22.26, 120.65], ["枋野", 22.26, 120.65], ["愛琴海岸", 22.31, 120.63],
  ["恆春", 22.00, 120.74], ["墾丁", 21.94, 120.79],
  ["台東", 22.75, 121.15], ["鐵花", 22.75, 121.15], ["波浪屋", 22.75, 121.15],
  ["琵琶湖", 22.77, 121.16], ["森林公園", 22.77, 121.16],
  ["鹿野", 22.92, 121.12], ["熱氣球", 22.92, 121.12],
  ["小野柳", 22.79, 121.20], ["加路蘭", 22.81, 121.20], ["都蘭", 22.88, 121.23],
  ["成功", 23.10, 121.37], ["三仙台", 23.12, 121.41],
  ["金剛大道", 23.32, 121.46], ["長濱", 23.32, 121.46],
  ["石梯坪", 23.48, 121.51],
  ["花蓮", 23.98, 121.60], ["東大門", 23.98, 121.61],
  ["七星潭", 24.03, 121.63], ["崇德", 24.17, 121.66], ["清水斷崖", 24.17, 121.66],
  ["台泥", 24.30, 121.76], ["DAKA", 24.30, 121.76], ["和平", 24.30, 121.76],
  ["南方澳", 24.59, 121.86], ["南澳", 24.46, 121.80], ["蘇澳", 24.59, 121.85],
  ["礁溪", 24.83, 121.77],
];

// 從文字辨識地點:取「最後出現」的地名(車程「A → B」因此會取目的地 B)
function matchPlace(text) {
  let best = null, bestEnd = -1, bestLen = 0;
  for (const p of PLACES) {
    const idx = text.lastIndexOf(p[0]);
    if (idx === -1) continue;
    const end = idx + p[0].length;
    if (end > bestEnd || (end === bestEnd && p[0].length > bestLen)) { best = p; bestEnd = end; bestLen = p[0].length; }
  }
  return best;
}

// 解析行程點的起始時間(小時),支援 "HH:MM" 與 "HH:MM-HH:MM"
function itemStartHour(timeStr) {
  const m = String(timeStr || "").match(/(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}

let weather = { fetchedAt: 0, points: {}, hourly: {} };

// WMO 天氣代碼 → 圖示與說明
function wmoIcon(code) {
  if (code === 0) return ["☀️", "晴"];
  if (code <= 1) return ["🌤️", "晴時多雲"];
  if (code <= 2) return ["⛅", "多雲"];
  if (code <= 3) return ["☁️", "陰"];
  if (code <= 48) return ["🌫️", "霧"];
  if (code <= 57) return ["🌦️", "毛毛雨"];
  if (code <= 67) return ["🌧️", "雨"];
  if (code <= 77) return ["🌨️", "雪"];
  if (code <= 82) return ["🌧️", "陣雨"];
  if (code <= 86) return ["🌨️", "陣雪"];
  return ["⛈️", "雷雨"];
}

const TRIP_START = "2026-07-17"; // 出發日固定,不開放修改
function tripStartDate() {
  return new Date(TRIP_START + "T00:00:00");
}
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function fetchWeather(force) {
  if (!force && Date.now() - weather.fetchedAt < 30 * 60_000 && Object.keys(weather.points).length) return;
  try {
    const uniq = new Map();
    Object.values(WEATHER_POINTS).flat().concat(PLACES).forEach((p) => uniq.set(p[1] + "," + p[2], p));
    const pts = [...uniq.values()];
    const url = "https://api.open-meteo.com/v1/forecast"
      + `?latitude=${pts.map((p) => p[1]).join(",")}&longitude=${pts.map((p) => p[2]).join(",")}`
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
      + "&hourly=weather_code,temperature_2m,precipitation_probability"
      + "&timezone=Asia%2FTaipei&forecast_days=16";
    const res = await fetch(url);
    if (!res.ok) return;
    let arr = await res.json();
    if (!Array.isArray(arr)) arr = [arr];
    weather.points = {};
    weather.hourly = {};
    arr.forEach((r, i) => {
      const key = pts[i][1] + "," + pts[i][2];
      weather.points[key] = r.daily;
      weather.hourly[key] = r.hourly;
    });
    weather.fetchedAt = Date.now();
  } catch {}
}

function renderWeather() {
  const start = tripStartDate();
  document.querySelectorAll(".weather-row").forEach((row) => {
    const dayId = row.dataset.wday;
    const idx = data.days.findIndex((d) => d.id === dayId);
    const date = new Date(start); date.setDate(date.getDate() + idx);
    const iso = localISO(date);
    const dateLabel = `${date.getMonth() + 1}/${date.getDate()}`;
    const pts = WEATHER_POINTS[dayId] || [];
    const chips = [];
    for (const [name, lat, lon] of pts) {
      const daily = weather.points[lat + "," + lon];
      if (!daily) continue;
      const di = daily.time.indexOf(iso);
      if (di === -1) continue;
      const [icon, label] = wmoIcon(daily.weather_code[di]);
      chips.push(`<span class="wx-chip" title="${esc(name)} ${label}">${esc(name)} ${icon} ${Math.round(daily.temperature_2m_max[di])}°/${Math.round(daily.temperature_2m_min[di])}° ☔${daily.precipitation_probability_max[di]}%</span>`);
    }
    if (chips.length) {
      row.innerHTML = `<span class="wx-date">🗓️ ${dateLabel}</span>` + chips.join("");
    } else if (Object.keys(weather.points).length) {
      row.innerHTML = `<span class="wx-date">🗓️ ${dateLabel} 距今較遠,進入 16 天預報範圍後自動顯示</span>`;
    } else {
      row.innerHTML = `<span class="wx-date">天氣載入中…</span>`;
    }
  });

  renderItemWeather(start);
}

// 各行程卡片:依「地點 + 該時段」顯示逐時天氣
function renderItemWeather(start) {
  if (!Object.keys(weather.hourly).length) return;
  data.days.forEach((day, idx) => {
    const date = new Date(start); date.setDate(date.getDate() + idx);
    const iso = localISO(date);
    let lastPlace = (WEATHER_POINTS[day.id] || [])[0] || null; // 認不出地名時沿用前一站
    for (const it of day.items) {
      const el = document.querySelector(`.item-wx[data-wxitem="${it.id}"]`);
      const place = matchPlace(it.title + " " + (it.note || "")) || lastPlace;
      lastPlace = place;
      if (!el || !place) continue;
      const hourly = weather.hourly[place[1] + "," + place[2]];
      const hour = itemStartHour(it.time);
      if (!hourly || hour === null) continue;
      const hi = hourly.time.indexOf(`${iso}T${String(hour).padStart(2, "0")}:00`);
      if (hi === -1) continue;
      const [icon, label] = wmoIcon(hourly.weather_code[hi]);
      el.innerHTML = `${icon} ${Math.round(hourly.temperature_2m[hi])}° ☔${hourly.precipitation_probability[hi]}%`;
      el.title = `${place[0]} ${String(hour).padStart(2, "0")}:00 ${label},氣溫 ${Math.round(hourly.temperature_2m[hi])}°C,降雨機率 ${hourly.precipitation_probability[hi]}%`;
    }
  });
}

// ─── 使用者/設定/紀錄 ─────────────────────────────────────────
function showLogin() {
  $("#login-overlay").classList.remove("hidden");
  $("#login-name").value = currentUser || "";
  setTimeout(() => $("#login-name").focus(), 50);
}

function doLogin() {
  const name = $("#login-name").value.trim();
  if (!name) { toast("請輸入名字"); return; }
  currentUser = name;
  localStorage.setItem(LS.user, name);
  $("#login-overlay").classList.add("hidden");
  $("#user-name").textContent = name;
  toast(`👋 歡迎,${name}!`);
}

function openHistory() {
  const list = $("#history-list");
  list.innerHTML = (data.history || []).map((h) => `
    <div class="history-entry">
      <div class="h-meta">${new Date(h.ts).toLocaleString("zh-TW", { hour12: false })}</div>
      <span class="h-user">${esc(h.user)}</span> ${esc(h.text)}
    </div>`).join("") || "<p>還沒有任何修改。</p>";
  $("#history-modal").classList.remove("hidden");
}

// ─── 事件綁定 ─────────────────────────────────────────────────
function bindGlobalEvents() {
  $("#login-btn").onclick = doLogin;
  $("#login-name").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("#btn-user").onclick = showLogin;
  $("#btn-history").onclick = openHistory;

  $("#item-save").onclick = saveItem;
  $("#item-cancel").onclick = () => $("#item-modal").classList.add("hidden");
  $("#item-delete").onclick = deleteItem;
  $("#btn-ai").onclick = runAI;

  document.querySelectorAll(".modal-close").forEach((b) => {
    b.onclick = () => b.closest(".overlay").classList.add("hidden");
  });
  document.querySelectorAll(".overlay").forEach((ov) => {
    ov.addEventListener("mousedown", (e) => {
      if (e.target === ov && ov.id !== "login-overlay") ov.classList.add("hidden");
    });
  });
}

init();
