"""影片：YouTube 網址（交給 Gemini 看，不下載影片）、上傳影片的縮圖和手機可播放的版本"""
import os
import re
import subprocess
import threading
import time

import httpx

from . import ai, config, db, engines

THUMB_DIR = os.path.join(config.DATA_DIR, "thumbs")
YT_RE = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})")
_lock = threading.Lock()


def yt_id(url):
    m = YT_RE.search(url or "")
    return m.group(1) if m else ""


def yt_meta(vid):
    """公開的 oEmbed：標題、頻道（不需要金鑰）"""
    if config.FAKE:
        return {"title": "測試 YouTube 影片", "author": "測試頻道"}
    try:
        r = httpx.get("https://www.youtube.com/oembed", params={"url": "https://www.youtube.com/watch?v=" + vid, "format": "json"}, timeout=15)
        if r.status_code == 200:
            j = r.json()
            return {"title": j.get("title") or "", "author": j.get("author_name") or ""}
        if r.status_code in (401, 403, 404):
            return {"error": "這支影片不是公開的（或不存在），Gemini 只能讀公開影片。"}
    except Exception:
        pass
    return {"title": "", "author": ""}


def thumb_path(lid):
    os.makedirs(THUMB_DIR, exist_ok=True)
    return os.path.join(THUMB_DIR, "lecture-%d.jpg" % lid)


# ---------- YouTube → 逐字稿（Gemini） ----------

TS_RE = re.compile(r"^\s*[\[(（]?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*[\])）]?\s*[-–—:：]?\s*(.+)$")


def _parse(text):
    out = []
    for ln in text.splitlines():
        m = TS_RE.match(ln.replace("**", ""))
        if not m:
            if out and ln.strip():
                out[-1][1] += ln.strip()
            continue
        h, mi, s, t = m.groups()
        out.append([int(h or 0) * 3600 + int(mi) * 60 + int(s), t.strip()])
    return out


def _gemini_model():
    s = ai.settings()
    m = s["models"].get("summary") or {}
    if m.get("provider") == "gemini" and m.get("model"):
        return s, m["model"]
    return s, ai.FALLBACK["gemini"][0]


def youtube_segments(lec, prog):
    """回傳 [(t0, t1, text)]。太長的影片一次寫不完，就從最後的時間點接著寫。"""
    if config.FAKE:
        from . import fake
        return fake.transcribe(600)
    s, model = _gemini_model()
    key = ai._key(s, "gemini")
    base = ai._base(s, "gemini")
    lang = {"zh": "影片是中文的話用台灣繁體中文；夾雜的英文保留原文。", "en": "照影片原本的語言（英文）寫，不要翻譯。"}.get(lec["lang"], "照影片原本的語言寫；中文用台灣繁體。")
    url = lec["youtube"]
    rows, offset = [], 0
    for part in range(10):
        prompt = ("把這支影片裡說的話完整轉成逐字稿。每 15～40 秒一行，每行格式固定：[分:秒] 內容（超過一小時用 [時:分:秒]）。"
                  "時間用影片本身的時間。" + lang +
                  "沒有人說話的段落，用一行簡短描述畫面，放在【】裡。不要摘要、不要加標題或其他說明，只輸出逐字稿。")
        if offset:
            prompt += "\n前面已經寫到 [%s]，請從那之後接著寫。" % engines_fmt(offset)
        parts = [{"file_data": {"file_uri": url}}, {"text": prompt}]
        if offset:
            parts[0]["video_metadata"] = {"start_offset": "%ds" % int(offset)}
        body = {"contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"maxOutputTokens": 60000, "mediaResolution": "MEDIA_RESOLUTION_LOW"}}
        prog("Gemini 看影片、寫逐字稿%s" % ("（從 %s 接著寫）" % engines_fmt(offset) if offset else ""), 0.05 + 0.5 * min(part, 5) / 6, True)
        r = None
        for attempt, wait in enumerate([0, 10, 30]):
            time.sleep(wait)
            try:
                r = httpx.post("%s/models/%s:generateContent" % (base, model), params={"key": key}, json=body,
                               timeout=httpx.Timeout(900, connect=20))
            except httpx.HTTPError as e:
                raise RuntimeError("連不到 Gemini：%s" % e)
            if r.status_code not in ai.BUSY:
                break
        if r.status_code != 200:
            err = ai._err(r, "gemini")
            if r.status_code == 400 and re.search(r"(?i)private|unlisted|not.*(public|accessible)|invalid.*uri", r.text):
                raise RuntimeError("Gemini 讀不到這支影片：只能用公開影片（不公開／私人影片不行）。")
            raise RuntimeError(str(err))
        j = r.json()
        cand = (j.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []) if not p.get("thought"))
        got = _parse(text)
        if offset and got and got[0][0] + 5 < offset:     # 模型用了片段內的相對時間
            got = [[t + offset, x] for t, x in got]
        got.sort(key=lambda g: g[0])
        got = [g for g in got if not rows or g[0] > rows[-1][0]]
        rows += got
        if cand.get("finishReason") != "MAX_TOKENS" or not got:
            break
        offset = rows[-1][0]
    if not rows:
        raise RuntimeError("Gemini 沒有寫出逐字稿（影片可能沒有聲音，或不是公開影片）。")
    segs = []
    for i, (t, x) in enumerate(rows):
        t1 = rows[i + 1][0] if i + 1 < len(rows) else t + 20
        segs.append((float(t), float(max(t1, t + 1)), x))
    return segs


