"use strict";
/* =========================================================
   分塊上傳：手機 → Worker → 電腦。每塊 32 MB（Cloudflare 一次最多 100 MB），
   斷線會自動重傳那一塊；網頁沒關的話可以一直續傳。
   ========================================================= */
const Up = {
  async start(file, kind, meta){
    const u = {key: Date.now() + Math.random(), name: file.name, size: file.size, kind, meta, sent: 0, state: "start", err: "", file};
    S.uploads.push(u);
    renderSoon();
    try {
      const st = await api("/uploads", {json: {name: file.name, size: file.size, kind, meta}});
      u.id = st.id; u.chunk = st.chunk; u.total = st.total;
      await this.run(u);
    } catch (e) {
      u.state = "error"; u.err = errMsg(e);
      renderSoon();
    }
    return u;
  },
  async run(u){
    u.state = "sending"; u.err = ""; renderSoon();
    let done = [];
    try { done = (await api("/uploads/" + u.id)).received || []; } catch (e) {}
    u.sent = done.length * u.chunk;
    for (let i = 0; i < u.total; i++){
      if (done.includes(i)) continue;
      const blob = u.file.slice(i * u.chunk, Math.min(u.size, (i + 1) * u.chunk));
      let tries = 0;
      for (;;){
        try {
          await this.put(u, i, blob);
          break;
        } catch (e) {
          if (e.relogin || ++tries >= 5) throw e;
          u.err = "第 " + (i + 1) + " 塊沒傳成功，" + (tries * 3) + " 秒後重試…"; renderSoon();
          await new Promise(r => setTimeout(r, tries * 3000));
          u.err = "";
        }
      }
    }
    u.state = "finishing"; renderSoon();
    const r = await api("/uploads/" + u.id + "/finish", {method: "POST"});
    u.state = "done"; u.sent = u.size; u.result = r; u.file = null;
    toast(u.kind === "lecture" ? "上傳完成，電腦開始處理這支影片" : "上傳完成，電腦開始讀這本書");
    pollJobs(true);
    if (u.kind === "book"){ S.books = null; if (S.sub && S.sub.type === "book") loadBook(); }
    if (u.kind === "lecture"){ S.lectures = null; loadLectures(); }
    setTimeout(() => { S.uploads = S.uploads.filter(x => x !== u); renderSoon(); }, 4000);
    renderSoon();
  },
  /* 用 XHR 才看得到上傳進度 */
  put(u, i, blob){
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", S.api + "/uploads/" + u.id + "/" + i);
      x.setRequestHeader("Authorization", "Bearer " + S.token);
      x.setRequestHeader("Content-Type", "application/octet-stream");
      const base = u.sent;
      x.upload.onprogress = e => { u.cur = base + e.loaded; renderSoon(); };
      x.onload = () => {
        let j = {};
        try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status === 401 && j.relogin){ logout(true); return reject(Object.assign(new Error("請重新登入"), {relogin: true})); }
        if (x.status >= 200 && x.status < 300 && j.ok){ u.sent = base + blob.size; u.cur = u.sent; resolve(); }
        else reject(new Error(j.error || "上傳失敗（" + x.status + "）"));
      };
      x.onerror = () => reject(new Error("網路中斷"));
      x.send(blob);
    });
  },
  retry(key){
    const u = S.uploads.find(x => String(x.key) === String(key));
    if (!u || !u.file) return;
    (u.id ? this.run(u) : (S.uploads = S.uploads.filter(x => x !== u), this.start(u.file, u.kind, u.meta)))
      .catch(e => { u.state = "error"; u.err = errMsg(e); renderSoon(); });
  }
};

function uploadsHTML(kind){
  const list = S.uploads.filter(u => !kind || u.kind === kind);
  if (!list.length) return "";
  return '<div class="stack">' + list.map(u => {
    const frac = (u.cur || u.sent || 0) / (u.size || 1);
    const label = {start: "準備上傳", sending: "上傳中 " + Math.floor(frac * 100) + "%", finishing: "電腦正在組合檔案…", done: "上傳完成", error: "上傳失敗"}[u.state];
    return '<div class="up"><div class="row between"><b class="grow clamp2 small">' + esc(u.name) + '</b><span class="tiny muted">' + fmtSize(u.size) + "</span></div>" +
      progressBar(u.state === "done" ? 1 : frac, true) +
      '<div class="row between"><span class="small ' + (u.state === "error" ? "" : "muted") + '">' + label + (u.err ? "：" + esc(u.err) : "") + "</span>" +
      (u.state === "error" && u.file ? '<button class="btn sm" data-act="up-retry" data-key="' + u.key + '">重試</button>' : "") + "</div></div>";
  }).join("") + "</div>";
}

/* 上傳中一直重畫會太頻繁：每 250ms 最多一次 */
function renderSoon(){
  if (renderSoon.t) return;
  renderSoon.t = setTimeout(() => {
    renderSoon.t = null;
    const a = document.activeElement;
    /* 正在打字就先不要重畫，等一下再說 */
    if (a && $("#main").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "range"){ renderMini(); return renderSoon(); }
    render();
  }, 250);
}

/* 照片先縮到 2000px 再傳，省流量也比較快 */
function shrinkImage(file, max){
  max = max || 2000;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => { URL.revokeObjectURL(img.src); resolve(b || file); }, "image/jpeg", 0.88);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}
