# -*- coding: utf-8 -*-
"""HTTP API：只聽 127.0.0.1，只接受帶著電腦密碼（X-Study-Key）的請求，也就是 Cloudflare Worker。"""
import asyncio
import hmac
import json
import os
import re
import secrets
import shutil
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse

from . import ai, bookeval, chat, review, config, db, engines, jobs, knowledge, tts, websearch
from .textutil import fmt_t, tts_parts

app = FastAPI(title="study-server", docs_url=None, redoc_url=None, openapi_url=None)
VERSION = 1


class Bad(Exception):
    def __init__(self, msg, code=400):
        self.msg, self.code = msg, code


@app.exception_handler(Bad)
async def _bad(request, e):
    return JSONResponse({"ok": False, "error": e.msg}, status_code=e.code)


@app.exception_handler(ai.AIError)
async def _aierr(request, e):
    return JSONResponse({"ok": False, "error": str(e), "ai": True}, status_code=400)


@app.exception_handler(RuntimeError)
async def _rterr(request, e):
    return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


@app.exception_handler(Exception)
async def _any(request, e):
    import traceback
    traceback.print_exc()
    return JSONResponse({"ok": False, "error": "電腦端出錯：%s: %s" % (type(e).__name__, str(e)[:300])}, status_code=500)


@app.middleware("http")
async def _auth(request: Request, call_next):
    if request.url.path != "/ping":
        given = request.headers.get("x-study-key", "")
        if not hmac.compare_digest(given.encode(), config.KEY.encode()):
            return JSONResponse({"ok": False, "error": "電腦密碼不對（Worker 的 STUDY_KEY）", "key": False}, status_code=401)
    return await call_next(request)


async def body_json(request):
    try:
        b = await request.json()
    except ValueError:
        raise Bad("資料格式不對")
    if not isinstance(b, dict):
        raise Bad("資料格式不對")
    return b


def s(v, n=2000):
    return str(v or "").strip()[:n]


# ---------- 狀態、設定 ----------

@app.get("/ping")
def ping(request: Request):
    given = request.headers.get("x-study-key", "")
    return {"ok": True, "app": "study-server", "version": VERSION,
            "key": hmac.compare_digest(given.encode(), config.KEY.encode())}


@app.get("/status")
def status():
    q = db.one("SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running FROM jobs")
    n = db.one("SELECT (SELECT count(*) FROM books) AS books, (SELECT count(*) FROM notes) AS notes, "
               "(SELECT count(*) FROM lectures) AS lectures, (SELECT count(*) FROM chunks) AS chunks")
    du = shutil.disk_usage(config.DATA_DIR)
    return {"ok": True, "gpu": engines.state["gpu"] or ("CUDA" if engines.gpu_ok() else "（沒有偵測到顯示卡）"),
            "asr": engines.state["asr"], "asr_error": engines.state["asr_error"], "asr_model": config.ASR_MODEL,
            "embed": engines.state["embed"], "embed_error": engines.state["embed_error"],
            "tts": tts.status(), "tts_ref": tts.ref_info(), "search": websearch.status(), "ffmpeg": bool(engines.find_ffmpeg()), "fake": config.FAKE,
            "queue": q, "counts": n, "disk_free_gb": round(du.free / 1e9, 1), "inbox": config.INBOX_DIR}


@app.get("/settings")
def get_settings():
    return {"ok": True, "ai": ai.public_settings(), "prefs": db.get_setting("prefs", {"lang": "zh", "tts_lang": "zh", "tts_speed": 1.0})}


@app.put("/settings")
async def put_settings(request: Request):
    b = await body_json(request)
    out = {"ok": True}
    if isinstance(b.get("ai"), dict):
        out["ai"] = ai.update_settings(b["ai"])
    if isinstance(b.get("prefs"), dict):
        p = db.get_setting("prefs", {}) or {}
        for k in ("lang", "tts_lang"):
            if b["prefs"].get(k) in ("zh", "en", "auto"):
                p[k] = b["prefs"][k]
        if "tts_speed" in b["prefs"]:
            p["tts_speed"] = round(min(max(float(b["prefs"]["tts_speed"]), 0.6), 1.6), 2)
        db.set_setting("prefs", p)
        out["prefs"] = p
    return out


@app.get("/ai/models")
def ai_models(provider: str):
    return {"ok": True, "models": ai.list_models(provider)}


@app.post("/ai/test")
async def ai_test(request: Request):
    b = await body_json(request)
    t0 = time.time()
    text, used = ai.generate("ask", "只回答兩個字：可以", provider=s(b.get("provider")), model=s(b.get("model")), max_tokens=50)
    return {"ok": True, "reply": text[:100], "model": used, "ms": int((time.time() - t0) * 1000)}


