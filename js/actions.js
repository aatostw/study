"use strict";
/* =========================================================
   登入、所有按鈕的動作、朗讀播放、工作進度、啟動
   ========================================================= */

/* ---------- 登入 ---------- */
function showGate(msg){
  const g = $("#gate");
  $("#tabs").hidden = true;
  g.innerHTML = '<div class="g-deco g-blob1"></div><div class="g-deco g-dots"></div><div class="g-deco g-blob2"></div><div class="g-deco g-blob3"></div>' +
    '<form class="g-in" id="login-form"><div class="g-logo"><svg width="56" height="56" viewBox="0 0 30 30" aria-hidden="true"><rect x="2" y="7" width="17" height="19" rx="5" fill="#39648D"/><rect x="10" y="3" width="17" height="19" rx="5" fill="#48A88B"/><circle cx="23" cy="24" r="4" fill="#F3CC58"/></svg></div>' +
    '<div class="g-brand">NATURSAI</div><h1 class="g-title">學習筆記</h1>' +
    '<label class="g-field">' + ICON.lock + '<input type="password" id="g-pw" placeholder="密碼" autocomplete="current-password" required></label>' +
    '<button class="g-btn" id="g-go" type="submit">登入</button><div class="g-err" id="g-err">' + esc(msg || "") + "</div>" +
    '<div class="g-foot">只有你自己能用。資料存在你的電腦。</div></form>';
  g.hidden = false;
  $("#login-form").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#g-go"), pw = $("#g-pw").value;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>登入中';
    try {
      const res = await fetch(S.api + "/login", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({password: pw})});
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.token) throw new Error(j.error || "登入失敗（" + res.status + "）");
      S.token = j.token; lsSet("token", j.token);
      g.hidden = true; g.innerHTML = "";
      render(); load(); pollJobs(true);
    } catch (err) {
      $("#g-err").textContent = err.message === "Failed to fetch" ? "連不到伺服器，確認網路，或到設定檢查網址。" : err.message;
      btn.disabled = false; btn.textContent = "登入";
    }
  };
  setTimeout(() => { const i = $("#g-pw"); if (i) i.focus(); }, 50);
}

/* ---------- 工作進度：有東西在跑就每 3 秒問一次 ---------- */
let pollTimer = null;
async function pollJobs(now){
  clearTimeout(pollTimer);
  if (!S.token) return;
  if (!now){ pollTimer = setTimeout(() => pollJobs(true), 3000); return; }
  try {
    const before = new Map((S.jobs || []).map(j => [j.id, j.status]));
    S.jobs = (await api("/jobs?active=1")).jobs;
    let changed = false;
    for (const j of S.jobs){
      if ((j.status === "done" || j.status === "error") && before.get(j.id) && before.get(j.id) !== j.status){
        changed = true;
        if (j.status === "done") toast({lecture: "課程處理好了：", resummarize: "重新摘要好了：", bookfile: "原文讀好了：", analyze: "分析好了：", evaluate: "完成："}[j.kind] + j.title);
      }
    }
    if (changed){
      if (S.sub && S.sub.type === "lecture") loadLecture().catch(() => {});
      else if (S.sub && S.sub.type === "book") loadBook().catch(() => {});
      else if (S.view === "lectures") loadLectures().catch(() => {});
      else if (S.view === "books") loadBooks().catch(() => {});
    }
    renderSoon();
  } catch (e) {}
  const busy = (S.jobs || []).some(j => j.status === "queued" || j.status === "running") || S.uploads.some(u => u.state === "sending" || u.state === "finishing");
  pollTimer = setTimeout(() => pollJobs(true), busy ? 3000 : 30000);
}

/* ---------- 朗讀播放 ---------- */
/* 朗讀播放：嚴格「由上往下」一段一段跟電腦要聲音。
   電腦的 GPT-SoVITS 一次只能唸一句，同時送好幾個請求的話，排隊順序不保證，
   常常變成後面的段落先做好、第一段反而最晚。所以這裡一次只要一段：
   第 1 段好了就開始播，同時在背景接著要第 2、3…段（最多先準備好 AHEAD 段）。 */
