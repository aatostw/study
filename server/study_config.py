# -*- coding: utf-8 -*-
"""
學習筆記｜電腦端設定（只要改這個檔案）

改完存檔，重新雙擊「啟動學習伺服器.bat」就會生效。
AI 金鑰和每項工作要用的模型，不用寫在這裡，到 App 的「設定」頁填就好。
"""

# GPT-SoVITS 資料夾（朗讀會沿用裡面的聲音模型和參考音檔設定）
GPT_SOVITS_DIR = r"D:\GPT-SoVITS-v2pro-20250604"

# 所有資料放在這裡：上傳的影音、轉好的音訊、PDF/EPUB、朗讀暫存
DATA_DIR = r"D:\StudyData"

# 「電腦待處理資料夾」：用 OneDrive、隨身碟等方式放進來的檔案，App 裡可以直接匯入
INBOX_DIR = r"D:\StudyData\待處理"

# 資料庫（docker-compose.yml 會開一個 PostgreSQL + pgvector，連接埠 5433）
DATABASE_URL = "postgresql://study:study-local-only@127.0.0.1:5433/study"

# 這台電腦上的連接埠（只給 cloudflared 用，外面直接連不到）
PORT = 9882

# 固定網址：先雙擊一次「設定固定網址.bat」，之後網址就固定是 https://FIXED_HOST
# 這個網址只給 Cloudflare Worker 用，手機不會直接連。
FIXED_HOST = "study-pc.natursai.com"
TUNNEL_NAME = "study-pc"

# 課程轉逐字稿（faster-whisper）
#   "large-v3-turbo"：快、準（推薦；GPT-SoVITS 已經下載過的話會直接沿用）
#   "large-v3"：最準、慢一點
#   也可以填一個資料夾路徑，例如轉換好的 Breeze ASR（CTranslate2 格式）
ASR_MODEL = "large-v3-turbo"
# 閒置幾分鐘後把 Whisper 從顯示卡卸下（讓出顯存給 GPT-SoVITS）。0 = 一直留著
ASR_IDLE_UNLOAD_MIN = 10

# 語意搜尋用的向量模型（中英都好，約 2.3 GB，第一次會自動下載）
EMBED_MODEL = "BAAI/bge-m3"

# 單一檔案大小上限（GB）
MAX_UPLOAD_GB = 8
