# -*- coding: utf-8 -*-
"""
背景工作，一次做一件（顯示卡不搶）：
  lecture      課程：轉檔 → 逐字稿 → 建索引 → AI 摘要
  resummarize  課程重新摘要（換模型、改術語後）
  bookfile     PDF / EPUB / TXT：拆頁 → 建索引
  analyze      書籍分析：主題 → 找其他書和課程的關聯
"""
import json
import os
import time
import traceback

from . import ai, config, db, engines, knowledge
from .db import Jsonb
from .textutil import chunk_text, epub_chapters, fmt_t, parse_t, pdf_pages, to_trad


def add(kind, ref_id, title=""):
    r = db.one("INSERT INTO jobs (kind, ref_id, title) VALUES (%s, %s, %s) RETURNING *", (kind, ref_id, title))
    return r


class Progress:
    def __init__(self, job_id):
        self.id, self.last = job_id, 0.0

    def __call__(self, step, frac, force=False):
        now = time.time()
        if force or now - self.last > 1.0:
            self.last = now
            db.run("UPDATE jobs SET step = %s, progress = %s, updated_at = now() WHERE id = %s",
                   (step, round(max(0.0, min(1.0, frac)), 3), self.id))


def worker():
    db.run("UPDATE jobs SET status = 'queued', step = '電腦重開後重新排隊' WHERE status = 'running'")
    while True:
        try:
            job = db.one("UPDATE jobs SET status = 'running', updated_at = now() WHERE id = ("
                         "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *")
        except Exception as e:
            print("  [工作佇列] 資料庫錯誤：%s" % e, flush=True)
            time.sleep(10)
            continue
        if not job:
            time.sleep(2)
            continue
        prog = Progress(job["id"])
        print("  開始：%s %s" % (job["kind"], job["title"]), flush=True)
        try:
            {"lecture": run_lecture, "resummarize": run_resummarize,
             "bookfile": run_bookfile, "analyze": run_analyze}[job["kind"]](job, prog)
            db.run("UPDATE jobs SET status = 'done', step = '完成', progress = 1, error = '', updated_at = now() WHERE id = %s", (job["id"],))
            print("  完成：%s %s" % (job["kind"], job["title"]), flush=True)
        except Exception as e:
            msg = str(e) if isinstance(e, (ai.AIError, RuntimeError, ValueError)) else "%s: %s" % (type(e).__name__, e)
            traceback.print_exc()
            db.run("UPDATE jobs SET status = 'error', error = %s, updated_at = now() WHERE id = %s", (msg[:800], job["id"]))
            _mark_ref_error(job)


def _mark_ref_error(job):
    if job["kind"] in ("lecture", "resummarize"):
        db.run("UPDATE lectures SET status = CASE WHEN EXISTS (SELECT 1 FROM segments WHERE lecture_id = %s) "
               "THEN 'ready' ELSE 'error' END WHERE id = %s", (job["ref_id"], job["ref_id"]))
    elif job["kind"] == "bookfile":
        db.run("UPDATE books SET status = 'error' WHERE id = %s", (job["ref_id"],))


# ======================= 課程 =======================