# ---------- 書與筆記 ----------

@app.get("/books")
def books():
    rows = db.all("SELECT b.id, b.title, b.author, b.file_name, b.pages, b.status, b.updated_at, b.shelf, b.isbn, "
                  "b.starred, b.analysis IS NOT NULL AS analyzed, b.evaluation->'credibility'->>'light' AS light, "
                  "b.evaluation->'verdict'->>'level' AS verdict, b.evaluation->'reception'->>'headline' AS headline, "
                  "(SELECT count(*) FROM notes n WHERE n.book_id = b.id) AS notes, "
                  "(SELECT status FROM jobs j WHERE j.ref_id = b.id AND j.kind = 'evaluate' ORDER BY j.id DESC LIMIT 1) AS eval_status "
                  "FROM books b ORDER BY b.updated_at DESC")
    return {"ok": True, "books": rows}


@app.post("/books")
async def book_add(request: Request):
    b = await body_json(request)
    title, author, isbn = s(b.get("title"), 200), s(b.get("author"), 200), re.sub(r"[^0-9Xx]", "", s(b.get("isbn"), 20))
    if not title and isbn:
        info = bookeval.lookup_isbn(isbn) or {}
        title, author = info.get("title") or "", author or info.get("author") or ""
    if not title:
        raise Bad("請填書名" + ("（這個 ISBN 查不到書名）" if isbn else ""))
    shelf = b.get("shelf") if b.get("shelf") in ("wish", "reading", "done") else "wish"
    r = db.one("INSERT INTO books (title, author, isbn, shelf, wish_note) VALUES (%s, %s, %s, %s, %s) RETURNING *",
               (title, author, isbn, shelf, s(b.get("wish_note"), 1000)))
    out = {"ok": True, "book": r}
    if b.get("evaluate"):
        out["job"] = jobs.add("evaluate", r["id"], "評估《%s》" % title)
    return out


@app.get("/lookup")
def lookup(isbn: str):
    if not bookeval.isbn_ok(isbn):
        raise Bad("ISBN 不對（10 或 13 碼，檢查碼對不上），請再拍一次或手動輸入")
    info = bookeval.lookup_isbn(isbn)
    return {"ok": True, "book": info}


IDENTIFY_PROMPT = ("這是一本書的照片（封面、書背、條碼或版權頁）。辨識出書的資訊，只輸出 JSON："
                   '{"isbn": "ISBN，只要數字（條碼下方或上方印的 978／979 開頭 13 碼；不是價格條碼），看不到就空字串", '
                   '"title": "照片上看得到的書名，看不到就空字串", "author": "照片上看得到的作者"}。'
                   "只拍到條碼時書名和作者留空字串，不要猜。數字要一位一位仔細核對。")


@app.post("/identify")
async def identify(request: Request):
    data = await request.body()
    mt = request.headers.get("content-type", "image/jpeg").split(";")[0]
    if not mt.startswith("image/") or not data or len(data) > 15 * 1024 * 1024:
        raise Bad("請上傳照片")
    d, used = ai.generate_json("ocr", IDENTIFY_PROMPT, images=[(mt, data)], max_tokens=500)
    isbn = re.sub(r"[^0-9Xx]", "", str(d.get("isbn") or "")).upper()
    if isbn and not bookeval.isbn_ok(isbn):
        isbn = ""                                   # 看錯數字，寧可不要
    out = {"isbn": isbn, "title": str(d.get("title") or "").strip(), "author": str(d.get("author") or "").strip()}
    if isbn and (not out["title"] or not out["author"]):
        info = bookeval.lookup_isbn(isbn) or {}
        out["title"] = out["title"] or info.get("title", "")
        out["author"] = out["author"] or info.get("author", "")
    return {"ok": True, "book": out, "model": used}


def _book(bid):
    b = db.one("SELECT * FROM books WHERE id = %s", (bid,))
    if not b:
        raise Bad("找不到這本書", 404)
    return b


@app.get("/books/{bid}")
def book_get(bid: int):
    b = _book(bid)
    b.pop("file_path", None)
    notes = db.all("SELECT n.*, EXISTS (SELECT 1 FROM chunks c WHERE c.note_id = n.id) AS indexed "
                   "FROM notes n WHERE book_id = %s ORDER BY n.created_at DESC", (bid,))
    job = db.one("SELECT id, kind, status, step, progress, error FROM jobs WHERE ref_id = %s AND kind IN ('bookfile', 'analyze', 'evaluate') "
                 "ORDER BY id DESC LIMIT 1", (bid,))
    return {"ok": True, "book": b, "notes": notes, "job": job}


