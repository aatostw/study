"use strict";
/* =========================================================
   設定：跟每日英文一樣，先是一張選單，點進去是各自的頁面
   電腦狀態、AI 模型（金鑰＋每項工作的模型）、朗讀、課程、連線
   ========================================================= */
const STATE_TXT = {ready: ["準備好了", "green"], loading: ["載入中", "yellow"], idle: ["待命（用到才載入）", ""], error: ["出錯", "red"], offline: ["沒開", "yellow"]};
function stateChip(v){ const s = STATE_TXT[v] || [v, ""]; return '<span class="chip ' + s[1] + '">' + esc(s[0]) + "</span>"; }
const LANG_LABEL = {zh: "中文（夾英文）", en: "英文", auto: "自動判斷"};
const TTS_LANG_LABEL = {zh: "中英混合", en: "英文", auto: "自動"};
const BACK_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';

function aiSummary(){
  const a = S.settings && S.settings.ai;
  if (!a) return "讀取中…";
  const m = a.models.ask || {};
  const set = Object.keys(a.tasks).filter(t => a.models[t] && a.models[t].provider && a.models[t].model).length;
  if (!set) return Object.values(a.keys).some(Boolean) ? "已填金鑰・還沒選模型" : "還沒設定";
  return (a.providers[m.provider] || m.provider || "") + " · " + (m.model || "") + (set < Object.keys(a.tasks).length ? "（" + set + " / " + Object.keys(a.tasks).length + " 項）" : "");
}

