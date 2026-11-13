# -*- coding: utf-8 -*-
"""測試模式（STUDY_FAKE=1）：不用 GPU、不用金鑰，產生假的結果，用來檢查整個流程。"""
import hashlib
import json
import math
import re

from . import config


def embed(texts):
    out = []
    for t in texts:
        v = [0.0] * config.EMBED_DIM
        s = re.sub(r"\s+", "", t.lower())
        for i in range(len(s) - 1):
            h = int(hashlib.md5(s[i:i + 2].encode()).hexdigest()[:8], 16)
            v[h % config.EMBED_DIM] += 1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append([x / n for x in v])
    return out


def transcribe(duration):
    lines = ["今天我們要談的是道德經第一章，道可道非常道。",
             "老子認為真正的道是無法用語言完全說明的。",
             "這裡可以對照 Wittgenstein 說的 whereof one cannot speak。",
             "下週請大家讀莊子逍遙遊，並寫一頁心得。",
             "接下來我們看第二個主題：無為。",
             "無為不是什麼都不做，而是不刻意、不強求。"]
    n = max(6, int(duration // 20))
    step = max(duration, 60) / n
    return [(i * step, (i + 1) * step - 0.5, lines[i % len(lines)]) for i in range(n)]


def search(query, engines=None):
    q = query.split(" ")[0]
    if engines:
        return [{"url": "https://mp.weixin.qq.com/s/fake-%d" % (abs(hash(query)) % 999), "title": q + " 讀後感（公眾號）", "snippet": "這本書讓我重新思考人際關係。", "engine": "sogou wechat"}]
    base = abs(hash(query)) % 1000
    return [{"url": "https://book.douban.com/subject/%d/" % base, "title": q + " (豆瓣)", "snippet": "豆瓣評分 8.1，2.3萬人評價。", "engine": "google"},
            {"url": "https://www.zhihu.com/question/%d" % base, "title": q + " 值得讀嗎？- 知乎", "snippet": "觀點有啟發，但有些地方過度簡化。", "engine": "bing"},
            {"url": "https://example-pdf-download.com/%d.pdf" % base, "title": q + " PDF 下載", "snippet": "盜版", "engine": "baidu"},
            {"url": "https://www.books.com.tw/products/%d" % base, "title": q + " - 博客來", "snippet": "作者是心理學家。", "engine": "google"}]


def fetch(url):
    if "zhihu" in url:
        return {"ok": False, "text": "", "why": "要登入或驗證才看得到"}
    return {"ok": True, "text": "這本書的作者是一位執業心理師，書中以對話形式介紹阿德勒心理學。讀者普遍認為通俗易懂，但也有人批評過度簡化學術理論。", "why": ""}


def generate(task, prompt, json_mode):
    if task == "summary" and "partial" in prompt and json_mode:
        return json.dumps({"sections": [{"title": "片段主題", "start": "00:00", "end": "01:00", "summary": "片段摘要", "points": [{"text": "片段重點", "t": "00:20"}]}],
                           "details": [], "terms": []}, ensure_ascii=False)
    if task in ("summary", "resummarize") and json_mode:
        return json.dumps({
            "overview": "本堂課介紹道德經第一章「道可道，非常道」，並討論無為的意義。",
            "sections": [
                {"title": "道可道，非常道", "start": "00:00", "end": "01:20", "summary": "說明道無法被語言完全描述。",
                 "points": [{"text": "真正的道超越語言", "t": "00:20"}, {"text": "對照維根斯坦的語言界限", "t": "00:40"}]},
                {"title": "無為", "start": "01:20", "end": "02:00", "summary": "無為是不刻意、不強求。",
                 "points": [{"text": "無為不等於什麼都不做", "t": "01:40"}]}],
            "details": [{"kind": "作業", "text": "讀莊子逍遙遊並寫一頁心得", "t": "01:00"},
                        {"kind": "引用", "text": "Wittgenstein：whereof one cannot speak", "t": "00:40"}],
            "terms": [{"term": "無為", "explain": "順其自然、不強求的行事態度", "t": "01:40"}],
            "questions": ["老子為什麼說道不可言說？", "無為和消極有什麼不同？"]}, ensure_ascii=False)
    if task == "analyze" and json_mode and "themes" in prompt and "connections" not in prompt:
        return json.dumps({"summary": "這本書的筆記集中在語言與實在的關係。",
                           "themes": [{"title": "語言的界限", "explain": "語言無法完全描述經驗", "note_ids": []}],
                           "questions": ["語言和經驗的落差如何影響理解？"]}, ensure_ascii=False)
    if task == "analyze" and json_mode:
        return json.dumps({"connections": [{"theme": "語言的界限", "text": "和課程裡談的道可道非常道相互呼應 [1]。"}]}, ensure_ascii=False)
    if task == "evaluate" and "title_tc" in prompt:
        return json.dumps({"title_tc": "被討厭的勇氣", "title_sc": "被讨厌的勇气", "original_title": "嫌われる勇気",
                           "author_tc": "岸見一郎、古賀史健", "author_sc": "岸见一郎、古贺史健", "original_author": "岸見一郎", "kind": "心理勵志"}, ensure_ascii=False)
    if task == "evaluate":
        return json.dumps({"book": {"title": "被討厭的勇氣", "author": "岸見一郎、古賀史健", "original": "嫌われる勇気", "publisher": "究竟", "year": "2014",
                                    "summary": "以哲人與青年對話的形式介紹阿德勒心理學。"},
                           "credibility": {"light": "yellow", "headline": "作者是哲學學者，但把阿德勒理論簡化得很多", "author": "岸見一郎研究阿德勒心理學多年 [1]",
                                           "reasons": [{"text": "作者有相關研究背景", "src": "[1]"}, {"text": "有讀者批評過度簡化理論", "src": "[2]"}]},
                           "reception": {"headline": "多數讀者覺得有啟發，少數覺得說教", "ratings": [{"site": "豆瓣", "score": "8.1", "count": "2.3萬人", "src": "[1]"}],
                                         "pros": [{"text": "通俗易懂，對人際關係有新角度", "src": "[1]"}], "cons": [{"text": "對話形式有時說教", "src": "[2]"}]},
                           "fit": {"relation": "延伸", "text": "和你《允許一切發生》的筆記談的接納相呼應 [K1]"},
                           "verdict": {"level": "skim", "text": "核心觀念值得了解，對話部分可以挑章節讀。"},
                           "alternatives": [{"title": "阿德勒心理學講義", "author": "阿德勒", "why": "原典"}],
                           "gaps": ["缺少專業心理學者的書評"], "followup_queries": []}, ensure_ascii=False)
    if task == "review":
        return json.dumps({"headline": "這週在想「語言能不能說清楚道」", "highlights": [{"title": "道不可言說", "text": "老子認為真正的道超越語言 [1]。"},
                           {"title": "無為", "text": "無為是不刻意、不強求，不是什麼都不做 [2]。"}],
                           "connections": [{"text": "課程談的語言界限，和你在記事本寫的上善若水互相呼應 [1][2]。"}],
                           "questions": [{"q": "如果道說不清楚，我們要怎麼學它？", "why": "連到這週的兩個重點"},
                                         {"q": "無為在工作上可以怎麼實踐？", "why": "把觀念落到生活"}]}, ensure_ascii=False)
    if task == "ocr" and "ISBN" in prompt:
        return json.dumps({"isbn": "9789861371955", "title": "被討厭的勇氣", "author": "岸見一郎"}, ensure_ascii=False)
    if task == "ocr":
        return "（測試）照片辨識出的文字：道可道，非常道。名可名，非常名。"
    return "根據你的資料，道被認為無法用語言完全說明 [1]，而無為的意思是不刻意、不強求 [2]。（測試模式回答）"


def rerank(query, texts):
    """測試用：看問題裡的字出現多少"""
    qs = set(c for c in query if not c.isspace())
    return [min(1.0, len(qs & set(t)) / max(1, len(qs))) for t in texts]
