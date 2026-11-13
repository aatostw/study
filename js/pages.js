"use strict";
/* =========================================================
   問答、書櫃、單本書、朗讀
   ========================================================= */

/* ---------- 載入資料 ---------- */
async function load(){
  try {
    if (S.sub && S.sub.type === "book") return await loadBook();
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

function renderBook(){
  const back = '<button class="btn ghost back" data-act="back">' + ICON.back + ({ask: "助理", mybooks: "我的書"}[S.view] || "書櫃") + "</button>";
  if (!S.book || S.book.book.id !== S.sub.id) return back + loading();
  const {book: b, notes, job} = S.book;
  const jobs = S.jobs || [];
  const live = jobs.find(j => j.ref_id === b.id && (j.kind === "bookfile" || j.kind === "analyze") && j.status !== "done") || (job && job.kind !== "evaluate" ? job : null);
  const evLive = jobs.find(j => j.ref_id === b.id && j.kind === "evaluate" && j.status !== "done") || (job && job.kind === "evaluate" ? job : null);
  const sh = b.shelf || "reading";
  let html = back + '<section class="card hero"><div class="row between"><div class="seg shelf-seg" role="group" aria-label="狀態">' +
    ["wish", "reading", "done"].map(v => '<button data-act="shelf-set" data-v="' + v + '" aria-pressed="' + (sh === v) + '">' + SHELF[v] + "</button>").join("") + "</div>" +
    starBtn("book", b.id, b.starred) + "</div>" +
    '<div class="hero-book"><button class="hero-cover" data-act="cover-sheet" aria-label="換封面">' + coverHTML(b) + '<span class="hc-edit">換封面</span></button>' +
    "<div><h1>" + esc(b.title) + "</h1>" + (b.author ? '<div class="sub">' + esc(b.author) + "</div>" : "") + "</div></div>" +
    '<div class="row wrap"><span class="chip">' + notes.length + " 則筆記</span>" +
    (b.file_name ? '<span class="chip">原文：' + esc(b.file_name) + "</span>" : "") + (b.isbn ? '<span class="chip en">ISBN ' + esc(b.isbn) + "</span>" : "") + "</div></section>";
  html += '<div class="row wrap"><button class="btn grow" data-act="note-new">' + ICON.plus + "記一則筆記</button>" +
    '<button class="btn soft" data-act="pick-photo">' + ICON.camera + "拍照</button></div>";
  html += '<div class="row wrap"><button class="btn soft sm" data-act="pick-book" data-id="' + b.id + '">' + ICON.upload + (b.file_name ? "換原文檔" : "上傳原文 PDF／EPUB") + "</button>" +
    '<button class="btn soft sm" data-act="analyze" data-id="' + b.id + '">' + ICON.spark + (b.analysis ? "重新分析筆記" : "AI 分析筆記") + "</button>" +
    '<button class="btn soft sm" data-act="book-export" data-id="' + b.id + '">' + ICON.down + "匯出</button>" +
    '<button class="btn ghost sm" data-act="book-edit">編輯</button></div>';
  html += uploadsHTML("book");
  if (S.busy.ocr) html += '<div class="note"><div class="row"><span class="spinner"></span>正在辨識照片裡的文字…</div></div>';
  if (live && live.status !== "done") html += jobCard(live);
  html += evalSection(b, evLive && evLive.status !== "done" ? evLive : null);
  if (b.analysis) html += analysisHTML(b.analysis);
  html += '<button class="btn soft block" data-act="ask-pin" data-kind="book" data-id="' + b.id + '" data-label="' + esc(b.title) + '">💬 問這本書（到助理，只看這本）</button>';
  html += '<section class="card"><div class="label">筆記</div>' + (notes.length ? '<div class="stack">' + notes.map(noteHTML).join("") + "</div>"
    : '<div class="empty">還沒有筆記。打字、貼上，或拍下畫線的那一頁。</div>') + "</section>";
  return html;
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
  let html = '<section class="card" data-read="AI 分析"><div class="row between no-read"><div class="label">AI 分析（你的筆記）</div>' + readBtn() + "</div>";
  if (a.summary) html += '<p style="margin:0;line-height:1.75">' + esc(a.summary) + "</p>";
  if ((a.themes || []).length) html += '<div class="stack">' + a.themes.map(t => '<div class="sec"><h3>' + esc(t.title) + '</h3><div class="small" style="line-height:1.7">' + esc(t.explain || "") + "</div></div>").join("") + "</div>";
  if ((a.connections || []).length){
    html += '<div class="label">跟其他書和影片的關聯</div><div class="stack">' + a.connections.map(c => '<div class="pt"><span class="chip green" style="flex:none">' + esc(c.theme || "") + '</span><span class="rich">' + richHTML(c.text, "analysis") + "</span></div>").join("") + "</div>";
  }
  if ((a.questions || []).length) html += '<div class="label">值得再想的問題</div><ol style="margin:0;padding-left:22px;line-height:1.8">' + a.questions.map(q => "<li>" + esc(q) + "</li>").join("") + "</ol>";
  return html + '<div class="tiny muted">' + esc(a.at || "") + "</div></section>";
}
function noteSheet(n){
  const isNew = !n.id;
  openSheet('<h2>' + (isNew ? "記一則筆記" : "編輯筆記") + "</h2>" +
    '<div class="field"><label for="n-quote">原文摘句</label><textarea class="input" id="n-quote" rows="4" placeholder="書裡的那段話">' + esc(n.quote || "") + "</textarea></div>" +
    '<div class="field"><label for="n-content">我的想法</label><textarea class="input" id="n-content" rows="4" placeholder="為什麼畫這段、讓你想到什麼">' + esc(n.content || "") + "</textarea></div>" +
    '<div class="row"><div class="field grow"><label for="n-chapter">章節</label><input class="input" id="n-chapter" value="' + esc(n.chapter || "") + '" placeholder="第三章"></div>' +
    '<div class="field" style="width:110px"><label for="n-page">頁碼</label><input class="input en" id="n-page" inputmode="numeric" value="' + esc(n.page || "") + '"></div></div>' +
    '<button class="btn block" data-act="note-save" data-id="' + (n.id || "") + '" data-source="' + esc(n.source || "typed") + '">儲存</button>');
}

/* ---------- 朗讀 ---------- */
