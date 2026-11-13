"use strict";
/* =========================================================
   想讀：選書評估。給書名／作者／ISBN（或拍封面、條碼），
   電腦上網找評價和作者資料，AI 寫成評估卡：
   可信度燈號（防唬爛）＋讀者心得＋適不適合你＋結論
   ========================================================= */
const LIGHT = {green: ["可信", "green", "🟢"], yellow: ["留意", "yellow", "🟡"], red: ["警訊", "red", "🔴"], unknown: ["資料不足", "", "⚪"]};
const VERDICT = {read: ["值得讀", "green"], skim: ["挑章節讀", "yellow"], skip: ["可以跳過", "red"]};

function wishSheet(pre){
  pre = pre || {};
  const ev = pre.evaluate == null ? true : pre.evaluate;
  openSheet('<h2>新增一本書</h2><div class="small muted">拍封面或條碼自動認書，也可以直接打書名。</div>' +
    (S.busy.identify ? '<div class="btn soft block" aria-busy="true"><span class="spinner"></span>辨識中…</div>'
      : '<button class="btn soft block" data-act="cam-open">' + ICON.camera + "拍封面／ISBN 條碼</button>") +
    '<div class="field"><label for="w-title">書名</label><input class="input" id="w-title" value="' + esc(pre.title || "") + '" placeholder="被討厭的勇氣"></div>' +
    '<div class="row"><div class="field grow"><label for="w-author">作者</label><input class="input" id="w-author" value="' + esc(pre.author || "") + '"></div>' +
    '<div class="field" style="width:44%"><label for="w-isbn">ISBN（選填）</label><input class="input en" id="w-isbn" inputmode="numeric" value="' + esc(pre.isbn || "") + '"></div></div>' +
    '<label class="check"><input type="checkbox" id="w-eval"' + (ev ? " checked" : "") + '><span><b>加入後評估這本書</b><span class="small muted">上網找讀者心得和作者背景，約 1～3 分鐘。已經在讀的書可以不勾。</span></span></label>' +
    '<div class="field" id="w-note-box"' + (ev ? "" : " hidden") + '><label for="w-note">為什麼想讀（選填，判斷「適不適合你」會參考）</label><textarea class="input" id="w-note" rows="2" placeholder="朋友推薦／想了解某個主題">' + esc(pre.wish_note || "") + "</textarea></div>" +
    '<button class="btn block" data-act="wish-create">加入</button>');
}

function evidenceSheet(b){
  openSheet('<h2>補充資料</h2><div class="small muted">微信讀書的點評、朋友的心得，網路上找不到的都可以貼在這裡，評估時會一起看。</div>' +
    '<button class="btn soft block" data-act="pick-evid">' + (S.busy.evid ? '<span class="spinner"></span>辨識中…' : ICON.camera + "拍或選截圖（自動辨識文字）") + "</button>" +
    '<textarea class="input" id="evid-text" rows="9" placeholder="貼上文字，或用上面的按鈕從截圖辨識">' + esc(b.user_evidence || "") + "</textarea>" +
    '<div class="row"><button class="btn soft grow" data-act="evid-save">只儲存</button><button class="btn grow" data-act="evid-save" data-eval="1">儲存並重新評估</button></div>');
}

/* 評估卡裡的 [3]、[K2]、[U] 變成可以點的小標籤 */
function evalCite(text){
  return esc(text || "").replace(/\[(\d{1,2}|K\d{1,2}|U)\]/g, (m, n) => '<button class="cite' + (n[0] === "K" ? " k" : n === "U" ? " u" : "") + '" data-act="esrc" data-n="' + n + '">' + n + "</button>");
}
function evalItem(x){ return evalCite(x.text) + (x.src ? " " + evalCite(x.src) : ""); }

const SHELF = {wish: "想讀", reading: "在讀", done: "讀完"};

