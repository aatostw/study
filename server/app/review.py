"""知識複習：把一週裡讀的書、記的筆記、上的課、問過的問題整理成一篇。

每週日早上 7 點（電腦的時間）自動產生「週一到週六」；
平常也可以按「產生本週至今」。做好後先把朗讀的聲音生好，打開就能聽。"""
import datetime as dt
import re
import threading
import time

from . import ai, config, db, jobs, tts
from .db import Jsonb
from .textutil import tts_parts

AUTO_HOUR = 7


def monday_of(d):
    return d - dt.timedelta(days=d.weekday())


def request(week_start=None, auto=False):
    """建立（或重做）某一週的複習，排進工作佇列"""
    now = dt.datetime.now().astimezone()
    ws = week_start or monday_of(now.date())
    if auto:      # 週日早上：算到星期六結束
        end = dt.datetime.combine(ws + dt.timedelta(days=6), dt.time(0, 0)).astimezone()
    else:
        end = min(now, dt.datetime.combine(ws + dt.timedelta(days=7), dt.time(0, 0)).astimezone())
    r = db.one("INSERT INTO reviews (week_start, range_end, auto, status) VALUES (%s, %s, %s, 'queued') "
               "ON CONFLICT (week_start) DO UPDATE SET range_end = EXCLUDED.range_end, auto = EXCLUDED.auto, status = 'queued', updated_at = now() "
               "RETURNING *", (ws, end, auto))
    j = jobs.add("review", r["id"], "知識複習（%d/%d 那一週）" % (ws.month, ws.day))
    return r, j


def scheduler():
    """每分鐘看一次：星期日早上 7 點以後，這週還沒有自動複習就做一篇"""
    while True:
        try:
            now = dt.datetime.now()
            if now.weekday() == 6 and now.hour >= AUTO_HOUR:
                ws = monday_of(now.date())
                r = db.one("SELECT auto, status FROM reviews WHERE week_start = %s", (ws,))
                busy = db.one("SELECT 1 FROM jobs WHERE kind = 'review' AND status IN ('queued', 'running')")
                if not busy and (not r or (not r["auto"] and r["status"] != "queued")):
                    print("  [知識複習] 星期日早上，產生本週複習", flush=True)
                    request(ws, auto=True)
        except Exception as e:
            print("  [知識複習] 排程錯誤：%s" % e, flush=True)
        time.sleep(60)


# ---------- 收集這一週的資料 ----------

def _gather(start, end):
    items = []

    def add(kind, ref, label, text):
        text = re.sub(r"\s+", " ", text or "").strip()
        if text:
            items.append({"n": len(items) + 1, "kind": kind, "id": ref, "label": label, "text": text})

    for n in db.all("SELECT n.*, b.title AS book_title FROM notes n LEFT JOIN books b ON b.id = n.book_id "
                    "WHERE n.updated_at >= %s AND n.updated_at < %s AND NOT n.no_index ORDER BY n.updated_at", (start, end)):
        if n["book_id"]:
            where = " ".join(x for x in [n["chapter"], ("p." + n["page"]) if n["page"] else ""] if x)
            add("book", n["book_id"], "《%s》筆記%s" % (n["book_title"], (" " + where) if where else ""),
                ("摘句：" + n["quote"] + " ") * bool(n["quote"]) + ("想法：" + n["content"]) * bool(n["content"]))
        else:
            add("note", n["id"], "記事本：" + (n["title"] or "（無標題）"), n["content"][:1500])
    for b in db.all("SELECT id, title, author, analysis FROM books WHERE analysis IS NOT NULL "
                    "AND updated_at >= %s AND updated_at < %s", (start, end)):
        a = b["analysis"] or {}
        add("book", b["id"], "《%s》AI 分析" % b["title"], (a.get("summary") or "") + " 主題：" + "、".join(t.get("title", "") for t in a.get("themes") or []))
    for l in db.all("SELECT id, course, title, summary FROM lectures WHERE summary IS NOT NULL AND created_at >= %s AND created_at < %s "
                    "ORDER BY created_at", (start, end)):
        s = l["summary"] or {}
        secs = "；".join("%s：%s" % (x.get("title", ""), x.get("summary", "")) for x in s.get("sections") or [])
        add("lecture", l["id"], "%s%s（課程）" % ((l["course"] + "｜") if l["course"] else "", l["title"]), (s.get("overview") or "") + " " + secs)
    for b in db.all("SELECT id, title, evaluation FROM books WHERE evaluation IS NOT NULL AND updated_at >= %s AND updated_at < %s", (start, end)):
        v = (b["evaluation"] or {}).get("verdict") or {}
        add("book", b["id"], "《%s》選書評估" % b["title"], v.get("text", ""))
    qs = db.all("SELECT content FROM chat_msgs WHERE role = 'user' AND created_at >= %s AND created_at < %s ORDER BY id", (start, end))
    if qs:
        add("chat", None, "這週問過助理的問題", "；".join(q["content"][:120] for q in qs[:30]))
    # 太多就截短，避免超過模型能讀的長度
    total = 0
    for it in items:
        it["text"] = it["text"][:1800]
        total += len(it["text"])
    while total > 60000 and items:
        total -= len(items.pop()["text"])
    return items


