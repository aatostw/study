"use strict";
/* =========================================================
   書櫃（一體化）：新增學習、匯入、收藏、我的書、記事本、課程
   記事本：不屬於任何書的獨立筆記，可以朗讀
   朗讀：任何 AI 內容旁的「朗讀」鍵＋底部小播放條
   ========================================================= */
const TAB_OF = {books: "books", mybooks: "books", notebook: "books", lectures: "books", review: "review", ask: "ask", prefs: "prefs"};

async function loadNotebook(quiet){ S.notes = (await api("/notes")).notes; S.err.load = ""; if (!quiet) render(); }
async function loadNote(){
  const id = S.sub.id, j = await api("/notes/" + id);
  if (!S.sub || S.sub.id !== id) return;
  S.note = j.note; S.err.load = ""; render();
}
async function loadShelf(){
  await Promise.all([loadBooks(true), loadNotebook(true), loadLectures().catch(() => {})]);
  render();
}

function starBtn(kind, id, on){
  return '<button class="star' + (on ? " on" : "") + '" data-act="star" data-kind="' + kind + '" data-id="' + id + '" data-on="' + (on ? 1 : 0) + '" aria-label="' + (on ? "取消收藏" : "收藏") + '">' + (on ? "★" : "☆") + "</button>";
}
function backBtn(label, view){ return '<button class="btn ghost back" data-act="go" data-v="' + view + '">' + ICON.back + esc(label) + "</button>"; }

/* ---------- 列表的一列 ---------- */
const COLS = ["", "green", "yellow"];
function bookRow(b, i){
  const bits = [b.notes + " 則筆記"];
  if (b.file_name) bits.push(b.status === "ready" ? (b.pages ? "原文 " + b.pages + (b.file_name.toLowerCase().endsWith(".epub") ? " 章" : " 頁") : "原文") : b.status === "error" ? "原文讀取失敗" : "原文處理中");
  if (b.analyzed) bits.push("已分析");
  const busy = b.eval_status === "queued" || b.eval_status === "running";
  if (busy) bits.unshift("評估中…");
  else if (b.verdict && VERDICT[b.verdict]) bits.unshift((LIGHT[b.light] ? LIGHT[b.light][2] + " " : "") + VERDICT[b.verdict][0]);
  const sh = b.shelf || "reading";
  return '<button class="list-row" data-act="open-book" data-id="' + b.id + '"><span class="ic ' + COLS[i % 3] + '">' + esc((b.title || "?").slice(0, 1)) + '</span><span class="t"><b>' + (b.starred ? "★ " : "") + esc(b.title) +
    '</b><span class="sub">' + esc(b.author ? b.author + " · " : "") + bits.join(" · ") + "</span></span>" +
    (sh !== "reading" ? '<span class="chip ' + (sh === "wish" ? "yellow" : "green") + '">' + SHELF[sh] + "</span>" : '<span class="chev">›</span>') + "</button>";
}
function noteRow(n){
  return '<button class="list-row" data-act="open-note" data-id="' + n.id + '"><span class="ic yellow">' + ICON.edit.replace("<svg", '<svg width="20" height="20"') + '</span><span class="t"><b>' + (n.starred ? "★ " : "") + esc(n.title || "（無標題）") +
    '</b><span class="sub">' + (n.no_index ? "🔒 不進知識庫 · " : "") + fmtDate(n.updated_at) + (n.preview ? " · " + esc(n.preview.replace(/\s+/g, " ").slice(0, 60)) : "") + '</span></span><span class="chev">›</span></button>';
}
function lectureRow(l){
  const st = STATUS[l.status] || ["", ""];
  return '<button class="list-row" data-act="open-lecture" data-id="' + l.id + '"><span class="ic green">' + ICON.play.replace("<svg", '<svg width="18" height="18"') + '</span><span class="t"><b>' + (l.starred ? "★ " : "") + esc(l.title) +
    '</b><span class="sub">' + esc(l.course ? l.course + " · " : "") + fmtDate(l.created_at) + (l.duration ? " · " + fmtDur(l.duration) : "") + "</span></span>" +
    (l.status !== "ready" ? '<span class="chip ' + st[1] + '">' + st[0] + "</span>" : '<span class="chev">›</span>') + "</button>";
}

