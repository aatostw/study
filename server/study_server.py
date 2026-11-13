# -*- coding: utf-8 -*-
"""
學習筆記｜電腦端伺服器

雙擊「啟動學習伺服器.bat」就會：
  1. 連上資料庫（Docker 裡的 PostgreSQL + pgvector；沒開會自動開）
  2. 在背景準備：課程處理佇列、筆記索引
  3. 開啟只給 Cloudflare Worker 用的固定網址 https://<FIXED_HOST>
  4. 顯示要貼到 Cloudflare 的電腦密碼

設定都在 study_config.py。視窗開著就能用，關掉就停止。
"""
import os
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
sys.path.insert(0, HERE)

from app import config  # noqa: E402

TUNNEL_LOG = os.path.join(HERE, "study_server_tunnel.log")
children = []


class Stop(Exception):
    pass


def say(msg=""):
    print(msg, flush=True)


def tail(path, n=20):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return ""


# ---------- 資料庫 ----------

def check_db():
    import psycopg
    for attempt in range(40):
        try:
            with psycopg.connect(config.DATABASE_URL, connect_timeout=3):
                return
        except Exception as e:
            err = e
        if attempt == 0:
            say("  資料庫還沒開，試著啟動 Docker 裡的 study-db …")
            docker = shutil.which("docker")
            if not docker:
                raise Stop("連不到資料庫，也找不到 Docker。\n請先安裝 Docker Desktop，再雙擊「安裝資料庫.bat」。\n" + str(err)[:300])
            r = subprocess.run([docker, "start", "study-db"], capture_output=True)
            if r.returncode != 0:
                out = (r.stdout + r.stderr).decode("utf-8", "replace")
                if "No such container" in out:
                    raise Stop("還沒建立資料庫。請先雙擊「安裝資料庫.bat」。")
                if "daemon" in out.lower() or "pipe" in out.lower():
                    raise Stop("Docker Desktop 沒有開。請打開 Docker Desktop，等它顯示 Engine running 再重來。")
                raise Stop("資料庫啟動失敗：\n" + out[-500:])
        time.sleep(1.5)
    raise Stop("連不到資料庫：%s" % err)


# ---------- Cloudflare 固定網址 ----------

def find_cloudflared():
    for c in (os.path.join(HERE, "cloudflared.exe"),
              os.path.join(config.GPT_SOVITS_DIR or "", "cloudflared.exe"),
              shutil.which("cloudflared"),
              r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
              r"C:\Program Files\cloudflared\cloudflared.exe"):
        if c and os.path.isfile(c):
            return c
    return None


NO_CLOUDFLARED = ("找不到 cloudflared。請先開「命令提示字元」執行：\n"
                  "  winget install --id Cloudflare.cloudflared\n裝好後再試一次。")


