"use strict";
/* =========================================================
   影片：YouTube 網址、上傳、電腦待處理資料夾、處理進度、摘要、逐字稿、播放
   ========================================================= */
async function loadLectures(){ S.lectures = (await api("/lectures")).lectures; S.err.load = ""; render(); }
async function loadInbox(){ try { S.inbox = await api("/inbox"); render(); } catch (e) { S.inbox = {files: [], error: errMsg(e)}; } }
async function loadLecture(){
  const id = S.sub.id;
  const j = await api("/lectures/" + id);
  if (!S.sub || S.sub.id !== id) return;
  const fresh = !S.lecture || S.lecture.lecture.id !== id;
  S.lecture = j; S.err.load = "";
  if (fresh || !$("#au").src) setAudio(j.lecture);
  render();
  if (S.pendingSeek != null){ const t = S.pendingSeek; S.pendingSeek = null; seek(t); }
}

const LANG_NAME = {zh: "中文", en: "英文", auto: "自動"};
const STATUS = {queued: ["排隊中", ""], processing: ["處理中", "yellow"], ready: ["完成", "green"], error: ["失敗", "red"]};

function renderLectures(){
  let html = backBtn("書櫃", "books", "影片") + '<section class="card"><div class="label">新增影片</div>' +
    '<button class="btn block green" data-act="pick-lecture">' + ICON.upload + "上傳影片或錄音</button>" +
    '<div class="small muted">檔案直接傳到你的電腦（分塊上傳，沒有大小限制的困擾）。45 分鐘的影片，電腦大約 3～5 分鐘轉好逐字稿。</div>' +
    uploadsHTML("lecture") + "</section>";
  const inbox = S.inbox && S.inbox.files ? S.inbox.files.filter(f => f.kind === "lecture") : [];
  if (inbox.length){
    html += '<section class="card"><div class="row between"><div class="label">電腦待處理資料夾</div><button class="btn ghost sm" data-act="inbox-refresh">重新整理</button></div>' +
      '<div class="stack">' + inbox.map(f => '<div class="list-row"><span class="ic yellow">' + ICON.folder.replace("<svg", '<svg width="22" height="22"') + '</span><span class="t"><b>' + esc(f.name) + '</b><span class="sub">' + fmtSize(f.size) + '</span></span><button class="btn sm" data-act="inbox-import" data-name="' + esc(f.name) + '">匯入</button></div>').join("") + "</div></section>";
  }
  const active = (S.jobs || []).filter(j => (j.kind === "lecture" || j.kind === "resummarize") && j.status !== "done");
  if (active.length) html += '<section class="card"><div class="label">電腦正在處理</div><div class="stack">' + active.map(j => '<div class="stack" style="gap:4px"><b class="small">' + esc(j.title) + "</b>" + jobCard(j) + "</div>").join("") + "</div></section>";
  if (!S.lectures) return html + loading();
  if (!S.lectures.length) return html + '<section class="card"><div class="empty">還沒有影片。上傳影片／錄音，或貼 YouTube 網址。</div></section>';
  const groups = {};
  S.lectures.forEach(l => { (groups[l.course || "未分類"] = groups[l.course || "未分類"] || []).push(l); });
  Object.keys(groups).forEach(c => {
    html += '<section class="card"><div class="label">' + esc(c) + "（" + groups[c].length + " 支）</div><div class=\"stack\">" + groups[c].map(l => {
      const st = STATUS[l.status] || ["", ""];
      return '<button class="list-row" data-act="open-lecture" data-id="' + l.id + '"><span class="ic green">' + ICON.play.replace("<svg", '<svg width="18" height="18"') + '</span><span class="t"><b>' + esc(l.title) + '</b><span class="sub">' + fmtDate(l.created_at) + (l.duration ? " · " + fmtDur(l.duration) : "") +
        (l.overview ? " · " + esc(l.overview.slice(0, 40)) + "…" : "") + "</span></span>" + (l.status !== "ready" ? '<span class="chip ' + st[1] + '">' + st[0] + "</span>" : '<span class="chev">›</span>') + "</button>";
    }).join("") + "</div></section>";
  });
  return html;
}