/* ---------- 書櫃首頁 ---------- */
function shelfSection(title, view, rows, total, empty){
  return '<section class="card"><div class="row between"><div class="label">' + title + (total ? "（" + total + "）" : "") + "</div>" +
    (total > rows.length ? '<button class="btn ghost sm" data-act="go" data-v="' + view + '">全部 ›</button>' : "") + "</div>" +
    (rows.length ? '<div class="stack">' + rows.join("") + "</div>" : '<div class="empty small">' + empty + "</div>") + "</section>";
}
function renderShelf(){
  let html = '<div class="row"><button class="btn grow" data-act="add-sheet">' + ICON.plus + '新增學習</button><button class="btn soft" data-act="import-sheet">' + ICON.upload + "匯入</button></div>" +
    uploadsHTML("book") + uploadsHTML("lecture");
  const active = (S.jobs || []).filter(j => j.status === "queued" || j.status === "running");
  if (active.length) html += '<section class="card"><div class="label">電腦正在處理</div><div class="stack">' + active.map(j => '<div class="stack" style="gap:4px"><b class="small">' + esc(j.title) + "</b>" + jobCard(j) + "</div>").join("") + "</div></section>";
  if (!S.books || !S.notes || !S.lectures) return html + loading();
  const books = S.books;
  const stars = books.filter(b => b.starred).map(bookRow).concat(S.notes.filter(n => n.starred).map(noteRow), S.lectures.filter(l => l.starred).map(lectureRow));
  if (stars.length) html += '<section class="card starred"><div class="label">★ 收藏</div><div class="stack">' + stars.join("") + "</div></section>";
  html += shelfSection("我的書", "mybooks", books.slice(0, 4).map(bookRow), books.length, "還沒有書。按「新增學習」→ 書，拍封面或條碼就能認書。");
  html += shelfSection("記事本", "notebook", S.notes.slice(0, 4).map(noteRow), S.notes.length, "隨手記、想法、要朗讀的文字都可以放這裡。");
  html += shelfSection("課程", "lectures", S.lectures.slice(0, 4).map(lectureRow), S.lectures.length, "還沒有課程。按「新增學習」→ 課程，上傳錄音或影片。");
  return html;
}

/* ---------- 我的書（全部）---------- */
function renderMyBooks(){
  let html = backBtn("書櫃", "books") + '<div class="row"><button class="btn grow" data-act="book-new">' + ICON.plus + "新增一本書</button>" +
    '<button class="btn soft" data-act="pick-book" data-id="">' + ICON.upload + "上傳 PDF／EPUB</button></div>" + uploadsHTML("book");
  if (!S.books) return html + loading();
  const f = S.shelfFilter || "all";
  const n = v => S.books.filter(b => (b.shelf || "reading") === v).length;
  html += '<div class="seg" role="group" aria-label="篩選">' + [["all", "全部", S.books.length], ["wish", "想讀", n("wish")], ["reading", "在讀", n("reading")], ["done", "讀完", n("done")]].map(o =>
    '<button data-act="shelf-filter" data-v="' + o[0] + '" aria-pressed="' + (f === o[0]) + '">' + o[1] + (o[2] ? " " + o[2] : "") + "</button>").join("") + "</div>";
  const mine = f === "all" ? S.books : S.books.filter(b => (b.shelf || "reading") === f);
  if (!mine.length) return html + '<section class="card"><div class="empty">' + (f === "all" ? "書櫃還是空的。<br>新增一本書：拍封面或條碼就能認書，可以先評估值不值得讀，也可以直接記筆記。" : "這裡還沒有書。") + "</div></section>";
  return html + '<section class="card"><div class="stack">' + mine.map(bookRow).join("") + "</div></section>";
}

