"use strict";
/* =========================================================
   助理：對話。問知識庫（看得懂追問）、評估一本書（對話裡出現評估卡）
   ========================================================= */
S.chat = null;            // {id, title, messages:[]}
S.chats = null;           // 對話紀錄
S.chatPending = null;     // 送出中的那句話

async function loadChats(){ S.chats = (await api("/chats")).chats; renderSoon(); }
async function openChat(id){
  const j = await api("/chats/" + id);
  S.chat = {id: j.chat.id, title: j.chat.title, messages: j.messages};
  S.chatScroll = true; render();
}

function renderAssist(){
  if (S.assist === "wish") return renderWishList();
  const nWish = (S.books || []).filter(b => b.shelf === "wish").length;
  let html = '<div class="assist-top"><div class="chips">' +
    '<button class="chip-btn" data-act="ask-focus">💬 問我的筆記</button>' +
    '<button class="chip-btn" data-act="wish-new">📖 評估一本書</button>' +
    '<button class="chip-btn" data-act="assist" data-v="wish">📚 想讀清單' + (nWish ? "（" + nWish + "）" : "") + "</button></div>" +
    "</div></div>" +
    '<div class="row between assist-bar"><span class="small muted">' + esc(S.chat ? S.chat.title : "新對話") + "</span>" +
    '<span class="row"><button class="btn ghost sm" data-act="chat-history">🕘 紀錄</button>' +
    (S.chat ? '<button class="btn ghost sm" data-act="chat-new">' + ICON.plus + "新對話</button>" : "") + "</span></div>";

  const msgs = (S.chat && S.chat.messages) || [];
  if (!msgs.length && !S.chatPending){
    html += '<section class="card hero"><div class="label">助理</div><h1>想問什麼？</h1><div class="sub">我會翻你的書、筆記、課程回答，每句都標出處；也可以叫我評估一本書。</div></section>' +
      '<div class="stack">' + ["老子和莊子對「無為」的看法有什麼不同？", "這週上課講的重點是什麼？", "幫我評估《原子習慣》"].map(q =>
        '<button class="list-row" data-act="chat-example" data-q="' + esc(q) + '"><span class="t"><b>' + esc(q) + '</b></span><span class="chev">›</span></button>').join("") + "</div>";
  } else {
    html += '<div class="thread">' + msgs.map(msgHTML).join("");
    if (S.chatPending) html += '<div class="msg user"><div class="bubble">' + esc(S.chatPending) + "</div></div>" +
      '<div class="msg ai"><div class="bubble typing"><span></span><span></span><span></span></div><div class="tiny muted">正在翻你的筆記…</div></div>';
    html += "</div>";
  }
  if (S.err.chat) html += '<div class="err">' + esc(S.err.chat) + "</div>";
  html += '<div class="composer"><div class="scope-mini">' + [["all", "全部"], ["books", "書和筆記"], ["lectures", "課程"]].map(o =>
      '<button data-act="ask-scope" data-v="' + o[0] + '" aria-pressed="' + (S.ask.scope === o[0]) + '">' + o[1] + "</button>").join("") + "</div>" +
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
