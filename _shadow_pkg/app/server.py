# -*- coding: utf-8 -*-
"""وب‌سرورِ سیستم مدیریت تولید (جایگزینِ Express در server.js).

همان پورت‌ها (۳۰۰۰ و ۳۴۴۳)، همان پوشهٔ public (بدون هیچ تغییری)، همان آدرس‌های API.
هستهٔ منطق در engine.py است؛ این فایل فقط HTTP است.

اجرا:
  python server.py --data <پوشهٔ داده> [--public <پوشهٔ public>] [--port 3000] [--https-port 3443]
                   [--import-json db.json] [--mode live|shadow|test]
"""
import argparse
import base64
import email.parser
import email.policy
import hashlib
import json
import mimetypes
import os
import queue
import ssl
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qsl, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from engine import Engine, Request, Response  # noqa: E402
from jsx import stringify, UNDEF  # noqa: E402
from store import Store  # noqa: E402
import shadowcmp  # noqa: E402

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def express_etag(body_bytes):
    h = base64.b64encode(hashlib.sha1(body_bytes).digest()).decode()[:27]
    return 'W/"%x-%s"' % (len(body_bytes), h)


def http_date(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


class AfterWorker:
    """کارهای بعد از پاسخ (اعلان‌ها، لاگِ ممیزی) به ترتیب، در یک نخِ جدا — مثل setImmediate/Promise در Node."""

    def __init__(self, log):
        self.q = queue.Queue()
        self.log = log
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

    def submit(self, jobs):
        for j in jobs:
            self.q.put(j)

    def _run(self):
        while True:
            j = self.q.get()
            try:
                j()
            except Exception:
                self.log("after-job failed:", traceback.format_exc())
            finally:
                self.q.task_done()

    def drain(self):
        self.q.join()


class App:
    def __init__(self, engine, public_dir, cert_dir=None, test_hooks=False, log=print, shadow=False, shadow_key=None):
        self.engine = engine
        self.shadow = shadow
        self.shadow_key = shadow_key
        self.public_dir = os.path.abspath(public_dir)
        self.cert_dir = cert_dir
        self.test_hooks = test_hooks
        self.log = log
        self.worker = AfterWorker(log)

    # ---------- حالتِ سایه: اجرای درخواستِ آینه‌شده و مقایسه با پاسخِ Node ----------
    def mirror(self, env):
        import base64 as b64
        env["body"] = b64.b64decode(env.get("body") or "")
        env["respBody"] = b64.b64decode(env.get("respBody") or "")
        hdrs = {k.lower(): v for k, v in (env.get("headers") or {}).items()}
        hdrs["x-shadow-now"] = str(env["t"])
        t0 = time.time()
        try:
            code, h, b = self.handle(env["method"], env["path"], hdrs, env["body"])
        except Exception:
            self.rec.write("errors", {"seq": env.get("seq"), "path": env["path"], "error": traceback.format_exc()})
            return 200, {"Content-Type": "application/json"}, b'{"ok":false}'
        ms = (time.time() - t0) * 1000
        self.rec.write("timing", {"t": env["t"], "req": shadowcmp.route_key(env["method"], env["path"]), "nodeMs": env.get("nodeMs"), "shadowMs": round(ms, 1)})
        try:
            shadowcmp.compare_response(self.rec, env, code, b, ms)
        except Exception:
            self.rec.write("errors", {"seq": env.get("seq"), "path": env["path"], "error": traceback.format_exc()})
        return 200, {"Content-Type": "application/json"}, b'{"ok":true}'

    # ---------- static (express.static) ----------
    def static(self, method, path, headers):
        if method not in ("GET", "HEAD"):
            return None
        rel = unquote(path)
        if "\x00" in rel:
            return None
        full = os.path.abspath(os.path.join(self.public_dir, rel.lstrip("/")))
        if not (full == self.public_dir or full.startswith(self.public_dir + os.sep)):
            return None
        if os.path.isdir(full):
            if not path.endswith("/"):
                return (301, {"Location": path + "/", "Content-Type": "text/html; charset=UTF-8"},
                        ("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n"
                         "<body>\n<pre>Redirecting to " + path + "/</pre>\n</body>\n</html>\n").encode())
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return None
        st = os.stat(full)
        etag = 'W/"%x-%x"' % (st.st_size, int(st.st_mtime * 1000))
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "application/manifest+json"):
            ctype += "; charset=UTF-8"
        h = {"Content-Type": ctype, "Cache-Control": "public, max-age=0", "Last-Modified": http_date(st.st_mtime),
             "ETag": etag, "Accept-Ranges": "bytes"}
        if headers.get("if-none-match") == etag:
            return (304, h, b"")
        with open(full, "rb") as fh:
            return (200, h, fh.read())

    def cert_files(self):
        d = self.cert_dir or ""
        shared = (os.path.join(d, "dastoor.key"), os.path.join(d, "dastoor.crt"), os.path.join(d, "dastoor.crt"))
        if d and os.path.exists(shared[0]) and os.path.exists(shared[1]):
            return shared
        base = os.path.join(self.engine.app_dir, "certs")
        return (os.path.join(base, "server-key.pem"), os.path.join(base, "server-cert.pem"), os.path.join(base, "ca-cert.pem"))

    def handle(self, method, raw_path, headers, body_bytes):
        u = urlsplit(raw_path)
        path = u.path
        query = {}
        for k, v in parse_qsl(u.query, keep_blank_values=True):
            if k not in query:
                query[k] = v
        base = {"Access-Control-Allow-Origin": "*", "X-Powered-By": "Express",
                "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept"}
        if method == "OPTIONS":
            base.update({"Access-Control-Allow-Methods": "GET,HEAD,PUT,PATCH,POST,DELETE", "Vary": "Access-Control-Request-Headers",
                         "Content-Length": "0"})
            return 204, base, b""
        if self.test_hooks and path == "/__test/clock" and method == "POST":
            ms = json.loads(body_bytes or b"{}").get("now")
            self.engine.clock = (lambda v=ms: v)
            return 200, {"Content-Type": "application/json"}, b'{"ok":true}'
        if self.shadow and path.startswith("/__shadow/") and headers.get("x-shadow-key") == self.shadow_key:
            if path == "/__shadow/reseed" and method == "POST":
                src = json.loads(body_bytes)["dbPath"]
                with open(src, encoding="utf-8") as fh:
                    self.engine.reseed(json.load(fh))
                return 200, {"Content-Type": "application/json"}, b'{"ok":true}'
            if path == "/__shadow/state":
                with self.engine.lock:
                    self.engine.loadData()
                    txt = stringify(self.engine.data)
                return 200, {"Content-Type": "application/json; charset=utf-8"}, txt.encode("utf-8")
            if path == "/__shadow/drain":
                self.worker.drain()
                return 200, {"Content-Type": "application/json"}, b'{"ok":true}'
            if path == "/__shadow/mirror" and method == "POST":
                return self.mirror(json.loads(body_bytes))
            if path == "/__shadow/nightly" and method == "POST":
                q = json.loads(body_bytes or b"{}")
                summ = shadowcmp.nightly_compare(self.engine, self.node_db, self.rec, reseed=q.get("reseed", True))
                return 200, {"Content-Type": "application/json; charset=utf-8"}, json.dumps(summ, ensure_ascii=False, default=str).encode()
        if self.test_hooks and path == "/__test/drain":
            self.worker.drain()
            return 200, {"Content-Type": "application/json"}, b'{"ok":true}'
        st = self.static(method, path, headers)
        if st is not None:
            code, h, b = st
            base.update(h)
            return code, base, (b"" if method == "HEAD" else b)
        if method == "GET" and path == "/ca.crt":
            ca = self.cert_files()[2]
            if not os.path.exists(ca):
                b = "هنوز گواهی HTTPS ساخته نشده - روی سرور «node generate-https-cert.js» را اجرا کنید.".encode()
                base["Content-Type"] = "text/html; charset=utf-8"
                return 404, base, b
            with open(ca, "rb") as fh:
                base.update({"Content-Type": "application/x-x509-ca-cert",
                             "Content-Disposition": 'attachment; filename="warehouse-lan-ca.crt"'})
                return 200, base, fh.read()
        # بدنهٔ درخواست (express.json + multer)
        ctype = headers.get("content-type", "")
        body = {}
        files = {}
        if body_bytes and "application/json" in ctype.lower():
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                base["Content-Type"] = "text/html; charset=utf-8"
                return 400, base, b"Bad Request"
        elif body_bytes and ctype.lower().startswith("multipart/form-data"):
            msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body_bytes)
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if part.get_filename() is not None:
                    files[name] = part.get_payload(decode=True)
                elif name:
                    body[name] = part.get_content()
        req = Request(method, path, query=query, body=body, headers=headers, files=files)
        now_override = None
        if self.shadow and headers.get("x-shadow-now"):
            now_override = int(headers["x-shadow-now"])
        resp, jobs = self.engine.handle(req, now_override)
        self.worker.submit(jobs)
        if resp.kind in ("json", "rawjson"):
            b = resp.text.encode("utf-8")
            base["Content-Type"] = "application/json; charset=utf-8"
            et = express_etag(b)
            base["ETag"] = et
            if method in ("GET", "HEAD") and resp.status == 200 and headers.get("if-none-match") == et:
                return 304, base, b""
            return resp.status, base, (b"" if method == "HEAD" else b)
        if resp.kind == "file":
            with open(resp.body, "rb") as fh:
                b = fh.read()
            base.update(resp.headers)
            base["Content-Type"] = mimetypes.guess_type(resp.body)[0] or "application/octet-stream"
            return resp.status, base, b
        b = (resp.body if isinstance(resp.body, bytes) else str(resp.body).encode("utf-8"))
        base["Content-Type"] = "text/html; charset=utf-8"
        base.update(resp.headers)
        return resp.status, base, b