def setup_fixed():
    exe = find_cloudflared()
    if not exe:
        raise Stop(NO_CLOUDFLARED)
    say("1/3 登入 Cloudflare")
    cert = os.path.join(os.path.expanduser("~"), ".cloudflared", "cert.pem")
    if not os.path.isfile(cert):
        say("    瀏覽器會打開，選 %s 然後按 Authorize。" % config.FIXED_HOST.split(".", 1)[-1])
        if subprocess.run([exe, "tunnel", "login"]).returncode != 0:
            raise Stop("Cloudflare 登入沒有完成。")
    else:
        say("    已經登入過了（設定語音伺服器時登入的）。")
    say("2/3 建立通道 %s …" % config.TUNNEL_NAME)
    if subprocess.run([exe, "tunnel", "info", config.TUNNEL_NAME], capture_output=True).returncode != 0:
        if subprocess.run([exe, "tunnel", "create", config.TUNNEL_NAME]).returncode != 0:
            raise Stop("通道建立失敗。")
    else:
        say("    已經建立過了。")
    say("3/3 把 %s 指到這台電腦 …" % config.FIXED_HOST)
    r = subprocess.run([exe, "tunnel", "route", "dns", "--overwrite-dns", config.TUNNEL_NAME, config.FIXED_HOST], capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace")
    if r.returncode != 0 and "already" not in out:
        raise Stop("DNS 設定失敗：\n" + out.strip()[-600:])
    say()
    say("完成！之後雙擊「啟動學習伺服器.bat」，網址都會是 https://%s" % config.FIXED_HOST)


def start_tunnel():
    exe = find_cloudflared()
    if not exe:
        raise Stop(NO_CLOUDFLARED)
    if subprocess.run([exe, "tunnel", "info", config.TUNNEL_NAME], capture_output=True, timeout=40).returncode != 0:
        raise Stop("還沒設定固定網址。請先雙擊「設定固定網址.bat」（只要一次）。")
    say("開啟固定網址 https://%s …" % config.FIXED_HOST)
    p = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:%d" % config.PORT, config.TUNNEL_NAME],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    children.append(p)
    ready = threading.Event()

    def reader():
        with open(TUNNEL_LOG, "wb") as log:
            for line in p.stdout:
                log.write(line)
                log.flush()
                if b"Registered tunnel connection" in line or b"Connection registered" in line:
                    ready.set()
    threading.Thread(target=reader, daemon=True).start()
    for _ in range(60):
        if ready.wait(1) or p.poll() is not None:
            break
    if not ready.is_set():
        raise Stop("固定網址沒有連上。紀錄的最後幾行：\n" + tail(TUNNEL_LOG))
    return "https://" + config.FIXED_HOST


# ---------- 主程式 ----------

def start_api():
    import uvicorn
    from app.api import app
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=config.PORT, log_level="warning",
                                           timeout_keep_alive=30))
    threading.Thread(target=server.run, daemon=True).start()
    import socket
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1", config.PORT), timeout=1):
                return
        except OSError:
            time.sleep(0.5)
    raise Stop("API 沒有開起來（連接埠 %d 可能被占用）。" % config.PORT)


def main():
    line = "=" * 56
    if "--setup" in sys.argv:
        say(line)
        say("  設定固定網址：https://%s" % config.FIXED_HOST)
        say(line)
        try:
            setup_fixed()
        except Stop as e:
            say("\n[錯誤] " + str(e))
            return 1
        return 0

    say(line)
    say("  學習筆記：電腦端伺服器" + ("（測試模式）" if config.FAKE else ""))
    say(line)
    try:
        from app import covers, db, engines, jobs, knowledge, review, tts, video
        say("連接資料庫 …")
        check_db()
        db.init()
        say("  資料庫準備好了")
        say("ffmpeg：%s" % (engines.find_ffmpeg() or "找不到（課程處理需要；winget install Gyan.FFmpeg）"))
        say("GPT-SoVITS 朗讀：%s" % {"ready": "已開啟", "offline": "沒開（需要朗讀時，先開「啟動語音伺服器.bat」）"}.get(tts.status(), "狀態不明"))
        threading.Thread(target=jobs.worker, daemon=True).start()
        threading.Thread(target=review.scheduler, daemon=True).start()
        threading.Thread(target=covers.backfill, daemon=True).start()
        threading.Thread(target=video.backfill, daemon=True).start()
        threading.Thread(target=knowledge.notes_indexer, daemon=True).start()
        threading.Thread(target=engines.asr_idle_unloader, daemon=True).start()
        start_api()
        say("  API 在 127.0.0.1:%d" % config.PORT)
        url = None if "--no-tunnel" in sys.argv else start_tunnel()
    except Stop as e:
        say("\n[錯誤] " + str(e))
        cleanup()
        return 1

    say()
    say(line)
    say("  完成！")
    if url:
        say("  電腦網址：%s" % url)
    say("  電腦密碼：%s" % config.KEY)
    say()
    say("  第一次使用：把上面兩個填到 Cloudflare Worker「study-api」的")
    say("  ORIGIN（變數）和 STUDY_KEY（Secret）。之後就不用再填。")
    say("  待處理資料夾：%s" % config.INBOX_DIR)
    say("  這個視窗不要關，關掉就停止。")
    say(line)
    say()
    try:
        while True:
            time.sleep(5)
            for p in children:
                if p.poll() is not None:
                    say("[提醒] cloudflared 停止了，重新連線 …")
                    children.remove(p)
                    try:
                        start_tunnel()
                    except Stop as e:
                        say("[錯誤] " + str(e))
                    break
    except KeyboardInterrupt:
        pass
    cleanup()
    return 0


def cleanup():
    for p in children:
        if p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main() or 0)
