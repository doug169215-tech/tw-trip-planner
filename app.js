/* 四天三夜環島 · 行程協作板 */
"use strict";

// ─── 常數與狀態 ───────────────────────────────────────────────
const GH = { owner: "doug169215-tech", repo: "tw-trip-planner", branch: "main", path: "data.json" };
const LS = { data: "ttp.data", user: "ttp.user", settings: "ttp.settings" };
const TYPE_EMOJI = { spot: "🏞️", meal: "🍜", transport: "🚗", stay: "🏠", prep: "🧳" };
const TYPE_LABEL = { spot: "景點", meal: "餐食", transport: "車程", stay: "住宿/休息", prep: "整備" };

let data = null;          // 行程資料(含 history)
let currentUser = null;
let settings = { deepseek: "", tavily: "", ghtoken: "", proxy: "", teamcode: "" };
let dirty = false;        // 本機有未同步修改
let activeDay = "overview";
let editing = null;       // { dayId, itemId } 或 { dayId, itemId:null }(新增)
let aiFill = null;        // AI 辨識結果暫存
let sortables = [];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ─── 初始化 ───────────────────────────────────────────────────
async function init() {
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(LS.settings) || "{}") }; } catch {}
  currentUser = localStorage.getItem(LS.user) || null;

  await loadData();
  bindGlobalEvents();
  renderAll();

  if (!currentUser) showLogin();
}

async function loadData() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LS.data) || "null"); } catch {}

  let remote = null;
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) remote = await res.json();
  } catch {}

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
  updateSyncBadge();
}

