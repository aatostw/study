"use strict";
/* =========================================================
   問答、書櫃、單本書、朗讀
   ========================================================= */

/* ---------- 載入資料 ---------- */
async function load(){
  try {
    if (S.sub && S.sub.type === "book") return await loadBook();
    if (S.sub && S.sub.type === "lecture") return await loadLecture();
    if (S.view === "ask"){ if (!S.books) loadBooks(true); return await loadAsks(); }
    if (S.view === "books") return await loadBooks();
    if (S.view === "lectures"){ loadInbox(); return await loadLectures(); }
    if (S.view === "tts" || S.view === "prefs"){ if (S.view === "prefs") loadStatus().catch(() => {}); return await loadSettings(); }
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
  const opts = [["all", "全部"], ["books", "書和筆記"], ["lectures", "課程"]];
  return '<div class="seg" role="group" aria-label="範圍">' + opts.map(o => '<button data-act="' + act + '" data-v="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + o[1] + "</button>").join("") + "</div>";
}
function renderAsk(){
  const a = S.ask;
  let html = '<section class="card"><div class="label">問你讀過的書、上過的課</div>' +
    '<textarea class="input" id="ask-q" rows="3" placeholder="例如：老子和莊子對「無為」的看法有什麼不同？" data-draft="ask">' + esc(a.draft) + "</textarea>" +
    scopeSeg(a.scope, "ask-scope") +
    '<button class="btn block" data-act="ask"' + (a.busy ? " disabled" : "") + ">" + (a.busy ? '<span class="spinner"></span>正在翻你的筆記…' : "問問看") + "</button>" +
    (S.err.ask ? '<div class="err">' + esc(S.err.ask) + "</div>" : "") + "</section>";
  if (a.cur) html += answerHTML(a.cur, "ask");
  html += '<section class="card"><div class="label">最近問過</div>';
  if (!S.asks) html += S.err.load ? loadErr() : '<div class="row muted"><span class="spinner"></span>載入中…</div>';
  else if (!S.asks.length) html += '<div class="empty">還沒問過問題。先到「書櫃」記筆記，或到「課程」上傳一堂課，再回來問。</div>';
  else html += '<div class="stack">' + S.asks.map(x =>
    '<button class="list-row" data-act="ask-open" data-id="' + x.id + '"><span class="t"><b>' + esc(x.question) + '</b><span class="sub">' + fmtDate(x.created_at) + " · " + ({all: "全部", books: "書和筆記", lectures: "課程"}[x.scope] || "指定範圍") + '</span></span><span class="chev">›</span></button>').join("") + "</div>";
  return html + "</section>";
}
function answerHTML(r, ctx){
  const cited = (r.sources || []).filter(s => s.cited), rest = (r.sources || []).filter(s => !s.cited);
  return '<section class="card"><div class="row between top"><div class="label grow">' + esc(r.question) + '</div>' +
    (r.id && ctx === "ask" ? '<button class="icon-btn" data-act="ask-del" data-id="' + r.id + '" aria-label="刪除">' + ICON.trash + "</button>" : "") + "</div>" +
    '<div class="answer rich">' + richHTML(r.answer, ctx) + "</div>" +
    (r.model ? '<div class="tiny muted">' + esc(r.model) + "</div>" : "") +
    (cited.length ? '<div class="label">出處</div><div class="stack">' + cited.map(s => srcRow(s, ctx)).join("") + "</div>" : "") +
    (rest.length ? '<details><summary class="small muted" style="cursor:pointer">其他找到但沒用上的資料（' + rest.length + "）</summary>" +
      '<div class="stack" style="margin-top:8px">' + rest.map(s => srcRow(s, ctx)).join("") + "</div></details>" : "") + "</section>";
}
function srcRow(s, ctx){
  const kind = {note: "筆記", book: "原文", lecture: "課程"}[s.kind] || "";
  return '<button class="src' + (s.cited ? " cited" : "") + '" data-act="src" data-ctx="' + ctx + '" data-n="' + s.n + '"><span class="n">' + s.n + '</span><span class="body"><span class="lbl">' +
    '<span class="chip ' + (s.kind === "lecture" ? "green" : s.kind === "note" ? "yellow" : "blue") + '" style="padding:0 7px;font-size:12px;margin-right:6px">' + kind + "</span>" + esc(s.label) +
    '</span><div class="snip clamp2">' + esc(s.text) + "</div></span></button>";
}
function sourceSheet(s){
  let acts = "";
  if (s.kind === "lecture") acts = '<button class="btn block green" data-act="open-lecture" data-id="' + s.lecture_id + '" data-t="' + (s.t0 || 0) + '">' + ICON.play + "從 " + fmtT(s.t0) + " 開始聽</button>";
  else if (s.book_id) acts = '<button class="btn block" data-act="open-book" data-id="' + s.book_id + '">打開這本書</button>';
  openSheet('<div class="label">出處 [' + s.n + "]</div><h3>" + esc(s.label) + "</h3>" +
    '<div class="' + (s.kind === "note" ? "thought" : "quote") + '">' + esc(s.text) + "</div>" + acts);
}

/* ---------- 書櫃 ---------- */
function renderBooks(){
  if (S.shelf === "wish") return renderWishList();
  let html = shelfSeg() + '<div class="row"><button class="btn grow" data-act="book-new">' + ICON.plus + "新增一本書</button>" +
    '<button class="btn soft" data-act="pick-book" data-id="">' + ICON.upload + "上傳 PDF／EPUB</button></div>" + uploadsHTML("book");
  if (!S.books) return html + loading();
  const all = S.books;
  const mine = all.filter(b => (b.shelf || "read") === "read");
  if (!mine.length) return html + '<section class="card"><div class="empty">書櫃還是空的。<br>新增一本書開始記筆記，或直接上傳 PDF／EPUB，原文也會進知識庫。</div></section>';
  const cols = ["", "green", "yellow"];
  html += '<section class="card"><div class="label">我的書（' + mine.length + "）</div><div class=\"stack\">" + mine.map((b, i) => {
    const bits = [b.notes + " 則筆記"];
    if (b.file_name) bits.push(b.status === "ready" ? (b.pages ? "原文 " + b.pages + (b.file_name.toLowerCase().endsWith(".epub") ? " 章" : " 頁") : "原文") : b.status === "error" ? "原文讀取失敗" : "原文處理中");
    if (b.analyzed) bits.push("已分析");
    return '<button class="list-row" data-act="open-book" data-id="' + b.id + '"><span class="ic ' + cols[i % 3] + '">' + esc((b.title || "?").slice(0, 1)) + '</span><span class="t"><b>' + esc(b.title) + '</b><span class="sub">' + esc(b.author ? b.author + " · " : "") + bits.join(" · ") + '</span></span><span class="chev">›</span></button>';
  }).join("") + "</div></section>";
  return html;
}

function jobCard(job){
  if (!job || job.status === "done") return "";
  const name = {bookfile: "讀取原文", analyze: "AI 分析", lecture: "處理課程", resummarize: "重新摘要", evaluate: "選書評估"}[job.kind] || "處理中";
  if (job.status === "error") return '<div class="err">' + name + "失敗：" + esc(job.error) + '</div><button class="btn soft sm" data-act="job-retry" data-id="' + job.id + '">再試一次</button>';
  return '<div class="up"><div class="row between"><b class="small">' + name + '</b><span class="tiny muted">' + (job.status === "queued" ? "排隊中" : Math.round(job.progress * 100) + "%") + "</span></div>" +
    progressBar(job.progress) + '<div class="small muted">' + esc(job.step || "等前面的工作做完") + "</div></div>";
}

function renderBook(){
  const back = '<button class="btn ghost back" data-act="back">' + ICON.back + "書櫃</button>";
  if (!S.book || S.book.book.id !== S.sub.id) return back + loading();
  if (S.book.book.shelf === "wish") return renderWishBook();
  const {book: b, notes, job} = S.book;
  const live = (S.jobs || []).find(j => j.ref_id === b.id && (j.kind === "bookfile" || j.kind === "analyze") && j.status !== "done") || job;
  let html = back + '<section class="card hero"><div class="label">書</div><h1>' + esc(b.title) + "</h1>" +
    (b.author ? '<div class="sub">' + esc(b.author) + "</div>" : "") +
    '<div class="row wrap"><span class="chip">' + notes.length + " 則筆記</span>" +
    (b.file_name ? '<span class="chip">原文：' + esc(b.file_name) + "</span>" : "") + "</div></section>";
  html += '<div class="row wrap"><button class="btn grow" data-act="note-new">' + ICON.plus + "記一則筆記</button>" +
    '<button class="btn soft" data-act="pick-photo">' + ICON.camera + "拍照</button></div>";
  html += '<div class="row wrap"><button class="btn soft sm" data-act="pick-book" data-id="' + b.id + '">' + ICON.upload + (b.file_name ? "換原文檔" : "上傳原文 PDF／EPUB") + "</button>" +
    '<button class="btn soft sm" data-act="analyze" data-id="' + b.id + '">' + ICON.spark + (b.analysis ? "重新分析" : "AI 分析") + "</button>" +
    '<button class="btn soft sm" data-act="book-export" data-id="' + b.id + '">' + ICON.down + "匯出</button>" +
    '<button class="btn ghost sm" data-act="book-edit">編輯</button></div>';
  html += uploadsHTML("book");
  if (S.busy.ocr) html += '<div class="note"><div class="row"><span class="spinner"></span>正在辨識照片裡的文字…</div></div>';
  if (live && live.status !== "done") html += jobCard(live);
  if (b.analysis) html += analysisHTML(b.analysis);
  html += '<section class="card"><div class="label">只問這本書</div><div class="row"><input class="input grow" id="book-q" placeholder="這本書怎麼談…" data-draft="bookq" value="' + esc(S.ask.bookDraft || "") + '">' +
    '<button class="btn" data-act="ask-book"' + (S.busy.askBook ? " disabled" : "") + ">" + (S.busy.askBook ? '<span class="spinner"></span>' : "問") + "</button></div>" +
    (S.err.askBook ? '<div class="err">' + esc(S.err.askBook) + "</div>" : "") + "</section>";
  if (S.ask.book && S.ask.book.bookId === b.id) html += answerHTML(S.ask.book, "book");
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
  let html = '<section class="card"><div class="row between"><div class="label">AI 分析</div><span class="tiny muted">' + esc(a.at || "") + "</span></div>";
  if (a.summary) html += '<p style="margin:0;line-height:1.75">' + esc(a.summary) + "</p>";
  if ((a.themes || []).length) html += '<div class="stack">' + a.themes.map(t => '<div class="sec"><h3>' + esc(t.title) + '</h3><div class="small" style="line-height:1.7">' + esc(t.explain || "") + "</div></div>").join("") + "</div>";
  if ((a.connections || []).length){
    html += '<div class="label">跟其他書和課程的關聯</div><div class="stack">' + a.connections.map(c => '<div class="pt"><span class="chip green" style="flex:none">' + esc(c.theme || "") + '</span><span class="rich">' + richHTML(c.text, "analysis") + "</span></div>").join("") + "</div>";
  }
  if ((a.questions || []).length) html += '<div class="label">值得再想的問題</div><ol style="margin:0;padding-left:22px;line-height:1.8">' + a.questions.map(q => "<li>" + esc(q) + "</li>").join("") + "</ol>";
  return html + "</section>";
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
function renderTts(){
  const t = S.tts, pr = (S.settings && S.settings.prefs) || {};
  if (t.lang == null) t.lang = pr.tts_lang || "zh";
  if (t.speed == null) t.speed = pr.tts_speed || 1.0;
  const ready = t.parts.filter(p => t.ready[p]).length;
  let html = '<section class="card"><div class="label">輸入文字，用你的 GPT-SoVITS 聲音唸出來</div>' +
    '<textarea class="input" id="tts-text" rows="7" placeholder="貼上文章、筆記或課程摘要…" data-draft="tts">' + esc(t.text) + "</textarea>" +
    '<div class="seg" role="group" aria-label="語言">' + [["zh", "中英混合"], ["en", "英文"], ["auto", "自動"]].map(o => '<button data-act="tts-lang" data-v="' + o[0] + '" aria-pressed="' + (t.lang === o[0]) + '">' + o[1] + "</button>").join("") + "</div>" +
    '<div class="field"><label for="tts-speed">速度：<span id="tts-speed-v">' + Number(t.speed).toFixed(1) + '×</span></label><input type="range" id="tts-speed" min="0.6" max="1.6" step="0.1" value="' + t.speed + '" data-act-change="tts-speed"></div>' +
    '<div class="row"><button class="btn grow" data-act="tts-go"' + (S.busy.tts ? " disabled" : "") + ">" + (t.playing ? ICON.stop + "停止" : ICON.play + "開始朗讀") + "</button>" +
    (t.parts.length ? '<button class="btn soft" data-act="tts-download"' + (S.busy.ttsDl ? " disabled" : "") + ">" + (S.busy.ttsDl ? '<span class="spinner"></span>' : ICON.down) + "下載</button>" : "") + "</div>" +
    (S.err.tts ? '<div class="err">' + esc(S.err.tts) + "</div>" : "") + "</section>";
  if (t.parts.length){
    html += '<section class="card"><div class="row between"><div class="label">分段（點一段從那裡開始）</div><span class="tiny muted">準備好 ' + ready + " / " + t.parts.length + "</span></div>" +
      '<div class="stack">' + t.parts.map((p, i) => { const now = i === t.i && t.playing; return '<button class="part' + (now ? " playing" : "") + (t.ready[p] ? " ok" : "") + '" data-act="tts-from" data-i="' + i + '"><span class="st">' + (now ? (t.ready[p] ? "▶" : '<span class="spinner" style="width:14px;height:14px"></span>') : t.ready[p] ? "✓" : i + 1) + '</span><span class="grow">' + esc(p) + "</span></button>"; }).join("") + "</div></section>";
  }
  return html;
}
