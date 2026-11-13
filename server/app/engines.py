# -*- coding: utf-8 -*-
"""顯示卡上的模型：Whisper（轉逐字稿）、bge-m3（向量），以及 ffmpeg。"""
import glob
import os
import re
import shutil
import subprocess
import sys
import threading
import time

from . import config, fake

state = {"asr": "idle", "asr_error": "", "embed": "idle", "embed_error": "", "gpu": ""}


# ---------- 讓 Windows 找得到 CUDA / cuDNN 的 DLL（torch 自帶一份）----------
_dll_done = False


def _cuda_dlls():
    global _dll_done
    if _dll_done:
        return
    _dll_done = True
    try:
        import torch
        if torch.cuda.is_available():
            state["gpu"] = torch.cuda.get_device_name(0)
        if os.name == "nt":
            lib = os.path.join(os.path.dirname(torch.__file__), "lib")
            if os.path.isdir(lib):
                os.add_dll_directory(lib)
                os.environ["PATH"] = lib + os.pathsep + os.environ.get("PATH", "")
            for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def gpu_ok():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


# ---------- 向量 ----------
_embed = {"model": None}
_embed_lock = threading.Lock()


def embed(texts):
    if not texts:
        return []
    if config.FAKE:
        state["embed"] = "ready"
        return fake.embed(texts)
    with _embed_lock:
        if _embed["model"] is None:
            state["embed"] = "loading"
            try:
                _cuda_dlls()
                from sentence_transformers import SentenceTransformer
                _embed["model"] = SentenceTransformer(config.EMBED_MODEL, device="cuda" if gpu_ok() else "cpu")
                if gpu_ok():
                    _embed["model"].half()
                state["embed"] = "ready"
            except Exception as e:
                state["embed"], state["embed_error"] = "error", str(e)[:300]
                raise
        vecs = _embed["model"].encode(texts, batch_size=16, normalize_embeddings=True, show_progress_bar=False)
        return [v.tolist() for v in vecs]


# ---------- 重新排名（cross-encoder）----------
_rr = {"model": None}
_rr_lock = threading.Lock()


def rerank(query, texts):
    """每段跟問題的相關分數（0～1）。模型載入失敗就回傳 None，呼叫的地方改用原本的順序"""
    if not texts:
        return []
    if config.FAKE:
        return fake.rerank(query, texts)
    with _rr_lock:
        if _rr["model"] is None:
            if state.get("rerank") == "error":
                return None
            state["rerank"] = "loading"
            try:
                _cuda_dlls()
                from sentence_transformers import CrossEncoder
                dev = "cuda" if gpu_ok() else "cpu"
                _rr["model"] = CrossEncoder(config.RERANK_MODEL, device=dev, max_length=512)
                if dev == "cuda":
                    _rr["model"].model.half()
                state["rerank"] = "ready"
            except Exception as e:
                state["rerank"], state["rerank_error"] = "error", str(e)[:300]
                print("  [重新排名] 載入失敗，改用原本的順序：%s" % e, flush=True)
                return None
        try:
            import torch
            scores = _rr["model"].predict([(query, t[:1500]) for t in texts], batch_size=16,
                                          activation_fn=torch.nn.Sigmoid(), show_progress_bar=False)
        except TypeError:   # 舊版 sentence-transformers 參數名稱不同
            import torch
            scores = _rr["model"].predict([(query, t[:1500]) for t in texts], batch_size=16,
                                          activation_fct=torch.nn.Sigmoid(), show_progress_bar=False)
        return [float(s) for s in scores]


# ---------- Whisper ----------
_asr = {"model": None, "last": 0.0}
_asr_lock = threading.Lock()


def _asr_path():
    m = config.ASR_MODEL
    if os.path.isdir(m):
        return m
    # GPT-SoVITS 已經下載過的話直接用（跟讀評分用的就是這份）
    if config.GPT_SOVITS_DIR:
        p = os.path.join(config.GPT_SOVITS_DIR, "tools", "asr", "models", "faster-whisper-" + m)
        if os.path.isfile(os.path.join(p, "model.bin")):
            return p
    if m == "large-v3-turbo":
        return "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    return m


