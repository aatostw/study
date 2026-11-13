# -*- coding: utf-8 -*-
"""讀取 study_config.py；環境變數可以覆蓋（測試用）。"""
import os
import secrets
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import study_config as _c  # noqa: E402


def _get(name, default):
    v = os.environ.get("STUDY_" + name)
    if v is None:
        return getattr(_c, name, default)
    if isinstance(default, bool):
        return v.lower() in ("1", "true", "yes")
    if isinstance(default, int):
        return int(v)
    return v


GPT_SOVITS_DIR = _get("GPT_SOVITS_DIR", "")
DATA_DIR = _get("DATA_DIR", os.path.join(HERE, "data"))
INBOX_DIR = _get("INBOX_DIR", os.path.join(DATA_DIR, "inbox"))
DATABASE_URL = _get("DATABASE_URL", "")
PORT = _get("PORT", 9882)
FIXED_HOST = _get("FIXED_HOST", "")
TUNNEL_NAME = _get("TUNNEL_NAME", "")
ASR_MODEL = _get("ASR_MODEL", "large-v3-turbo")
ASR_IDLE_UNLOAD_MIN = _get("ASR_IDLE_UNLOAD_MIN", 10)
EMBED_MODEL = _get("EMBED_MODEL", "BAAI/bge-m3")
CLIP_MODEL = _get("CLIP_MODEL", "clip-ViT-B-32")                 # 封面核對，約 600MB，跑 CPU
RERANK_MODEL = _get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")   # 重新排名：中英都準，約 1GB
MAX_UPLOAD_GB = _get("MAX_UPLOAD_GB", 8)
REF_ZH_AUDIO = _get("REF_ZH_AUDIO", "")
REF_ZH_TEXT = _get("REF_ZH_TEXT", "")
MODEL_DIR = _get("MODEL_DIR", os.path.join(DATA_DIR, "models"))
# Hugging Face 下載的模型放 MODEL_DIR（預設會放在 C 槽的使用者資料夾）
os.makedirs(MODEL_DIR, exist_ok=True)
os.environ.setdefault("HF_HOME", MODEL_DIR)
# 測試模式：不載入 Whisper / 向量模型 / 呼叫 AI，用假的結果跑完整流程
FAKE = _get("FAKE", False)

EMBED_DIM = 1024
CHUNK_BYTES = 32 * 1024 * 1024      # 分塊上傳每塊 32 MB（Cloudflare 單次上限 100 MB）

MEDIA_DIR = os.path.join(DATA_DIR, "media")
BOOK_DIR = os.path.join(DATA_DIR, "books")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
TTS_DIR = os.path.join(DATA_DIR, "tts")
for _d in (DATA_DIR, INBOX_DIR, MEDIA_DIR, BOOK_DIR, UPLOAD_DIR, TTS_DIR):
    os.makedirs(_d, exist_ok=True)

KEY_FILE = os.path.join(HERE, "study_server_key.txt")


def access_key():
    """電腦的密碼：給 Cloudflare Worker 用（Secret STUDY_KEY）。第一次自動產生。"""
    env = os.environ.get("STUDY_KEY")
    if env:
        return env
    try:
        with open(KEY_FILE, encoding="utf-8") as f:
            k = f.read().strip()
            if k:
                return k
    except OSError:
        pass
    k = secrets.token_urlsafe(24)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(k)
    return k


KEY = access_key()

LECTURE_EXT = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus", ".webm",
               ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".3gp", ".wma"}
BOOK_EXT = {".pdf", ".epub", ".txt", ".md"}
