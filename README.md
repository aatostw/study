# 學習筆記（study.natursai.com）

你的個人學習 App，有三個功能：

1. **讀書筆記知識庫**：打字、貼上、拍照辨識畫線段落，或上傳整本 PDF／EPUB。AI 會分析每本書，也能回答你的問題，每個說法都附上出處（書名、頁碼、筆記）。
2. **課程錄音整理**：上傳錄音或影片，電腦會轉成逐字稿，再由 AI 依主題分成單元，整理出細節、術語和複習問題。每個重點都有時間戳，點一下就跳到錄音的那個地方。
3. **朗讀**：輸入文字，用你自己的 GPT-SoVITS 聲音唸出來，也可以下載成 wav。

整體架構跟「每日英文練習」一樣：網頁放在 GitHub Pages，Cloudflare Worker 當守門員，真正的運算和資料都在你的電腦。

```
手機 ──► study.natursai.com（GitHub Pages：這個 repo 的根目錄）
   └──► study-api.natursai.com（Cloudflare Worker：登入、轉接）
            └──► study-pc.natursai.com（Cloudflare Tunnel）
                     └──► 你的電腦 127.0.0.1:9882（server/study_server.py）
                              ├─ PostgreSQL + pgvector（Docker）
                              ├─ Whisper 轉逐字稿、bge-m3 語意搜尋（RTX 4080 Super）
                              └─ GPT-SoVITS api_v2（127.0.0.1:9880，由「啟動語音伺服器.bat」開啟）
```

---

## 一、電腦端（只要做一次）

1. **放好資料夾**：把 `server` 資料夾複製到電腦上，例如 `D:\Study Natursai\server`。
2. **安裝三樣軟體**（開「命令提示字元」執行）：
   ```
   winget install Python.Python.3.11
   winget install Docker.DockerDesktop
   winget install Gyan.FFmpeg
   ```
   Docker Desktop 裝好後打開一次，等它顯示 *Engine running*。設定裡記得勾選「開機時啟動」。
3. **看一下 `study_config.py`**：GPT-SoVITS 資料夾、資料存放位置（預設 `D:\Study Natursai\data`）、固定網址。一般不用改。
4. **依序雙擊**：
   - `安裝.bat`：安裝 Python 套件，包含有 CUDA 的 PyTorch，大約 3 GB。
   - `安裝資料庫.bat`：在 Docker 裡開 PostgreSQL + pgvector。
   - `設定固定網址.bat`：建立 Tunnel `study-pc`，把 study-pc.natursai.com 指到這台電腦。語音伺服器登入過 Cloudflare，這次不用再登入。
   - `啟動學習伺服器.bat`：視窗最後會顯示**電腦網址**和**電腦密碼**，下一步要用。
5. **（建議）** 雙擊 `設定開機自動啟動.bat`，電腦登入後會自動開學習伺服器和語音伺服器。

第一次處理課程時，電腦會自動下載模型，請稍等：
- Whisper：已經有 GPT-SoVITS 下載的 large-v3-turbo，會直接沿用。
- 向量模型 bge-m3：約 2.3 GB。

## 二、Cloudflare Worker「study-api」

步驟跟當初設定 eel-api 一樣：

1. Cloudflare → **Workers & Pages** → **Create** → **Worker**，取名 `study-api`。
2. **Edit code**：把 `worker/study-api.js` 整個貼上，按 **Deploy**。
3. **Settings → Variables and Secrets**：

   | 名稱 | 類型 | 值 |
   |---|---|---|
   | `ORIGIN` | Text | `https://study-pc.natursai.com` |
   | `ALLOW_ORIGIN` | Text | `https://study.natursai.com` |
   | `STUDY_PASSWORD` | Secret | 你登入 App 用的密碼（長一點） |
   | `STUDY_KEY` | Secret | 電腦視窗顯示的「電腦密碼」 |
   | `TOKEN_SECRET` | Secret | 隨便一長串亂碼 |

4. **Settings → Domains & Routes** → Add → **Custom domain**：填 `study-api.natursai.com`。

如果你習慣用指令，也可以在 `worker` 資料夾執行 `npx wrangler deploy`，設定已經寫在 `wrangler.toml`。

## 三、GitHub Pages（網頁）

1. 在 GitHub 開一個新 repo，例如 `study`，把這個資料夾整個推上去。
2. **Settings → Pages**：Source 選 `main` 分支的 `/ (root)`。`CNAME` 檔已經寫好 `study.natursai.com`。
3. Cloudflare DNS 新增一筆 `CNAME study → <你的帳號>.github.io`，跟 english 那筆一樣。

`server/` 和 `worker/` 裡只有程式碼，沒有任何密碼。電腦密碼、AI 金鑰和資料都只在你的電腦上，`.gitignore` 也已經排除了它們。

## 四、開始使用

1. 打開 https://study.natursai.com，用 `STUDY_PASSWORD` 登入。
2. **設定 → AI 金鑰**：填你要用的那幾家（Gemini、Claude、OpenAI，或本機 Ollama）。
3. **設定 → 每項工作的模型**：選服務 → 按「載入清單」→ 挑模型 → 按「測試」→ 儲存。
   - 課程摘要：建議選比較強的模型，整堂課的細節才抓得到。
   - 拍照辨識：要選能看圖的模型。
4. 到「書櫃」新增一本書，或到「課程」上傳一堂課。

### 錄音怎麼傳到電腦

- **App 內上傳**（推薦）：手機會把檔案切成每塊 32 MB，經過 Worker 直接傳到電腦，所以能避開 Cloudflare 一次最多 100 MB 的限制。中途斷線會自動重傳那一塊。
- **電腦待處理資料夾**：把檔案放進 `D:\Study Natursai\待處理`（用 OneDrive、隨身碟都可以），App 的「課程」頁就會列出來，按「匯入」即可。

---

## 小提醒

- **辨識不準？** 在課程資料的「術語」欄填專有名詞，再按「重新轉逐字稿」。想試聯發科的 Breeze ASR（台灣華語、中英夾雜比較準），先轉成 CTranslate2 格式：
  ```
  .venv\Scripts\pip install transformers ctranslate2
  .venv\Scripts\ct2-transformers-converter --model MediaTek-Research/Breeze-ASR-25 --output_dir D:\models\breeze-asr-25 --copy_files tokenizer.json preprocessor_config.json --quantization float16
  ```
  再把 `study_config.py` 的 `ASR_MODEL` 改成 `r"D:\models\breeze-asr-25"`。
- **顯存**：Whisper 閒置 10 分鐘會自動從顯示卡卸下，把空間讓給 GPT-SoVITS。
- **朗讀**：直接呼叫 GPT-SoVITS 的 api_v2，沿用 `voice_server.py` 裡的參考音檔設定，所以「啟動語音伺服器.bat」要開著。如果每日英文的跟讀和這裡的朗讀剛好同時在唸，GPT-SoVITS 可能會互搶，等一下再按就好。
- **備份**：雙擊 `備份資料庫.bat`，檔案會存到 `D:\Study Natursai\backup`。原始影音放在 `D:\Study Natursai\data\media`。
- **測試模式**：設定環境變數 `STUDY_FAKE=1` 再啟動，不需要 GPU 和金鑰，會用假的結果把整個流程跑一遍。