const TTSP = {
  AHEAD: 4,
  urls: new Map(),        // key → blob URL（已經生成好的段落）
  gen: 0,                 // 換文字、語言、速度或停止時 +1，舊的請求就作廢
  fetching: false, waiting: -1, cur: null,
  key(p){ return S.tts.lang + "|" + S.tts.speed + "|" + p; },
  has(i){ const p = S.tts.parts[i]; return p != null && this.urls.has(this.key(p)); },
  reset(){ this.gen++; this.waiting = -1; this.fetching = false; this.urls.forEach(u => URL.revokeObjectURL(u)); this.urls.clear(); S.tts.ready = {}; },
  /* 從目前播放的位置往下，找第一段還沒準備好的，一次只要一段 */
  async pump(){
    if (this.fetching) return;
    const t = S.tts, from = Math.max(0, t.i);
    let next = -1;
    for (let j = from; j < t.parts.length && j <= from + this.AHEAD; j++){ if (!this.has(j)){ next = j; break; } }
    if (next < 0) return;
    this.fetching = true;
    const gen = this.gen, p = t.parts[next], k = this.key(p);
    try {
      const res = await api("/tts/audio?" + new URLSearchParams({text: p, lang: t.lang, speed: t.speed}).toString(), {raw: true});
      const blob = await res.blob();
      if (gen !== this.gen) return;                 // 中途停止或換設定了
      this.urls.set(k, URL.createObjectURL(blob));
      t.ready[p] = true; renderSoon();
      if (this.waiting === next){ this.waiting = -1; this.play(next); }
    } catch (e) {
      if (gen !== this.gen) return;
      S.err.tts = "第 " + (next + 1) + " 段唸不出來：" + errMsg(e);
      this.stop(); return;
    } finally {
      if (gen === this.gen) this.fetching = false;
    }
    this.pump();
  },
  play(i){
    const t = S.tts;
    if (i >= t.parts.length){ this.stop(); toast("唸完了"); return; }
    $("#au").pause();
    t.i = i; t.playing = true; S.err.tts = "";
    if (this.cur){ try { this.cur.pause(); } catch (e) {} }
    if (!this.has(i)){                              // 還沒好：等它，好了 pump 會叫 play
      this.waiting = i; this.cur = null; renderSoon(); this.pump(); return;
    }
    const a = new Audio(this.urls.get(this.key(t.parts[i])));
    this.cur = a;
    a.playbackRate = 1;
    a.onended = () => { if (this.cur === a && t.playing) this.play(i + 1); };
    a.play().catch(() => {});
    renderSoon();
    this.pump();                                    // 播放的同時準備後面的段落
  },
  stop(){
    S.tts.playing = false; this.waiting = -1;
    if (this.cur){ try { this.cur.pause(); } catch (e) {} }
    this.cur = null; renderSoon();
  }
};

async function ttsStart(from){
  const t = S.tts, box = $("#tts-text");
  if (box) t.text = box.value;
  if (!t.text.trim()){ toast("先輸入要唸的文字"); return; }
  if (t.splitOf !== t.text || !t.parts.length){
    S.busy.tts = true; render();
    try { TTSP.reset(); t.parts = (await api("/tts/split", {json: {text: t.text}})).parts; t.splitOf = t.text; t.ready = {}; }
    catch (e) { S.err.tts = errMsg(e); S.busy.tts = false; render(); return; }
    S.busy.tts = false;
  }
  TTSP.play(from || 0);
}

/* ---------- 下載檔案（匯出、朗讀）---------- */
async function download(path, name, opt){
  const res = await api(path, Object.assign({raw: true}, opt || {}));
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = s => String(s || "export").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);

function findSource(ctx, n){
  const list = ctx === "ask" ? S.ask.cur && S.ask.cur.sources : ctx === "book" ? S.ask.book && S.ask.book.sources
    : ctx === "lec" ? S.ask.lec && S.ask.lec.sources : ctx === "analysis" ? S.book && S.book.book.analysis && S.book.book.analysis.sources : null;
  return (list || []).find(s => String(s.n) === String(n));
}

async function act(name, fn){
  S.busy[name] = true; S.err[name] = ""; render();
  try { await fn(); } catch (e) { if (!e.relogin){ S.err[name] = errMsg(e); toast(errMsg(e)); } }
  S.busy[name] = false; render();
}