def _load_asr():
    if _asr["model"] is not None:
        return _asr["model"]
    state["asr"] = "loading"
    try:
        _cuda_dlls()
        from faster_whisper import WhisperModel
        gpu = gpu_ok()
        _asr["model"] = WhisperModel(_asr_path(), device="cuda" if gpu else "cpu",
                                     compute_type="float16" if gpu else "int8")
        state["asr"] = "ready"
    except Exception as e:
        state["asr"], state["asr_error"] = "error", str(e)[:300]
        raise
    return _asr["model"]


def transcribe(wav_path, lang, terms, duration, progress=None):
    """回傳 [(開始秒, 結束秒, 文字)]；progress(0~1)"""
    if config.FAKE:
        segs = fake.transcribe(duration)
        if progress:
            progress(1.0)
        return segs
    with _asr_lock:
        model = _load_asr()
        _asr["last"] = time.time()
        prompt = None
        if terms.strip():
            words = re.split(r"[\n,，、;；]+", terms)
            prompt = "本課會提到：" + "、".join(w.strip() for w in words if w.strip())[:600]
        segments, info = model.transcribe(
            wav_path,
            language=None if lang == "auto" else lang,
            task="transcribe",
            beam_size=5,
            vad_filter=True,                                   # 在停頓處切，不會切斷句子
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,                  # 長錄音比較不會鬼打牆重複
            initial_prompt=prompt,
        )
        out = []
        total = duration or getattr(info, "duration", 0) or 1
        for s in segments:
            text = s.text.strip()
            if text:
                out.append((float(s.start), float(s.end), text))
            if progress:
                progress(min(1.0, float(s.end) / total))
            _asr["last"] = time.time()
        return out


def asr_idle_unloader():
    """閒置一段時間就把 Whisper 從顯示卡卸下"""
    while True:
        time.sleep(30)
        mins = config.ASR_IDLE_UNLOAD_MIN
        if mins and _asr["model"] is not None and time.time() - _asr["last"] > mins * 60:
            with _asr_lock:
                if _asr["model"] is not None and time.time() - _asr["last"] > mins * 60:
                    _asr["model"] = None
                    state["asr"] = "idle"
                    try:
                        import gc
                        import torch
                        gc.collect()
                        torch.cuda.empty_cache()
                    except Exception:
                        pass


# ---------- ffmpeg ----------

def find_ffmpeg():
    cands = []
    if config.GPT_SOVITS_DIR:
        cands += [os.path.join(config.GPT_SOVITS_DIR, "ffmpeg.exe"),
                  os.path.join(config.GPT_SOVITS_DIR, "runtime", "ffmpeg.exe")]
    cands += [shutil.which("ffmpeg") or ""]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def _run(args):
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 失敗：" + r.stderr.decode("utf-8", "replace")[-500:])
    return r


def duration(path):
    ff = find_ffmpeg()
    r = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True)
    m = re.search(rb"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
    if not m:
        return 0.0
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def prepare_audio(src, wav_out, m4a_out):
    """給 Whisper 的 16kHz 單聲道 wav，和給手機播放的小 m4a（約 20 MB / 45 分鐘）"""
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg。請在命令提示字元執行：winget install Gyan.FFmpeg，再重開伺服器。")
    _run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav_out])
    _run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k",
          "-movflags", "+faststart", m4a_out])


def dictate(src):
    """助理的語音輸入：一小段錄音 → 文字（台灣繁體）"""
    if config.FAKE:
        time.sleep(0.5)
        return "老子說的無為是什麼意思？"
    from .textutil import to_trad
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("找不到 ffmpeg，沒辦法聽寫。")
    wav = src + ".wav"
    try:
        _run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav])
        with _asr_lock:
            model = _load_asr()
            _asr["last"] = time.time()
            segments, _ = model.transcribe(wav, language="zh", task="transcribe", beam_size=5, vad_filter=True,
                                           condition_on_previous_text=False,
                                           initial_prompt="以下是台灣繁體中文的提問，可能夾雜英文。")
            text = "".join(s.text.strip() for s in segments)
            _asr["last"] = time.time()
        return to_trad(text).strip()
    finally:
        for p in (wav,):
            try:
                os.remove(p)
            except OSError:
                pass