@app.patch("/books/{bid}")
async def book_edit(bid: int, request: Request):
    _book(bid)
    b = await body_json(request)
    cur = _book(bid)
    shelf = b.get("shelf") if b.get("shelf") in ("wish", "reading", "done") else cur["shelf"]
    db.run("UPDATE books SET title = COALESCE(NULLIF(%s, ''), title), author = %s, isbn = %s, wish_note = %s, shelf = %s, updated_at = now() WHERE id = %s",
           (s(b.get("title"), 200), s(b.get("author", cur["author"]), 200), re.sub(r"[^0-9Xx]", "", s(b.get("isbn", cur["isbn"]), 20)),
            s(b.get("wish_note", cur["wish_note"]), 1000), shelf, bid))
    return {"ok": True}


@app.post("/books/{bid}/evaluate")
def book_evaluate(bid: int):
    b = _book(bid)
    j = jobs.add("evaluate", bid, "評估《%s》" % b["title"])
    return {"ok": True, "job": j}


@app.post("/books/{bid}/evidence")
async def book_evidence(bid: int, request: Request):
    """自己補的資料（例如微信讀書截圖辨識出來的點評），評估時一起看"""
    b = _book(bid)
    body = await body_json(request)
    text = s(body.get("text"), 8000)
    new = text if body.get("replace") else (b["user_evidence"] + ("\n\n" if b["user_evidence"] and text else "") + text)
    db.run("UPDATE books SET user_evidence = %s, updated_at = now() WHERE id = %s", (new[-20000:], bid))
    return {"ok": True, "user_evidence": new[-20000:]}


@app.delete("/books/{bid}")
def book_del(bid: int):
    b = _book(bid)
    db.run("DELETE FROM books WHERE id = %s", (bid,))
    if b["file_path"] and os.path.isfile(b["file_path"]):
        os.remove(b["file_path"])
    return {"ok": True}


@app.post("/books/{bid}/analyze")
def book_analyze(bid: int):
    b = _book(bid)
    j = jobs.add("analyze", bid, "分析《%s》" % b["title"])
    return {"ok": True, "job": j}


@app.post("/books/{bid}/notes")
async def note_add(bid: int, request: Request):
    _book(bid)
    b = await body_json(request)
    quote, content = s(b.get("quote"), 8000), s(b.get("content"), 8000)
    if not quote and not content:
        raise Bad("摘句和想法至少填一個")
    r = db.one("INSERT INTO notes (book_id, quote, content, chapter, page, source) VALUES (%s, %s, %s, %s, %s, %s) RETURNING *",
               (bid, quote, content, s(b.get("chapter"), 200), s(b.get("page"), 40), "photo" if b.get("source") == "photo" else "typed"))
    db.run("UPDATE books SET updated_at = now() WHERE id = %s", (bid,))
    return {"ok": True, "note": r}


# ---------- 記事本（獨立筆記）----------

@app.get("/notes")
def notebook():
    rows = db.all("SELECT id, title, left(content, 160) AS preview, starred, no_index, created_at, updated_at, "
                  "EXISTS (SELECT 1 FROM chunks c WHERE c.note_id = n.id) AS indexed "
                  "FROM notes n WHERE book_id IS NULL ORDER BY updated_at DESC")
    return {"ok": True, "notes": rows}


@app.post("/notes")
async def notebook_add(request: Request):
    b = await body_json(request)
    title, content = s(b.get("title"), 200), s(b.get("content"), 30000)
    if not title and not content:
        raise Bad("標題和內容至少填一個")
    r = db.one("INSERT INTO notes (book_id, title, content, source) VALUES (NULL, %s, %s, 'typed') RETURNING *", (title, content))
    return {"ok": True, "note": r}


@app.get("/notes/{nid}")
def note_get(nid: int):
    r = db.one("SELECT n.*, EXISTS (SELECT 1 FROM chunks c WHERE c.note_id = n.id) AS indexed FROM notes n WHERE id = %s", (nid,))
    if not r:
        raise Bad("找不到這則筆記", 404)
    return {"ok": True, "note": r}