/* ---------- 記事本 ---------- */
function renderNotebook(){
  let html = backBtn("書櫃", "books") + '<button class="btn block" data-act="free-new">' + ICON.plus + "寫一則筆記</button>";
  if (!S.notes) return html + loading();
  if (!S.notes.length) return html + '<section class="card"><div class="empty">記事本是空的。<br>寫下想法、貼一段文章，按「朗讀」就能用你的聲音聽。</div></section>';
  return html + '<section class="card"><div class="label">記事本（' + S.notes.length + '）</div><div class="stack">' + S.notes.map(noteRow).join("") + "</div></section>";
}
function renderNote(){
  const back = backBtn(S.view === "books" ? "書櫃" : "記事本", S.view === "books" ? "books" : "notebook");
  if (!S.note || S.note.id !== S.sub.id) return back + loading();
  const n = S.note;
  return back + '<section class="card" data-read="' + esc(n.title || "筆記") + '"><div class="row between top"><h2 class="grow" style="margin:0">' + esc(n.title || "（無標題）") + "</h2>" + starBtn("note", n.id, n.starred) + "</div>" +
    '<div class="tiny muted no-read">' + fmtDate(n.updated_at) + (n.no_index ? " · 不放進知識庫" : n.indexed ? "" : " · 建索引中") + "</div>" +
    '<div class="thought">' + esc(n.content) + "</div>" +
    '<div class="row wrap no-read">' + readBtn() + '<button class="btn soft sm" data-act="ask-pin" data-kind="note" data-id="' + n.id + '" data-label="' + esc(n.title || "筆記") + '">💬 問這則</button><button class="btn soft sm" data-act="free-edit">' + ICON.edit + '編輯</button><button class="btn ghost sm" data-act="free-del" style="color:var(--danger)">' + ICON.trash + "刪除</button></div>" +
    '<label class="check no-read"><input type="checkbox" id="note-noindex"' + (n.no_index ? " checked" : "") + '><span><b>不放進知識庫</b><span class="small muted">助理和知識複習都不會用到這則，例如測驗題、草稿。</span></span></label></section>';
}
function freeNoteSheet(n){
  n = n || {};
  openSheet("<h2>" + (n.id ? "編輯筆記" : "寫一則筆記") + "</h2>" +
    '<div class="field"><label for="f-title">標題</label><input class="input" id="f-title" value="' + esc(n.title || "") + '" placeholder="例如：讀書會的想法"></div>' +
    '<div class="field"><label for="f-content">內容</label><textarea class="input" id="f-content" rows="12" placeholder="想法、摘錄、要朗讀的文章…">' + esc(n.content || "") + "</textarea></div>" +
    '<button class="btn block" data-act="free-save" data-id="' + (n.id || "") + '">儲存</button>');
}

/* ---------- 新增學習、匯入 ---------- */
function addSheet(){
  openSheet('<h2>新增學習</h2><div class="stack">' +
    '<button class="list-row" data-act="book-new"><span class="ic">📘</span><span class="t"><b>書</b><span class="sub">開始讀一本書，記筆記、拍畫線段落</span></span><span class="chev">›</span></button>' +
    '<button class="list-row" data-act="free-new"><span class="ic yellow">📝</span><span class="t"><b>筆記</b><span class="sub">記事本：獨立的想法、摘錄，可以朗讀</span></span><span class="chev">›</span></button>' +
    '<button class="list-row" data-act="pick-lecture"><span class="ic green">🎓</span><span class="t"><b>課程</b><span class="sub">上傳一堂課的錄音或影片</span></span><span class="chev">›</span></button>' +
    "</div>");
}
async function importSheet(){
  const draw = () => {
    const inbox = S.inbox && S.inbox.files ? S.inbox.files : [];
    openSheet('<h2>匯入</h2><div class="stack">' +
      '<button class="list-row" data-act="pick-book" data-id=""><span class="ic">📄</span><span class="t"><b>PDF／EPUB</b><span class="sub">整本書的原文，會進知識庫</span></span><span class="chev">›</span></button>' +
      '<button class="list-row" data-act="pick-lecture"><span class="ic green">🎬</span><span class="t"><b>錄音／影片</b><span class="sub">從手機選檔案，傳到電腦處理</span></span><span class="chev">›</span></button></div>' +
      '<div class="label">電腦「待處理」資料夾</div>' +
      (!S.inbox ? '<div class="row muted small"><span class="spinner"></span>讀取中…</div>'
        : !inbox.length ? '<div class="small muted">' + esc(S.inbox.error || "目前是空的。大檔案可以直接放進電腦的 D:\\study-server\\待處理，再回來這裡匯入。") + "</div>"
        : '<div class="stack">' + inbox.map(f => '<div class="list-row"><span class="ic yellow">' + ICON.folder.replace("<svg", '<svg width="22" height="22"') + '</span><span class="t"><b>' + esc(f.name) + '</b><span class="sub">' + fmtSize(f.size) + '</span></span>' +
            (f.kind === "lecture" ? '<button class="btn sm" data-act="inbox-import" data-name="' + esc(f.name) + '">匯入</button>' : '<span class="tiny muted">不支援</span>') + "</div>").join("") + "</div>"));
  };
  S.inbox = null; draw();
  try { S.inbox = await api("/inbox"); } catch (e) { S.inbox = {files: [], error: errMsg(e)}; }
  if (S.sheet) draw();
}