function updateSyncBadge() {
  const b = $("#sync-badge");
  b.classList.toggle("dirty", dirty);
  b.title = dirty ? "本機有未同步的修改(按「同步到 GitHub」分享給團員)" : "已與線上版本一致";
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
      if (e.target.closest(".drag-handle") || e.target.closest("details")) return;
      openItemModal(card.closest(".item-list").dataset.day, card.dataset.id);
    };
  });
  main.querySelectorAll(".add-item-btn").forEach((btn) => {
    btn.onclick = () => openItemModal(btn.dataset.day, null);
  });

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
    `<tr><td><b>${esc(d.name)}</b><br><small>${esc(d.weekday)}</small></td><td>${esc(d.route)}</td><td>${esc(d.lodging || "—")}</td></tr>`
  ).join("");
  return `
  <section class="day-panel ${act}" data-panel="overview">
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

function renderDay(day) {
  const act = activeDay === day.id ? "active" : "";
  return `
  <section class="day-panel ${act}" data-panel="${day.id}">
    <div class="day-head">
      <h2>${esc(day.name)}(${esc(day.weekday)})|${esc(day.title)}</h2>
      <p class="day-route">${esc(day.route)}</p>
      ${day.lodging ? `<p class="day-lodging">🏠 住宿:${esc(day.lodging)}</p>` : ""}
      ${(day.trafficTips || []).map((t) => `<div class="traffic-tip">🚦 ${esc(t)}</div>`).join("")}
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
  return `
  <div class="item-card" data-id="${it.id}" data-type="${esc(it.type)}">
    <span class="drag-handle" title="拖曳調整順序">⠿</span>
    <div class="item-body">
      <div class="item-top">
        <span class="item-time">${esc(it.time)}</span>
        <span class="item-title">${esc(it.title)}</span>
        <span class="type-badge">${TYPE_LABEL[it.type] || "行程"}</span>
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
// 代理模式:填了 Worker 網址+通行碼,金鑰留在伺服器端
const useProxy = () => !!(settings.proxy && settings.teamcode);
const aiEndpoint = (svc) => useProxy()
  ? { url: settings.proxy.replace(/\/+$/, "") + "/" + svc, headers: { "Content-Type": "application/json", "X-Team-Code": settings.teamcode } }
  : svc === "deepseek"
    ? { url: "https://api.deepseek.com/chat/completions", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.deepseek}` } }
    : { url: "https://api.tavily.com/search", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.tavily}` } };

async function runAI() {
  const title = $("#item-title").value.trim();
  if (!title) { toast("請先填寫地點名稱"); return; }
  if (!useProxy() && !settings.deepseek && !settings.tavily) {
    toast("請先到 ⚙️ 設定填入 Worker 代理(向團長索取)或 API Key");
    return;
  }
  const status = $("#ai-status");
  const result = $("#ai-result");
  status.classList.remove("hidden");
  result.classList.add("hidden");

  const day = data.days.find((d) => d.id === editing.dayId);
  const prevItem = day.items.length ? day.items[day.items.length - 1] : null;
  const parts = [];

  // 1) Tavily:景點介紹
  if (useProxy() || settings.tavily) {
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
        $("#item-intro").value = j.answer;
        parts.push("✅ 已取得景點介紹(Tavily)");
      } else parts.push("⚠️ Tavily 沒有回傳摘要");
    } catch (e) {
      parts.push(`⚠️ Tavily 失敗:${e.message}`);
    }
  }

  // 2) DeepSeek:車程與停留時間估算
  if (useProxy() || settings.deepseek) {
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

// ─── GitHub 同步 ──────────────────────────────────────────────
const b64encode = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

async function pushRemote() {
  if (!settings.ghtoken) {
    toast("請先到 ⚙️ 設定填入 GitHub Token 才能同步");
    openSettings();
    return;
  }
  const btn = $("#btn-push");
  btn.disabled = true; btn.textContent = "⬆️ 同步中…";
  try {
    const api = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
    const headers = { "Authorization": `Bearer ${settings.ghtoken}`, "Accept": "application/vnd.github+json" };

    // 取得遠端 sha 與版本
    let sha = null;
    const get = await fetch(`${api}?ref=${GH.branch}&t=${Date.now()}`, { headers });
    if (get.ok) {
      const gj = await get.json();
      sha = gj.sha;
      try {
        const remote = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(gj.content.replace(/\n/g, "")), (c) => c.charCodeAt(0))));
        if (new Date(remote.updatedAt) > new Date(data.updatedAt)) {
          if (!confirm("線上版本比你的還新(可能有團員剛改過)。仍要用你的版本覆蓋嗎?\n建議先按「取得最新行程」。")) {
            btn.disabled = false; btn.textContent = "⬆️ 同步到 GitHub";
            return;
          }
        }
      } catch {}
    }

    const lastAction = data.history[0] ? data.history[0].text : "更新行程";
    const put = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `${currentUser || "訪客"}: ${lastAction}`,
        content: b64encode(JSON.stringify(data, null, 2)),
        branch: GH.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) {
      const err = await put.json().catch(() => ({}));
      throw new Error(`HTTP ${put.status} ${err.message || ""}`);
    }
    dirty = false;
    localStorage.setItem(LS.data, JSON.stringify(data));
    updateSyncBadge();
    toast("✅ 已同步到 GitHub,團員按「取得最新行程」即可看到");
  } catch (e) {
    toast("❌ 同步失敗:" + e.message, 4200);
  }
  btn.disabled = false; btn.textContent = "⬆️ 同步到 GitHub";
}

async function pullRemote() {
  const btn = $("#btn-pull");
  btn.disabled = true; btn.textContent = "⬇️ 取得中…";
  try {
    // 優先走 raw(免 token);GitHub Pages 部署後也可直接抓同源 data.json
    let remote = null;
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/${GH.path}?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) remote = await res.json();
    } catch {}
    if (!remote) {
      const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) remote = await res.json();
    }
    if (!remote) throw new Error("無法取得線上版本");

    if (dirty && new Date(data.updatedAt) > new Date(remote.updatedAt)) {
      if (!confirm("你有尚未同步的本機修改,取得線上版本會覆蓋它們。確定要繼續嗎?")) {
        btn.disabled = false; btn.textContent = "⬇️ 取得最新行程";
        return;
      }
    }
    data = remote;
    dirty = false;
    localStorage.setItem(LS.data, JSON.stringify(data));
    renderAll();
    toast("✅ 已更新為線上最新行程");
  } catch (e) {
    toast("❌ " + e.message, 4000);
  }
  btn.disabled = false; btn.textContent = "⬇️ 取得最新行程";
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

function openSettings() {
  $("#set-proxy").value = settings.proxy;
  $("#set-teamcode").value = settings.teamcode;
  $("#set-deepseek").value = settings.deepseek;
  $("#set-tavily").value = settings.tavily;
  $("#set-ghtoken").value = settings.ghtoken;
  $("#settings-modal").classList.remove("hidden");
}

function saveSettings() {
  settings.proxy = $("#set-proxy").value.trim();
  settings.teamcode = $("#set-teamcode").value.trim();
  settings.deepseek = $("#set-deepseek").value.trim();
  settings.tavily = $("#set-tavily").value.trim();
  settings.ghtoken = $("#set-ghtoken").value.trim();
  localStorage.setItem(LS.settings, JSON.stringify(settings));
  $("#settings-modal").classList.add("hidden");
  toast("✅ 設定已儲存(僅存於此瀏覽器)");
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

function exportJSON() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `環島行程-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const j = JSON.parse(reader.result);
      if (!j.days || !Array.isArray(j.days)) throw new Error("格式不符");
      data = j;
      commit("匯入 JSON 行程檔");
      renderAll();
      toast("✅ 已匯入");
    } catch (e) { toast("❌ 匯入失敗:" + e.message); }
  };
  reader.readAsText(file);
}

function resetData() {
  if (!confirm("確定重設為預設行程?你的本機修改將被清除(線上版本不受影響)。")) return;
  data = structuredClone(window.DEFAULT_DATA);
  commit("重設為預設行程");
  renderAll();
  toast("已重設");
}

// ─── 事件綁定 ─────────────────────────────────────────────────
function bindGlobalEvents() {
  $("#login-btn").onclick = doLogin;
  $("#login-name").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("#btn-user").onclick = showLogin;
  $("#btn-settings").onclick = openSettings;
  $("#settings-save").onclick = saveSettings;
  $("#btn-history").onclick = openHistory;
  $("#btn-push").onclick = pushRemote;
  $("#btn-pull").onclick = pullRemote;

  $("#item-save").onclick = saveItem;
  $("#item-cancel").onclick = () => $("#item-modal").classList.add("hidden");
  $("#item-delete").onclick = deleteItem;
  $("#btn-ai").onclick = runAI;

  $("#btn-export").onclick = exportJSON;
  $("#btn-import").onclick = () => $("#import-file").click();
  $("#import-file").onchange = (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; };
  $("#btn-reset").onclick = resetData;

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
