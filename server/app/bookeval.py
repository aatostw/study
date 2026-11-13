# -*- coding: utf-8 -*-
"""
選書評估：給一本書的書名／作者，電腦自己上網找評價和作者資料，再請 AI 寫成評估卡。

  1. AI 補齊名稱：繁簡體書名、原文書名、作者其他寫法
  2. 自架搜尋（SearXNG）：書評、豆瓣、知乎、微信公眾號、批評、作者背景、原文評論
  3. 抓網頁、只留跟這本書有關的段落（遵守 robots.txt，被擋的就只用搜尋摘要）
  4. 從你的知識庫找相關筆記（判斷延伸／重複／挑戰）
  5. AI 寫評估：可信度燈號（防唬爛）＋讀者心得＋適不適合你＋結論；每個說法都標出處
  6. 證據不夠時，照 AI 建議的關鍵字再查一輪
"""
import re
import json
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import httpx

from . import ai, db, knowledge, websearch
from .db import Jsonb
from .textutil import to_trad

# 比較有參考價值的網站排前面
PREFER = [
    ("book.douban.com", 10), ("douban.com", 8), ("zhihu.com", 8), ("mp.weixin.qq.com", 7), ("weread.qq.com", 6),
    ("books.com.tw", 7), ("readmoo.com", 7), ("eslite.com", 6), ("kobo.com", 5), ("taaze.tw", 5),
    ("goodreads.com", 7), ("wikipedia.org", 6), ("baike.baidu.com", 5), ("scholar.google", 7), (".edu", 7),
    ("openbookproject", 4), ("nytimes.com", 6), ("theguardian.com", 6), ("kirkusreviews.com", 7), ("publishersweekly.com", 7),
    ("thenewslens.com", 5), ("vocus.cc", 5), ("matters.town", 5), ("medium.com", 4), ("pixnet.net", 4), ("sohu.com", 3),
]
# 盜版下載站一律不碰
BLOCK = re.compile(r"(download|下載|下载|\bpdf\b|epub|mobi|azw3|txt下|網盤|网盘|pan\.baidu|zlib|libgen|shopee|taobao|jd\.com|pinduoduo|youtube\.com|facebook\.com|instagram\.com)", re.I)


def _domain(u):
    return urlparse(u).netloc.lower().removeprefix("www.")


def _pref(u):
    d = _domain(u)
    for k, v in PREFER:
        if k in d or k in u:
            return v
    return 2


def isbn_ok(isbn):
    """檢查 ISBN 的檢查碼，擋掉 AI 看錯一兩位數字的情況"""
    s = re.sub(r"[^0-9Xx]", "", isbn or "").upper()
    if len(s) == 13 and s.isdigit():
        return sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(s)) % 10 == 0
    if len(s) == 10 and s[:9].isdigit() and (s[9].isdigit() or s[9] == "X"):
        return sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(s)) % 11 == 0
    return False


ISBN_PROMPT = """下面是用 ISBN %s 在網路上搜尋到的結果（書店、圖書館、豆瓣等）。
找出這個 ISBN 對應的書，只輸出 JSON：
{"title": "書名（照台灣書店的寫法；只有簡體來源就照寫）", "author": "作者（譯者不算）", "publisher": "出版社", "year": "出版年（4 位數）"}
只有在搜尋結果明確是這個 ISBN 的書時才填，看不出來就全部留空字串，不要猜。

%s"""


def _isbn_by_search(isbn):
    """台灣、中國的書 Google Books 常常查不到，改用自架搜尋直接搜 ISBN，再請 AI 從結果認出書名"""
    try:
        hits = websearch.search(isbn, n=10) + websearch.search("ISBN " + isbn + " 書", n=6)
    except RuntimeError:
        return None
    hits = [h for h in hits if not BLOCK.search(h["url"])][:12]
    if not hits:
        return None
    lines = "\n".join("- %s｜%s｜%s" % (h["title"], h["snippet"][:200], urlparse(h["url"]).netloc) for h in hits)
    try:
        d, _ = ai.generate_json("evaluate", ISBN_PROMPT % (isbn, lines), max_tokens=400)
    except ai.AIError:
        return None
    title = str(d.get("title") or "").strip()
    if not title:
        return None
    return {"isbn": isbn, "title": title, "author": str(d.get("author") or "").strip(),
            "publisher": str(d.get("publisher") or "").strip(), "year": str(d.get("year") or "").strip()[:4]}


