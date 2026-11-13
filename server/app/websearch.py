# -*- coding: utf-8 -*-
"""
自己電腦上的網路搜尋：
  search()  問自架的 SearXNG（Google、Bing、百度、搜狗、搜狗微信…），不用任何金鑰
  fetch()   抓網頁、只留正文；遵守網站的 robots.txt、同一個網站放慢速度、結果存 7 天
"""
import re
import threading
import time
import urllib.robotparser
from urllib.parse import urlparse

import httpx

from . import config, db

SEARX = "http://127.0.0.1:8890"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StudyNotes/1.0 (personal reading assistant)"
CACHE_DAYS = 7
MAX_BYTES = 3 * 1024 * 1024

_robots = {}
_last_hit = {}
_lock = threading.Lock()


def status():
    try:
        r = httpx.get(SEARX + "/healthz", timeout=3)
        return "ready" if r.status_code == 200 else "error"
    except httpx.HTTPError:
        return "offline"


def search(query, engines=None, lang="zh-TW", n=8):
    """回傳 [{url, title, snippet, engine}]"""
    if config.FAKE:
        from . import fake
        return fake.search(query, engines)
    params = {"q": query, "format": "json", "language": lang, "safesearch": 0}
    if engines:
        params["engines"] = engines
    try:
        r = httpx.get(SEARX + "/search", params=params, timeout=25)
    except httpx.HTTPError:
        raise RuntimeError("自架搜尋沒有開：請在 D:\\study-server 雙擊「安裝資料庫.bat」（會一起開搜尋），或打開 Docker Desktop。")
    if r.status_code != 200:
        raise RuntimeError("自架搜尋回應錯誤（%d）。" % r.status_code)
    out, seen = [], set()
    for x in r.json().get("results", []):
        u = x.get("url") or ""
        if not u.startswith("http") or u in seen:
            continue
        seen.add(u)
        out.append({"url": u, "title": (x.get("title") or "").strip(), "snippet": (x.get("content") or "").strip(),
                    "engine": ",".join(x.get("engines") or [x.get("engine") or ""])})
        if len(out) >= n:
            break
    return out


def search_images(query, n=8):
    """圖片搜尋（SearXNG images 分類）：[{img, page, title}]"""
    if config.FAKE:
        return []
    try:
        r = httpx.get(SEARX + "/search", params={"q": query, "format": "json", "categories": "images", "safesearch": 0}, timeout=25)
    except httpx.HTTPError:
        raise RuntimeError("自架搜尋沒有開")
    out = []
    for x in (r.json().get("results", []) if r.status_code == 200 else []):
        u = x.get("img_src") or ""
        if u.startswith("//"):
            u = "https:" + u
        if u.startswith("http"):
            out.append({"img": u, "page": x.get("url") or "", "title": x.get("title") or ""})
        if len(out) >= n:
            break
    return out


def _allowed(url):
    """遵守 robots.txt；讀不到 robots.txt 就當作可以"""
    p = urlparse(url)
    base = "%s://%s" % (p.scheme, p.netloc)
    rp = _robots.get(base)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = httpx.get(base + "/robots.txt", headers={"User-Agent": UA}, timeout=8, follow_redirects=True)
            if r.status_code == 200:
                rp.parse(r.text.splitlines())
            else:
                rp.parse([])
        except httpx.HTTPError:
            rp.parse([])
        _robots[base] = rp
    return rp.can_fetch(UA, url)


def _polite(host):
    """同一個網站至少隔 2 秒"""
    with _lock:
        wait = _last_hit.get(host, 0) + 2.0 - time.time()
        _last_hit[host] = max(time.time(), _last_hit.get(host, 0) + 2.0)
    if wait > 0:
        time.sleep(wait)


def _extract(html, url):
    try:
        import trafilatura
        t = trafilatura.extract(html, url=url, include_comments=True, include_tables=False, favor_recall=True)
        if t and len(t) > 80:
            return t
    except Exception:
        pass
    # 沒有 trafilatura 時的簡單版本
    s = re.sub(r"(?is)<(script|style|noscript|header|footer|nav|aside)[^>]*>.*?</\1>", " ", html)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d|tr)>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    import html as _h
    s = _h.unescape(s)
    s = re.sub(r"[ \t\u3000]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def fetch(url):
    """回傳 {"ok": bool, "text": 正文, "why": 失敗原因}"""
    if config.FAKE:
        from . import fake
        return fake.fetch(url)
    row = db.one("SELECT ok, text, why FROM web_cache WHERE url = %s AND fetched_at > now() - make_interval(days => %s)",
                 (url, CACHE_DAYS))
    if row:
        return dict(row)
    res = _fetch(url)
    db.run("INSERT INTO web_cache (url, ok, text, why) VALUES (%s, %s, %s, %s) "
           "ON CONFLICT (url) DO UPDATE SET ok = excluded.ok, text = excluded.text, why = excluded.why, fetched_at = now()",
           (url, res["ok"], res["text"], res["why"]))
    return res


def _fetch(url):
    try:
        if not _allowed(url):
            return {"ok": False, "text": "", "why": "網站不允許自動讀取（robots.txt）"}
        _polite(urlparse(url).netloc)
        with httpx.stream("GET", url, headers={"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.6"},
                          timeout=15, follow_redirects=True) as r:
            if r.status_code != 200:
                return {"ok": False, "text": "", "why": "網站回應 %d" % r.status_code}
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return {"ok": False, "text": "", "why": "不是網頁（%s）" % ctype.split(";")[0]}
            buf = b""
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > MAX_BYTES:
                    break
            enc = r.encoding or "utf-8"
        try:
            html = buf.decode(enc, errors="replace")
        except LookupError:
            html = buf.decode("utf-8", errors="replace")
        m = re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', buf[:4000], re.I)
        if m and m.group(1).decode().lower() not in (enc.lower(), "utf-8"):
            try:
                html = buf.decode(m.group(1).decode(), errors="replace")
            except LookupError:
                pass
        text = _extract(html, url)
        if len(text) < 80:
            return {"ok": False, "text": "", "why": "讀不到正文（可能要登入或被擋）"}
        if re.search(r"(登录|登入|验证码|驗證碼|安全验证|captcha)", text[:400], re.I) and len(text) < 1500:
            return {"ok": False, "text": "", "why": "要登入或驗證才看得到"}
        return {"ok": True, "text": text[:60000], "why": ""}
    except httpx.HTTPError as e:
        return {"ok": False, "text": "", "why": "連不上（%s）" % type(e).__name__}


def excerpt(text, keys, limit=2200):
    """長文章只留跟這本書有關的段落"""
    if len(text) <= limit:
        return text
    paras = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if len(p.strip()) > 15]
    keys = [k for k in keys if k]
    scored = []
    for i, p in enumerate(paras):
        score = sum(p.count(k) for k in keys) * 3 + sum(p.count(w) for w in ("評", "评", "讀", "读", "推薦", "推荐", "批評", "批评", "作者", "觀點", "观点", "認為", "认为"))
        scored.append((score, i, p))
    keep = sorted(sorted(scored, key=lambda x: -x[0])[:40], key=lambda x: x[1])
    out, total = [], 0
    for _, _, p in keep:
        if total + len(p) > limit:
            break
        out.append(p)
        total += len(p)
    return "\n".join(out) if out else text[:limit]
