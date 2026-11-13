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

const WAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/></svg>';
const SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';
const MIC2 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

/* 目前的回答方式，一行字 */
function chatModeLabel(){
  const o = S.chatOpts, n = S.chatPins.length;
  let s = n ? "指定 " + n + " 項" : o.kb && o.web ? "書櫃＋網路" : o.kb ? "書櫃" : o.web ? "網路" : "直接聊";
  if (o.web && (o.kb || n) && o.balance !== "kb") s += "・" + {even: "平衡", web: "網路為主"}[o.balance];
  return s;
}

function renderAssist(){
  let html = '<div class="row between assist-bar"><button class="chat-title" data-act="chat-history" aria-label="對話紀錄"><span class="ellip">' + esc(S.chat ? S.chat.title : "新對話") +
    '</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>' +
    (S.chat ? '<button class="btn ghost sm" data-act="chat-new">' + ICON.plus + "新對話</button>" : "") + "</div>";

  const msgs = (S.chat && S.chat.messages) || [];
  if (!msgs.length && !S.chatPending){
    html += '<section class="card hero"><div class="label">助理</div><h1>想聊什麼？</h1><div class="sub">按左下角「＋」可以選要不要引用書櫃、上網搜尋，或指定只看某幾本書。</div></section>';
  } else {
    html += '<div class="thread">' + msgs.map(msgHTML).join("");
    if (S.chatPending) html += '<div class="msg user"><div class="bubble">' + esc(S.chatPending) + "</div></div>" +
      '<div class="msg ai"><div class="bubble typing"><span></span><span></span><span></span></div><div class="tiny muted">' + (S.chatPins.length ? "正在翻你指定的資料…" : S.chatOpts.kb && S.chatOpts.web ? "正在翻你的書櫃、上網找資料…" : S.chatOpts.kb ? "正在翻你的書櫃…" : S.chatOpts.web ? "正在上網找資料…" : "思考中…") + "</div></div>";
    html += "</div>";
  }
  if (S.err.chat) html += '<div class="err">' + esc(S.err.chat) + "</div>";
  const pins = S.chatPins;
  const citeTog = '<div class="cmp-top"><button class="tog cite-tog" data-act="cite-toggle" aria-pressed="' + S.showCite + '"><span class="box">' + (S.showCite ? "✓" : "") + "</span>顯示引用</button></div>";
  const pinRow0 = pins.length ? '<div class="pins">' + pins.map((p, i) => '<span class="pin-chip">' + ({book: "📘", note: "📝", lecture: "🎓"}[p.kind] || "📌") + " " + esc(p.label) +
      '<button data-act="pin-del" data-i="' + i + '" aria-label="取消指定">✕</button></span>').join("") + "</div>" : "";
  const pinRow = citeTog;      // 指定的資料不另外顯示標籤，看「＋」旁的模式標籤或「進階」
  if (S.voice){
    html += '<div class="composer voice">' + pinRow + voiceHTML() + '<button class="btn ghost sm" data-act="voice-mode" data-v="0">⌨️ 改用文字</button></div>';
    return html;
  }
  const draft = S.chatDraft || "", rec = S.rec.state;
  const open = !!draft || S.cmpOpen;
  let act;
  if (S.chatPending) act = '<button class="cmp-act" disabled aria-label="回答中"><span class="spinner" style="width:18px;height:18px;border-color:#fff4;border-top-color:#fff"></span></button>';
  else act = '<button class="cmp-act" data-act="cmp-act" aria-label="' + (draft.trim() ? "送出" : "語音對話") + '">' + (draft.trim() ? SEND : WAVE) + "</button>";
  if (S.recMode !== "voice" && (rec === "rec" || rec === "stt")){
    html += '<div class="composer">' + pinRow + '<div class="cmp recbar">' +
      '<button class="cmp-btn" data-act="rec-cancel" aria-label="取消">✕</button>' +
      (rec === "rec" ? '<div class="wave" id="wave"></div>' : '<div class="rec-msg">正在轉錄…</div>') +
      (rec === "rec" ? '<button class="rec-stop" data-act="rec-stop" aria-label="停止，文字放進輸入框"><span></span></button>'
        : '<span class="rec-spin"><span class="spinner" style="width:20px;height:20px"></span></span>') +
      '<button class="cmp-act send" data-act="rec-send" aria-label="直接送出"' + (rec === "stt" ? " disabled" : "") + ">" + SEND + "</button></div></div>";
    return html;
  }
  html += '<div class="composer">' + pinRow +
    '<div class="cmp' + (open ? " open" : "") + (draft.trim() ? " has-text" : "") + (rec === "rec" && S.recMode !== "voice" ? " recording" : "") + '" id="cmp">' +
      '<textarea id="chat-in" rows="1" data-draft="chat" placeholder="' + (rec === "rec" ? (S.recMode === "ptt" ? "正在聽…放開就送出" : "正在聽…再按麥克風結束") : rec === "stt" ? "聽寫中…" : open ? "回覆助理…" : "回覆或長按說話") + '">' + esc(draft) + "</textarea>" +
      '<button class="cmp-btn plus" data-act="cmp-menu" aria-label="選項">' + ICON.plus + "</button>" +
      '<button class="cmp-chip" data-act="cmp-menu">' + esc(chatModeLabel()) + "</button>" +
      '<button class="cmp-btn mic' + (rec === "rec" && S.recMode === "dictate" ? " on" : "") + '" data-act="cmp-mic" aria-label="聽寫"' + (rec === "stt" ? " disabled" : "") + ">" +
        (rec === "stt" && S.recMode !== "voice" ? '<span class="spinner" style="width:16px;height:16px"></span>' : MIC2) + "</button>" +
      act + "</div></div>";
  return html;
}

