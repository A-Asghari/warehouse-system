# -*- coding: utf-8 -*-
"""اتصالِ فقط‌خواندنی به سپیدار (معادلِ کتابخانهٔ mssql در نسخهٔ Node).

قاعدهٔ قطعی: به دیتابیس سپیدار هرگز چیزی نوشته نمی‌شود. این کلاس هر دستوری را که با SELECT شروع نشود
(یا شاملِ کلیدواژه‌های نوشتن باشد) پیش از ارسال رد می‌کند، و اتصال با ApplicationIntent=ReadOnly باز می‌شود.
"""
import re
import threading
from datetime import datetime, timezone, date
from decimal import Decimal

PREFERRED_ODBC_DRIVERS = [
    "ODBC Driver 18 for SQL Server",
    "ODBC Driver 17 for SQL Server",
    "ODBC Driver 13 for SQL Server",
    "SQL Server Native Client 11.0",
    "SQL Server",
]

_WRITE_WORDS = re.compile(r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|INTO)\b", re.I)


class ReadOnlyViolation(Exception):
    pass


def assert_read_only(sql_text):
    s = sql_text.strip()
    if not re.match(r"^SELECT\b", s, re.I) or _WRITE_WORDS.search(s) or ";" in s:
        raise ReadOnlyViolation("فقط دستورِ SELECT به سپیدار مجاز است")


def _iso_utc(dt):
    """mssql (Node) تاریخ‌های بدونِ منطقهٔ زمانی را UTC در نظر می‌گیرد؛ همین‌جا هم همان."""
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)
    if isinstance(dt, date):
        return dt.strftime("%Y-%m-%dT00:00:00.000Z")
    return dt


def _conv(v):
    if isinstance(v, Decimal):
        f = float(v)
        return int(f) if f.is_integer() and abs(f) < 2 ** 53 else f
    if isinstance(v, (datetime, date)):
        return _iso_utc(v)
    if isinstance(v, bool):
        return v
    return v


class Pool:
    def __init__(self, conn_str, timeout):
        self.conn_str = conn_str
        self.timeout = timeout
        self._local = threading.local()

    def _conn(self):
        import pyodbc
        c = getattr(self._local, "conn", None)
        if c is None:
            c = pyodbc.connect(self.conn_str, timeout=self.timeout, readonly=True)
            c.timeout = self.timeout
            self._local.conn = c
        return c

    def query(self, sql_text, params=None):
        assert_read_only(sql_text)
        args = []

        def rep(m):
            name = m.group(1)
            v = (params or {}).get(name)
            if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", v):
                v = datetime.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")  # UTC، مثل mssql با useUTC
            args.append(v)
            return "?"
        text = re.sub(r"@(\w+)", rep, sql_text)
        try:
            cur = self._conn().cursor()
            cur.execute(text, args)
            cols = [d[0] for d in cur.description]
            return [{c: _conv(v) for c, v in zip(cols, row)} for row in cur.fetchall()]
        except Exception:
            self._local.conn = None
            raise

    def close(self):
        c = getattr(self._local, "conn", None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass
        self._local.conn = None


class SepidarClient:
    def connect(self, cfg):
        import pyodbc
        installed = set(pyodbc.drivers())
        driver = next((d for d in PREFERRED_ODBC_DRIVERS if d in installed), None)
        if not driver:
            raise Exception("درایور ODBC برای SQL Server روی این سیستم نصب نیست")
        opts = cfg.get("options") or {}
        timeout = int((cfg.get("connectionTimeout") or 30000) / 1000)
        conn_str = ("DRIVER={%s};SERVER=%s;DATABASE=%s;UID=%s;PWD=%s;Encrypt=%s;TrustServerCertificate=%s;"
                    "ApplicationIntent=ReadOnly;Connect Timeout=%d"
                    % (driver, cfg.get("server"), cfg.get("database"), cfg.get("user"), cfg.get("password"),
                       "yes" if opts.get("encrypt") else "no", "yes" if opts.get("trustServerCertificate") else "no", timeout))
        pool = Pool(conn_str, int((cfg.get("requestTimeout") or 30000) / 1000))
        pool._conn()  # مثل sql.connect: اگر وصل نشود همین‌جا خطا می‌دهد
        return pool
