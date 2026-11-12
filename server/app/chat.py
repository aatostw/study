"""助理：一串一串的對話。

一般訊息 → 翻知識庫回答（看得懂追問）；
「評估《某本書》」→ 加進想讀清單並開始評估，回一張卡片。"""
import re

import concurrent.futures as cf
from urllib.parse import urlparse

from . import ai, db, jobs, knowledge, websearch
from .db import Jsonb

EVAL_RE = re.compile(r"(評估|值不值得[讀看買]|值得[讀看]嗎|該不該讀|適不適合我)")


def _eval_title(msg):
    if not EVAL_RE.search(msg):
        return None
    m = re.search(r"[《〈「『\"](.+?)[》〉」』\"]", msg)
    if m:
        return m.group(1).strip()
    m = re.match(r"^\s*(?:幫我|請)?\s*評估(?:一下)?\s*(?:這本書|這本)?\s*[:：]?\s*(.{1,40}?)\s*(?:這本書|這本)?\s*[。？?！!]*$", msg)
    title = m.group(1).strip() if m else ""
    return title if title and title not in ("一下", "這本書", "這本", "書") else None


def _msg(row):
    row = dict(row)
    row["created_at"] = row["created_at"].isoformat()
    return row


SYSTEM_KB = (
    "你是使用者的個人學習助理。回答以使用者書櫃裡的資料（他讀的書、寫的筆記、上的課）為主；"
    "有網路資料時可以拿來補充、對照，但要分清楚哪些是他的資料、哪些是網路上的說法。\n"
    "規則：\n"
    "1. 每個論點後面用 [編號] 標出處，可以多個，例如 [2][5]。不要編造編號。\n"
    "2. 資料都沒有提到的，可以用一般知識補充，但要標明「（一般知識）」。\n"
    "3. 書櫃資料和網路說法不同時，主動指出來。\n"
    "4. 用台灣繁體中文；專有名詞保留原文。條理清楚，可以用短段落或條列，不用 Markdown 標題。")
SYSTEM_WEB = (
    "你是使用者的學習助理。根據下面的網路搜尋結果回答，每個論點後面用 [編號] 標出處，不要編造編號；"
    "搜尋結果不夠時可以用一般知識補充，但要標明「（一般知識）」。來源互相矛盾時指出來。"
    "用台灣繁體中文；專有名詞保留原文；可以用短段落或條列，不用 Markdown 標題。")
SYSTEM_FREE = (
    "你是使用者的學習夥伴，直接用你自己的知識和他聊、回答問題，不需要標出處。"
    "說不確定的事要講明不確定。用台灣繁體中文；專有名詞保留原文；可以用短段落或條列，不用 Markdown 標題。")


def _web_sources(query, start_n):
    """自架 SearXNG 搜尋，讀前幾頁的正文，整理成可以引用的來源"""
    from .bookeval import BLOCK
    hits = [h for h in websearch.search(query, n=10) if not BLOCK.search(h["url"])][:6]
    keys = [w for w in re.split(r"[\s，。？！、,.?!]+", query) if len(w) >= 2][:8]

    def read(h):
        if len(h["snippet"]) > 400:
            return h["snippet"]
        try:
            r = websearch.fetch(h["url"])
            return websearch.excerpt(r["text"], keys, 1500) if r.get("ok") and r.get("text") else h["snippet"]
        except Exception:
            return h["snippet"]
    with cf.ThreadPoolExecutor(4) as ex:
        texts = list(ex.map(read, hits[:4])) + [h["snippet"] for h in hits[4:]]
    out = []
    for i, (h, txt) in enumerate(zip(hits, texts)):
        if txt:
            out.append({"n": start_n + len(out), "kind": "web", "label": h["title"] or urlparse(h["url"]).netloc,
                        "url": h["url"], "domain": urlparse(h["url"]).netloc.replace("www.", ""), "text": txt[:1500]})
    return out


