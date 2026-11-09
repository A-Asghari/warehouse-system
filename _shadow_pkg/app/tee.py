# -*- coding: utf-8 -*-
"""«دوشاخه»ی دورهٔ آزمایشی: کاربران مثل همیشه به پورت ۳۰۰۰/۳۴۴۳ وصل می‌شوند؛ این برنامه هر درخواست را بی‌تغییر
به سیستمِ فعلی (Node) می‌دهد و پاسخِ همان را به کاربر برمی‌گرداند. یک کپی از درخواستِ API و پاسخِ Node (به ترتیبِ
رسیدن) در پس‌زمینه برای نسخهٔ سایه فرستاده می‌شود؛ مقایسه و گزارش داخلِ خودِ سایه انجام می‌شود تا این برنامه سبک بماند.

اگر سایه کند/خاموش باشد: صفِ محدود و دور ریختن — هیچ اثری روی کاربر ندارد.
"""
import argparse
import base64
import http.client
import itertools
import json
import os
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}


class Mirror:
    """ترتیبِ ارسال به سایه = ترتیبی که درخواست‌ها به Node داده شده‌اند (نه ترتیبِ تمام‌شدنشان)."""

    def __init__(self, shadow_addr, key, maxq=3000, log=print):
        self.host, port = shadow_addr.split(":")
        self.port = int(port)
        self.key = key
        self.log = log
        self.seq = itertools.count(1)
        self.cv = threading.Condition()
        self.ready = {}
        self.next = 1
        self.maxq = maxq
        self.dropped = 0
        self.sent = 0
        threading.Thread(target=self._run, daemon=True).start()

    def ticket(self):
        with self.cv:
            return next(self.seq)

    def done(self, seq, env):
        with self.cv:
            if len(self.ready) >= self.maxq:
                self.dropped += 1
                env = None
            self.ready[seq] = env
            self.cv.notify()

    def _run(self):
        conn = None
        while True:
            with self.cv:
                deadline = time.time() + 30
                while self.next not in self.ready:
                    left = deadline - time.time()
                    if left <= 0:
                        # بلیتی که هرگز کامل نشد (مثلاً خطای شبکه) — رد شو
                        if self.ready:
                            self.next = min(self.ready)
                        deadline = time.time() + 30
                        continue
                    self.cv.wait(left)
                env = self.ready.pop(self.next)
                self.next += 1
            if env is None:
                continue
            try:
                if conn is None:
                    conn = http.client.HTTPConnection(self.host, self.port, timeout=300)
                payload = json.dumps(env).encode()
                conn.request("POST", "/__shadow/mirror", body=payload,
                             headers={"Content-Type": "application/json", "X-Shadow-Key": self.key})
                conn.getresponse().read()
                self.sent += 1
            except Exception as e:
                self.dropped += 1
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None


def make_proxy(node_addr, mirror):
    nh, np_ = node_addr.split(":")
    np_ = int(np_)

    class P(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 120

        def log_message(self, *a):
            pass

        def _go(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            hdrs = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            api = self.path.startswith("/api/")
            seq = mirror.ticket() if api else None
            t0 = time.time()
            try:
                c = http.client.HTTPConnection(nh, np_, timeout=300)
                c.request(self.command, self.path, body=body if body or self.command in ("POST", "PUT", "PATCH") else None, headers=hdrs)
                r = c.getresponse()
                rb = r.read()
                status, rh = r.status, r.getheaders()
                c.close()
            except Exception:
                if seq:
                    mirror.done(seq, None)
                self.send_response(502)
                msg = "سیستم تولید در دسترس نیست".encode("utf-8")
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            t1 = time.time()
            self.send_response(status)
            for k, v in rh:
                if k.lower() not in HOP and k.lower() != "content-length":
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(rb)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(rb)
            if seq:
                ctype = ""
                for k, v in rh:
                    if k.lower() == "content-type":
                        ctype = v
                mirror.done(seq, {
                    "seq": seq, "t": int(t1 * 1000), "method": self.command, "path": self.path,
                    "headers": {k: v for k, v in hdrs.items() if k.lower() in ("content-type", "user-agent", "accept")},
                    "body": base64.b64encode(body).decode(), "status": status, "respType": ctype,
                    "respBody": base64.b64encode(rb).decode() if not self.path.startswith("/api/backup/download") else "",
                    "nodeMs": round((t1 - t0) * 1000, 1)})

        do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_OPTIONS = do_HEAD = _go
    return P


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node-http", required=True)
    ap.add_argument("--shadow", required=True)
    ap.add_argument("--listen", type=int, default=3000)
    ap.add_argument("--listen-https", type=int, default=3443)
    ap.add_argument("--cert-dir", default=r"C:\dastoor-pardakht\app\certs")
    ap.add_argument("--shadow-key", default=os.environ.get("SHADOW_KEY", "local-shadow"))
    a = ap.parse_args()
    mirror = Mirror(a.shadow, a.shadow_key)
    P = make_proxy(a.node_http, mirror)
    srv = ThreadingHTTPServer(("0.0.0.0", a.listen), P)
    srv.daemon_threads = True
    key, cert = os.path.join(a.cert_dir, "dastoor.key"), os.path.join(a.cert_dir, "dastoor.crt")
    if a.listen_https and os.path.exists(key) and os.path.exists(cert):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        hs = ThreadingHTTPServer(("0.0.0.0", a.listen_https), P)
        hs.daemon_threads = True
        hs.socket = ctx.wrap_socket(hs.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=hs.serve_forever, daemon=True).start()
    print("tee: %d → Node %s ، سایه %s" % (a.listen, a.node_http, a.shadow), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
