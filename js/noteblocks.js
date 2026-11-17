"use strict";
/* =========================================================
   筆記的文字／圖片區塊
   - 存的時候還是一段文字：圖片是獨立一行 [[圖片 id=… size=寬x高 w=寬度百分比 crop=x,y,w,h]]
   - 編輯：一塊一塊的文字框和圖片，底部「＋」加文字或圖片
   - 圖片：拖四個角調大小；雙擊（手機點兩下，或點「雙擊裁剪」）開裁剪視窗。裁剪只記範圍，不動原圖，隨時可以重裁
   ========================================================= */
const IMG_RE = /\[\[圖片 ([^\]]*)\]\]/g;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const FULL = [0, 0, 1, 1];

function imgParse(attr){
  const o = {};
  attr.trim().split(/\s+/).forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); });
  const sz = (o.size || "").split("x").map(Number), c = (o.crop || "").split(",").map(Number);
  return {t: "img", id: o.id || "", nw: sz[0] || 1, nh: sz[1] || 1, w: clamp(Number(o.w) || 100, 15, 100),
          c: c.length === 4 && c.every(x => isFinite(x)) && c[2] > 0 && c[3] > 0 ? c : FULL.slice()};
}
function imgToken(b){
  const full = b.c.every((x, i) => Math.abs(x - FULL[i]) < 1e-4);
  return "[[圖片 id=" + b.id + " size=" + b.nw + "x" + b.nh + " w=" + Math.round(b.w) + (full ? "" : " crop=" + b.c.map(x => +x.toFixed(4)).join(",")) + "]]";
}
function toBlocks(text){
  text = text || "";
  const out = [];
  let last = 0;
  for (const m of text.matchAll(IMG_RE)){
    out.push({t: "text", v: text.slice(last, m.index).replace(/^\n/, "").replace(/\n$/, "")});
    out.push(imgParse(m[1]));
    last = m.index + m[0].length;
  }
  out.push({t: "text", v: text.slice(last).replace(/^\n/, "")});
  return out;
}
function fromBlocks(blocks){
  const keep = blocks.filter(b => b.t === "img" ? b.id : b.v.trim());
  return keep.map((b, i) => (i && b.t === "text" && keep[i - 1].t === "text" ? "\n" : "") + (b.t === "img" ? imgToken(b) : b.v.replace(/\s+$/, ""))).join("\n");   // 兩段文字之間空一行
}
function nimgSrc(b){ return b.local || (S.api + "/note-images/" + b.id + "?t=" + encodeURIComponent(S.token)); }

/* 圖片本體：外框照裁剪後的比例，裡面的原圖放大、位移 */
function imgBox(b){
  const [cx, cy, cw, ch] = b.c, ar = (b.nw * cw) / (b.nh * ch);
  return '<span class="nimg-box" style="aspect-ratio:' + ar.toFixed(4) + '"><img src="' + esc(nimgSrc(b)) + '" alt="" draggable="false" style="width:' + (100 / cw).toFixed(3) +
    "%;height:" + (100 / ch).toFixed(3) + "%;left:" + (-cx / cw * 100).toFixed(3) + "%;top:" + (-cy / ch * 100).toFixed(3) + '%"></span>';
}

/* 看的時候：文字照原樣、圖片照大小 */
function noteBody(text, cls){
  cls = cls || "thought";
  if (!text || text.indexOf("[[圖片") < 0) return '<div class="' + cls + '">' + esc(text || "") + "</div>";
  return '<div class="nblocks">' + toBlocks(text).map(b => b.t === "img"
    ? (b.id ? '<figure class="nimg" style="width:' + b.w + '%">' + imgBox(b) + "</figure>" : "")
    : (b.v.trim() ? '<div class="' + cls + '">' + esc(b.v) + "</div>" : "")).join("") + "</div>";
}

/* ---------- 編輯器 ---------- */
function nedNew(text, key, ph){
  let blocks = toBlocks(text).filter(b => b.t === "img" || b.v.trim());
  if (!blocks.length || blocks[0].t === "img") blocks.unshift({t: "text", v: ""});
  return {key, ph: ph || "", blocks, menu: false};
}
function nedText(){ return S.ned ? fromBlocks(S.ned.blocks) : ""; }
function nedBusy(){ return !!(S.ned && S.ned.blocks.some(b => b.up)); }