@app.post("/star")
async def star(request: Request):
    """收藏：書、記事本、課程都可以釘在書櫃最上面"""
    b = await body_json(request)
    table = {"book": "books", "note": "notes", "lecture": "lectures"}.get(b.get("kind"))
    if not table:
        raise Bad("不知道要收藏什麼")
    r = db.one("UPDATE %s SET starred = %%s WHERE id = %%s RETURNING id, starred" % table, (bool(b.get("on")), int(b.get("id") or 0)))
    if not r:
        raise Bad("找不到", 404)
    return {"ok": True, "starred": r["starred"]}


@app.patch("/notes/{nid}")
async def note_edit(nid: int, request: Request):
    b = await body_json(request)
    cur = db.one("SELECT * FROM notes WHERE id = %s", (nid,))
    if not cur:
        raise Bad("找不到這則筆記", 404)
    g = lambda k, n: s(b.get(k, cur[k]), n)
    if "no_index" in b and set(b) <= {"no_index"}:     # 只切換「放不放進知識庫」，不動更新時間
        r = db.one("UPDATE notes SET no_index = %s WHERE id = %s RETURNING *", (bool(b["no_index"]), nid))
        return {"ok": True, "note": r}
    r = db.one("UPDATE notes SET title = %s, quote = %s, content = %s, chapter = %s, page = %s, updated_at = now() WHERE id = %s RETURNING *",
               (g("title", 200), g("quote", 8000), g("content", 30000), g("chapter", 200), g("page", 40), nid))
    if not r:
        raise Bad("找不到這則筆記", 404)
    db.run("DELETE FROM chunks WHERE note_id = %s", (nid,))      # 背景會重建向量
    return {"ok": True, "note": r}


@app.delete("/notes/{nid}")
def note_del(nid: int):
    db.run("DELETE FROM notes WHERE id = %s", (nid,))
    return {"ok": True}


OCR_PROMPT = ("這是一張書頁的照片。請把文字辨識出來：\n"
              "- 如果有畫線、螢光筆、圈起來或旁邊有記號的段落，只輸出那些段落；沒有標記就輸出整頁正文。\n"
              "- 忠於原文，不要翻譯、不要摘要、不要加註解；保留原本的分段。\n"
              "- 頁首、頁尾、頁碼不要。\n"
              "- 最後一行輸出：頁碼：<看得到的頁碼，看不到就留空>")


@app.post("/ocr")
async def ocr(request: Request):
    data = await request.body()
    mt = request.headers.get("content-type", "image/jpeg").split(";")[0]
    if not mt.startswith("image/") or not data:
        raise Bad("請上傳照片")
    if len(data) > 15 * 1024 * 1024:
        raise Bad("照片太大")
    text, used = ai.generate("ocr", OCR_PROMPT, images=[(mt, data)], max_tokens=4000)
    page = ""
    m = re.search(r"\n?\s*頁碼[:：]\s*(\S*)\s*$", text)
    if m:
        page, text = m.group(1), text[:m.start()].rstrip()
    return {"ok": True, "text": text, "page": page, "model": used}


@app.get("/books/{bid}/export")
def book_export(bid: int):
    b = _book(bid)
    notes = db.all("SELECT * FROM notes WHERE book_id = %s ORDER BY id", (bid,))
    out = ["# 《%s》%s" % (b["title"], ("　" + b["author"]) if b["author"] else ""), ""]
    a = b.get("analysis") or {}
    if a.get("summary"):
        out += ["## AI 整理", "", a["summary"], ""]
        for t in a.get("themes") or []:
            out += ["- **%s**：%s" % (t.get("title"), t.get("explain", ""))]
        out.append("")
    out += ["## 筆記", ""]
    for n in notes:
        where = " ".join(x for x in (n["chapter"], ("p." + n["page"]) if n["page"] else "") if x)
        if where:
            out.append("**%s**" % where)
        if n["quote"]:
            out += ["> " + n["quote"].replace("\n", "\n> ")]
        if n["content"]:
            out += ["", n["content"]]
        out += ["", "---", ""]
    return PlainTextResponse("\n".join(out), media_type="text/markdown; charset=utf-8")


# ---------- 分塊上傳（每塊 32 MB，Cloudflare 一次最多 100 MB）----------

def _udir(uid):
    if not re.fullmatch(r"[0-9a-f]{24}", uid or ""):
        raise Bad("上傳編號不對")
    d = os.path.join(config.UPLOAD_DIR, uid)
    if not os.path.isdir(d):
        raise Bad("找不到這個上傳（可能已經完成或過期），請重新選檔案", 404)
    return d