def run_lecture(job, prog):
    lec = db.one("SELECT * FROM lectures WHERE id = %s", (job["ref_id"],))
    if not lec:
        raise RuntimeError("這堂課已經被刪除")
    db.run("UPDATE lectures SET status = 'processing' WHERE id = %s", (lec["id"],))
    base = os.path.join(config.MEDIA_DIR, "lecture-%d" % lec["id"])
    wav, m4a = base + ".16k.wav", base + ".m4a"
    have_segments = db.one("SELECT count(*) AS n FROM segments WHERE lecture_id = %s", (lec["id"],))["n"]

    # 1. 轉檔
    if not have_segments:
        prog("轉檔中", 0.01, True)
        if not os.path.isfile(lec["media_path"]):
            raise RuntimeError("找不到原始檔案：%s" % lec["media_path"])
        engines.prepare_audio(lec["media_path"], wav, m4a)
        dur = engines.duration(m4a) or engines.duration(lec["media_path"])
        db.run("UPDATE lectures SET audio_path = %s, duration = %s WHERE id = %s", (m4a, dur, lec["id"]))
        lec["duration"] = dur

        # 2. 逐字稿
        prog("轉逐字稿（%s）" % fmt_t(dur), 0.05, True)
        segs = engines.transcribe(wav, lec["lang"], lec["terms"], dur,
                                  progress=lambda f: prog("轉逐字稿（%s / %s）" % (fmt_t(f * dur), fmt_t(dur)), 0.05 + 0.6 * f))
        if not segs:
            raise RuntimeError("聽不到說話的聲音，確認檔案有沒有聲音。")
        with db.connect() as c:
            c.execute("DELETE FROM segments WHERE lecture_id = %s", (lec["id"],))
            with c.cursor() as cur:
                cur.executemany("INSERT INTO segments (lecture_id, idx, t0, t1, text) VALUES (%s, %s, %s, %s, %s)",
                                [(lec["id"], i, t0, t1, to_trad(t)) for i, (t0, t1, t) in enumerate(segs)])
        try:
            os.remove(wav)
        except OSError:
            pass

    # 3. 建索引
    segments = db.all("SELECT idx, t0, t1, text FROM segments WHERE lecture_id = %s ORDER BY idx", (lec["id"],))
    has_chunks = db.one("SELECT count(*) AS n FROM chunks WHERE lecture_id = %s", (lec["id"],))["n"]
    if not has_chunks:
        prog("建立搜尋索引", 0.66, True)
        rows = [dict(kind="lecture", lecture_id=lec["id"], t0=w["t0"], t1=w["t1"], text=w["text"])
                for w in knowledge.lecture_windows(segments)]
        knowledge.insert_chunks(rows, progress=lambda f: prog("建立搜尋索引", 0.66 + 0.12 * f))

    # 4. 摘要（AI 沒設定好的話，逐字稿還是可以用；之後按「重新摘要」就好）
    summarize(lec, segments, prog, 0.8)
    db.run("UPDATE lectures SET status = 'ready' WHERE id = %s", (lec["id"],))


def run_resummarize(job, prog):
    lec = db.one("SELECT * FROM lectures WHERE id = %s", (job["ref_id"],))
    if not lec:
        raise RuntimeError("這堂課已經被刪除")
    segments = db.all("SELECT idx, t0, t1, text FROM segments WHERE lecture_id = %s ORDER BY idx", (lec["id"],))
    if not segments:
        return run_lecture(job, prog)
    summarize(lec, segments, prog, 0.05)
    db.run("UPDATE lectures SET status = 'ready' WHERE id = %s", (lec["id"],))


SUMMARY_RULES = """要求：
- 照教授「換主題」的地方切單元，不是固定時間切；一般 3～8 個單元，每單元 3～8 個重點。
- 時間一律用逐字稿裡出現過的 [分:秒]，指向那件事「開始被提到」的地方。
- 細節要具體：教授提到的人名、書名、年代、數字、例子、比喻，還有他強調「重要」「會考」「回去要讀」的地方都要留下。
- 逐字稿是語音辨識結果，可能有同音錯字，請依上下文理解並寫成正確的詞。
- 不要加入逐字稿沒有的內容。用台灣繁體中文；英文專有名詞保留原文。"""

SUMMARY_SHAPE = """{
  "overview": "3～5 句：這堂課在講什麼、核心論點是什麼",
  "sections": [{"title": "單元標題", "start": "分:秒", "end": "分:秒", "summary": "2～4 句",
                "points": [{"text": "重點（含細節）", "t": "分:秒"}]}],
  "details": [{"kind": "例子｜引用｜書目｜定義｜提醒｜作業｜考試", "text": "內容", "t": "分:秒"}],
  "terms": [{"term": "術語", "explain": "教授怎麼解釋", "t": "分:秒"}],
  "questions": ["3～5 題複習問題"]
}"""

PART_CHARS = 45000


def _lines(segments):
    return ["[%s] %s" % (fmt_t(s["t0"]), s["text"]) for s in segments]


def _header(lec):
    h = "課程：%s\n這堂課：%s\n" % (lec["course"] or "（未填）", lec["title"])
    if lec["terms"].strip():
        h += "課程術語（辨識錯字時參考）：%s\n" % lec["terms"].strip().replace("\n", "、")
    return h


