"use strict";
/* =========================================================
   問答、書櫃、單本書、朗讀
   ========================================================= */

/* ---------- 載入資料 ---------- */
async function load(){
  try {
    if (S.sub && (S.sub.type === "book" || S.sub.type === "eval")) return await loadBook();
    if (!S.settings) loadSettings().catch(() => {});        // 朗讀要用到語言和速度
    if (S.sub && S.sub.type === "lecture") return await loadLecture();
    if (S.sub && S.sub.type === "note") return await loadNote();
    if (S.view === "ask"){ loadBooks(true).then(renderSoon).catch(() => {}); return await loadChats(); }
    if (S.view === "books") return await loadShelf();
    if (S.view === "mybooks") return await loadBooks();
    if (S.view === "notebook") return await loadNotebook();
    if (S.view === "review") return await loadReviews();
    if (S.view === "lectures"){ loadInbox(); return await loadLectures(); }
    if (S.view === "prefs"){ loadStatus().catch(() => {}); return await loadSettings(); }
  } catch (e) { if (!e.relogin){ S.err.load = errMsg(e); render(); } }
}
async function loadAsks(){ S.asks = (await api("/asks?limit=15")).asks; S.err.load = ""; render(); }
async function loadBooks(quiet){ S.books = (await api("/books")).books; S.err.load = ""; if (!quiet) render(); }
async function loadBook(){
  const id = S.sub.id;
  const j = await api("/books/" + id);
  if (!S.sub || S.sub.id !== id) return;
  S.book = j; S.err.load = ""; render();
}
async function loadSettings(){ const j = await api("/settings"); S.settings = j; S.err.load = ""; render(); }
async function loadStatus(){ S.status = await api("/status"); render(); }

function loadErr(){ return S.err.load ? '<div class="err">' + esc(S.err.load) + '</div><button class="btn soft" data-act="reload">再試一次</button>' : ""; }
function loading(){ return loadErr() || '<div class="card flat"><div class="row"><span class="spinner"></span><span>載入中…</span></div></div>'; }