function lectureForm(file, inboxName){
  const name = inboxName || file.name;
  const courses = [...new Set((S.lectures || []).map(l => l.course).filter(Boolean))];
  const lang = (S.settings && S.settings.prefs && S.settings.prefs.lang) || S.lastLang || "zh";
  S.pendingFile = file || null; S.pendingInbox = inboxName || null; S.formLang = lang;
  openSheet('<h2>這支影片的資料</h2><div class="small muted">' + esc(name) + (file ? " · " + fmtSize(file.size) : "") + "</div>" +
    '<div class="field"><label for="l-course">分類（選填）</label><input class="input" id="l-course" list="l-courses" value="' + esc(S.lastCourse || "") + '" placeholder="例如：中國哲學史、頻道名稱"><datalist id="l-courses">' + courses.map(c => '<option value="' + esc(c) + '">').join("") + "</datalist></div>" +
    '<div class="field"><label for="l-title">標題</label><input class="input" id="l-title" value="' + esc(name.replace(/\.[^.]+$/, "")) + '"></div>' +
    '<div class="field"><label>上課語言</label><div class="seg" id="l-lang">' + ["zh", "en", "auto"].map(v => '<button data-act="form-lang" data-v="' + v + '" aria-pressed="' + (lang === v) + '">' + (v === "zh" ? "中文（夾英文）" : LANG_NAME[v]) + "</button>").join("") + "</div></div>" +
    '<div class="field"><label for="l-terms">術語（選填，辨識會更準）</label><textarea class="input" id="l-terms" rows="3" placeholder="用逗號分開：老子, 無為, Wittgenstein, epistemology">' + esc(S.lastTerms && S.lastCourse ? S.lastTerms : "") + "</textarea></div>" +
    '<button class="btn block green" data-act="lecture-go">' + (file ? "開始上傳" : "匯入並處理") + "</button>");
}

/* ---------- 新增影片：YouTube 網址或上傳 ---------- */
function videoSheet(){
  const lang = (S.settings && S.settings.prefs && S.settings.prefs.lang) || S.lastLang || "zh";
  S.formLang = lang;
  openSheet('<h2>新增影片</h2>' +
    '<div class="field"><label for="yt-url">YouTube 網址</label><input class="input" id="yt-url" type="url" inputmode="url" placeholder="https://youtu.be/…" autocomplete="off"></div>' +
    '<div class="field"><label>影片語言</label><div class="seg" id="l-lang">' + ["zh", "en", "auto"].map(v => '<button data-act="form-lang" data-v="' + v + '" aria-pressed="' + (lang === v) + '">' + (v === "zh" ? "中文（夾英文）" : LANG_NAME[v]) + "</button>").join("") + "</div></div>" +
    '<button class="btn block green" data-act="yt-go">加入</button>' +
    '<div class="tiny muted">由 Gemini 直接看影片產生逐字稿和摘要（不下載影片）。只能用公開影片；需要在設定填 Gemini 金鑰。</div>' +
    '<div class="or-line"><span>或</span></div>' +
    '<button class="btn block soft" data-act="pick-lecture">' + ICON.upload + "上傳影片或錄音</button>");
  setTimeout(() => { const i = $("#yt-url"); if (i) i.focus(); }, 250);
}