PROMPT = """你是我的學習教練。下面是我這一週（%s～%s）讀的書、記的筆記、上的課、問過的問題，每一項前面有編號。
請寫成一篇週日的「知識複習」，只輸出 JSON：
{"headline": "一句話：這週學習的主軸",
 "highlights": [{"title": "重點標題", "text": "2～4 句，說清楚這個重點講了什麼、我學到什麼，句尾用 [編號] 標出處"}],
 "connections": [{"text": "不同書、筆記、課程之間互相呼應或矛盾的地方，2～3 句，標出處 [編號][編號]"}],
 "questions": [{"q": "一個開放式問題，從這週的筆記延伸出去，值得我再想或跟助理討論", "why": "一句：為什麼值得想"}]}
規則：重點 3～6 個；關聯 1～4 個（真的有才寫，不要硬湊）；問題 3～5 個。
只根據資料，不要編造；台灣繁體中文；專有名詞保留原文；不要用 Markdown。

資料：
%s"""


def speech_text(c, label):
    """朗讀用的文字（App 會用同一段文字要聲音，電腦先生好就能直接播）"""
    lines = ["%s的知識複習。" % label, c.get("headline", "")]
    if c.get("highlights"):
        lines.append("本週重點。")
        lines += ["%s。%s" % (h["title"], h["text"]) for h in c["highlights"]]
    if c.get("connections"):
        lines.append("跨內容的關聯。")
        lines += [x["text"] for x in c["connections"]]
    if c.get("questions"):
        lines.append("可以再想的問題。")
        lines += [q["q"] for q in c["questions"]]
    return re.sub(r"\[\d{1,2}\]", "", "\n".join(x for x in lines if x)).strip()


def run(job, prog):
    r = db.one("SELECT * FROM reviews WHERE id = %s", (job["ref_id"],))
    if not r:
        raise RuntimeError("這篇複習已經被刪除")
    start = dt.datetime.combine(r["week_start"], dt.time(0, 0)).astimezone()
    end = r["range_end"]
    label = "%d/%d～%d/%d" % (start.month, start.day, (end - dt.timedelta(seconds=1)).month, (end - dt.timedelta(seconds=1)).day)
    prog("收集這週的筆記、書、課程", 0.1, True)
    items = _gather(start, end)
    if not items:
        db.run("UPDATE reviews SET status = 'empty', content = %s, updated_at = now() WHERE id = %s",
               (Jsonb({"label": label, "sources": []}), r["id"]))
        return
    prog("AI 整理本週重點", 0.3, True)
    data = "\n\n".join("[%d] %s\n%s" % (it["n"], it["label"], it["text"]) for it in items)
    d, used = ai.generate_json("review", PROMPT % (label.split("～")[0], label.split("～")[1], data), max_tokens=6000)
    c = {"label": label,
         "headline": str(d.get("headline") or "").strip(),
         "highlights": [{"title": str(h.get("title", "")), "text": str(h.get("text", ""))} for h in d.get("highlights") or [] if isinstance(h, dict) and h.get("text")][:6],
         "connections": [{"text": str(x.get("text", ""))} for x in d.get("connections") or [] if isinstance(x, dict) and x.get("text")][:4],
         "questions": [{"q": str(q.get("q", "")), "why": str(q.get("why", ""))} for q in d.get("questions") or [] if isinstance(q, dict) and q.get("q")][:5],
         "sources": [{k: it[k] for k in ("n", "kind", "id", "label")} for it in items],
         "counts": {k: sum(1 for it in items if it["kind"] == k) for k in ("book", "note", "lecture", "chat")}}
    c["speech"] = speech_text(c, label)
    db.run("UPDATE reviews SET status = 'ready', content = %s, model = %s, updated_at = now() WHERE id = %s", (Jsonb(c), used, r["id"]))

    # 先把朗讀的聲音生好（GPT-SoVITS 沒開就跳過，打開時再生）
    if tts.status() == "ready" and not config.FAKE:
        prefs = db.get_setting("prefs", {}) or {}
        parts = tts_parts(c["speech"])
        for i, p in enumerate(parts):
            prog("先生好朗讀的聲音（%d/%d）" % (i + 1, len(parts)), 0.7 + 0.3 * i / max(1, len(parts)))
            try:
                tts.synth(p, prefs.get("tts_lang", "zh"), prefs.get("tts_speed", 1.0))
            except Exception as e:
                print("  [知識複習] 朗讀預先生成失敗：%s" % e, flush=True)
                break