def make_handler(app):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 120
        server_version = "WarehouseSystem-Py"

        def log_message(self, fmt, *args):
            pass

        def _go(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n > 60 * 1024 * 1024:
                    self.send_error(413)
                    return
                data = self.rfile.read(n) if n else b""
                hdrs = {k.lower(): v for k, v in self.headers.items()}
                code, h, b = app.handle(self.command, self.path, hdrs, data)
            except Exception:
                app.log("server error:", traceback.format_exc())
                code, h, b = 500, {"Content-Type": "text/plain"}, b"Internal Server Error"
            self.send_response(code)
            for k, v in h.items():
                if k.lower() != "content-length":
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            if b:
                self.wfile.write(b)

        do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_OPTIONS = do_HEAD = _go
    return H


def build_engine(data_dir, mode, app_dir, import_json=None, fake_sepidar=None, push_log=None, om_log=None, sql_log=None, log=print):
    os.makedirs(data_dir, exist_ok=True)
    store = Store(os.path.join(data_dir, "production.sqlite3"))
    if import_json and store.is_empty():
        with open(import_json, encoding="utf-8") as fh:
            raw = json.load(fh)
        store.save(raw)
    if mode == "live":
        from notifier import RealNotifier
        from sepidar_client import SepidarClient
        notifier, sep = RealNotifier(log), SepidarClient()
    else:
        from notifier import RecordingNotifier
        notifier = RecordingNotifier(push_log, om_log)
        if fake_sepidar:
            from fake_sepidar import FakeSepidar
            sep = FakeSepidar(fake_sepidar, sql_log)
        else:
            from sepidar_client import SepidarClient
            sep = SepidarClient()
    eng = Engine(store, sepidar=sep, notifier=notifier, log=log)
    eng.app_dir = app_dir
    if mode == "shadow":
        eng.fs_jail = os.path.join(data_dir, "shadow-fs")
    return eng


class BackupScheduler:
    def __init__(self, engine):
        self.engine = engine
        self.timers = []

    def rearm(self):
        for t in self.timers:
            t.cancel()
        self.timers = []
        cfg = self.engine.getBackupSettings()
        if not cfg.get("autoEnabled"):
            return
        t1 = threading.Timer(60, self._tick_once)
        t1.daemon = True
        t1.start()
        self.timers.append(t1)
        self._schedule()

    def _tick_once(self):
        self.engine.autoBackupIfDue()

    def _schedule(self):
        t = threading.Timer(600, self._interval)
        t.daemon = True
        t.start()
        self.timers.append(t)

    def _interval(self):
        self.engine.autoBackupIfDue()
        self._schedule()


def _install_cov(path):
    import signal
    hits = set()
    target = os.path.join(HERE, "engine.py")

    def tr(frame, event, arg):
        if frame.f_code.co_filename != target:
            return None

        def lt(f, e, a):
            if e == "line":
                hits.add(f.f_lineno)
            return lt
        hits.add(frame.f_lineno)
        return lt
    sys.settrace(tr)
    threading.settrace(tr)

    def dump(*_):
        old = set()
        if os.path.exists(path):
            old = set(json.load(open(path)))
        json.dump(sorted(old | hits), open(path, "w"))
        os._exit(0)
    signal.signal(signal.SIGTERM, dump)


def main():
    if os.environ.get("PYCOV"):
        _install_cov(os.environ["PYCOV"])
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--public", default=os.path.join(HERE, "public"))
    ap.add_argument("--app-dir", default=None, help="معادلِ __dirname (پیش‌فرضِ پوشهٔ بکاپ و certs)")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--https-port", type=int, default=None)
    ap.add_argument("--cert-dir", default=os.environ.get("SHARED_CERT_DIR", r"C:\dastoor-pardakht\app\certs"))
    ap.add_argument("--import-json", default=None)
    ap.add_argument("--mode", choices=["live", "shadow", "test"], default="live")
    ap.add_argument("--fake-sepidar", default=None)
    ap.add_argument("--push-log", default=None)
    ap.add_argument("--om-log", default=None)
    ap.add_argument("--sql-log", default=None)
    ap.add_argument("--now", type=int, default=None, help="فقط آزمون: ساعتِ ثابت (میلی‌ثانیه)")
    ap.add_argument("--node-db", default=None, help="حالتِ سایه: مسیرِ db.jsonِ Node (فقط خواندن) برای مقایسهٔ شبانه")
    ap.add_argument("--reports", default=None, help="حالتِ سایه: پوشهٔ گزارش‌ها")
    a = ap.parse_args()

    def log(*x):
        print(*x, file=sys.stderr, flush=True)
    eng = build_engine(a.data, a.mode, a.app_dir or a.data, a.import_json, a.fake_sepidar, a.push_log, a.om_log, a.sql_log, log)
    if a.now is not None:
        eng.clock = (lambda v=a.now: v)
        eng.dataVersion = a.now
    app = App(eng, a.public, a.cert_dir, test_hooks=(a.mode == "test"), log=log,
              shadow=(a.mode == "shadow"), shadow_key=os.environ.get("SHADOW_KEY", "local-shadow"))
    app.node_db = a.node_db
    app.rec = shadowcmp.Recorder(a.reports or os.path.join(a.data, "reports"))
    if a.mode == "shadow" and a.node_db:
        threading.Thread(target=shadowcmp.nightly_loop, args=(eng, a.node_db, app.rec), daemon=True).start()
    with eng.lock:
        eng.loadData()
    if a.mode != "test":
        eng.backup = BackupScheduler(eng)
        if a.mode == "live":
            eng.backup.rearm()
    with eng.lock:
        try:
            eng.ensurePushKeys()
        except Exception as e:
            log("ensurePushKeys:", e)
    if a.mode == "live":   # در حالتِ سایه این بررسیِ زمان‌دار را Node انجام می‌دهد (هم‌ترازیِ شبانه)
        def sep_check():
            try:
                eng.checkSepidarDeletedDocs_locked()
            except Exception:
                log(traceback.format_exc())
        def loop():
            time.sleep(60)
            while True:
                sep_check()
                time.sleep(15 * 60)
        threading.Thread(target=loop, daemon=True).start()
    port = a.port or (eng.appSettings.get("appPort") if isinstance(eng.appSettings, dict) else None) or 3000
    bind = "127.0.0.1" if a.mode == "shadow" else "0.0.0.0"   # سایه از بیرون در دسترس نیست
    srv = ThreadingHTTPServer((bind, port), make_handler(app))
    srv.daemon_threads = True
    log("✅ سرور (پایتون) روی پورت %s — حالت: %s" % (port, a.mode))
    key, cert, _ca = app.cert_files()
    hp = a.https_port or 3443
    if os.path.exists(key) and os.path.exists(cert) and a.mode == "live":
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            hs = ThreadingHTTPServer(("0.0.0.0", hp), make_handler(app))
            hs.daemon_threads = True
            hs.socket = ctx.wrap_socket(hs.socket, server_side=True, do_handshake_on_connect=False)
            threading.Thread(target=hs.serve_forever, daemon=True).start()
            log("🔒 HTTPS روی پورت %s" % hp)
        except Exception as e:
            log("❌ خطا در راه‌اندازی HTTPS:", e)
    srv.serve_forever()


if __name__ == "__main__":
    main()
