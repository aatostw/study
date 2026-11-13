/* =========================================================
   App 切換：點左上角 Logo，在「學習筆記」和「每日英文練習」之間切換
   （兩個 app 共用這個檔案）
   ========================================================= */
const APP_LOGO = {
  study: '<svg viewBox="0 0 30 30" aria-hidden="true"><path d="M15 8.2C11.2 5.6 6.8 5 3 6.1v17.8c3.8-1.1 8.2-.5 12 2.1z" fill="#39648D"/><path d="M15 8.2c3.8-2.6 8.2-3.2 12-2.1v17.8c-3.8-1.1-8.2-.5-12 2.1z" fill="#48A88B"/><path d="M19.6 3.6h4.2v8.6l-2.1-1.7-2.1 1.7z" fill="#F3CC58"/></svg>',
  english: '<svg viewBox="0 0 30 30" aria-hidden="true"><rect x="2" y="7" width="17" height="19" rx="5" fill="#39648D"/><rect x="10" y="3" width="17" height="19" rx="5" fill="#48A88B"/><circle cx="23" cy="24" r="4" fill="#F3CC58"/></svg>'
};
const APPS = [
  {id: "study", name: "學習筆記", sub: "書櫃、影片、知識複習、助理", url: "https://study.natursai.com/"},
  {id: "english", name: "每日英文練習", sub: "每日文章、單字、我的城市", url: "https://english.natursai.com/"}
];
const APP_ID = /english/.test(location.hostname) || /英文/.test(document.title) ? "english" : "study";

function appSwitchOpen(){
  appSwitchClose();
  const brand = document.getElementById("brand");
  const r = brand ? brand.getBoundingClientRect() : {left: 12, bottom: 56};
  const wrap = document.createElement("div");
  wrap.id = "appsw";
  wrap.innerHTML = '<div class="appsw-bg"></div><div class="appsw-pop" role="menu" style="left:' + Math.max(8, r.left - 4) + "px;top:" + (r.bottom + 6) + 'px">' +
    '<div class="appsw-h">切換 App</div>' +
    APPS.map(a => '<button class="appsw-row' + (a.id === APP_ID ? " cur" : "") + '" role="menuitem" data-app="' + a.id + '">' +
      '<span class="appsw-ic">' + APP_LOGO[a.id] + '</span><span class="appsw-t"><b>' + a.name + "</b><small>" + a.sub + "</small></span>" +
      (a.id === APP_ID ? '<span class="appsw-cur">使用中</span>' : '<span class="appsw-go">›</span>') + "</button>").join("") + "</div>";
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("on"));
}
function appSwitchClose(){ const w = document.getElementById("appsw"); if (w) w.remove(); }

document.addEventListener("click", e => {
  const row = e.target.closest && e.target.closest("#appsw .appsw-row");
  if (row){
    e.preventDefault(); e.stopPropagation();
    const a = APPS.find(x => x.id === row.dataset.app);
    if (!a || a.id === APP_ID) return appSwitchClose();
    row.classList.add("going");
    location.href = a.url;
    return;
  }
  if (e.target.closest && e.target.closest("#appsw")){ appSwitchClose(); return; }
  if (e.target.closest && e.target.closest("#brand, [data-act=app-switch]")){ e.preventDefault(); e.stopPropagation(); appSwitchOpen(); }
}, true);
document.addEventListener("keydown", e => { if (e.key === "Escape") appSwitchClose(); });