def lookup_isbn(isbn):
    """用 ISBN 查書名、作者、出版社：Google Books → Open Library → 自架搜尋＋AI"""
    isbn = re.sub(r"[^0-9Xx]", "", isbn or "").upper()
    if len(isbn) not in (10, 13):
        return None
    try:
        r = httpx.get("https://www.googleapis.com/books/v1/volumes", params={"q": "isbn:" + isbn}, timeout=12)
        items = (r.json().get("items") or []) if r.status_code == 200 else []
        if items:
            v = items[0].get("volumeInfo", {})
            if v.get("title"):
                return {"isbn": isbn, "title": v.get("title", "") + ((("：" + v["subtitle"]) if v.get("subtitle") else "")),
                        "author": "、".join(v.get("authors") or []), "publisher": v.get("publisher", ""),
                        "year": (v.get("publishedDate") or "")[:4]}
        r = httpx.get("https://openlibrary.org/api/books", params={"bibkeys": "ISBN:" + isbn, "format": "json", "jscmd": "data"}, timeout=12)
        d = (r.json() or {}).get("ISBN:" + isbn) if r.status_code == 200 else None
        if d and d.get("title"):
            return {"isbn": isbn, "title": d.get("title", ""), "author": "、".join(a.get("name", "") for a in d.get("authors") or []),
                    "publisher": "、".join(p.get("name", "") for p in d.get("publishers") or []), "year": str(d.get("publish_date", ""))[-4:]}
    except (httpx.HTTPError, ValueError):
        pass
    return _isbn_by_search(isbn) or {"isbn": isbn, "title": "", "author": "", "publisher": "", "year": ""}


NAMES_PROMPT = """我要在網路上找這本書的評價和作者資料。請補齊各種寫法，只輸出 JSON：
{"title_tc": "繁體中文書名", "title_sc": "簡體中文書名", "original_title": "原文書名（中文原創書就空字串）",
 "author_tc": "作者（繁體）", "author_sc": "作者（簡體）", "original_author": "作者原文名（中文作者就空字串）",
 "kind": "這本書的類型，例如：心理勵志、哲學、歷史、科普、商管、文學小說、宗教靈修"}
不確定的欄位就留空字串，不要猜。"""


def _names(b):
    info = "書名：%s\n作者：%s\nISBN：%s" % (b["title"], b["author"] or "（未填）", b["isbn"] or "（未填）")
    try:
        d, _ = ai.generate_json("evaluate", info + "\n\n" + NAMES_PROMPT, max_tokens=800)
    except ai.AIError:
        d = {}
    t = b["title"]
    return {"title_tc": d.get("title_tc") or t, "title_sc": d.get("title_sc") or t,
            "original_title": d.get("original_title") or "", "author_tc": d.get("author_tc") or b["author"],
            "author_sc": d.get("author_sc") or b["author"], "original_author": d.get("original_author") or "",
            "kind": d.get("kind") or ""}


def _queries(n):
    tc, sc, au, aus = n["title_tc"], n["title_sc"], n["author_tc"], n["author_sc"]
    q = [("review", tc + " 書評 心得", None), ("review", sc + " 豆瓣 评价", None), ("review", sc + " 读后感 值得读吗", None),
         ("review", sc + " 书评", "sogou wechat"), ("critique", sc + " 批评 争议 问题", None), ("critique", tc + " 批評 缺點", None)]
    if au:
        q += [("author", au + " 作者 學歷 經歷 背景", None)]
        if aus and aus != au:
            q += [("author", aus + " 作者 简介 学历", None)]
    if n["original_title"]:
        q += [("review", '"%s" %s review' % (n["original_title"], n["original_author"]), None)]
    if n["original_author"]:
        q += [("author", n["original_author"] + " credentials background criticism", None)]
    return q


def _gather(queries, pool, prog, p0, p1, stats):
    for i, (cat, q, engines) in enumerate(queries):
        prog("搜尋：%s" % q[:24], p0 + (p1 - p0) * i / max(1, len(queries)), True)
        try:
            res = websearch.search(q, engines=engines, lang="zh-CN" if re.search(r"[们书评读问题简]", q) else "zh-TW")
        except RuntimeError:
            raise
        except Exception:
            res = []
        stats["searched"] += 1
        for r in res:
            if BLOCK.search(r["url"] + " " + r["title"]):
                continue
            if r["url"] not in pool:
                pool[r["url"]] = dict(r, category=cat, score=_pref(r["url"]))
            else:
                pool[r["url"]]["score"] += 1      # 好幾個關鍵字都找到它，比較相關
        time.sleep(0.5)