/* 書頁裡的「網路評價」：沒評估 → 一個按鈕；評估好了 → 一張小卡，點開看完整評估 */
function evalSection(b, live){
  const ev = b.evaluation, running = live && (live.status === "queued" || live.status === "running");
  let html = '<section class="card evalbox"><div class="row between"><div class="label">網路評價</div><span class="tiny muted">別人怎麼說、作者可不可信</span></div>';
  if (running || (live && live.status === "error")) html += jobCard(live);
  if (!ev){
    if (!running) html += '<div class="small muted">上網找讀者心得、書評和作者背景，判斷值不值得讀（約 1～3 分鐘）。</div>' +
      '<div class="row wrap"><button class="btn grow" data-act="evaluate" data-id="' + b.id + '">' + ICON.spark + "評估這本書</button>" +
      '<button class="btn soft" data-act="evid-open">補充資料' + (b.user_evidence ? "（有）" : "") + "</button></div>";
    return html + "</section>";
  }
  const L0 = LIGHT[ev.credibility.light] || LIGHT.unknown, V0 = VERDICT[ev.verdict.level] || VERDICT.skim;
  html += '<button class="list-row evalcard" data-act="eval-toggle"><span class="ic yellow">' + L0[2] + '</span><span class="t"><b>' + V0[0] + " · " + L0[0] +
    '</b><span class="sub">' + esc(ev.credibility.headline || ev.reception.headline || "") + '</span></span><span class="chev">›</span></button>';
  return html + "</section>";
}

/* 評估的專屬頁 */
function renderEval(){
  if (!S.book || S.book.book.id !== S.sub.id) return pageTop("網路評價") + loading();
  const b = S.book.book, ev = b.evaluation;
  const live = (S.jobs || []).find(j => j.ref_id === b.id && j.kind === "evaluate" && j.status !== "done");
  const running = live && (live.status === "queued" || live.status === "running");
  let html = pageTop("網路評價", ev ? '<button class="btn soft sm" data-act="read-eval">' + ICON.speaker + "朗讀</button>" +
      '<button class="btn soft sm" data-act="evaluate" data-id="' + b.id + '"' + (running ? " disabled" : "") + ">" + ICON.spark + "重新評估</button>" +
      '<button class="btn soft sm" data-act="evid-open">補充資料' + (b.user_evidence ? "（有）" : "") + "</button>" : "");
  if (live) html += jobCard(live);
  if (!ev) return html + evalSection(b, live);
  return html + '<div class="stack" id="eval-body" data-read="《' + esc(b.title) + '》網路評價">' + evalDetail(b, ev) + "</div>";
}

function evalDetail(b, ev){
  let html = "";
  const L = LIGHT[ev.credibility.light] || LIGHT.unknown, V = VERDICT[ev.verdict.level] || VERDICT.skim;
  html += '<section class="card verdict ' + V[1] + '" data-read="《' + esc(b.title) + '》評估"><div class="row between"><div class="label">結論</div><span class="chip ' + V[1] + '" style="font-size:15px">' + V[0] + "</span></div>" +
    '<p style="margin:0;line-height:1.75">' + evalCite(ev.verdict.text) + "</p>" +
    (ev.book.summary ? '<div class="small muted">' + evalCite(ev.book.summary) + "</div>" : "") + "</section>";

  html += '<section class="card"><div class="row between"><div class="label">可信度（防唬爛）</div><span class="chip ' + L[1] + '">' + L[2] + " " + L[0] + "</span></div>" +
    (ev.credibility.headline ? "<b>" + evalCite(ev.credibility.headline) + "</b>" : "") +
    (ev.credibility.author ? '<div class="pt"><span class="kind">作者</span><span>' + evalCite(ev.credibility.author) + "</span></div>" : "") +
    (ev.credibility.reasons.length ? '<ul class="ev-list">' + ev.credibility.reasons.map(x => "<li>" + evalItem(x) + "</li>").join("") + "</ul>" : "") + "</section>";

  const R = ev.reception;
  html += '<section class="card"><div class="label">讀者怎麼說</div>' + (R.headline ? "<b>" + evalCite(R.headline) + "</b>" : "") +
    (R.ratings.length ? '<div class="row wrap">' + R.ratings.map(r => '<span class="chip blue">' + esc(r.site) + " " + esc(r.score) + (r.count ? "（" + esc(r.count) + "）" : "") + "</span>" + evalCite(r.src)).join("") + "</div>" : "") +
    (R.pros.length ? '<div class="pref-h">收穫</div><ul class="ev-list pro">' + R.pros.map(x => "<li>" + evalItem(x) + "</li>").join("") + "</ul>" : "") +
    (R.cons.length ? '<div class="pref-h">失望的地方</div><ul class="ev-list con">' + R.cons.map(x => "<li>" + evalItem(x) + "</li>").join("") + "</ul>" : "") + "</section>";

  if (ev.fit && ev.fit.text) html += '<section class="card"><div class="row between"><div class="label">適合你嗎</div>' + (ev.fit.relation ? '<span class="chip green">' + esc(ev.fit.relation) + "</span>" : "") + "</div>" +
    '<p style="margin:0;line-height:1.75">' + evalCite(ev.fit.text) + "</p></section>";
  if ((ev.alternatives || []).length) html += '<section class="card"><div class="label">也可以考慮</div><div class="stack">' + ev.alternatives.map(a =>
    '<div class="pt"><span>📘</span><span><b>' + esc(a.title) + "</b>" + (a.author ? "　" + esc(a.author) : "") + (a.why ? '<div class="small muted">' + evalCite(a.why) + "</div>" : "") + "</span></div>").join("") + "</div></section>";
  if ((ev.gaps || []).length) html += '<section class="card flat"><div class="label">還缺的資料</div><ul class="ev-list">' + ev.gaps.map(g => "<li>" + esc(g) + "</li>").join("") + "</ul>" +
    '<div class="small muted">有這方面的資料（例如微信讀書的點評），可以按「補充資料」貼進來再評估一次。</div></section>';

  const st = ev.stats || {};
  html += '<section class="card"><details><summary class="adv-sum"><b>來源（' + (ev.sources || []).length + "）</b>" +
    '<span class="small muted">　搜尋 ' + (st.searched || 0) + " 次・讀了 " + (st.fetched || 0) + " 頁・" + (st.blocked || 0) + " 頁讀不到</span></summary>" +
    '<div class="stack" style="margin-top:12px">' + (ev.sources || []).map(srcLine).join("") + "</div></details>" +
    '<div class="tiny muted">' + esc(ev.model || "") + " · " + esc(ev.at || "") + "</div></section>";
  return html;
}