def summarize(lec, segments, prog, start):
    lines = _lines(segments)
    parts, cur = [], []
    for ln in lines:
        if cur and sum(len(x) + 1 for x in cur) + len(ln) > PART_CHARS:
            parts.append(cur)
            cur = []
        cur.append(ln)
    if cur:
        parts.append(cur)

    if len(parts) == 1:
        prog("AI 摘要中", start, True)
        prompt = ("你在幫一位學生整理他錄下來的一堂課。下面是逐字稿，每行開頭是 [分:秒]。\n" + _header(lec) +
                  "\n逐字稿：\n" + "\n".join(parts[0]) + "\n\n請只輸出這個 JSON：\n" + SUMMARY_SHAPE + "\n\n" + SUMMARY_RULES)
        data, used = ai.generate_json("summary", prompt, max_tokens=16000)
    else:
        # 太長的課：先分段整理（partial），再合成總覽
        merged = {"sections": [], "details": [], "terms": []}
        for i, p in enumerate(parts):
            prog("AI 摘要中（第 %d / %d 段）" % (i + 1, len(parts)), start + (0.95 - start) * i / len(parts), True)
            prompt = ("你在幫一位學生整理一堂很長的課。這是逐字稿的第 %d / %d 部分（partial），每行開頭是 [分:秒]。\n" % (i + 1, len(parts)) +
                      _header(lec) + "\n逐字稿：\n" + "\n".join(p) +
                      '\n\n請只輸出 JSON：{"sections": [...], "details": [...], "terms": [...]}，格式同下：\n' + SUMMARY_SHAPE +
                      "\n\n" + SUMMARY_RULES)
            d, used = ai.generate_json("summary", prompt, max_tokens=12000)
            for k in merged:
                merged[k].extend(d.get(k) or [])
        prog("AI 整理總覽", 0.95, True)
        outline = "\n".join("- [%s] %s：%s" % (s.get("start", ""), s.get("title", ""), s.get("summary", "")) for s in merged["sections"])
        prompt = ("這是一堂課各單元的摘要：\n" + _header(lec) + "\n" + outline +
                  '\n\n請只輸出 JSON：{"overview": "3～5 句總覽", "questions": ["3～5 題複習問題"]}。台灣繁體中文。')
        d, used = ai.generate_json("summary", prompt, max_tokens=3000)
        data = dict(merged, overview=d.get("overview", ""), questions=d.get("questions") or [])

    summary = normalize_summary(data, lec.get("duration") or (segments[-1]["t1"] if segments else 0))
    db.run("UPDATE lectures SET summary = %s, summary_model = %s WHERE id = %s", (Jsonb(summary), used, lec["id"]))


def normalize_summary(d, duration):
    def t(v):
        s = parse_t(v)
        if s is None:
            return None
        return max(0.0, min(float(s), float(duration or s)))

    def txt(v):
        return to_trad(str(v or "").strip())

    out = {"overview": txt(d.get("overview")), "sections": [], "details": [], "terms": [],
           "questions": [txt(q) for q in (d.get("questions") or []) if str(q).strip()]}
    for s in d.get("sections") or []:
        if not isinstance(s, dict):
            continue
        out["sections"].append({"title": txt(s.get("title")), "start": t(s.get("start")), "end": t(s.get("end")),
                                "summary": txt(s.get("summary")),
                                "points": [{"text": txt(p.get("text")), "t": t(p.get("t"))}
                                           for p in (s.get("points") or []) if isinstance(p, dict) and p.get("text")]})
    out["sections"].sort(key=lambda s: s["start"] if s["start"] is not None else 1e9)
    for x in d.get("details") or []:
        if isinstance(x, dict) and x.get("text"):
            out["details"].append({"kind": txt(x.get("kind")) or "細節", "text": txt(x.get("text")), "t": t(x.get("t"))})
    for x in d.get("terms") or []:
        if isinstance(x, dict) and x.get("term"):
            out["terms"].append({"term": txt(x.get("term")), "explain": txt(x.get("explain")), "t": t(x.get("t"))})
    return out


# ======================= 書 =======================

def run_bookfile(job, prog):
    b = db.one("SELECT * FROM books WHERE id = %s", (job["ref_id"],))
    if not b:
        raise RuntimeError("這本書已經被刪除")
    db.run("UPDATE books SET status = 'indexing' WHERE id = %s", (b["id"],))
    prog("讀取檔案", 0.02, True)
    ext = os.path.splitext(b["file_path"])[1].lower()
    rows, pages = [], 0
    if ext == ".pdf":
        pp = pdf_pages(b["file_path"])
        pages = len(pp)
        for page, text in pp:
            for piece in chunk_text(text, 650):
                rows.append(dict(kind="book", book_id=b["id"], page=page, text=piece))
    elif ext == ".epub":
        chs = epub_chapters(b["file_path"])
        pages = len(chs)
        for title, text in chs:
            for piece in chunk_text(text, 650):
                rows.append(dict(kind="book", book_id=b["id"], chapter=title, text=piece))
    else:
        with open(b["file_path"], encoding="utf-8", errors="replace") as f:
            for piece in chunk_text(f.read(), 650):
                rows.append(dict(kind="book", book_id=b["id"], text=piece))
    if not rows:
        raise RuntimeError("檔案裡讀不到文字（可能是掃描的圖片 PDF，需要先做文字辨識）。")
    db.run("DELETE FROM chunks WHERE book_id = %s AND kind = 'book'", (b["id"],))
    prog("建立搜尋索引（%d 段）" % len(rows), 0.1, True)
    knowledge.insert_chunks(rows, progress=lambda f: prog("建立搜尋索引（%d 段）" % len(rows), 0.1 + 0.9 * f))
    db.run("UPDATE books SET status = 'ready', pages = %s, updated_at = now() WHERE id = %s", (pages, b["id"]))