def respond(text, history, use_kb=True, use_web=False):
    """依照開關回答：書櫃為主／網路搜尋／都不開就直接聊"""
    search_text = text if len(text) >= 16 or not history else history[-1][0] + "\n" + text
    sources, note = [], ""
    if use_kb:
        for s in knowledge.search(search_text, "all", 8 if use_web else 10):
            sources.append(s)
    if use_web:
        try:
            sources += _web_sources(search_text.replace("\n", " ")[:200], len(sources) + 1)
        except Exception as e:
            note = "（網路搜尋現在連不到：%s）\n\n" % e
    for i, s in enumerate(sources, 1):
        s["n"] = i
    hist = ""
    if history:
        hist = "先前的對話（只用來理解問題在指什麼）：\n" + "\n".join(
            "使用者：%s\n助理：%s" % (q, re.sub(r"\[\d{1,2}\]", "", a)[:600]) for q, a in history[-3:]) + "\n\n"
    if sources:
        blocks = "\n\n".join("[%d] %s%s\n%s" % (s["n"], "（網路）" if s["kind"] == "web" else "（書櫃）", s["label"], s["text"]) for s in sources)
        prompt = "資料：\n\n" + blocks + "\n\n" + hist + "問題：" + text
        system = SYSTEM_KB if use_kb else SYSTEM_WEB
    else:
        if use_kb and not use_web and not note:
            note = "（書櫃裡沒有找到相關資料，以下是一般知識）\n\n"
        prompt = hist + "問題：" + text
        system = SYSTEM_FREE
    answer, used = ai.generate("ask", prompt, system=system, max_tokens=4096)
    cited = {int(n) for n in re.findall(r"\[(\d{1,2})\]", answer)}
    for s in sources:
        s["cited"] = s["n"] in cited
    return {"answer": note + answer, "sources": sources, "model": used}


def send(chat_id, text, scope="all", use_kb=True, use_web=False):
    if chat_id:
        chat = db.one("SELECT * FROM chats WHERE id = %s", (chat_id,))
        if not chat:
            raise ValueError("找不到這段對話")
    else:
        chat = db.one("INSERT INTO chats (title) VALUES (%s) RETURNING *", (text[:40],))
    cid = chat["id"]
    prev = db.all("SELECT role, content FROM chat_msgs WHERE chat_id = %s ORDER BY id DESC LIMIT 6", (cid,))[::-1]
    scope = ("kb" if use_kb else "") + ("+web" if use_web else "") or "free"
    user = db.one("INSERT INTO chat_msgs (chat_id, role, content, scope) VALUES (%s, 'user', %s, %s) RETURNING *", (cid, text, scope))

    title = _eval_title(text)
    if title:
        book = db.one("SELECT id FROM books WHERE title = %s ORDER BY id DESC LIMIT 1", (title,)) or \
            db.one("INSERT INTO books (title, shelf) VALUES (%s, 'wish') RETURNING id", (title,))
        jobs.add("evaluate", book["id"], "評估《%s》" % title)
        reply = db.one("INSERT INTO chat_msgs (chat_id, role, content, scope, card) VALUES (%s, 'assistant', %s, %s, %s) RETURNING *",
                       (cid, "好，我上網找《%s》的讀者心得和作者背景，大約 1～3 分鐘。好了以後點下面的卡片看評估，書也會加進你的書櫃（想讀）。" % title,
                        scope, Jsonb({"type": "eval", "book_id": book["id"]})))
    else:
        history, q = [], None
        for m in prev:
            if m["role"] == "user":
                q = m["content"]
            elif q is not None:
                history.append((q, m["content"]))
                q = None
        # 短的追問（「那他怎麼說？」）會帶上一題一起找資料
        r = respond(text, history, use_kb, use_web)
        reply = db.one("INSERT INTO chat_msgs (chat_id, role, content, scope, sources, model) VALUES (%s, 'assistant', %s, %s, %s, %s) RETURNING *",
                       (cid, r["answer"], scope, Jsonb(r["sources"]), r["model"]))
    db.run("UPDATE chats SET updated_at = now() WHERE id = %s", (cid,))
    return {"chat": {"id": cid, "title": chat["title"]}, "messages": [_msg(user), _msg(reply)]}


def get(cid):
    chat = db.one("SELECT id, title, created_at, updated_at FROM chats WHERE id = %s", (cid,))
    if not chat:
        return None
    msgs = [_msg(m) for m in db.all("SELECT * FROM chat_msgs WHERE chat_id = %s ORDER BY id", (cid,))]
    return {"chat": chat, "messages": msgs}


def recent(limit=30):
    return db.all("SELECT c.id, c.title, c.updated_at, (SELECT count(*) FROM chat_msgs m WHERE m.chat_id = c.id) AS n "
                  "FROM chats c ORDER BY c.updated_at DESC LIMIT %s", (limit,))