/* ---------- 所有按鈕 ---------- */
const ACT = {
  "tab": el => { closeSheet(); if (el.dataset.v === "prefs") S.prefPage = null; go(el.dataset.v); },
  "pref-open": el => {
    S.prefPage = el.dataset.p; S.aiTest = null; S.dd = null; render.last = null; render(); $("#main").scrollTop = 0;
    if (el.dataset.p === "status") loadStatus().catch(() => {});
    if (el.dataset.p === "ai") S.aiCustom = false;
  },
  "pref-back": () => { S.prefPage = null; render.last = null; render(); $("#main").scrollTop = 0; },
  "back": () => { closeSheet(); go(S.view); },
  "reload": () => { S.err.load = ""; render(); load(); },
  "close-sheet": () => closeSheet(),
  "job-retry": el => act("retry", async () => { await api("/jobs/" + el.dataset.id + "/retry", {method: "POST"}); pollJobs(true); load(); }),
  "up-retry": el => Up.retry(el.dataset.key),

  /* 問答 */
  "ask-scope": el => { S.ask.scope = el.dataset.v; render(); },
  "ask": () => {
    const q = ($("#ask-q").value || "").trim();
    if (!q) return toast("先輸入問題");
    S.ask.draft = q;
    act("ask", async () => { S.ask.cur = await api("/ask", {json: {question: q, scope: S.ask.scope}}); S.ask.draft = ""; loadAsks().catch(() => {}); });
  },
  "ask-open": el => { const x = (S.asks || []).find(a => String(a.id) === el.dataset.id); if (x){ S.ask.cur = x; render(); $("#main").scrollTop = 0; } },
  "ask-del": el => act("askdel", async () => { await api("/asks/" + el.dataset.id, {method: "DELETE"}); S.ask.cur = null; await loadAsks(); }),
  "src": el => { const s = findSource(el.dataset.ctx, el.dataset.n); if (s) sourceSheet(s); },

  /* 書 */
  "open-book": el => { closeSheet(); S.book = null; S.view = "books"; go("books", {type: "book", id: Number(el.dataset.id)}); },
  "book-new": () => openSheet('<h2>新增一本書</h2><div class="field"><label for="b-title">書名</label><input class="input" id="b-title" placeholder="道德經"></div>' +
    '<div class="field"><label for="b-author">作者</label><input class="input" id="b-author" placeholder="老子"></div><button class="btn block" data-act="book-create">新增</button>'),
  "book-create": () => {
    const title = $("#b-title").value.trim();
    if (!title) return toast("請填書名");
    act("bookc", async () => { const r = await api("/books", {json: {title, author: $("#b-author").value.trim()}}); closeSheet(); S.books = null; go("books", {type: "book", id: r.book.id}); });
  },
  "book-edit": () => { const b = S.book.book; openSheet('<h2>編輯書的資料</h2><div class="field"><label for="b-title">書名</label><input class="input" id="b-title" value="' + esc(b.title) + '"></div>' +
    '<div class="field"><label for="b-author">作者</label><input class="input" id="b-author" value="' + esc(b.author) + '"></div><button class="btn block" data-act="book-save">儲存</button>' +
    '<button class="btn ghost block" data-act="book-del" style="color:var(--danger)">刪除這本書（含所有筆記）</button>'); },
  "book-save": () => act("books", async () => { await api("/books/" + S.sub.id, {method: "PATCH", json: {title: $("#b-title").value, author: $("#b-author").value}}); closeSheet(); S.books = null; await loadBook(); }),
  "book-del": async () => {
    if (!(await confirmBox("刪除這本書？", "書、所有筆記、上傳的原文和分析都會刪除，無法復原。", "刪除", true))) return;
    act("bookd", async () => { await api("/books/" + S.sub.id, {method: "DELETE"}); closeSheet(); S.books = null; go("books"); });
  },
  /* 想讀 */
  "shelf": el => { S.shelf = el.dataset.v; render(); },
  "wish-new": () => wishSheet({}),
  "wish-create": () => {
    const body = {shelf: "wish", title: $("#w-title").value.trim(), author: $("#w-author").value.trim(), isbn: $("#w-isbn").value.trim(), wish_note: $("#w-note").value.trim()};
    if (!body.title && !body.isbn) return toast("請填書名或 ISBN");
    act("wishc", async () => { const r = await api("/books", {json: body}); closeSheet(); S.books = null; S.shelf = "wish"; pollJobs(true); go("books", {type: "book", id: r.book.id}); });
  },
  "pick-cover": () => { $("#pick-cover").value = ""; $("#pick-cover").click(); },
  "evaluate": el => act("evaluate", async () => { await api("/books/" + el.dataset.id + "/evaluate", {method: "POST"}); toast("開始評估，大約 1～3 分鐘"); pollJobs(true); await loadBook(); }),
  "evid-open": () => evidenceSheet(S.book.book),
  "pick-evid": () => { $("#pick-evid").value = ""; $("#pick-evid").click(); },
  "evid-save": el => act("evid", async () => {
    const bid = S.sub.id;
    await api("/books/" + bid + "/evidence", {json: {text: $("#evid-text").value, replace: true}});
    closeSheet();
    if (el.dataset.eval){ await api("/books/" + bid + "/evaluate", {method: "POST"}); toast("存好了，重新評估中"); pollJobs(true); } else toast("存好了");
    await loadBook();
  }),
  "esrc": el => evalSourceSheet(el.dataset.n),
  "wish-to-read": () => act("books", async () => { await api("/books/" + S.sub.id, {method: "PATCH", json: {shelf: "read"}}); S.books = null; S.shelf = "read"; toast("移到我的書了，開始記筆記吧"); await loadBook(); }),
  "pick-book": el => { S.bookTarget = el.dataset.id ? Number(el.dataset.id) : 0; $("#pick-book").value = ""; $("#pick-book").click(); },
  "pick-photo": () => { $("#pick-photo").value = ""; $("#pick-photo").click(); },
  "note-new": () => noteSheet({}),
  "note-edit": el => noteSheet(S.book.notes.find(n => String(n.id) === el.dataset.id) || {}),
  "note-save": el => {
    const body = {quote: $("#n-quote").value, content: $("#n-content").value, chapter: $("#n-chapter").value, page: $("#n-page").value, source: el.dataset.source};
    if (!body.quote.trim() && !body.content.trim()) return toast("摘句和想法至少填一個");
    act("note", async () => {
      if (el.dataset.id) await api("/notes/" + el.dataset.id, {method: "PATCH", json: body});
      else await api("/books/" + S.sub.id + "/notes", {json: body});
      closeSheet(); toast("存好了"); await loadBook();
      setTimeout(() => loadBook().catch(() => {}), 6000);         // 看索引好了沒
    });
  },
  "note-del": async el => {
    if (!(await confirmBox("刪除這則筆記？", "刪除後無法復原。", "刪除", true))) return;
    act("noted", async () => { await api("/notes/" + el.dataset.id, {method: "DELETE"}); await loadBook(); });
  },
  "analyze": el => act("analyze", async () => { await api("/books/" + el.dataset.id + "/analyze", {method: "POST"}); toast("開始分析，大約一分鐘"); pollJobs(true); await loadBook(); }),
  "book-export": el => act("export", () => download("/books/" + el.dataset.id + "/export", safeName(S.book.book.title) + ".md")),
  "ask-book": () => {
    const q = ($("#book-q").value || "").trim();
    if (!q) return toast("先輸入問題");
    const bid = S.sub.id;
    act("askBook", async () => { const r = await api("/ask", {json: {question: q, scope: "book:" + bid}}); r.bookId = bid; S.ask.book = r; S.ask.bookDraft = ""; });
  },

  /* 課程 */
  "pick-lecture": () => { $("#pick-lecture").value = ""; $("#pick-lecture").click(); },
  "form-lang": el => { S.formLang = el.dataset.v; document.querySelectorAll("#l-lang button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === S.formLang)); },
  "lecture-go": () => {
    const meta = {course: $("#l-course").value.trim(), title: $("#l-title").value.trim(), lang: S.formLang, terms: $("#l-terms").value.trim()};
    S.lastCourse = meta.course; S.lastTerms = meta.terms; S.lastLang = meta.lang;
    closeSheet();
    if (S.pendingFile){ Up.start(S.pendingFile, "lecture", meta); S.pendingFile = null; }
    else if (S.pendingInbox){
      const name = S.pendingInbox; S.pendingInbox = null;
      act("inbox", async () => { await api("/inbox/import", {json: {name, kind: "lecture", meta}}); toast("匯入了，電腦開始處理"); pollJobs(true); loadInbox(); await loadLectures(); });
    }
  },
  "inbox-refresh": () => loadInbox(),
  "inbox-import": el => lectureForm(null, el.dataset.name),
  "open-lecture": el => {
    closeSheet();
    const id = Number(el.dataset.id);
    if (el.dataset.t != null && el.dataset.t !== "") S.pendingSeek = Number(el.dataset.t);
    if (S.sub && S.sub.type === "lecture" && S.sub.id === id && S.pendingSeek != null){ const t = S.pendingSeek; S.pendingSeek = null; S.lecTab = "tr"; render(); seek(t); return; }
    S.lecTab = S.pendingSeek != null ? "tr" : "sum";
    go("lectures", {type: "lecture", id});
  },
  "lec-tab": el => { S.lecTab = el.dataset.v; render(); },
  "seek": el => seek(Number(el.dataset.t)),
  "play": () => { const au = $("#au"); if (au.paused){ TTSP.stop(); au.play().catch(() => toast("播放失敗")); } else au.pause(); },
  "rate": () => { const r = [1, 1.25, 1.5, 1.75, 2, 0.75]; S.rate = r[(r.indexOf(S.rate || 1) + 1) % r.length]; $("#au").playbackRate = S.rate; const b = $("#pl-rate"); if (b) b.textContent = S.rate + "×"; },
  "lec-tts": () => {
    const s = S.lecture.lecture.summary, l = S.lecture.lecture;
    const lines = [l.title + "。", s.overview || ""];
    (s.sections || []).forEach(sec => { lines.push(sec.title + "。" + (sec.summary || "")); (sec.points || []).forEach(p => lines.push(p.text)); });
    S.tts.text = lines.filter(Boolean).join("\n"); S.tts.parts = []; S.tts.lang = "zh";
    go("tts");
  },
  "lec-export": () => act("export", () => download("/lectures/" + S.sub.id + "/export", safeName(S.lecture.lecture.title) + ".md")),
  "lec-resum": () => act("resum", async () => { await api("/lectures/" + S.sub.id + "/resummarize", {method: "POST"}); toast("開始重新摘要"); pollJobs(true); await loadLecture(); }),
  "lec-retrans": async () => {
    if (!(await confirmBox("重新轉逐字稿？", "會刪掉現在的逐字稿和摘要，用最新的術語重新辨識。", "重新轉"))) return;
    act("retrans", async () => { await api("/lectures/" + S.sub.id + "/retranscribe", {method: "POST"}); pollJobs(true); await loadLecture(); });
  },
  "lec-edit": () => lectureEditSheet(S.lecture.lecture),
  "lec-save": () => act("lecs", async () => { await api("/lectures/" + S.sub.id, {method: "PATCH", json: {course: $("#le-course").value, title: $("#le-title").value, terms: $("#le-terms").value}}); closeSheet(); S.lectures = null; await loadLecture(); }),
  "lec-del": async () => {
    if (!(await confirmBox("刪除這堂課？", "錄音、逐字稿、摘要都會刪除，無法復原。", "刪除", true))) return;
    act("lecd", async () => { await api("/lectures/" + S.sub.id, {method: "DELETE"}); setAudio(null); S.lectures = null; go("lectures"); });
  },
  "ask-lec": () => {
    const q = ($("#lec-q").value || "").trim();
    if (!q) return toast("先輸入問題");
    const lid = S.sub.id;
    act("askLec", async () => { const r = await api("/ask", {json: {question: q, scope: "lecture:" + lid}}); r.lid = lid; S.ask.lec = r; S.ask.lecDraft = ""; });
  },

  /* 朗讀 */
  "tts-lang": el => { S.tts.lang = el.dataset.v; TTSP.stop(); TTSP.reset(); render(); },
  "tts-go": () => { if (S.tts.playing) TTSP.stop(); else ttsStart(0); },
  "tts-from": el => { TTSP.stop(); ttsStart(Number(el.dataset.i)); },
  "tts-download": () => act("ttsDl", () => download("/tts/full", "朗讀.wav", {json: {parts: S.tts.parts, lang: S.tts.lang, speed: S.tts.speed}})),

  /* 設定 */
  "status-refresh": () => { S.status = null; render(); loadStatus().catch(e => toast(errMsg(e))); },
  "dd-toggle": el => { S.dd = S.dd === el.dataset.dd ? null : el.dataset.dd; render(); },
  "dd-pick": el => {
    const id = el.dataset.dd, v = el.dataset.val;
    S.dd = null;
    if (id === "ai-prov"){
      S.aiProv = v; S.aiCustom = false;
      return aiSetDefault(v, MODEL_DEFAULT[v] || "");
    }
    if (id === "ai-model"){
      if (v === "__custom"){ S.aiCustom = true; render(); setTimeout(() => { const i = $("#ai-model-text"); if (i) i.focus(); }, 30); return; }
      S.aiCustom = false;
      return aiSetDefault(aiDefault().provider, v);
    }
    if (id.startsWith("tk-")){
      const t = id.slice(3), d = aiDefault();
      const [prov, ...rest] = v ? v.split("|") : [d.provider, d.model];
      return aiSave({models: {[t]: {provider: prov, model: v ? rest.join("|") : d.model}}});
    }
    render();
  },
  "key-eye": el => { const i = $("#" + el.dataset.for); if (i) i.type = i.type === "password" ? "text" : "password"; },
  "ai-test": () => {
    const d = aiDefault();
    S.aiTest = null;
    act("aiTest", async () => {
      try { const r = await api("/ai/test", {json: d}); S.aiTest = {ok: true, msg: "連線成功：" + r.model + " 回答了（" + (r.ms / 1000).toFixed(1) + " 秒）。"}; }
      catch (e) { S.aiTest = {ok: false, msg: errMsg(e)}; }
    });
  },
  "voice-test": () => act("voiceTest", () => new Promise((resolve, reject) => {
    const pr = S.settings.prefs || {};
    const a = new Audio(apiUrl("/tts/audio", {text: "你好，這是學習筆記的朗讀測試。Small steps every day.", lang: pr.tts_lang || "zh", speed: pr.tts_speed || 1}));
    a.oncanplaythrough = () => { a.play().catch(() => {}); resolve(); };
    a.onerror = () => reject(new Error("唸不出來：確認電腦上的「啟動語音伺服器」開著。"));
    $("#au").pause(); TTSP.stop();
  })),
  "pref": el => act("pref", async () => { const r = await api("/settings", {method: "PUT", json: {prefs: {[el.dataset.k]: el.dataset.v}}}); S.settings.prefs = r.prefs; }),
  "api-save": () => { S.api = $("#api-url").value.trim().replace(/\/+$/, "") || DEFAULT_API; lsSet("api", S.api); toast("網址存好了"); load(); },
  "logout": async () => { if (await confirmBox("登出？", "這支手機要重新輸入密碼才能用。", "登出")) logout(); }
};

/* ---------- 事件 ---------- */
document.addEventListener("click", e => {
  if (S.dd && !e.target.closest(".dd")){ S.dd = null; render(); if (!e.target.closest("[data-act]")) return; }
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn){ e.preventDefault(); fn(el, e); }
});
document.addEventListener("input", e => {
  const el = e.target, d = el.dataset && el.dataset.draft;
  if (d === "ask") S.ask.draft = el.value;
  else if (d === "bookq") S.ask.bookDraft = el.value;
  else if (d === "lecq") S.ask.lecDraft = el.value;
  else if (d === "tts") S.tts.text = el.value;
  else if (d === "tr"){ S.trFilter = el.value; clearTimeout(ACT._tr); ACT._tr = setTimeout(() => render(), 250); }
  if (el.id === "pref-speed"){ $("#pref-speed-v").textContent = Number(el.value).toFixed(1) + "×"; }
  if (el.id === "tts-speed"){ $("#tts-speed-v").textContent = Number(el.value).toFixed(1) + "×"; }
  if (el.id === "pl-seek"){ $("#au").currentTime = Number(el.value); }
});
document.addEventListener("change", async e => {
  const el = e.target, a = el.dataset && el.dataset.actChange;
  if (a === "pref-speed"){
    const v = Number(el.value);
    try { const r = await api("/settings", {method: "PUT", json: {prefs: {tts_speed: v}}}); S.settings.prefs = r.prefs; S.tts.speed = null; } catch (err) { toast(errMsg(err)); }
  }
  if (a === "tts-speed"){ S.tts.speed = Number(el.value); TTSP.stop(); TTSP.reset(); render(); }
  if (a === "ai-key" && el.value.trim()){
    const p = el.dataset.p;
    await aiSave({keys: {[p]: el.value.trim()}});
    toast("金鑰存好了");
  }
  if (a === "ai-base") await aiSave({custom_base: el.value.trim()});
  if (a === "ai-model-text" && el.value.trim()) await aiSetDefault(aiDefault().provider || S.aiProv, el.value.trim());
  if (el.id === "pick-lecture" && el.files[0]) lectureForm(el.files[0]);
  if (el.id === "pick-book" && el.files[0]){
    const f = el.files[0];
    Up.start(f, "book", S.bookTarget ? {book_id: S.bookTarget} : {title: f.name.replace(/\.[^.]+$/, "")});
    if (!S.sub && S.view !== "books") go("books");
  }
  if (el.id === "pick-cover" && el.files[0]){
    const keep = {title: $("#w-title").value, author: $("#w-author").value, isbn: $("#w-isbn").value, wish_note: $("#w-note").value};
    S.busy.identify = true; wishSheet(keep);
    try {
      const r = await identifyCover(el.files[0]);
      S.busy.identify = false;
      wishSheet({title: r.title || keep.title, author: r.author || keep.author, isbn: r.isbn || keep.isbn, wish_note: keep.wish_note});
      toast(r.title ? "認出來了，確認一下" : "沒認出書名，請手動輸入");
    } catch (err) { S.busy.identify = false; wishSheet(keep); toast(errMsg(err)); }
  }
  if (el.id === "pick-evid" && el.files[0]){
    const box = $("#evid-text"), prev = box ? box.value : "";
    S.busy.evid = true; evidenceSheet({user_evidence: prev});
    try {
      const r = await api("/ocr", {method: "POST", body: await shrinkImage(el.files[0]), headers: {"Content-Type": "image/jpeg"}});
      S.busy.evid = false;
      evidenceSheet({user_evidence: (prev ? prev + "\n\n" : "") + (r.text || "")});
      toast("辨識好了，可以再加一張");
    } catch (err) { S.busy.evid = false; evidenceSheet({user_evidence: prev}); toast(errMsg(err)); }
  }
  if (el.id === "pick-photo" && el.files[0]){
    const f = el.files[0];
    S.busy.ocr = true; render();
    try {
      const blob = await shrinkImage(f);
      const r = await api("/ocr", {method: "POST", body: blob, headers: {"Content-Type": "image/jpeg"}});
      noteSheet({quote: r.text, page: r.page, source: "photo"});
      toast("辨識好了，確認一下再存");
    } catch (err) { toast(errMsg(err)); }
    S.busy.ocr = false; render();
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && S.dd){ S.dd = null; render(); return; }
  if (e.key === "Escape" && S.sheet) closeSheet();
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.target.id === "book-q")){ e.preventDefault(); ACT["ask-book"](); }
});
const AU = $("#au");
["timeupdate", "play", "pause", "loadedmetadata"].forEach(ev => AU.addEventListener(ev, () => playerTick()));
function afterRender(){ playerTick(); }

/* ---------- 網址 #books/book/3 ---------- */
function fromHash(){
  const m = location.hash.slice(1).split("/");
  const views = ["ask", "books", "lectures", "tts", "prefs"];
  S.view = views.includes(m[0]) ? m[0] : "ask";
  S.sub = (m[1] === "book" || m[1] === "lecture") && Number(m[2]) ? {type: m[1], id: Number(m[2])} : null;
}
document.addEventListener("toggle", e => { if (e.target.dataset && e.target.dataset.actToggle === "ai-adv") S.aiAdv = e.target.open; }, true);
window.addEventListener("popstate", () => { closeSheet(); fromHash(); render.last = null; render(); load(); });

/* ---------- 啟動 ---------- */
(function boot(){
  fromHash();
  if (!S.token){ showGate(); return; }
  render(); load(); pollJobs(true);
})();
