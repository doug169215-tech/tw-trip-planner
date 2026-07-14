// 環島行程協作板 · AI 代理 Worker
// 把 DeepSeek / Tavily 金鑰藏在伺服器端;來源鎖定行程板網頁,免通行碼。
//
// 需要設定的 Secrets(Cloudflare 儀表板 → Worker → Settings → Variables and Secrets):
//   DEEPSEEK_KEY  = 你的 DeepSeek API Key
//   TAVILY_KEY    = 你的 Tavily API Key

const ALLOWED_ORIGINS = [
  "https://doug169215-tech.github.io", // 行程板網頁
];
const LIMIT_PER_MIN = 30; // 粗略限流:每分鐘最多 30 次(單一節點,盡力而為)

let windowStart = 0;
let count = 0;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "只接受 POST" }, 405, cors);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "來源不在允許清單" }, 403, cors);

    // 粗略限流(每分鐘視窗)
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; count = 0; }
    if (++count > LIMIT_PER_MIN) return json({ error: "請求太頻繁,稍等一下" }, 429, cors);

    const path = new URL(req.url).pathname;
    let upstream, auth;
    if (path === "/deepseek") {
      upstream = "https://api.deepseek.com/chat/completions";
      auth = env.DEEPSEEK_KEY;
    } else if (path === "/tavily") {
      upstream = "https://api.tavily.com/search";
      auth = env.TAVILY_KEY;
    } else {
      return json({ error: "路徑不存在(用 /deepseek 或 /tavily)" }, 404, cors);
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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