function renderPrefs(){
  const pr = (S.settings && S.settings.prefs) || {}, s = S.status;
  const items = [
    ["status", "電腦狀態", S.online === false ? "連不到電腦" : s ? "已連線・" + s.gpu + (s.queue.running ? "・處理中" : "") : "讀取中…"],
    ["ai", "AI 模型", aiSummary()],
    ["voice", "朗讀", "GPT-SoVITS・" + (TTS_LANG_LABEL[pr.tts_lang] || "中英混合") + "・" + Number(pr.tts_speed || 1).toFixed(1) + "×"],
    ["lecture", "課程", "預設語言：" + (LANG_LABEL[pr.lang] || LANG_LABEL.zh) + (s ? "・Whisper " + s.asr_model : "")],
    ["link", "連線", S.api.replace(/^https?:\/\//, "")]
  ];
  if (!S.prefPage){
    return '<section class="card"><h2 class="title">設定</h2><div class="stack">' + items.map(([k, t, sub]) =>
      '<button class="menu-row" data-act="pref-open" data-p="' + k + '"><span><b>' + t + '</b><span class="small muted">' + esc(sub) + '</span></span><span class="chev" aria-hidden="true">›</span></button>').join("") +
      "</div></section>" + '<button class="prefs-logout" data-act="logout">登出</button>';
  }
  const page = {status: statusPage, ai: aiPage, voice: voicePage, lecture: lecturePrefPage, link: linkPage}[S.prefPage];
  return '<div class="back-row"><button class="back-btn" data-act="pref-back" aria-label="回到設定">' + BACK_ICON + "</button></div>" + (page ? page() : "");
}

/* ---------- 電腦狀態 ---------- */
function statusPage(){
  const s = S.status;
  let html = '<section class="card pref-card"><div class="row between"><h2 class="title">電腦狀態</h2><button class="btn ghost sm" data-act="status-refresh">重新整理</button></div>';
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
    row("內容", s.counts.books + " 本書・" + s.counts.notes + " 則筆記・" + s.counts.lectures + " 堂課") +
    row("硬碟剩餘", s.disk_free_gb + " GB") + "</div>" +
    (s.asr_error ? '<div class="err">Whisper：' + esc(s.asr_error) + "</div>" : "") +
    (s.embed_error ? '<div class="err">向量模型：' + esc(s.embed_error) + "</div>" : "") +
    (s.fake ? '<div class="note warn">電腦端在測試模式（STUDY_FAKE），結果都是假的。</div>' : "");
  return html + "</section>";
}

/* ---------- AI 模型：金鑰和每項工作的模型放在同一頁 ---------- */
function aiPage(){
  const st = S.settings;
  if (!st) return loading();
  const a = st.ai, P = a.providers;
  let html = '<section class="card pref-card"><h2 class="title">AI 模型</h2>' +
    '<p class="small muted" style="margin:0">先填你要用的服務金鑰，再替每項工作選模型。金鑰只存在你的電腦，App 只看得到最後 4 碼。</p>';

  html += '<div class="pref-group"><div class="pref-h">AI 服務金鑰</div>';
  [["gemini", "https://aistudio.google.com/apikey"], ["anthropic", "https://console.anthropic.com/settings/keys"], ["openai", "https://platform.openai.com/api-keys"]].forEach(([p, url]) => {
    html += '<div class="field"><label for="k-' + p + '" class="small">' + esc(P[p]) + ' <a href="' + url + '" target="_blank" rel="noopener">申請 ↗</a></label>' +
      '<div class="row"><input class="input en grow" id="k-' + p + '" type="password" autocomplete="off" placeholder="' + (a.keys[p] ? esc(a.keys[p]) + "（已設定，要換才填）" : "貼上金鑰") + '">' +
      (a.keys[p] ? '<button class="btn ghost sm" data-act="key-del" data-p="' + p + '">刪除</button>' : "") + "</div></div>";
  });
  html += '<div class="field"><label for="k-custom-base" class="small">自訂 OpenAI 相容服務（選填，例如本機 Ollama）</label>' +
    '<input class="input en" id="k-custom-base" placeholder="http://127.0.0.1:11434/v1" value="' + esc(a.custom_base) + '">' +
    '<input class="input en" id="k-custom" type="password" autocomplete="off" placeholder="' + (a.keys.custom ? esc(a.keys.custom) : "金鑰（沒有就留空）") + '"></div></div>';

  html += '<div class="pref-group"><div class="pref-h">每項工作的模型</div>';
  Object.keys(a.tasks).forEach(t => {
    const m = (S.modelDraft && S.modelDraft[t]) || a.models[t] || {provider: "", model: ""};
    const list = S.models[m.provider] || [];
    html += '<div class="task-box"><div><b>' + esc(a.tasks[t].label) + '</b><div class="small muted">' + esc(a.tasks[t].hint) + "</div></div>" +
      '<select class="input" data-act-change="m-provider" data-task="' + t + '"><option value="">選服務</option>' +
      Object.keys(P).map(p => '<option value="' + p + '"' + (m.provider === p ? " selected" : "") + ">" + esc(P[p]) + "</option>").join("") + "</select>" +
      '<input class="input en" id="m-' + t + '" list="ml-' + t + '" value="' + esc(m.model) + '" placeholder="模型名稱（按「載入清單」可以挑）" data-act-change="m-model" data-task="' + t + '">' +
      '<datalist id="ml-' + t + '">' + list.map(x => '<option value="' + esc(x) + '">').join("") + "</datalist>" +
      '<div class="row"><button class="btn soft sm" data-act="m-list" data-task="' + t + '"' + (!m.provider ? " disabled" : "") + ">" + (S.busy["ml" + m.provider] ? '<span class="spinner"></span>' : "") + "載入清單" + (list.length ? "（" + list.length + "）" : "") + "</button>" +
      '<button class="btn soft sm" data-act="m-test" data-task="' + t + '"' + (!m.provider || !m.model ? " disabled" : "") + ">" + (S.busy["mt" + t] ? '<span class="spinner"></span>' : "") + "測試</button>" +
      '<span class="small grow" style="text-align:right">' + (S.test && S.test[t] ? esc(S.test[t]) : "") + "</span></div></div>";
  });
  html += "</div>" +
    '<div class="row" style="justify-content:flex-end"><button class="btn green" data-act="ai-save"' + (S.busy.ai ? " disabled" : "") + ">" + (S.busy.ai ? '<span class="spinner"></span>' : "") + "儲存</button></div>" +
    (S.err.ai ? '<div class="err">' + esc(S.err.ai) + "</div>" : "") + "</section>";
  return html;
}

/* ---------- 朗讀 ---------- */
function voicePage(){
  const pr = (S.settings && S.settings.prefs) || {}, sp = Number(pr.tts_speed || 1);
  return '<section class="card pref-card"><h2 class="title">朗讀</h2>' +
    '<div class="pref-row"><span><b>GPT-SoVITS</b><div class="small muted">你自己的聲音，電腦上的「啟動語音伺服器」要開著</div></span>' + (S.status ? stateChip(S.status.tts) : "") + "</div>" +
    '<div class="pref-group"><div class="pref-h">預設語言</div><div class="seg">' + ["zh", "en", "auto"].map(v => '<button data-act="pref" data-k="tts_lang" data-v="' + v + '" aria-pressed="' + ((pr.tts_lang || "zh") === v) + '">' + TTS_LANG_LABEL[v] + "</button>").join("") + "</div></div>" +
    '<div class="pref-group"><div class="row between"><label class="pref-h" for="pref-speed">預設速度</label><span class="val-pill" id="pref-speed-v">' + sp.toFixed(1) + '×</span></div>' +
    '<input type="range" id="pref-speed" min="0.6" max="1.6" step="0.1" value="' + sp + '" data-act-change="pref-speed" style="accent-color:var(--primary)"></div>' +
    '<div class="pref-group"><div class="pref-h">試聽</div><button class="btn soft" data-act="voice-test"' + (S.busy.voiceTest ? " disabled" : "") + ">" + (S.busy.voiceTest ? '<span class="spinner"></span>' : ICON.speaker) + "唸一句聽聽看</button></div>" +
    (S.err.voiceTest ? '<div class="err">' + esc(S.err.voiceTest) + "</div>" : "") + "</section>";
}

/* ---------- 課程 ---------- */
function lecturePrefPage(){
  const pr = (S.settings && S.settings.prefs) || {}, s = S.status;
  return '<section class="card pref-card"><h2 class="title">課程</h2>' +
    '<div class="pref-group"><div class="pref-h">上課語言（新增課程時的預設）</div><div class="seg">' + ["zh", "en", "auto"].map(v => '<button data-act="pref" data-k="lang" data-v="' + v + '" aria-pressed="' + ((pr.lang || "zh") === v) + '">' + LANG_LABEL[v] + "</button>").join("") + "</div>" +
    '<div class="small muted">中英夾雜的課選「中文」，英文術語會照樣保留。辨識不準的話，在每堂課的資料裡補上術語。</div></div>' +
    (s ? '<div class="pref-group"><div class="pref-h">電腦上的設定</div>' +
      '<div class="pref-row"><span class="small"><b>轉逐字稿模型</b></span><span class="small en">' + esc(s.asr_model) + "</span></div>" +
      '<div class="pref-row"><span class="small"><b>待處理資料夾</b></span><span class="small">' + esc(s.inbox) + "</span></div>" +
      '<div class="small muted">要換模型或資料夾，改電腦上的 study_config.py 再重開伺服器。</div></div>' : "") + "</section>";
}

/* ---------- 連線 ---------- */
function linkPage(){
  return '<section class="card pref-card"><h2 class="title">連線</h2>' +
    '<div class="pref-group"><label class="pref-h" for="api-url">伺服器（Cloudflare Worker）網址</label><input class="input en" id="api-url" value="' + esc(S.api) + '"></div>' +
    '<div class="row" style="justify-content:flex-end"><button class="btn soft" data-act="api-save">儲存</button></div></section>';
}
