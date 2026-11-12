# -*- coding: utf-8 -*-
"""知識庫：把筆記、書、課程轉成向量；搜尋；有出處的問答。"""
import math
import re
import time

from . import ai, db, engines
from .db import Jsonb
from .textutil import chunk_text, fmt_t

# ---------- 寫入 ----------

def note_text(n):
    parts = []
    if n.get("title"):
        parts.append("標題：" + n["title"])
    if n.get("quote"):
        parts.append("摘句：" + n["quote"])
    if n.get("content"):
        parts.append("想法：" + n["content"])
    return "\n".join(parts)


def index_note(note_id):
    n = db.one("SELECT * FROM notes WHERE id = %s", (note_id,))
    if not n:
        return
    pieces = chunk_text(note_text(n), 700) or []
    vecs = engines.embed(pieces)
    with db.connect() as c:
        c.execute("DELETE FROM chunks WHERE note_id = %s", (note_id,))
        for text, v in zip(pieces, vecs):
            c.execute("INSERT INTO chunks (kind, book_id, note_id, page, chapter, text, embedding) "
                      "VALUES ('note', %s, %s, %s, %s, %s, %s)",
                      (n["book_id"], note_id, n["page"], n["chapter"], text, v))


def notes_indexer():
    """背景：還沒有向量的筆記，一筆一筆補上（新增、修改筆記都會清掉舊向量）"""
    while True:
        try:
            rows = db.all("SELECT n.id FROM notes n WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.note_id = n.id) "
                          "AND (n.quote <> '' OR n.content <> '') ORDER BY n.id LIMIT 20")
            for r in rows:
                index_note(r["id"])
            time.sleep(2 if rows else 4)
        except Exception as e:  # 向量模型還沒好之類的，等一下再試
            print("  [筆記索引] %s" % str(e)[:200], flush=True)
            time.sleep(20)


def insert_chunks(rows, progress=None):
    """rows: [dict(kind, book_id, lecture_id, page, chapter, t0, t1, text)]"""
    batch = 32
    for i in range(0, len(rows), batch):
        part = rows[i:i + batch]
        vecs = engines.embed([r["text"] for r in part])
        with db.connect() as c:
            for r, v in zip(part, vecs):
                c.execute("INSERT INTO chunks (kind, book_id, lecture_id, page, chapter, t0, t1, text, embedding) "
                          "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                          (r["kind"], r.get("book_id"), r.get("lecture_id"), r.get("page", ""), r.get("chapter", ""),
                           r.get("t0"), r.get("t1"), r["text"], v))
        if progress:
            progress(min(1.0, (i + batch) / max(1, len(rows))))


def lecture_windows(segments, max_chars=420, max_sec=75):
    """把逐字稿的小段合成約 1 分鐘一塊，搜尋到時能直接跳到那個時間"""
    out, cur = [], []
    for s in segments:
        if cur and (sum(len(x["text"]) for x in cur) + len(s["text"]) > max_chars or s["t1"] - cur[0]["t0"] > max_sec):
            out.append(cur)
            cur = cur[-1:]                       # 重疊一段
        cur.append(s)
    if cur:
        out.append(cur)
    return [{"t0": w[0]["t0"], "t1": w[-1]["t1"], "text": " ".join(x["text"] for x in w)} for w in out]


# ---------- 搜尋 ----------

def _scope_sql(scope):
    if scope == "books":
        return "c.kind IN ('note', 'book')", ()
    if scope == "lectures":
        return "c.kind = 'lecture'", ()
    m = re.match(r"^(book|lecture):(\d+)$", scope or "")
    if m:
        return ("c.book_id = %s" if m.group(1) == "book" else "c.lecture_id = %s"), (int(m.group(2)),)
    return "TRUE", ()


