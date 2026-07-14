# 四天三夜環島|行程協作板 🚗🏝️

8 人自駕環島(海線主軸版)的多人行程協作網頁,部署於 GitHub Pages。

## 功能

- **多人使用**:進入時只需輸入名字(免密碼),所有修改都會標記操作者
- **拖曳修改行程**:拖曳卡片左側 `⠿` 調整順序,支援跨天移動
- **修改紀錄**:應用內「📜 紀錄」保留誰在何時改了什麼;同步到 GitHub 時亦以 git commit 留痕
- **AI 智慧辨識**(新增地點時):
  - **DeepSeek**:估算前一站到新地點的車程分鐘數、建議停留時間,自動帶入建議時段
  - **Tavily**:自動搜尋並填入景點介紹
- **全團同步**:行程資料存於本 repo 的 `data.json`;讀取免登入,寫入需在「⚙️ 設定」填入 GitHub token

## 使用方式

1. 開啟網頁 → 輸入你的名字
2. 拖曳/點擊卡片修改行程,「＋ 新增地點」可用 AI 智慧辨識
3. 改完按「⬆️ 同步到 GitHub」分享給團員;其他人按「⬇️ 取得最新行程」

## 設定(⚙️)

| 項目 | 用途 | 取得方式 |
|---|---|---|
| DeepSeek API Key | 車程/停留時間估算 | https://platform.deepseek.com |
| Tavily API Key | 景點介紹搜尋 | https://tavily.com |
| GitHub Token | 寫入 `data.json`(同步行程) | GitHub → Settings → Developer settings → Fine-grained token,僅授權本 repo 的 Contents 讀寫 |

所有金鑰僅儲存在你自己瀏覽器的 localStorage,不會上傳到任何地方(API 呼叫直接由瀏覽器發出)。

## 資料來源

行程整合自兩份規劃文件:「四天三夜環島完整行程・海線主軸版」(主軸)+「四天三夜半島大環線完整行程表」(餐廳首選/備案與路況提示)。

## 技術

純靜態網頁(HTML/CSS/JS),無建置步驟;拖曳排序使用 [SortableJS](https://github.com/SortableJS/Sortable)。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