def _check_kind(name, kind):
    ext = os.path.splitext(name)[1].lower()
    allowed = config.LECTURE_EXT if kind == "lecture" else config.BOOK_EXT if kind == "book" else set()
    if ext not in allowed:
        raise Bad("不支援這種檔案（%s）。%s" % (ext or "沒有副檔名", "影音：mp3、m4a、wav、mp4、mov…" if kind == "lecture" else "書：PDF、EPUB、TXT"))
    return ext


@app.post("/uploads")
async def upload_start(request: Request):
    b = await body_json(request)
    name, kind, size = os.path.basename(s(b.get("name"), 300)), s(b.get("kind")), int(b.get("size") or 0)
    _check_kind(name, kind)
    if size <= 0 or size > config.MAX_UPLOAD_GB * 1024 ** 3:
        raise Bad("檔案大小不對（上限 %d GB）" % config.MAX_UPLOAD_GB)
    uid = secrets.token_hex(12)
    d = os.path.join(config.UPLOAD_DIR, uid)
    os.makedirs(d)
    total = (size + config.CHUNK_BYTES - 1) // config.CHUNK_BYTES
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"name": name, "kind": kind, "size": size, "total": total, "meta": b.get("meta") or {}, "at": time.time()}, f, ensure_ascii=False)
    return {"ok": True, "id": uid, "chunk": config.CHUNK_BYTES, "total": total}


def _meta(d):
    with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def _received(d):
    return sorted(int(n[:-5]) for n in os.listdir(d) if n.endswith(".part"))


@app.get("/uploads/{uid}")
def upload_info(uid: str):
    d = _udir(uid)
    m = _meta(d)
    return {"ok": True, "received": _received(d), "total": m["total"], "chunk": config.CHUNK_BYTES}


@app.put("/uploads/{uid}/{i}")
async def upload_part(uid: str, i: int, request: Request):
    d = _udir(uid)
    m = _meta(d)
    if i < 0 or i >= m["total"]:
        raise Bad("分塊編號不對")
    tmp = os.path.join(d, "%d.tmp" % i)
    n = 0
    with open(tmp, "wb") as f:
        async for piece in request.stream():
            n += len(piece)
            if n > config.CHUNK_BYTES:
                f.close()
                os.remove(tmp)
                raise Bad("分塊太大")
            f.write(piece)
    expect = config.CHUNK_BYTES if i < m["total"] - 1 else m["size"] - config.CHUNK_BYTES * (m["total"] - 1)
    if n != expect:
        os.remove(tmp)
        raise Bad("這一塊沒傳完整（%d / %d），會自動重傳" % (n, expect))
    os.replace(tmp, os.path.join(d, "%d.part" % i))
    return {"ok": True, "i": i}


@app.post("/uploads/{uid}/finish")
def upload_finish(uid: str):
    d = _udir(uid)
    m = _meta(d)
    got = _received(d)
    if got != list(range(m["total"])):
        raise Bad("還有 %d 塊沒收到" % (m["total"] - len(got)))
    ext = os.path.splitext(m["name"])[1].lower()
    joined = os.path.join(d, "file" + ext)
    with open(joined, "wb") as out:
        for i in range(m["total"]):
            p = os.path.join(d, "%d.part" % i)
            with open(p, "rb") as f:
                shutil.copyfileobj(f, out, 8 * 1024 * 1024)
            os.remove(p)
    res = create_from_file(joined, m["name"], m["kind"], m["meta"])
    shutil.rmtree(d, ignore_errors=True)
    return res


def create_from_file(path, name, kind, meta):
    ext = _check_kind(name, kind)
    meta = meta if isinstance(meta, dict) else {}
    if kind == "lecture":
        title = s(meta.get("title"), 200) or os.path.splitext(name)[0]
        lang = meta.get("lang") if meta.get("lang") in ("zh", "en", "auto") else (db.get_setting("prefs", {}) or {}).get("lang", "zh")
        lec = db.one("INSERT INTO lectures (course, title, lang, terms, file_name) VALUES (%s, %s, %s, %s, %s) RETURNING *",
                     (s(meta.get("course"), 200), title, lang, s(meta.get("terms"), 3000), name))
        dest = os.path.join(config.MEDIA_DIR, "lecture-%d%s" % (lec["id"], ext))
        shutil.move(path, dest)
        db.run("UPDATE lectures SET media_path = %s WHERE id = %s", (dest, lec["id"]))
        j = jobs.add("lecture", lec["id"], title)
        return {"ok": True, "lecture_id": lec["id"], "job": j}
    bid = int(meta.get("book_id") or 0)
    if bid:
        b = _book(bid)
    else:
        b = db.one("INSERT INTO books (title, author, shelf) VALUES (%s, %s, 'reading') RETURNING *",
                   (s(meta.get("title"), 200) or os.path.splitext(name)[0], s(meta.get("author"), 200)))
    dest = os.path.join(config.BOOK_DIR, "book-%d%s" % (b["id"], ext))
    if b.get("file_path") and os.path.isfile(b["file_path"]) and b["file_path"] != dest:
        os.remove(b["file_path"])
    shutil.move(path, dest)
    db.run("UPDATE books SET file_name = %s, file_path = %s, status = 'queued', updated_at = now() WHERE id = %s", (name, dest, b["id"]))
    j = jobs.add("bookfile", b["id"], "索引《%s》" % b["title"])
    return {"ok": True, "book_id": b["id"], "job": j}


