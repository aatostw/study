"""助理：一串一串的對話。

一般訊息 → 翻知識庫回答（看得懂追問）；
「評估《某本書》」→ 加進想讀清單並開始評估，回一張卡片。"""
import re

from . import db, jobs, knowledge
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


def send(chat_id, text, scope="all"):
    if chat_id:
        chat = db.one("SELECT * FROM chats WHERE id = %s", (chat_id,))
        if not chat:
            raise ValueError("找不到這段對話")
    else:
        chat = db.one("INSERT INTO chats (title) VALUES (%s) RETURNING *", (text[:40],))
    cid = chat["id"]
    prev = db.all("SELECT role, content FROM chat_msgs WHERE chat_id = %s ORDER BY id DESC LIMIT 6", (cid,))[::-1]
    user = db.one("INSERT INTO chat_msgs (chat_id, role, content, scope) VALUES (%s, 'user', %s, %s) RETURNING *", (cid, text, scope))

    title = _eval_title(text)
    if title:
        book = db.one("SELECT id FROM books WHERE shelf = 'wish' AND title = %s", (title,)) or \
            db.one("INSERT INTO books (title, shelf) VALUES (%s, 'wish') RETURNING id", (title,))
        jobs.add("evaluate", book["id"], "評估《%s》" % title)
        reply = db.one("INSERT INTO chat_msgs (chat_id, role, content, scope, card) VALUES (%s, 'assistant', %s, %s, %s) RETURNING *",
                       (cid, "好，我上網找《%s》的讀者心得和作者背景，大約 1～3 分鐘。好了以後點下面的卡片看評估，也會放進想讀清單。" % title,
                        scope, Jsonb({"type": "eval", "book_id": book["id"]})))
    else:
        history, q = [], None
        for m in prev:
            if m["role"] == "user":
                q = m["content"]
            elif q is not None:
                history.append((q, m["content"]))
                q = None
        # 短的追問（「那他怎麼說？」）要帶上一題一起找資料
        search_text = text if len(text) >= 16 or not history else history[-1][0] + "\n" + text
        r = knowledge.answer(text, scope, history=history[-3:], search_text=search_text)
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
