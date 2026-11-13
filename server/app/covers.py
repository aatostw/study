"""書的封面。

找封面的順序：Google Books → Open Library（用 ISBN）→ 自架搜尋找封面圖。
如果有自己拍的封面照片，就用它來「核對」找到的圖是不是同一個版本（本機 CLIP 比相似度）；
都對不上、或都找不到，才用自己拍的照片當封面。什麼都沒有時，App 會顯示文字封面。"""
import io
import os
import re
import time

import httpx

from . import config, db, engines, websearch

COVER_DIR = os.path.join(config.DATA_DIR, "covers")
UA = "Mozilla/5.0 (study-server; personal use)"
MATCH = 0.82            # CLIP 相似度：大於這個才算同一個封面


def path(bid, photo=False):
    os.makedirs(COVER_DIR, exist_ok=True)
    return os.path.join(COVER_DIR, "%d%s.jpg" % (bid, "_photo" if photo else ""))


def _img(data):
    from PIL import Image, ImageOps
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert("RGB")
    return im


def _looks_like_cover(im):
    w, h = im.size
    return w >= 120 and h >= 170 and 0.5 <= w / h <= 0.9


def _download(url):
    if config.FAKE:
        return None
    try:
        if not websearch._allowed(url):
            return None
        r = httpx.get(url, headers={"User-Agent": UA}, timeout=12, follow_redirects=True)
        if r.status_code != 200 or len(r.content) > 6 * 1024 * 1024 or not r.headers.get("content-type", "").startswith("image"):
            return None
        im = _img(r.content)
        return im if _looks_like_cover(im) else None
    except Exception:
        return None


def _candidates(b):
    """依可靠度排好的封面網址：[(來源, 網址)]"""
    out = []
    isbn = re.sub(r"[^0-9Xx]", "", b.get("isbn") or "")
    if config.FAKE:
        return out
    if isbn:
        try:
            r = httpx.get("https://www.googleapis.com/books/v1/volumes", params={"q": "isbn:" + isbn}, timeout=10)
            for it in (r.json().get("items") or [])[:2]:
                links = (it.get("volumeInfo") or {}).get("imageLinks") or {}
                u = links.get("thumbnail") or links.get("smallThumbnail")
                if u:
                    out.append(("google", u.replace("http://", "https://").replace("&edge=curl", "").replace("zoom=1", "zoom=2")))
        except Exception:
            pass
        out.append(("openlibrary", "https://covers.openlibrary.org/b/isbn/%s-L.jpg?default=false" % isbn))
    try:
        q = "%s %s 書 封面" % (b["title"], b.get("author") or "")
        for h in websearch.search_images(q.strip(), n=8):
            out.append(("search", h["img"]))
    except Exception as e:
        print("  [封面] 圖片搜尋失敗：%s" % e, flush=True)
    return out


def _save(bid, im, src):
    im = im.copy()
    im.thumbnail((600, 900))
    im.save(path(bid), "JPEG", quality=86)
    ver = str(int(time.time()))
    db.run("UPDATE books SET cover = %s, cover_src = %s, cover_tried = true WHERE id = %s", (ver, src, bid))
    return ver


def find(bid, prog=None):
    b = db.one("SELECT * FROM books WHERE id = %s", (bid,))
    if not b:
        return
    photo_p = path(bid, photo=True)
    photo = _img(open(photo_p, "rb").read()) if os.path.exists(photo_p) else None
    mode = b["cover_mode"]
    if mode == "text":
        db.run("UPDATE books SET cover = '', cover_src = '', cover_tried = true WHERE id = %s", (bid,))
        return
    if mode == "photo" and photo:
        return _save(bid, photo, "photo")
    if prog:
        prog("找封面", 0.2)
    cands = _candidates(b)
    imgs = []
    for src, u in cands[:10]:
        im = _download(u)
        if im is not None:
            imgs.append((src, im))
        if not photo and imgs:          # 沒有照片可以核對：第一張可靠的就用
            break
    if photo and imgs:
        if prog:
            prog("用你拍的照片核對封面", 0.7)
        sims = engines.image_similarity(photo, [im for _, im in imgs])
        if sims:
            best = max(range(len(imgs)), key=lambda i: sims[i])
            print("  [封面] 《%s》核對相似度：%s" % (b["title"], ", ".join("%.2f" % s for s in sims)), flush=True)
            if sims[best] >= MATCH:
                return _save(bid, imgs[best][1], imgs[best][0])
        return _save(bid, photo, "photo")     # 找到的都對不上：用自己拍的
    if imgs:
        return _save(bid, imgs[0][1], imgs[0][0])
    if photo:
        return _save(bid, photo, "photo")
    db.run("UPDATE books SET cover_tried = true WHERE id = %s", (bid,))


def run_cover(job, prog):
    find(job["ref_id"], prog)


def backfill():
    """背景：以前加的書還沒有封面，一本一本補（只試一次）"""
    from . import jobs
    time.sleep(30)
    while True:
        try:
            rows = db.all("SELECT id, title FROM books WHERE cover = '' AND NOT cover_tried AND cover_mode <> 'text' ORDER BY id LIMIT 5")
            busy = db.one("SELECT 1 FROM jobs WHERE kind = 'cover' AND status IN ('queued', 'running')")
            if rows and not busy:
                for r in rows:
                    db.run("UPDATE books SET cover_tried = true WHERE id = %s", (r["id"],))
                    jobs.add("cover", r["id"], "找封面《%s》" % r["title"])
        except Exception as e:
            print("  [封面] %s" % e, flush=True)
        time.sleep(120)
