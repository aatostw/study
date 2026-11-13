"""助理：一串一串的對話。

一般訊息 → 翻知識庫回答（看得懂追問）；
「評估《某本書》」→ 加進想讀清單並開始評估，回一張卡片。"""
import re

import concurrent.futures as cf
from urllib.parse import urlparse

from . import ai, db, engines, jobs, knowledge, websearch
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
    row.pop("pool", None)
    row["created_at"] = row["created_at"].isoformat()
    return row


SYSTEM_KB = (
    "你是使用者的個人學習助理。回答以使用者書櫃裡的資料（他讀的書、寫的筆記、上的課）為主；"
    "有網路資料時可以拿來補充、對照，但要分清楚哪些是他的資料、哪些是網路上的說法。\n"
    "規則：\n"
    "1. 每個論點後面用 [編號] 標出處，可以多個，例如 [2][5]。不要編造編號。\n"
    "2. 資料都沒有提到的，可以用一般知識補充，但要標明「（一般知識）」。\n"
    "3. 書櫃資料和網路說法不同時，主動指出來。\n"
    "4. 問到「我記了什麼、我畫了什麼、我的筆記」時，只能用標「（書櫃）」的資料回答，網路資料不能當成他的筆記；"
    "標題寫著「《書名》…的筆記」或「我的筆記」的段落就是他的筆記，書名簡繁體不同也算同一本。\n"
    "5. 用台灣繁體中文；專有名詞保留原文。條理清楚，可以用短段落或條列，不用 Markdown 標題。")
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


POOL_KB, POOL_WEB, KEEP = 25, 6, 8


def _key(s):
    return "web:" + s["url"] if s["kind"] == "web" else "kb:%s" % (s.get("cid") or s["label"] + s["text"][:40])


MINE_RE = re.compile(r"我.{0,24}?(記了|記下|記過|寫了|寫過|畫了|畫線|劃了|劃線|筆記|摘了|摘錄|標了|上過|讀過|心得|重點)")


BALANCE = {"kb": (0.05, 0.0), "even": (0.0, 0.0), "web": (0.0, 0.1)}   # (書櫃加分, 網路加分)


def _rank(query, cands, cited_keys, use_kb, balance="kb"):
    """本機重新排名，加權後只留最相關的幾段。排序模型不能用時，退回原本的向量分數。"""
    # 排名時連標題一起看（「《允許一切發生》第一章 我的筆記」），不然只看內容會認不出是哪本書
    scores = engines.rerank(query, [c["label"] + "\n" + c["text"] for c in cands])
    mine = bool(MINE_RE.search(query))      # 問「我記了什麼」：答案一定在自己的資料，網路只能當背景
    ranked = []
    for i, c in enumerate(cands):
        base = scores[i] if scores is not None else float(c.get("score") or 0.5) * (0.97 ** i)
        w = base
        if _key(c) in cited_keys:
            w += 0.08                      # 上一輪真的引用過：跟這段對話有關
        kb_b, web_b = BALANCE.get(balance, BALANCE["kb"])
        if use_kb and c["kind"] != "web":
            w += kb_b                      # 書櫃為主：書櫃資料優先
        if c["kind"] == "web":
            w += web_b                     # 網路為主：網路資料優先
        if c.get("named"):
            w += 0.25 if c["kind"] == "note" else 0.15     # 問題裡直接點名的書／課／筆記（自己的筆記最優先）
        if mine and c["kind"] == "web":
            w -= 0.35
        c = dict(c, rel=round(base, 3), weight=round(w, 3))
        ranked.append(c)
    ranked.sort(key=lambda c: -c["weight"])
    top = [c for c in ranked if c["rel"] >= 0.08 or c.get("named") or scores is None][:KEEP]
    if len(top) < 3:
        top = ranked[:min(3, len(ranked))]
    for c in top:
        c["level"] = "高" if c["rel"] >= 0.6 else "中" if c["rel"] >= 0.25 else "低"
    return top, ranked[:40], scores is not None