def search(query, scope="all", k=10):
    v = engines.embed([query])[0]
    where, args = _scope_sql(scope)
    rows = db.all(
        "SELECT c.id, c.kind, c.book_id, c.note_id, c.lecture_id, c.page, c.chapter, c.t0, c.t1, c.text, "
        "b.title AS book_title, b.author, l.title AS lecture_title, l.course, n.title AS note_title, "
        "1 - (c.embedding <=> %s::vector) AS score "
        "FROM chunks c LEFT JOIN books b ON b.id = c.book_id LEFT JOIN lectures l ON l.id = c.lecture_id LEFT JOIN notes n ON n.id = c.note_id "
        "WHERE c.embedding IS NOT NULL AND " + where + " ORDER BY c.embedding <=> %s::vector LIMIT %s",
        (v,) + args + (v, k))
    return [source_view(r) for r in rows]


def source_view(r):
    if r["kind"] == "lecture":
        label = "%s%s @ %s" % ((r["course"] + "｜") if r.get("course") else "", r["lecture_title"], fmt_t(r["t0"]))
    elif r["kind"] == "note" and not r.get("book_id"):
        label = "記事本：%s" % (r.get("note_title") or "（無標題）")
    else:
        bits = ["《%s》" % r["book_title"]]
        if r.get("chapter"):
            bits.append(r["chapter"])
        if r.get("page"):
            bits.append("p.%s" % r["page"])
        bits.append("我的筆記" if r["kind"] == "note" else "原文")
        label = " ".join(bits)
    score = float(r.get("score") or 0)
    if math.isnan(score):
        score = 0.0
    return {"kind": r["kind"], "label": label, "text": r["text"], "score": round(score, 3),
            "book_id": r.get("book_id"), "note_id": r.get("note_id"), "lecture_id": r.get("lecture_id"),
            "t0": r.get("t0"), "page": r.get("page"), "chapter": r.get("chapter")}


ASK_SYSTEM = (
    "你是使用者的個人學習助理，幫他整理自己讀過的書、寫過的筆記、上過的課。\n"
    "規則：\n"
    "1. 只根據使用者提供的「資料」回答；資料沒有的就直說「資料裡沒有提到」，可以補一句一般常識但要標明「（一般知識，非你的資料）」。\n"
    "2. 每個論點後面用 [編號] 標出處，可以多個，例如 [2][5]。不要編造編號。\n"
    "3. 不同來源互相呼應或矛盾時，主動指出來（例如：書裡這樣說，但教授上課那樣說）。\n"
    "4. 用台灣繁體中文；專有名詞保留原文。條理清楚，可以用短段落或條列，不用 Markdown 標題。"
)


def answer(question, scope="all", k=10, history=None, search_text=None):
    """找資料、請 AI 回答；history = [(問, 答), ...] 讓追問聽得懂前文"""
    sources = search(search_text or question, scope, k)
    if not sources:
        return {"answer": "知識庫裡還沒有資料可以回答。先新增筆記或處理一堂課。", "sources": [], "model": ""}
    blocks = []
    for i, s in enumerate(sources, 1):
        blocks.append("[%d] %s\n%s" % (i, s["label"], s["text"]))
    prompt = "資料：\n\n" + "\n\n".join(blocks)
    if history:
        prompt += "\n\n先前的對話（只用來理解問題在指什麼，引用編號以這次的資料為準）：\n" + "\n".join(
            "使用者：%s\n助理：%s" % (q, re.sub(r"\[\d{1,2}\]", "", a)[:600]) for q, a in history)
    prompt += "\n\n問題：" + question
    text, used = ai.generate("ask", prompt, system=ASK_SYSTEM, max_tokens=4096)
    cited = {int(n) for n in re.findall(r"\[(\d{1,2})\]", text)}
    for i, s in enumerate(sources, 1):
        s["n"] = i
        s["cited"] = i in cited
    return {"answer": text, "sources": sources, "model": used}


def ask(question, scope="all", k=10):
    r = answer(question, scope, k)
    if not r["sources"]:
        return r
    row = db.one("INSERT INTO asks (question, scope, answer, sources, model) VALUES (%s, %s, %s, %s, %s) RETURNING id, created_at",
                 (question, scope, r["answer"], Jsonb(r["sources"]), r["model"]))
    return dict(r, id=row["id"], question=question, scope=scope, created_at=row["created_at"].isoformat())