function srcLine(s){
  return '<a class="src" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer"><span class="n">' + s.n + '</span><span class="body"><span class="lbl">' + esc(s.title) + '</span>' +
    '<div class="snip">' + esc(s.domain) + " · " + ({review: "評價", author: "作者", critique: "批評"}[s.category] || "") + " · " + (s.fetched ? "已讀全文" : "只看到摘要" + (s.why ? "（" + esc(s.why) + "）" : "")) + "</div></span></a>";
}

function evalSourceSheet(n){
  const ev = S.book && S.book.book.evaluation;
  if (!ev) return;
  if (n === "U") return openSheet('<div class="label">你補充的資料</div><div class="thought">' + esc(S.book.book.user_evidence || "") + "</div>");
  if (n[0] === "K"){
    const k = (ev.notes || []).find(x => "K" + x.k === n);
    if (!k) return;
    const act = k.kind === "lecture" ? '<button class="btn block green" data-act="open-lecture" data-id="' + k.lecture_id + '" data-t="' + (k.t0 || 0) + '">' + ICON.play + "從 " + fmtT(k.t0) + " 開始聽</button>"
      : k.book_id ? '<button class="btn block" data-act="open-book" data-id="' + k.book_id + '">打開這本書</button>' : "";
    return openSheet('<div class="label">你的知識庫 [' + n + "]</div><h3>" + esc(k.label) + '</h3><div class="thought">' + esc(k.text) + "</div>" + act);
  }
  const s = (ev.sources || []).find(x => String(x.n) === n);
  if (!s) return;
  openSheet('<div class="label">來源 [' + n + "]・" + esc(s.domain) + "</div><h3>" + esc(s.title) + "</h3>" +
    (s.snippet ? '<div class="quote">' + esc(s.snippet) + "</div>" : "") +
    '<div class="small muted">' + (s.fetched ? "電腦已讀過這頁的正文" : "只看到搜尋摘要" + (s.why ? "（" + esc(s.why) + "）" : "")) + "</div>" +
    '<a class="btn block" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">打開網頁 ↗</a>');
}

