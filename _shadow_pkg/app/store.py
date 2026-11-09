# -*- coding: utf-8 -*-
"""ذخیره‌سازیِ داده‌های سیستم تولید در SQLite (به‌جای فایلِ db.json).

هر کلیدِ سطح‌بالای db.json (docs، transactions، inventory، ...) یک ردیف در جدول kv است. هر «ذخیره» همهٔ
کلیدهای تغییرکرده را در یک تراکنش SQLite می‌نویسد؛ پس قطع برق وسطِ نوشتن هرگز داده را نصفه نمی‌گذارد
(در db.json این اتفاق یک بار افتاده بود). ترتیبِ کلیدها همان ترتیبِ db.json می‌ماند تا خروجیِ /api/data
عیناً همان باشد.
"""
import json
import os
import sqlite3
import threading
import time

from jsx import stringify, UNDEF

_fp_enc = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=True,
                           default=lambda o: "\x00undefined" if o is UNDEF else repr(o)).encode


def fingerprint(v):
    """اثرِ انگشتِ سریع (کدِ C): اگر برابر باشد، متنِ JSONِ دقیق هم قطعاً برابر است."""
    return _fp_enc(v)


SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  ord   INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS save_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms   INTEGER NOT NULL,
  keys    TEXT NOT NULL,
  bytes   INTEGER NOT NULL
);
"""


class Store:
    def __init__(self, path):
        self.path = path
        self._cache = {}  # key -> json text آخرین چیزی که نوشته شده
        self._fp = {}     # key -> اثرِ انگشتِ همان
        self._order = []
        self._db = None
        self._lock = threading.Lock()
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=FULL")
        return c

    def _writer(self):
        if self._db is None:
            self._db = sqlite3.connect(self.path, timeout=30, check_same_thread=False, isolation_level=None)
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
        return self._db

    def is_empty(self):
        with self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM kv").fetchone()[0] == 0

    def load(self):
        """کلِ داده را به‌صورت dict (با ترتیبِ اصلیِ کلیدها) برمی‌گرداند؛ None اگر خالی باشد."""
        with self._lock, self._conn() as c:
            rows = c.execute("SELECT key, value FROM kv ORDER BY ord").fetchall()
        if not rows:
            return None
        data = {}
        self._cache = {}
        self._fp = {}
        self._order = []
        for k, v in rows:
            data[k] = json.loads(v)
            self._cache[k] = v
            self._order.append(k)
        return data

    def save(self, data, now_ms=None):
        """فقط کلیدهای تغییرکرده را در یک تراکنش می‌نویسد. تعداد کلیدهای نوشته‌شده را برمی‌گرداند."""
        changed = []
        texts = {}
        fps = {}
        for k, v in data.items():
            fp = fingerprint(v)
            if self._fp.get(k) == fp and k in self._cache:
                continue
            t = stringify(v)
            fps[k] = fp
            if self._cache.get(k) != t:
                changed.append(k)
                texts[k] = t
            else:
                self._fp[k] = fp
        removed = [k for k in self._cache if k not in data]
        if not changed and not removed:
            return 0
        order = list(data.keys())
        old_pos = {k: i for i, k in enumerate(self._order)}
        with self._lock:
            c = self._writer()
            try:
                c.execute("BEGIN IMMEDIATE")
                for k in removed:
                    c.execute("DELETE FROM kv WHERE key=?", (k,))
                for i, k in enumerate(order):
                    if k in texts:
                        c.execute("INSERT INTO kv(key, ord, value) VALUES(?,?,?) "
                                  "ON CONFLICT(key) DO UPDATE SET ord=excluded.ord, value=excluded.value",
                                  (k, i, texts[k]))
                    elif old_pos.get(k) != i:
                        c.execute("UPDATE kv SET ord=? WHERE key=?", (i, k))
                c.execute("INSERT INTO save_log(at_ms, keys, bytes) VALUES(?,?,?)",
                          (int(now_ms if now_ms is not None else time.time() * 1000),
                           ",".join(changed + ["-" + k for k in removed]), sum(len(t) for t in texts.values())))
                c.execute("DELETE FROM save_log WHERE id <= (SELECT MAX(id) FROM save_log) - 5000")
                c.execute("COMMIT")
            except Exception:
                try:
                    c.execute("ROLLBACK")
                except Exception:
                    pass
                self._db = None
                raise
            for k in removed:
                self._cache.pop(k, None)
                self._fp.pop(k, None)
            self._cache.update(texts)
            for k in texts:
                self._fp[k] = fps[k]
            self._order = order
        return len(changed) + len(removed)

    def load_cached(self):
        """مثلِ load() ولی اگر آخرین متنِ نوشته‌شده در حافظه هست، از همان می‌خواند (همان محتوای دیسک)."""
        if self._order:
            return {k: json.loads(self._cache[k]) for k in self._order}
        return self.load()

    def replace_all(self, data):
        with self._lock:
            c = self._conn()
            try:
                c.execute("BEGIN IMMEDIATE")
                c.execute("DELETE FROM kv")
                for i, k in enumerate(data.keys()):
                    c.execute("INSERT INTO kv(key, ord, value) VALUES(?,?,?)", (k, i, stringify(data[k])))
                c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK")
                raise
            finally:
                c.close()
            self._cache = {}
            self._fp = {}
            self._order = []
        self.load()

    def json_text(self, keys):
        """متنِ JSONِ کل داده از روی آخرین متن‌های ذخیره‌شده (بدون سریال‌سازیِ دوباره)."""
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + self._cache[k] for k in keys if k in self._cache) + "}"

    def export_json(self):
        """همان ساختارِ db.json (برای پشتیبان و مقایسه)."""
        data = self.load() or {}
        return stringify(data)

    def get_meta(self, key, default=None):
        with self._conn() as c:
            r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(r[0]) if r else default

    def set_meta(self, key, value):
        with self._conn() as c:
            c.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (key, json.dumps(value, ensure_ascii=False)))