function nedHTML(){
  const e = S.ned;
  if (!e) return "";
  const many = e.blocks.length > 1;
  return '<div class="ned" id="ned">' + e.blocks.map((b, i) => b.t === "text"
    ? '<div class="ned-row"><textarea class="ned-t" id="ned-t' + i + '" data-i="' + i + '" rows="' + (i === 0 && !many ? 6 : 2) + '" placeholder="' + esc(i === 0 ? e.ph : "繼續寫…") + '">' + esc(b.v) + "</textarea>" +
      (many ? '<button class="ned-x" data-act="ned-del" data-i="' + i + '" aria-label="刪掉這段文字">✕</button>' : "") + "</div>"
    : '<figure class="nimg ed' + (b.up ? " up" : "") + '" data-i="' + i + '" tabindex="0" style="width:' + b.w + '%">' +
      '<button class="nimg-tag" data-act="ned-crop" data-i="' + i + '"' + (b.up ? " disabled" : "") + ">" + (b.up ? "上傳中…" : "雙擊裁剪") + "</button>" +
      imgBox(b) + (b.up ? '<span class="nimg-wait"><span class="spinner"></span></span>' : "") +
      ["nw", "ne", "sw", "se"].map(h => '<span class="nh h-' + h + '" data-h="' + h + '"></span>').join("") +
      '<button class="nimg-del" data-act="ned-del" data-i="' + i + '" aria-label="刪除圖片">' + ICON.trash + "</button></figure>").join("") +
    '<div class="ned-add"><button class="ned-plus" data-act="ned-plus" aria-label="新增" aria-expanded="' + e.menu + '">' + ICON.plus + "</button>" +
    (e.menu ? '<div class="ned-menu"><button data-act="ned-add-text">文字</button><button data-act="ned-add-img">圖片</button></div>' : "") + "</div></div>";
}
function nedRedraw(focus){
  const el = $("#ned");
  if (!el) return;
  const t = document.createElement("div"); t.innerHTML = nedHTML();
  el.replaceWith(t.firstChild);
  document.querySelectorAll(".ned-t").forEach(nedGrow);
  if (focus != null){ const f = $("#ned-t" + focus); if (f) f.focus(); }
}
/* 有改動：記事本頁面編輯中要記成草稿（離開會提醒） */
function nedChanged(){
  if (S.noteEdit && $(".note-edit")) S.noteDraft = {title: ($("#f-title") || {}).value || "", content: nedText()};
}
function nedGrow(t){
  if (typeof FIELD_SIZING !== "undefined" && FIELD_SIZING) return;
  const m = $("#main"), top = m ? m.scrollTop : 0;
  t.style.height = "auto"; t.style.height = (t.scrollHeight + 2) + "px";
  if (m) m.scrollTop = top;
}

/* 按鈕：actions.js 定義 ACT 之後併進去 */
const NED_ACT = {
  "ned-plus": () => { S.ned.menu = !S.ned.menu; nedRedraw(); },
  "ned-add-text": () => {
    const b = S.ned.blocks;
    S.ned.menu = false;
    if (b.length && b[b.length - 1].t === "text" && !b[b.length - 1].v.trim()) return nedRedraw(b.length - 1);
    b.push({t: "text", v: ""}); nedRedraw(b.length - 1);
  },
  "ned-add-img": () => { S.ned.menu = false; nedRedraw(); const p = $("#pick-nimg"); p.value = ""; p.click(); },
  "ned-del": async el => {
    const i = Number(el.dataset.i), b = S.ned.blocks[i];
    if (!b) return;
    if (b.t === "text" && b.v.trim() && !(await confirmBox("刪掉這段文字？", "儲存之前都還可以按「取消」放棄這次修改。", "刪掉", true))) return;
    S.ned.blocks.splice(i, 1);
    if (!S.ned.blocks.length || S.ned.blocks[0].t === "img") S.ned.blocks.unshift({t: "text", v: ""});
    nedRedraw(); nedChanged();
  },
  "ned-crop": el => cropOpen(Number(el.dataset.i))
};

