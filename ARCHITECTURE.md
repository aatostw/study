# 學習筆記：程式結構

| 部分 | 在哪裡 | 做什麼 |
|---|---|---|
| 網頁 App | 這個 repo 的根目錄（GitHub Pages，`CNAME`） | 畫面；資料不存在手機，全部即時跟電腦要 |
| 守門員 | `worker/study-api.js`（Cloudflare Worker） | 登入（30 天通行證）、把請求加上電腦密碼後轉給電腦 |
| 電腦 | `server/`（FastAPI，127.0.0.1:9882，Tunnel `study-pc`） | 資料庫、Whisper、向量、AI 呼叫、工作佇列、朗讀 |

## 網頁（依載入順序，一般 `<script>`，共用全域變數，不需要建置）

| 檔案 | 內容 |
|---|---|
| `js/core.js` | 狀態 `S`、小工具、`api()`、`render()`、`go()`、圖示 |
| `js/upload.js` | `Up`：分塊上傳（32 MB／塊，失敗重傳）、照片縮圖 |
| `js/pages.js` | 載入資料、問答、書櫃、單本書、筆記、朗讀頁 |
| `js/lecture.js` | 課程列表、上傳表單、單堂課（摘要／逐字稿／提問）、播放器 |
| `js/settings.js` | 設定頁：電腦狀態、AI 金鑰、每項工作的模型 |
| `js/actions.js` | 登入畫面、`ACT`（所有 `data-act` 按鈕）、朗讀播放、工作輪詢、啟動 |
| `css/app.css` | 全部樣式（沿用每日英文練習的配色與元件） |

慣例跟每日英文一樣：畫面都是字串組 HTML，按鈕用 `data-act="名稱"`，動作寫在 `ACT`。

## 電腦端 `server/`

| 檔案 | 內容 |
|---|---|
| `study_config.py` | **唯一需要改的設定** |
| `study_server.py` | 啟動：資料庫、背景工作、API、Tunnel；`--setup` 設定固定網址 |
| `schema.sql` | 資料表：books、notes、lectures、segments、chunks（向量）、jobs、asks、settings |
| `app/api.py` | 所有 HTTP 路徑 |
| `app/jobs.py` | 背景工作：課程（轉檔→逐字稿→索引→摘要）、重新摘要、PDF/EPUB 索引、書籍分析 |
| `app/knowledge.py` | 筆記索引、語意搜尋、有出處的問答 |
| `app/engines.py` | Whisper、bge-m3、ffmpeg |
| `app/ai.py` | Gemini／Anthropic／OpenAI／自訂 OpenAI 相容；每項工作各自的模型 |
| `app/tts.py` | 呼叫 GPT-SoVITS api_v2（9880），沿用 voice_server.py 的參考音檔 |
| `app/textutil.py` | 繁體轉換、時間格式、切段、讀 PDF/EPUB |
| `app/fake.py` | 測試模式的假結果 |

## 主要路徑（都要經過 Worker）

`/status` `/settings` `/ai/models` `/ai/test` ·
`/books` `/books/{id}` `/books/{id}/notes` `/notes/{id}` `/books/{id}/analyze` `/books/{id}/export` `/ocr` ·
`/uploads` `/uploads/{id}/{i}` `/uploads/{id}/finish` `/inbox` `/inbox/import` ·
`/lectures` `/lectures/{id}` `/lectures/{id}/audio` `/lectures/{id}/resummarize` `/lectures/{id}/retranscribe` `/lectures/{id}/export` ·
`/jobs` `/jobs/{id}/retry` · `/ask` `/asks` `/search` · `/tts/split` `/tts/audio` `/tts/full`

## 安全

- 電腦端只聽 127.0.0.1，外面只能透過 Tunnel 進來，而且每個請求都要帶 `X-Study-Key`（32 字元亂碼，只存在電腦和 Worker Secret）。
- 手機只拿得到 Worker 簽發的通行證；改 `STUDY_PASSWORD`，舊通行證全部失效。
- AI 金鑰存在電腦的資料庫，App 只看得到最後 4 碼。
- 想再加一層：在 Cloudflare Zero Trust 為 `study-pc.natursai.com` 加 Access 應用程式（Service Auth），把 Service Token 填到 Worker 的 `ACCESS_CLIENT_ID`／`ACCESS_CLIENT_SECRET`。
