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

/* 等某個很快的工作（例如找封面）做完再重新整理：輪詢太慢會錯過它 */
async function waitJob(id, then){
  for (let i = 0; i < 40; i++){
    await new Promise(r => setTimeout(r, 1500));
    try {
      const j = ((await api("/jobs?active=1")).jobs || []).find(x => x.id === id);
      if (!j || j.status === "done" || j.status === "error"){ if (then) await then(j); return j; }
    } catch (e) {}
  }
}
async function afterCover(j){
  S.books = null;
  if (S.sub && S.sub.type === "book") await loadBook().catch(() => {});
  toast(j && j.status === "error" ? "找封面失敗：" + (j.error || "") : "封面更新了");
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
        if (j.status === "done" && j.kind !== "cover") toast({lecture: "影片處理好了：", resummarize: "重新摘要好了：", bookfile: "原文讀好了：", analyze: "分析好了：", evaluate: "完成：", review: "整理好了："}[j.kind] + j.title);
      }
    }
    if (changed){
      if (S.sub && S.sub.type === "lecture") loadLecture().catch(() => {});
      else if (S.sub && S.sub.type === "book") loadBook().catch(() => {});
      else if (S.view === "lectures") loadLectures().catch(() => {});
      else if (S.view === "books") loadShelf().catch(() => {});
      else if (S.view === "review") loadReviews().catch(() => {});
      else if (S.view === "mybooks" || S.view === "ask") loadBooks().catch(() => {});
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
  if (/^m\d+$/.test(ctx || "")){
    const all = [].concat((S.chat && S.chat.messages) || [], (S.pop && S.pop.chat && S.pop.chat.messages) || []);
    const m = all.find(x => "m" + x.id === ctx); return ((m && m.sources) || []).find(s => String(s.n) === String(n));
  }
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
  "back": async () => {
    if (S.noteEdit && S.noteDraft && !(await confirmBox("還沒儲存", "離開的話，這次的修改會不見。", "不儲存，離開", true))) return;
    S.noteEdit = null; S.noteDraft = null; closeSheet(); if (S.sub && S.sub.type === "eval") return go(S.view, {type: "book", id: S.sub.id}); go(S.view); },
  "go": el => { closeSheet(); go(el.dataset.v); },
  "assist": el => { S.assist = el.dataset.v || null; render.last = null; render(); $("#main").scrollTop = 0; if (!S.books) loadBooks(); },
  "ask-focus": () => { const q = $("#chat-in"); if (q) q.focus(); },
  "chat-send": () => chatSend(($("#chat-in") || {}).value),
  "chat-opt": el => { const k = el.dataset.k; S.chatOpts[k] = !S.chatOpts[k]; lsSet("chat_" + k, S.chatOpts[k] ? null : "0"); render(); },
  "voice-mode": el => { S.voice = el.dataset.v === "1"; lsSet("voice", S.voice ? "1" : null); if (!S.voice && S.rec.state === "rec") REC.stop(true); render(); },
  "mic": () => { if (S.rec.state === "rec") REC.stop(); else if (S.rec.state === "idle" && !S.chatPending) REC.start("voice"); },
  "cmp-act": () => {
    const v = ($("#chat-in") || {}).value || "";
    if (v.trim()) return chatSend(v);
    S.voice = true; lsSet("voice", "1"); render();           // 黑色按鈕：沒有字就進入語音對話
  },
  "cmp-mic": () => { if (S.rec.state === "idle" && !S.chatPending) REC.start("dictate"); },
  "cmp-menu": () => cmpMenu(),
  "rec-cancel": () => { if (S.rec.state === "rec") REC.stop(true); else if (S.rec.state === "stt"){ REC.cancel = true; } },
  "rec-stop": () => { if (S.rec.state === "rec") REC.stop(false, "draft"); },
  "rec-send": () => { if (S.rec.state === "rec") REC.stop(false, "send"); },
  "menu-kb": () => {
    if (S.chatPins.length){ S.chatPins = []; S.chatOpts.kb = false; lsSet("chat_kb", "0"); toast("已取消指定引用"); cmpMenu(); render(); return; }
    S.chatOpts.kb = !S.chatOpts.kb; lsSet("chat_kb", S.chatOpts.kb ? null : "0"); cmpMenu(); render(); },
  "menu-web": () => { S.chatOpts.web = !S.chatOpts.web; lsSet("chat_web", S.chatOpts.web ? null : "0"); cmpMenu(); render(); },
  "menu-cite": () => { ACT["cite-toggle"](); cmpMenu(); },
  "mic-cancel": () => REC.stop(true),
  "chat-example": el => chatSend(el.dataset.q),
  "pin-sheet": () => pinSheet(),
  "chat-balance": el => {
    S.chatOpts.balance = el.dataset.v; lsSet("chat_balance", el.dataset.v === "kb" ? null : el.dataset.v);
    document.querySelectorAll("#sheet [data-act=chat-balance]").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === el.dataset.v));
    render();
  },
  "cite-toggle": () => { S.showCite = !S.showCite; lsSet("show_cite", S.showCite ? null : "0"); document.documentElement.classList.toggle("hide-cite", !S.showCite); render(); },
  "pin-done": () => {
    const all = pinItems(), flat = [...all.book, ...all.note, ...all.lecture];
    S.chatPins = flat.filter(x => S.pinUI.sel.has(x.kind + ":" + x.id)).map(x => ({kind: x.kind, id: x.id, label: x.label})).slice(0, 30);
    closeSheet(); render();
  },
  "pin-all": () => {
    const q = S.pinUI.q.trim().toLowerCase(), all = pinItems();
    [...all.book, ...all.note, ...all.lecture].filter(x => !q || (x.label + " " + x.sub).toLowerCase().includes(q)).forEach(x => S.pinUI.sel.add(x.kind + ":" + x.id));
    pinRedraw();
  },
  "pin-clear": () => { S.pinUI.sel.clear(); pinRedraw(); },
  "pin-more": el => { S.pinUI.more[el.dataset.k] = !S.pinUI.more[el.dataset.k]; pinRedraw(); },
  "pin-det": el => { S.pinUI.det[el.dataset.k] = !S.pinUI.det[el.dataset.k]; pinRedraw(); },
  "pin-del": el => { S.chatPins.splice(Number(el.dataset.i), 1); render(); },
  "askpop": () => askPopOpen(),
  "askpop-close": () => askPopClose(),
  "askpop-send": () => askPopSend(),
  "pop-menu": () => popMenu(),
  "pop-only": () => { S.pop.only = S.pop.only === false; popMenu(); askPopDraw(); },
  "pop-web": () => { S.pop.web = !S.pop.web; popMenu(); askPopDraw(); },
  "askpop-unquote": () => { if (S.pop){ S.pop.quote = ""; askPopDraw(); } },
  "askpop-full": () => {
    const P = S.pop; if (!P || !P.chat) return;
    askPopClose(); S.chat = null; go("ask");
    openChat(P.chat.id).catch(e => toast(errMsg(e)));
  },
  "ask-pin": el => {
    closeSheet(); S.chat = null; S.err.chat = ""; S.assist = null;
    S.chatPins = [{kind: el.dataset.kind, id: Number(el.dataset.id), label: el.dataset.label}];
    go("ask"); setTimeout(() => { const q = $("#chat-in"); if (q) q.focus(); }, 300);
  },
  "chat-new": () => { closeSheet(); S.chat = null; S.chatPins = []; S.err.chat = ""; render(); const q = $("#chat-in"); if (q) q.focus(); },
  "chat-history": () => { chatHistorySheet(); loadChats().then(() => { if (S.sheet) chatHistorySheet(); }).catch(() => {}); },
  "chat-open": el => { closeSheet(); openChat(Number(el.dataset.id)).catch(e => toast(errMsg(e))); },
  "chat-del": async el => {
    if (!(await confirmBox("刪除這段對話？", "刪除後無法復原。", "刪除", true))) return;
    const id = Number(el.dataset.id);
    await api("/chats/" + id, {method: "DELETE"}).catch(e => toast(errMsg(e)));
    if (S.chat && S.chat.id === id) S.chat = null;
    await loadChats(); chatHistorySheet(); render();
  },

  /* 知識複習 */
  "rv-make": () => act("rv", async () => { const r = await api("/reviews", {method: "POST"}); S.reviewId = r.review_id; toast("開始整理本週，大約一分鐘"); pollJobs(true); await loadReviews(); }),
  "rv-list": () => reviewListSheet(),
  "rv-open": el => { closeSheet(); loadReview(Number(el.dataset.id)).catch(e => toast(errMsg(e))); $("#main").scrollTop = 0; },
  "rv-read": () => { const c = S.review && S.review.content; if (c && c.speech) readAloud(c.speech, "知識複習 " + (c.label || "")); },
  "rv-ask": el => {
    const q = S.review.content.questions[Number(el.dataset.i)];
    S.chat = null; S.assist = null;
    go("ask"); chatSend(q.q);
  },
  "rv-src": el => {
    const s = ((S.review && S.review.content.sources) || []).find(x => String(x.n) === el.dataset.n);
    if (!s) return;
    if (s.kind === "book") ACT["open-book"]({dataset: {id: s.id}});
    else if (s.kind === "note") ACT["open-note"]({dataset: {id: s.id}});
    else if (s.kind === "lecture") ACT["open-lecture"]({dataset: {id: s.id}});
    else toast(s.label);
  },

  /* 書櫃 */
  "shelf-tab": el => { S.shelfTab = el.dataset.v; render(); },
  "sel-toggle": () => { S.sel = S.sel ? null : new Set(); render(); },
  "sel-pick": el => { const k = el.dataset.k; if (S.sel.has(k)) S.sel.delete(k); else S.sel.add(k); render(); },
  "sel-star": () => act("selstar", async () => {
    const items = [...S.sel].map(k => k.split(":"));
    const all = {book: S.books || [], note: S.notes || [], lecture: S.lectures || []};
    const on = !items.every(([k, id]) => (all[k].find(x => x.id === Number(id)) || {}).starred);
    for (const [kind, id] of items) await api("/star", {json: {kind, id: Number(id), on}});
    S.sel = null; await loadShelf(); toast(on ? "收藏了" : "取消收藏");
  }),
  "sel-shelf": () => openSheet('<h2>改成</h2><div class="stack">' + ["wish", "reading", "done"].map(v => '<button class="list-row" data-act="sel-shelf-set" data-v="' + v + '"><span class="t"><b>' + SHELF[v] + "</b></span></button>").join("") + "</div>"),
  "sel-shelf-set": el => act("selshelf", async () => {
    for (const k of S.sel) await api("/books/" + k.split(":")[1], {method: "PATCH", json: {shelf: el.dataset.v}});
    closeSheet(); S.sel = null; await loadShelf(); toast("改好了");
  }),
  "sel-del": async () => {
    const n = S.sel.size;
    if (!(await confirmBox("刪除 " + n + " 項？", "書會連同筆記、原文一起刪除；影片會連同錄音、影片檔刪除。無法復原。", "刪除", true))) return;
    act("seldel", async () => {
      const path = {book: "/books/", note: "/notes/", lecture: "/lectures/"};
      for (const k of S.sel){ const [kind, id] = k.split(":"); await api(path[kind] + id, {method: "DELETE"}); }
      S.sel = null; S.books = S.notes = S.lectures = null; await loadShelf(); toast("刪除了");
    });
  },
  /* 封面 */
  "cover-sheet": () => {
    const b = S.book.book;
    openSheet('<h2>換封面</h2><div class="stack">' +
      '<button class="list-row" data-act="cover-shoot"><span class="ic">📷</span><span class="t"><b>拍封面</b><span class="sub">用照片核對網路上找到的封面，對不上就用照片</span></span></button>' +
      '<button class="list-row" data-act="cover-lib"><span class="ic">🖼️</span><span class="t"><b>從相簿選</b><span class="sub">同上</span></span></button>' +
      (b.cover_src === "photo" || b.cover_mode === "photo" ? "" : '<button class="list-row" data-act="cover-mode" data-v="photo"><span class="ic">📸</span><span class="t"><b>直接用我拍的照片</b></span></button>') +
      '<button class="list-row" data-act="cover-mode" data-v="auto"><span class="ic">🔍</span><span class="t"><b>重新自動找</b></span></button>' +
      '<button class="list-row" data-act="cover-mode" data-v="text"><span class="ic">Aa</span><span class="t"><b>用文字封面</b></span></button></div>');
  },
  "cover-shoot": () => { const i = $("#pick-cover"); i.dataset.for = "cover"; i.value = ""; i.click(); },
  "cover-lib": () => { const i = $("#pick-cover-lib"); i.dataset.for = "cover"; i.value = ""; i.click(); },
  "cover-mode": el => act("cover", async () => {
    const r = await api("/books/" + S.sub.id + "/cover", {json: {mode: el.dataset.v}});
    closeSheet(); toast(el.dataset.v === "text" ? "改成文字封面" : "換封面中，幾秒鐘後會更新"); waitJob(r.job && r.job.id, afterCover);
  }),
  "add-sheet": () => addSheet(),
  "import-sheet": () => importSheet(),
  "star": el => {
    const on = el.dataset.on !== "1", kind = el.dataset.kind, id = Number(el.dataset.id);
    act("star", async () => {
      await api("/star", {json: {kind, id, on}});
      const fix = x => { if (x && x.id === id) x.starred = on; };
      if (kind === "book"){ (S.books || []).forEach(fix); if (S.book) fix(S.book.book); }
      if (kind === "note"){ (S.notes || []).forEach(fix); fix(S.note); }
      if (kind === "lecture"){ (S.lectures || []).forEach(fix); if (S.lecture) fix(S.lecture.lecture); }
      render(); toast(on ? "收藏了，會放在書櫃最上面" : "取消收藏");
    });
  },
  "open-note": el => { closeSheet(); S.note = null; go(S.view === "notebook" ? "notebook" : "books", {type: "note", id: Number(el.dataset.id)}); },
  "free-new": () => freeNoteSheet({}),
  "free-edit": () => { S.noteEdit = S.note.id; S.noteDraft = null; render(); setTimeout(() => { const t = $("#f-content"); if (t){ growTA(t); t.focus(); } }, 50); },
  "free-cancel": () => { S.noteEdit = null; S.noteDraft = null; render(); },
  "free-save": el => {
    const body = {title: $("#f-title").value.trim(), content: $("#f-content").value};
    if (!body.title && !body.content.trim()) return toast("標題和內容至少填一個");
    act("free", async () => {
      if (el.dataset.id){ await api("/notes/" + el.dataset.id, {method: "PATCH", json: body}); closeSheet(); S.notes = null; S.noteEdit = null; S.noteDraft = null; await loadNote(); }
      else { const r = await api("/notes", {json: body}); closeSheet(); S.notes = null; go(S.view === "notebook" ? "notebook" : "books", {type: "note", id: r.note.id}); }
      toast("存好了");
    });
  },
  "free-del": async () => {
    if (!(await confirmBox("刪除這則筆記？", "刪除後無法復原。", "刪除", true))) return;
    act("freed", async () => { await api("/notes/" + S.sub.id, {method: "DELETE"}); S.notes = null; go(S.view); });
  },

  /* 朗讀 */
  "up-x": el => { S.uploads = S.uploads.filter(u => String(u.key) !== el.dataset.key); render(); },
  "err-x": el => {
    const k = el.dataset.k || "";
    if (k.startsWith("err:")) S.err[k.slice(4)] = "";
    else if (k.startsWith("job:") || k.startsWith("rv:")){ S.dismissed.add(k); lsSet("dismissed", [...S.dismissed].slice(-100).join(",")); }
    if (k.startsWith("tmp:")) S.dismissed.add(k);
    if (k === "pop:err" && S.pop) S.pop.err = "";
    const w = el.closest(".err-wrap"); if (w) w.remove();
  },
  "read-eval": () => { const box = $("#eval-body"); if (box) readAloud(readableText(box), box.dataset.read); },
  "read-note": () => { const box = $("#note-card"); if (box) readAloud(readableText(box), box.dataset.read); },
  "read": el => { const box = el.closest("[data-read]"); if (box) readAloud(readableText(box), box.dataset.read); },
  "tts-toggle": () => { const t = S.tts; if (t.playing) TTSP.stop(); else if (t.parts.length){ $("#au").pause(); TTSP.play(Math.max(0, t.i)); } },
  "tts-prev": () => { if (S.tts.i > 0) TTSP.play(S.tts.i - 1); },
  "tts-next": () => { if (S.tts.i < S.tts.parts.length - 1) TTSP.play(S.tts.i + 1); },
  "tts-rate": () => {
    const t = S.tts, cur = Number(t.speed || 1), next = SPEEDS[(SPEEDS.findIndex(v => Math.abs(v - cur) < .01) + 1) % SPEEDS.length];
    const was = t.playing; TTSP.stop(); TTSP.reset(); t.speed = next; renderMini();
    if (was) TTSP.play(t.i);
  },
  "tts-close": () => { S.voiceSpeaking = false; TTSP.stop(); TTSP.reset(); S.tts.parts = []; S.tts.i = -1; S.err.tts = ""; renderMini(); },
  "tts-sheet": () => ttsSheet(),
  "reload": () => { S.err.load = ""; render(); load(); },
  "close-sheet": () => closeSheet(),
  "job-retry": el => act("retry", async () => { await api("/jobs/" + el.dataset.id + "/retry", {method: "POST"}); pollJobs(true); load(); }),
  "up-retry": el => Up.retry(el.dataset.key),

  /* 問答 */
  "ask-scope": el => { S.ask.scope = el.dataset.v; render(); },
  "src": el => { const s = findSource(el.dataset.ctx, el.dataset.n); if (s) sourceSheet(s); },

  /* 書 */
  "open-book": el => { closeSheet(); S.book = null; S.evalOpen = false; go(["ask", "mybooks"].includes(S.view) ? S.view : "books", {type: "book", id: Number(el.dataset.id)}); },
  "book-new": () => { S.wishKeep = null; S.coverPhoto = null; wishSheet({}); },
  "book-edit": () => { const b = S.book.book; openSheet('<h2>編輯書的資料</h2><div class="field"><label for="b-title">書名</label><input class="input" id="b-title" value="' + esc(b.title) + '"></div>' +
    '<div class="field"><label for="b-author">作者</label><input class="input" id="b-author" value="' + esc(b.author) + '"></div><button class="btn block" data-act="book-save">儲存</button>' +
    '<div class="label" style="margin-top:6px">封面、原文與匯出</div>' +
    '<div class="row wrap"><button class="btn soft sm" data-act="cover-sheet">' + ICON.camera + "換封面</button></div>" +
    (b.file_name ? '<div class="tiny muted">原文：' + esc(b.file_name) + "</div>" : "") + (b.isbn ? '<div class="tiny muted en">ISBN ' + esc(b.isbn) + "</div>" : "") +
    '<div class="row wrap"><button class="btn soft sm" data-act="pick-book" data-id="' + b.id + '">' + ICON.upload + (b.file_name ? "換原文檔" : "上傳原文 PDF／EPUB") + "</button>" +
    '<button class="btn soft sm" data-act="book-export" data-id="' + b.id + '">' + ICON.down + "匯出筆記</button></div>" +
    '<button class="btn ghost block" data-act="book-del" style="color:var(--danger)">刪除這本書（含所有筆記）</button>'); },
  "book-save": () => act("books", async () => { await api("/books/" + S.sub.id, {method: "PATCH", json: {title: $("#b-title").value, author: $("#b-author").value}}); closeSheet(); S.books = null; await loadBook(); }),
  "book-del": async () => {
    if (!(await confirmBox("刪除這本書？", "書、所有筆記、上傳的原文和分析都會刪除，無法復原。", "刪除", true))) return;
    act("bookd", async () => { await api("/books/" + S.sub.id, {method: "DELETE"}); closeSheet(); S.books = null; go(S.view); });
  },
  /* 想讀 */
  "wish-new": () => { S.wishKeep = null; wishSheet({}); },
  "wish-create": () => {
    const body = {shelf: "wish", title: $("#w-title").value.trim(), author: $("#w-author").value.trim(), isbn: $("#w-isbn").value.trim(), wish_note: $("#w-note").value.trim(), evaluate: $("#w-eval").checked};
    if (!body.title && !body.isbn) return toast("請填書名或 ISBN");
    act("wishc", async () => {
      const r = await api("/books", {json: body}); closeSheet(); S.books = null; S.evalOpen = false;
      if (S.coverPhoto){ const ph = S.coverPhoto; S.coverPhoto = null; api("/books/" + r.book.id + "/cover-photo", {method: "POST", body: ph, headers: {"Content-Type": "image/jpeg"}}).then(x => waitJob(x.job && x.job.id, afterCover)).catch(() => {}); }
      else if (r.cover_job) waitJob(r.cover_job.id, async () => { S.books = null; if (S.sub && S.sub.type === "book") await loadBook().catch(() => {}); });
      if (body.evaluate) pollJobs(true);
      go(S.view === "mybooks" ? "mybooks" : "books", {type: "book", id: r.book.id});
    });
  },
  "eval-toggle": () => { closeSheet(); go(S.view, {type: "eval", id: S.book.book.id}); $("#main").scrollTop = 0; },
  "ntab": el => { S.ntab = el.dataset.v; render(); },
  "shelf-set": el => act("books", async () => {
    await api("/books/" + S.sub.id, {method: "PATCH", json: {shelf: el.dataset.v}});
    S.book.book.shelf = el.dataset.v; S.books = null; render(); toast("改成「" + SHELF[el.dataset.v] + "」");
  }),
  "shelf-filter": el => { S.shelfFilter = el.dataset.v; render(); },
  "cam-open": () => CAM.open(),
  "cam-close": () => CAM.close(),
  "cam-shot": () => CAM.shot(),
  "cam-lib": () => { CAM.close(); $("#pick-cover-lib").value = ""; $("#pick-cover-lib").click(); },
  "job-cancel": async el => {
    if (!(await confirmBox("停止選書評估？", "這次找到的資料不會保留，之前的評估結果不受影響。", "停止評估", true))) return;
    try { await api("/jobs/" + el.dataset.id + "/cancel", {method: "POST"}); toast("已取消"); } catch (e) { toast(errMsg(e)); }
    pollJobs(true); if (S.sub && (S.sub.type === "book" || S.sub.type === "eval")) loadBook().catch(() => {});
  },
  "evaluate": async el => {
    const b = S.book && S.book.book;
    if (b && b.evaluation && !(await confirmBox("重新評估這本書？", "會重新上網找資料、讓 AI 再判斷一次（約 1～3 分鐘），完成後取代目前的評估結果。", "重新評估"))) return;
    ACT["evaluate-go"](el);
  },
  "evaluate-go": el => act("evaluate", async () => { await api("/books/" + el.dataset.id + "/evaluate", {method: "POST"}); toast("開始評估，大約 1～3 分鐘"); pollJobs(true); await loadBook(); }),
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
  "pick-book": el => { S.bookTarget = el.dataset.id ? Number(el.dataset.id) : 0; $("#pick-book").value = ""; $("#pick-book").click(); },
  "pick-photo": () => { $("#pick-photo").value = ""; $("#pick-photo").click(); },
  "note-new": () => noteSheet(S.ntab && S.ntab !== "ai" && S.ntab !== "未分章" && S.sub && S.sub.type === "book" ? {chapter: S.ntab} : {}),
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
  "video-sheet": () => videoSheet(),
  "yt-go": () => {
    const url = $("#yt-url").value.trim();
    if (!ytId(url)) return toast("請貼 YouTube 影片網址");
    act("yt", async () => {
      const r = await api("/lectures/youtube", {json: {url, lang: S.formLang}});
      closeSheet(); toast("加入了，Gemini 開始看影片"); S.lastLang = S.formLang;
      pollJobs(true); S.lectures = null; S.shelfTab = "lecture";
      await loadLectures().catch(() => {});
      go("books", {type: "lecture", id: r.lecture_id});
    });
  },
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
    go(S.view === "lectures" ? "lectures" : "books", {type: "lecture", id});
  },
  "lec-tab": el => { S.lecTab = el.dataset.v; render(); },
  "seek": el => seek(Number(el.dataset.t)),
  "play": () => { const au = $("#au"); if (au.paused){ TTSP.stop(); au.play().catch(() => toast("播放失敗")); } else au.pause(); },
  "rate": () => { const r = [1, 1.25, 1.5, 1.75, 2, 0.75]; S.rate = r[(r.indexOf(S.rate || 1) + 1) % r.length]; $("#au").playbackRate = S.rate; const b = $("#pl-rate"); if (b) b.textContent = S.rate + "×"; },
  "lec-tts": () => {
    const s = S.lecture.lecture.summary, l = S.lecture.lecture;
    const lines = [l.title + "。", s.overview || ""];
    (s.sections || []).forEach(sec => { lines.push(sec.title + "。" + (sec.summary || "")); (sec.points || []).forEach(p => lines.push(p.text)); });
    readAloud(lines.filter(Boolean).join("\n"), l.title);
  },
  "lec-export-sheet": () => lecExportSheet(),
  "lexp-set": el => { S.lexp[el.dataset.k] = el.dataset.v; lecExportSheet(); },
  "lexp-go": () => {
    const E = S.lexp, l = S.lecture.lecture;
    const text = lecExportText(E.what, E.fmt);
    const name = safeName(l.title) + (E.what === "sum" ? "－摘要" : E.what === "tr" && E.fmt !== "srt" ? "－逐字稿" : "") + "." + E.fmt;
    const blob = new Blob(["\ufeff" + text], {type: {md: "text/markdown", txt: "text/plain", srt: "application/x-subrip"}[E.fmt] + ";charset=utf-8"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    closeSheet(); toast("已匯出：" + name);
  },
  "lec-regen": () => lecRegenSheet(),
  "lec-export": () => act("export", () => download("/lectures/" + S.sub.id + "/export", safeName(S.lecture.lecture.title) + ".md")),
  "lec-resum": () => act("resum", async () => { closeSheet(); await api("/lectures/" + S.sub.id + "/resummarize", {method: "POST"}); toast("開始重新摘要"); pollJobs(true); await loadLecture(); }),
  "lec-retrans": async () => {
    closeSheet();
    if (!(await confirmBox("重新轉逐字稿？", "會刪掉現在的逐字稿和摘要，用最新的術語重新辨識。", "重新轉"))) return;
    act("retrans", async () => { await api("/lectures/" + S.sub.id + "/retranscribe", {method: "POST"}); pollJobs(true); await loadLecture(); });
  },
  "lec-edit": () => lectureEditSheet(S.lecture.lecture),
  "lec-save": () => act("lecs", async () => { await api("/lectures/" + S.sub.id, {method: "PATCH", json: {course: $("#le-course").value, title: $("#le-title").value, terms: $("#le-terms").value}}); closeSheet(); S.lectures = null; await loadLecture(); }),
  "lec-del": async () => {
    if (!(await confirmBox("刪除這支影片？", "錄音、影片檔、逐字稿、摘要都會刪除，無法復原。", "刪除", true))) return;
    act("lecd", async () => { await api("/lectures/" + S.sub.id, {method: "DELETE"}); setAudio(null); S.lectures = null; go(S.view); });
  },
  "ask-lec": () => {
    const q = ($("#lec-q").value || "").trim();
    if (!q) return toast("先輸入問題");
    const lid = S.sub.id;
    act("askLec", async () => { const r = await api("/ask", {json: {question: q, scope: "lecture:" + lid}}); r.lid = lid; S.ask.lec = r; S.ask.lecDraft = ""; });
  },

  /* 朗讀 */
  "tts-lang": el => { const was = S.tts.playing; S.tts.lang = el.dataset.v; TTSP.stop(); TTSP.reset(); ttsSheet(); if (was) TTSP.play(S.tts.i); },
  "tts-from": el => { closeSheet(); $("#au").pause(); TTSP.play(Number(el.dataset.i)); },
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
  else if (el.id === "shelf-q"){ S.shelfQ = el.value; el.parentNode.classList.toggle("has-q", !!el.value); const g = $("#shelf-grid"); if (g){ g.innerHTML = shelfGridHTML(); loadCovers(); } }
  else if (el.id === "pin-q"){ S.pinUI.q = el.value; pinRedraw(); }
  else if (d === "chat"){
    S.chatDraft = el.value; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px";
    const c = $("#cmp"), has = !!el.value.trim();
    if (c && c.classList.contains("has-text") !== has){
      c.classList.toggle("has-text", has);
      const b = c.querySelector("[data-act=cmp-act]"); if (b){ b.innerHTML = has ? SEND : WAVE; b.setAttribute("aria-label", has ? "送出" : "語音對話"); }
    }
    if (c && el.value) c.classList.add("open");
  }
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
    closeSheet();
    if (!S.sub && !["books", "mybooks"].includes(S.view)) go("books");
  }
  if (el.dataset && el.dataset.pin){ if (el.checked) S.pinUI.sel.add(el.dataset.pin); else S.pinUI.sel.delete(el.dataset.pin); const c = $("#pin-count"); if (c) c.textContent = "已選 " + S.pinUI.sel.size + " 項"; }
  if (el.id === "note-noindex") act("noidx", async () => {
    await api("/notes/" + S.sub.id, {method: "PATCH", json: {no_index: el.checked}});
    S.note.no_index = el.checked; S.notes = null; render();
    toast(el.checked ? "這則不會放進知識庫" : "這則會放進知識庫");
  });
  if (el.id === "w-eval"){ const nb = $("#w-note-box"); if (nb) nb.hidden = !el.checked; }
  if ((el.id === "pick-cover" || el.id === "pick-cover-lib") && el.files[0]){
    if (el.dataset.for === "cover"){        // 書頁「換封面」
      el.dataset.for = "";
      const f = el.files[0];
      act("cover", async () => {
        const blob = await shrinkImage(f, 1600);
        const r = await api("/books/" + S.sub.id + "/cover-photo", {method: "POST", body: blob, headers: {"Content-Type": "image/jpeg"}});
        closeSheet(); toast("用照片核對封面中…"); waitJob(r.job && r.job.id, afterCover);
      });
    } else coverDone(identifyCover(el.files[0]));
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
/* 輸入框跟著內容長高：先記住捲動位置再量，畫面才不會跳 */
const FIELD_SIZING = typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content");
function growTA(t){
  if (FIELD_SIZING) return;
  const m = $("#main"), top = m.scrollTop, h = t.offsetHeight;
  t.style.minHeight = h + "px"; t.style.height = "auto";          // 用 min-height 撐住，量的時候版面不會縮
  const want = Math.max(t.scrollHeight + 2, 240);
  t.style.height = want + "px"; t.style.minHeight = "";
  m.scrollTop = top;
}
document.addEventListener("input", e => {
  if ((e.target.id === "f-content" || e.target.id === "f-title") && S.noteEdit && $(".note-edit")){
    S.noteDraft = {title: $("#f-title").value, content: $("#f-content").value};
    if (e.target.id === "f-content") growTA(e.target);
  }
  if (e.target.id === "pop-in"){ const q = e.target; q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 120) + "px"; }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("#cam")){ CAM.close(); return; }
  if (e.key === "Escape" && S.dd){ S.dd = null; render(); return; }
  if (e.key === "Escape" && S.sheet){ closeSheet(); return; }
  if (e.key === "Escape" && !$("#askpop").hidden){ askPopClose(); return; }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.id === "pop-in" && matchMedia("(hover: hover)").matches){ e.preventDefault(); askPopSend(); }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.target.id === "book-q")){ e.preventDefault(); ACT["ask-book"](); }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.id === "chat-in" && matchMedia("(hover: hover)").matches){ e.preventDefault(); ACT["chat-send"](); }
});
const AU = $("#au");
["timeupdate", "play", "pause", "loadedmetadata"].forEach(ev => AU.addEventListener(ev, () => playerTick()));
function afterRender(){
  playerTick();
  const ta = $(".inline-ta"); if (ta) growTA(ta);
  syncAskBtn();
  syncVideo();
  loadThumbs();
  loadCovers();
  const ci = $("#chat-in");
  if (ci && ci.value){ ci.style.height = "auto"; ci.style.height = Math.min(ci.scrollHeight, 160) + "px"; }
  if (S.chatScroll && S.view === "ask" && !S.sub){ S.chatScroll = false; const m = $("#main"); m.scrollTop = m.scrollHeight; }
}