def _fetch_some(pool, keys, prog, p0, p1, stats, limit=12):
    """每類至少挑幾篇，同一個網站最多兩篇"""
    picked, per = [], {}
    need = {"review": 6, "author": 3, "critique": 3}
    ranked = sorted((x for x in pool.values() if not x.get("tried")), key=lambda x: -x["score"])
    for cat in ("author", "critique", "review"):          # 作者和批評先保留名額，不然都被書評佔滿
        for x in ranked:
            if len(picked) >= limit or need[cat] <= 0:
                break
            d = _domain(x["url"])
            if x["category"] != cat or x in picked or per.get(d, 0) >= 2:
                continue
            picked.append(x)
            per[d] = per.get(d, 0) + 1
            need[cat] -= 1
    for i, x in enumerate(picked):
        prog("讀網頁：%s" % _domain(x["url"]), p0 + (p1 - p0) * i / max(1, len(picked)), True)
        r = websearch.fetch(x["url"])
        x["tried"] = True
        x["fetched"] = r["ok"]
        x["why"] = r["why"]
        if r["ok"]:
            x["excerpt"] = websearch.excerpt(r["text"], keys)
            stats["fetched"] += 1
        else:
            stats["blocked"] += 1


EVAL_RULES = """你是嚴謹的選書顧問，幫一位台灣讀者判斷一本書值不值得讀、內容可不可信。
下面是電腦從網路上找到的資料（[數字]）和讀者自己補充的資料（[U]），以及讀者知識庫裡的相關筆記（[K數字]）。

評估原則：
1. 只能根據下面的資料下判斷。每個說法後面標出處，例如 [3]、[3][7]、[U]、[K2]。沒有資料支持的就不要寫，或寫進 gaps。
2. 出版社文案、書店介紹、推薦序、作者自己的宣傳，不算獨立評價，要分開看。
3. 可信度燈號（防唬爛）看：作者是否是這個領域的專業人士、主張有沒有研究或專業評論支持、有沒有偽科學用語或被專家公開反駁。
   green＝可信；yellow＝作者背景和主題無關、或主張找不到出處，但沒有明確錯誤；red＝明確的偽科學、被專家反駁、造假紀錄；unknown＝資料不足。
4. 讀者心得要寫「讀完的人覺得收穫在哪、失望在哪」，正反都要，具體不要空泛。評分只有在資料裡看得到才寫，連同評分人數。
5. 適不適合：對照 [K] 筆記，判斷這本書對讀者是延伸、重複、挑戰還是全新領域。
6. 台灣繁體中文。書名作者照實際資料寫。
"""

# 一次寫完整份很長，容易被切斷 → 拆成三次：A 書和可信度、B 讀者評價（同時跑），C 綜合判斷
PART_A = """只輸出 JSON（這次只寫書的基本資料和可信度）：
{
 "book": {"title": "", "author": "", "original": "原文書名（沒有就空字串）", "publisher": "", "year": "", "summary": "2～3 句：這本書在講什麼"},
 "credibility": {"light": "green|yellow|red|unknown", "headline": "一句話結論",
                 "author": "作者背景，和主題相不相關 [n]",
                 "reasons": [{"text": "判斷理由", "src": "[n]"}]}
}"""

PART_B = """只輸出 JSON（這次只寫讀者評價，正反各最多 5 點）：
{
 "reception": {"headline": "一句話：讀者整體怎麼看",
               "ratings": [{"site": "豆瓣", "score": "8.1", "count": "2.3萬人", "src": "[n]"}],
               "pros": [{"text": "讀者說的收穫", "src": "[n]"}],
               "cons": [{"text": "讀者說的缺點", "src": "[n]"}]}
}"""

