"use strict";
/* =========================================================
   設定：電腦狀態、AI 金鑰、每項工作的模型、預設值、登入
   ========================================================= */
const STATE_TXT = {ready: ["準備好了", "green"], loading: ["載入中", "yellow"], idle: ["待命（用到才載入）", ""], error: ["出錯", "red"], offline: ["沒開", "yellow"]};
function stateChip(v){ const s = STATE_TXT[v] || [v, ""]; return '<span class="chip ' + s[1] + '">' + esc(s[0]) + "</span>"; }

function renderPrefs(){
  let html = statusCard();
  const st = S.settings;
  if (!st) return html + loading();
  const a = st.ai, P = a.providers;
  // AI 金鑰
  html += '<section class="card"><h2>AI 金鑰</h2><p class="small muted" style="margin:0">金鑰只存在你的電腦（資料庫），手機和 Cloudflare 都看不到完整金鑰。用哪家就填哪家。</p>';
  [["gemini", "https://aistudio.google.com/apikey"], ["anthropic", "https://console.anthropic.com/settings/keys"], ["openai", "https://platform.openai.com/api-keys"]].forEach(([p, url]) => {
    html += '<div class="field"><label for="k-' + p + '">' + esc(P[p]) + ' <a class="small" href="' + url + '" target="_blank" rel="noopener">申請 ↗</a></label>' +
      '<div class="row"><input class="input en grow" id="k-' + p + '" type="password" autocomplete="off" placeholder="' + (a.keys[p] ? esc(a.keys[p]) + "（已設定，要換才填）" : "貼上金鑰") + '">' +
      (a.keys[p] ? '<button class="btn ghost sm" data-act="key-del" data-p="' + p + '">刪除</button>' : "") + "</div></div>";
  });
  html += '<div class="field"><label for="k-custom-base">自訂 OpenAI 相容服務（選填，例如本機的 Ollama）</label>' +
    '<input class="input en" id="k-custom-base" placeholder="http://127.0.0.1:11434/v1" value="' + esc(a.custom_base) + '">' +
    '<input class="input en" id="k-custom" type="password" autocomplete="off" placeholder="' + (a.keys.custom ? esc(a.keys.custom) : "金鑰（沒有就留空）") + '"></div>' +
    '<button class="btn" data-act="keys-save"' + (S.busy.keys ? " disabled" : "") + ">儲存金鑰</button></section>";

  // 每項工作的模型
  html += '<section class="card"><h2>每項工作的模型</h2><p class="small muted" style="margin:0">先選服務，按「載入清單」從那家拿到可用的模型；也可以直接打模型名稱。</p>';
  Object.keys(a.tasks).forEach(t => {
    const m = (S.modelDraft && S.modelDraft[t]) || a.models[t] || {provider: "", model: ""};
    const list = S.models[m.provider] || [];
    html += '<div class="field" style="padding:12px;border-radius:14px;background:var(--field)"><label>' + esc(a.tasks[t].label) + '</label><div class="small muted" style="margin-top:-4px">' + esc(a.tasks[t].hint) + "</div>" +
      '<div class="row"><select class="input" style="background:var(--surface);flex:0 0 46%" data-act-change="m-provider" data-task="' + t + '"><option value="">選服務</option>' +
      Object.keys(P).map(p => '<option value="' + p + '"' + (m.provider === p ? " selected" : "") + ">" + esc(P[p]) + "</option>").join("") + "</select>" +
      '<input class="input en grow" style="background:var(--surface)" id="m-' + t + '" list="ml-' + t + '" value="' + esc(m.model) + '" placeholder="模型名稱" data-act-change="m-model" data-task="' + t + '">' +
      '<datalist id="ml-' + t + '">' + list.map(x => '<option value="' + esc(x) + '">').join("") + "</datalist></div>" +
      '<div class="row"><button class="btn ghost sm" data-act="m-list" data-task="' + t + '"' + (!m.provider ? " disabled" : "") + ">" + (S.busy["ml" + m.provider] ? '<span class="spinner"></span>' : "") + "載入清單" + (list.length ? "（" + list.length + "）" : "") + "</button>" +
      '<button class="btn ghost sm" data-act="m-test" data-task="' + t + '"' + (!m.provider || !m.model ? " disabled" : "") + ">" + (S.busy["mt" + t] ? '<span class="spinner"></span>' : "") + "測試</button>" +
      '<span class="small grow" style="text-align:right">' + (S.test && S.test[t] ? esc(S.test[t]) : "") + "</span></div></div>";
  });
  html += '<button class="btn" data-act="models-save"' + (S.busy.models ? " disabled" : "") + ">儲存模型設定</button></section>";

  // 預設值
  const pr = st.prefs || {};
  html += '<section class="card"><h2>預設</h2><div class="field"><label>課程語言</label><div class="seg">' +
    [["zh", "中文（夾英文）"], ["en", "英文"], ["auto", "自動"]].map(o => '<button data-act="pref" data-k="lang" data-v="' + o[0] + '" aria-pressed="' + (pr.lang === o[0]) + '">' + o[1] + "</button>").join("") + "</div></div>" +
    '<div class="field"><label>朗讀語言</label><div class="seg">' + [["zh", "中英混合"], ["en", "英文"], ["auto", "自動"]].map(o => '<button data-act="pref" data-k="tts_lang" data-v="' + o[0] + '" aria-pressed="' + (pr.tts_lang === o[0]) + '">' + o[1] + "</button>").join("") + "</div></div></section>";

  // 連線
  html += '<section class="card"><h2>連線</h2><div class="field"><label for="api-url">伺服器（Cloudflare Worker）網址</label><input class="input en" id="api-url" value="' + esc(S.api) + '"></div>' +
    '<div class="row"><button class="btn soft" data-act="api-save">儲存網址</button><button class="btn ghost" data-act="logout">登出</button></div></section>';
  return html;
}

