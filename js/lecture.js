"use strict";
/* =========================================================
   課程：上傳、電腦待處理資料夾、處理進度、摘要、逐字稿、播放
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
  let html = '<section class="card"><div class="label">新增一堂課</div>' +
    '<button class="btn block green" data-act="pick-lecture">' + ICON.upload + "上傳錄音或影片</button>" +
    '<div class="small muted">檔案直接傳到你的電腦（分塊上傳，沒有大小限制的困擾）。45 分鐘的課，電腦大約 3～5 分鐘轉好逐字稿。</div>' +
    uploadsHTML("lecture") + "</section>";
  const inbox = S.inbox && S.inbox.files ? S.inbox.files.filter(f => f.kind === "lecture") : [];
  if (inbox.length){
    html += '<section class="card"><div class="row between"><div class="label">電腦待處理資料夾</div><button class="btn ghost sm" data-act="inbox-refresh">重新整理</button></div>' +
      '<div class="stack">' + inbox.map(f => '<div class="list-row"><span class="ic yellow">' + ICON.folder.replace("<svg", '<svg width="22" height="22"') + '</span><span class="t"><b>' + esc(f.name) + '</b><span class="sub">' + fmtSize(f.size) + '</span></span><button class="btn sm" data-act="inbox-import" data-name="' + esc(f.name) + '">匯入</button></div>').join("") + "</div></section>";
  }
  const active = (S.jobs || []).filter(j => (j.kind === "lecture" || j.kind === "resummarize") && j.status !== "done");
  if (active.length) html += '<section class="card"><div class="label">電腦正在處理</div><div class="stack">' + active.map(j => '<div class="stack" style="gap:4px"><b class="small">' + esc(j.title) + "</b>" + jobCard(j) + "</div>").join("") + "</div></section>";
  if (!S.lectures) return html + loading();
  if (!S.lectures.length) return html + '<section class="card"><div class="empty">還沒有課程。上傳第一堂課的錄音吧。</div></section>';
  const groups = {};
  S.lectures.forEach(l => { (groups[l.course || "未分類"] = groups[l.course || "未分類"] || []).push(l); });
  Object.keys(groups).forEach(c => {
    html += '<section class="card"><div class="label">' + esc(c) + "（" + groups[c].length + " 堂）</div><div class=\"stack\">" + groups[c].map(l => {
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
  openSheet('<h2>這堂課的資料</h2><div class="small muted">' + esc(name) + (file ? " · " + fmtSize(file.size) : "") + "</div>" +
    '<div class="field"><label for="l-course">課程名稱</label><input class="input" id="l-course" list="l-courses" value="' + esc(S.lastCourse || "") + '" placeholder="例如：中國哲學史"><datalist id="l-courses">' + courses.map(c => '<option value="' + esc(c) + '">').join("") + "</datalist></div>" +
    '<div class="field"><label for="l-title">這堂課</label><input class="input" id="l-title" value="' + esc(name.replace(/\.[^.]+$/, "")) + '"></div>' +
    '<div class="field"><label>上課語言</label><div class="seg" id="l-lang">' + ["zh", "en", "auto"].map(v => '<button data-act="form-lang" data-v="' + v + '" aria-pressed="' + (lang === v) + '">' + (v === "zh" ? "中文（夾英文）" : LANG_NAME[v]) + "</button>").join("") + "</div></div>" +
    '<div class="field"><label for="l-terms">課程術語（選填，辨識會更準）</label><textarea class="input" id="l-terms" rows="3" placeholder="用逗號分開：老子, 無為, Wittgenstein, epistemology">' + esc(S.lastTerms && S.lastCourse ? S.lastTerms : "") + "</textarea></div>" +
    '<button class="btn block green" data-act="lecture-go">' + (file ? "開始上傳" : "匯入並處理") + "</button>");
}

/* ---------- 單堂課 ---------- */
function setAudio(lec){
  const au = $("#au");
  if (lec && lec.audio_path) {
    const src = apiUrl("/lectures/" + lec.id + "/audio");
    if (au.dataset.lid !== String(lec.id)){ au.pause(); au.src = src; au.dataset.lid = lec.id; au.playbackRate = S.rate || 1; }
  } else { au.pause(); au.removeAttribute("src"); au.dataset.lid = ""; }
}
function seek(t){
  const au = $("#au");
  if (!au.src) return toast("音訊還沒準備好");
  const go = () => { au.currentTime = Math.max(0, Number(t) - 1); au.play().catch(() => {}); };
  if (au.readyState >= 1) go(); else { au.addEventListener("loadedmetadata", go, {once: true}); au.load(); }
}

