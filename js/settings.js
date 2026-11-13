"use strict";
/* =========================================================
   設定：跟每日英文一樣，先是一張選單，點進去是各自的頁面
   電腦狀態、AI 模型、朗讀、課程、連線
   ========================================================= */
const STATE_TXT = {ready: ["準備好了", "green"], loading: ["載入中", "yellow"], idle: ["待命（用到才載入）", ""], error: ["出錯", "red"], offline: ["沒開", "yellow"]};
function stateChip(v){ const s = STATE_TXT[v] || [v, ""]; return '<span class="chip ' + s[1] + '">' + esc(s[0]) + "</span>"; }
const LANG_LABEL = {zh: "中文（夾英文）", en: "英文", auto: "自動判斷"};
const TTS_LANG_LABEL = {zh: "中英混合", en: "英文", auto: "自動"};
const BACK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
const CHEV = '<svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const KEY_URL = {gemini: "https://aistudio.google.com/apikey", anthropic: "https://console.anthropic.com/settings/keys", openai: "https://platform.openai.com/api-keys"};
const PROVIDER_ORDER = ["gemini", "anthropic", "openai", "custom"];
/* 常用模型（跟每日英文同一份）；paid = 需付費。清單外的可以選「自訂」自己輸入 */
const MODEL_PRESETS = {
  gemini: [{id: "gemini-3.5-flash-lite"}, {id: "gemini-3.6-flash"}, {id: "gemini-3.8-flash"}, {id: "gemini-4-argon", paid: true}],
  anthropic: [{id: "claude-haiku-5-5", paid: true}, {id: "claude-sonnet-5-5", paid: true}, {id: "claude-opus-5-5", paid: true}],
  openai: [{id: "gpt-5.6-luna", paid: true}, {id: "gpt-5.6-terra", paid: true}, {id: "gpt-5.6-sol", paid: true}],
  custom: []
};
const MODEL_DEFAULT = {gemini: "gemini-3.6-flash", anthropic: "claude-sonnet-5-5", openai: "gpt-5.6-terra", custom: ""};
const PAID = '<span class="paid-badge" title="需付費" aria-label="需付費">$</span>';
function isPaid(p, id){ return ((MODEL_PRESETS[p] || []).find(m => m.id === id) || {}).paid; }

/* 「預設」= 問答用的那組；其他工作沒有另外指定的話，就跟著它 */
function aiDefault(){ const a = S.settings.ai; return a.models.ask || {provider: "", model: ""}; }
function aiSummary(){
  const a = S.settings && S.settings.ai;
  if (!a) return "讀取中…";
  const d = aiDefault();
  if (!d.provider) return "還沒設定";
  return (a.providers[d.provider] || d.provider) + " · " + (d.model || "未選模型");
}

