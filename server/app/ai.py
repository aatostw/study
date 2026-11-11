# -*- coding: utf-8 -*-
"""
AI 服務：Gemini、Anthropic（Claude）、OpenAI、自訂 OpenAI 相容（例如 Ollama、LM Studio）。
金鑰只存在這台電腦的資料庫；每項工作可以選不同的服務和模型（App →設定）。
"""
import base64
import re

import httpx

from . import config, db
from .textutil import parse_json

PROVIDERS = {
    "gemini": {"name": "Google Gemini", "base": "https://generativelanguage.googleapis.com/v1beta"},
    "anthropic": {"name": "Anthropic Claude", "base": "https://api.anthropic.com/v1"},
    "openai": {"name": "OpenAI", "base": "https://api.openai.com/v1"},
    "custom": {"name": "自訂（OpenAI 相容）", "base": ""},
}

# 每項工作：顯示名稱、是否需要看圖
TASKS = {
    "summary": {"label": "課程摘要", "hint": "整堂課的逐字稿 → 分段摘要、細節、時間戳。建議選比較強的模型"},
    "ask": {"label": "知識庫問答", "hint": "根據你的筆記和課程回答，附上出處"},
    "analyze": {"label": "書籍分析", "hint": "整理一本書的主題、跨書連結"},
    "ocr": {"label": "拍照辨識", "hint": "辨識書頁照片裡的文字，模型要能看圖", "vision": True},
}


class AIError(Exception):
    pass


def settings():
    s = db.get_setting("ai", {}) or {}
    s.setdefault("keys", {})
    s.setdefault("custom_base", "")
    s.setdefault("models", {})
    for t in TASKS:
        s["models"].setdefault(t, {"provider": "", "model": ""})
    return s


def public_settings():
    """給 App 看的設定：金鑰只露出最後 4 碼"""
    s = settings()
    keys = {}
    for p in PROVIDERS:
        k = (s["keys"].get(p) or "").strip()
        keys[p] = ("••••" + k[-4:]) if k else ""
    return {"keys": keys, "custom_base": s["custom_base"], "models": s["models"],
            "providers": {p: v["name"] for p, v in PROVIDERS.items()},
            "tasks": TASKS}


def update_settings(body):
    s = settings()
    for p, k in (body.get("keys") or {}).items():
        if p in PROVIDERS and isinstance(k, str):
            k = k.strip()
            if k == "-":                  # 刪除
                s["keys"].pop(p, None)
            elif k and not k.startswith("••••"):
                s["keys"][p] = k
    if isinstance(body.get("custom_base"), str):
        s["custom_base"] = body["custom_base"].strip().rstrip("/")
    for t, m in (body.get("models") or {}).items():
        if t in TASKS and isinstance(m, dict):
            s["models"][t] = {"provider": str(m.get("provider") or ""), "model": str(m.get("model") or "").strip()}
    db.set_setting("ai", s)
    return public_settings()


def _base(s, provider):
    if provider == "custom":
        b = s["custom_base"]
        if not b:
            raise AIError("自訂服務還沒填網址（設定 → AI 金鑰）。")
        return b
    return PROVIDERS[provider]["base"]


def _key(s, provider):
    k = (s["keys"].get(provider) or "").strip()
    if not k and provider != "custom":
        raise AIError("%s 還沒填金鑰（設定 → AI 金鑰）。" % PROVIDERS[provider]["name"])
    return k


def _err(r, provider):
    try:
        j = r.json()
        msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error")
        msg = msg or j.get("message") or r.text[:300]
    except ValueError:
        msg = r.text[:300]
    hint = {401: "金鑰不對或過期", 403: "金鑰沒有權限", 404: "模型名稱不對", 429: "用量到上限或太頻繁，稍後再試"}.get(r.status_code, "")
    return AIError("%s 回應錯誤（%d%s）：%s" % (PROVIDERS[provider]["name"], r.status_code,
                                           "，" + hint if hint else "", str(msg)[:300]))


def pick(task):
    s = settings()
    m = s["models"].get(task) or {}
    provider, model = m.get("provider"), m.get("model")
    if not provider or not model:
        # 沒選的話，借用「問答」的設定；再沒有就提示
        m = s["models"].get("ask") or {}
        provider, model = m.get("provider"), m.get("model")
    if not provider or not model:
        raise AIError("還沒選「%s」要用的 AI 模型（設定 → 每項工作的模型）。" % TASKS[task]["label"])
    if provider not in PROVIDERS:
        raise AIError("不認得的 AI 服務：%s" % provider)
    return s, provider, model