/* ---------- 知識複習：每週日早上 7 點自動，也可以隨時「產生本週至今」 ---------- */
async function loadReviews(){
  S.reviews = (await api("/reviews")).reviews; S.err.load = "";
  if (!S.reviewId && S.reviews.length) S.reviewId = S.reviews[0].id;
  if (S.reviewId) await loadReview(S.reviewId, true);
  render();
}
async function loadReview(id, quiet){
  const j = await api("/reviews/" + id);
  S.review = j.review; S.reviewId = id;
  if (!quiet) render();
}
function rvCite(text){
  return esc(text || "").replace(/\[(\d{1,2})\]/g, (m, n) => '<button class="cite" data-act="rv-src" data-n="' + n + '">' + n + "</button>");
}
function renderReview(){
  let html = '<section class="card hero"><div class="label">知識複習</div><h1>' + (S.review && S.review.content && S.review.content.label ? esc(S.review.content.label) : "這一週") + "</h1>" +
    '<div class="sub">每週日早上 7 點自動整理週一到週六；平常也可以先看本週至今。</div>' +
    '<div class="row wrap"><button class="btn soft sm" data-act="rv-make"' + (S.busy.rv ? " disabled" : "") + ">" + ICON.spark + "產生本週至今</button>" +
    ((S.reviews || []).length > 1 ? '<button class="btn ghost sm" data-act="rv-list" style="color:#fff">以前的複習 ›</button>' : "") + "</div></section>";
  if (!S.reviews) return html + loading();
  const live = (S.jobs || []).find(j => j.kind === "review" && j.status !== "done");
  if (live) html += jobCard(live);
  const r = S.review;
  if (!r) return html + (live ? "" : '<section class="card"><div class="empty">還沒有複習。按「產生本週至今」先看看這週的整理。</div></section>');
  const c = r.content || {};
  if (r.status === "empty") return html + '<section class="card"><div class="empty">這一週（' + esc(c.label || "") + "）還沒有新的筆記、書或課程，沒有東西可以複習。</div></section>";
  if (r.status === "error" && !c.headline) return html + '<div class="err">這篇複習沒有做好，再按一次「產生本週至今」。</div>';
  if (!c.headline) return html;
  const cnt = c.counts || {};
  html += '<section class="card" data-read="知識複習"><div class="row between no-read"><div class="label">本週主軸</div>' +
    '<button class="btn soft sm" data-act="rv-read">' + ICON.speaker + "朗讀整篇</button></div>" +
    '<p class="rv-head">' + esc(c.headline) + "</p>" +
    '<div class="row wrap no-read">' + [["book", "書"], ["note", "記事本"], ["lecture", "課程"]].filter(k => cnt[k[0]]).map(k => '<span class="chip">' + k[1] + " " + cnt[k[0]] + " 則</span>").join("") +
    (cnt.chat ? '<span class="chip">問過助理</span>' : "") + "</div></section>";
  if ((c.highlights || []).length) html += '<section class="card"><div class="label">本週重點</div><div class="stack">' + c.highlights.map((h, i) =>
    '<div class="rv-item"><span class="rv-n">' + (i + 1) + '</span><div><b>' + esc(h.title) + '</b><div class="rv-text">' + rvCite(h.text) + "</div></div></div>").join("") + "</div></section>";
  if ((c.connections || []).length) html += '<section class="card"><div class="label">跨內容的關聯</div><div class="stack">' + c.connections.map(x =>
    '<div class="pt"><span>🔗</span><span class="rv-text">' + rvCite(x.text) + "</span></div>").join("") + "</div></section>";
  if ((c.questions || []).length) html += '<section class="card"><div class="label">可以再想的問題</div><div class="small muted">點一題，到助理接著聊。</div><div class="stack">' + c.questions.map((q, i) =>
    '<button class="list-row rv-q" data-act="rv-ask" data-i="' + i + '"><span class="ic">💭</span><span class="t"><b>' + esc(q.q) + '</b><span class="sub">' + esc(q.why || "") + '</span></span><span class="chev">›</span></button>').join("") + "</div></section>";
  html += '<section class="card flat"><details><summary class="adv-sum"><b>這週的資料（' + (c.sources || []).length + "）</b></summary>" +
    '<div class="stack" style="margin-top:10px">' + (c.sources || []).map(s => '<button class="src" data-act="rv-src" data-n="' + s.n + '"><span class="n">' + s.n + '</span><span class="body"><span class="lbl">' + esc(s.label) + "</span></span></button>").join("") + "</div></details>" +
    '<div class="tiny muted">' + (r.auto ? "週日自動產生" : "手動產生") + " · " + esc(r.model || "") + "</div></section>";
  return html;
}
function reviewListSheet(){
  openSheet("<h2>以前的複習</h2><div class=\"stack\">" + (S.reviews || []).map(r => {
    const d = new Date(r.week_start + "T00:00:00");
    return '<button class="list-row" data-act="rv-open" data-id="' + r.id + '"><span class="t"><b>' + (d.getMonth() + 1) + "/" + d.getDate() + " 那一週" + (r.id === S.reviewId ? "（正在看）" : "") +
      '</b><span class="sub">' + esc(r.headline || {queued: "產生中…", empty: "那週沒有資料", error: "沒有做好"}[r.status] || "") + '</span></span><span class="chev">›</span></button>';
  }).join("") + "</div>");
}