function renderPrefs(){
  const pr = (S.settings && S.settings.prefs) || {}, s = S.status;
  const items = [
    ["status", "電腦狀態", S.online === false ? "連不到電腦" : s ? "已連線・" + s.gpu + (s.queue.running ? "・處理中" : "") : "讀取中…"],
    ["ai", "AI 模型", aiSummary()],
    ["voice", "朗讀", "GPT-SoVITS・" + (TTS_LANG_LABEL[pr.tts_lang] || "中英混合") + "・" + Number(pr.tts_speed || 1).toFixed(1) + "×"],
    ["lecture", "影片", "預設語言：" + (LANG_LABEL[pr.lang] || LANG_LABEL.zh) + (s ? "・Whisper " + s.asr_model : "")],
    ["link", "連線", S.api.replace(/^https?:\/\//, "")]
  ];
  if (!S.prefPage){
    return '<section class="card"><h2 style="font-size:20px">設定</h2><div class="stack">' + items.map(([k, t, sub]) =>
      '<button class="menu-row" data-act="pref-open" data-p="' + k + '"><span><b>' + t + '</b><span class="small muted">' + esc(sub) + '</span></span><span class="chev" aria-hidden="true">›</span></button>').join("") +
      "</div></section>" + '<button class="prefs-logout" data-act="logout">登出</button>';
  }
  const page = {status: statusPage, ai: aiPage, voice: voicePage, lecture: lecturePrefPage, link: linkPage}[S.prefPage];
  return '<div class="back-row"><button class="back-btn" data-act="pref-back" aria-label="回到設定">' + BACK_ICON + "</button></div>" + (page ? page() : "");
}

/* ---------- 自訂下拉選單（跟每日英文一樣）---------- */
/* options: [值, 文字, 額外 HTML（例如 $ 標示）] */
function dd(id, label, options, cur, extraCls){
  const sel = options.find(o => o[0] === cur);
  return '<div class="dd"><button class="dd-btn ' + (extraCls || "") + '" id="' + id + '" data-act="dd-toggle" data-dd="' + id + '" aria-haspopup="listbox" aria-expanded="' + (S.dd === id) + '"><span class="row" style="gap:8px">' + esc(sel ? sel[1] : "請選擇") + (sel && sel[2] ? sel[2] : "") + "</span>" + CHEV + "</button>" +
    (S.dd === id ? '<div class="dd-list ' + (extraCls || "") + '" role="listbox" aria-label="' + esc(label) + '">' + options.map(o =>
      '<button class="dd-opt" role="option" aria-selected="' + (o[0] === cur) + '" data-act="dd-pick" data-dd="' + id + '" data-val="' + esc(o[0]) + '"><span>' + esc(o[1]) + "</span>" + (o[2] || "") + (o[0] === cur ? '<span class="check">' + CHECK + "</span>" : "") + "</button>").join("") + "</div>" : "") + "</div>";
}

/* ---------- 電腦狀態 ---------- */
function statusPage(){
  const s = S.status;
  let html = '<section class="card pref-card"><div class="row between"><h2 style="font-size:20px">電腦狀態</h2><button class="btn ghost sm" data-act="status-refresh">重新整理</button></div>';
  if (S.online === false) return html + '<div class="err">連不到電腦。確認電腦開著、「啟動學習伺服器」視窗也開著。</div></section>';
  if (!s) return html + '<div class="row muted"><span class="spinner"></span>讀取中…</div></section>';
  const row = (k, v) => '<div class="pref-row"><span class="small"><b>' + k + "</b></span><span class=\"small\">" + v + "</span></div>";
  html += '<div class="pref-group"><div class="pref-h">運算</div>' +
    row("顯示卡", esc(s.gpu)) +
    row("轉逐字稿（Whisper）", stateChip(s.asr)) +
    row("語意搜尋（向量模型）", stateChip(s.embed)) +
    row("朗讀（GPT-SoVITS）", stateChip(s.tts)) +
    row("ffmpeg", s.ffmpeg ? stateChip("ready") : '<span class="chip red">找不到</span>') + "</div>" +
    '<div class="pref-group"><div class="pref-h">資料</div>' +
    row("工作佇列", (s.queue.running ? "處理中 " + s.queue.running : "閒置") + (s.queue.queued ? "，排隊 " + s.queue.queued : "")) +
    row("內容", s.counts.books + " 本書・" + s.counts.notes + " 則筆記・" + s.counts.lectures + " 支影片") +
    row("硬碟剩餘", s.disk_free_gb + " GB") + "</div>" +
    (s.asr_error ? '<div class="err">Whisper：' + esc(s.asr_error) + "</div>" : "") +
    (s.embed_error ? '<div class="err">向量模型：' + esc(s.embed_error) + "</div>" : "") +
    (s.fake ? '<div class="note warn">電腦端在測試模式（STUDY_FAKE），結果都是假的。</div>' : "");
  return html + "</section>";
}

/* ---------- AI 模型：選服務、選模型、填金鑰，選了就存 ---------- */
function aiPage(){
  const st = S.settings;
  if (!st) return loading();
  const a = st.ai, d = aiDefault(), p = d.provider || S.aiProv || "", P = a.providers;
  const presets = MODEL_PRESETS[p] || [];
  const provDd = dd("ai-prov", "AI 服務", PROVIDER_ORDER.map(q => [q, P[q]]), p);
  const inPreset = presets.some(m => m.id === d.model);
  const custom = p && (S.aiCustom || !presets.length || (d.model && !inPreset));
  let model = "";
  if (p && presets.length){
    const opts = presets.map(m => [m.id, m.id, m.paid ? PAID : ""]).concat([["__custom", "自訂…"]]);
    model = dd("ai-model", "模型", opts, custom ? "__custom" : d.model, "en");
  }
  if (custom){
    model += '<input class="input en" id="ai-model-text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="輸入模型名稱" value="' + esc(inPreset ? "" : d.model || "") + '" data-act-change="ai-model-text"' + (presets.length ? ' style="margin-top:8px"' : "") + ">";
  }
  if (!p) model = '<input class="input" disabled placeholder="先選 AI 服務">';
  const keyField = !p ? "" :
    '<div class="field"><div class="row between"><label for="ai-key">API Key' + (p === "custom" ? ' <span class="muted" style="font-weight:400">（選填）</span>' : "") + "</label>" +
    (KEY_URL[p] ? '<a class="small" href="' + KEY_URL[p] + '" target="_blank" rel="noopener">取得 API Key ↗</a>' : "") + "</div>" +
    '<div class="row"><input class="input grow" id="ai-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + (a.keys[p] ? esc(a.keys[p]) + "（已設定，要換才輸入）" : "輸入 API Key") + '" data-act-change="ai-key" data-p="' + p + '">' +
    '<button class="icon-btn" data-act="key-eye" data-for="ai-key" aria-label="顯示或隱藏金鑰">' + EYE + "</button></div></div>" +
    (p === "custom" ? '<div class="field"><label for="ai-base">API Endpoint <span class="muted" style="font-weight:400">（必填）</span></label><input class="input en" id="ai-base" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="http://127.0.0.1:11434/v1" value="' + esc(a.custom_base) + '" data-act-change="ai-base"></div>' : "");
  const tr = S.aiTest;
  let html = '<section class="card ai-card"><h2 style="font-size:20px">AI 模型</h2>' +
    '<div class="field"><label for="ai-prov">AI 服務</label>' + provDd + "</div>" +
    '<div class="field"><label for="ai-model">模型</label>' + model + "</div>" +
    keyField +
    (presets.some(m => m.paid) ? '<p class="muted small" style="margin:0">標示 ' + PAID + ' 的模型需付費。</p>' : "") +
    (tr ? '<div class="' + (tr.ok ? "note ok" : "err") + '">' + esc(tr.msg) + "</div>" : "") +
    '<div class="row" style="justify-content:flex-end"><button class="btn green" data-act="ai-test"' + (S.busy.aiTest || !d.model ? " disabled" : "") + ">" + (S.busy.aiTest ? '<span class="spinner"></span>測試中' : "測試連線") + "</button></div></section>";

  /* 進階：個別工作換模型（例如拍照辨識要能看圖、課程摘要想用更強的） */
  const others = Object.keys(a.tasks).filter(t => t !== "ask");
  const withKey = PROVIDER_ORDER.filter(q => a.keys[q] || q === d.provider);
  html += '<section class="card ai-card"><details' + (S.aiAdv ? " open" : "") + ' data-act-toggle="ai-adv"><summary class="adv-sum"><b>個別工作</b><span class="small muted">　沒指定就跟上面一樣</span></summary><div class="stack" style="margin-top:12px">' +
    others.map(t => {
      const m = a.models[t] || {}, same = !m.provider || (m.provider === d.provider && m.model === d.model);
      const opts = [["", "跟上面一樣（" + (d.model || "未選") + "）"]].concat(withKey.flatMap(q => (MODEL_PRESETS[q] || []).map(x => [q + "|" + x.id, P[q] + " · " + x.id, x.paid ? PAID : ""])));
      const cur = same ? "" : m.provider + "|" + m.model;
      if (cur && !opts.some(o => o[0] === cur)) opts.push([cur, (P[m.provider] || m.provider) + " · " + m.model, isPaid(m.provider, m.model) ? PAID : ""]);
      return '<div class="field"><label class="small" for="tk-' + t + '"><b>' + esc(a.tasks[t].label) + '</b>　<span class="muted" style="font-weight:400">' + esc(a.tasks[t].hint) + "</span></label>" + dd("tk-" + t, a.tasks[t].label, opts, cur) + "</div>";
    }).join("") + "</div></details></section>";
  return html;
}

/* ---------- 朗讀 ---------- */
function voicePage(){
  const pr = (S.settings && S.settings.prefs) || {}, sp = Number(pr.tts_speed || 1);
  return '<section class="card pref-card"><h2 style="font-size:20px">朗讀</h2>' +
    '<div class="pref-row"><span><b>GPT-SoVITS</b><div class="small muted">你自己的聲音，電腦上的「啟動語音伺服器」要開著</div></span>' + (S.status ? stateChip(S.status.tts) : "") + "</div>" +
    refHTML() +
    '<div class="pref-group"><div class="pref-h">預設語言</div><div class="seg">' + ["zh", "en", "auto"].map(v => '<button data-act="pref" data-k="tts_lang" data-v="' + v + '" aria-pressed="' + ((pr.tts_lang || "zh") === v) + '">' + TTS_LANG_LABEL[v] + "</button>").join("") + "</div></div>" +
    '<div class="pref-group"><div class="row between"><label class="pref-h" for="pref-speed">預設速度</label><span class="val-pill" id="pref-speed-v">' + sp.toFixed(1) + '×</span></div>' +
    '<input type="range" id="pref-speed" min="0.6" max="1.6" step="0.1" value="' + sp + '" data-act-change="pref-speed" style="accent-color:var(--primary)"></div>' +
    '<div class="pref-group"><div class="pref-h">試聽</div><button class="btn soft" data-act="voice-test"' + (S.busy.voiceTest ? " disabled" : "") + ">" + (S.busy.voiceTest ? '<span class="spinner"></span>' : ICON.speaker) + "唸一句聽聽看</button></div>" +
    (S.err.voiceTest ? '<div class="err">' + esc(S.err.voiceTest) + "</div>" : "") + "</section>";
}

function refHTML(){
  const r = S.status && S.status.tts_ref;
  if (!r) return "";
  return '<div class="pref-group"><div class="pref-h">參考音檔（決定語氣和口音）</div>' +
    '<div class="pref-row"><span class="small"><b>英文</b><div class="muted">' + esc(r.en.file) + "：" + esc(r.en.text) + "</div></span>" + stateChip("ready") + "</div>" +
    '<div class="pref-row"><span class="small"><b>中文</b><div class="muted">' + (r.zh ? esc(r.zh.file) + "：" + esc(r.zh.text) : "還沒設定，中文也用英文樣本，口音會比較怪") + "</div></span>" + (r.zh ? stateChip("ready") : '<span class="chip yellow">未設定</span>') + "</div>" +
    (r.zh ? "" : '<div class="small muted">放一段 3～10 秒的中文錄音到 <span class="en">' + esc(r.zh_path) + "</span>，再把說的內容一字不差填進電腦上 study_config.py 的 REF_ZH_TEXT，重開伺服器。</div>") + "</div>";
}

/* ---------- 課程 ---------- */
function lecturePrefPage(){
  const pr = (S.settings && S.settings.prefs) || {}, s = S.status;
  return '<section class="card pref-card"><h2 style="font-size:20px">影片</h2>' +
    '<div class="pref-group"><div class="pref-h">影片語言（新增時的預設）</div><div class="seg">' + ["zh", "en", "auto"].map(v => '<button data-act="pref" data-k="lang" data-v="' + v + '" aria-pressed="' + ((pr.lang || "zh") === v) + '">' + LANG_LABEL[v] + "</button>").join("") + "</div>" +
    '<div class="small muted">中英夾雜的選「中文」，英文術語會照樣保留。辨識不準的話，在每支影片的資料裡補上術語。</div></div>' +
    (s ? '<div class="pref-group"><div class="pref-h">電腦上的設定</div>' +
      '<div class="pref-row"><span class="small"><b>轉逐字稿模型</b></span><span class="small en">' + esc(s.asr_model) + "</span></div>" +
      '<div class="pref-row"><span class="small"><b>待處理資料夾</b></span><span class="small">' + esc(s.inbox) + "</span></div>" +
      '<div class="small muted">要換模型或資料夾，改電腦上的 study_config.py 再重開伺服器。</div></div>' : "") + "</section>";
}

/* ---------- 連線 ---------- */
function linkPage(){
  return '<section class="card pref-card"><h2 style="font-size:20px">連線</h2>' +
    '<div class="pref-group"><label class="pref-h" for="api-url">伺服器（Cloudflare Worker）網址</label><input class="input en" id="api-url" value="' + esc(S.api) + '"></div>' +
    '<div class="row" style="justify-content:flex-end"><button class="btn soft" data-act="api-save">儲存</button></div></section>';
}

/* ---------- AI 設定的動作（選了就存）---------- */
async function aiSave(body){
  try { const r = await api("/settings", {method: "PUT", json: {ai: body}}); S.settings.ai = r.ai; }
  catch (e) { toast(errMsg(e)); }
  render();
}
/* 換預設：問答，以及原本跟著預設的工作，一起換 */
async function aiSetDefault(provider, model){
  const a = S.settings.ai, old = aiDefault(), models = {};
  Object.keys(a.tasks).forEach(t => {
    const m = a.models[t] || {};
    const follows = !m.provider || (m.provider === old.provider && m.model === old.model);
    if (t === "ask" || follows) models[t] = {provider, model};
  });
  S.aiTest = null;
  await aiSave({models});
}
async function aiLoadModels(p, quiet){
  if (!p) return;
  S.busy["ml" + p] = true; render();
  try { S.models[p] = (await api("/ai/models?provider=" + p)).models; }
  catch (e) { S.models[p] = S.models[p] || []; if (!quiet) toast(errMsg(e)); }
  S.busy["ml" + p] = false; render();
}