/* 先試手機內建的條碼辨識（不用花 AI），讀不到再請 AI 看封面 */
async function identifyCover(file){
  try {
    if ("BarcodeDetector" in window){
      const bd = new BarcodeDetector({formats: ["ean_13"]});
      const bmp = await createImageBitmap(file);
      const codes = await bd.detect(bmp);
      const isbn = (codes.map(c => c.rawValue).find(v => /^97[89]\d{10}$/.test(v)) || "");
      if (isbn){
        const r = await api("/lookup?isbn=" + isbn);
        if (r.book.title) return Object.assign({isbn}, r.book);
      }
    }
  } catch (e) {}
  const blob = await shrinkImage(file, 1600);
  const r = (await api("/identify", {method: "POST", body: blob, headers: {"Content-Type": "image/jpeg"}})).book;
  if (r.cover_photo) r.photo = blob;          // 拍到的是封面：留著，加入書之後拿去核對網路上找到的封面
  return r;
}

/* ---------- 相機：全螢幕取景，Android 對準條碼會自動認 ---------- */
const CAM = {
  stream: null, timer: 0, busy: false,
  async open(){
    S.wishKeep = wishForm();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ $("#pick-cover").value = ""; return $("#pick-cover").click(); }
    const box = document.createElement("div");
    box.id = "cam";
    box.innerHTML = '<div class="cam-top"><button class="btn ghost back" data-act="cam-close" aria-label="返回">' + ICON.back + '</button><b>拍封面／ISBN</b></div>' +
      '<div class="cam-view"><video playsinline muted autoplay></video>' +
      '<div class="cam-frame"><i></i><i></i><i></i><i></i></div>' +
      '<div class="cam-hint">' + ("BarcodeDetector" in window ? "對準條碼會自動辨識，或拍下封面" : "拍下封面或條碼") + "</div>" +
      '<div class="cam-bar"><button class="cam-lib" data-act="cam-lib"><span>🖼️</span>相簿</button>' +
      '<button class="cam-shot" data-act="cam-shot" aria-label="拍照"><span></span></button><span class="cam-lib ghost"></span></div></div>';
    document.body.appendChild(box);
    try {
      CAM.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1080}}});
      const v = box.querySelector("video");
      v.srcObject = CAM.stream;
      await v.play().catch(() => {});
      CAM.scan(v);
    } catch (e) {
      CAM.close();
      toast("打不開相機，改用手機的拍照");
      $("#pick-cover").value = ""; $("#pick-cover").click();
    }
  },
  scan(v){
    if (!("BarcodeDetector" in window)) return;
    let bd;
    try { bd = new BarcodeDetector({formats: ["ean_13"]}); } catch (e) { return; }
    const tick = async () => {
      if (!CAM.stream || CAM.busy) return;
      try {
        const codes = await bd.detect(v);
        const isbn = codes.map(c => c.rawValue).find(x => /^97[89]\d{10}$/.test(x));
        if (isbn){ if (navigator.vibrate) navigator.vibrate(60); CAM.close(); return coverDone(api("/lookup?isbn=" + isbn).then(r => Object.assign({isbn}, r.book))); }
      } catch (e) {}
      CAM.timer = setTimeout(tick, 350);
    };
    CAM.timer = setTimeout(tick, 500);
  },
  shot(){
    const v = $("#cam video");
    if (!v || !v.videoWidth) return;
    CAM.busy = true;
    const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(b => { CAM.close(); coverDone(identifyCover(b)); }, "image/jpeg", 0.88);
  },
  close(){
    clearTimeout(CAM.timer);
    if (CAM.stream) CAM.stream.getTracks().forEach(t => t.stop());
    CAM.stream = null; CAM.busy = false;
    const box = $("#cam"); if (box) box.remove();
  },
};

function wishForm(){
  const g = id => ($(id) ? $(id).value : "");
  return {title: g("#w-title"), author: g("#w-author"), isbn: g("#w-isbn"), wish_note: g("#w-note"), evaluate: $("#w-eval") ? $("#w-eval").checked : true};
}

/* 辨識完把結果填回「加入想讀」 */
async function coverDone(promise){
  const keep = S.wishKeep || wishForm();
  S.busy.identify = true; wishSheet(keep);
  try {
    const r = await promise;
    S.busy.identify = false;
    if (r.photo) S.coverPhoto = r.photo;
    wishSheet({title: r.title || keep.title, author: r.author || keep.author, isbn: r.isbn || keep.isbn, wish_note: keep.wish_note, evaluate: keep.evaluate});
    toast(r.title ? "認出來了，確認一下" : r.isbn ? "讀到 ISBN，但查不到書名，請手動輸入書名" : "沒認出來，請拍清楚一點或手動輸入");
  } catch (err) { S.busy.identify = false; wishSheet(keep); toast(errMsg(err)); }
}