/* =========================================================
   朗讀：任何地方的「朗讀」鍵 → 底部小播放條
   ========================================================= */
function readBtn(label){ return '<button class="btn soft sm" data-act="read">' + ICON.speaker + (label || "朗讀") + "</button>"; }

/* 拿畫面上那一塊的文字：去掉按鈕、引用標號、標了 no-read 的部分 */
function readableText(box){
  const c = box.cloneNode(true);
  c.querySelectorAll("button, .cite, .no-read, summary, details:not([open]), .tiny, input, textarea, audio").forEach(x => x.remove());
  c.style.cssText = "position:fixed;left:-9999px;top:0;width:600px;opacity:0;pointer-events:none";
  document.body.appendChild(c);
  const txt = c.innerText;
  c.remove();
  return txt.replace(/\[(\d{1,2}|K\d{1,2}|U)\]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function readAloud(text, title){
  const t = S.tts, pr = (S.settings && S.settings.prefs) || {};
  if (!text.trim()) return toast("沒有可以唸的文字");
  TTSP.stop(); TTSP.reset();
  t.text = text; t.title = title || "朗讀"; t.i = 0; t.parts = []; S.err.tts = "";
  if (t.lang == null) t.lang = pr.tts_lang || "zh";
  if (t.speed == null) t.speed = pr.tts_speed || 1.0;
  t.loading = true; renderMini();
  try { t.parts = (await api("/tts/split", {json: {text}})).parts; t.splitOf = text; }
  catch (e) { t.loading = false; S.err.tts = errMsg(e); renderMini(); return toast(errMsg(e)); }
  t.loading = false;
  TTSP.play(0);
}

const SPEEDS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.4];
function renderMini(){
  const box = $("#mini"), t = S.tts;
  if (!box) return;
  if (!S.token || (!t.parts.length && !t.loading)){ box.hidden = true; return; }
  box.hidden = false;
  const waiting = t.loading || (t.playing && !TTSP.has(t.i));
  const n = t.parts.length;
  box.innerHTML = '<div class="mini-prog" style="width:' + (n ? Math.round((t.i + (t.playing ? .5 : 0)) / n * 100) : 0) + '%"></div>' +
    '<button class="mini-btn" data-act="tts-prev" aria-label="上一段"' + (t.i <= 0 ? " disabled" : "") + '>⏮</button>' +
    '<button class="mini-play" data-act="tts-toggle" aria-label="播放／暫停">' + (waiting ? '<span class="spinner" style="width:20px;height:20px;border-color:#fff4;border-top-color:#fff"></span>' : t.playing ? ICON.pause : ICON.play) + "</button>" +
    '<button class="mini-btn" data-act="tts-next" aria-label="下一段"' + (t.i >= n - 1 ? " disabled" : "") + '>⏭</button>' +
    '<button class="mini-t" data-act="tts-sheet"><b>' + esc(t.title || "朗讀") + '</b><span>' + (t.loading ? "準備中…" : S.err.tts ? esc(S.err.tts) : "第 " + (t.i + 1) + " / " + n + " 段") + "</span></button>" +
    '<button class="mini-btn rate" data-act="tts-rate">' + Number(t.speed || 1).toFixed(1) + "×</button>" +
    '<button class="mini-btn" data-act="tts-close" aria-label="關閉">✕</button>';
}
function ttsSheet(){
  const t = S.tts;
  openSheet('<div class="row between"><h2 style="margin:0">' + esc(t.title || "朗讀") + '</h2><span class="tiny muted">點一段從那裡開始</span></div>' +
    '<div class="seg" role="group" aria-label="語言">' + [["zh", "中英混合"], ["en", "英文"], ["auto", "自動"]].map(o => '<button data-act="tts-lang" data-v="' + o[0] + '" aria-pressed="' + (t.lang === o[0]) + '">' + o[1] + "</button>").join("") + "</div>" +
    '<div class="stack">' + t.parts.map((p, i) => '<button class="part' + (i === t.i && t.playing ? " playing" : "") + (t.ready[p] ? " ok" : "") + '" data-act="tts-from" data-i="' + i + '"><span class="st">' + (t.ready[p] ? "✓" : i + 1) + '</span><span class="grow">' + esc(p) + "</span></button>").join("") + "</div>" +
    '<button class="btn soft block" data-act="tts-download">' + ICON.down + "下載整段音檔</button>");
}