PART_C = """上面是已經整理好的「可信度」和「讀者評價」。根據它們和讀者的筆記 [K]，做最後判斷。
只輸出 JSON：
{
 "fit": {"relation": "延伸|重複|挑戰|全新領域", "text": "對照你的筆記說明 [K1]"},
 "verdict": {"level": "read|skim|skip", "text": "值得讀／挑章節讀／可以跳過 的理由，2～3 句"},
 "alternatives": [{"title": "", "author": "", "why": "為什麼可以考慮（資料裡有提到才寫）"}],
 "gaps": ["還缺什麼資料"],
 "followup_queries": ["如果資料不夠，建議再搜的關鍵字（最多 3 個）"]
}"""



def _evidence_text(sources, user_evidence, notes):
    blocks = []
    for s in sources:
        body = s.get("excerpt") or ("（只有搜尋摘要，網頁讀不到：%s）\n%s" % (s.get("why") or "", s.get("snippet") or ""))
        blocks.append("[%d] %s｜%s｜%s\n%s" % (s["n"], s["title"], _domain(s["url"]),
                                               {"review": "評價", "author": "作者", "critique": "批評"}.get(s["category"], ""), body))
    if user_evidence.strip():
        blocks.append("[U] 讀者自己補充的資料（例如微信讀書的點評截圖）：\n" + user_evidence.strip()[:6000])
    for i, k in enumerate(notes, 1):
        blocks.append("[K%d] %s\n%s" % (i, k["label"], k["text"][:500]))
    return "\n\n".join(blocks)


def run_evaluate(job, prog):
    b = db.one("SELECT * FROM books WHERE id = %s", (job["ref_id"],))
    if not b:
        raise RuntimeError("這本書已經被刪除")
    if websearch.status() != "ready" and not websearch.config.FAKE:
        raise RuntimeError("自架搜尋沒有開：請在 D:\\study-server 雙擊「安裝資料庫.bat」（會一起開搜尋），確認 Docker Desktop 開著。")
    prog("確認書名和作者", 0.03, True)
    names = _names(b)
    keys = [names["title_tc"], names["title_sc"], names["author_tc"], names["author_sc"], names["original_title"], names["original_author"]]
    keys = [k for k in dict.fromkeys(keys) if k and len(k) >= 2]
    pool, stats = {}, {"searched": 0, "fetched": 0, "blocked": 0}
    _gather(_queries(names), pool, prog, 0.05, 0.35, stats)
    _fetch_some(pool, keys, prog, 0.35, 0.65, stats)

    # 你的知識庫裡相關的筆記（排除這本書自己）
    probe = " ".join([names["title_tc"], names["kind"], b["wish_note"]] + [x["snippet"] for x in list(pool.values())[:6]])[:1500]
    try:
        notes = [k for k in knowledge.search(probe, "all", 10) if k["book_id"] != b["id"]][:6]
    except Exception:
        notes = []

    def evaluate(round_no):
        tried = [x for x in pool.values() if x.get("tried")]
        extra = sorted((x for x in pool.values() if not x.get("tried")), key=lambda x: -x["score"])[:6]   # 沒讀的也給摘要
        sources = tried + extra
        for i, s in enumerate(sources, 1):
            s["n"] = i
        info = "要評估的書：%s　作者：%s　ISBN：%s　類型：%s\n讀者想讀的原因：%s\n\n" % (
            names["title_tc"], names["author_tc"] or "（未填）", b["isbn"] or "（未填）", names["kind"] or "（不確定）", b["wish_note"] or "（沒寫）")
        r2 = "（第二輪）" if round_no == 2 else ""
        base = EVAL_RULES + "\n\n" + info + "資料：\n\n" + _evidence_text(sources, b["user_evidence"], notes) + "\n\n"
        prog("AI 評估：可信度、讀者評價" + r2, 0.7 if round_no == 1 else 0.9, True)
        with ThreadPoolExecutor(2) as ex:
            fa = ex.submit(ai.generate_json, "evaluate", base + PART_A, max_tokens=4000)
            fb = ex.submit(ai.generate_json, "evaluate", base + PART_B, max_tokens=4000)
            d, gaps = {}, []
            for f, name in ((fa, "可信度"), (fb, "讀者評價")):
                try:
                    part, used = f.result()
                    d.update(part if isinstance(part, dict) else {})
                except ValueError:                     # 補救後還是不完整：其他部分照樣用
                    gaps.append("「%s」這部分 AI 沒寫完整，可以按重新評估再試。" % name)
        if not d:
            raise RuntimeError("AI 兩部分都沒寫完整，請再試一次或換一個模型。")
        prog("AI 評估：綜合判斷" + r2, 0.78 if round_no == 1 else 0.95, True)
        summary = json.dumps({k: d.get(k) for k in ("book", "credibility", "reception") if d.get(k)}, ensure_ascii=False)
        knotes = "\n\n".join("[K%d] %s\n%s" % (i, k["label"], k["text"][:500]) for i, k in enumerate(notes, 1)) or "（讀者沒有相關筆記）"
        try:
            part, used = ai.generate_json("evaluate", EVAL_RULES + "\n\n" + info + "已整理的評估：\n" + summary + "\n\n讀者的筆記：\n" + knotes + "\n\n" + PART_C, max_tokens=3000)
            d.update(part if isinstance(part, dict) else {})
        except ValueError:
            gaps.append("「綜合判斷」這部分 AI 沒寫完整，可以按重新評估再試。")
        d["gaps"] = list(d.get("gaps") or []) + gaps
        return d, used, sources

    d, used, sources = evaluate(1)
    follow = [q for q in (d.get("followup_queries") or []) if isinstance(q, str) and q.strip()][:3]
    if follow and (stats["fetched"] < 6 or d.get("gaps")):
        _gather([("review", q.strip(), None) for q in follow], pool, prog, 0.75, 0.8, stats)
        _fetch_some(pool, keys, prog, 0.8, 0.88, stats, limit=6)
        d, used, sources = evaluate(2)

    ev = normalize(d)
    ev["sources"] = [{"n": s["n"], "url": s["url"], "title": s["title"] or _domain(s["url"]), "domain": _domain(s["url"]),
                      "category": s["category"], "snippet": s.get("snippet", "")[:300], "fetched": bool(s.get("fetched")),
                      "why": s.get("why", "")} for s in sources]
    ev["notes"] = [{"k": i, "label": k["label"], "text": k["text"][:300], "book_id": k.get("book_id"), "lecture_id": k.get("lecture_id"),
                    "t0": k.get("t0"), "kind": k["kind"]} for i, k in enumerate(notes, 1)]
    ev["names"] = names
    ev["stats"] = stats
    ev["model"] = used
    ev["at"] = time.strftime("%Y-%m-%d %H:%M")
    bk = ev.get("book") or {}
    db.run("UPDATE books SET evaluation = %s, author = CASE WHEN author = '' THEN %s ELSE author END, updated_at = now() WHERE id = %s",
           (Jsonb(ev), (bk.get("author") or "")[:200], b["id"]))