def generate(task, prompt, system="", images=None, json_mode=False, max_tokens=8192, provider=None, model=None):
    """回傳 (文字, '服務/模型')。images: [(mime, bytes)]"""
    if config.FAKE:
        from . import fake
        return fake.generate(task, prompt, json_mode), "fake/fake"
    if provider and model:
        s = settings()
    else:
        s, provider, model = pick(task)
    images = images or []
    base, key = _base(s, provider), _key(s, provider)
    timeout = httpx.Timeout(300, connect=20)
    try:
        if provider == "gemini":
            parts = [{"text": prompt}] + [{"inline_data": {"mime_type": mt, "data": base64.b64encode(b).decode()}} for mt, b in images]
            body = {"contents": [{"role": "user", "parts": parts}],
                    "generationConfig": {"maxOutputTokens": max_tokens}}
            if system:
                body["systemInstruction"] = {"parts": [{"text": system}]}
            if json_mode:
                body["generationConfig"]["responseMimeType"] = "application/json"
            r = httpx.post("%s/models/%s:generateContent" % (base, model), params={"key": key}, json=body, timeout=timeout)
            if r.status_code != 200:
                raise _err(r, provider)
            j = r.json()
            cands = j.get("candidates") or []
            if not cands:
                raise AIError("Gemini 沒有回答（可能被安全過濾）：%s" % str(j.get("promptFeedback", ""))[:200])
            text = "".join(p.get("text", "") for p in (cands[0].get("content") or {}).get("parts", []) if not p.get("thought"))
        elif provider == "anthropic":
            content = [{"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(b).decode()}} for mt, b in images]
            content.append({"type": "text", "text": prompt + ("\n\n只回 JSON，不要其他文字。" if json_mode else "")})
            body = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
            if system:
                body["system"] = system
            r = httpx.post(base + "/messages", json=body, timeout=timeout,
                           headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
            if r.status_code != 200:
                raise _err(r, provider)
            text = "".join(c.get("text", "") for c in r.json().get("content", []) if c.get("type") == "text")
        else:  # openai / custom：Chat Completions
            if images:
                content = [{"type": "text", "text": prompt}] + [
                    {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mt, base64.b64encode(b).decode())}} for mt, b in images]
            else:
                content = prompt
            msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
            body = {"model": model, "messages": msgs}
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            headers = {"Authorization": "Bearer " + key} if key else {}
            r = httpx.post(base + "/chat/completions", json=body, headers=headers, timeout=timeout)
            if r.status_code == 400 and json_mode and "response_format" in r.text:
                body.pop("response_format")       # 有些自訂服務不支援
                r = httpx.post(base + "/chat/completions", json=body, headers=headers, timeout=timeout)
            if r.status_code != 200:
                raise _err(r, provider)
            text = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    except httpx.TimeoutException:
        raise AIError("%s 太久沒回應，稍後再試或換一個比較快的模型。" % PROVIDERS[provider]["name"])
    except httpx.HTTPError as e:
        raise AIError("連不到 %s：%s" % (PROVIDERS[provider]["name"], e))
    text = re.sub(r"(?s)^<think>.*?</think>\s*", "", text or "").strip()   # 本地推理模型的思考過程
    if not text:
        raise AIError("AI 回了空白，換個模型再試。")
    return text, "%s/%s" % (provider, model)


def generate_json(task, prompt, **kw):
    text, used = generate(task, prompt, json_mode=True, **kw)
    try:
        return parse_json(text), used
    except ValueError:
        # 再給一次機會
        text, used = generate(task, prompt + "\n\n上一次的回覆不是合法 JSON。這次只輸出 JSON。", json_mode=True, **kw)
        return parse_json(text), used


def list_models(provider):
    if config.FAKE:
        return ["fake-small", "fake-large"]
    s = settings()
    if provider not in PROVIDERS:
        raise AIError("不認得的 AI 服務")
    base, key = _base(s, provider), _key(s, provider)
    try:
        if provider == "gemini":
            r = httpx.get(base + "/models", params={"key": key, "pageSize": 1000}, timeout=30)
            if r.status_code != 200:
                raise _err(r, provider)
            ids = [m["name"].replace("models/", "") for m in r.json().get("models", [])
                   if "generateContent" in (m.get("supportedGenerationMethods") or [])]
            ids = [i for i in ids if re.search(r"gemini|gemma", i) and not re.search(r"tts|image|audio|live|embedding|robotics|veo|computer", i)]
        elif provider == "anthropic":
            r = httpx.get(base + "/models", params={"limit": 100}, timeout=30,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
            if r.status_code != 200:
                raise _err(r, provider)
            ids = [m["id"] for m in r.json().get("data", [])]
        else:
            r = httpx.get(base + "/models", timeout=30, headers={"Authorization": "Bearer " + key} if key else {})
            if r.status_code != 200:
                raise _err(r, provider)
            ids = [m["id"] for m in r.json().get("data", []) if m.get("id")]
            if provider == "openai":
                ids = [i for i in ids if re.match(r"(gpt|o\d|chatgpt)", i) and not re.search(r"audio|realtime|tts|transcribe|image|search|embedding|moderation|dall|whisper", i)]
    except httpx.HTTPError as e:
        raise AIError("連不到 %s：%s" % (PROVIDERS[provider]["name"], e))
    return sorted(set(ids))