def respond(text, history, use_kb=True, use_web=False, prev_pool=None, cited_keys=(), pins=None, balance="kb"):
    """依照開關回答：書櫃為主／網路搜尋／都不開就直接聊。
    追問時，上一題的候選資料和這題新搜到的合在一起重新排名，只留 6～8 段給 AI。"""
    search_text = text if len(text) >= 16 or not history else history[-1][0] + "\n" + text
    note, cands, seen = "", [], set()

    def add(c):
        k = _key(c)
        if k not in seen:
            seen.add(k)
            cands.append(c)
    scope = "all"
    if pins:                                             # 指定：只在勾選的項目裡找
        use_kb = True
        scope = "pins:" + ",".join("%s:%d" % (p["kind"], int(p["id"])) for p in pins)
        for s in knowledge.pinned_chunks(pins):
            add(dict(s, named=True))
    elif use_kb:
        for s in knowledge.search_titles(search_text):      # 直接點名的書／課／筆記
            add(dict(s, named=True))
    if use_kb:
        for s in knowledge.search(search_text, scope, POOL_KB):
            add(s)
    if use_web:
        try:
            for s in _web_sources(search_text.replace("\n", " ")[:200], 1):
                add(s)
        except Exception as e:
            note = "（網路搜尋現在連不到：%s）\n\n" % e
    pin_ok = None
    if pins:
        pin_ok = {(p["kind"], int(p["id"])) for p in pins}
    for c in prev_pool or []:      # 上一題的候選，照這次的開關和指定範圍過濾
        if c["kind"] == "web":
            if use_web:
                add(c)
        elif use_kb and (pin_ok is None or ("book", c.get("book_id")) in pin_ok or ("note", c.get("note_id")) in pin_ok
                         or ("lecture", c.get("lecture_id")) in pin_ok):
            add(c)

    sources, pool, reranked = [], [], False
    if cands:
        sources, pool, reranked = _rank(text if not history else search_text, cands, set(cited_keys), use_kb,
                                        balance if use_web else "kb")
    for i, s in enumerate(sources, 1):
        s["n"] = i
    hist = ""
    if history:
        hist = "先前的對話（只用來理解問題在指什麼）：\n" + "\n".join(
            "使用者：%s\n助理：%s" % (q, re.sub(r"\[\d{1,2}\]", "", a)[:600]) for q, a in history[-3:]) + "\n\n"
    if sources:
        # 最相關的放最後、最靠近問題（模型對開頭和結尾讀得最仔細）
        blocks = "\n\n".join("[%d]（相關度：%s）%s%s\n%s" % (s["n"], s["level"], "（網路）" if s["kind"] == "web" else "（書櫃）", s["label"], s["text"])
                             for s in reversed(sources))
        scope_line = ("使用者指定只看這些：%s。書櫃資料只來自它們。\n\n" % "、".join(p.get("label") or "" for p in pins)) if pins else ""
        prompt = (scope_line + "資料（已依相關度排序，越下面越相關；相關度「高」的優先依據，「低」的只在需要時參考）：\n\n"
                  + blocks + "\n\n" + hist + "問題：" + text)
        system = SYSTEM_KB if use_kb else SYSTEM_WEB
        if use_kb and use_web and balance == "even":
            system += "\n補充：這次書櫃資料和網路資料同等重要，兩邊都要納入、互相對照。"
        elif use_kb and use_web and balance == "web":
            system += "\n補充：這次以網路資料為主來回答，書櫃資料用來對照他自己記過什麼（問「我記了什麼」時仍只能用書櫃資料）。"
    else:
        if pins and not note:
            note = "（指定的範圍裡沒有找到相關資料，以下是一般知識）\n\n"
        elif use_kb and not use_web and not note:
            note = "（書櫃裡沒有找到相關資料，以下是一般知識）\n\n"
        prompt = hist + "問題：" + text
        system = SYSTEM_FREE
    answer, used = ai.generate("ask", prompt, system=system, max_tokens=4096)
    cited = {int(n) for n in re.findall(r"\[(\d{1,2})\]", answer)}
    for s in sources:
        s["cited"] = s["n"] in cited
    slim = [{k: v for k, v in c.items() if k not in ("n", "cited", "level")} for c in pool]
    return {"answer": note + answer, "sources": sources, "model": used, "pool": slim, "reranked": reranked}


def send(chat_id, text, scope="all", use_kb=True, use_web=False, pins=None, balance="kb"):
    if chat_id:
        chat = db.one("SELECT * FROM chats WHERE id = %s", (chat_id,))
        if not chat:
            raise ValueError("找不到這段對話")
    else:
        chat = db.one("INSERT INTO chats (title) VALUES (%s) RETURNING *", (text[:40],))
    cid = chat["id"]
    prev = db.all("SELECT role, content, pool, sources FROM chat_msgs WHERE chat_id = %s ORDER BY id DESC LIMIT 6", (cid,))[::-1]
    last_ai = next((m for m in reversed(prev) if m["role"] == "assistant"), None)
    pins = [{"kind": p["kind"], "id": int(p["id"]), "label": str(p.get("label") or "")[:80]}
            for p in (pins or []) if p.get("kind") in ("book", "note", "lecture") and str(p.get("id", "")).isdigit()][:30]
    db.run("UPDATE chats SET pins = %s WHERE id = %s", (Jsonb(pins), cid))
    scope = ("pins" if pins else "kb" if use_kb else "") + ("+web" if use_web else "") or "free"
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
        r = respond(text, history, use_kb, use_web,
                    prev_pool=(last_ai or {}).get("pool") or [],
                    cited_keys=[_key(s) for s in ((last_ai or {}).get("sources") or []) if s.get("cited")], pins=pins, balance=balance if balance in BALANCE else "kb")
        reply = db.one("INSERT INTO chat_msgs (chat_id, role, content, scope, sources, model, pool) VALUES (%s, 'assistant', %s, %s, %s, %s, %s) RETURNING *",
                       (cid, r["answer"], scope, Jsonb(r["sources"]), r["model"], Jsonb(r["pool"])))
    db.run("UPDATE chats SET updated_at = now() WHERE id = %s", (cid,))
    return {"chat": {"id": cid, "title": chat["title"], "pins": pins}, "messages": [_msg(user), _msg(reply)]}


def get(cid):
    chat = db.one("SELECT id, title, pins, created_at, updated_at FROM chats WHERE id = %s", (cid,))
    if not chat:
        return None
    msgs = [_msg(m) for m in db.all("SELECT * FROM chat_msgs WHERE chat_id = %s ORDER BY id", (cid,))]
    return {"chat": chat, "messages": msgs}


def recent(limit=30):
    return db.all("SELECT c.id, c.title, c.updated_at, (SELECT count(*) FROM chat_msgs m WHERE m.chat_id = c.id) AS n "
                  "FROM chats c ORDER BY c.updated_at DESC LIMIT %s", (limit,))
