# -*- coding: utf-8 -*-
"""اعلان‌ها: Web Push و Output Messenger.

RealNotifier واقعاً می‌فرستد؛ RecordingNotifier (برای آزمون و حالتِ «سایه») فقط در فایل می‌نویسد و هیچ پیامی
به گوشیِ کسی یا گروهِ پیام‌رسان نمی‌فرستد.
"""
import base64
import json
import os
import struct
import time
import http.client
import urllib.parse
from urllib.parse import urlparse


def b64u_encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64u_decode(s):
    s = (s or "").strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _tls_context():
    """همان فهرستِ گواهی‌های ریشه‌ای که Node و کتابخانهٔ requests استفاده می‌کنند (certifi/Mozilla)،
    به‌اضافهٔ گواهی‌های ویندوز. فقط فروشگاهِ ویندوزِ سرور، ریشهٔ سرویسِ اعلانِ اپل را نداشت."""
    import ssl
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    return ctx


class RealNotifier:
    """کلیدهای VAPID در قالبِ کتابخانهٔ web-push (Node) هستند: کلید خصوصی = ۳۲ بایتِ خام base64url."""

    def __init__(self, log=print):
        self.log = log

    def generate_vapid_keys(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        k = ec.generate_private_key(ec.SECP256R1())
        d = k.private_numbers().private_value.to_bytes(32, "big")
        pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return b64u_encode(pub), b64u_encode(d)

    def _priv(self, raw_b64):
        from cryptography.hazmat.primitives.asymmetric import ec
        return ec.derive_private_key(int.from_bytes(b64u_decode(raw_b64), "big"), ec.SECP256R1())

    def _encrypt(self, plaintext, p256dh, auth):
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        ua_public = b64u_decode(p256dh)
        auth_secret = b64u_decode(auth)
        as_private = ec.generate_private_key(ec.SECP256R1())
        as_public = as_private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
        secret = as_private.exchange(ec.ECDH(), ua_key)
        ikm = HKDF(algorithm=hashes.SHA256(), length=32, salt=auth_secret, info=b"WebPush: info\x00" + ua_public + as_public).derive(secret)
        salt = os.urandom(16)
        cek = HKDF(algorithm=hashes.SHA256(), length=16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
        nonce = HKDF(algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
        record = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
        return salt + struct.pack(">IB", 4096, len(as_public)) + as_public + record

    def web_push(self, vapid, endpoint, keys, payload_str, ttl=86400, urgency="high"):
        """کد وضعیتِ HTTP را برمی‌گرداند (۴۰۴/۴۱۰ = اشتراک باطل)؛ خطای شبکه → None."""
        import jwt
        subject, pub, priv_raw = vapid
        try:
            priv = self._priv(priv_raw)
            u = urlparse(endpoint)
            token = jwt.encode({"aud": u.scheme + "://" + u.netloc, "exp": int(time.time()) + 12 * 3600, "sub": subject}, priv, algorithm="ES256")
            if isinstance(token, bytes):
                token = token.decode("ascii")
            body = self._encrypt(payload_str.encode("utf-8"), keys["p256dh"], keys["auth"])
            headers = {"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(ttl),
                       "Authorization": "vapid t=" + token + ", k=" + pub, "Content-Length": str(len(body))}
            if urgency:
                headers["Urgency"] = urgency
            conn = http.client.HTTPSConnection(u.netloc, timeout=15, context=_tls_context())
            conn.request("POST", u.path + (("?" + u.query) if u.query else ""), body=body, headers=headers)
            st = conn.getresponse().status
            conn.close()
            if st >= 400 and st not in (404, 410):
                self.log("⚠️ ارسال Web Push ناموفق: status", st)
            return st
        except Exception as e:
            self.log("⚠️ ارسال Web Push ناموفق:", str(e))
            return None

    def om_request(self, host, port, api_key, params, timeout):
        """('ok', متنِ پاسخ) | ('timeout', None) | ('error', پیام)"""
        try:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
            conn.request("POST", "/api/notify?" + urllib.parse.urlencode(params), headers={"API-KEY": api_key, "Content-Length": "0"})
            body = conn.getresponse().read().decode("utf-8", "replace")
            conn.close()
            return "ok", body
        except TimeoutError:
            return "timeout", None
        except OSError as e:
            if "timed out" in str(e):
                return "timeout", None
            return "error", str(e)

    def output_messenger(self, cfg, room, message):
        if not cfg.get("enabled") or not cfg.get("host") or not cfg.get("port") or not cfg.get("apiKey") or not room:
            return
        params = [("room", room), ("message", message), ("notify", "1")]
        if cfg.get("fromUser"):
            params.append(("from", cfg["fromUser"]))
        kind, val = self.om_request(cfg["host"], int(cfg["port"]), cfg["apiKey"], params, 5.0)
        ok = False
        if kind == "ok":
            try:
                ok = bool(json.loads(val).get("success"))
            except Exception:
                ok = False
        if not ok:
            self.log("⚠️ ارسال پیامِ Output Messenger به گروه «%s» ناموفق بود: %s" % (room, val))


class RecordingNotifier:
    """هیچ چیزی بیرون نمی‌فرستد؛ هر اعلان یک خط JSON در فایل (همان قالبِ شبیه‌سازِ Node)."""

    def __init__(self, push_log=None, om_log=None):
        self.push_log = push_log
        self.om_log = om_log

    def generate_vapid_keys(self):
        return "TEST_PUBLIC_KEY", "TEST_PRIVATE_KEY"

    def _w(self, path, obj):
        if path:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(obj, ensure_ascii=False) + "\n")

    def web_push(self, vapid, endpoint, keys, payload_str, ttl=86400, urgency="high"):
        opts = {"TTL": ttl}
        if urgency:
            opts["urgency"] = urgency
        self._w(self.push_log, {"endpoint": endpoint, "payload": json.loads(payload_str), "opts": opts})
        if "gone" in (endpoint or ""):
            return 410
        return 201

    def om_request(self, host, port, api_key, params, timeout):
        self._w(self.om_log, {"host": host, "port": port, "params": params})
        return "error", "recording mode: no network"

    def output_messenger(self, cfg, room, message):
        self._w(self.om_log, {"room": room, "message": message})
