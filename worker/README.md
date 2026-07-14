# AI 代理 Worker(trip-ai-proxy)

讓團員不需要 API 金鑰就能使用 AI 智慧辨識:金鑰藏在 Cloudflare Worker,行程板網頁已內建代理網址,**開箱即用、免任何設定**。

```
團員瀏覽器 → Cloudflare Worker(金鑰在伺服器端)→ DeepSeek / Tavily
```

防護:CORS 鎖定只接受行程板網頁(github.io)的請求 + 每分鐘限流 30 次。

## 目前部署

- Worker 名稱:`trip-ai-proxy`
- 網址:`https://trip-ai-proxy.doug169215.workers.dev`
- 路徑:`POST /deepseek`(轉發 DeepSeek chat/completions)、`POST /tavily`(轉發 Tavily search)
- Secrets:`DEEPSEEK_KEY`、`TAVILY_KEY`(儀表板 → Worker → Settings → Variables and Secrets)

## 更新部署(程式碼有改時)

```bash
cd worker
npx wrangler deploy
```

(首次需 `npx wrangler login` 以瀏覽器授權)

## 安全性說明

- 金鑰只存在 Cloudflare Secret,永遠不會出現在網頁或團員瀏覽器
- 瀏覽器端受 CORS 限制,只有行程板網頁能呼叫
- 注意:非瀏覽器的程式(如 curl)可偽造來源標頭,因此代理網址本身請只分享給團員;DeepSeek 為預付儲值制,最壞情況損失以餘額為上限,建議小額儲值
- 免費額度每天 100,000 次請求

🤖 Generated with [Claude Code](https://claude.com/claude-code)