function statusCard(){
  const s = S.status;
  let html = '<section class="card"><div class="row between"><h2>電腦狀態</h2><button class="btn ghost sm" data-act="status-refresh">重新整理</button></div>';
  if (S.online === false) return html + '<div class="err">連不到電腦。確認電腦開著、「啟動學習伺服器」視窗也開著。</div></section>';
  if (!s) return html + '<div class="row muted"><span class="spinner"></span>讀取中…</div></section>';
  const row = (k, v) => '<div class="row between small"><span class="muted">' + k + "</span><span>" + v + "</span></div>";
  html += row("顯示卡", esc(s.gpu)) +
    row("轉逐字稿（Whisper " + esc(s.asr_model) + "）", stateChip(s.asr)) +
    row("語意搜尋（向量模型）", stateChip(s.embed)) +
    row("朗讀（GPT-SoVITS）", stateChip(s.tts)) +
    row("ffmpeg", s.ffmpeg ? stateChip("ready") : '<span class="chip red">找不到</span>') +
    row("工作佇列", (s.queue.running ? "處理中 " + s.queue.running : "閒置") + (s.queue.queued ? "，排隊 " + s.queue.queued : "")) +
    row("資料", s.counts.books + " 本書 · " + s.counts.notes + " 則筆記 · " + s.counts.lectures + " 堂課") +
    row("硬碟剩餘", s.disk_free_gb + " GB") +
    (s.asr_error ? '<div class="err">Whisper：' + esc(s.asr_error) + "</div>" : "") +
    (s.embed_error ? '<div class="err">向量模型：' + esc(s.embed_error) + "</div>" : "") +
    (s.fake ? '<div class="note warn">電腦端在測試模式（STUDY_FAKE），結果都是假的。</div>' : "") +
    '<div class="tiny muted">待處理資料夾：' + esc(s.inbox) + "</div>";
  return html + "</section>";
}
