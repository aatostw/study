"use strict";
/* =========================================================
   助理：對話。問知識庫（看得懂追問）、評估一本書（對話裡出現評估卡）
   ========================================================= */
S.chat = null;            // {id, title, messages:[]}
S.chats = null;           // 對話紀錄
S.chatPending = null;     // 送出中的那句話
S.voice = lsGet("voice") === "1";   // 語音模式
S.chatPins = [];          // 指定：[{kind, id, label}]，跟著這段對話
S.chatOpts = {kb: lsGet("chat_kb") !== "0", web: lsGet("chat_web") !== "0", balance: lsGet("chat_balance") || "kb"};
S.showCite = lsGet("show_cite") !== "0";   // 顯示 [1][2] 引用標號
document.documentElement.classList.toggle("hide-cite", !S.showCite);   // 引用書櫃／網路搜尋
S.rec = {state: "idle"};  // idle / rec / stt

async function loadChats(){ S.chats = (await api("/chats")).chats; renderSoon(); }
async function openChat(id){
  const j = await api("/chats/" + id);
  S.chat = {id: j.chat.id, title: j.chat.title, messages: j.messages};
  S.chatPins = j.chat.pins || [];
  S.chatScroll = true; render();
}

function renderAssist(){
  let html = "" +
    '<div class="row between assist-bar"><div class="mode-seg" role="group" aria-label="模式">' +
      '<button data-act="voice-mode" data-v="0" aria-pressed="' + !S.voice + '">⌨️ 文字</button><button data-act="voice-mode" data-v="1" aria-pressed="' + S.voice + '">🎙️ 語音</button></div>' +
    '<span class="row"><button class="btn ghost sm" data-act="chat-history">🕘 紀錄</button>' +
    (S.chat ? '<button class="btn ghost sm" data-act="chat-new">' + ICON.plus + "新對話</button>" : "") + "</span></div>";

  const msgs = (S.chat && S.chat.messages) || [];
  if (!msgs.length && !S.chatPending){
    html += '<section class="card hero"><div class="label">助理</div><h1>想聊什麼？</h1><div class="sub">勾「引用書櫃」會翻你的書、筆記、課程回答並標出處；勾「網路搜尋」會上網找資料；兩個都不勾就直接聊。</div></section>';
  } else {
    html += '<div class="thread">' + msgs.map(msgHTML).join("");
    if (S.chatPending) html += '<div class="msg user"><div class="bubble">' + esc(S.chatPending) + "</div></div>" +
      '<div class="msg ai"><div class="bubble typing"><span></span><span></span><span></span></div><div class="tiny muted">' + (S.chatPins.length ? "正在翻你指定的資料…" : S.chatOpts.kb && S.chatOpts.web ? "正在翻你的書櫃、上網找資料…" : S.chatOpts.kb ? "正在翻你的書櫃…" : S.chatOpts.web ? "正在上網找資料…" : "思考中…") + "</div></div>";
    html += "</div>";
  }
  if (S.err.chat) html += '<div class="err">' + esc(S.err.chat) + "</div>";
  const o = S.chatOpts, pins = S.chatPins;
  const scope = '<div class="scope-mini">' +
    '<button class="tog" data-act="chat-opt" data-k="kb" aria-pressed="' + (o.kb || !!pins.length) + '"' + (pins.length ? " disabled" : "") + '><span class="box">' + (o.kb || pins.length ? "✓" : "") + "</span>" + (pins.length ? "只看指定" : "引用書櫃") + "</button>" +
    '<button class="tog" data-act="chat-opt" data-k="web" aria-pressed="' + o.web + '"><span class="box">' + (o.web ? "✓" : "") + "</span>網路搜尋</button>" +
    '<button class="tog pin" data-act="pin-sheet" aria-pressed="' + (!!pins.length || o.balance !== "kb") + '">⚙️ 進階' +
      ([pins.length ? "指定 " + pins.length : "", o.web && o.balance !== "kb" ? {even: "平衡", web: "網路為主"}[o.balance] : ""].filter(Boolean).map(x => "・" + x).join("")) + "</button>" +
    '<button class="tog" data-act="cite-toggle" aria-pressed="' + S.showCite + '"><span class="box">' + (S.showCite ? "✓" : "") + "</span>顯示引用</button>" +
    (!o.kb && !o.web && !pins.length ? '<span class="tiny muted">直接聊</span>' : "") + "</div>" +
    (pins.length ? '<div class="pins">' + pins.map((p, i) => '<span class="pin-chip">' + ({book: "📘", note: "📝", lecture: "🎓"}[p.kind] || "📌") + " " + esc(p.label) +
      '<button data-act="pin-del" data-i="' + i + '" aria-label="取消指定">✕</button></span>').join("") + "</div>" : "");
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
  const others = (m.sources || []).filter(s => !s.cited);
  if (cited.length || others.length) html += '<details class="no-read"><summary class="small muted">出處（' + cited.length + "）" + (others.length ? "・其他參考 " + others.length : "") + '</summary><div class="stack" style="margin-top:8px">' +
    cited.map(s => srcRow(s, ctx)).join("") +
    (others.length ? '<div class="tiny muted" style="margin-top:4px">也有讀，但回答沒有引用：</div>' + others.map(s => srcRow(s, ctx)).join("") : "") + "</div></details>";
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
    const r = await api("/chat", {json: {chat_id: S.chat && S.chat.id, message: text, kb: S.chatOpts.kb, web: S.chatOpts.web, pins: S.chatPins, balance: S.chatOpts.balance}});
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

/* 進階：比重＋指定資料（全選、搜尋；每類先顯示最近編輯的 3 項，可展開） */
S.pinUI = {q: "", more: {}, det: {}, sel: null};
function pinItems(){
  return {
    book: (S.books || []).map(b => ({kind: "book", id: b.id, label: b.title, sub: [b.author, SHELF[b.shelf], b.notes + " 則筆記"].filter(Boolean).join(" · "), ic: "📘"})),
    note: (S.notes || []).filter(n => !n.no_index).map(n => ({kind: "note", id: n.id, label: n.title || "（無標題）", sub: "最後編輯 " + fmtDate(n.updated_at) + (n.preview ? " · " + n.preview.replace(/\s+/g, " ").slice(0, 40) : ""), ic: "📝"})),
    lecture: (S.lectures || []).map(l => ({kind: "lecture", id: l.id, label: l.title, sub: [l.course, fmtDate(l.created_at), l.duration ? fmtDur(l.duration) : ""].filter(Boolean).join(" · "), ic: "🎓"})),
  };
}
function pinListHTML(){
  const u = S.pinUI, q = u.q.trim().toLowerCase(), all = pinItems();
  let html = "";
  for (const [k, name] of [["book", "書"], ["note", "記事本"], ["lecture", "課程"]]){
    let list = all[k].filter(x => !q || (x.label + " " + x.sub).toLowerCase().includes(q));
    if (!list.length) continue;
    const total = list.length, open = u.more[k] || q;
    if (!open) list = list.slice(0, 3);
    html += '<div class="row between"><div class="label">' + name + "（" + total + "）</div></div><div class=\"stack\">" + list.map(x => {
      const key = x.kind + ":" + x.id, det = u.det[key];
      return '<div class="pin-row"><label class="pin-main"><input type="checkbox" data-pin="' + key + '"' + (u.sel.has(key) ? " checked" : "") + '><span class="pin-t">' + x.ic + " " + esc(x.label) + "</span></label>" +
        '<button class="pin-det" data-act="pin-det" data-k="' + key + '">' + (det ? "收合" : "展開") + "</button>" +
        (det ? '<div class="pin-sub small muted">' + esc(x.sub || "—") + "</div>" : "") + "</div>";
    }).join("") + "</div>" +
      (!q && total > 3 ? '<button class="btn ghost sm block" data-act="pin-more" data-k="' + k + '">' + (u.more[k] ? "收合" : "展開全部（還有 " + (total - 3) + " 項）") + "</button>" : "");
  }
  return html || '<div class="empty small">' + (q ? "找不到符合的資料" : "書櫃還是空的") + "</div>";
}
function advSheetBody(){
  const o = S.chatOpts, u = S.pinUI;
  return '<h2 style="margin:0">進階</h2>' +
    '<div class="label">比重</div><div class="bal-seg" role="group" aria-label="比重">' + [["kb", "書櫃為主"], ["even", "平衡"], ["web", "網路為主"]].map(x =>
      '<button data-act="chat-balance" data-v="' + x[0] + '" aria-pressed="' + (o.balance === x[0]) + '">' + x[1] + "</button>").join("") + "</div>" +
    '<div class="tiny muted">同時開「網路搜尋」和書櫃（或指定）時才有作用。</div>' +
    '<div class="row between" style="margin-top:6px"><div class="label">指定資料</div><span class="tiny muted" id="pin-count">已選 ' + u.sel.size + " 項</span></div>" +
    '<div class="tiny muted">勾選後，助理只在這些裡面找書櫃資料。只跟著這段對話。</div>' +
    '<div class="row"><input class="input grow" id="pin-q" placeholder="搜尋書名、作者、課程…" value="' + esc(u.q) + '">' +
    '<button class="btn soft sm" data-act="pin-all">全選</button><button class="btn ghost sm" data-act="pin-clear">清除</button></div>' +
    '<div id="pin-list" class="stack">' + (!S.books || !S.notes || !S.lectures ? '<div class="row muted"><span class="spinner"></span>載入中…</div>' : pinListHTML()) + "</div>" +
    '<button class="btn block" data-act="pin-done">完成</button>';
}
function pinRedraw(){ const l = $("#pin-list"); if (l) l.innerHTML = pinListHTML(); const c = $("#pin-count"); if (c) c.textContent = "已選 " + S.pinUI.sel.size + " 項"; }
async function pinSheet(){
  S.pinUI = {q: "", more: {}, det: {}, sel: new Set(S.chatPins.map(p => p.kind + ":" + p.id))};
  openSheet(advSheetBody());
  if (!S.books || !S.notes || !S.lectures){
    await Promise.all([S.books ? 0 : loadBooks(true), S.notes ? 0 : loadNotebook(true), S.lectures ? 0 : loadLectures().catch(() => {})]).catch(() => {});
    pinRedraw();
  }
}