/* ---------- 播放：YouTube 嵌入、上傳的影片、只有聲音 ---------- */
const VID = {lid: null, kind: ""};
function ytId(url){ const m = /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/.exec(url || ""); return m ? m[1] : ""; }
function lecThumb(l){ return l.youtube ? "https://i.ytimg.com/vi/" + ytId(l.youtube) + "/mqdefault.jpg" : (l.thumb > 0 ? COVER_URL.get("lthumb:" + l.id + ":" + l.thumb) || "" : ""); }
async function loadThumbs(){
  for (const el of document.querySelectorAll("[data-thumb]")){
    const k = el.dataset.thumb, [, id] = k.split(":");
    if (COVER_URL.has(k)){ if (COVER_URL.get(k)) el.style.backgroundImage = "url(" + COVER_URL.get(k) + ")"; continue; }
    COVER_URL.set(k, "");
    try {
      const r = await api("/lectures/" + id + "/thumb?v=" + k.split(":")[2], {raw: true});
      const u = URL.createObjectURL(await r.blob()); COVER_URL.set(k, u);
      document.querySelectorAll('[data-thumb="' + k + '"]').forEach(x => { x.style.backgroundImage = "url(" + u + ")"; });
    } catch (e) {}
  }
}
function setVideo(lec){
  const box = $("#vbox");
  $("#app").classList.toggle("has-video", !!(lec && (lec.youtube || lec.video_path)));
  const kind = !lec ? "" : lec.youtube ? "yt" : lec.video_path ? "file" : "";
  if (VID.lid === (lec && lec.id) && VID.kind === kind) return;
  VID.lid = lec ? lec.id : null; VID.kind = kind;
  const v = box.querySelector("video"); if (v) v.pause();
  if (kind === "yt"){
    VID.ready = false; VID.yid = ytId(lec.youtube);
    box.innerHTML = '<iframe id="yt" src="' + ytSrc(0) + '" title="' + esc(lec.title) + '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>';
    $("#yt").addEventListener("load", () => setTimeout(() => { VID.ready = true; }, 600));
  } else if (kind === "file"){
    box.innerHTML = '<video id="vid" controls playsinline preload="metadata" src="' + apiUrl("/lectures/" + lec.id + "/video") + '"></video>';
    const vid = $("#vid"); vid.playbackRate = S.rate || 1;
    vid.addEventListener("play", () => { $("#au").pause(); TTSP.stop(); });
  } else box.innerHTML = "";
  box.hidden = !kind;
}
function syncVideo(){
  const on = S.sub && S.sub.type === "lecture" && S.lecture && S.lecture.lecture.id === S.sub.id;
  if (!on){ if (VID.lid != null) setVideo(null); return; }
  setVideo(S.lecture.lecture);
}
function ytSrc(start){ return "https://www.youtube.com/embed/" + VID.yid + "?enablejsapi=1&playsinline=1&rel=0&origin=" + encodeURIComponent(location.origin) + (start ? "&start=" + Math.floor(start) + "&autoplay=1" : ""); }
function ytCmd(func, args){ const f = $("#yt"); if (f && f.contentWindow) f.contentWindow.postMessage(JSON.stringify({event: "command", func, args: args || []}), "*"); }

/* ---------- 單一影片 ---------- */
function setAudio(lec){
  const au = $("#au");
  if (lec && lec.audio_path) {
    const src = apiUrl("/lectures/" + lec.id + "/audio");
    if (au.dataset.lid !== String(lec.id)){ au.pause(); au.src = src; au.dataset.lid = lec.id; au.playbackRate = S.rate || 1; }
  } else { au.pause(); au.removeAttribute("src"); au.dataset.lid = ""; }
}
function seek(t){
  if (VID.kind === "yt"){
    const at = Math.max(0, Number(t) - 1);
    if (VID.ready){ ytCmd("seekTo", [at, true]); ytCmd("playVideo"); }
    else { const f = $("#yt"); if (f) f.src = ytSrc(at || 1); } return; }
  if (VID.kind === "file"){
    const v = $("#vid"); if (!v) return;
    const go = () => { v.currentTime = Math.max(0, Number(t) - 1); v.play().catch(() => {}); };
    if (v.readyState >= 1) go(); else { v.addEventListener("loadedmetadata", go, {once: true}); v.load(); }
    return;
  }
  const au = $("#au");
  if (!au.src) return toast("音訊還沒準備好");
  const go = () => { au.currentTime = Math.max(0, Number(t) - 1); au.play().catch(() => {}); };
  if (au.readyState >= 1) go(); else { au.addEventListener("loadedmetadata", go, {once: true}); au.load(); }
}

