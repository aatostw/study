"use strict";
/* =========================================================
   助理：對話。問知識庫（看得懂追問）、評估一本書（對話裡出現評估卡）
   ========================================================= */
S.chat = null;            // {id, title, messages:[]}
S.chats = null;           // 對話紀錄
S.chatPending = null;     // 送出中的那句話
S.voice = lsGet("voice") === "1";   // 語音模式
S.rec = {state: "idle"};  // idle / rec / stt

async function loadChats(){ S.chats = (await api("/chats")).chats; renderSoon(); }
async function openChat(id){
  const j = await api("/chats/" + id);
  S.chat = {id: j.chat.id, title: j.chat.title, messages: j.messages};
  S.chatScroll = true; render();
}

function renderAssist(){
  let html = '<div class="assist-top"><div class="chips">' +
    '<button class="chip-btn" data-act="ask-focus">💬 問我的筆記</button>' +
    "</div>" +
    "</div></div>" +
    '<div class="row between assist-bar"><div class="mode-seg" role="group" aria-label="模式">' +
      '<button data-act="voice-mode" data-v="0" aria-pressed="' + !S.voice + '">⌨️ 文字</button><button data-act="voice-mode" data-v="1" aria-pressed="' + S.voice + '">🎙️ 語音</button></div>' +
    '<span class="row"><button class="btn ghost sm" data-act="chat-history">🕘 紀錄</button>' +
    (S.chat ? '<button class="btn ghost sm" data-act="chat-new">' + ICON.plus + "新對話</button>" : "") + "</span></div>";

  const msgs = (S.chat && S.chat.messages) || [];
  if (!msgs.length && !S.chatPending){
    html += '<section class="card hero"><div class="label">助理</div><h1>想問什麼？</h1><div class="sub">我會翻你的書、筆記、課程回答，每句都標出處。說「評估《書名》」，我也會上網幫你看這本書值不值得讀。</div></section>' +
      '<div class="stack">' + ["老子和莊子對「無為」的看法有什麼不同？", "這週上課講的重點是什麼？", "幫我評估《原子習慣》"].map(q =>
        '<button class="list-row" data-act="chat-example" data-q="' + esc(q) + '"><span class="t"><b>' + esc(q) + '</b></span><span class="chev">›</span></button>').join("") + "</div>";
  } else {
    html += '<div class="thread">' + msgs.map(msgHTML).join("");
    if (S.chatPending) html += '<div class="msg user"><div class="bubble">' + esc(S.chatPending) + "</div></div>" +
      '<div class="msg ai"><div class="bubble typing"><span></span><span></span><span></span></div><div class="tiny muted">正在翻你的筆記…</div></div>';
    html += "</div>";
  }
  if (S.err.chat) html += '<div class="err">' + esc(S.err.chat) + "</div>";
  const scope = '<div class="scope-mini">' + [["all", "全部"], ["books", "書和筆記"], ["lectures", "課程"]].map(o =>
      '<button data-act="ask-scope" data-v="' + o[0] + '" aria-pressed="' + (S.ask.scope === o[0]) + '">' + o[1] + "</button>").join("") + "</div>";
  if (S.voice){
    html += '<div class="composer voice">' + scope + voiceHTML() + "</div>";
    return html;
  }
  html += '<div class="composer">' + scope +
    '<div class="row"><textarea class="input" id="chat-in" rows="1" placeholder="' + (msgs.length ? "接著問…" : "問你讀過的書、上過的課…") + '" data-draft="chat">' + esc(S.chatDraft || "") + "</textarea>" +
    '<button class="send" data-act="chat-send" aria-label="送出"' + (S.chatPending ? " disabled" : "") + ">" +
    (S.chatPending ? '<span class="spinner" style="width:18px;height:18px;border-color:#fff4;border-top-color:#fff"></span>' : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.5-7.5c.8-.4.8-1.5 0-1.8L3.4 3.6c-.7-.3-1.4.3-1.3 1l1.4 6.3 9 1.1-9 1.1-1.4 6.3c-.1.7.6 1.3 1.3 1z"/></svg>') + "</button></div></div>";
  return html;
}

function msgHTML(m){
  if (m.role === "user") return '<div class="msg user"><div class="bubble">' + esc(m.content) + "</div></div>";
  const ctx = "m" + m.id, cited = (m.sources || []).filter(s => s.cited);
  let html = '<div class="msg ai"><div class="bubble" data-read="助理的回答"><div class="rich">' + richHTML(m.content, ctx) + "</div>";
  if (m.card && m.card.type === "eval") html += '<div class="no-read">' + evalCardHTML(m.card.book_id) + "</div>";
  html += '<div class="row between no-read msg-foot">' + (m.content ? readBtn() : "") + (m.model ? '<span class="tiny muted">' + esc(m.model) + "</span>" : "") + "</div>";
  if (cited.length) html += '<details class="no-read"><summary class="small muted">出處（' + cited.length + '）</summary><div class="stack" style="margin-top:8px">' + cited.map(s => srcRow(s, ctx)).join("") + "</div></details>";
  return html + "</div></div>";
}

function evalCardHTML(bid){
  const b = (S.books || []).find(x => x.id === bid);
  if (!b) return '<button class="list-row" data-act="open-book" data-id="' + bid + '"><span class="t"><b>看評估</b></span><span class="chev">›</span></button>';
  const busy = b.eval_status === "queued" || b.eval_status === "running";
  const L = LIGHT[b.light], V = VERDICT[b.verdict];
  return '<button class="list-row evalcard" data-act="open-book" data-id="' + b.id + '"><span class="ic yellow">' + (busy ? '<span class="spinner" style="width:18px;height:18px"></span>' : L ? L[2] : "📖") + "</span>" +
    '<span class="t"><b>' + esc(b.title) + '</b><span class="sub">' + (busy ? "評估中…" : b.eval_status === "error" ? "評估失敗，點進去重試" : esc(b.headline || "點開看評估")) + "</span></span>" +
    (V && !busy ? '<span class="chip ' + V[1] + '">' + V[0] + "</span>" : '<span class="chev">›</span>') + "</button>";
}

async function chatSend(text){
  text = (text || "").trim();
  if (!text || S.chatPending) return;
  S.chatPending = text; S.chatDraft = ""; S.err.chat = ""; S.chatScroll = true; render();
  try {
    const r = await api("/chat", {json: {chat_id: S.chat && S.chat.id, message: text, scope: S.ask.scope}});
    if (!S.chat || S.chat.id !== r.chat.id) S.chat = {id: r.chat.id, title: r.chat.title, messages: (S.chat && S.chat.id === r.chat.id) ? S.chat.messages : []};
    S.chat.messages.push(...r.messages);
    if (r.messages.some(m => m.card)){ pollJobs(true); loadBooks(true).then(renderSoon).catch(() => {}); }
    loadChats().catch(() => {});
  } catch (e) { if (!e.relogin){ S.err.chat = errMsg(e); S.chatDraft = text; } }
  S.chatPending = null; S.chatScroll = true; render();
}

function chatHistorySheet(){
  const list = S.chats || [];
  openSheet('<div class="row between"><h2 style="margin:0">對話紀錄</h2><button class="btn soft sm" data-act="chat-new">' + ICON.plus + "新對話</button></div>" +
    (!S.chats ? '<div class="row muted"><span class="spinner"></span>載入中…</div>' : !list.length ? '<div class="empty">還沒有對話。</div>'
      : '<div class="stack">' + list.map(c => '<div class="row"><button class="list-row grow" data-act="chat-open" data-id="' + c.id + '"><span class="t"><b>' + esc(c.title || "（無標題）") + '</b><span class="sub">' + fmtDate(c.updated_at) + " · " + c.n + " 則</span></span></button>" +
        '<button class="icon-btn" data-act="chat-del" data-id="' + c.id + '" aria-label="刪除">' + ICON.trash + "</button></div>").join("") + "</div>"));
}

/* =========================================================
   語音模式：點一下開始說、再點一下送出 → 電腦聽寫 → 回答 → 用你的聲音唸
   回答的文字和文字模式一模一樣，所以音檔也共用（電腦會快取）
   ========================================================= */
const MIC = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function voiceHTML(){
  const r = S.rec, t = S.tts;
  let state = "idle", label = "點一下開始說";
  if (r.state === "rec"){ state = "rec"; label = "正在聽 " + fmtT((Date.now() - r.start) / 1000) + "　說完再點一下"; }
  else if (r.state === "stt"){ state = "busy"; label = "聽寫中…"; }
  else if (S.chatPending){ state = "busy"; label = "思考中…"; }
  else if (t.playing && S.voiceSpeaking){ state = "speak"; label = "正在唸　點一下打斷並開始說"; }
  return '<div class="voice-box"><button class="mic ' + state + '" data-act="mic" aria-label="' + label + '"' + (state === "busy" ? " disabled" : "") + ">" +
    (state === "busy" ? '<span class="spinner" style="width:28px;height:28px;border-color:#fff4;border-top-color:#fff"></span>' : MIC) + "</button>" +
    '<div class="voice-label" id="voice-label">' + label + "</div>" +
    (r.state === "rec" ? '<button class="btn ghost sm" data-act="mic-cancel">取消</button>' : "") + "</div>";
}

const REC = {
  mr: null, chunks: [], stream: null, timer: 0, cancel: false,
  async start(){
    TTSP.stop(); S.voiceSpeaking = false;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast("這個瀏覽器不能錄音");
    try { REC.stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}}); }
    catch (e) { return toast("沒有麥克風權限：請在瀏覽器允許使用麥克風"); }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(x => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(x)) || "";
    REC.mr = new MediaRecorder(REC.stream, type ? {mimeType: type} : undefined);
    REC.chunks = []; REC.cancel = false;
    REC.mr.ondataavailable = e => { if (e.data && e.data.size) REC.chunks.push(e.data); };
    REC.mr.onstop = () => REC.done();
    REC.mr.start();
    S.rec = {state: "rec", start: Date.now()}; render();
    if (navigator.vibrate) navigator.vibrate(30);
    clearInterval(REC.timer);
    REC.timer = setInterval(() => {
      const l = $("#voice-label");
      if (l && S.rec.state === "rec") l.textContent = "正在聽 " + fmtT((Date.now() - S.rec.start) / 1000) + "　說完再點一下";
      if (Date.now() - S.rec.start > 180000) REC.stop();          // 最多 3 分鐘
    }, 500);
  },
  stop(cancel){
    clearInterval(REC.timer);
    REC.cancel = !!cancel;
    if (REC.mr && REC.mr.state !== "inactive") REC.mr.stop();
    if (REC.stream) REC.stream.getTracks().forEach(t => t.stop());
  },
  async done(){
    const blob = new Blob(REC.chunks, {type: (REC.mr && REC.mr.mimeType) || "audio/webm"});
    REC.mr = null; REC.stream = null;
    if (REC.cancel || blob.size < 1500){ S.rec = {state: "idle"}; render(); if (!REC.cancel) toast("太短了，再說一次"); return; }
    S.rec = {state: "stt"}; render();
    try {
      const r = await api("/stt", {method: "POST", body: blob, headers: {"Content-Type": blob.type.split(";")[0] || "audio/webm"}});
      S.rec = {state: "idle"};
      await chatSend(r.text);
      speakLast();
    } catch (e) { S.rec = {state: "idle"}; render(); if (!e.relogin) toast(errMsg(e)); }
  }
};

/* 語音模式：回答出來就自動唸（跳過引用編號、出處、按鈕） */
function speakLast(){
  if (!S.voice || S.view !== "ask") return;
  const boxes = document.querySelectorAll(".msg.ai .bubble[data-read]");
  const box = boxes[boxes.length - 1];
  if (!box) return;
  S.voiceSpeaking = true;
  readAloud(readableText(box), "助理的回答");
}
