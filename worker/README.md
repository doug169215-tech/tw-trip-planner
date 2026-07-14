# AI 代理 Worker 部署指南(免安裝任何工具)

讓團員不需要 API 金鑰也能使用 AI 智慧辨識:金鑰藏在 Cloudflare Worker,團員只需填「團隊通行碼」。

```
團員瀏覽器 → Cloudflare Worker(金鑰在伺服器端)→ DeepSeek / Tavily
```

三道防護:CORS 鎖定只接受行程板網頁的請求、團隊通行碼驗證、每分鐘限流。

## 部署步驟(用瀏覽器儀表板,約 5 分鐘)

1. 註冊/登入 [Cloudflare](https://dash.cloudflare.com)(免費方案即可)
2. 左側選 **Workers & Pages** → **Create** → **Create Worker** → 取名(例:`trip-ai-proxy`)→ **Deploy**
3. 點 **Edit code**,把 [`worker.js`](./worker.js) 的內容全部貼上覆蓋 → **Deploy**
4. 回到 Worker 頁面 → **Settings** → **Variables and Secrets** → 新增 3 個 **Secret**:
   | 名稱 | 值 |
   |---|---|
   | `DEEPSEEK_KEY` | 你的 DeepSeek API Key(sk-…) |
   | `TAVILY_KEY` | 你的 Tavily API Key(tvly-…) |
   | `TEAM_CODE` | 自訂通行碼,例:`huandao2026` |
5. 記下 Worker 網址,例:`https://trip-ai-proxy.<你的帳號>.workers.dev`

## 團員如何使用

到行程板網頁 → **⚙️ 設定** → 「AI 代理(推薦)」區塊填:

- **Worker 代理網址**:`https://trip-ai-proxy.<你的帳號>.workers.dev`
- **團隊通行碼**:你訂的 `TEAM_CODE`

填了代理就**不需要**填 DeepSeek / Tavily 金鑰。

## 安全性說明

- 金鑰只存在 Cloudflare Secret,永遠不會出現在網頁或團員瀏覽器
- 通行碼若外流,別人也只能透過你的 Worker 用(且有限流),換一個 `TEAM_CODE` 即可,金鑰不用換
- 免費額度每天 100,000 次請求,這個用途綽綽有餘
- 限流是單節點盡力而為;若要嚴格限流可加 Cloudflare Rate Limiting 規則

🤖 Generated with [Claude Code](https://claude.com/claude-code)