def run_analyze(job, prog):
    b = db.one("SELECT * FROM books WHERE id = %s", (job["ref_id"],))
    if not b:
        raise RuntimeError("這本書已經被刪除")
    notes = db.all("SELECT * FROM notes WHERE book_id = %s ORDER BY id", (b["id"],))
    prog("整理主題", 0.1, True)
    if notes:
        items, total = [], 0
        for n in notes:
            line = "(#%d)%s%s %s" % (n["id"], (" " + n["chapter"]) if n["chapter"] else "", (" p." + n["page"]) if n["page"] else "",
                                     knowledge.note_text(n).replace("\n", " ／ "))
            total += len(line)
            if total > 60000:
                break
            items.append(line)
        material = "我的讀書筆記（# 後面是筆記編號）：\n" + "\n".join(items)
    else:
        rows = db.all("SELECT page, chapter, text FROM chunks WHERE book_id = %s AND kind = 'book' ORDER BY id", (b["id"],))
        if not rows:
            raise RuntimeError("這本書還沒有筆記，也沒有上傳原文，沒有東西可以分析。")
        step = max(1, len(rows) // 40)
        material = "書的原文節錄：\n" + "\n".join("[%s] %s" % (r["page"] or r["chapter"], r["text"]) for r in rows[::step][:40])
    prompt = ("《%s》%s\n\n%s\n\n" % (b["title"], ("　" + b["author"]) if b["author"] else "", material) +
              "請整理這本書（以我的筆記為主）的 themes，只輸出 JSON：\n"
              '{"summary": "3～5 句：我從這本書抓到的核心", '
              '"themes": [{"title": "主題", "explain": "2～3 句，引用我的筆記內容", "note_ids": [筆記編號]}], '
              '"questions": ["值得再想的 2～4 個問題"]}\n'
              "主題 3～6 個。台灣繁體中文。不要加入資料裡沒有的內容。")
    a, used = ai.generate_json("analyze", prompt, max_tokens=6000)
    themes = [t for t in (a.get("themes") or []) if isinstance(t, dict) and t.get("title")][:6]

    # 用每個主題去搜尋「其他書和課程」
    prog("尋找跨書、跨課程的關聯", 0.5, True)
    sources, seen = [], set()
    for t in themes:
        got = 0
        for s in knowledge.search(t["title"] + "：" + str(t.get("explain", "")), "all", 12):
            if s["book_id"] == b["id"]:
                continue
            key = (s["kind"], s.get("note_id"), s.get("lecture_id"), s["text"][:40])
            if key in seen:
                continue
            seen.add(key)
            sources.append(s)
            got += 1
            if got >= 3:
                break
    connections = []
    if sources:
        prog("寫跨書連結", 0.75, True)
        for i, s in enumerate(sources, 1):
            s["n"] = i
        blocks = "\n\n".join("[%d] %s\n%s" % (s["n"], s["label"], s["text"]) for s in sources)
        prompt = ("我正在整理《%s》。它的主題：\n%s\n\n下面是我其他書的筆記、原文和課程片段：\n\n%s\n\n"
                  % (b["title"], "\n".join("- %s：%s" % (t["title"], t.get("explain", "")) for t in themes), blocks) +
                  '請找出這些主題和其他資料之間真正有意義的 connections（呼應、補充、對立），只輸出 JSON：'
                  '{"connections": [{"theme": "主題", "text": "2～3 句，每個說法後面用 [編號] 標出處"}]}。'
                  "沒有關聯就不要硬湊，可以回空陣列。台灣繁體中文。")
        c, used2 = ai.generate_json("analyze", prompt, max_tokens=4000)
        connections = [x for x in (c.get("connections") or []) if isinstance(x, dict) and x.get("text")]
    analysis = {"summary": to_trad(a.get("summary", "")), "themes": themes,
                "questions": a.get("questions") or [], "connections": connections, "sources": sources,
                "model": used, "at": time.strftime("%Y-%m-%d %H:%M")}
    db.run("UPDATE books SET analysis = %s, updated_at = now() WHERE id = %s", (Jsonb(json.loads(json.dumps(analysis, default=str))), b["id"]))