function renderLecture(){
  if (!S.lecture || S.lecture.lecture.id !== S.sub.id) return pageTop("影片") + loading();
  const {lecture: l, segments, job} = S.lecture;
  const live = (S.jobs || []).find(j => j.ref_id === l.id && (j.kind === "lecture" || j.kind === "resummarize") && j.status !== "done") || job;
  let html = pageTop("影片", '<button class="btn soft sm" data-act="lec-export-sheet">' + ICON.down + "匯出</button>" +
    '<button class="btn soft sm" data-act="lec-regen">' + ICON.spark + "重新生成</button>" +
    '<button class="btn soft sm" data-act="lec-edit">' + ICON.edit + "編輯</button>" +
    '<button class="btn soft sm" data-act="lec-del" style="color:var(--danger)">' + ICON.trash + "刪除</button>");
  if (l.audio_path && !l.video_path && !l.youtube) html += playerHTML(l);
  html += '<section class="card hero green"><div class="row between"><div class="label">' + esc(l.course || "未分類") + "</div>" + starBtn("lecture", l.id, l.starred) + "</div><h1>" + esc(l.title) + "</h1>" +
    '<div class="row wrap"><span class="chip">' + fmtDate(l.created_at) + "</span>" + (l.duration ? '<span class="chip">' + fmtDur(l.duration) + "</span>" : "") +
    '<span class="chip">' + LANG_NAME[l.lang] + "</span>" + (l.summary_model ? '<span class="chip">' + esc(l.summary_model) + "</span>" : "") + "</div></section>";
  if (live && live.status !== "done") html += jobCard(live);
  if (!segments.length){
    if (!live || live.status === "done") html += '<div class="note">還沒有逐字稿。</div>';
    return html;
  }
  html += '<div class="seg" role="group">' + [["sum", "摘要"], ["tr", "逐字稿"]].map(o => '<button data-act="lec-tab" data-v="' + o[0] + '" aria-pressed="' + (S.lecTab === o[0]) + '">' + o[1] + "</button>").join("") + "</div>";
  if (S.lecTab === "tr") html += transcriptHTML(segments);
  else html += summaryHTML(l);
  return html;
}