/* ---------- 問答 ---------- */
function scopeSeg(cur, act){
  const opts = [["all", "全部"], ["books", "書和筆記"], ["lectures", "影片"]];
  return '<div class="seg" role="group" aria-label="範圍">' + opts.map(o => '<button data-act="' + act + '" data-v="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + o[1] + "</button>").join("") + "</div>";
}
function answerHTML(r, ctx){
  const cited = (r.sources || []).filter(s => s.cited), rest = (r.sources || []).filter(s => !s.cited);
  return '<section class="card" data-read="助理的回答"><div class="row between top"><div class="label grow no-read">' + esc(r.question) + '</div>' +
    (r.id && ctx === "ask" ? '<button class="icon-btn" data-act="ask-del" data-id="' + r.id + '" aria-label="刪除">' + ICON.trash + "</button>" : "") + "</div>" +
    '<div class="answer rich">' + richHTML(r.answer, ctx) + "</div>" +
    '<div class="row between no-read">' + readBtn() + (r.model ? '<span class="tiny muted">' + esc(r.model) + "</span>" : "") + "</div>" +
    '<div class="no-read stack">' + (cited.length ? '<div class="label">出處</div><div class="stack">' + cited.map(s => srcRow(s, ctx)).join("") + "</div>" : "") +
    (rest.length ? '<details><summary class="small muted" style="cursor:pointer">其他找到但沒用上的資料（' + rest.length + "）</summary>" +
      '<div class="stack" style="margin-top:8px">' + rest.map(s => srcRow(s, ctx)).join("") + "</div></details>" : "") + "</div></section>";
}
function srcRow(s, ctx){
  const kind = {note: "筆記", book: "原文", lecture: "影片", web: "網路"}[s.kind] || "";
  return '<button class="src' + (s.cited ? " cited" : "") + '" data-act="src" data-ctx="' + ctx + '" data-n="' + s.n + '"><span class="n">' + s.n + '</span><span class="body"><span class="lbl">' +
    '<span class="chip ' + (s.kind === "lecture" ? "green" : s.kind === "note" ? "yellow" : s.kind === "web" ? "" : "blue") + '" style="padding:0 7px;font-size:12px;margin-right:6px">' + kind + "</span>" + esc(s.label) + (s.domain ? '<span class="tiny muted">　' + esc(s.domain) + "</span>" : "") +
    (s.level ? '<span class="rel rel-' + ({"高": "hi", "中": "mid"}[s.level] || "lo") + '">相關度 ' + s.level + "</span>" : "") +
    '</span><div class="snip clamp2">' + esc(s.text) + "</div></span></button>";
}
function sourceSheet(s){
  let acts = "";
  if (s.kind === "lecture") acts = '<button class="btn block green" data-act="open-lecture" data-id="' + s.lecture_id + '" data-t="' + (s.t0 || 0) + '">' + ICON.play + "從 " + fmtT(s.t0) + " 開始聽</button>";
  else if (s.book_id) acts = '<button class="btn block" data-act="open-book" data-id="' + s.book_id + '">打開這本書</button>';
  else if (s.kind === "web" && s.url) acts = '<a class="btn block" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">打開網頁 ↗</a>';
  openSheet('<div class="label">出處 [' + s.n + "]" + (s.domain ? "・" + esc(s.domain) : "") + "</div><h3>" + esc(s.label) + "</h3>" +
    '<div class="' + (s.kind === "note" ? "thought" : "quote") + '">' + esc(s.text) + "</div>" + acts);
}

/* ---------- 書櫃 ---------- */
function jobCard(job){
  if (!job || job.status === "done") return "";
  const name = {bookfile: "讀取原文", analyze: "AI 分析", lecture: "處理影片", resummarize: "重新摘要", evaluate: "選書評估", review: "知識複習"}[job.kind] || "處理中";
  if (job.status === "error") return '<div class="err">' + name + "失敗：" + esc(job.error) + '</div><button class="btn soft sm" data-act="job-retry" data-id="' + job.id + '">再試一次</button>';
  return '<div class="up"><div class="row between"><b class="small">' + name + '</b><span class="tiny muted">' + (job.status === "queued" ? "排隊中" : Math.round(job.progress * 100) + "%") + "</span></div>" +
    progressBar(job.progress) + '<div class="small muted">' + esc(job.step || "等前面的工作做完") + "</div></div>";
}

const CHAT_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="#4C8DF6"/><circle cx="8.5" cy="11" r="1.3" fill="#fff"/><circle cx="12" cy="11" r="1.3" fill="#fff"/><circle cx="15.5" cy="11" r="1.3" fill="#fff"/></svg>';
function renderBook(){
  const backB = '<button class="back-btn" data-act="back" aria-label="回' + ({ask: "助理", mybooks: "我的書"}[S.view] || "書櫃") + '">' + ICON.back + "</button>";
  if (!S.book || S.book.book.id !== S.sub.id) return '<div class="page-top">' + backB + "</div>" + loading();
  const {book: b, notes, job} = S.book;
  const jobs = S.jobs || [];
  const live = jobs.find(j => j.ref_id === b.id && (j.kind === "bookfile" || j.kind === "analyze") && j.status !== "done") || (job && job.kind !== "evaluate" ? job : null);
  const evLive = jobs.find(j => j.ref_id === b.id && j.kind === "evaluate" && j.status !== "done") || (job && job.kind === "evaluate" ? job : null);
  const sh = b.shelf || "reading";
  let html = '<div class="page-top">' + backB + '<span class="grow"></span>' +
    '<button class="btn soft sm" data-act="book-edit">' + ICON.edit + "編輯</button></div>" +
    '<section class="card hero"><div class="row between"><div class="seg shelf-seg" role="group" aria-label="狀態">' +
    ["wish", "reading", "done"].map(v => '<button data-act="shelf-set" data-v="' + v + '" aria-pressed="' + (sh === v) + '">' + SHELF[v] + "</button>").join("") + "</div>" +
    starBtn("book", b.id, b.starred) + "</div>" +
    '<div class="hero-book"><button class="hero-cover" data-act="cover-sheet" aria-label="換封面">' + coverHTML(b) + '<span class="hc-edit">換封面</span></button>' +
    "<div><h1>" + esc(b.title) + "</h1>" + (b.author ? '<div class="sub">' + esc(b.author) + "</div>" : "") + "</div></div>" +
    '<div class="row wrap"><span class="chip">' + notes.length + " 則筆記</span></div></section>";
  html += uploadsHTML("book");
  if (S.busy.ocr) html += '<div class="note"><div class="row"><span class="spinner"></span>正在辨識照片裡的文字…</div></div>';
  if (live && live.status !== "done") html += jobCard(live);
  html += evalSection(b, evLive && evLive.status !== "done" ? evLive : null);
  html += notesSection(b, notes);
  return html;
}
/* 筆記區：AI 分析 | 第一章 | 第二章 | ＋新增筆記 */
function noteChapters(notes){
  const order = [];
  notes.slice().reverse().forEach(n => { const c = (n.chapter || "").trim() || "未分章"; if (!order.includes(c)) order.push(c); });
  const num = c => { const m = /第?\s*([0-9０-９一二三四五六七八九十百零〇兩]+)\s*[章篇部卷回節講]/.exec(c); if (!m) return 1e9; const d = m[1].replace(/[０-９]/g, x => String.fromCharCode(x.charCodeAt(0) - 65248));
    if (/^\d+$/.test(d)) return Number(d); const D = {零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9}; let t = 0, cur = 0;
    for (const ch of d){ if (ch in D) cur = D[ch]; else if (ch === "十"){ t += (cur || 1) * 10; cur = 0; } else if (ch === "百"){ t += (cur || 1) * 100; cur = 0; } } return t + cur; };
  return order.map((c, i) => [c, i]).sort((a, b) => (a[0] === "未分章") - (b[0] === "未分章") || num(a[0]) - num(b[0]) || a[1] - b[1]).map(x => x[0]);
}
function notesSection(b, notes){
  const chs = noteChapters(notes);
  const tabs = ["ai"].concat(chs);
  if (!S.ntab || S.ntabBook !== b.id || !tabs.includes(S.ntab)){ S.ntab = b.analysis || !chs.length ? "ai" : chs[0]; S.ntabBook = b.id; }
  let html = '<section class="card notes-box"><div class="ntabs-row"><div class="ntabs" role="tablist">' +
    tabs.map(t => '<button role="tab" data-act="ntab" data-v="' + esc(t) + '" aria-pressed="' + (S.ntab === t) + '">' + (t === "ai" ? "AI 分析" : esc(t)) + "</button>").join("") + "</div>" +
    '<button class="hbtn" data-act="note-new"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8" stroke-linecap="round"/></svg>新增筆記</button></div>';
  if (S.ntab === "ai"){
    html += b.analysis ? analysisHTML(b.analysis) + '<button class="btn soft block" data-act="analyze" data-id="' + b.id + '">' + ICON.spark + "分析筆記（重新整理）</button>"
      : '<div class="empty">' + (notes.length ? "還沒有 AI 分析。按「分析筆記」，AI 會整理這本書筆記的重點、跟其他書的關聯和值得再想的問題。" : "先記幾則筆記，再讓 AI 分析。") + "</div>" +
        (notes.length ? '<button class="btn soft block" data-act="analyze" data-id="' + b.id + '">' + ICON.spark + "分析筆記</button>" : "");
  } else {
    const list = notes.filter(n => ((n.chapter || "").trim() || "未分章") === S.ntab);
    html += '<div class="stack">' + list.map(noteHTML).join("") + "</div>";
  }
  if (!notes.length && S.ntab === "ai") html += '<div class="tiny muted">打字、貼上，或拍下畫線的那一頁。</div>';
  return html + "</section>";
}
function noteHTML(n){
  const where = [n.chapter, n.page ? "p." + n.page : ""].filter(Boolean).join(" · ");
  return '<div class="note-card"><div class="row between"><div class="row wrap">' + (where ? '<span class="chip blue">' + esc(where) + "</span>" : "") +
    (n.source === "photo" ? '<span class="chip">拍照</span>' : "") + (n.indexed ? "" : '<span class="chip yellow">建索引中</span>') + "</div>" +
    '<span class="tiny muted">' + fmtDate(n.created_at) + "</span></div>" +
    (n.quote ? '<div class="quote">' + esc(n.quote) + "</div>" : "") + (n.content ? '<div class="thought">' + esc(n.content) + "</div>" : "") +
    '<div class="acts"><button class="btn ghost sm" data-act="note-edit" data-id="' + n.id + '">' + ICON.edit + '編輯</button><button class="btn ghost sm" data-act="note-del" data-id="' + n.id + '">' + ICON.trash + "刪除</button></div></div>";
}
function analysisHTML(a){
  let html = '<div class="stack ai-an" data-read="AI 分析"><div class="row between no-read"><span class="tiny muted">根據你的筆記整理</span>' + readBtn() + "</div>";
  if (a.summary) html += '<p style="margin:0;line-height:1.75">' + esc(a.summary) + "</p>";
  if ((a.themes || []).length) html += '<div class="stack">' + a.themes.map(t => '<div class="sec"><h3>' + esc(t.title) + '</h3><div class="small" style="line-height:1.7">' + esc(t.explain || "") + "</div></div>").join("") + "</div>";
  if ((a.connections || []).length){
    html += '<div class="label">跟其他書和影片的關聯</div><div class="stack">' + a.connections.map(c => '<div class="pt"><span class="chip green" style="flex:none">' + esc(c.theme || "") + '</span><span class="rich">' + richHTML(c.text, "analysis") + "</span></div>").join("") + "</div>";
  }
  if ((a.questions || []).length) html += '<div class="label">值得再想的問題</div><ol style="margin:0;padding-left:22px;line-height:1.8">' + a.questions.map(q => "<li>" + esc(q) + "</li>").join("") + "</ol>";
  return html + '<div class="tiny muted">' + esc(a.at || "") + "</div></div>";
}
function noteSheet(n){
  const isNew = !n.id;
  openSheet('<h2>' + (isNew ? "記一則筆記" : "編輯筆記") + "</h2>" +
    (isNew ? '<button class="btn soft block" data-act="pick-photo">' + ICON.camera + "拍下畫線的那一頁（自動辨識文字）</button>" : "") +
    '<div class="field"><label for="n-quote">原文摘句</label><textarea class="input" id="n-quote" rows="4" placeholder="書裡的那段話">' + esc(n.quote || "") + "</textarea></div>" +
    '<div class="field"><label for="n-content">我的想法</label><textarea class="input" id="n-content" rows="4" placeholder="為什麼畫這段、讓你想到什麼">' + esc(n.content || "") + "</textarea></div>" +
    '<div class="row"><div class="field grow"><label for="n-chapter">章節</label><input class="input" id="n-chapter" value="' + esc(n.chapter || "") + '" placeholder="第三章"></div>' +
    '<div class="field" style="width:110px"><label for="n-page">頁碼</label><input class="input en" id="n-page" inputmode="numeric" value="' + esc(n.page || "") + '"></div></div>' +
    '<button class="btn block" data-act="note-save" data-id="' + (n.id || "") + '" data-source="' + esc(n.source || "typed") + '">儲存</button>');
}

/* ---------- 朗讀 ---------- */
