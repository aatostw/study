# -*- coding: utf-8 -*-
"""
朗讀：直接用 GPT-SoVITS 的 api_v2（127.0.0.1:9880，由「啟動語音伺服器.bat」開啟），
沿用 voice_server.py 裡的參考音檔設定，但可以選中文／英文／自動。
"""
import hashlib
import io
import os
import re
import threading
import wave

import httpx

from . import config

API = "http://127.0.0.1:9880"
_lock = threading.Lock()
LANGS = {"zh": "中英混合", "en": "英文", "auto": "自動判斷"}


def _voice_settings():
    """從 voice_server.py 讀參考音檔、參考文字、參考語言（只讀，不改）"""
    path = os.path.join(config.GPT_SOVITS_DIR or "", "voice_server.py")
    s = {"REF_AUDIO": "ref.wav", "REF_TEXT": "", "REF_LANG": "zh"}
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
        for k in s:
            m = re.search(r'^%s\s*=\s*r?"(.*)"' % k, src, re.M)
            if m:
                s[k] = m.group(1)
    except OSError:
        pass
    ref = s["REF_AUDIO"]
    if not os.path.isabs(ref):
        ref = os.path.join(config.GPT_SOVITS_DIR or "", ref)
    return ref, s["REF_TEXT"], s["REF_LANG"]


def status():
    try:
        r = httpx.get(API + "/tts", timeout=3)
        return "ready" if r.status_code in (200, 400, 422) else "error"
    except httpx.HTTPError:
        return "offline"


def synth(text, lang="zh", speed=1.0):
    """回傳 wav bytes；同樣的句子存在硬碟，不用再算"""
    text = " ".join(text.split())
    lang = lang if lang in LANGS else "zh"
    speed = round(min(max(float(speed), 0.6), 1.6), 2)
    h = hashlib.sha1(("%s|%s|%s" % (lang, speed, text)).encode("utf-8")).hexdigest()
    path = os.path.join(config.TTS_DIR, h + ".wav")
    if os.path.isfile(path):
        with open(path, "rb") as f:
            return f.read()
    if config.FAKE:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 8000)
        data = buf.getvalue()
    else:
        ref, ref_text, ref_lang = _voice_settings()
        with _lock:
            try:
                r = httpx.get(API + "/tts", timeout=300, params={
                    "text": text, "text_lang": lang, "ref_audio_path": ref, "prompt_text": ref_text,
                    "prompt_lang": ref_lang, "text_split_method": "cut5", "media_type": "wav", "speed_factor": speed})
            except httpx.HTTPError:
                raise RuntimeError("GPT-SoVITS 沒有開：請先雙擊「啟動語音伺服器.bat」。")
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("audio"):
            raise RuntimeError("GPT-SoVITS 唸不出來：%s" % r.text[:200])
        data = r.content
    with open(path, "wb") as f:
        f.write(data)
    return data


def join_wavs(blobs, gap=0.35):
    """把每段的 wav 接成一個檔，中間留一點停頓"""
    out = io.BytesIO()
    params = None
    with wave.open(out, "wb") as w:
        for b in blobs:
            with wave.open(io.BytesIO(b), "rb") as r:
                if params is None:
                    params = r.getparams()
                    w.setnchannels(params.nchannels)
                    w.setsampwidth(params.sampwidth)
                    w.setframerate(params.framerate)
                    silence = b"\x00" * int(params.framerate * gap) * params.sampwidth * params.nchannels
                elif (r.getframerate(), r.getnchannels(), r.getsampwidth()) != (params.framerate, params.nchannels, params.sampwidth):
                    continue
                w.writeframes(r.readframes(r.getnframes()))
                w.writeframes(silence)
    return out.getvalue()