def engines_fmt(t):
    t = int(t)
    return "%d:%02d:%02d" % (t // 3600, t // 60 % 60, t % 60) if t >= 3600 else "%d:%02d" % (t // 60, t % 60)


# ---------- 上傳的影片：縮圖、手機能播的 mp4 ----------

def _probe(path):
    ff = engines.find_ffmpeg()
    if not ff:
        return ""
    r = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True)
    m = re.search(rb"Stream #[^\n]*Video: ([a-z0-9_]+)", r.stderr)
    if not m or b"attached pic" in r.stderr.split(m.group(0))[1].split(b"\n")[0]:
        return ""                                     # 沒有畫面（或只是 mp3 的專輯封面）
    return m.group(1).decode()


def prepare_video(lec, prog=None):
    """有畫面的話：做縮圖；瀏覽器不能播的格式轉成 720p mp4。回傳 True＝有影片"""
    src = lec["media_path"]
    if not src or not os.path.isfile(src):
        return False
    codec = _probe(src)
    if not codec:
        db.run("UPDATE lectures SET thumb = -1 WHERE id = %s", (lec["id"],))
        return False
    ff = engines.find_ffmpeg()
    dur = lec.get("duration") or engines.duration(src) or 0
    tp = thumb_path(lec["id"])
    at = min(max(dur * 0.1, 1), 90) if dur else 1
    try:
        engines._run([ff, "-y", "-hide_banner", "-loglevel", "error", "-ss", "%.1f" % at, "-i", src, "-frames:v", "1",
                      "-vf", "scale=480:-2", "-q:v", "4", tp])
    except RuntimeError:
        engines._run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", tp])
    ext = os.path.splitext(src)[1].lower()
    playable = src
    if not (ext in (".mp4", ".m4v", ".mov") and codec == "h264"):
        out = os.path.join(config.MEDIA_DIR, "lecture-%d.play.mp4" % lec["id"])
        if prog:
            prog("轉成手機能播的影片", 0.02, True)
        engines._run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", "scale=-2:'min(720,ih)'",
                      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k",
                      "-movflags", "+faststart", out])
        playable = out
    db.run("UPDATE lectures SET video_path = %s, thumb = %s WHERE id = %s", (playable, int(time.time()) % 1000000, lec["id"]))
    return True


def backfill():
    """背景：以前上傳的影片補縮圖（一次一支）"""
    time.sleep(45)
    while True:
        try:
            r = db.one("SELECT * FROM lectures WHERE thumb = 0 AND youtube = '' AND status = 'ready' ORDER BY id DESC LIMIT 1")
            if r:
                with _lock:
                    print("  [影片] 補縮圖：%s" % r["title"], flush=True)
                    try:
                        prepare_video(r)
                    except Exception as e:
                        print("  [影片] %s" % e, flush=True)
                        db.run("UPDATE lectures SET thumb = -1 WHERE id = %s", (r["id"],))
                continue
        except Exception as e:
            print("  [影片] %s" % e, flush=True)
        time.sleep(300)