def normalize(d):
    t = lambda v: to_trad(str(v or "").strip())

    def items(xs):
        return [{"text": t(x.get("text")), "src": str(x.get("src") or "")} for x in (xs or []) if isinstance(x, dict) and x.get("text")]
    c, r = d.get("credibility") or {}, d.get("reception") or {}
    light = c.get("light") if c.get("light") in ("green", "yellow", "red", "unknown") else "unknown"
    level = (d.get("verdict") or {}).get("level")
    return {
        "book": {k: t((d.get("book") or {}).get(k)) for k in ("title", "author", "original", "publisher", "year", "summary")},
        "credibility": {"light": light, "headline": t(c.get("headline")), "author": t(c.get("author")), "reasons": items(c.get("reasons"))},
        "reception": {"headline": t(r.get("headline")),
                      "ratings": [{"site": t(x.get("site")), "score": t(x.get("score")), "count": t(x.get("count")), "src": str(x.get("src") or "")}
                                  for x in (r.get("ratings") or []) if isinstance(x, dict) and x.get("score")],
                      "pros": items(r.get("pros")), "cons": items(r.get("cons"))},
        "fit": {"relation": t((d.get("fit") or {}).get("relation")), "text": t((d.get("fit") or {}).get("text"))},
        "verdict": {"level": level if level in ("read", "skim", "skip") else "skim", "text": t((d.get("verdict") or {}).get("text"))},
        "alternatives": [{"title": t(x.get("title")), "author": t(x.get("author")), "why": t(x.get("why"))}
                         for x in (d.get("alternatives") or []) if isinstance(x, dict) and x.get("title")][:5],
        "gaps": [t(x) for x in (d.get("gaps") or []) if str(x).strip()][:6],
    }