/* 「＋」選單：引用書櫃、網路搜尋、顯示引用、進階 */
function cmpMenu(){
  const o = S.chatOpts, n = S.chatPins.length;
  const tile = (k, on, title, dis) => '<button class="menu-tile" data-act="' + k + '"' + (dis ? " disabled" : "") + '><b>' + title + '</b><span class="sw' + (on ? " on" : "") + '"></span></button>';
  openSheet('<div class="row" style="gap:10px"><h2 style="margin:0">回答方式</h2>' +
    (n ? '<button class="part-chip" data-act="pin-sheet" title="' + esc(S.chatPins.map(p => p.label).join("、")) + '">📌 部分引用（' + n + " 項）</button>" : "") + "</div>" +
    '<div class="tile-row">' + tile("menu-kb", o.kb || n, n ? "只看指定" : "引用書櫃", n) + tile("menu-web", o.web, "網路搜尋") + "</div>" +
    '<button class="menu-sw" data-act="pin-sheet"><span><b>⚙️ 進階</b></span><span class="chev">›</span></button>' +
    "");
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
  return '<button class="list-row evalcard" data-act="open-book" data-id="' + b.id + '"><span class="ic lic-box ' + (L ? L[1] : "lt-unknown") + '">' + (busy ? '<span class="spinner" style="width:18px;height:18px"></span>' : L ? L[2] : lightIcon("unknown")) + "</span>" +
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
  mr: null, chunks: [], stream: null, timer: 0, cancel: false, then: "", ac: null, levels: [], wtimer: 0,
  async start(mode){
    S.recMode = mode || "voice";       // voice：語音對話；dictate：聽寫到輸入框；ptt：長按說話，放開就送出
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
    REC.then = S.recMode === "ptt" ? "send" : "";
    S.rec = {state: "rec", start: Date.now()}; render();
    REC.meter();
    if (navigator.vibrate) navigator.vibrate(30);
    clearInterval(REC.timer);
    REC.timer = setInterval(() => {
      const l = $("#voice-label");
      if (S.recMode !== "voice") return;
      if (l && S.rec.state === "rec") l.textContent = "正在聽 " + fmtT((Date.now() - S.rec.start) / 1000) + "　說完再點一下";
      if (Date.now() - S.rec.start > 180000) REC.stop();          // 最多 3 分鐘
    }, 500);
  },
  /* 音量波形：每 70ms 量一次音量，從右邊長出一根直條 */
  meter(){
    REC.levels = [];
    clearInterval(REC.wtimer);
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      REC.ac = new AC();
      const src = REC.ac.createMediaStreamSource(REC.stream), an = REC.ac.createAnalyser();
      an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      REC.wtimer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf){ const x = (v - 128) / 128; sum += x * x; }
        REC.levels.push(Math.min(1, Math.sqrt(sum / buf.length) * 4.5));
        if (REC.levels.length > 90) REC.levels.shift();
        const w = $("#wave");
        if (w) w.innerHTML = REC.levels.map(l => '<i style="height:' + Math.max(10, Math.round(l * 100)) + '%"></i>').join("");
      }, 70);
    } catch (e) {}
  },
  stop(cancel, then){
    if (then) REC.then = then;
    clearInterval(REC.wtimer);
    if (REC.ac){ REC.ac.close().catch(() => {}); REC.ac = null; }
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
      if (REC.cancel){ render(); return; }          // 轉錄中按了 ✕
      if (S.recMode !== "voice" && REC.then !== "send"){
        S.chatDraft = (S.chatDraft ? S.chatDraft.replace(/\s+$/, "") + " " : "") + r.text; S.cmpOpen = true; render();
        const q = $("#chat-in"); if (q){ q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
        return;
      }
      const text = S.recMode === "voice" ? r.text : (S.chatDraft ? S.chatDraft.replace(/\s+$/, "") + " " : "") + r.text;
      if (S.recMode !== "voice"){ S.chatDraft = ""; S.cmpOpen = false; }
      await chatSend(text);
      if (S.recMode === "voice") speakLast();
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
  for (const [k, name] of [["book", "書"], ["note", "記事本"], ["lecture", "影片"]]){
    let list = all[k].filter(x => !q || (x.label + " " + x.sub).toLowerCase().includes(q));
    if (!list.length) continue;
    const total = list.length, open = u.more[k] || q;
    if (!open) list = list.slice(0, 3);
    html += '<div class="row between"><div class="label">' + name + "（" + total + "）</div></div><div class=\"stack\">" + list.map(x => {
      const key = x.kind + ":" + x.id, det = u.det[key];
      return '<div class="pin-row"><label class="pin-main"><input type="checkbox" data-pin="' + key + '"' + (u.sel.has(key) ? " checked" : "") + '><span class="pin-t">' + esc(x.label) + "</span></label>" +
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

    '<div class="row between" style="margin-top:6px"><div class="label">指定資料</div><span class="tiny muted" id="pin-count">已選 ' + u.sel.size + " 項</span></div>" +

    '<div class="row"><input class="input grow" id="pin-q" placeholder="搜尋書名、作者、影片…" value="' + esc(u.q) + '">' +
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


/* =========================================================
   各頁右上角「問助理」：底部彈窗，只引用這本書／這則筆記／這支影片
   ========================================================= */
function popTarget(){
  const sub = S.sub;
  if (!sub) return null;
  if ((sub.type === "book" || sub.type === "eval") && S.book && S.book.book.id === sub.id) return {kind: "book", id: sub.id, label: S.book.book.title};
  if (sub.type === "note" && S.note && S.note.id === sub.id) return {kind: "note", id: sub.id, label: S.note.title || "筆記"};
  if (sub.type === "lecture" && S.lecture && S.lecture.lecture.id === sub.id) return {kind: "lecture", id: sub.id, label: S.lecture.lecture.title};
  return null;
}
function syncAskBtn(){
  const b = $("#hdr-ask"); if (!b) return;
  const t = popTarget();
  b.hidden = !t;
  if (!t && !$("#askpop").hidden) askPopClose();
}
const POP_NAME = {book: "這本書", note: "這則筆記", lecture: "這支影片"};
function askPopOpen(quote){
  const t = popTarget(); if (!t) return;
  if (!S.pop || S.pop.kind !== t.kind || S.pop.id !== t.id) S.pop = {kind: t.kind, id: t.id, label: t.label, chat: null, pending: null, err: ""};
  S.pop.quote = quote ? quote.slice(0, 600) : (S.pop.quote || "");
  $("#askpop").hidden = false;
  askPopDraw(true);
  setTimeout(() => { const q = $("#pop-in"); if (q) q.focus(); }, 250);
}
function askPopClose(){ $("#askpop").hidden = true; }
function askPopDraw(scroll){
  const P = S.pop, card = $("#askpop-card"); if (!P || !card) return;
  const keep = $("#pop-in") ? $("#pop-in").value : (P.draft || "");
  const msgs = (P.chat && P.chat.messages) || [];
  card.innerHTML = '<div class="grab" aria-hidden="true"></div>' +
    '<div class="pop-head"><div class="pop-title"><b>問助理</b><span class="part-chip">只看' + POP_NAME[P.kind] + "</span></div>" +
    (P.chat ? '<button class="btn ghost sm" data-act="askpop-full">到助理繼續</button>' : "") +
    '<button class="icon-btn" data-act="askpop-close" aria-label="關閉"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
    '<div class="pop-thread" id="pop-thread">' +
      (msgs.length ? msgs.map(msgHTML).join("") : '<div class="pop-empty">問問看《' + esc(P.label) + "》裡的內容，回答只會引用" + POP_NAME[P.kind] + "。</div>") +
      (P.pending ? '<div class="msg user"><div class="bubble">' + esc(P.pending) + '</div></div><div class="msg ai"><div class="bubble"><span class="spinner"></span> 正在找資料、整理回答…</div></div>' : "") +
      (P.err ? '<div class="note bad">' + esc(P.err) + "</div>" : "") +
    "</div>" +
    (P.quote ? '<div class="pop-quote"><span class="pq-t">' + esc(P.quote) + '</span><button class="icon-btn" data-act="askpop-unquote" aria-label="取消引用"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' : "") +
    '<div class="pop-cmp"><textarea id="pop-in" rows="1" placeholder="' + (P.quote ? "想討論什麼？直接送出＝解釋這段" : "問" + POP_NAME[P.kind] + "…") + '" enterkeyhint="send">' + esc(keep) + "</textarea>" +
    '<button class="pop-send" data-act="askpop-send" aria-label="送出"' + (P.pending ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></div>';
  const th = $("#pop-thread"); if (th && scroll) th.scrollTop = th.scrollHeight;
  const q = $("#pop-in"); if (q){ q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 120) + "px"; }
}
async function askPopSend(){
  const P = S.pop, q = $("#pop-in"); if (!P || !q) return;
  const typed = q.value.trim(); if ((!typed && !P.quote) || P.pending) return;
  const text = P.quote ? "關於這段：「" + P.quote + "」\n" + (typed || "幫我解釋這段在說什麼，並連結我的筆記。") : typed;
  q.value = ""; P.quote = ""; P.pending = text; P.err = ""; askPopDraw(true);
  try {
    const r = await api("/chat", {json: {chat_id: P.chat && P.chat.id, message: text, kb: true, web: false, balance: "kb", pins: [{kind: P.kind, id: P.id, label: P.label}]}});
    if (!P.chat) P.chat = {id: r.chat.id, title: r.chat.title, messages: []};
    P.chat.messages.push(...r.messages);
    S.chats = null;
  } catch (e) { if (!e.relogin){ P.err = errMsg(e); P.draft = text; } }
  P.pending = null; if (S.pop === P) askPopDraw(true);
}

/* 框選文字 → 浮出「討論」→ 帶著那段話開「問助理」 */
const SELB = {text: "", t: 0};
function selBtn(){ let b = $("#sel-ask"); if (!b){ b = document.createElement("button"); b.id = "sel-ask"; b.className = "sel-ask"; b.type = "button";
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="currentColor"/></svg>討論';
  b.addEventListener("pointerdown", e => e.preventDefault());
  b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); const t = SELB.text; b.hidden = true; const sel = getSelection(); if (sel) sel.removeAllRanges(); askPopOpen(t); });
  document.body.appendChild(b); } return b; }
function selCheck(){
  const sel = getSelection(), b = selBtn();
  const txt = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
  const main = $("#main");
  if (txt.length < 2 || !popTarget() || !$("#askpop").hidden || !main || !main.contains(sel.anchorNode) || (sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest("input,textarea"))){ b.hidden = true; return; }
  SELB.text = txt;
  const r = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect();
  const w = 92, x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let y = r.bottom + 34;                       // 手機的選取把手在下面，往下讓開
  if (y > innerHeight - 140) y = Math.max(70, r.top - 96);
  b.style.left = x + "px"; b.style.top = y + "px"; b.hidden = false;
}
document.addEventListener("selectionchange", () => { clearTimeout(SELB.t); SELB.t = setTimeout(selCheck, 250); });
document.addEventListener("scroll", () => { const b = $("#sel-ask"); if (b && !b.hidden) selCheck(); }, true);
