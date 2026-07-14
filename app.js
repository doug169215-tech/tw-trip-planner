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

  // 綁定行程卡片
  main.querySelectorAll(".item-card").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest(".drag-handle") || e.target.closest("details") || e.target.closest("a")) return;
      openItemModal(card.closest(".item-list").dataset.day, card.dataset.id);
    };
  });
  main.querySelectorAll(".add-item-btn").forEach((btn) => {
    btn.onclick = () => openItemModal(btn.dataset.day, null);
  });

  renderWeather();

  // 拖曳排序(跨天共用群組)
  main.querySelectorAll(".item-list").forEach((list) => {
    sortables.push(new Sortable(list, {
      group: "trip-items",
      handle: ".drag-handle",
      animation: 150,
      forceFallback: true,      // 統一使用滑鼠/觸控模擬,手機拖曳更可靠
      fallbackTolerance: 3,
      delayOnTouchOnly: 150,    // 觸控長按 150ms 才開始拖,避免誤觸捲動
      onEnd: onDragEnd,
    }));
  });
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
    </div>
    <div class="day-head">
      <h2>✅ 行前確認清單</h2>
      ${data.preTrip.map((p) => `
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
    </div>
    <div class="item-list" data-day="${day.id}">
      ${day.items.map(renderItem).join("")}
    </div>
    <button class="add-item-btn" data-day="${day.id}">＋ 新增地點(可用 AI 智慧辨識)</button>
    <div class="day-extras">
      ${renderRestaurants(day)}
      ${renderList("🧭 沿途備選", day.alternates)}
      ${renderList("⏱️ 時間控制", day.timeControls)}
    </div>
  </section>`;
}

function renderItem(it) {
  // 景點/餐食/可辨識地名的行程點,附 Google Maps 連結(車程與整備不附)
  const mappable = it.type !== "transport" && it.type !== "prep" && (it.type === "spot" || it.type === "meal" || matchPlace(it.title));
  const mapLink = mappable
    ? `<a class="map-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.title)}" target="_blank" rel="noopener" title="在 Google Maps 開啟「${esc(it.title)}」">📍</a>`
    : "";
  return `
  <div class="item-card" data-id="${it.id}" data-type="${esc(it.type)}">
    <span class="drag-handle" title="拖曳調整順序">⠿</span>
    <div class="item-body">
      <div class="item-top">
        <span class="item-time">${esc(it.time)}</span>
        <span class="item-title">${esc(it.title)}</span>${mapLink}
        <span class="type-badge">${TYPE_LABEL[it.type] || "行程"}</span>
        <span class="item-wx" data-wxitem="${it.id}"></span>
      </div>
      ${it.note ? `<p class="item-note">${esc(it.note)}</p>` : ""}
      ${it.intro ? `<details class="item-intro"><summary>景點介紹</summary>${esc(it.intro)}</details>` : ""}
    </div>
  </div>`;
}

function renderRestaurants(day) {
  if (!day.restaurants || !day.restaurants.length) return "";
  const body = day.restaurants.map((r) => `
    <p class="resto-meal">${esc(r.meal)}</p>
    <ul>
      ${r.first.map((x) => `<li><span class="resto-tag tag-first">首選</span>${esc(x)}</li>`).join("")}
      ${r.backup.map((x) => `<li><span class="resto-tag tag-backup">備案</span>${esc(x)}</li>`).join("")}
    </ul>`).join("");
  return `<div class="extra-block"><h3>🍽️ 餐廳推薦</h3>${body}</div>`;
}

function renderList(title, arr) {
  if (!arr || !arr.length) return "";
  return `<div class="extra-block"><h3>${title}</h3><ul>${arr.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`;
}

// ─── 拖曳 ─────────────────────────────────────────────────────
function onDragEnd(evt) {
  const fromDay = evt.from.dataset.day;
  const toDay = evt.to.dataset.day;
  const itemId = evt.item.dataset.id;
  if (fromDay === toDay && evt.oldIndex === evt.newIndex) return;

  const from = data.days.find((d) => d.id === fromDay);
  const to = data.days.find((d) => d.id === toDay);
  const idx = from.items.findIndex((i) => i.id === itemId);
  const [moved] = from.items.splice(idx, 1);
  to.items.splice(evt.newIndex, 0, moved);

  const msg = fromDay === toDay
    ? `調整「${moved.title}」在 ${to.name} 的順序(第 ${evt.oldIndex + 1} → 第 ${evt.newIndex + 1})`
    : `將「${moved.title}」從 ${from.name} 移到 ${to.name}`;
  commit(msg);
  renderPanels();
  toast("已記錄:" + msg);
}

// ─── 行程點編輯 ───────────────────────────────────────────────
function openItemModal(dayId, itemId) {
  editing = { dayId, itemId };
  aiFill = null;
  const day = data.days.find((d) => d.id === dayId);
  const it = itemId ? day.items.find((i) => i.id === itemId) : null;

  $("#item-modal-title").textContent = it ? `編輯行程點(${day.name})` : `新增地點到 ${day.name}`;
  $("#item-time").value = it ? it.time : "";
  $("#item-title").value = it ? it.title : "";
  $("#item-type").value = it ? it.type : "spot";
  $("#item-note").value = it ? it.note : "";
  $("#item-intro").value = it ? it.intro : "";
  $("#item-delete").classList.toggle("hidden", !it);
  $("#ai-status").classList.add("hidden");
  $("#ai-result").classList.add("hidden");
  $("#item-modal").classList.remove("hidden");
}

function saveItem() {
  const { dayId, itemId } = editing;
  const day = data.days.find((d) => d.id === dayId);
  const vals = {
    time: $("#item-time").value.trim(),
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
    day.items.push({ id: uid(), ...vals });
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
        let intro = j.answer;
        // Tavily 偶爾回英文:偵測到大量英文就交給 DeepSeek 翻成繁體中文
        const latin = (intro.match(/[A-Za-z]/g) || []).length;
        if (latin > intro.length * 0.3) {
          status.textContent = "🈶 翻譯景點介紹為中文…";
          try {
            const dep = aiEndpoint("deepseek");
            const tr = await fetch(dep.url, {
              method: "POST",
              headers: dep.headers,
              body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{ role: "user", content: `將以下景點介紹翻譯成繁體中文,語氣自然,只回傳譯文:\n\n${intro}` }],
                temperature: 0.2,
              }),
            });
            if (tr.ok) intro = (await tr.json()).choices[0].message.content.trim();
          } catch {}
        }
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
      if (suggest && !$("#item-time").value.trim()) $("#item-time").value = suggest;
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
