"use strict";
/* =========================================================
   全域狀態、小工具、和伺服器說話
   ========================================================= */
const LS = "study1:";
const DEFAULT_API = "https://study-api.natursai.com";

const S = {
  view: "books", sub: null,                   // sub: {type:"book"|"lecture"|"note", id}
  token: lsGet("token") || "", api: lsGet("api") || DEFAULT_API,
  online: null, status: null,
  books: null, book: null, notes: null, note: null, assist: null, lectures: null, lecture: null, lecTab: "sum", trFilter: "",
  jobs: [], asks: null, ask: {scope: "all", cur: null, busy: false, draft: ""},
  settings: null, models: {}, tts: {parts: [], i: -1, playing: false, lang: null, speed: null, text: "", ready: {}},
  uploads: [], inbox: null, busy: {}, err: {}, sheet: null
};

function lsGet(k){ try { return localStorage.getItem(LS + k); } catch (e) { return null; } }
function lsSet(k, v){ try { if (v == null) localStorage.removeItem(LS + k); else localStorage.setItem(LS + k, v); } catch (e) {} }

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
function fmtT(sec){
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}
function fmtSize(b){ return b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB"; }
function fmtDate(s){
  if (!s) return "";
  const d = new Date(s), now = new Date();
  const md = (d.getMonth() + 1) + "/" + d.getDate();
  return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + "/" + md;
}
function fmtDur(sec){ sec = Math.round(sec || 0); const m = Math.round(sec / 60); return m >= 60 ? Math.floor(m / 60) + " 小時 " + (m % 60) + " 分" : m + " 分鐘"; }

function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3000);
}
function confirmBox(title, body, okLabel, danger){
  return new Promise(resolve => {
    const d = $("#dialog");
    d.innerHTML = '<div class="card" role="alertdialog" aria-modal="true"><h3>' + esc(title) + '</h3><p class="muted" style="margin:0">' + esc(body) + '</p><div class="row" style="justify-content:flex-end"><button class="btn soft" id="dlg-no">取消</button><button class="btn ' + (danger ? "danger" : "") + '" id="dlg-ok">' + esc(okLabel) + "</button></div></div>";
    d.hidden = false;
    const done = v => { d.hidden = true; d.innerHTML = ""; resolve(v); };
    $("#dlg-no").onclick = () => done(false);
    $("#dlg-ok").onclick = () => done(true);
    $("#dlg-ok").focus();
  });
}

/* ---------- API ----------
   全部經過 Cloudflare Worker：它檢查通行證，再轉給你的電腦。 */
class ApiError extends Error {
  constructor(msg, extra){ super(msg); Object.assign(this, extra || {}); }
}
async function api(path, opt){
  opt = opt || {};
  const headers = Object.assign({}, opt.headers || {});
  if (S.token) headers.Authorization = "Bearer " + S.token;
  let body = opt.body;
  if (opt.json !== undefined){ headers["Content-Type"] = "application/json"; body = JSON.stringify(opt.json); }
  let res;
  try {
    res = await fetch(S.api + path, {method: opt.method || (body ? "POST" : "GET"), headers, body, signal: opt.signal});
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    setOnline(false);
    throw new ApiError("網路連不上，確認手機有網路。", {network: true});
  }
  if (opt.raw && res.ok) return res;
  let j = null;
  try { j = await res.json(); } catch (e) {}
  if (res.status === 401 && j && j.relogin){ logout(true); throw new ApiError("請重新登入", {relogin: true}); }
  if (j && j.offline){ setOnline(false); throw new ApiError(j.error || "連不到電腦", {offline: true}); }
  if (!res.ok || !j || j.ok === false){
    throw new ApiError((j && j.error) || ("伺服器錯誤（" + res.status + "）"), {status: res.status, ai: j && j.ai, setup: j && j.setup});
  }
  if (S.online !== true) setOnline(true);
  return j;
}
/* <audio> 不能帶 header，通行證放在網址上（Worker 會拿掉再轉給電腦） */
function apiUrl(path, params){
  const q = new URLSearchParams(params || {});
  q.set("t", S.token);
  return S.api + path + "?" + q.toString();
}
function setOnline(v){
  S.online = v;
  const p = $("#pill");
  if (!p) return;
  p.className = "pill " + (v === true ? "ok" : v === false ? "bad" : "");
  p.textContent = v === true ? "電腦已連線" : v === false ? "連不到電腦" : "連線中";
}
function errMsg(e){ return (e && e.message) || String(e); }

