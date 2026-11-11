/* =====================================================================
   學習筆記｜Cloudflare Worker「study-api」（網址 https://study-api.natursai.com）

   手機只跟這裡說話：
     POST /login {password}  → 登入，拿到 30 天有效的通行證
     其他所有路徑            → 檢查通行證後，轉給你的電腦（ORIGIN），
                               並加上電腦密碼（STUDY_KEY）。手機永遠不知道電腦的網址和密碼。

   設定（Cloudflare → Workers → study-api → Settings → Variables and Secrets）：
     ORIGIN          變數   https://study-pc.natursai.com（電腦視窗上顯示的網址）
     ALLOW_ORIGIN    變數   https://study.natursai.com（App 的網址，逗號分隔可填多個）
     STUDY_PASSWORD  Secret 你登入 App 用的密碼（長一點）
     STUDY_KEY       Secret 電腦視窗上顯示的「電腦密碼」
     TOKEN_SECRET    Secret 隨便一長串亂碼（簽通行證用）
   ===================================================================== */

const TOKEN_DAYS = 30;
const enc = new TextEncoder();

function b64url(buf) {
  const s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
async function sha(s) { return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s))).slice(0, 12); }
function sameText(a, b) {
  /* constant-time compare */
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

/* 通行證 = base64url({exp, pv}) + "." + 簽章；改密碼（pv 變了）舊的通行證就失效 */
async function makeToken(env) {
  const body = b64url(enc.encode(JSON.stringify({exp: Date.now() + TOKEN_DAYS * 864e5, pv: await sha(env.STUDY_PASSWORD)})));
  return body + "." + await hmac(env.TOKEN_SECRET, body);
}
async function checkToken(env, token) {
  if (!token || token.indexOf(".") < 0) return false;
  const [body, sig] = token.split(".");
  if (!sameText(sig, await hmac(env.TOKEN_SECRET, body))) return false;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    return p.exp > Date.now() && p.pv === await sha(env.STUDY_PASSWORD);
  } catch (e) { return false; }
}

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (allowed[0] || "null"),
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(req, env, status, obj) {
  return new Response(JSON.stringify(obj), {status, headers: {...cors(req, env), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {status: 204, headers: cors(req, env)});
    for (const k of ["STUDY_PASSWORD", "STUDY_KEY", "TOKEN_SECRET", "ORIGIN"]) {
      if (!env[k]) return json(req, env, 503, {ok: false, error: "Worker 還沒設定 " + k, setup: true});
    }

    if (url.pathname === "/login" && req.method === "POST") {
      let b = {};
      try { b = await req.json(); } catch (e) {}
      if (!sameText(b.password || "", env.STUDY_PASSWORD)) {
        await new Promise(r => setTimeout(r, 1200));           // 放慢猜密碼
        return json(req, env, 401, {ok: false, error: "密碼不對"});
      }
      return json(req, env, 200, {ok: true, token: await makeToken(env), days: TOKEN_DAYS});
    }

    /* 通行證：一般請求放在 Authorization；<audio> 這種不能帶 header 的，放在 ?t= */
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("t");
    if (!await checkToken(env, token)) return json(req, env, 401, {ok: false, error: "請重新登入", relogin: true});
    if (url.pathname === "/me") return json(req, env, 200, {ok: true});

    /* 轉給電腦 */
    const q = new URLSearchParams(url.search);
    q.delete("t");
    const target = env.ORIGIN.replace(/\/+$/, "") + url.pathname + (q.toString() ? "?" + q.toString() : "");
    const headers = new Headers();
    headers.set("X-Study-Key", env.STUDY_KEY);
    for (const h of ["Content-Type", "Content-Length", "Range"]) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {         // 選用：電腦網址前面再加 Cloudflare Access
      headers.set("CF-Access-Client-Id", env.ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.ACCESS_CLIENT_SECRET);
    }
    let r;
    try {
      r = await fetch(target, {method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body, redirect: "manual"});
    } catch (e) {
      return json(req, env, 502, {ok: false, error: "連不到電腦", offline: true});
    }
    if (r.status >= 520 || r.status === 502 || r.status === 530) {
      return json(req, env, 502, {ok: false, error: "連不到電腦：確認電腦開著、「啟動學習伺服器」視窗也開著", offline: true});
    }
    const out = new Headers(cors(req, env));
    for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition", "Cache-Control"]) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(r.body, {status: r.status, headers: out});
  }
};