# ---------- 電腦的待處理資料夾 ----------

@app.get("/inbox")
def inbox():
    files = []
    for n in sorted(os.listdir(config.INBOX_DIR)):
        p = os.path.join(config.INBOX_DIR, n)
        ext = os.path.splitext(n)[1].lower()
        if os.path.isfile(p) and (ext in config.LECTURE_EXT or ext in config.BOOK_EXT):
            st = os.stat(p)
            files.append({"name": n, "size": st.st_size, "mtime": int(st.st_mtime),
                          "kind": "lecture" if ext in config.LECTURE_EXT else "book"})
    return {"ok": True, "files": files, "dir": config.INBOX_DIR}


@app.post("/inbox/import")
async def inbox_import(request: Request):
    b = await body_json(request)
    name = os.path.basename(s(b.get("name"), 300))
    p = os.path.join(config.INBOX_DIR, name)
    if not name or os.path.dirname(os.path.realpath(p)) != os.path.realpath(config.INBOX_DIR) or not os.path.isfile(p):
        raise Bad("找不到這個檔案", 404)
    tmp = os.path.join(config.UPLOAD_DIR, "inbox-" + secrets.token_hex(6) + os.path.splitext(name)[1].lower())
    shutil.move(p, tmp)
    try:
        return create_from_file(tmp, name, s(b.get("kind")), b.get("meta") or {})
    except Exception:
        if os.path.isfile(tmp):
            shutil.move(tmp, p)    # 失敗就放回去
        raise


# ---------- 課程 ----------

@app.get("/lectures")
def lectures():
    rows = db.all("SELECT id, course, title, lang, duration, status, created_at, summary IS NOT NULL AS summarized, "
                  "starred, summary->>'overview' AS overview FROM lectures ORDER BY created_at DESC")
    return {"ok": True, "lectures": rows}


def _lec(lid):
    r = db.one("SELECT * FROM lectures WHERE id = %s", (lid,))
    if not r:
        raise Bad("找不到這堂課", 404)
    return r


@app.get("/lectures/{lid}")
def lecture_get(lid: int):
    lec = _lec(lid)
    for k in ("media_path", "audio_path"):
        lec[k] = bool(lec[k])
    segs = db.all("SELECT idx, t0, t1, text FROM segments WHERE lecture_id = %s ORDER BY idx", (lid,))
    job = db.one("SELECT id, kind, status, step, progress, error FROM jobs WHERE ref_id = %s AND kind IN ('lecture', 'resummarize') "
                 "ORDER BY id DESC LIMIT 1", (lid,))
    return {"ok": True, "lecture": lec, "segments": segs, "job": job}


@app.patch("/lectures/{lid}")
async def lecture_edit(lid: int, request: Request):
    _lec(lid)
    b = await body_json(request)
    lang = b.get("lang") if b.get("lang") in ("zh", "en", "auto") else None
    db.run("UPDATE lectures SET title = COALESCE(NULLIF(%s, ''), title), course = %s, terms = %s, lang = COALESCE(%s, lang) WHERE id = %s",
           (s(b.get("title"), 200), s(b.get("course"), 200), s(b.get("terms"), 3000), lang, lid))
    return {"ok": True}


@app.delete("/lectures/{lid}")
def lecture_del(lid: int):
    lec = _lec(lid)
    db.run("DELETE FROM lectures WHERE id = %s", (lid,))
    db.run("UPDATE jobs SET status = 'error', error = '已刪除' WHERE ref_id = %s AND kind IN ('lecture', 'resummarize') AND status = 'queued'", (lid,))
    for p in (lec["media_path"], lec["audio_path"]):
        if p and os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass
    return {"ok": True}


@app.post("/lectures/{lid}/resummarize")
def lecture_resum(lid: int):
    lec = _lec(lid)
    j = jobs.add("resummarize", lid, "重新摘要：%s" % lec["title"])
    return {"ok": True, "job": j}