function logout(expired){
  S.token = ""; lsSet("token", null);
  S.books = S.lectures = S.notes = S.asks = S.settings = S.status = null;
  showGate(expired ? "登入過期了，請重新登入。" : "");
}

/* ---------- 畫面 ---------- */
function render(){
  if (!S.token){ showGate(); return; }
  $("#gate").hidden = true;
  $("#tabs").hidden = false;
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-current", t.dataset.v === (TAB_OF[S.view] || S.view) ? "page" : "false"));
  const main = $("#main");
  const key = S.view + "|" + (S.sub ? S.sub.type + S.sub.id : "") + "|" + (S.view === "lectures" ? S.lecTab : "") + "|" + (S.assist || "");
  const keep = render.last === key ? main.scrollTop : 0;
  const fn = S.sub ? ({book: renderBook, lecture: renderLecture, note: renderNote}[S.sub.type])
    : ({ask: renderAsk, books: renderShelf, mybooks: renderMyBooks, notebook: renderNotebook, lectures: renderLectures, review: renderReview, prefs: renderPrefs}[S.view] || renderShelf);
  const active = document.activeElement, activeId = active && active.id, sel = active && active.selectionStart;
  main.innerHTML = fn();
  main.scrollTop = keep;
  render.last = key;
  if (activeId){ const el = document.getElementById(activeId); if (el && el !== document.body){ el.focus(); try { if (sel != null) el.setSelectionRange(sel, sel); } catch (e) {} } }
  renderMini();
  if (typeof afterRender === "function") afterRender();
}
function go(view, sub){
  S.view = view; S.sub = sub || null;
  const h = "#" + view + (sub ? "/" + sub.type + "/" + sub.id : "");
  if (location.hash !== h){ try { history.pushState(null, "", h); } catch (e) {} }
  render.last = null;
  render();
  load();
}

/* ---------- 抽屜（sheet）---------- */
function openSheet(html){ S.sheet = true; $("#sheet-card").innerHTML = '<div class="grab" aria-hidden="true"></div>' + html; $("#sheet").hidden = false; }
function closeSheet(){ S.sheet = null; $("#sheet").hidden = true; $("#sheet-card").innerHTML = ""; }

/* ---------- 圖示 ---------- */
const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z"/><circle cx="19" cy="19" r="2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
};

/* 把 AI 回答裡的 [3] 變成可以點的小標籤 */
function citeHTML(text, ctx){
  return esc(text).replace(/\[(\d{1,2})\]/g, (m, n) => '<button class="cite" data-act="src" data-ctx="' + ctx + '" data-n="' + n + '">' + n + "</button>");
}
/* AI 回答常用 Markdown（* 條列、1. 編號、**粗體**），轉成正常的條列；其他一律當純文字 */
function richHTML(text, ctx){
  const inline = x => citeHTML(x, ctx).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
  let out = "", list = null;
  const close = () => { if (list){ out += "</" + list + ">"; list = null; } };
  String(text || "").replace(/\r/g, "").split("\n").forEach(raw => {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^[*\-•・]\s+(.*)$/))){ if (list !== "ul"){ close(); out += "<ul>"; list = "ul"; } out += "<li>" + inline(m[1]) + "</li>"; return; }
    if ((m = l.match(/^(\d+)[.)、]\s*(.+)$/))){ if (list !== "ol"){ close(); out += "<ol>"; list = "ol"; } out += "<li>" + inline(m[2]) + "</li>"; return; }
    close();
    if (!l) return;
    if ((m = l.match(/^#{1,6}\s+(.*)$/))){ out += '<p class="rich-h">' + inline(m[1]) + "</p>"; return; }
    out += "<p>" + inline(l) + "</p>";
  });
  close();
  return out;
}
function timeBtn(t){ return t == null ? "" : '<button class="time" data-act="seek" data-t="' + t + '">' + fmtT(t) + "</button>"; }
function progressBar(frac, blue){ return '<div class="progress' + (blue ? " blue" : "") + '"><span style="width:' + Math.round(Math.max(0.02, Math.min(1, frac || 0)) * 100) + '%"></span></div>'; }
