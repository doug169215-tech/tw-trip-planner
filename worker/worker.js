// 環島行程協作板 · AI 代理 + 行程同步 Worker
// 金鑰全部藏在伺服器端;來源鎖定行程板網頁,免通行碼。
//
// 需要設定的 Secrets(Cloudflare 儀表板 → Worker → Settings → Variables and Secrets):
//   DEEPSEEK_KEY  = DeepSeek API Key(車程/停留估算)
//   TAVILY_KEY    = Tavily API Key(景點介紹)
//   GITHUB_TOKEN  = GitHub fine-grained token,僅授權 tw-trip-planner 的 Contents 讀寫(行程自動同步)

const ALLOWED_ORIGINS = [
  "https://doug169215-tech.github.io", // 行程板網頁
];
const GH = { owner: "doug169215-tech", repo: "tw-trip-planner", branch: "main", path: "data.json" };
const LIMIT_PER_MIN = 60; // 粗略限流(單一節點,盡力而為)

let windowStart = 0;
let count = 0;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "來源不在允許清單" }, 403, cors);

    // 粗略限流(每分鐘視窗)
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; count = 0; }
    if (++count > LIMIT_PER_MIN) return json({ error: "請求太頻繁,稍等一下" }, 429, cors);

    const path = new URL(req.url).pathname;

    // ── 行程資料:讀取(GET /data)──
    if (path === "/data" && req.method === "GET") {
      if (!env.GITHUB_TOKEN) return json({ error: "Worker 尚未設定 GITHUB_TOKEN" }, 500, cors);
      const r = await ghContents("GET", null, env);
      if (!r.ok) return json({ error: `GitHub 讀取失敗(${r.status})` }, 502, cors);
      const j = await r.json();
      const content = fromB64(j.content);
      return new Response(content, { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ── 行程資料:自動上傳(POST /sync)──
    if (path === "/sync" && req.method === "POST") {
      if (!env.GITHUB_TOKEN) return json({ error: "Worker 尚未設定 GITHUB_TOKEN" }, 500, cors);
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON 格式錯誤" }, 400, cors); }
      if (!body || !Array.isArray(body.days)) return json({ error: "缺少 days 陣列" }, 400, cors);
      const text = JSON.stringify(body, null, 2);
      if (text.length > 900_000) return json({ error: "資料過大" }, 413, cors);

      // 取得現有檔案 sha(檔案不存在則為新建)
      let sha;
      const cur = await ghContents("GET", null, env);
      if (cur.ok) sha = (await cur.json()).sha;

      const who = String(body.history?.[0]?.user || "團員").slice(0, 20);
      const what = String(body.history?.[0]?.text || "更新行程").slice(0, 80);
      const put = await ghContents("PUT", {
        message: `${who}: ${what}`,
        content: toB64(text),
        branch: GH.branch,
        ...(sha ? { sha } : {}),
      }, env);
      if (!put.ok) {
        const err = await put.json().catch(() => ({}));
        return json({ error: `GitHub 寫入失敗(${put.status})${err.message ? ":" + err.message : ""}` }, 502, cors);
      }
      return json({ ok: true, updatedAt: body.updatedAt }, 200, cors);
    }

    // ── AI 代理(POST /deepseek、/tavily)──
    if (req.method !== "POST") return json({ error: "只接受 POST" }, 405, cors);
    let upstream, auth;
    if (path === "/deepseek") {
      upstream = "https://api.deepseek.com/chat/completions";
      auth = env.DEEPSEEK_KEY;
    } else if (path === "/tavily") {
      upstream = "https://api.tavily.com/search";
      auth = env.TAVILY_KEY;
    } else {
      return json({ error: "路徑不存在(/deepseek、/tavily、/data、/sync)" }, 404, cors);
    }
    if (!auth) return json({ error: `Worker 尚未設定 ${path === "/deepseek" ? "DEEPSEEK_KEY" : "TAVILY_KEY"}` }, 500, cors);

    const res = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${auth}` },
      body: await req.text(),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};

function ghContents(method, bodyObj, env) {
  return fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}${method === "GET" ? `?ref=${GH.branch}&t=${Date.now()}` : ""}`, {
    method,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "trip-ai-proxy",
    },
    ...(bodyObj ? { body: JSON.stringify(bodyObj) } : {}),
  });
}

// UTF-8 安全的 base64 轉換(分段避免堆疊溢位)
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