/* ---------- 網址 #books/book/3 ---------- */
function fromHash(){
  const m = location.hash.slice(1).split("/");
  const views = ["books", "mybooks", "notebook", "lectures", "review", "ask", "prefs"];
  S.view = views.includes(m[0]) ? m[0] : "books";
  S.sub = ["book", "lecture", "note", "eval"].includes(m[1]) && Number(m[2]) ? {type: m[1], id: Number(m[2])} : null;
}
document.addEventListener("toggle", e => { if (e.target.dataset && e.target.dataset.actToggle === "ai-adv") S.aiAdv = e.target.open; }, true);
window.addEventListener("popstate", () => { closeSheet(); fromHash(); render.last = null; render(); load(); });

/* ---------- 啟動 ---------- */
(function boot(){
  fromHash();
  if (!S.token){ showGate(); return; }
  render(); load(); pollJobs(true);
})();

/* 輸入框：點進去展開；長按（沒打字時）直接說話，放開就送出 */
document.addEventListener("focusin", e => { if (e.target.id === "chat-in"){ S.cmpOpen = true; const c = $("#cmp"); if (c) c.classList.add("open"); } });
document.addEventListener("focusout", e => {
  if (e.target.id !== "chat-in") return;
  setTimeout(() => { const c = $("#cmp"), q = $("#chat-in"); if (c && q && document.activeElement !== q && !q.value && !c.contains(document.activeElement)){ S.cmpOpen = false; c.classList.remove("open"); } }, 150);
});
const PTT = {timer: 0, on: false, x: 0, y: 0};
document.addEventListener("pointerdown", e => {
  const q = e.target.id === "chat-in" ? e.target : null;
  if (!q || q.value || S.chatPending || S.rec.state !== "idle") return;
  PTT.x = e.clientX; PTT.y = e.clientY;
  PTT.timer = setTimeout(() => { PTT.on = true; q.blur(); if (navigator.vibrate) navigator.vibrate(30); REC.start("ptt"); }, 450);
});
document.addEventListener("pointermove", e => { if (PTT.timer && Math.hypot(e.clientX - PTT.x, e.clientY - PTT.y) > 12){ clearTimeout(PTT.timer); PTT.timer = 0; } });
["pointerup", "pointercancel"].forEach(ev => document.addEventListener(ev, () => {
  clearTimeout(PTT.timer); PTT.timer = 0;
  if (PTT.on){ PTT.on = false; if (S.rec.state === "rec") REC.stop(false, "send"); }
}));
document.addEventListener("contextmenu", e => { if (e.target.id === "chat-in" && (PTT.on || PTT.timer)) e.preventDefault(); });