@app.post("/lectures/{lid}/retranscribe")
def lecture_retrans(lid: int):
    lec = _lec(lid)
    if not os.path.isfile(lec["media_path"]):
        raise Bad("原始檔案已經不在了，不能重新轉逐字稿")
    db.run("DELETE FROM segments WHERE lecture_id = %s", (lid,))
    db.run("DELETE FROM chunks WHERE lecture_id = %s", (lid,))
    db.run("UPDATE lectures SET status = 'queued' WHERE id = %s", (lid,))
    j = jobs.add("lecture", lid, lec["title"])
    return {"ok": True, "job": j}


def _range_file(path, request, ctype):
    size = os.path.getsize(path)
    rng = request.headers.get("range", "")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
    start, end, code = 0, size - 1, 200
    if m and (m.group(1) or m.group(2)):
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        else:
            start, end = max(0, size - int(m.group(2))), size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": "bytes */%d" % size})
        code = 206

    def gen():
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                b = f.read(min(1024 * 512, left))
                if not b:
                    break
                left -= len(b)
                yield b
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1), "Cache-Control": "private, max-age=86400"}
    if code == 206:
        headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
    return StreamingResponse(gen(), status_code=code, media_type=ctype, headers=headers)


@app.get("/lectures/{lid}/audio")
def lecture_audio(lid: int, request: Request):
    lec = _lec(lid)
    if not lec["audio_path"] or not os.path.isfile(lec["audio_path"]):
        raise Bad("音訊還沒準備好", 404)
    return _range_file(lec["audio_path"], request, "audio/mp4")


@app.get("/lectures/{lid}/export")
def lecture_export(lid: int):
    lec = _lec(lid)
    sm = lec.get("summary") or {}
    out = ["# %s%s" % ((lec["course"] + "｜") if lec["course"] else "", lec["title"]), ""]
    if sm.get("overview"):
        out += ["## 總覽", "", sm["overview"], ""]
    for sec in sm.get("sections") or []:
        out += ["## [%s] %s" % (fmt_t(sec.get("start") or 0), sec.get("title", "")), "", sec.get("summary", ""), ""]
        out += ["- [%s] %s" % (fmt_t(p["t"] or 0), p["text"]) for p in sec.get("points") or []]
        out.append("")
    if sm.get("details"):
        out += ["## 細節", ""] + ["- （%s）[%s] %s" % (d["kind"], fmt_t(d["t"] or 0), d["text"]) for d in sm["details"]] + [""]
    if sm.get("terms"):
        out += ["## 術語", ""] + ["- **%s**：%s" % (t["term"], t["explain"]) for t in sm["terms"]] + [""]
    if sm.get("questions"):
        out += ["## 複習問題", ""] + ["%d. %s" % (i + 1, q) for i, q in enumerate(sm["questions"])] + [""]
    out += ["## 逐字稿", ""]
    for sg in db.all("SELECT t0, text FROM segments WHERE lecture_id = %s ORDER BY idx", (lid,)):
        out.append("[%s] %s" % (fmt_t(sg["t0"]), sg["text"]))
    return PlainTextResponse("\n".join(out), media_type="text/markdown; charset=utf-8")


# ---------- 工作 ----------

@app.get("/jobs")
def job_list(active: int = 0, limit: int = 20):
    if active:
        rows = db.all("SELECT * FROM jobs WHERE status IN ('queued', 'running') OR (status IN ('done', 'error') AND updated_at > now() - interval '30 seconds') "
                      "ORDER BY id")
    else:
        rows = db.all("SELECT * FROM jobs ORDER BY id DESC LIMIT %s", (min(max(limit, 1), 100),))
    return {"ok": True, "jobs": rows}


@app.post("/jobs/{jid}/retry")
def job_retry(jid: int):
    j = db.one("UPDATE jobs SET status = 'queued', error = '', step = '重新排隊', progress = 0, updated_at = now() "
               "WHERE id = %s AND status = 'error' RETURNING *", (jid,))
    if not j:
        raise Bad("這個工作不能重試")
    return {"ok": True, "job": j}


# ---------- 知識庫問答 ----------

@app.post("/ask")
async def ask(request: Request):
    b = await body_json(request)
    q = s(b.get("question"), 2000)
    if not q:
        raise Bad("請輸入問題")
    return dict(knowledge.ask(q, s(b.get("scope"), 40) or "all"), ok=True)


