# -*- coding: utf-8 -*-
"""文字小工具：繁體轉換、時間格式、切段、讀 PDF / EPUB。"""
import html
import json
import re
import zipfile

_cc = None


def to_trad(text):
    """簡體 → 台灣繁體（Whisper 常常輸出簡體）。沒裝 OpenCC 就原樣回傳。"""
    global _cc
    if not text:
        return text
    if _cc is None:
        try:
            from opencc import OpenCC
            _cc = OpenCC("s2twp")
        except Exception:
            _cc = False
    return _cc.convert(text) if _cc else text


def fmt_t(sec):
    sec = max(0, int(round(float(sec or 0))))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%02d:%02d" % (m, s)


def parse_t(v):
    """'12:34' / '1:02:03' / 754 → 秒；看不懂回傳 None"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.match(r"^\s*\[?(?:(\d+):)?(\d{1,3}):(\d{2})\]?\s*$", str(v))
    if not m:
        try:
            return float(v)
        except ValueError:
            return None
    h, mi, s = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(s)


_SENT_END = re.compile(r"(?<=[。！？!?；;…])|(?<=[.!?])\s+")


def split_sentences(text):
    parts = [p.strip() for p in _SENT_END.split(text or "") if p and p.strip()]
    return parts or ([text.strip()] if text and text.strip() else [])


def chunk_text(text, size=650, overlap=1):
    """依句子切成約 size 字的段落；相鄰段落重疊 overlap 句，搜尋時不會斷在一半。"""
    text = re.sub(r"[ \t]+", " ", (text or "")).strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    sents = []
    for para in re.split(r"\n\s*\n", text):
        sents.extend(split_sentences(para.replace("\n", " ")))
    out, cur = [], []
    for s in sents:
        while len(s) > size:                      # 一句太長就硬切
            if cur:
                out.append(" ".join(cur))
                cur = []
            out.append(s[:size])
            s = s[size:]
        if cur and len(" ".join(cur)) + len(s) > size:
            out.append(" ".join(cur))
            cur = cur[-overlap:] if overlap else []
        cur.append(s)
    if cur:
        out.append(" ".join(cur))
    return out


def tts_parts(text, limit=110):
    """朗讀用：先分段落，再把句子合到約 limit 字，一段一段送去唸。"""
    parts = []
    for para in re.split(r"\n\s*\n|\n", text or ""):
        para = para.strip()
        if not para:
            continue
        buf = ""
        for s in split_sentences(para):
            # 英文比較長，放寬
            lim = limit * 2 if re.fullmatch(r"[\x00-\x7F]+", s) else limit
            if buf and len(buf) + len(s) > lim:
                parts.append(buf)
                buf = ""
            buf = (buf + " " + s).strip() if buf and re.match(r"[\x00-\x7F]", s[:1]) else buf + s
        if buf:
            parts.append(buf)
    return parts


def parse_json(text):
    """AI 回的 JSON 常常包在 ``` 裡或前後有字，盡量救回來。"""
    if text is None:
        raise ValueError("empty")
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        a, b = t.find(open_c), t.rfind(close_c)
        if a >= 0 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except ValueError:
                continue
    raise ValueError("AI 回傳的不是 JSON：" + t[:200])


# ---------- 讀書檔 ----------

def pdf_pages(path):
    """[(頁碼, 文字)]"""
    import fitz  # PyMuPDF
    out = []
    with fitz.open(path) as doc:
        for i, page in enumerate(doc):
            t = page.get_text("text") or ""
            t = re.sub(r"[ \t]+\n", "\n", t).strip()
            if t:
                out.append((str(i + 1), t))
    return out


def _strip_html(s):
    s = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|h\d|li|tr)>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t　]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def epub_chapters(path):
    """[(章節名稱, 文字)]：照書的閱讀順序（spine）讀，不需要額外套件。"""
    out = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        container = z.read("META-INF/container.xml").decode("utf-8", "replace")
        opf_path = re.search(r'full-path="([^"]+)"', container).group(1)
        base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
        opf = z.read(opf_path).decode("utf-8", "replace")
        manifest = {m.group(1): m.group(2) for m in
                    re.finditer(r'<item\b[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"', opf)}
        manifest.update({m.group(2): m.group(1) for m in
                         re.finditer(r'<item\b[^>]*?href="([^"]+)"[^>]*?id="([^"]+)"', opf)})
        order = re.findall(r'<itemref\b[^>]*?idref="([^"]+)"', opf)
        for n, idref in enumerate(order):
            href = manifest.get(idref)
            if not href:
                continue
            full = base + href.split("#")[0]
            if full not in names:
                continue
            raw = z.read(full).decode("utf-8", "replace")
            title = ""
            m = re.search(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", raw) or re.search(r"(?is)<title>(.*?)</title>", raw)
            if m:
                title = _strip_html(m.group(1))[:60]
            text = _strip_html(raw)
            if len(text) > 30:
                out.append((title or "第 %d 部分" % (n + 1), text))
    return out