function renderLecture(){
  const back = '<button class="btn ghost back" data-act="back">' + ICON.back + "課程</button>";
  if (!S.lecture || S.lecture.lecture.id !== S.sub.id) return back + loading();
  const {lecture: l, segments, job} = S.lecture;
  const live = (S.jobs || []).find(j => j.ref_id === l.id && (j.kind === "lecture" || j.kind === "resummarize") && j.status !== "done") || job;
  let html = "";
  if (l.audio_path) html += playerHTML(l);
  html += back + '<section class="card hero green"><div class="label">' + esc(l.course || "未分類") + "</div><h1>" + esc(l.title) + "</h1>" +
    '<div class="row wrap"><span class="chip">' + fmtDate(l.created_at) + "</span>" + (l.duration ? '<span class="chip">' + fmtDur(l.duration) + "</span>" : "") +
    '<span class="chip">' + LANG_NAME[l.lang] + "</span>" + (l.summary_model ? '<span class="chip">' + esc(l.summary_model) + "</span>" : "") + "</div></section>";
  if (live && live.status !== "done") html += jobCard(live);
  if (!segments.length){
    if (!live || live.status === "done") html += '<div class="note">還沒有逐字稿。</div>';
    return html + lectureMenu(l);
  }
  html += '<div class="seg" role="group">' + [["sum", "摘要"], ["tr", "逐字稿"], ["ask", "提問"]].map(o => '<button data-act="lec-tab" data-v="' + o[0] + '" aria-pressed="' + (S.lecTab === o[0]) + '">' + o[1] + "</button>").join("") + "</div>";
  if (S.lecTab === "tr") html += transcriptHTML(segments);
  else if (S.lecTab === "ask") html += lectureAskHTML(l);
  else html += summaryHTML(l);
  return html + lectureMenu(l);
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
  if (!s) return '<section class="card"><div class="note warn">還沒有 AI 摘要。到「設定」選好「課程摘要」要用的模型，再按下面的「重新摘要」。</div></section>';
  let html = "";
  if (s.overview) html += '<section class="card"><div class="label">總覽</div><p style="margin:0;line-height:1.8">' + esc(s.overview) + "</p></section>";
  if ((s.sections || []).length){
    html += '<section class="card"><div class="label">單元（點時間直接聽）</div><div class="stack">' + s.sections.map(sec =>
      '<div class="sec"><h3>' + timeBtn(sec.start) + "<span>" + esc(sec.title) + "</span></h3>" +
      (sec.summary ? '<div class="small" style="line-height:1.7">' + esc(sec.summary) + "</div>" : "") +
      (sec.points || []).map(p => '<div class="pt">' + timeBtn(p.t) + "<span>" + esc(p.text) + "</span></div>").join("") + "</div>").join("") + "</div></section>";
  }
  if ((s.details || []).length){
    html += '<section class="card"><div class="label">教授提到的細節</div><div class="stack">' + s.details.map(d =>
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
    '<div class="tiny muted">' + (f ? "找到 " + list.length + " 段" : segs.length + " 段 · 點一段從那裡開始聽") + '</div><div id="tr-list">' +
    list.map(s => '<button class="seg-line" data-act="seek" data-t="' + s.t0 + '" data-i="' + s.idx + '"><span class="tt">' + fmtT(s.t0) + "</span><span>" + esc(s.text) + "</span></button>").join("") + "</div></section>";
}
function lectureAskHTML(l){
  const r = S.ask.lec && S.ask.lec.lid === l.id ? S.ask.lec : null;
  return '<section class="card"><div class="label">只問這堂課</div><textarea class="input" id="lec-q" rows="2" placeholder="教授怎麼解釋…？他舉了什麼例子？" data-draft="lecq">' + esc(S.ask.lecDraft || "") + "</textarea>" +
    '<button class="btn block green" data-act="ask-lec"' + (S.busy.askLec ? " disabled" : "") + ">" + (S.busy.askLec ? '<span class="spinner"></span>找答案中…' : "問") + "</button>" +
    (S.err.askLec ? '<div class="err">' + esc(S.err.askLec) + "</div>" : "") + "</section>" + (r ? answerHTML(r, "lec") : "");
}
function lectureMenu(l){
  return '<section class="card flat"><div class="label">這堂課</div><div class="row wrap">' +
    (l.summary ? '<button class="btn soft sm" data-act="lec-tts">' + ICON.speaker + "朗讀摘要</button>" : "") +
    '<button class="btn soft sm" data-act="lec-export">' + ICON.down + "匯出 Markdown</button>" +
    '<button class="btn soft sm" data-act="lec-resum">' + ICON.spark + "重新摘要</button>" +
    '<button class="btn soft sm" data-act="lec-edit">' + ICON.edit + "編輯資料</button>" +
    '<button class="btn soft sm" data-act="lec-retrans">重新轉逐字稿</button>' +
    '<button class="btn ghost sm" data-act="lec-del" style="color:var(--danger)">' + ICON.trash + "刪除</button></div>" +
    '<div class="tiny muted">換了模型或補了術語，可以「重新摘要」；辨識錯字很多，補術語後「重新轉逐字稿」。</div></section>';
}
function lectureEditSheet(l){
  openSheet('<h2>編輯課程資料</h2>' +
    '<div class="field"><label for="le-course">課程名稱</label><input class="input" id="le-course" value="' + esc(l.course) + '"></div>' +
    '<div class="field"><label for="le-title">這堂課</label><input class="input" id="le-title" value="' + esc(l.title) + '"></div>' +
    '<div class="field"><label for="le-terms">課程術語</label><textarea class="input" id="le-terms" rows="3">' + esc(l.terms) + "</textarea></div>" +
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