/* 選圖片 → 縮到 2000px → 上傳；先用本機預覽顯示 */
document.addEventListener("change", async e => {
  if (e.target.id !== "pick-nimg" || !S.ned) return;
  const files = [...e.target.files].filter(f => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
  for (const f of files) nedUpload(f);
});
async function nedUpload(f){
  const e = S.ned, bl = e.blocks;
  if (bl.length > 1 && bl[bl.length - 1].t === "text" && !bl[bl.length - 1].v.trim()) bl.pop();
  const blob = await shrinkImage(f, 2000);
  const local = URL.createObjectURL(blob);
  const dim = await new Promise(r => { const im = new Image(); im.onload = () => r([im.naturalWidth, im.naturalHeight]); im.onerror = () => r([4, 3]); im.src = local; });
  const b = {t: "img", id: "", nw: dim[0], nh: dim[1], w: 100, c: FULL.slice(), up: true, local};
  bl.push(b); nedRedraw();
  try {
    const r = await api("/note-images", {method: "POST", body: blob, headers: {"Content-Type": blob.type || "image/jpeg"}});
    Object.assign(b, {id: r.id, nw: r.w, nh: r.h, up: false, local: null});
    setTimeout(() => URL.revokeObjectURL(local), 5000);
  } catch (err) {
    const i = bl.indexOf(b); if (i >= 0) bl.splice(i, 1);
    toast("圖片沒傳上去：" + errMsg(err));
  }
  if (S.ned === e){ nedRedraw(); nedChanged(); }
}

document.addEventListener("input", e => {
  if (!e.target.classList || !e.target.classList.contains("ned-t") || !S.ned) return;
  const b = S.ned.blocks[Number(e.target.dataset.i)];
  if (b) b.v = e.target.value;
  nedGrow(e.target); nedChanged();
});

/* 貼上圖片（電腦截圖直接 Ctrl+V） */
document.addEventListener("paste", e => {
  if (!S.ned || !e.target.closest || !e.target.closest("#ned")) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(nedUpload);
});

/* ---------- 拖角落調大小、雙擊裁剪 ---------- */
const NRS = {fig: null, tap: 0, tapI: -1};
document.addEventListener("pointerdown", e => {
  const h = e.target.closest && e.target.closest(".nimg.ed .nh");
  if (!h || !S.ned) return;
  const fig = h.closest(".nimg"), box = fig.parentElement;
  e.preventDefault();
  NRS.fig = fig; NRS.x = e.clientX; NRS.w0 = fig.getBoundingClientRect().width; NRS.max = box.clientWidth;
  NRS.dir = h.dataset.h.endsWith("w") ? -1 : 1;
  fig.classList.add("resizing");
  try { h.setPointerCapture(e.pointerId); } catch (err) {}
});
document.addEventListener("pointermove", e => {
  if (!NRS.fig) return;
  const px = clamp(NRS.w0 + (e.clientX - NRS.x) * NRS.dir, NRS.max * .15, NRS.max);
  NRS.fig.style.width = (px / NRS.max * 100).toFixed(1) + "%";
});
["pointerup", "pointercancel"].forEach(ev => document.addEventListener(ev, e => {
  if (NRS.fig){
    const fig = NRS.fig, b = S.ned && S.ned.blocks[Number(fig.dataset.i)];
    NRS.fig = null; fig.classList.remove("resizing");
    if (b){ b.w = clamp(Math.round(parseFloat(fig.style.width)), 15, 100); fig.style.width = b.w + "%"; nedChanged(); }
    return;
  }
  /* 手機點兩下 = 雙擊 */
  if (ev !== "pointerup" || e.pointerType === "mouse") return;
  const fig = e.target.closest && e.target.closest(".nimg.ed");
  if (!fig || e.target.closest("button, .nh")) return;
  const i = Number(fig.dataset.i), now = Date.now();
  if (NRS.tapI === i && now - NRS.tap < 350){ NRS.tap = 0; cropOpen(i); }
  else { NRS.tap = now; NRS.tapI = i; }
}));
document.addEventListener("dblclick", e => {
  const fig = e.target.closest && e.target.closest(".nimg.ed");
  if (fig && !e.target.closest("button, .nh")){ e.preventDefault(); cropOpen(Number(fig.dataset.i)); }
});
document.addEventListener("keydown", e => {
  const fig = document.activeElement;
  if (!fig || !fig.classList || !fig.classList.contains("ed") || !S.ned) return;
  if (e.key === "Delete" || e.key === "Backspace"){ e.preventDefault(); ACT["ned-del"]({dataset: {i: fig.dataset.i}}); }
  if (e.key === "Enter"){ e.preventDefault(); cropOpen(Number(fig.dataset.i)); }
});

/* ---------- 裁剪視窗 ---------- */
const CROP = {i: -1, r: null, drag: null};
function cropOpen(i){
  const b = S.ned && S.ned.blocks[i];
  if (!b || b.t !== "img" || b.up || $("#crop-ov")) return;
  CROP.i = i; CROP.r = b.c.slice();
  const ov = document.createElement("div");
  ov.className = "crop-ov"; ov.id = "crop-ov";
  ov.innerHTML = '<div class="crop-card" role="dialog" aria-modal="true" aria-label="裁剪圖片"><div class="row between"><h3>裁剪圖片</h3><span class="tiny muted">拖曳角落調整裁剪範圍</span></div>' +
    '<div class="crop-stage" style="aspect-ratio:' + b.nw + "/" + b.nh + ";width:min(100%,calc(62vh*" + (b.nw / b.nh).toFixed(4) + '))"><img src="' + esc(nimgSrc(b)) + '" alt="" draggable="false">' +
    '<div class="crop-rect" id="crop-rect"><i class="g1"></i><i class="g2"></i>' +
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map(h => '<span class="ch h-' + h + '" data-h="' + h + '"></span>').join("") + "</div></div>" +
    '<div class="row crop-acts"><button class="btn soft" id="crop-full">整張</button><span class="grow"></span><button class="btn" id="crop-ok">確認</button><button class="btn soft" id="crop-no">取消</button></div></div>';
  document.body.appendChild(ov);
  cropDraw();
  ov.addEventListener("pointerdown", cropDown);
  ov.addEventListener("click", e => { if (e.target === ov) cropClose(); });
  $("#crop-no").onclick = cropClose;
  $("#crop-full").onclick = () => { CROP.r = FULL.slice(); cropDraw(); };
  $("#crop-ok").onclick = () => {
    const b2 = S.ned && S.ned.blocks[CROP.i];
    if (b2){ b2.c = CROP.r.map(x => +x.toFixed(4)); nedRedraw(); nedChanged(); }
    cropClose();
  };
  $("#crop-ok").focus();
}
function cropClose(){ const ov = $("#crop-ov"); if (ov) ov.remove(); CROP.drag = null; }
function cropDraw(){
  const el = $("#crop-rect"), [x, y, w, h] = CROP.r;
  if (el) el.style.cssText = "left:" + x * 100 + "%;top:" + y * 100 + "%;width:" + w * 100 + "%;height:" + h * 100 + "%";
}
function cropDown(e){
  const rect = e.target.closest(".crop-rect");
  if (!rect) return;
  e.preventDefault();
  const st = $(".crop-stage").getBoundingClientRect();
  CROP.drag = {h: e.target.dataset.h || "move", x: e.clientX, y: e.clientY, r0: CROP.r.slice(), sw: st.width, sh: st.height};
  try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
}
document.addEventListener("pointermove", e => {
  const d = CROP.drag;
  if (!d) return;
  const dx = (e.clientX - d.x) / d.sw, dy = (e.clientY - d.y) / d.sh, MIN = .05;
  let [x, y, w, h] = d.r0, x2 = x + w, y2 = y + h;
  if (d.h === "move"){
    x = clamp(x + dx, 0, 1 - w); y = clamp(y + dy, 0, 1 - h);
    CROP.r = [x, y, w, h];
  } else {
    if (d.h.includes("w")) x = clamp(x + dx, 0, x2 - MIN);
    if (d.h.includes("e")) x2 = clamp(x2 + dx, x + MIN, 1);
    if (d.h.includes("n")) y = clamp(y + dy, 0, y2 - MIN);
    if (d.h.includes("s")) y2 = clamp(y2 + dy, y + MIN, 1);
    CROP.r = [x, y, x2 - x, y2 - y];
  }
  cropDraw();
});
["pointerup", "pointercancel"].forEach(ev => document.addEventListener(ev, () => { CROP.drag = null; }));
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#crop-ov")){ e.stopImmediatePropagation(); cropClose(); } }, true);