@app.get("/asks")
def asks(limit: int = 20):
    return {"ok": True, "asks": db.all("SELECT * FROM asks ORDER BY id DESC LIMIT %s", (min(max(limit, 1), 100),))}


@app.delete("/asks/{aid}")
def ask_del(aid: int):
    db.run("DELETE FROM asks WHERE id = %s", (aid,))
    return {"ok": True}


# ---------- 助理對話 ----------

@app.get("/chats")
def chats_list(limit: int = 30):
    return {"ok": True, "chats": chat.recent(min(max(limit, 1), 100))}


@app.get("/chats/{cid}")
def chat_get(cid: int):
    r = chat.get(cid)
    if not r:
        raise Bad("找不到這段對話", 404)
    return dict(r, ok=True)


@app.post("/chat")
async def chat_send(request: Request):
    b = await body_json(request)
    text = s(b.get("message"), 4000)
    if not text:
        raise Bad("請輸入訊息")
    try:
        r = await asyncio.to_thread(chat.send, int(b.get("chat_id") or 0) or None, text, "all",
                                    bool(b.get("kb", True)), bool(b.get("web", False)), b.get("pins") or [],
                                    s(b.get("balance"), 10) or "kb")
        return dict(r, ok=True)
    except ValueError as e:
        raise Bad(str(e), 404)


@app.post("/stt")
async def stt(request: Request):
    """語音模式：手機錄的一小段話 → 文字"""
    data = await request.body()
    if not data or len(data) > 25 * 1024 * 1024:
        raise Bad("錄音是空的或太長了（一次最多約 3 分鐘）")
    ext = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav"}.get(
        request.headers.get("content-type", "").split(";")[0].strip(), ".webm")
    os.makedirs(os.path.join(config.DATA_DIR, "tmp"), exist_ok=True)
    path = os.path.join(config.DATA_DIR, "tmp", "stt-%d%s" % (int(time.time() * 1000), ext))
    with open(path, "wb") as f:
        f.write(data)
    try:
        text = await asyncio.to_thread(engines.dictate, path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if not text:
        raise Bad("沒聽到內容，再說一次看看")
    return {"ok": True, "text": text}


@app.delete("/chats/{cid}")
def chat_del(cid: int):
    db.run("DELETE FROM chats WHERE id = %s", (cid,))
    return {"ok": True}


# ---------- 知識複習 ----------

@app.get("/reviews")
def reviews():
    rows = db.all("SELECT id, week_start, range_end, auto, status, updated_at, content->>'headline' AS headline FROM reviews ORDER BY week_start DESC LIMIT 60")
    for r in rows:
        r["week_start"] = r["week_start"].isoformat()
    return {"ok": True, "reviews": rows}


@app.get("/reviews/{rid}")
def review_get(rid: int):
    r = db.one("SELECT * FROM reviews WHERE id = %s", (rid,))
    if not r:
        raise Bad("找不到這篇複習", 404)
    r["week_start"] = r["week_start"].isoformat()
    r["job"] = db.one("SELECT id, kind, status, step, progress, error FROM jobs WHERE kind = 'review' AND ref_id = %s ORDER BY id DESC LIMIT 1", (rid,))
    return {"ok": True, "review": r}


@app.post("/reviews")
def review_make():
    """手動：產生（或重做）本週至今的複習"""
    r, j = review.request()
    return {"ok": True, "review_id": r["id"], "job": j}


@app.get("/search")
def search(q: str, scope: str = "all"):
    return {"ok": True, "results": knowledge.search(q, scope, 12)}


# ---------- 朗讀 ----------

@app.post("/tts/split")
async def tts_split(request: Request):
    b = await body_json(request)
    text = s(b.get("text"), 30000)
    if not text:
        raise Bad("請輸入要唸的文字")
    return {"ok": True, "parts": tts_parts(text)}


@app.get("/tts/audio")
def tts_audio(text: str, lang: str = "zh", speed: float = 1.0):
    if not text.strip() or len(text) > 1000:
        raise Bad("文字長度不對")
    return Response(tts.synth(text, lang, speed), media_type="audio/wav", headers={"Cache-Control": "private, max-age=86400"})


@app.post("/tts/full")
async def tts_full(request: Request):
    b = await body_json(request)
    parts = [s(p, 1000) for p in (b.get("parts") or []) if s(p)][:400]
    if not parts:
        raise Bad("沒有內容")
    wav = tts.join_wavs([tts.synth(p, b.get("lang", "zh"), b.get("speed", 1.0)) for p in parts])
    return Response(wav, media_type="audio/wav", headers={"Content-Disposition": 'attachment; filename="reading.wav"'})