/* 匯出：選內容和檔案格式（在手機上直接產生檔案） */
function lecExportSheet(){
  const hasSum = !!S.lecture.lecture.summary;
  S.lexp = S.lexp || {what: hasSum ? "all" : "tr", fmt: "md"};
  const seg = (name, opts, cur) => '<div class="seg" role="group">' + opts.map(o => '<button data-act="lexp-set" data-k="' + name + '" data-v="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '"' + (o[2] ? " disabled" : "") + ">" + o[1] + "</button>").join("") + "</div>";
  const E = S.lexp;
  if (E.fmt === "srt") E.what = "tr";
  openSheet("<h2>匯出</h2>" +
    '<div class="field"><label>內容</label>' + seg("what", [["all", "全部", !hasSum || E.fmt === "srt"], ["sum", "摘要", !hasSum || E.fmt === "srt"], ["tr", "逐字稿"]], E.what) + "</div>" +
    '<div class="field"><label>檔案格式</label>' + seg("fmt", [["md", "Markdown"], ["txt", "純文字"], ["srt", "字幕 SRT"]], E.fmt) + "</div>" +
    '<div class="tiny muted">' + {md: "適合貼到 Notion、Obsidian，保留標題和清單。", txt: "沒有格式符號，任何地方都能打開。", srt: "影片字幕檔，只含逐字稿和時間。"}[E.fmt] + "</div>" +
    '<button class="btn block" data-act="lexp-go">' + ICON.down + "下載</button>");
}
function lecExportText(what, fmt){
  const {lecture: l, segments} = S.lecture, sm = l.summary || {};
  const T = t => fmtT(t || 0);
  if (fmt === "srt"){
    const st = t => { t = Math.max(0, t || 0); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
      return [h, m, sec].map(x => String(x).padStart(2, "0")).join(":") + "," + String(ms).padStart(3, "0"); };
    return segments.map((g, i) => (i + 1) + "\n" + st(g.t0) + " --> " + st(g.t1 || g.t0 + 3) + "\n" + g.text + "\n").join("\n");
  }
  const md = fmt === "md", H = (n, x) => md ? "#".repeat(n) + " " + x : x, B = x => md ? "- " + x : "・" + x;
  const out = [H(1, (l.course ? l.course + "｜" : "") + l.title), ""];
  if (what !== "tr"){
    if (sm.overview) out.push(H(2, "總覽"), "", sm.overview, "");
    (sm.sections || []).forEach(sec => { out.push(H(2, "[" + T(sec.start) + "] " + (sec.title || "")), "", sec.summary || "", ""); (sec.points || []).forEach(p => out.push(B("[" + T(p.t) + "] " + p.text))); out.push(""); });
    if ((sm.details || []).length) out.push(H(2, "細節"), "", ...sm.details.map(d => B("（" + d.kind + "）[" + T(d.t) + "] " + d.text)), "");
    if ((sm.terms || []).length) out.push(H(2, "術語"), "", ...sm.terms.map(t => B((md ? "**" + t.term + "**" : t.term) + "：" + t.explain)), "");
    if ((sm.questions || []).length) out.push(H(2, "複習問題"), "", ...sm.questions.map((q, i) => (i + 1) + ". " + q), "");
  }
  if (what !== "sum"){ out.push(H(2, "逐字稿"), ""); segments.forEach(g => out.push("[" + T(g.t0) + "] " + g.text)); }
  return out.join("\n");
}
function lecRegenSheet(){
  const yt = !!S.lecture.lecture.youtube;
  openSheet("<h2>重新生成</h2>" +
    '<button class="list-row" data-act="lec-resum"><span class="ic green">' + ICON.spark + '</span><span class="t"><b>重新摘要</b><span class="sub">逐字稿不變，用目前設定的模型重寫摘要。換了模型或補了術語時用。</span></span><span class="chev">›</span></button>' +
    '<button class="list-row" data-act="lec-retrans"><span class="ic">' + ICON.edit + '</span><span class="t"><b>重新轉逐字稿</b><span class="sub">' + (yt ? "請 Gemini 重新看一次影片，" : "重新辨識聲音，") + "逐字稿和摘要都會重做。錯字很多時用。</span></span><span class=\"chev\">›</span></button>");
}

function playerHTML(l){
  const au = $("#au"), dur = l.duration || au.duration || 0, cur = au.currentTime || 0;
  return '<div class="player"><div class="row"><button class="play" data-act="play" aria-label="播放／暫停" id="pl-btn">' + (au.paused ? ICON.play : ICON.pause) + "</button>" +
    '<input type="range" id="pl-seek" min="0" max="' + Math.max(1, Math.round(dur)) + '" step="1" value="' + Math.round(cur) + '" aria-label="播放位置">' +
    '<span class="tm" id="pl-tm">' + fmtT(cur) + " / " + fmtT(dur) + "</span>" +
    '<button class="rate" data-act="rate" id="pl-rate">' + (S.rate || 1) + "×</button></div></div>";
}
function summaryHTML(l){
  const s = l.summary;
  if (!s) return '<section class="card"><div class="note warn">還沒有 AI 摘要。到「設定」選好「影片摘要」要用的模型，再按右上角「重新生成」→「重新摘要」。</div></section>';
  let html = "";
  if (s.overview) html += '<section class="card"><div class="row between"><div class="label">總覽</div><button class="btn soft sm" data-act="lec-tts">' + ICON.speaker + "朗讀摘要</button></div>" + '<p style="margin:0;line-height:1.8">' + esc(s.overview) + "</p></section>";
  if ((s.sections || []).length){
    html += '<section class="card"><div class="label">單元（點時間直接跳到那裡）</div><div class="stack">' + s.sections.map(sec =>
      '<div class="sec"><h3>' + timeBtn(sec.start) + "<span>" + esc(sec.title) + "</span></h3>" +
      (sec.summary ? '<div class="small" style="line-height:1.7">' + esc(sec.summary) + "</div>" : "") +
      (sec.points || []).map(p => '<div class="pt">' + timeBtn(p.t) + "<span>" + esc(p.text) + "</span></div>").join("") + "</div>").join("") + "</div></section>";
  }
  if ((s.details || []).length){
    html += '<section class="card"><div class="label">提到的細節</div><div class="stack">' + s.details.map(d =>
      '<div class="pt"><span class="kind">' + esc(d.kind) + "</span>" + timeBtn(d.t) + "<span>" + esc(d.text) + "</span></div>").join("") + "</div></section>";
  }
  if ((s.terms || []).length){
    html += '<section class="card"><div class="label">術語</div><div class="stack">' + s.terms.map(t =>
      '<div class="pt">' + timeBtn(t.t) + "<span><b>" + esc(t.term) + "</b>　" + esc(t.explain) + "</span></div>").join("") + "</div></section>";
  }
  if ((s.questions || []).length){
    html += '<section class="card"><div class="label">複習問題</div><ol style="margin:0;padding-left:22px;line-height:1.8">' + s.questions.map(q => "<li>" + esc(q) + "</li>").join("") + "</ol></section>";
  }
  return html;
}
function transcriptHTML(segs){
  const f = S.trFilter.trim().toLowerCase();
  const list = f ? segs.filter(s => s.text.toLowerCase().includes(f)) : segs;
  return '<section class="card"><input class="input" id="tr-filter" placeholder="在逐字稿裡找…" value="' + esc(S.trFilter) + '" data-draft="tr">' +
    '<div class="tiny muted">' + (f ? "找到 " + list.length + " 段" : segs.length + " 段 · 點一段從那裡開始播") + '</div><div id="tr-list">' +
    list.map(s => '<button class="seg-line" data-act="seek" data-t="' + s.t0 + '" data-i="' + s.idx + '"><span class="tt">' + fmtT(s.t0) + "</span><span>" + esc(s.text) + "</span></button>").join("") + "</div></section>";
}
function lectureAskHTML(l){
  const r = S.ask.lec && S.ask.lec.lid === l.id ? S.ask.lec : null;
  return '<section class="card"><div class="label">只問這支影片</div><textarea class="input" id="lec-q" rows="2" placeholder="影片裡怎麼解釋…？舉了什麼例子？" data-draft="lecq">' + esc(S.ask.lecDraft || "") + "</textarea>" +
    '<button class="btn block green" data-act="ask-lec"' + (S.busy.askLec ? " disabled" : "") + ">" + (S.busy.askLec ? '<span class="spinner"></span>找答案中…' : "問") + "</button>" +
    (S.err.askLec ? errBox(esc(S.err.askLec), "err:askLec") : "") + "</section>" + (r ? answerHTML(r, "lec") : "");
}
function lectureEditSheet(l){
  openSheet('<h2>編輯影片資料</h2>' +
    '<div class="field"><label for="le-course">分類（選填）</label><input class="input" id="le-course" value="' + esc(l.course) + '"></div>' +
    '<div class="field"><label for="le-title">標題</label><input class="input" id="le-title" value="' + esc(l.title) + '"></div>' +
    '<div class="field"><label for="le-terms">術語</label><textarea class="input" id="le-terms" rows="3">' + esc(l.terms) + "</textarea></div>" +
    '<button class="btn block" data-act="lec-save">儲存</button>');
}

/* 播放器跟著時間更新（不重畫整頁） */
function playerTick(){
  const au = $("#au"), tm = $("#pl-tm"), sk = $("#pl-seek"), btn = $("#pl-btn");
  if (!tm) return;
  const dur = (S.lecture && S.lecture.lecture.duration) || au.duration || 0;
  tm.textContent = fmtT(au.currentTime) + " / " + fmtT(dur);
  if (sk && !sk.matches(":active")) sk.value = Math.round(au.currentTime);
  if (btn) btn.innerHTML = au.paused ? ICON.play : ICON.pause;
  if (S.lecTab === "tr" && S.lecture){
    const segs = S.lecture.segments, t = au.currentTime;
    let cur = -1;
    for (let i = 0; i < segs.length; i++){ if (segs[i].t0 <= t + 0.2) cur = segs[i].idx; else break; }
    if (cur !== playerTick.cur){
      playerTick.cur = cur;
      document.querySelectorAll(".seg-line.now").forEach(e => e.classList.remove("now"));
      const el = document.querySelector('.seg-line[data-i="' + cur + '"]');
      if (el){ el.classList.add("now"); if (!au.paused) el.scrollIntoView({block: "center", behavior: "smooth"}); }
    }
  }
}
