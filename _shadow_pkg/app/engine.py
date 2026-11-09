# -*- coding: utf-8 -*-
"""هستهٔ سیستم مدیریت تولید — بازنویسیِ خط‌به‌خطِ C:\\WarehouseSystem\\server.js به پایتون.

قاعدهٔ این فایل: «اول عیناً همان». هر تابع و هر مسیر، همان ورودی را می‌گیرد، همان بررسی‌ها را به همان
ترتیب انجام می‌دهد، همان پیام فارسی را برمی‌گرداند و همان تغییر را روی داده می‌دهد. نام‌ها عمداً همان
نام‌های server.js است تا مقایسهٔ دو کد ساده باشد. هر رفتاری که عجیب به‌نظر می‌رسد ولی در نسخهٔ فعلی
هست، این‌جا هم هست (اصلاحش بعد از جابه‌جایی و با تأیید کاربر).

این فایل چیزی دربارهٔ HTTP نمی‌داند؛ server.py درخواست را به Request تبدیل می‌کند و Response برمی‌گیرد.
"""
import copy
import hashlib
import hmac
import json
import math
import os
import re
import threading
import time
import base64

from jsx import (UNDEF, NaN, truthy, js_or, to_str, num_str, parse_int, parse_float, to_number,
                 is_finite, is_number, is_nan, js_round, stringify, js_keys, js_items, js_values, iso, fa_date, fa_number, fa_digits,
                 jalali_parts, local_dt, date_parse, num, add, sub, mul, lt, js_floor, js_min)
from collate_fa import fa_key


def seq(a, b):
    """=== در JS"""
    if is_number(a) and is_number(b):
        return a == b
    if type(a) is not type(b):
        return False
    return a == b if not isinstance(a, (dict, list)) else a is b


QTY_EPS = 0.001

DEFAULT_SEPIDAR_CONFIG = {
    "user": "report",
    "password": "61704",
    "server": "192.168.0.12\\Sepidar",
    "database": "Sepidar01",
    "encrypt": False,
    "trustServerCertificate": True,
}
DEFAULT_BACKUP_SETTINGS = {"folder": "", "autoEnabled": False, "autoIntervalHours": 24, "keepCount": 30}
DEFAULT_OUTPUT_MESSENGER_CONFIG = {
    "enabled": False,
    "host": "192.168.0.3",
    "port": 14125,
    "apiKey": "1N6U8JKPWLHW2MWIA70APT0N4XBC8822",
    "fromUser": "",
    "deptGroups": {},
}
DEFAULT_WAREHOUSE_GATE_CONFIG = {"pairs": []}
DEFAULT_PRODUCTION_GATE_CONFIG = {"depts": []}
PUSH_SUBJECT_DEFAULT = "mailto:ahmad.asghari@live.com"
PERM_APPROVE_ADJUSTMENTS = "perm-approve-adjustments"
DEFAULT_ROLE_PERMISSIONS = {
    "supervisor": ["sec-dashboard", "sec-daily-report", "sec-cardex", "sec-summary",
                   "sec-production", "sec-consume", "sec-output", "sec-waste", "sec-adjust",
                   "sec-documents", "sec-history", PERM_APPROVE_ADJUSTMENTS],
    "warehouse": ["sec-dashboard", "sec-cardex", "sec-summary", "sec-initial-inv",
                  "sec-adjust", "sec-output", "sec-documents", "sec-history"],
    "user": ["sec-dashboard", "sec-daily-report", "sec-cardex", "sec-summary", "sec-production",
             "sec-consume", "sec-output", "sec-waste", "sec-adjust", "sec-documents", "sec-history"],
}
DEFAULT_USERS = [
    {"username": "admin", "password": "123456", "fullname": "مدیر سیستم", "unit": "مدیریت", "role": "admin"},
    {"username": "ali", "password": "123456", "fullname": "علی احمدی", "unit": "برش", "role": "user"},
    {"username": "reza", "password": "123456", "fullname": "رضا کریمی", "unit": "لحیم", "role": "user"},
    {"username": "mohsen", "password": "123456", "fullname": "محسن رضایی", "unit": "تزریق", "role": "user"},
    {"username": "mehdi", "password": "123456", "fullname": "مهدی قاسمی", "unit": "کنترل کیفیت", "role": "user"},
    {"username": "hamid", "password": "123456", "fullname": "حمید علیپور", "unit": "بسته‌بندی", "role": "user"},
    {"username": "nader", "password": "123456", "fullname": "نادر محمدی", "unit": "انبار محصول", "role": "user"},
    {"username": "ahmad", "password": "123456", "fullname": "احمد اصغری", "unit": "انبار مواد اولیه", "role": "user"},
]
DEPTS = [
    {"id": "raw", "name": "انبار مواد اولیه", "type": "wh"},
    {"id": "cut", "name": "برش", "type": "stage"},
    {"id": "solder", "name": "لحیم", "type": "stage"},
    {"id": "qc", "name": "کنترل کیفیت", "type": "qc"},
    {"id": "inject", "name": "تزریق", "type": "stage"},
    {"id": "laser", "name": "لیزر", "type": "stage"},
    {"id": "pack", "name": "بسته‌بندی", "type": "stage"},
    {"id": "finished", "name": "انبار محصول", "type": "wh"},
]
DEPT_IDS = [d["id"] for d in DEPTS]
STAGE_DEPTS = ["cut", "solder", "inject", "laser", "pack"]
DEFAULT_FISCAL_YEARS = [
    {"year": "1405", "title": "سال مالی 1405", "status": "active", "startDate": "1405/01/01", "endDate": "1405/12/29"}
]
DUPLICATE_OUTPUT_WINDOW_MS = 10 * 1000
INBOX_RAW_STOCK_REF = 6
INBOX_ASSEMBLY_STOCK_REFS = [16, 17, 14, 44]
INBOX_KIND_LABELS = {
    "transfer_to_assembly": "انتقال به مونتاژ",
    "transfer_out_other": "انتقال به انبار دیگر",
    "direct_consumption": "مصرف مستقیم",
    "other_out": "سایر خروجی",
    "purchase_receipt": "رسید خرید",
    "return_from_assembly": "برگشتی از مونتاژ/واسط",
    "transfer_in": "انتقال از انبار دیگر",
    "code_fix": "اصلاح کد کالا",
    "other_in": "سایر ورودی",
    "opening": "ابتدای دوره",
}
INBOX_APPROVABLE_KINDS = ["transfer_to_assembly", "return_from_assembly", "direct_consumption",
                          "purchase_receipt", "transfer_in", "other_in", "other_out", "transfer_out_other"]
RECONCILE_STOCKS = [
    {"dept": "raw", "stockRef": 6, "title": "انبار تولید - مواد اولیه"},
    {"dept": "finished", "stockRef": 37, "title": "انبار تولید - محصول"},
]
SETTINGS_MANAGED_SECTIONS = [
    "sec-dashboard", "sec-daily-report", "sec-cardex", "sec-summary",
    "sec-production", "sec-consume", "sec-output", "sec-waste", "sec-adjust",
    "sec-documents", "sec-history", "sec-initial-inv",
    "sec-stock-check", "sec-sepidar-inbox", "sec-stock-count", "sec-forecast", "sec-home",
]
SETTINGS_MANAGED_PERMISSIONS = [PERM_APPROVE_ADJUSTMENTS]
AUDITED_DOC_ROUTES = [
    (re.compile(r"^/output/approve$"), "تایید خروج (بخش گیرنده)"),
    (re.compile(r"^/(\d+)/cancel$"), "لغو سند"),
    (re.compile(r"^/return/approve$"), "تایید برگشت"),
    (re.compile(r"^/return/reject$"), "رد برگشت"),
    (re.compile(r"^/output/request-return$"), "درخواست برگشت خروج"),
]


class Response:
    def __init__(self, status, body, after=None, kind="json", headers=None):
        self.status = status
        self.body = body
        self.after = after or []   # کارهای بعد از پاسخ (اعلان‌ها) — هرگز جلوی پاسخ را نمی‌گیرند
        self.kind = kind           # json | file | text
        self.headers = headers or {}


def J(body, status=200, after=None):
    return Response(status, body, after)


def ERR(status, error, **extra):
    b = {"success": False}
    b["error"] = error
    for k, v in extra.items():
        b[k] = v
    return Response(status, b)


def g(o, k, default=UNDEF):
    """o[k] با رفتارِ JS (کلیدِ نبود = undefined)."""
    if isinstance(o, dict):
        return o.get(k, default)
    return default


def deep_copy(o):
    return copy.deepcopy(o)


class Request:
    def __init__(self, method, path, params=None, query=None, body=None, headers=None, files=None):
        self.method = method
        self.path = path
        self.params = params or {}
        self.query = query or {}
        self.body = body if body is not None else {}
        self.headers = headers or {}
        self.files = files or {}


# ======================================================================
# مسیریابی (معادلِ app.get/app.post/app.delete در Express، به همان ترتیب)
# ======================================================================
ROUTES = []  # (order, method, regex, names, func_name, catch)


def _compile_path(p):
    names = []

    def rep(m):
        names.append(m.group(1))
        return r"([^/]+?)"
    rx = re.sub(r":([A-Za-z_]\w*)", rep, re.escape(p).replace(r"\:", ":"))
    # Express: بدون حساسیت به حروف و با «/» اختیاری در انتها
    return re.compile("^" + rx + r"/?$", re.IGNORECASE), names


def route(method, path, order, catch=False):
    """catch=True یعنی بدنهٔ JS داخل try/catch بوده و خطا را با {success:false,error} برمی‌گرداند."""
    def deco(fn):
        rx, names = _compile_path(path)
        ROUTES.append((order, method, rx, names, fn.__name__, catch))
        return fn
    return deco


class HttpError(Exception):
    pass


def js_err_message(e):
    """پیامِ خطای پایتون؛ در JS پیام‌ها فرق دارند (مثلاً Cannot read properties of undefined)."""
    return str(e)


def pad2(n):
    return to_str(n).rjust(2, "0")


def fa_date_from_iso(s):
    return s


class Engine:
    """معادلِ همهٔ متغیرهای سراسری و توابعِ server.js."""

    def __init__(self, store, clock=None, sepidar=None, notifier=None, backup=None, log=None):
        self.store = store
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.sepidar = sepidar          # sepidar_client (read-only)
        self.notifier = notifier        # push / output messenger
        self.backup = backup            # مدیریت فایل‌های پشتیبان
        self.log = log or (lambda *a: None)
        self.lock = threading.RLock()
        self.data = None
        self.force_reload = False
        self.save_count = 0
        self.dataVersion = self.clock()
        self.sepidarDeletedCheckRunning = False
        self._after = []                # کارهای بعد از پاسخ در درخواستِ جاری
        self._init_globals()

    # ---------- زمان ----------
    def now(self):
        v = getattr(self._tls, "now", None)   # حالتِ سایه: زمانِ همان درخواست در Node
        return v if v is not None else self.clock()

    def now_iso(self):
        return iso(self.now())

    def today_fa(self):
        """new Date().toLocaleDateString('fa-IR')"""
        return fa_date(self.now())

    def todayJalali(self):
        y, m, d = jalali_parts(self.now())
        return "%d/%02d/%02d" % (y, m, d)

    # ---------- globals ----------
    def _init_globals(self):
        self.items = []
        self.users = []
        self.inventory = {}
        self.transactions = []
        self.docs = []
        self.fiscalYears = []
        self.activeFiscalYear = "1405"
        self.initialInventory = []
        self.productDefinitions = {}
        self.seqId = 1
        self.docSeq = 1
        self.batchCounter = 1
        self.productionOrders = []
        self.orderSeq = 1
        self.materialClassification = {}
        self.bomFormulas = {}
        self.appSettings = {}
        self.activityLog = []
        self.pushSubscriptions = []
        self.sepidarInbox = {"startDate": None, "decisions": {}}
        self.stockCounts = []
        self.stockCountSeq = 1
        self.itemLocations = {}
        self.minStock = {}
        self.productionTargets = []
        self.productionTargetSeq = 1

    def getDefaultData(self):
        inventory = {d["id"]: {} for d in DEPTS}
        return {
            "depts": deep_copy(DEPTS),
            "items": [],
            "users": deep_copy(DEFAULT_USERS),
            "inventory": inventory,
            "transactions": [],
            "docs": [],
            "fiscalYears": deep_copy(DEFAULT_FISCAL_YEARS),
            "activeFiscalYear": "1405",
            "initialInventory": [],
            "productDefinitions": {},
            "seq": {"id": 1, "doc": 1},
            "batchCounter": 1,
            "materialClassification": {},
            "bomFormulas": {},
            "productionOrders": [],
            "orderSeq": 1,
            "appSettings": {
                "sepidar": dict(DEFAULT_SEPIDAR_CONFIG),
                "appPort": 3000,
                "backup": {"folder": "", "autoEnabled": False, "autoIntervalHours": 24, "keepCount": 30},
                "rolePermissions": {k: list(v) for k, v in DEFAULT_ROLE_PERMISSIONS.items()},
                "outputMessenger": deep_copy(DEFAULT_OUTPUT_MESSENGER_CONFIG),
                "warehouseGate": deep_copy(DEFAULT_WAREHOUSE_GATE_CONFIG),
                "productionGate": deep_copy(DEFAULT_PRODUCTION_GATE_CONFIG),
                "push": None,
            },
            "pushSubscriptions": [],
            "activityLog": [],
            "sepidarInbox": {"startDate": None, "decisions": {}},
            "stockCounts": [],
            "stockCountSeq": 1,
            "itemLocations": {},
            "minStock": {},
            "productionTargets": [],
            "productionTargetSeq": 1,
        }

    def applyLoadedData(self, raw):
        d = self.getDefaultData()
        for k in d:
            if not truthy(raw.get(k, UNDEF)):
                raw[k] = d[k]
        self.data = data = raw
        self._clean = False
        self.items = js_or(data.get("items"), [])
        self.users = js_or(data.get("users"), [])
        self.inventory = js_or(data.get("inventory"), {})
        self.transactions = js_or(data.get("transactions"), [])
        self.docs = js_or(data.get("docs"), [])
        self.fiscalYears = js_or(data.get("fiscalYears"), deep_copy(DEFAULT_FISCAL_YEARS))
        self.activeFiscalYear = js_or(data.get("activeFiscalYear"), "1405")
        self.initialInventory = js_or(data.get("initialInventory"), [])
        self.productDefinitions = js_or(data.get("productDefinitions"), {})
        seq = data.get("seq")
        self.seqId = js_or(g(seq, "id") if isinstance(seq, dict) else UNDEF, 1)
        self.docSeq = js_or(g(seq, "doc") if isinstance(seq, dict) else UNDEF, 1)
        self.batchCounter = js_or(data.get("batchCounter"), 1)
        self.materialClassification = js_or(data.get("materialClassification"), {})
        self.bomFormulas = js_or(data.get("bomFormulas"), {})
        self.productionOrders = js_or(data.get("productionOrders"), [])
        self.orderSeq = js_or(data.get("orderSeq"), 1)
        self.appSettings = js_or(data.get("appSettings"), d["appSettings"])
        a = self.appSettings
        if not truthy(a.get("rolePermissions")):
            a["rolePermissions"] = {k: list(v) for k, v in DEFAULT_ROLE_PERMISSIONS.items()}
        rp = a["rolePermissions"]
        if not truthy(a.get("adjApproverMigrated")):
            if not isinstance(rp.get("supervisor"), list):
                rp["supervisor"] = []
            if PERM_APPROVE_ADJUSTMENTS not in rp["supervisor"]:
                rp["supervisor"].append(PERM_APPROVE_ADJUSTMENTS)
            a["adjApproverMigrated"] = True
        if not truthy(a.get("sepidarFiscalYears")):
            a["sepidarFiscalYears"] = {"1405": 13}
        if a.get("docStampFromId") is None:
            a["docStampFromId"] = self.docSeq
        if not truthy(a.get("initialDocsBackfilled")):
            made = 0
            for r in self.initialInventory:
                if truthy(r.get("docId")):
                    continue
                self.ensureInitialDoc(r, actor="سیستم", source="backfill",
                                      note="موجودی اول دوره (سند ساخته‌شده برای ثبتِ قدیمی؛ ثبت‌کننده و ساعت دقیق در سوابق قدیمی ثبت نشده بود)",
                                      createdAt=js_or(self.jalaliStrToIso(r.get("date")), UNDEF), approxTime=True)
                made += 1
            a["initialDocsBackfilled"] = True
        if not truthy(a.get("analyticsMigrated")):
            for r in ["supervisor", "warehouse", "user"]:
                if not isinstance(rp.get(r), list):
                    rp[r] = []
                if "sec-home" not in rp[r]:
                    rp[r].append("sec-home")
            if isinstance(rp.get("supervisor"), list) and "sec-forecast" not in rp["supervisor"]:
                rp["supervisor"].append("sec-forecast")
            a["analyticsMigrated"] = True
        if not truthy(a.get("stockCountMigrated")):
            for r in ["warehouse", "supervisor"]:
                if not isinstance(rp.get(r), list):
                    rp[r] = []
                if "sec-stock-count" not in rp[r]:
                    rp[r].append("sec-stock-count")
            a["stockCountMigrated"] = True
        if not truthy(a.get("sepidarSectionsMigrated")):
            if not isinstance(rp.get("warehouse"), list):
                rp["warehouse"] = []
            if "sec-sepidar-inbox" not in rp["warehouse"]:
                rp["warehouse"].append("sec-sepidar-inbox")
            a["sepidarSectionsMigrated"] = True
        if not truthy(a.get("outputMessenger")):
            a["outputMessenger"] = deep_copy(DEFAULT_OUTPUT_MESSENGER_CONFIG)
        if not truthy(a.get("warehouseGate")):
            a["warehouseGate"] = deep_copy(DEFAULT_WAREHOUSE_GATE_CONFIG)
        if not truthy(a.get("productionGate")):
            a["productionGate"] = deep_copy(DEFAULT_PRODUCTION_GATE_CONFIG)
        self.activityLog = js_or(data.get("activityLog"), [])
        self.pushSubscriptions = js_or(data.get("pushSubscriptions"), [])
        self.sepidarInbox = js_or(data.get("sepidarInbox"), {"startDate": None, "decisions": {}})
        if not truthy(self.sepidarInbox.get("decisions")):
            self.sepidarInbox["decisions"] = {}
        self.stockCounts = js_or(data.get("stockCounts"), [])
        self.stockCountSeq = js_or(data.get("stockCountSeq"),
                                   self._max_id(self.stockCounts) + 1)
        self.itemLocations = js_or(data.get("itemLocations"), {})
        self.minStock = js_or(data.get("minStock"), {})
        self.productionTargets = js_or(data.get("productionTargets"), [])
        self.productionTargetSeq = js_or(data.get("productionTargetSeq"),
                                         self._max_id(self.productionTargets) + 1)
        self.normalizeInventory()
        for dd in self.docs:
            if dd.get("source") == "sepidar" and dd.get("type") == "excess":
                dd["type"] = "receipt"
                t = next((x for x in self.transactions if x.get("id") == dd.get("transactionId")), None)
                if t and t.get("type") == "excess":
                    t["type"] = "receipt"

    @staticmethod
    def _max_id(lst):
        m = 0
        for c in lst:
            v = js_or(g(c, "id"), 0)
            m = max(m, v) if is_number(v) else m
        return m

    # ---------- خواندن/نوشتن ----------
    def loadData(self):
        if self.data is not None and not self.force_reload:
            return
        raw = self.store.load_cached()
        self.applyLoadedData(raw if raw is not None else self.getDefaultData())
        self.force_reload = False

    def normalizeInventory(self):
        for u in list(self.inventory.keys()):
            inv = self.inventory[u]
            if not truthy(inv) or not isinstance(inv, dict):
                continue
            for k in list(inv.keys()):
                v = inv[k]
                if not is_number(v) or not is_finite(v) or v == 0:
                    continue
                r = js_round(v * 1e6) / 1e6
                if r < 0 and r > -QTY_EPS:
                    r = 0
                if r != v or (r == 0 and v != 0):
                    inv[k] = num(r)

    def saveData(self):
        self.normalizeInventory()
        stampFrom = g(self.appSettings, "docStampFromId") if self.appSettings else UNDEF
        if truthy(stampFrom):
            nowIso = self.now_iso()
            for d in self.docs:
                if not truthy(d.get("createdAt")) and is_number(d.get("id")) and d["id"] >= stampFrom:
                    d["createdAt"] = nowIso
        data = self.data
        data["users"] = self.users
        data["items"] = self.items
        data["inventory"] = self.inventory
        data["transactions"] = self.transactions
        data["docs"] = self.docs
        data["fiscalYears"] = self.fiscalYears
        data["activeFiscalYear"] = self.activeFiscalYear
        data["initialInventory"] = self.initialInventory
        data["productDefinitions"] = self.productDefinitions
        data["seq"] = {"id": self.seqId, "doc": self.docSeq}
        data["batchCounter"] = self.batchCounter
        data["materialClassification"] = self.materialClassification
        data["bomFormulas"] = self.bomFormulas
        data["productionOrders"] = self.productionOrders
        data["orderSeq"] = self.orderSeq
        data["appSettings"] = self.appSettings
        data["activityLog"] = self.activityLog
        data["pushSubscriptions"] = self.pushSubscriptions
        data["sepidarInbox"] = self.sepidarInbox
        data["stockCounts"] = self.stockCounts
        data["stockCountSeq"] = self.stockCountSeq
        data["itemLocations"] = self.itemLocations
        data["minStock"] = self.minStock
        data["productionTargets"] = self.productionTargets
        data["productionTargetSeq"] = self.productionTargetSeq
        self.writeDB(data)
        self.dataVersion = self.now()

    def writeDB(self, data):
        try:
            self.store.save(data, self.now())
            self.save_count += 1
            self._clean = data is self.data
            return True
        except Exception as e:  # مثل Node: خطای نوشتن فقط لاگ می‌شود
            self.log("Error writing DB:", repr(e))
            return False

    # ---------- پیکربندی‌ها ----------
    def getSepidarConfig(self):
        cfg = js_or(g(self.appSettings, "sepidar") if self.data else UNDEF, DEFAULT_SEPIDAR_CONFIG)
        return {
            "user": g(cfg, "user"), "password": g(cfg, "password"), "server": g(cfg, "server"),
            "database": g(cfg, "database"),
            "options": {"encrypt": truthy(g(cfg, "encrypt")), "trustServerCertificate": truthy(g(cfg, "trustServerCertificate"))},
            "connectionTimeout": 30000, "requestTimeout": 30000,
        }

    def isProductionGated(self, unit):
        cfg = js_or(g(self.appSettings, "productionGate") if self.data else UNDEF, DEFAULT_PRODUCTION_GATE_CONFIG)
        return unit in js_or(g(cfg, "depts"), [])

    @staticmethod
    def warehouseGatePairKey(a, b):
        return "|".join(sorted([to_str(a), to_str(b)], key=lambda s: [ord(c) for c in s.encode("utf-16-le").decode("utf-16-le")]))

    def isDeptPairGated(self, a, b):
        cfg = js_or(g(self.appSettings, "warehouseGate") if self.data else UNDEF, DEFAULT_WAREHOUSE_GATE_CONFIG)
        return self.warehouseGatePairKey(a, b) in js_or(g(cfg, "pairs"), [])

    def getOutputMessengerConfig(self):
        return js_or(g(self.appSettings, "outputMessenger") if self.data else UNDEF, DEFAULT_OUTPUT_MESSENGER_CONFIG)

    # ---------- اعلان‌ها (بعد از پاسخ اجرا می‌شوند) ----------
    def after(self, fn):
        self._after.append(fn)

    def notifyOutputMessengerForOutputDoc(self, doc):
        cfg = self.getOutputMessengerConfig()
        if not truthy(g(cfg, "enabled")):
            return
        itemName = self.resolveItemName(doc.get("item"))
        lines = [
            "📤 خروج بین خطوط تولید ثبت شد",
            "",
            "🔢 شماره سند: " + to_str(g(doc, "id")),
            "📅 تاریخ: " + to_str(g(doc, "date")),
            "🏭 از بخش: " + to_str(self.deptName(g(doc, "fromUnit"))),
            "🏭 به بخش: " + to_str(self.deptName(g(doc, "toUnit"))),
            "",
            "📦 کد کالا: " + to_str(g(doc, "item")),
            "📝 شرح: " + to_str(itemName),
            "🔢 مقدار: " + to_str(g(doc, "qty")),
            ("🔖 بچ: " + to_str(doc.get("batchNumber"))) if truthy(doc.get("batchNumber")) else None,
            ("📝 توضیح: " + to_str(doc.get("note"))) if truthy(doc.get("note")) else None,
        ]
        message = "\n".join(x for x in lines if truthy(x))
        groups = g(cfg, "deptGroups")
        fromRoom = g(groups, to_str(g(doc, "fromUnit"))) if truthy(groups) else groups
        toRoom = g(groups, to_str(g(doc, "toUnit"))) if truthy(groups) else groups
        rooms = []
        for r in [fromRoom, toRoom]:
            if truthy(r) and r not in rooms:
                rooms.append(r)
        cfg_copy = deep_copy(cfg)
        if self.notifier and rooms:
            self.after(lambda: [self.notifier.output_messenger(cfg_copy, room, message) for room in rooms])

    def ensurePushKeys(self):
        push = g(self.appSettings, "push")
        if truthy(push) and truthy(g(push, "publicKey")) and truthy(g(push, "privateKey")):
            subj = g(push, "subject")
            if not truthy(subj) or re.search(r"example\.com", to_str(subj), re.I):
                push["subject"] = PUSH_SUBJECT_DEFAULT
                self.saveData()
            return
        pub, priv = self.notifier.generate_vapid_keys()
        self.appSettings["push"] = {"publicKey": pub, "privateKey": priv, "subject": PUSH_SUBJECT_DEFAULT}
        self.saveData()

    @staticmethod
    def pushUrlForPlatform(url, platform):
        u = js_or(url, "/")
        if platform == "desktop":
            return "/" if u.find("/mobile") == 0 else u
        return u if u.find("/mobile") == 0 else "/mobile/"

    def usersInDeptId(self, deptId):
        d = next((x for x in DEPTS if x["id"] == deptId), None)
        if not d:
            return []
        return [u.get("username") for u in self.users if u.get("unit") == d["name"]]

    def usersWithRoles(self, roles):
        return [u.get("username") for u in self.users if u.get("role") in roles]

    def sendPushToUsernames(self, usernames, payload):
        """بخشِ همگامِ تابع (انتخاب گیرنده‌ها) همین‌جا؛ ارسالِ واقعی بعد از پاسخ."""
        if not usernames:
            return
        cfg = g(self.appSettings, "push")
        if not truthy(cfg) or not truthy(g(cfg, "publicKey")) or not truthy(g(cfg, "privateKey")):
            return
        targets = [s for s in self.pushSubscriptions if s.get("username") in usernames]
        if not targets:
            return
        jobs = []
        for sub in targets:
            p = dict(payload)
            p["url"] = self.pushUrlForPlatform(payload.get("url", UNDEF), sub.get("platform"))
            jobs.append((sub.get("endpoint"), deep_copy(sub.get("keys")), stringify(p)))
        vapid = (cfg.get("subject"), cfg.get("publicKey"), cfg.get("privateKey"))

        def run():
            gone = []
            for endpoint, keys, payloadStr in jobs:
                status = self.notifier.web_push(vapid, endpoint, keys, payloadStr)
                if status in (404, 410):
                    gone.append(endpoint)
            if gone:
                with self.lock:
                    self.pushSubscriptions = [s for s in self.pushSubscriptions if s.get("endpoint") not in gone]
                    self.data["pushSubscriptions"] = self.pushSubscriptions
                    self.writeDB(self.data)
        if self.notifier:
            self.after(run)

    # ---------- کالا ----------
    def resolveItemCode(self, deptId, itemName):
        c = next((i for i in self.items if i.get("name") == itemName), None)
        if c:
            return c.get("code")
        prod = next((p for p in js_or(self.productDefinitions.get(deptId), []) if p.get("name") == itemName), None)
        if not prod:
            return None
        return js_or(prod.get("productCode"), prod.get("code"))

    def resolveItemName(self, code):
        c = next((i for i in self.items if i.get("code") == code), None)
        if c:
            return c.get("name", UNDEF)
        for dept in js_keys(self.productDefinitions):
            prod = next((p for p in js_or(self.productDefinitions.get(dept), [])
                         if p.get("code") == code or p.get("productCode") == code), None)
            if prod:
                return prod.get("name", UNDEF)
        return code

    def migrateItemRename(self, oldName, newName):
        if not truthy(oldName) or not truthy(newName) or oldName == newName:
            return
        for d in DEPTS:
            inv = self.inventory.get(d["id"])
            if not truthy(inv):
                continue
            if oldName in inv:
                inv[newName] = js_or(inv.get(newName), 0) + inv[oldName]
                del inv[oldName]
        for t in self.transactions:
            if t.get("item") == oldName:
                t["item"] = newName
        for d in self.docs:
            if d.get("item") == oldName:
                d["item"] = newName
        for t in self.initialInventory:
            if t.get("item") == oldName:
                t["item"] = newName

    @staticmethod
    def jalaliStrToIso(s):
        s = to_str(js_or(s, ""))
        s = re.sub(r"[۰-۹]", lambda m: str("۰۱۲۳۴۵۶۷۸۹".index(m.group(0))), s)
        p = [parse_int(x) for x in s.split("/")]
        if len(p) != 3 or any(is_nan(x) for x in p):
            return None
        jy, jm, jd = p
        jy -= 979
        jm -= 1
        jd -= 1
        jdm = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29]

        def jsmod(a, b):
            return int(math.fmod(a, b))
        jdn = 365 * jy + math.floor(jy / 33) * 8 + math.floor((jsmod(jy, 33) + 3) / 4)
        for i in range(0, max(jm, 0)):
            jdn += jdm[i] if i < 12 else 0
        jdn += jd
        gdn = jdn + 79
        gy = 1600 + 400 * math.floor(gdn / 146097)
        gdn = jsmod(gdn, 146097)
        leap = True
        if gdn >= 36525:
            gdn -= 1
            gy += 100 * math.floor(gdn / 36524)
            gdn = jsmod(gdn, 36524)
            if gdn >= 365:
                gdn += 1
            else:
                leap = False
        gy += 4 * math.floor(gdn / 1461)
        gdn = jsmod(gdn, 1461)
        if gdn >= 366:
            leap = False
            gdn -= 1
            gy += math.floor(gdn / 365)
            gdn = jsmod(gdn, 365)
        gdm = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        gm = 0
        while gm < 12 and gdn >= gdm[gm]:
            gdn -= gdm[gm]
            gm += 1
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        try:
            base = _dt(gy, 1, 1, tzinfo=_tz.utc)
            # Date.UTC(gy, gm, gdn+1) با سرریزِ ماه/روز
            y2 = gy + gm // 12
            m2 = gm % 12
            dt = _dt(y2, m2 + 1, 1, tzinfo=_tz.utc) + _td(days=gdn)
            return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        except Exception:
            return None

    def ensureInitialDoc(self, row, actor=UNDEF, source=UNDEF, note=UNDEF, createdAt=UNDEF, approxTime=UNDEF):
        doc = None
        if truthy(row.get("docId")):
            doc = next((d for d in self.docs if d.get("id") == row.get("docId")), None)
        if doc and doc.get("status") == "cancelled":
            doc = None
        if doc:
            if doc.get("qty", UNDEF) != row.get("qty", UNDEF):
                doc["qty"] = row.get("qty", UNDEF)
                tx = None
                if truthy(doc.get("transactionId")):
                    tx = next((t for t in self.transactions if t.get("id") == doc.get("transactionId")), None)
                if tx:
                    tx["qty"] = row.get("qty", UNDEF)
                doc["updatedAt"] = self.now_iso()
                doc["updatedBy"] = js_or(actor, "سیستم")
            return doc
        tx = {"id": self.seqId, "date": row.get("date", UNDEF), "type": "initial", "unit": row.get("unit", UNDEF),
              "item": row.get("item", UNDEF), "qty": row.get("qty", UNDEF), "note": "موجودی اول دوره",
              "targetUnit": "", "fiscalYear": row.get("fiscalYear", UNDEF)}
        self.seqId += 1
        self.transactions.append(tx)
        doc = {
            "id": self.docSeq, "date": row.get("date", UNDEF), "type": "initial", "unit": row.get("unit", UNDEF),
            "item": row.get("item", UNDEF), "qty": row.get("qty", UNDEF), "fromUnit": "", "toUnit": "",
            "note": js_or(note, "موجودی اول دوره"), "status": "approved", "fiscalYear": row.get("fiscalYear", UNDEF),
            "createdBy": js_or(actor, "سیستم"), "createdAt": js_or(createdAt, self.now_iso()),
            "transactionId": tx["id"], "parentDocId": None, "source": js_or(source, "manual"),
        }
        self.docSeq += 1
        if truthy(approxTime):
            doc["createdAtApprox"] = True
        self.docs.append(doc)
        row["docId"] = doc["id"]
        row["createdBy"] = doc["createdBy"]
        row["createdAt"] = doc["createdAt"]
        return doc

    # ---------- کمکی‌های عمومی ----------
    @staticmethod
    def deptName(id_):
        d = next((x for x in DEPTS if x["id"] == id_), None)
        return d["name"] if d else id_

    @staticmethod
    def formatNumber(n):
        if n is UNDEF or n is None:
            return "0"
        if is_number(n):
            return fa_number(n)
        return to_str(n)  # String.prototype.toLocaleString → خودِ متن

    def _ymd_local(self):
        dt = local_dt(self.now())
        return to_str(dt.year)[2:] + "%02d" % dt.month + "%02d" % dt.day

    def generateBatchNumber(self):
        b = to_str(self.batchCounter).rjust(4, "0")
        self.batchCounter += 1
        return "B" + self._ymd_local() + b

    def generateOrderBatchId(self):
        s = to_str(self.orderSeq).rjust(4, "0")
        self.orderSeq += 1
        return "ORD-" + self._ymd_local() + "-" + s

    def findRelatedDocs(self, doc):
        rel = [d for d in self.docs if d.get("type") == "output" and d.get("fromUnit", UNDEF) == doc.get("toUnit", UNDEF)
               and d.get("item", UNDEF) == doc.get("item", UNDEF) and d.get("status") == "approved"
               and d.get("batchNumber", UNDEF) == doc.get("batchNumber", UNDEF)]
        rel += [d for d in self.docs if d.get("type") in ("consume", "waste") and d.get("unit", UNDEF) == doc.get("toUnit", UNDEF)
                and d.get("item", UNDEF) == doc.get("item", UNDEF) and d.get("status") == "approved"
                and d.get("batchNumber", UNDEF) == doc.get("batchNumber", UNDEF)]
        rel += [d for d in self.docs if d.get("type") == "return" and d.get("parentDocId", UNDEF) == doc.get("id", UNDEF)
                and d.get("status") in ("return_pending", "return_approved")]
        return rel

    def findChainForDoc(self, docId, chain=None):
        if chain is None:
            chain = []
        doc = next((d for d in self.docs if d.get("id") == docId), None)
        if not doc:
            return chain
        chain.append(doc.get("id"))
        for r in self.findRelatedDocs(doc):
            if r.get("id") not in chain:
                self.findChainForDoc(r.get("id"), chain)
        return chain

    def logActivity(self, username, action, details=UNDEF):
        nextId = self._max_id(self.activityLog) + 1
        self.activityLog.append({
            "id": nextId, "timestamp": self.now_iso(), "username": js_or(username, "نامشخص"),
            "action": action, "details": js_or(details, ""),
        })
        if len(self.activityLog) > 2000:
            self.activityLog = self.activityLog[len(self.activityLog) - 2000:]
        self.saveData()

    # ---------- اعتبارسنجی ----------
    def knownItemCode(self, unit, code):
        if not isinstance(code, str) or not code:
            return False
        if any(i.get("code") == code for i in self.items):
            return True
        inv = self.inventory.get(unit) if isinstance(unit, str) else None
        if truthy(inv) and code in inv:
            return True
        return any(any(p.get("code") == code or p.get("productCode") == code for p in js_or(lst, []))
                   for lst in js_or(self.productDefinitions, {}).values())

    def validateMovement(self, body, unitFields=("unit",), needItem=True):
        if not isinstance(body, dict):
            return "درخواست نامعتبر است"
        raw = body.get("qty", UNDEF)
        if is_number(raw):
            q = raw
        elif isinstance(raw, str) and raw.strip(" \t\n\r\v\f ﻿  ") != "":
            q = to_number(raw)
        else:
            q = NaN
        if not is_finite(q) or q <= 0 or q > 1e9:
            return "مقدار نامعتبر است (باید عددی بزرگ‌تر از صفر باشد)"
        body["qty"] = q
        units = []
        for f in unitFields:
            v = body.get(f, UNDEF)
            if not any(d["id"] == v for d in DEPTS):
                return "بخش نامعتبر است (" + f + ": " + to_str(v) + ")"
            units.append(v)
        if needItem and not self.knownItemCode(units[0] if units else UNDEF, body.get("item", UNDEF)):
            return "کالا یا کد «" + to_str(body.get("item", UNDEF)) + "» در سیستم شناخته‌شده نیست"
        return None

    # ---------- تاریخ سند ----------
    @staticmethod
    def jalaliLeap(y):
        return (25 * y + 11) % 33 < 8

    def jalaliMonthDays(self, y, m):
        return 31 if m <= 6 else (30 if m <= 11 else (30 if self.jalaliLeap(y) else 29))

    def normalizeJalaliDate(self, s):
        latin = to_str("" if (s is None or s is UNDEF) else s).strip(" \t\n\r\v\f ﻿  ")
        latin = re.sub(r"[۰-۹]", lambda m: str("۰۱۲۳۴۵۶۷۸۹".index(m.group(0))), latin)
        latin = re.sub(r"[٠-٩]", lambda m: str("٠١٢٣٤٥٦٧٨٩".index(m.group(0))), latin)
        m = re.match(r"^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$", latin, re.ASCII)
        if not m:
            return {"ok": False, "error": "تاریخ را به شکل 1405/07/01 وارد کنید"}
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 1300 or y > 1500 or mo < 1 or mo > 12 or d < 1:
            return {"ok": False, "error": "تاریخ نامعتبر است"}
        if d > self.jalaliMonthDays(y, mo):
            return {"ok": False, "error": "روز " + str(d) + " در ماه " + str(mo) + " سال " + str(y) +
                    " وجود ندارد (این ماه " + str(self.jalaliMonthDays(y, mo)) + " روز دارد)"}
        return {"ok": True, "value": "%d/%02d/%02d" % (y, mo, d)}

    def resolveDocDate(self, req):
        """(تاریخ, None) یا (None, Response خطا)"""
        raw = req.body.get("date", UNDEF) if isinstance(req.body, dict) else UNDEF
        today = self.todayJalali()
        if raw is UNDEF or raw is None or to_str(raw).strip(" \t\n\r\v\f ﻿  ") == "":
            return today, None
        n = self.normalizeJalaliDate(raw)
        if not n["ok"]:
            return None, ERR(400, n["error"])
        if n["value"] > today:
            return None, ERR(400, "تاریخ سند نمی‌تواند در آینده باشد (امروز " + today + ")")
        fy = next((f for f in self.fiscalYears if to_str(g(f, "year")) == to_str(self.activeFiscalYear)), None)
        if fy and truthy(fy.get("startDate")) and truthy(fy.get("endDate")) and (
                n["value"] < fy["startDate"] or n["value"] > fy["endDate"]):
            return None, ERR(400, "تاریخ سند باید در سال مالی فعال (" + to_str(fy["startDate"]) + " تا " + to_str(fy["endDate"]) + ") باشد")
        return n["value"], None

    # ======================================================================
    # اجرای یک درخواست
    # ======================================================================
    _tls = threading.local()

    def after(self, fn):  # noqa: F811  (نسخهٔ نهایی: صفِ هر درخواست جدا)
        q = getattr(self._tls, "after", None)
        if q is None:
            q = self._tls.after = []
        q.append(fn)

    def await_(self, fn, *a, **kw):
        """معادلِ await در Node: در طولِ کارِ ورودی/خروجی، قفل آزاد است و درخواست‌های دیگر جلو می‌روند."""
        n = 0
        while True:
            try:
                self.lock.release()
                n += 1
            except RuntimeError:
                break
        try:
            return fn(*a, **kw)
        finally:
            for _ in range(n):
                self.lock.acquire()

    def handle(self, req, now_override=None):
        """(Response, [کارهای بعد از پاسخ])"""
        self._tls.after = []
        self._tls.now = now_override
        with self.lock:
            saves_before = self.save_count
            try:
                resp = self._dispatch(req)
            except Exception as e:  # خطای پیش‌بینی‌نشده بیرون از try/catch → مثل Express: 500
                import traceback
                self.log("Unhandled:", traceback.format_exc())
                resp = Response(500, "Internal Server Error", kind="text")
            if resp.status >= 400 or (req.method not in ("GET", "HEAD") and self.save_count == saves_before):
                self.force_reload = True
            self._audit(req, resp)
            # سریال‌سازی همین‌جا و زیرِ قفل (بدنه ممکن است خودِ داده‌های زنده باشد)
            if resp.kind == "json":
                resp.text = stringify(resp.body)
            elif resp.kind == "rawjson":
                resp.text = resp.body
        jobs = self._tls.after
        self._tls.after = []
        self._tls.now = None
        if now_override is not None:
            jobs = [self._with_now(j, now_override) for j in jobs]
        return resp, jobs

    def _with_now(self, fn, ms):
        def run():
            self._tls.now = ms
            try:
                fn()
            finally:
                self._tls.now = None
        return run

    def reseed(self, raw):
        """حالتِ سایه: جایگزینیِ کاملِ داده با db.jsonِ Node (شروعِ دورهٔ مقایسهٔ تازه)."""
        with self.lock:
            self.store.replace_all(raw)
            self.force_reload = True
            self.loadData()

    def _dispatch(self, req):
        for order, method, rx, names, fname, catch in sorted(ROUTES, key=lambda r: r[0]):
            if method != req.method and not (method == "GET" and req.method == "HEAD"):
                continue
            m = rx.match(req.path)
            if not m:
                continue
            from urllib.parse import unquote
            req.params = {n: unquote(v) for n, v in zip(names, m.groups())}
            fn = getattr(self, fname)
            if catch:
                try:
                    return fn(req)
                except Exception as e:
                    import traceback
                    self.log("route error:", traceback.format_exc())
                    return ERR(500, js_err_message(e))
            return fn(req)
        from html import escape
        return Response(404, '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ' +
                        req.method + " " + escape(req.path, quote=False) + "</pre>\n</body>\n</html>\n", kind="text",
                        headers={"Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff"})

    def _audit(self, req, resp):
        if req.method != "POST" or not req.path.startswith("/api/doc/"):
            return
        sub = req.path[len("/api/doc"):]
        route_ = next((r for r in AUDITED_DOC_ROUTES if r[0].match(sub)), None)
        if not route_ or resp.kind != "json":
            return
        body = resp.body
        if not (isinstance(body, dict) and truthy(body.get("success"))):
            return
        m = re.match(r"^/(\d+)/", sub)
        rb = req.body if isinstance(req.body, dict) else {}
        docId = parse_int(js_or(rb.get("docId", UNDEF), m.group(1) if m else None))
        actor = js_or(rb.get("actorUsername", UNDEF), "نامشخص")
        label = route_[1]

        def job():
            with self.lock:
                try:
                    self.loadData()
                    d = next((x for x in self.docs if x.get("id") == docId), None)
                    if d:
                        if truthy(d.get("fromUnit")) or truthy(d.get("toUnit")):
                            where = "از " + to_str(self.deptName(d.get("fromUnit", UNDEF))) + " به " + to_str(self.deptName(d.get("toUnit", UNDEF)))
                        else:
                            where = "بخش " + to_str(self.deptName(d.get("unit", UNDEF)))
                        det = ("سند " + to_str(d.get("id")) + " (" + to_str(d.get("type", UNDEF)) + ") - کالا: " +
                               to_str(self.resolveItemName(d.get("item", UNDEF))) + " (" + to_str(d.get("item", UNDEF)) +
                               "), تعداد: " + to_str(d.get("qty", UNDEF)) + " - " + where)
                    else:
                        det = "سند " + to_str(docId)
                    self.logActivity(actor, label, det)
                except Exception as e:
                    self.log("audit log failed:", repr(e))
        # setImmediate: قبل از اعلان‌های همان درخواست اجرا می‌شود
        q = self._tls.after
        q.insert(0, job)

    # ======================================================================
    # مسیرها — به ترتیبِ server.js (عددِ order همان شمارهٔ خط در server.js است)
    # ======================================================================
    @route("GET", "/api/depts", 1031)
    def r_depts(self, req):
        return J(deep_copy(DEPTS))

    _clean = False
    CHECK_FASTPATH = bool(os.environ.get("CHECK_FASTPATH"))

    @route("GET", "/api/data", 1035)
    def r_data(self, req):
        self.loadData()
        if self._clean:
            txt = self.store.json_text(list(self.data.keys()))
            if self.CHECK_FASTPATH and txt != stringify(self.data):
                raise AssertionError("fast /api/data text differs from state")
            return Response(200, txt, kind="rawjson")
        return J(self.data)

    DP_SSO_SECRET = "ef5dde8dc03b2c4cab0382397d550e56186f5bf6b73fe480b5c66b002151bd57"

    @route("GET", "/api/sso-verify", 1042)
    def r_sso_verify(self, req):
        token = to_str(js_or(req.query.get("token", UNDEF), ""))
        dot = token.rfind(".")
        if dot < 1:
            return J({"error": "توکن نامعتبر است"}, 400)
        payloadB64 = token[:dot]
        sig = token[dot + 1:]
        expected = hmac.new(self.DP_SSO_SECRET.encode(), payloadB64.encode("utf-8"), hashlib.sha256).hexdigest()
        mm = re.match(r"^((?:[0-9a-fA-F]{2})*)", sig)
        sigBuf = bytes.fromhex(mm.group(1))
        expBuf = bytes.fromhex(expected)
        if len(sigBuf) != len(expBuf) or not hmac.compare_digest(sigBuf, expBuf):
            return J({"error": "امضای توکن نامعتبر است"}, 401)
        try:
            clean = re.sub(r"[^A-Za-z0-9\-_+/]", "", payloadB64.split("=")[0])
            raw = base64.urlsafe_b64decode(clean.replace("+", "-").replace("/", "_") + "=" * (-len(clean) % 4))
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception:
            return J({"error": "توکن قابل خواندن نیست"}, 400)
        exp = g(payload, "exp") if isinstance(payload, dict) else UNDEF
        if not truthy(exp) or math.floor(self.now() / 1000) > to_number(exp):
            return J({"error": "توکن منقضی شده — دوباره از دستور پرداخت وارد شوید"}, 401)
        self.loadData()
        u = next((x for x in self.users if x.get("username") == g(payload, "u")), None)
        if not u:
            return J({"error": "کاربر متناظر در این سامانه پیدا نشد"}, 404)
        return J({"username": u.get("username", UNDEF), "fullname": u.get("fullname", UNDEF),
                  "unit": u.get("unit", UNDEF), "role": u.get("role", UNDEF)})

    @route("GET", "/api/data-version", 1076)
    def r_data_version(self, req):
        return J({"version": self.dataVersion})

    @route("POST", "/api/data", 1080, catch=True)
    def r_post_data(self, req):
        self.loadData()
        nd = js_or(req.body, {})
        pd = g(nd, "productDefinitions")
        if truthy(pd) and isinstance(pd, dict):
            self.productDefinitions = pd
            self.data["productDefinitions"] = pd
        self.saveData()
        return J({"success": True})

    @route("GET", "/api/users", 1104)
    def r_users(self, req):
        self.loadData()
        return J(self.users)

    @route("POST", "/api/users", 1109)
    def r_add_user(self, req):
        self.loadData()
        nu = req.body
        if any(u.get("username", UNDEF) == g(nu, "username") for u in self.users):
            return ERR(400, "یوزرنیم تکراری است")
        self.users.append({
            "username": g(nu, "username"), "password": g(nu, "password"),
            "fullname": js_or(g(nu, "fullname"), g(nu, "username")),
            "unit": js_or(g(nu, "unit"), "مدیریت"), "role": js_or(g(nu, "role"), "user"),
        })
        self.saveData()
        self.logActivity(g(nu, "actorUsername"), "افزودن کاربر", to_str(g(nu, "username")) + " (" + to_str(js_or(g(nu, "role"), "user")) + ")")
        return J({"success": True, "user": nu})

    @route("DELETE", "/api/users/:username", 1130)
    def r_del_user(self, req):
        self.loadData()
        username = req.params["username"]
        if username == "admin":
            return ERR(400, "نمی‌توان ادمین را حذف کرد")
        idx = next((i for i, u in enumerate(self.users) if u.get("username") == username), -1)
        if idx == -1:
            return ERR(404, "کاربر یافت نشد")
        del self.users[idx]
        self.saveData()
        self.logActivity(req.query.get("actorUsername", UNDEF), "حذف کاربر", username)
        return J({"success": True, "message": "کاربر حذف شد"})

    @route("GET", "/api/products/:dept", 1153)
    def r_products(self, req):
        self.loadData()
        return J(js_or(self.productDefinitions.get(req.params["dept"], UNDEF), []))

    @route("POST", "/api/products/copy", 1160)
    def r_products_copy(self, req):
        self.loadData()
        b = req.body
        sourceDept, targetDept, suffix, startCode = g(b, "sourceDept"), g(b, "targetDept"), g(b, "suffix"), g(b, "startCode")
        pd = self.productDefinitions
        if not truthy(pd.get(to_str(sourceDept), UNDEF)):
            return ERR(404, "بخش مبدأ یافت نشد")
        tkey = to_str(targetDept)
        if not truthy(pd.get(tkey, UNDEF)):
            pd[tkey] = []
        src = pd[to_str(sourceDept)]
        counter = js_or(parse_int(startCode), 1)
        created = skipped = 0
        for p in list(src):
            newName = to_str(p.get("name", UNDEF)) + " - " + to_str(suffix)
            code = to_str(counter)
            counter += 1
            if any(it.get("code") == code or it.get("name") == newName for it in pd[tkey]):
                skipped += 1
                continue
            pd[tkey].append({
                "code": code, "name": newName, "group": js_or(p.get("group", UNDEF), targetDept),
                "unit": js_or(p.get("unit", UNDEF), "عدد"),
                "baseFormulaCode": js_or(p.get("baseFormulaCode", UNDEF), p.get("code", UNDEF)),
                "productCode": js_or(p.get("productCode", UNDEF), None),
                "created": self.now_iso(),
            })
            created += 1
        if self.seqId < counter:
            self.seqId = counter
        self.saveData()
        return J({"success": True, "created": created, "skipped": skipped,
                  "message": to_str(created) + " محصول با موفقیت کپی شد"})

    # ---------- BOM ----------
    def ingestBomRows(self, rows):
        newBom = {}
        unclassified = {}
        keyByCodeName = {}
        variantCount = {}

        def guess(productCode, productName):
            lk = productCode + "\u0000" + productName
            if truthy(keyByCodeName.get(lk)):
                return keyByCodeName[lk]
            vi = js_or(variantCount.get(productCode), 0) + 1
            variantCount[productCode] = vi
            fk = productCode if vi == 1 else productCode + "-" + str(vi)
            keyByCodeName[lk] = fk
            return fk

        def S(v):
            return to_str("" if (v is None or v is UNDEF) else v).strip(" \t\n\r\v\f ﻿                　")

        added = processed = skipped = 0
        for row in rows:
            bomCode = S(row.get("bomCode", UNDEF))
            productCode = S(row.get("productCode", UNDEF))
            productName = S(row.get("productName", UNDEF))
            matCode = S(row.get("matCode", UNDEF))
            matName = S(row.get("matName", UNDEF))
            unit = js_or(S(row.get("unit", UNDEF)), "عدد")
            qty = parse_float(row.get("qty", UNDEF))
            qty = qty if truthy(qty) else 0
            if not productCode or not matCode:
                skipped += 1
                continue
            processed += 1
            fk = bomCode or guess(productCode, productName)
            if not truthy(newBom.get(fk)):
                newBom[fk] = {"name": productName, "productCode": productCode, "bomCode": bomCode or None, "materials": []}
            stage = js_or(self.materialClassification.get(matCode, UNDEF), None)
            if not truthy(stage):
                unclassified[matCode] = matName
            ex = next((m for m in newBom[fk]["materials"] if m.get("code") == matCode), None)
            if ex:
                if abs(ex["qty"] - qty) > 1e-9:
                    ex["qty"] = ex["qty"] + qty
            else:
                newBom[fk]["materials"].append({"code": matCode, "name": matName, "unit": unit, "qty": qty,
                                                "stage": js_or(stage, "نامشخص")})
            if not any(i.get("code") == matCode for i in self.items):
                self.items.append({"code": matCode, "name": matName, "unit": unit, "groupCode": "---",
                                   "groupName": "مواد اولیه (فرمول سپیدار)", "created": self.now_iso()})
                added += 1
            if matCode not in self.materialClassification:
                self.materialClassification[matCode] = None
        return newBom, unclassified, added, processed, skipped

    @staticmethod
    def _normalize_header(s):
        s = to_str("" if (s is None or s is UNDEF) else s).replace("ي", "ی").replace("ك", "ک").replace("‌", " ")
        s = s.strip(" \t\n\r\v\f ﻿                　")
        return re.sub(r"[\s ﻿    -   　]+", " ", s)

    @route("POST", "/api/bom/upload", 1302, catch=True)
    def r_bom_upload(self, req):
        self.loadData()
        f = req.files.get("file")
        if not f:
            return ERR(400, "فایلی ارسال نشده است")
        try:
            from xlsx_read import sheet_to_json
            rows = sheet_to_json(f)
        except Exception as pe:
            return ERR(400, "فایل اکسل قابل خواندن نیست: " + js_err_message(pe))
        if not rows:
            return ERR(400, "فایل خالی است")
        required = ["کد محصول", "محصول", "کد مواد اولیه", "مواد اولیه", "واحد", "تعداد مواد اولیه"]
        firstKeys = js_keys(rows[0])
        hm = {}
        for k in firstKeys:
            hm[self._normalize_header(k)] = k
        missing = [c for c in required if c not in hm]
        if missing:
            return ERR(400, "ستون‌های زیر در فایل یافت نشد: " + "، ".join(missing) + "\nستون‌های موجود: " + "، ".join(firstKeys))
        hasBom = "کد BOM" in hm
        norm = [{
            "bomCode": row.get(hm["کد BOM"], UNDEF) if hasBom else "",
            "productCode": row.get(hm["کد محصول"], UNDEF), "productName": row.get(hm["محصول"], UNDEF),
            "matCode": row.get(hm["کد مواد اولیه"], UNDEF), "matName": row.get(hm["مواد اولیه"], UNDEF),
            "unit": row.get(hm["واحد"], UNDEF), "qty": row.get(hm["تعداد مواد اولیه"], UNDEF),
        } for row in rows]
        newBom, unc, added, processed, skipped = self.ingestBomRows(norm)
        n = len(newBom)
        self.bomFormulas = newBom
        counts = self.rebuildProductDefinitionsFromBOM()
        self.saveData()
        return J({"success": True, "productsProcessed": n, "rowsProcessed": processed, "rowsSkipped": skipped,
                  "newMaterialsAdded": added, "usedOfficialBomCode": hasBom,
                  "unclassifiedMaterials": [{"code": c, "name": nm} for c, nm in js_items(unc)],
                  "rebuildCounts": counts,
                  "message": str(n) + " فرمول محصول از " + str(processed) + " ردیف پردازش شد"})

    @route("POST", "/api/bom/sync-from-sepidar", 1390, catch=True)
    def r_bom_sync(self, req):
        self.loadData()
        pool = self.connectToSepidar()
        if not pool:
            return ERR(502, "اتصال به دیتابیس سپیدار برقرار نشد")
        rawRows = self.sql(pool, BOM_QUERY)
        if not rawRows:
            return ERR(400, "هیچ ردیف فعالی از فرمول‌های سپیدار برنگشت")
        norm = [{"bomCode": r.get("BomCode"), "productCode": r.get("ProductCode"), "productName": r.get("ProductName"),
                 "matCode": r.get("MatCode"), "matName": r.get("MatName"), "unit": r.get("Unit"), "qty": r.get("Qty")}
                for r in rawRows]
        newBom, unc, added, processed, skipped = self.ingestBomRows(norm)
        n = len(newBom)
        self.bomFormulas = newBom
        counts = self.rebuildProductDefinitionsFromBOM()
        self.saveData()
        return J({"success": True, "productsProcessed": n, "rowsProcessed": processed, "rowsSkipped": skipped,
                  "newMaterialsAdded": added, "usedOfficialBomCode": True,
                  "unclassifiedMaterials": [{"code": c, "name": nm} for c, nm in js_items(unc)],
                  "rebuildCounts": counts,
                  "message": str(n) + " فرمول محصول از " + str(processed) + " ردیف مستقیم از سپیدار سینک شد"})

    @route("GET", "/api/materials/classification", 1454)
    def r_mat_class(self, req):
        self.loadData()
        codes = js_keys(self.materialClassification)
        seen = set(codes)
        for f in js_values(self.bomFormulas):
            for m in f.get("materials", []):
                if m.get("code") not in seen:
                    seen.add(m.get("code"))
                    codes.append(m.get("code"))
        lst = []
        for code in codes:
            item = next((i for i in self.items if i.get("code") == code), None)
            name = item.get("name", UNDEF) if item else code
            unit = item.get("unit", UNDEF) if item else ""
            if not item:
                for f in js_values(self.bomFormulas):
                    m = next((mm for mm in f.get("materials", []) if mm.get("code") == code), None)
                    if m:
                        name, unit = m.get("name", UNDEF), m.get("unit", UNDEF)
                        break
            lst.append({"code": code, "name": name, "unit": unit,
                        "stage": js_or(self.materialClassification.get(code, UNDEF), None)})
        lst.sort(key=lambda x: fa_key(to_str(x["name"])))
        return J(lst)

    @route("POST", "/api/materials/classification", 1476, catch=True)
    def r_mat_class_set(self, req):
        self.loadData()
        code, stage = g(req.body, "code"), g(req.body, "stage")
        if not truthy(code):
            return ERR(400, "کد ماده الزامی است")
        if stage not in ["cut", "solder", "inject", "laser", "pack", None, ""] or stage is UNDEF or isinstance(stage, bool):
            return ERR(400, "مرحله نامعتبر است")
        final = js_or(stage, None)
        self.materialClassification[to_str(code)] = final
        for pc in js_keys(self.bomFormulas):
            for m in self.bomFormulas[pc].get("materials", []):
                if m.get("code") == code:
                    m["stage"] = js_or(final, "نامشخص")
        self.saveData()
        return J({"success": True})

    @route("GET", "/api/bom", 1500)
    def r_bom_list(self, req):
        self.loadData()
        return J([{"formulaKey": k, "bomCode": js_or(f.get("bomCode", UNDEF), None), "productCode": f.get("productCode", UNDEF),
                   "name": f.get("name", UNDEF), "materialsCount": len(f.get("materials", []))}
                  for k, f in js_items(self.bomFormulas)])

    @route("GET", "/api/bom/cut-index", 1519)
    def r_bom_cut_index(self, req):
        self.loadData()
        idx = {}
        for k, f in js_items(self.bomFormulas):
            for m in f.get("materials", []):
                if m.get("stage") != "cut":
                    continue
                L = js_round(js_or(m.get("qty", UNDEF), 0) * 100)
                cc = "CUT-" + to_str(m.get("code", UNDEF)) + "-" + num_str(L)
                idx.setdefault(cc, []).append({"formulaKey": k, "productCode": js_or(f.get("productCode", UNDEF), None),
                                               "name": f.get("name", UNDEF)})
        return J(idx)

    @route("GET", "/api/bom/material-availability", 1543)
    def r_bom_avail(self, req):
        self.loadData()
        rawInv = js_or(self.inventory.get("raw"), {})
        report = []
        for k, f in js_items(self.bomFormulas):
            stages = {}
            for dept in ["cut", "solder", "inject", "laser", "pack"]:
                mats = [m for m in f.get("materials", []) if m.get("stage") == dept]
                if not mats:
                    stages[dept] = None
                    continue
                deptInv = js_or(self.inventory.get(dept), {})
                detail = []
                for m in mats:
                    own = js_or(deptInv.get(m.get("code"), UNDEF), 0)
                    rawq = js_or(rawInv.get(m.get("code"), UNDEF), 0)
                    q = m.get("qty", UNDEF)
                    mx = js_floor(to_number(own) / q + 1e-6) if (is_number(q) and q > 0) else math.inf
                    detail.append({"code": m.get("code", UNDEF), "name": m.get("name", UNDEF), "unit": m.get("unit", UNDEF),
                                   "qtyPerUnit": q, "ownQty": own, "rawQty": rawq, "maxFromOwn": mx})
                pq = js_min(d["maxFromOwn"] for d in detail)
                stages[dept] = {"status": "sufficient" if (not is_nan(pq) and pq >= 1) else "insufficient",
                                "producibleQty": pq if is_finite(pq) else 0, "materials": detail}
            hasUnc = any(not truthy(m.get("stage")) or m.get("stage") == "نامشخص" for m in f.get("materials", []))
            report.append({"formulaKey": k, "productCode": js_or(f.get("productCode", UNDEF), None), "name": f.get("name", UNDEF),
                           "hasUnclassified": hasUnc, "stages": stages})
        return J(report)

    @route("GET", "/api/bom/:code", 1575)
    def r_bom_one(self, req):
        self.loadData()
        code = req.params["code"]
        formula = self.bomFormulas.get(code)
        if not truthy(formula):
            return ERR(404, "فرمولی برای این کد یافت نشد")
        byStage = {"cut": [], "solder": [], "inject": [], "laser": [], "pack": [], "نامشخص": []}
        for m in formula.get("materials", []):
            st = m.get("stage")
            key = st if (isinstance(st, str) and st in byStage) else "نامشخص"
            byStage[key].append(m)
        return J({"formulaKey": code, "bomCode": js_or(formula.get("bomCode", UNDEF), None),
                  "productCode": formula.get("productCode", UNDEF), "name": formula.get("name", UNDEF),
                  "materials": formula.get("materials", UNDEF), "byStage": byStage})

    def rebuildProductDefinitionsFromBOM(self):
        counts = {}
        pd = self.productDefinitions
        for d in ["cut", "solder", "inject"]:
            pd[d] = []
            counts[d] = 0
        for code, f in js_items(self.bomFormulas):
            for stage in ["solder", "inject"]:
                pd[stage].append({"code": code, "productCode": js_or(f.get("productCode", UNDEF), None),
                                  "name": f.get("name", UNDEF), "group": stage, "unit": "عدد", "created": self.now_iso()})
                counts[stage] += 1
        counts["laser"] = len(js_or(pd.get("laser"), []))
        counts["pack"] = len(js_or(pd.get("pack"), []))
        cutSeen = {}
        for code, f in js_items(self.bomFormulas):
            for m in f.get("materials", []):
                if m.get("stage") != "cut":
                    continue
                qty = js_or(m.get("qty", UNDEF), 0)
                key = to_str(m.get("code", UNDEF)) + "_" + num_str(js_round(qty * 1000))
                if key in cutSeen:
                    continue
                L = num_str(js_round(qty * 100))
                cutSeen[key] = {"code": "CUT-" + to_str(m.get("code", UNDEF)) + "-" + L,
                                "name": to_str(m.get("name", UNDEF)) + " - " + L + " سانت",
                                "group": "cut", "unit": "عدد", "rawMaterialCode": m.get("code", UNDEF),
                                "rawMaterialName": m.get("name", UNDEF), "rawMaterialUnit": m.get("unit", UNDEF),
                                "rawMaterialQtyPerUnit": qty, "created": self.now_iso()}
        pd["cut"] = list(cutSeen.values())
        counts["cut"] = len(pd["cut"])
        return counts

    @route("POST", "/api/bom/clear-all", 1664, catch=True)
    def r_bom_clear(self, req):
        self.loadData()
        fc = len(self.bomFormulas)
        cc = len(self.materialClassification)
        mr = len([i for i in self.items if i.get("groupName") == "مواد اولیه (فرمول سپیدار)"])
        spr = sum(len(js_or(self.productDefinitions.get(d), [])) for d in STAGE_DEPTS)
        self.bomFormulas = {}
        self.materialClassification = {}
        for d in STAGE_DEPTS:
            self.productDefinitions[d] = []
        self.items = [i for i in self.items if i.get("groupName") != "مواد اولیه (فرمول سپیدار)"]
        self.saveData()
        return J({"success": True, "formulasCleared": fc, "classificationsCleared": cc, "materialsRemoved": mr,
                  "stageProductsRemoved": spr, "message": "همه جدول‌های مربوط به BOM سپیدار کاملاً پاک شد"})

    @route("POST", "/api/products/rebuild-from-bom", 1693, catch=True)
    def r_rebuild(self, req):
        self.loadData()
        if len(self.bomFormulas) == 0:
            return ERR(400, "هنوز هیچ فرمولی از سپیدار آپلود نشده است")
        counts = self.rebuildProductDefinitionsFromBOM()
        self.saveData()
        return J({"success": True, "counts": counts,
                  "message": "تعریف محصولات " + str(len(STAGE_DEPTS)) + " بخش (برش، لحیم، تزریق، لیزر، بسته‌بندی) از روی فرمول‌های سپیدار بازسازی شد"})

    @staticmethod
    def _sugg(a, qty):
        v = to_number(a) * qty if not is_number(a) else a * qty
        return js_round(v * 10000) / 10000

    @route("GET", "/api/bom/suggest/:dept/:code", 1712)
    def r_bom_suggest(self, req):
        self.loadData()
        dept, code = req.params["dept"], req.params["code"]
        qty = parse_float(req.query.get("qty", UNDEF))
        qty = qty if truthy(qty) else 1
        pd = self.productDefinitions
        S = self._sugg
        if dept == "cut":
            cp = next((p for p in js_or(pd.get("cut"), []) if p.get("code") == code), None)
            if not cp:
                return ERR(404, "این محصول برش در سیستم تعریف نشده (BOM سپیدار رو آپلود/بازسازی کردید؟)")
            mats = [{"code": cp.get("rawMaterialCode", UNDEF), "name": cp.get("rawMaterialName", UNDEF),
                     "unit": cp.get("rawMaterialUnit", UNDEF), "qtyPerUnit": cp.get("rawMaterialQtyPerUnit", UNDEF),
                     "suggestedQty": S(cp.get("rawMaterialQtyPerUnit", UNDEF), qty)}]
            return J({"success": True, "code": code, "name": cp.get("name", UNDEF), "dept": dept, "materials": mats,
                      "unclassifiedMaterials": [], "hasUnclassified": False})
        if dept == "laser":
            lp = next((p for p in js_or(pd.get("laser"), []) if p.get("code") == code), None)
            if not lp:
                return ERR(404, "این محصول لیزر در سیستم تعریف نشده (BOM سپیدار رو آپلود/بازسازی کردید؟)")
            bf = self.bomFormulas.get(to_str(lp.get("baseFormulaCode", UNDEF)))
            if not truthy(bf):
                return ERR(404, "فرمول پایه‌ی این محصول لیزر یافت نشد")
            mats = [{"code": m.get("code", UNDEF), "name": m.get("name", UNDEF), "unit": m.get("unit", UNDEF),
                     "qtyPerUnit": m.get("qty", UNDEF), "suggestedQty": S(m.get("qty", UNDEF), qty)}
                    for m in bf["materials"] if m.get("stage") == "laser"]
            mats.append({"code": lp.get("baseFormulaCode", UNDEF), "name": bf.get("name", UNDEF), "unit": "عدد",
                         "qtyPerUnit": 1, "suggestedQty": S(1, qty)})
            unc = [{"code": m.get("code", UNDEF), "name": m.get("name", UNDEF)} for m in bf["materials"]
                   if not truthy(m.get("stage")) or m.get("stage") == "نامشخص"]
            return J({"success": True, "code": code, "name": lp.get("name", UNDEF), "dept": dept, "materials": mats,
                      "unclassifiedMaterials": unc, "hasUnclassified": len(unc) > 0})
        if dept == "pack":
            pp = next((p for p in js_or(pd.get("pack"), []) if p.get("code") == code), None)
            bfc = js_or(pp.get("baseFormulaCode", UNDEF), code) if pp else code
            formula = self.bomFormulas.get(to_str(bfc))
            if not truthy(formula):
                return ERR(404, "فرمولی برای این محصول در سیستم ثبت نشده (BOM سپیدار رو آپلود کردید؟ محصول بسته‌بندی درست کپی/تعریف شده؟)")
            unc = [{"code": m.get("code", UNDEF), "name": m.get("name", UNDEF)} for m in formula["materials"]
                   if not truthy(m.get("stage")) or m.get("stage") == "نامشخص"]
            mats = [{"code": m.get("code", UNDEF), "name": m.get("name", UNDEF), "unit": m.get("unit", UNDEF),
                     "qtyPerUnit": m.get("qty", UNDEF), "suggestedQty": S(m.get("qty", UNDEF), qty)}
                    for m in formula["materials"] if m.get("stage") == "pack"]
            lasers = js_or(pd.get("laser"), [])
            lp = next((p for p in lasers if p.get("baseFormulaCode", UNDEF) == bfc), None) or \
                next((p for p in lasers if p.get("code") == "LASER-" + to_str(bfc)), None)
            mats.append({"code": lp.get("code", UNDEF) if lp else "LASER-" + to_str(bfc),
                         "name": lp.get("name", UNDEF) if lp else to_str(formula.get("name", UNDEF)) + " - بعد از لیزر",
                         "unit": "عدد", "qtyPerUnit": 1, "suggestedQty": S(1, qty)})
            return J({"success": True, "code": code, "name": pp.get("name", UNDEF) if pp else formula.get("name", UNDEF),
                      "dept": dept, "materials": mats, "unclassifiedMaterials": unc, "hasUnclassified": len(unc) > 0})
        formula = self.bomFormulas.get(code)
        if not truthy(formula):
            return ERR(404, "فرمولی برای این محصول در سیستم ثبت نشده (BOM سپیدار رو آپلود کردید؟)")
        unc = [{"code": m.get("code", UNDEF), "name": m.get("name", UNDEF)} for m in formula["materials"]
               if not truthy(m.get("stage")) or m.get("stage") == "نامشخص"]
        mats = [{"code": m.get("code", UNDEF), "name": m.get("name", UNDEF), "unit": m.get("unit", UNDEF),
                 "qtyPerUnit": m.get("qty", UNDEF), "suggestedQty": S(m.get("qty", UNDEF), qty)}
                for m in formula["materials"] if m.get("stage") == dept]
        if dept == "solder":
            for m in formula["materials"]:
                if m.get("stage") != "cut":
                    continue
                L = num_str(js_round(js_or(m.get("qty", UNDEF), 0) * 100))
                cc = "CUT-" + to_str(m.get("code", UNDEF)) + "-" + L
                cp = next((p for p in js_or(pd.get("cut"), []) if p.get("code") == cc), None)
                mats.append({"code": cc, "name": cp.get("name", UNDEF) if cp else to_str(m.get("name", UNDEF)) + " - " + L + " سانت",
                             "unit": "عدد", "qtyPerUnit": 1, "suggestedQty": S(1, qty)})
        if dept == "inject":
            mats.append({"code": code, "name": formula.get("name", UNDEF), "unit": "عدد", "qtyPerUnit": 1,
                         "suggestedQty": S(1, qty)})
        return J({"success": True, "code": code, "name": formula.get("name", UNDEF), "dept": dept, "materials": mats,
                  "unclassifiedMaterials": unc, "hasUnclassified": len(unc) > 0})

    @route("POST", "/api/production-orders", 1881, catch=True)
    def r_prod_orders(self, req):
        b = req.body
        tfk, tpc, tpn = g(b, "targetFormulaKey"), g(b, "targetProductCode"), g(b, "targetProductName")
        if not truthy(tfk) or not truthy(tpn):
            return ERR(400, "کد فرمول و نام محصول هدف الزامی است")
        self.loadData()
        obid = self.generateOrderBatchId()
        order = {"id": self.orderSeq, "orderBatchId": obid, "targetFormulaKey": tfk,
                 "targetProductCode": js_or(tpc, None), "targetProductName": tpn,
                 "startedAt": self.today_fa(), "startedBy": "سیستم", "status": "open"}
        self.productionOrders.append(order)
        self.saveData()
        return J({"success": True, "order": order, "orderBatchId": obid})

    # ---------- کمکیِ موجودی ----------
    def _inv(self, unit):
        k = to_str(unit)
        if not truthy(self.inventory.get(k)):
            self.inventory[k] = {}
        return self.inventory[k]

    def _inv_get(self, unit, item):
        inv = self.inventory.get(to_str(unit))
        if not truthy(inv):
            return UNDEF
        return inv.get(to_str(item), UNDEF)

    def _find_doc(self, docId):
        return next((d for d in self.docs if seq(d.get("id", UNDEF), docId)), None)

    def _find_user(self, username):
        return next((u for u in self.users if u.get("username", UNDEF) == username), None)

    @staticmethod
    def _role_ok(actor, roles):
        return actor is not None and actor.get("role") in roles

    # ---------- تولید ----------
    @route("POST", "/api/doc/production", 2021, catch=True)
    def r_doc_production(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        bad = self.validateMovement(req.body, ["unit"])
        if bad:
            return ERR(400, bad)
        b = req.body
        unit, item, qty, note, obid = b.get("unit"), b.get("item"), b.get("qty"), g(b, "note"), g(b, "orderBatchId")
        batch = self.generateBatchNumber()
        gated = self.isProductionGated(unit)
        tx = None
        if not gated:
            tx = {"id": self.seqId, "date": docDt, "type": "production", "unit": unit, "item": item, "qty": qty,
                  "note": js_or(note, ""), "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
            self.seqId += 1
            self.transactions.append(tx)
        doc = {"id": self.docSeq, "date": docDt, "type": "production", "unit": unit, "item": item, "qty": qty,
               "fromUnit": "", "toUnit": "", "note": js_or(note, ""),
               "status": "pending_production" if gated else "approved", "fiscalYear": self.activeFiscalYear,
               "createdBy": js_or(g(b, "actorUsername"), "سیستم"), "transactionId": tx["id"] if tx else None,
               "parentDocId": None, "batchNumber": batch, "orderBatchId": js_or(obid, None)}
        self.docSeq += 1
        self.docs.append(doc)
        if not gated:
            inv = self._inv(unit)
            if not truthy(inv.get(item)):
                inv[item] = 0
            inv[item] = add(inv[item], qty)
        self.saveData()
        resp = J({"success": True, "doc": doc, "tx": tx, "pendingWarehouse": gated,
                  "message": ("سند تولید با شماره " + to_str(doc["id"]) + " ثبت شد و در انتظار تایید انباردار است (بعد از تایید به موجودی اضافه می‌شود)")
                  if gated else ("سند تولید با شماره " + to_str(doc["id"]) + " ثبت شد"),
                  "batchNumber": batch})
        if gated:
            self.sendPushToUsernames(self.usersWithRoles(["warehouse", "admin"]), {
                "title": "🏭 تولید در انتظار تایید انباردار",
                "body": to_str(self.resolveItemName(item)) + " (" + self.formatNumber(qty) + ") - بخش " + to_str(self.deptName(unit)),
                "url": "/"})
        return resp

    @route("POST", "/api/doc/production/approve", 2106, catch=True)
    def r_doc_production_approve(self, req):
        b = req.body
        docId, actorUsername = g(b, "docId"), g(b, "actorUsername")
        self.loadData()
        actor = self._find_user(actorUsername)
        if not actor or actor.get("role") not in ("warehouse", "admin"):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند تولید را تایید کند")
        doc = self._find_doc(docId)
        if not doc or doc.get("type") != "production":
            return ERR(404, "سند تولید یافت نشد")
        if doc.get("status") != "pending_production":
            return ERR(400, "این سند در انتظار تایید انباردار نیست")
        children = [d for d in self.docs if d.get("parentDocId", UNDEF) == doc["id"] and d.get("type") == "consume"
                    and d.get("status") == "pending_production"]
        need = {}
        for c in children:
            k = to_str(c.get("unit", UNDEF)) + "|" + to_str(c.get("item", UNDEF))
            need[k] = add(js_or(need.get(k), 0), c.get("qty", UNDEF))
        errors = []
        for k, q in js_items(need):
            parts = k.split("|")
            unit, code = parts[0], (parts[1] if len(parts) > 1 else UNDEF)
            have = js_or(self._inv_get(unit, code) if truthy(self.inventory.get(unit)) else UNDEF, 0)
            if lt(add(have, QTY_EPS), q):
                errors.append("موجودی «" + to_str(self.resolveItemName(code)) + "» در " + to_str(self.deptName(unit)) +
                              " کافی نیست (موجود: " + to_str(have) + "، لازم: " + to_str(q) + ")")
        if errors:
            return ERR(400, "\n".join(errors))
        today = js_or(doc.get("date", UNDEF), self.todayJalali())
        nowIso = self.now_iso()
        ptx = {"id": self.seqId, "date": today, "type": "production", "unit": doc.get("unit", UNDEF), "item": doc.get("item", UNDEF),
               "qty": doc.get("qty", UNDEF), "note": js_or(doc.get("note", UNDEF), ""), "targetUnit": "",
               "fiscalYear": js_or(doc.get("fiscalYear", UNDEF), self.activeFiscalYear), "batchNumber": doc.get("batchNumber", UNDEF)}
        self.seqId += 1
        self.transactions.append(ptx)
        inv = self._inv(doc.get("unit", UNDEF))
        it = to_str(doc.get("item", UNDEF))
        if not truthy(inv.get(it)):
            inv[it] = 0
        inv[it] = add(inv[it], doc.get("qty", UNDEF))
        doc["status"] = "approved"
        doc["transactionId"] = ptx["id"]
        doc["approvedBy"] = actorUsername
        doc["approvedAt"] = nowIso
        for c in children:
            ctx = {"id": self.seqId, "date": today, "type": "consume", "unit": c.get("unit", UNDEF), "item": c.get("item", UNDEF),
                   "qty": c.get("qty", UNDEF), "note": js_or(c.get("note", UNDEF), ""), "targetUnit": "",
                   "fiscalYear": js_or(c.get("fiscalYear", UNDEF), self.activeFiscalYear), "batchNumber": c.get("batchNumber", UNDEF)}
            self.seqId += 1
            self.transactions.append(ctx)
            ci = self.inventory[to_str(c.get("unit"))]
            ci[to_str(c.get("item"))] = sub(ci.get(to_str(c.get("item")), UNDEF), c.get("qty", UNDEF))
            c["status"] = "approved"
            c["transactionId"] = ctx["id"]
            c["approvedBy"] = actorUsername
            c["approvedAt"] = nowIso
        self.saveData()
        self.logActivity(actorUsername, "تایید انباردار برای تولید",
                         "سند " + to_str(doc["id"]) + " - " + to_str(self.resolveItemName(doc.get("item", UNDEF))) + " (" +
                         to_str(doc.get("qty", UNDEF)) + ") در " + to_str(self.deptName(doc.get("unit", UNDEF))) + " - " +
                         str(len(children)) + " سند مصرف همراه")
        return J({"success": True, "doc": doc, "consumeCount": len(children),
                  "message": "تولید " + to_str(doc["id"]) + " توسط انباردار تایید شد و به موجودی اضافه شد"})

    @route("POST", "/api/doc/production/reject", 2169, catch=True)
    def r_doc_production_reject(self, req):
        b = req.body
        docId, actorUsername, reason = g(b, "docId"), g(b, "actorUsername"), g(b, "reason")
        self.loadData()
        actor = self._find_user(actorUsername)
        if not actor or actor.get("role") not in ("warehouse", "admin"):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند تولید را رد کند")
        doc = self._find_doc(docId)
        if not doc or doc.get("type") != "production":
            return ERR(404, "سند تولید یافت نشد")
        if doc.get("status") != "pending_production":
            return ERR(400, "این سند در انتظار تایید انباردار نیست")
        nowIso = self.now_iso()
        reasonText = (" | دلیل رد: " + to_str(reason)) if truthy(reason) else ""
        doc["status"] = "rejected"
        doc["rejectedBy"] = actorUsername
        doc["rejectedAt"] = nowIso
        if truthy(reason):
            doc["note"] = to_str(js_or(doc.get("note", UNDEF), "")) + reasonText
        for c in self.docs:
            if c.get("parentDocId", UNDEF) == doc["id"] and c.get("type") == "consume" and c.get("status") == "pending_production":
                c["status"] = "rejected"
                c["rejectedBy"] = actorUsername
                c["rejectedAt"] = nowIso
        self.saveData()
        self.logActivity(actorUsername, "رد انباردار برای تولید",
                         "سند " + to_str(doc["id"]) + " - " + to_str(self.resolveItemName(doc.get("item", UNDEF))) + " (" +
                         to_str(doc.get("qty", UNDEF)) + ") در " + to_str(self.deptName(doc.get("unit", UNDEF))) + reasonText)
        return J({"success": True, "doc": doc, "message": "تولید " + to_str(doc["id"]) + " رد شد و هیچ تغییری روی موجودی اعمال نشد"})

    @route("GET", "/api/settings/production-gate", 2202)
    def r_get_prod_gate(self, req):
        self.loadData()
        cfg = js_or(g(self.appSettings, "productionGate") if truthy(self.appSettings) else UNDEF, DEFAULT_PRODUCTION_GATE_CONFIG)
        return J({"success": True, "productionGate": cfg, "depts": [deep_copy(d) for d in DEPTS if d["type"] != "wh"]})

    @route("POST", "/api/settings/production-gate", 2208, catch=True)
    def r_set_prod_gate(self, req):
        self.loadData()
        depts, actorUsername = g(req.body, "depts"), g(req.body, "actorUsername")
        if not isinstance(depts, list):
            return ERR(400, "فرمت لیست بخش‌ها نامعتبر است")
        valid = [d["id"] for d in DEPTS if d["type"] != "wh"]
        clean = []
        for i in depts:
            if isinstance(i, str) and i in valid and i not in clean:
                clean.append(i)
        self.appSettings["productionGate"] = {"depts": clean}
        self.saveData()
        self.logActivity(actorUsername, "تغییر تنظیمات تاییدِ انباردار برای تولید",
                         "بخش‌های فعال: " + js_or("، ".join(self.deptName(x) for x in clean), "هیچ"))
        return J({"success": True, "message": "تنظیمات ذخیره شد", "depts": clean})

    def _stock_short(self, unit, item, qty):
        """!inventory[unit] || !inventory[unit][item] || inventory[unit][item] + QTY_EPS < qty"""
        inv = self.inventory.get(to_str(unit))
        if not truthy(inv):
            return True
        v = inv.get(to_str(item), UNDEF)
        if not truthy(v):
            return True
        return lt(add(v, QTY_EPS), qty)

    @route("POST", "/api/doc/consume", 2225, catch=True)
    def r_doc_consume(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        bad = self.validateMovement(req.body, ["unit"])
        if bad:
            return ERR(400, bad)
        b = req.body
        unit, item, qty = b.get("unit"), b.get("item"), b.get("qty")
        note, batchNumber, parentDocId, obid = g(b, "note"), g(b, "batchNumber"), g(b, "parentDocId"), g(b, "orderBatchId")
        if self._stock_short(unit, item, qty):
            return ERR(400, "موجودی کافی نیست")
        batch = js_or(batchNumber, UNDEF)
        if not truthy(batch):
            batch = self.generateBatchNumber()
        parent = self._find_doc(parentDocId) if truthy(parentDocId) else None
        deferred = bool(parent and parent.get("status") == "pending_production")
        tx = None
        if not deferred:
            tx = {"id": self.seqId, "date": docDt, "type": "consume", "unit": unit, "item": item, "qty": qty,
                  "note": js_or(note, ""), "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
            self.seqId += 1
            self.transactions.append(tx)
        doc = {"id": self.docSeq, "date": docDt, "type": "consume", "unit": unit, "item": item, "qty": qty,
               "fromUnit": "", "toUnit": "", "note": js_or(note, ""),
               "status": "pending_production" if deferred else "approved", "fiscalYear": self.activeFiscalYear,
               "createdBy": js_or(g(b, "actorUsername"), "سیستم"), "transactionId": tx["id"] if tx else None,
               "parentDocId": js_or(parentDocId, None), "batchNumber": batch, "orderBatchId": js_or(obid, None)}
        self.docSeq += 1
        self.docs.append(doc)
        if not deferred:
            inv = self.inventory[unit]
            inv[item] = sub(inv[item], qty)
        self.saveData()
        return J({"success": True, "doc": doc, "tx": tx, "deferred": deferred,
                  "message": "سند مصرف با شماره " + to_str(doc["id"]) + " ثبت شد"})

    def adjustmentApproverRoles(self):
        perms = js_or(g(self.appSettings, "rolePermissions") if truthy(self.appSettings) else UNDEF, {})
        return ["admin"] + [r for r in ["supervisor", "warehouse", "user"]
                            if PERM_APPROVE_ADJUSTMENTS in js_or(g(perms, r), [])]

    def isAdjustmentApprover(self, username):
        u = self._find_user(username)
        return bool(u) and u.get("role", UNDEF) in self.adjustmentApproverRoles()

    def _det(self, item, qty, unit):
        return "کالا: " + to_str(item) + ", تعداد: " + to_str(qty) + ", بخش: " + to_str(unit)

    @route("POST", "/api/doc/waste", 2310, catch=True)
    def r_doc_waste(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        bad = self.validateMovement(req.body, ["unit"])
        if bad:
            return ERR(400, bad)
        b = req.body
        unit, item, qty = b.get("unit"), b.get("item"), b.get("qty")
        note, batchNumber, actorUsername = g(b, "note"), g(b, "batchNumber"), g(b, "actorUsername")
        if self._stock_short(unit, item, qty):
            return ERR(400, "موجودی کافی نیست")
        batch = batchNumber if truthy(batchNumber) else self.generateBatchNumber()
        if not self.isAdjustmentApprover(actorUsername):
            doc = {"id": self.docSeq, "date": docDt, "type": "waste", "unit": unit, "item": item, "qty": qty,
                   "fromUnit": "", "toUnit": "", "note": js_or(note, ""), "status": "pending_approval",
                   "fiscalYear": self.activeFiscalYear, "createdBy": js_or(actorUsername, "سیستم"),
                   "transactionId": None, "parentDocId": None, "batchNumber": batch}
            self.docSeq += 1
            self.docs.append(doc)
            self.saveData()
            self.logActivity(actorUsername, "ثبت سند ضایعات (در انتظار تایید)", self._det(item, qty, unit))
            self.sendPushToUsernames(self.usersWithRoles(self.adjustmentApproverRoles()), {
                "title": "🗑️ سند ضایعات نیازمند تایید",
                "body": to_str(self.resolveItemName(item)) + " (" + self.formatNumber(qty) + ") در " + to_str(self.deptName(unit)),
                "url": "/mobile/"})
            return J({"success": True, "doc": doc, "pendingApproval": True,
                      "message": "سند ضایعات با شماره " + to_str(doc["id"]) + " ثبت شد و در انتظار تایید سرپرست/مدیر است"})
        tx = {"id": self.seqId, "date": docDt, "type": "waste", "unit": unit, "item": item, "qty": qty,
              "note": js_or(note, ""), "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
        self.seqId += 1
        self.transactions.append(tx)
        doc = {"id": self.docSeq, "date": docDt, "type": "waste", "unit": unit, "item": item, "qty": qty,
               "fromUnit": "", "toUnit": "", "note": js_or(note, ""), "status": "approved",
               "fiscalYear": self.activeFiscalYear, "createdBy": js_or(actorUsername, "سیستم"),
               "transactionId": tx["id"], "parentDocId": None, "batchNumber": batch}
        self.docSeq += 1
        self.docs.append(doc)
        self.inventory[unit][item] = sub(self.inventory[unit][item], qty)
        self.saveData()
        self.logActivity(actorUsername, "ثبت سند ضایعات", self._det(item, qty, unit))
        return J({"success": True, "doc": doc, "tx": tx, "message": "سند ضایعات با شماره " + to_str(doc["id"]) + " ثبت شد"})

    @route("POST", "/api/doc/adjust", 2407, catch=True)
    def r_doc_adjust(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        bad = self.validateMovement(req.body, ["unit"])
        if bad:
            return ERR(400, bad)
        b = req.body
        if b.get("type", UNDEF) not in ("shortage", "excess") or not isinstance(b.get("type"), str):
            return ERR(400, "نوع سند باید کسری یا اضافات باشد")
        unit, item, qty, typ = b.get("unit"), b.get("item"), b.get("qty"), b.get("type")
        note, actorUsername = g(b, "note"), g(b, "actorUsername")
        inv = self._inv(unit)
        if not truthy(inv.get(item)):
            inv[item] = 0
        txType = "shortage" if typ == "shortage" else "excess"
        label = "کسری" if typ == "shortage" else "اضافات"
        batch = self.generateBatchNumber()
        if typ == "shortage" and lt(add(inv[item], QTY_EPS), qty):
            return ERR(400, "موجودی کافی نیست")
        if not self.isAdjustmentApprover(actorUsername):
            doc = {"id": self.docSeq, "date": docDt, "type": txType, "unit": unit, "item": item, "qty": qty,
                   "fromUnit": "", "toUnit": "", "note": js_or(note, ""), "status": "pending_approval",
                   "fiscalYear": self.activeFiscalYear, "createdBy": js_or(actorUsername, "سیستم"),
                   "transactionId": None, "parentDocId": None, "batchNumber": batch}
            self.docSeq += 1
            self.docs.append(doc)
            self.saveData()
            self.logActivity(actorUsername, "ثبت سند " + label + " (در انتظار تایید)", self._det(item, qty, unit))
            self.sendPushToUsernames(self.usersWithRoles(self.adjustmentApproverRoles()), {
                "title": "⚙️ سند " + label + " نیازمند تایید",
                "body": to_str(self.resolveItemName(item)) + " (" + self.formatNumber(qty) + ") در " + to_str(self.deptName(unit)),
                "url": "/mobile/"})
            return J({"success": True, "doc": doc, "pendingApproval": True,
                      "message": "سند " + label + " با شماره " + to_str(doc["id"]) + " ثبت شد و در انتظار تایید سرپرست/مدیر است"})
        if typ == "shortage":
            inv[item] = sub(inv[item], qty)
        else:
            inv[item] = add(inv[item], qty)
        tx = {"id": self.seqId, "date": docDt, "type": txType, "unit": unit, "item": item, "qty": qty,
              "note": js_or(note, ""), "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
        self.seqId += 1
        self.transactions.append(tx)
        doc = {"id": self.docSeq, "date": docDt, "type": txType, "unit": unit, "item": item, "qty": qty,
               "fromUnit": "", "toUnit": "", "note": js_or(note, ""), "status": "approved",
               "fiscalYear": self.activeFiscalYear, "createdBy": js_or(actorUsername, "سیستم"),
               "transactionId": tx["id"], "parentDocId": None, "batchNumber": batch}
        self.docSeq += 1
        self.docs.append(doc)
        self.saveData()
        self.logActivity(actorUsername, "ثبت سند " + label, self._det(item, qty, unit))
        return J({"success": True, "doc": doc, "tx": tx, "message": "سند تعدیل با شماره " + to_str(doc["id"]) + " ثبت شد"})

    TYPE_LABELS_ADJ = {"waste": "ضایعات", "shortage": "کسری", "excess": "اضافات"}

    @route("POST", "/api/doc/pending-adjustment/approve", 2516, catch=True)
    def r_pending_adj_approve(self, req):
        b = req.body
        docId, actorUsername = g(b, "docId"), g(b, "actorUsername")
        self.loadData()
        if not self.isAdjustmentApprover(actorUsername):
            return ERR(403, "فقط مدیر یا نقش‌هایی که مجوز «تایید ضایعات/کسری/اضافات» دارند می‌توانند این سند را تایید کنند")
        doc = self._find_doc(docId)
        if not doc:
            return ERR(404, "سند یافت نشد")
        if doc.get("status") != "pending_approval":
            return ERR(400, "این سند در وضعیت مناسب برای تایید نیست")
        if doc.get("type") not in ("waste", "shortage", "excess"):
            return ERR(400, "نوع سند برای این عملیات پشتیبانی نمی‌شود")
        inv = self._inv(doc.get("unit", UNDEF))
        it = to_str(doc.get("item", UNDEF))
        if not truthy(inv.get(it)):
            inv[it] = 0
        if doc["type"] in ("waste", "shortage") and lt(add(inv[it], QTY_EPS), doc.get("qty", UNDEF)):
            return ERR(400, "موجودی کافی نیست (موجودی فعلی: " + to_str(inv[it]) + ")")
        if doc["type"] == "excess":
            inv[it] = add(inv[it], doc.get("qty", UNDEF))
        else:
            inv[it] = sub(inv[it], doc.get("qty", UNDEF))
        tx = {"id": self.seqId, "date": js_or(doc.get("date", UNDEF), self.todayJalali()), "type": doc["type"],
              "unit": doc.get("unit", UNDEF), "item": doc.get("item", UNDEF), "qty": doc.get("qty", UNDEF),
              "note": js_or(doc.get("note", UNDEF), ""), "targetUnit": "",
              "fiscalYear": js_or(doc.get("fiscalYear", UNDEF), self.activeFiscalYear), "batchNumber": doc.get("batchNumber", UNDEF)}
        self.seqId += 1
        self.transactions.append(tx)
        doc["status"] = "approved"
        doc["transactionId"] = tx["id"]
        doc["approvedBy"] = actorUsername
        doc["approvedAt"] = self.now_iso()
        self.saveData()
        self.logActivity(actorUsername, "تایید سند " + to_str(js_or(self.TYPE_LABELS_ADJ.get(doc["type"]), doc["type"])),
                         "سند " + to_str(doc["id"]) + " - " + self._det(doc.get("item", UNDEF), doc.get("qty", UNDEF), doc.get("unit", UNDEF)))
        return J({"success": True, "doc": doc, "tx": tx, "message": "سند " + to_str(doc["id"]) + " تایید و اعمال شد"})

    @route("POST", "/api/doc/pending-adjustment/reject", 2581, catch=True)
    def r_pending_adj_reject(self, req):
        b = req.body
        docId, actorUsername, reason = g(b, "docId"), g(b, "actorUsername"), g(b, "reason")
        self.loadData()
        if not self.isAdjustmentApprover(actorUsername):
            return ERR(403, "فقط مدیر یا نقش‌هایی که مجوز «تایید ضایعات/کسری/اضافات» دارند می‌توانند این سند را رد کنند")
        doc = self._find_doc(docId)
        if not doc:
            return ERR(404, "سند یافت نشد")
        if doc.get("status") != "pending_approval":
            return ERR(400, "این سند در وضعیت مناسب برای رد نیست")
        doc["status"] = "rejected"
        doc["rejectedBy"] = actorUsername
        if truthy(reason):
            doc["note"] = (to_str(doc["note"]) + " | دلیل رد: " + to_str(reason)) if truthy(doc.get("note")) else ("دلیل رد: " + to_str(reason))
        self.saveData()
        t = doc.get("type", UNDEF)
        self.logActivity(actorUsername, "رد سند " + to_str(js_or(self.TYPE_LABELS_ADJ.get(t) if isinstance(t, str) else UNDEF, t)),
                         "سند " + to_str(doc["id"]) + " - " + self._det(doc.get("item", UNDEF), doc.get("qty", UNDEF), doc.get("unit", UNDEF)))
        return J({"success": True, "doc": doc, "message": "سند " + to_str(doc["id"]) + " رد شد"})

    @route("POST", "/api/doc/output", 2618, catch=True)
    def r_doc_output(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        bad = self.validateMovement(req.body, ["from", "to"])
        if bad:
            return ERR(400, bad)
        b = req.body
        if b.get("from") == b.get("to"):
            return ERR(400, "بخش مبدأ و مقصد نمی‌تواند یکی باشد")
        frm, to, item, qty = b.get("from"), b.get("to"), b.get("item"), b.get("qty")
        note, obid, createdBy, submissionId = g(b, "note"), g(b, "orderBatchId"), g(b, "createdBy"), g(b, "submissionId")
        if self._stock_short(frm, item, qty):
            return ERR(400, "موجودی مبدأ کافی نیست")
        now = self.now()
        dup = None
        for d in self.docs:
            if (d.get("type") == "output" and d.get("status") != "rejected" and d.get("fromUnit", UNDEF) == frm
                    and d.get("toUnit", UNDEF) == to and d.get("item", UNDEF) == item
                    and to_number(d.get("qty", UNDEF)) == to_number(qty) and truthy(d.get("createdAt"))
                    and now - date_parse(d.get("createdAt")) < DUPLICATE_OUTPUT_WINDOW_MS
                    and not (truthy(submissionId) and d.get("submissionId", UNDEF) == submissionId)):
                dup = d
                break
        if dup:
            return ERR(409, "سند خروجِ مشابه (سند " + to_str(dup.get("id", UNDEF)) +
                       ") همین چند ثانیه پیش ثبت شده است - احتمالاً ثبتِ تکراری؛ اگر واقعاً دوباره لازم است، چند ثانیه بعد دوباره ثبت کنید",
                       duplicate=True)
        batch = self.generateBatchNumber()
        gate = self.isDeptPairGated(frm, to)
        doc = {"id": self.docSeq, "date": docDt, "type": "output", "unit": frm, "item": item, "qty": qty,
               "fromUnit": frm, "toUnit": to, "note": js_or(note, ""),
               "status": "pending_warehouse" if gate else "pending", "fiscalYear": self.activeFiscalYear,
               "createdBy": js_or(createdBy, "سیستم"), "createdAt": iso(now), "submissionId": js_or(submissionId, None),
               "transactionId": None, "parentDocId": None, "batchNumber": batch, "orderBatchId": js_or(obid, None)}
        self.docSeq += 1
        self.docs.append(doc)
        self.saveData()
        resp = J({"success": True, "doc": doc, "message": "سند خروج با شماره " + to_str(doc["id"]) + " ثبت شد", "batchNumber": batch})
        self.notifyOutputMessengerForOutputDoc(doc)
        targets = self.usersWithRoles(["warehouse"]) if gate else self.usersInDeptId(to)
        self.sendPushToUsernames(targets, {
            "title": "📤 سند خروج نیازمند تایید انباردار" if gate else "📤 سند خروج جدید",
            "body": to_str(self.resolveItemName(item)) + " (" + self.formatNumber(qty) + ") از " + to_str(self.deptName(frm)) + " به " + to_str(self.deptName(to)),
            "url": "/mobile/"})
        return resp

    def _move(self, frm, to, item, qty):
        inv = self.inventory[to_str(frm)]
        inv[to_str(item)] = sub(inv[to_str(item)], qty)
        ti = self._inv(to)
        if not truthy(ti.get(to_str(item))):
            ti[to_str(item)] = 0
        ti[to_str(item)] = add(ti[to_str(item)], qty)

    @route("POST", "/api/doc/output/approve", 2711, catch=True)
    def r_output_approve(self, req):
        docId = g(req.body, "docId")
        self.loadData()
        doc = self._find_doc(docId)
        if not doc:
            return ERR(404, "سند یافت نشد")
        if doc.get("status") != "pending":
            return ERR(400, "این سند قبلاً تایید شده است")
        if doc.get("type") != "output":
            return ERR(400, "این سند نیاز به تایید ندارد")
        approver = self._find_user(g(req.body, "actorUsername"))
        allowed = approver and (approver.get("role") == "admin" or approver.get("username", UNDEF) in self.usersInDeptId(doc.get("toUnit", UNDEF)))
        if not allowed:
            return ERR(403, "دریافت این کالا را فقط کاربرانِ بخش «" + to_str(self.deptName(doc.get("toUnit", UNDEF))) + "» (یا مدیر) می‌توانند تایید کنند")
        fromUnit, toUnit, item, qty = doc.get("fromUnit", UNDEF), doc.get("toUnit", UNDEF), doc.get("item", UNDEF), doc.get("qty", UNDEF)
        batch = doc.get("batchNumber") if truthy(doc.get("batchNumber")) else self.generateBatchNumber()
        if self._stock_short(fromUnit, item, qty):
            return ERR(400, "موجودی مبدأ کافی نیست")
        self._move(fromUnit, toUnit, item, qty)
        date = js_or(doc.get("date", UNDEF), self.todayJalali())
        txFrom = {"id": self.seqId, "date": date, "type": "output", "unit": fromUnit, "item": item, "qty": qty,
                  "note": js_or(doc.get("note", UNDEF), "خروج به " + to_str(self.deptName(toUnit))), "targetUnit": toUnit,
                  "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
        self.seqId += 1
        self.transactions.append(txFrom)
        date = js_or(doc.get("date", UNDEF), self.todayJalali())
        txTo = {"id": self.seqId, "date": date, "type": "input", "unit": toUnit, "item": item, "qty": qty,
                "note": js_or(doc.get("note", UNDEF), "ورود از " + to_str(self.deptName(fromUnit))), "sourceUnit": fromUnit,
                "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
        self.seqId += 1
        self.transactions.append(txTo)
        doc["transactionId"] = txFrom["id"]
        doc["transactionId2"] = txTo["id"]
        doc["status"] = "approved"
        doc["approvedBy"] = js_or(g(req.body, "actorUsername"), None)
        doc["approvedAt"] = self.now_iso()
        doc["batchNumber"] = batch
        self.saveData()
        return J({"success": True, "message": "سند خروج " + to_str(docId) + " تایید شد", "txFrom": txFrom, "txTo": txTo,
                  "batchNumber": batch})

    @route("POST", "/api/doc/output/warehouse-approve", 2805, catch=True)
    def r_output_wh_approve(self, req):
        docId, actorUsername = g(req.body, "docId"), g(req.body, "actorUsername")
        self.loadData()
        actor = self._find_user(actorUsername)
        if not actor or actor.get("role") not in ("warehouse", "admin"):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند این سند را تایید کند")
        doc = self._find_doc(docId)
        if not doc:
            return ERR(404, "سند یافت نشد")
        if doc.get("status") != "pending_warehouse":
            return ERR(400, "این سند در وضعیت مناسب برای تایید انباردار نیست")
        doc["status"] = "pending"
        doc["warehouseApprovedBy"] = actorUsername
        doc["warehouseApprovedAt"] = self.now_iso()
        self.saveData()
        self.logActivity(actorUsername, "تایید انباردار برای خروج بین بخش‌ها", self._route_det(doc))
        resp = J({"success": True, "doc": doc, "message": "سند " + to_str(doc["id"]) + " توسط انباردار تایید شد و برای تاییدِ " +
                  to_str(self.deptName(doc.get("toUnit", UNDEF))) + " آماده است"})
        self.sendPushToUsernames(self.usersInDeptId(doc.get("toUnit", UNDEF)), {
            "title": "📤 سند خروج آماده تایید",
            "body": to_str(self.resolveItemName(doc.get("item", UNDEF))) + " (" + self.formatNumber(doc.get("qty", UNDEF)) + ") از " +
                    to_str(self.deptName(doc.get("fromUnit", UNDEF))) + " - انباردار تایید کرد",
            "url": "/mobile/"})
        return resp

    def _route_det(self, doc):
        return ("سند " + to_str(doc["id"]) + " - از " + to_str(self.deptName(doc.get("fromUnit", UNDEF))) + " به " +
                to_str(self.deptName(doc.get("toUnit", UNDEF))) + " - کالا: " + to_str(doc.get("item", UNDEF)) +
                ", تعداد: " + to_str(doc.get("qty", UNDEF)))

    @route("POST", "/api/doc/output/warehouse-reject", 2843, catch=True)
    def r_output_wh_reject(self, req):
        docId, actorUsername, reason = g(req.body, "docId"), g(req.body, "actorUsername"), g(req.body, "reason")
        self.loadData()
        actor = self._find_user(actorUsername)
        if not actor or actor.get("role") not in ("warehouse", "admin"):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند این سند را رد کند")
        doc = self._find_doc(docId)
        if not doc:
            return ERR(404, "سند یافت نشد")
        if doc.get("status") != "pending_warehouse":
            return ERR(400, "این سند در وضعیت مناسب برای رد انباردار نیست")
        doc["status"] = "rejected"
        doc["rejectedBy"] = actorUsername
        if truthy(reason):
            doc["note"] = (to_str(doc["note"]) + " | دلیل رد: " + to_str(reason)) if truthy(doc.get("note")) else ("دلیل رد: " + to_str(reason))
        self.saveData()
        self.logActivity(actorUsername, "رد انباردار برای خروج بین بخش‌ها", self._route_det(doc))
        return J({"success": True, "doc": doc, "message": "سند " + to_str(doc["id"]) + " توسط انباردار رد شد"})

    @route("POST", "/api/doc/output/request-return", 2879, catch=True)
    def r_request_return(self, req):
        docId = g(req.body, "docId")
        self.loadData()
        parent = self._find_doc(docId)
        if not parent:
            return ERR(404, "سند یافت نشد")
        if parent.get("status") != "approved":
            return ERR(400, "فقط اسناد تایید شده قابل برگشت هستند")
        if parent.get("type") != "output":
            return ERR(400, "فقط اسناد خروج قابل برگشت هستند")
        if any(seq(d.get("parentDocId", UNDEF), parent["id"]) and d.get("status") in ("return_pending", "return_approved") for d in self.docs):
            return ERR(400, "قبلاً برای این سند درخواست برگشت ثبت شده است")
        batch = parent.get("batchNumber") if truthy(parent.get("batchNumber")) else self.generateBatchNumber()
        rd = {"id": self.docSeq, "date": self.todayJalali(), "type": "return", "unit": parent.get("toUnit", UNDEF),
              "item": parent.get("item", UNDEF), "qty": parent.get("qty", UNDEF), "fromUnit": parent.get("toUnit", UNDEF),
              "toUnit": parent.get("fromUnit", UNDEF),
              "note": ("برگشت از: " + to_str(parent["note"])) if truthy(parent.get("note")) else "برگشت کالا",
              "status": "return_pending", "fiscalYear": js_or(parent.get("fiscalYear", UNDEF), self.activeFiscalYear),
              "createdBy": js_or(g(req.body, "actorUsername"), "سیستم"), "transactionId": None, "parentDocId": parent["id"],
              "batchNumber": batch}
        self.docSeq += 1
        self.docs.append(rd)
        self.saveData()
        resp = J({"success": True, "message": "🔄 سند برگشت " + to_str(rd["id"]) + " ثبت شد", "doc": rd, "batchNumber": batch})
        self.sendPushToUsernames(self.usersInDeptId(rd["toUnit"]), {
            "title": "↩️ درخواست برگشت کالا",
            "body": to_str(self.resolveItemName(rd["item"])) + " (" + self.formatNumber(rd["qty"]) + ") از " + to_str(self.deptName(rd["fromUnit"])),
            "url": "/mobile/"})
        return resp

    @route("POST", "/api/doc/return/approve", 2946, catch=True)
    def r_return_approve(self, req):
        docId = g(req.body, "docId")
        self.loadData()
        rd = self._find_doc(docId)
        if not rd:
            return ERR(404, "سند برگشت یافت نشد")
        if rd.get("status") != "return_pending":
            return ERR(400, "این سند در وضعیت مناسب نیست")
        if rd.get("type") != "return":
            return ERR(400, "فقط اسناد برگشت قابل تایید هستند")
        approver = self._find_user(g(req.body, "actorUsername"))
        allowed = approver and (approver.get("role") == "admin" or approver.get("username", UNDEF) in self.usersInDeptId(rd.get("toUnit", UNDEF)))
        if not allowed:
            return ERR(403, "برگشت را فقط کاربرانِ بخش «" + to_str(self.deptName(rd.get("toUnit", UNDEF))) + "» (یا مدیر) می‌توانند تایید کنند")
        parent = self._find_doc(rd.get("parentDocId", UNDEF))
        if not parent:
            return ERR(404, "سند اصلی یافت نشد")
        fromUnit, toUnit, item, qty = rd.get("fromUnit", UNDEF), rd.get("toUnit", UNDEF), rd.get("item", UNDEF), rd.get("qty", UNDEF)
        batch = rd.get("batchNumber") if truthy(rd.get("batchNumber")) else self.generateBatchNumber()
        if self._stock_short(fromUnit, item, qty):
            return ERR(400, "موجودی مبدأ برگشت کافی نیست")
        self._move(fromUnit, toUnit, item, qty)
        for key in ("transactionId", "transactionId2"):
            if truthy(parent.get(key)):
                i = next((i for i, t in enumerate(self.transactions) if seq(t.get("id", UNDEF), parent[key])), -1)
                if i > -1:
                    del self.transactions[i]
                    parent[key] = None
        tx = {"id": self.seqId, "date": self.todayJalali(), "type": "return", "unit": fromUnit, "item": item, "qty": qty,
              "note": js_or(rd.get("note", UNDEF), "برگشت به " + to_str(self.deptName(toUnit))), "targetUnit": toUnit,
              "fiscalYear": rd.get("fiscalYear", UNDEF), "batchNumber": batch}
        self.seqId += 1
        self.transactions.append(tx)
        rd["transactionId"] = tx["id"]
        rd["status"] = "return_approved"
        rd["approvedBy"] = js_or(g(req.body, "actorUsername"), None)
        rd["approvedAt"] = self.now_iso()
        parent["status"] = "returned"
        rd["batchNumber"] = batch
        self.saveData()
        return J({"success": True, "message": "✅ برگشت سند " + to_str(docId) + " تایید شد", "doc": rd, "batchNumber": batch})

    @route("POST", "/api/doc/return/reject", 3040, catch=True)
    def r_return_reject(self, req):
        docId = g(req.body, "docId")
        self.loadData()
        rd = self._find_doc(docId)
        if not rd:
            return ERR(404, "سند برگشت یافت نشد")
        if rd.get("status") != "return_pending":
            return ERR(400, "این سند قابل لغو نیست")
        if rd.get("type") != "return":
            return ERR(400, "فقط اسناد برگشت قابل لغو هستند")
        rd["status"] = "return_rejected"
        self.saveData()
        return J({"success": True, "message": "❌ برگشت سند " + to_str(docId) + " لغو شد", "doc": rd})

    @route("DELETE", "/api/doc/:id", 3072, catch=True)
    def r_doc_delete(self, req):
        docId = parse_int(req.params["id"])
        self.loadData()
        idx = next((i for i, d in enumerate(self.docs) if seq(d.get("id", UNDEF), docId)), -1)
        if idx == -1:
            return ERR(404, "سند یافت نشد")
        doc = self.docs[idx]
        if doc.get("status") not in ("pending", "pending_warehouse", "pending_production"):
            return ERR(400, "فقط اسناد در انتظار تایید قابل حذف هستند")
        if doc.get("type") == "consume" and doc.get("status") == "pending_production":
            return ERR(400, "سند مصرفِ همراهِ تولید جدا حذف نمی‌شود؛ سند تولید را حذف کنید")
        actorUsername = g(js_or(req.body, {}), "actorUsername")
        if truthy(doc.get("warehouseApprovedBy")):
            wn = "بله (" + to_str(doc["warehouseApprovedBy"]) + ")"
        else:
            wn = "خیر (در انتظار انباردار)" if doc.get("status") == "pending_warehouse" else "خیر"
        if truthy(doc.get("fromUnit")) or truthy(doc.get("toUnit")):
            rt = "از " + to_str(self.deptName(doc.get("fromUnit", UNDEF))) + " به " + to_str(self.deptName(doc.get("toUnit", UNDEF)))
        else:
            rt = "بخش " + to_str(self.deptName(doc.get("unit", UNDEF)))
        del self.docs[idx]
        if doc.get("type") == "production" and doc.get("status") == "pending_production":
            for i in range(len(self.docs) - 1, -1, -1):
                if seq(self.docs[i].get("parentDocId", UNDEF), doc["id"]) and self.docs[i].get("status") == "pending_production":
                    del self.docs[i]
        self.logActivity(actorUsername, "حذف سند",
                         "سند " + to_str(doc["id"]) + " (" + to_str(doc.get("type", UNDEF)) + ") - کالا: " +
                         to_str(self.resolveItemName(doc.get("item", UNDEF))) + " (" + to_str(doc.get("item", UNDEF)) + "), تعداد: " +
                         to_str(doc.get("qty", UNDEF)) + " - " + rt + " - وضعیت: " + to_str(doc.get("status", UNDEF)) +
                         " - تایید انباردار: " + wn + " - ثبت‌کننده: " + to_str(js_or(doc.get("createdBy", UNDEF), "نامشخص")))
        return J({"success": True, "message": "سند " + to_str(docId) + " حذف شد"})

    CHAIN_TYPE_NAMES = {"production": "تولید", "output": "خروج به بخش", "consume": "مصرف", "waste": "ضایعات",
                        "input": "ورود به بخش", "return": "برگشت", "shortage": "کسری", "excess": "اضافات",
                        "receipt": "رسید انبار"}

    def _dec_floor0(self, unit, item, qty):
        inv = self.inventory.get(to_str(unit))
        if truthy(inv) and truthy(inv.get(to_str(item))):
            inv[to_str(item)] = sub(inv[to_str(item)], qty)
            if lt(inv[to_str(item)], 0):
                inv[to_str(item)] = 0

    def _inc(self, unit, item, qty):
        inv = self._inv(unit)
        if not truthy(inv.get(to_str(item))):
            inv[to_str(item)] = 0
        inv[to_str(item)] = add(inv[to_str(item)], qty)

    @route("POST", "/api/doc/:id/cancel", 3126, catch=True)
    def r_doc_cancel(self, req):
        docId = parse_int(req.params["id"])
        self.loadData()
        doc = self._find_doc(docId)
        if not doc:
            return ERR(404, "سند یافت نشد")
        if doc.get("status") == "cancelled":
            return ERR(400, "این سند قبلاً لغو شده است")
        if doc.get("status") not in ("approved", "pending"):
            return ERR(400, "فقط سندهای در انتظار یا تایید شده قابل لغو هستند")
        if doc.get("type") in ("consume", "waste") and truthy(doc.get("parentDocId")):
            p = self._find_doc(doc["parentDocId"])
            if p and p.get("status") == "approved":
                return ERR(400, "❌ این سند مصرف قابل لغو نیست!\nاین سند بخشی از موادِ سند تولید " + to_str(p["id"]) + " (" +
                           to_str(self.resolveItemName(p.get("item", UNDEF))) + ") است که هنوز تایید شده.\nبرای برگرداندن این ماده، ابتدا خودِ سند تولید " +
                           to_str(p["id"]) + " را لغو کنید؛ لغو آن به‌صورت خودکار همه‌ی مصرف‌های موادش (از جمله همین سند) را هم برمی‌گرداند و اگر کالای تولیدی به بخش دیگری منتقل شده باشد جلوی لغو را می‌گیرد.")
        chain = self.findChainForDoc(docId)
        if len(chain) > 1 and seq(chain[0], docId):
            lines = []
            for id_ in chain:
                d = self._find_doc(id_)
                if not d:
                    lines.append("سند " + to_str(id_))
                    continue
                t = d.get("type")
                tn = self.CHAIN_TYPE_NAMES.get(t, "") if isinstance(t, str) else ""
                lines.append("سند " + to_str(id_) + " (" + tn + ")")
            return ERR(400, "❌ این سند قابل لغو نیست!\nزنجیره اسناد وابسته:\n" + "\n".join(lines) + "\n\nلطفاً ابتدا اسناد بعدی را لغو کنید.")
        D = doc
        if D.get("type") == "production":
            outs = [d for d in self.docs if d.get("type") == "output" and d.get("fromUnit", UNDEF) == D.get("unit", UNDEF)
                    and d.get("item", UNDEF) == D.get("item", UNDEF) and d.get("status") in ("approved", "pending")
                    and not seq(d.get("id", UNDEF), docId)]
            if outs:
                det = "\n".join("سند خروج " + to_str(d.get("id", UNDEF)) + " به " + to_str(self.deptName(d.get("toUnit", UNDEF))) + " (" +
                                self.formatNumber(d.get("qty", UNDEF)) + " عدد)" + (" - در انتظار تایید" if d.get("status") == "pending" else "")
                                for d in outs)
                return ERR(400, "❌ این سند تولید قابل لغو نیست!\nکالا به بخش‌های دیگر منتقل شده یا در حال انتقال است:\n" + det +
                           "\n\nلطفاً ابتدا خروج‌های مربوطه را لغو/رد کنید.")
            cons = [d for d in self.docs if d.get("type") in ("consume", "waste") and d.get("unit", UNDEF) == D.get("unit", UNDEF)
                    and d.get("item", UNDEF) == D.get("item", UNDEF) and d.get("status") == "approved" and not seq(d.get("id", UNDEF), docId)]
            if cons:
                return ERR(400, "❌ این سند تولید قابل لغو نیست!\nاز این کالا مصرف/ضایعات ثبت شده است.\nلطفاً ابتدا اسناد مصرف/ضایعات مربوطه را لغو کنید.")
        if D.get("type") == "output":
            outs = [d for d in self.docs if d.get("type") == "output" and d.get("fromUnit", UNDEF) == D.get("toUnit", UNDEF)
                    and d.get("item", UNDEF) == D.get("item", UNDEF) and d.get("status") in ("approved", "pending")
                    and not seq(d.get("id", UNDEF), docId)]
            if outs:
                det = "\n".join("سند خروج " + to_str(d.get("id", UNDEF)) + " از " + to_str(self.deptName(d.get("fromUnit", UNDEF))) + " به " +
                                to_str(self.deptName(d.get("toUnit", UNDEF))) + " (" + self.formatNumber(d.get("qty", UNDEF)) + " عدد)" +
                                (" - در انتظار تایید" if d.get("status") == "pending" else "") for d in outs)
                return ERR(400, "❌ این سند خروج قابل لغو نیست!\nکالا از بخش مقصد به بخش‌های دیگر منتقل شده یا در حال انتقال است:\n" + det +
                           "\n\nلطفاً ابتدا خروج‌های بعدی را لغو/رد کنید.")
            cons = [d for d in self.docs if d.get("type") in ("consume", "waste") and d.get("unit", UNDEF) == D.get("toUnit", UNDEF)
                    and d.get("item", UNDEF) == D.get("item", UNDEF) and d.get("status") == "approved" and not seq(d.get("id", UNDEF), docId)]
            if cons:
                return ERR(400, "❌ این سند خروج قابل لغو نیست!\nاز این کالا در بخش مقصد مصرف/ضایعات ثبت شده است.\nلطفاً ابتدا اسناد مصرف/ضایعات مربوطه را لغو کنید.")
        if D.get("status") == "pending":
            D["status"] = "cancelled"
            self.saveData()
            return J({"success": True, "message": "سند " + to_str(docId) + " لغو شد"})
        preTx = None
        if truthy(D.get("transactionId")):
            preTx = next((t for t in self.transactions if seq(t.get("id", UNDEF), D["transactionId"])), None)
        if preTx:
            drain = None
            if preTx.get("type") in ("production", "excess", "initial", "receipt", "input"):
                drain = preTx.get("unit", UNDEF)
            elif preTx.get("type") == "output":
                drain = preTx.get("targetUnit", UNDEF)
            if truthy(drain):
                inv = self.inventory.get(to_str(drain))
                haveNow = js_or(inv.get(to_str(preTx.get("item", UNDEF)), UNDEF) if truthy(inv) else inv, 0)
                if lt(add(haveNow, QTY_EPS), preTx.get("qty", UNDEF)):
                    return ERR(400, "❌ این سند قابل لغو نیست!\nموجودیِ فعلیِ «" + to_str(self.resolveItemName(preTx.get("item", UNDEF))) + "» در " +
                               to_str(self.deptName(drain)) + " (" + to_str(haveNow) + ") کمتر از مقدارِ این سند (" + to_str(preTx.get("qty", UNDEF)) +
                               ") است؛ یعنی بخشی از آن قبلاً مصرف یا خارج شده و با لغوش موجودی منفی می‌شود.\nابتدا اسنادِ مصرف/تولید/خروجِ بعدیِ همین کالا را لغو کنید، بعد این سند را لغو کنید.")
        if truthy(D.get("transactionId")):
            i = next((i for i, t in enumerate(self.transactions) if seq(t.get("id", UNDEF), D["transactionId"])), -1)
            if i > -1:
                tx = self.transactions[i]
                tt = tx.get("type")
                if tt in ("production", "excess", "initial", "receipt"):
                    self._dec_floor0(tx.get("unit", UNDEF), tx.get("item", UNDEF), tx.get("qty", UNDEF))
                elif tt in ("consume", "waste", "shortage"):
                    self._inc(tx.get("unit", UNDEF), tx.get("item", UNDEF), tx.get("qty"))
                elif tt == "output":
                    self._inc(tx.get("unit", UNDEF), tx.get("item", UNDEF), tx.get("qty"))
                    self._dec_floor0(tx.get("targetUnit", UNDEF), tx.get("item", UNDEF), tx.get("qty"))
                elif tt == "input":
                    self._dec_floor0(tx.get("unit", UNDEF), tx.get("item", UNDEF), tx.get("qty", UNDEF))
                del self.transactions[i]
                D["transactionId"] = None
        if truthy(D.get("transactionId2")):
            i = next((i for i, t in enumerate(self.transactions) if seq(t.get("id", UNDEF), D["transactionId2"])), -1)
            if i > -1:
                del self.transactions[i]
                D["transactionId2"] = None
        reversed_ = []
        if D.get("type") == "production":
            linked = [d for d in self.docs if seq(d.get("parentDocId", UNDEF), D["id"]) and d.get("type") == "consume" and d.get("status") == "approved"]
            for md in linked:
                if truthy(md.get("transactionId")):
                    i = next((i for i, t in enumerate(self.transactions) if seq(t.get("id", UNDEF), md["transactionId"])), -1)
                    if i > -1:
                        del self.transactions[i]
                self._inc(md.get("unit", UNDEF), md.get("item", UNDEF), md.get("qty"))
                md["transactionId"] = None
                md["status"] = "cancelled"
                reversed_.append({"id": md.get("id", UNDEF), "item": md.get("item", UNDEF), "qty": md.get("qty", UNDEF)})
        D["status"] = "cancelled"
        if D.get("type") == "initial":
            self.initialInventory = [r for r in self.initialInventory if not seq(r.get("docId", UNDEF), D["id"])]
        self.saveData()
        return J({"success": True, "message": "سند " + to_str(docId) + " با موفقیت لغو شد",
                  "reversedMaterialDocs": reversed_ if reversed_ else UNDEF})

    # ======================================================================
    # سپیدار (فقط خواندنی)
    # ======================================================================
    sepidarPool = None
    lastSepidarConfigJSON = None

    def connectToSepidar(self):
        try:
            cfg = self.getSepidarConfig()
            cj = stringify(cfg)
            if self.sepidarPool and cj != self.lastSepidarConfigJSON:
                self.sepidarPool = None
            if self.sepidarPool:
                try:
                    self.await_(self.sepidarPool.query, "SELECT 1", {})
                    return self.sepidarPool
                except Exception:
                    self.sepidarPool = None
            if self.sepidar is None:
                raise Exception("Sepidar client not configured")
            self.sepidarPool = self.await_(self.sepidar.connect, cfg)
            self.lastSepidarConfigJSON = cj
            return self.sepidarPool
        except Exception as e:
            self.log("❌ خطا در اتصال به دیتابیس سپیدار:", js_err_message(e))
            return None

    def sql(self, pool, text, params=None):
        return self.await_(pool.query, text, params or {})

    @staticmethod
    def _trim(v):
        if v is None or v is UNDEF:
            return ""
        return to_str(v).strip(" \t\n\r\v\f ﻿                　")

    def getInventoryFromSepidar(self, fiscalYear):
        try:
            pool = self.connectToSepidar()
            if not pool:
                return {"success": False, "error": "اتصال به سپیدار برقرار نشد", "data": []}
            year = js_or(fiscalYear, 13)
            q = ("\n      SELECT \n        ItemCode,\n        ItemTitle_En,\n        UnitTitle,\n        Quantity\n      FROM INV.vwItemStockSummary\n"
                 "      WHERE StockTitle = 'انبار توليد - مواد اوليه'\n        AND FiscalYearRef = " + to_str(year) +
                 "\n        AND Quantity != 0\n      ORDER BY ItemCode\n    ")
            rs = self.sql(pool, q)
            return {"success": True, "data": rs, "count": len(rs), "fiscalYear": year}
        except Exception as e:
            return {"success": False, "error": js_err_message(e), "data": []}

    def getItemsFromSepidar(self):
        try:
            pool = self.connectToSepidar()
            if not pool:
                return {"success": False, "error": "اتصال به سپیدار برقرار نشد", "data": []}
            q = ("\n      SELECT \n        Code,\n        Title,\n        CodingGroupTitle\n      FROM INV.vwItem\n      WHERE IsActive = 1\n      ORDER BY Code\n    ")
            rs = self.sql(pool, q)
            return {"success": True, "data": rs, "count": len(rs)}
        except Exception as e:
            return {"success": False, "error": js_err_message(e), "data": []}

    def syncFromSepidar(self, fiscalYear, actorName):
        self.loadData()
        result = self.getInventoryFromSepidar(fiscalYear)
        if not result["success"]:
            return {"success": False, "error": result["error"]}
        if len(result["data"]) == 0:
            return {"success": True, "message": "هیچ داده‌ای برای همگام‌سازی وجود ندارد", "added": 0, "updated": 0, "total": 0}
        added = updated = processed = 0
        for row in result["data"]:
            processed += 1
            code = self._trim(row.get("ItemCode"))
            name = self._trim(row.get("ItemTitle_En"))
            unit = js_or(self._trim(row.get("UnitTitle")) if row.get("UnitTitle") is not None else "", "عدد")
            quantity = parse_float(row.get("Quantity", UNDEF))
            quantity = quantity if truthy(quantity) else 0
            if not code or not name:
                continue
            ex = next((i for i in self.items if i.get("code") == code), None)
            if ex:
                if ex.get("name", UNDEF) != name:
                    self.migrateItemRename(ex.get("name", UNDEF), name)
                ex["name"] = name
                ex["unit"] = unit
                updated += 1
            else:
                self.items.append({"code": code, "name": name, "unit": unit, "groupCode": "---", "groupName": "مواد اولیه"})
                added += 1
                for d in DEPTS:
                    inv = self._inv(d["id"])
                    if not truthy(inv.get(code)):
                        inv[code] = 0
            rawinv = self.inventory.get("raw")
            currentQty = js_or(rawinv.get(code, UNDEF) if truthy(rawinv) or isinstance(rawinv, dict) else UNDEF, 0)
            if not seq(currentQty, quantity):
                self._inv("raw")[code] = quantity
                ie = next((t for t in self.initialInventory if t.get("unit") == "raw" and t.get("item") == code), None)
                if ie:
                    ie["qty"] = quantity
                    ie["date"] = self.today_fa()
                else:
                    ie = {"unit": "raw", "item": code, "qty": quantity, "date": self.today_fa(), "fiscalYear": self.activeFiscalYear}
                    self.initialInventory.append(ie)
                self.ensureInitialDoc(ie, actor=actorName, source="sepidar-sync", note="موجودی اول دوره (دریافت از سپیدار)")
        self.saveData()
        self.logActivity(js_or(actorName, "سیستم"), "دریافت موجودی از سپیدار",
                         str(processed) + " کالا پردازش شد (" + str(added) + " جدید)، سال مالی سپیدار: " + to_str(result.get("fiscalYear")))
        return {"success": True, "added": added, "updated": updated, "total": processed, "fiscalYear": result.get("fiscalYear"),
                "message": str(processed) + " کالا پردازش شد (" + str(added) + " جدید، " + str(updated) + " به‌روزرسانی)"}

    def syncItemsFromSepidar(self):
        result = self.getItemsFromSepidar()
        if not result["success"]:
            return {"success": False, "error": result["error"]}
        if len(result["data"]) == 0:
            return {"success": True, "message": "هیچ کالایی برای همگام‌سازی وجود ندارد", "added": 0, "updated": 0, "total": 0}
        added = updated = processed = 0
        for row in result["data"]:
            processed += 1
            code = self._trim(row.get("Code"))
            name = self._trim(row.get("Title"))
            groupName = js_or(self._trim(row.get("CodingGroupTitle")), "مواد اولیه")
            if not code or not name:
                continue
            ex = next((i for i in self.items if i.get("code") == code), None)
            if ex:
                if ex.get("name", UNDEF) != name:
                    self.migrateItemRename(ex.get("name", UNDEF), name)
                ex["name"] = name
                ex["groupName"] = groupName
                updated += 1
            else:
                self.items.append({"code": code, "name": name, "unit": "عدد", "groupCode": "---", "groupName": groupName})
                added += 1
                for d in DEPTS:
                    inv = self._inv(d["id"])
                    if not truthy(inv.get(code)):
                        inv[code] = 0
        self.saveData()
        return {"success": True, "added": added, "updated": updated, "total": processed,
                "message": str(processed) + " کالا پردازش شد (" + str(added) + " جدید، " + str(updated) + " به‌روزرسانی)"}

    @route("GET", "/api/sync/sepidar", 3390, catch=True)
    def r_sync_sepidar(self, req):
        self.loadData()
        q = req.query
        if truthy(self.sepidarInbox.get("startDate")) and q.get("force") != "1":
            return J({"success": False, "locked": True,
                      "error": "صندوق اسناد سپیدار فعاله و موجودی با تاییدِ اسناد به‌روز می‌شه. اجرای این همگام‌سازی موجودیِ انبار مواد اولیه رو کاملاً با سپیدار بازنویسی می‌کنه و حرکت‌های ثبت‌شده رو می‌پوشونه."}, 409)
        if q.get("force") == "1" and not self.inboxActor(q.get("actor", UNDEF), ["admin"]):
            return ERR(403, "فقط مدیر می‌تواند این همگام‌سازی را با تایید صریح اجرا کند")
        fy = self.resolveSepidarFiscalYear(parse_int(q.get("year", UNDEF)))["ref"]
        if q.get("force") == "1":
            self.logActivity(q.get("actor", UNDEF), "⚠️ همگام‌سازی موجودی سپیدار (با وجود قفل صندوق)", "سال مالی سپیدار: " + to_str(fy))
        r = self.syncFromSepidar(fy, q.get("actor", UNDEF))
        if r["success"]:
            return J({"success": True, "message": r.get("message"), "added": js_or(r.get("added", UNDEF), 0),
                      "updated": js_or(r.get("updated", UNDEF), 0), "total": js_or(r.get("total", UNDEF), 0),
                      "fiscalYear": r.get("fiscalYear", UNDEF)})
        return ERR(500, js_or(r.get("error", UNDEF), "خطا در همگام‌سازی"))

    @route("GET", "/api/sync/sepidar-items", 3430, catch=True)
    def r_sync_items(self, req):
        r = self.syncItemsFromSepidar()
        if r["success"]:
            return J({"success": True, "message": r.get("message"), "added": js_or(r.get("added", UNDEF), 0),
                      "updated": js_or(r.get("updated", UNDEF), 0), "total": js_or(r.get("total", UNDEF), 0)})
        return ERR(500, js_or(r.get("error", UNDEF), "خطا در همگام‌سازی کالاها"))

    @route("GET", "/api/sepidar/reconcile", 3462, catch=True)
    def r_reconcile(self, req):
        self.loadData()
        fyInfo = self.resolveSepidarFiscalYear(parse_int(req.query.get("year", UNDEF)))
        fy = fyInfo["ref"]
        pool = self.connectToSepidar()
        if not pool:
            return ERR(500, "اتصال به سپیدار برقرار نشد")
        whs = []
        for w in RECONCILE_STOCKS:
            rs = self.sql(pool, "\n        SELECT ItemCode, MAX(ItemTitle) AS ItemTitle, MAX(UnitTitle) AS UnitTitle, SUM(Quantity) AS Quantity\n"
                                "        FROM INV.vwItemStockSummary\n        WHERE StockRef = " + str(w["stockRef"]) +
                                " AND FiscalYearRef = " + to_str(fy) + "\n        GROUP BY ItemCode\n        HAVING SUM(Quantity) <> 0\n      ")
            sq, st = {}, {}
            for row in rs:
                code = self._trim(js_or(row.get("ItemCode"), ""))
                if not code:
                    continue
                v = parse_float(row.get("Quantity", UNDEF))
                sq[code] = v if truthy(v) else 0
                st[code] = self._trim(js_or(row.get("ItemTitle"), ""))
            local = js_or(self.inventory.get(w["dept"]), {})
            pendingOut = {}
            for d in self.docs:
                if d.get("type") == "output" and d.get("fromUnit") == w["dept"] and d.get("status") in ("pending", "pending_warehouse"):
                    k = to_str(d.get("item", UNDEF))
                    v = parse_float(d.get("qty", UNDEF))
                    pendingOut[k] = js_or(pendingOut.get(k), 0) + (v if truthy(v) else 0)
            codes = []
            seen = set()
            for k in js_keys(sq) + [k for k in js_keys(local) if js_or(parse_float(local[k]), 0) != 0]:
                if k not in seen:
                    seen.add(k)
                    codes.append(k)
            rows = []
            ok = 0
            for code in codes:
                s = sq[code] if code in sq else 0
                l = parse_float(local.get(code, UNDEF))
                l = l if truthy(l) else 0
                diff = js_round((l - s) * 1000) / 1000
                if abs(diff) < 0.0005:
                    status = "ok"
                elif code not in sq:
                    status = "only_local"
                elif l == 0:
                    status = "only_sepidar"
                else:
                    status = "diff"
                if status == "ok":
                    ok += 1
                rn = self.resolveItemName(code)
                rows.append({"code": code, "name": rn if rn != code else js_or(st.get(code), code), "sepidar": s, "local": l,
                             "diff": num(diff), "status": status, "pendingOut": js_or(pendingOut.get(code), 0)})
            rows.sort(key=lambda r: (1 if r["status"] == "ok" else 0, -abs(r["diff"])))
            whs.append({"dept": w["dept"], "title": w["title"], "stockRef": w["stockRef"], "total": len(rows), "okCount": ok,
                        "mismatchCount": len(rows) - ok, "rows": rows})
        return J({"success": True, "fiscalYear": fy, "fiscalYearSource": fyInfo["source"], "checkedAt": self.now_iso(), "warehouses": whs})

    # ---------- صندوق اسناد ----------
    @staticmethod
    def normalizeFa(s):
        return Engine._trim("" if s is None or s is UNDEF else to_str(s).replace("ي", "ی").replace("ك", "ک"))

    @staticmethod
    def classifyInboxDoc(family, row):
        t = row.get("Type")
        if family == "issue":
            if seq(t, 4):
                return "transfer_to_assembly" if row.get("DestinationStockRef") in INBOX_ASSEMBLY_STOCK_REFS else "transfer_out_other"
            if seq(t, 2):
                return "direct_consumption"
            return "other_out"
        if truthy(row.get("IsOpening")):
            return "opening"
        if seq(t, 1):
            return "purchase_receipt"
        if seq(t, 5):
            return "return_from_assembly" if row.get("BaseInventoryDeliveryStockRef") in INBOX_ASSEMBLY_STOCK_REFS else "transfer_in"
        if seq(t, 3):
            return "code_fix" if "اصلاح" in Engine.normalizeFa(row.get("Description")) else "other_in"
        return "other_in"

    def fetchSepidarInboxDocs(self, frm=None, onlyKey=None, onlyKeys=None):
        pool = self.connectToSepidar()
        if not pool:
            raise Exception("اتصال به سپیدار برقرار نشد")
        keyList = onlyKeys if onlyKeys else ([onlyKey] if onlyKey else None)
        if keyList and not all(isinstance(k, str) and re.match(r"^[DR]\d+$", k, re.ASCII) for k in keyList):
            raise Exception("کلید سند نامعتبر است")

        def idsOf(p):
            return [parse_int(k[1:]) for k in keyList if k[0] == p] if keyList else None
        issueIds, receiptIds = idsOf("D"), idsOf("R")
        rowsIssue, rowsReceipt = [], []
        if not keyList or issueIds:
            params = {}
            cond = "d.StockRef = " + str(INBOX_RAW_STOCK_REF)
            if keyList:
                cond += " AND d.InventoryDeliveryID IN (" + ",".join(to_str(x) for x in issueIds) + ")"
            else:
                params["from"] = frm
                cond += " AND d.Date >= @from"
            rowsIssue += self.sql(pool, "\n      SELECT d.InventoryDeliveryID AS id, d.Number, d.Date, d.Type, d.DestinationStockRef, d.DestinationStockTitle,\n"
                                        "             d.DLTitle, d.Description, d.FiscalYearRef,\n"
                                        "             i.RowNumber, i.ItemCode, i.ItemTitle, i.UnitTitle, i.Quantity\n"
                                        "      FROM INV.vwInventoryDelivery d\n"
                                        "      JOIN INV.vwInventoryDeliveryItem i ON i.InventoryDeliveryRef = d.InventoryDeliveryID\n"
                                        "      WHERE " + cond + "\n      ORDER BY d.InventoryDeliveryID DESC, i.RowNumber\n    ", params)
        if not keyList or receiptIds:
            params = {}
            cond = "r.StockRef = " + str(INBOX_RAW_STOCK_REF)
            if keyList:
                cond += " AND r.InventoryReceiptID IN (" + ",".join(to_str(x) for x in receiptIds) + ")"
            else:
                params["from"] = frm
                cond += " AND r.Date >= @from"
            rowsReceipt += self.sql(pool, "\n      SELECT r.InventoryReceiptID AS id, r.Number, r.Date, r.Type, r.PurchaseType, r.IsOpening,\n"
                                          "             r.BaseInventoryDeliveryStockRef, r.BaseInventoryDeliveryStockTitle, r.DelivererTitle,\n"
                                          "             r.Description, r.FiscalYearRef,\n"
                                          "             i.RowNumber, i.ItemCode, i.ItemTitle, i.UnitTitle, i.Quantity\n"
                                          "      FROM INV.vwInventoryReceipt r\n"
                                          "      JOIN INV.vwInventoryReceiptItem i ON i.InventoryReceiptRef = r.InventoryReceiptID\n"
                                          "      WHERE " + cond + "\n      ORDER BY r.InventoryReceiptID DESC, i.RowNumber\n    ", params)
        known = set(i.get("code") for i in self.items)
        sd = self.sepidarInbox.get("startDate")
        startMs = date_parse(sd) if truthy(sd) else None

        def build(fam, rows):
            byId = {}
            order = []
            for row in rows:
                rid = row.get("id")
                doc = byId.get(rid)
                if not doc:
                    kind = self.classifyInboxDoc(fam, row)
                    key = ("D" if fam == "issue" else "R") + to_str(rid)
                    dec = self.getActiveInboxDecision(key)
                    reopened = (not dec) and truthy(self.sepidarInbox["decisions"].get(key))
                    status = dec.get("status", UNDEF) if dec else "new"
                    if status == "new" and (startMs is None or self._date_ms(row.get("Date")) < startMs):
                        status = "old"
                    if fam == "issue":
                        cp = js_or(self.normalizeFa(row.get("DestinationStockTitle")), self.normalizeFa(row.get("DLTitle")))
                        other = to_str(row.get("DestinationStockRef", UNDEF))
                    else:
                        cp = js_or(self.normalizeFa(row.get("BaseInventoryDeliveryStockTitle")), self.normalizeFa(row.get("DelivererTitle")))
                        other = self._jsplus(row.get("BaseInventoryDeliveryStockRef", UNDEF), ":") + to_str(row.get("Type", UNDEF))
                    doc = {"key": key, "family": fam, "number": row.get("Number", UNDEF), "date": row.get("Date", UNDEF), "kind": kind,
                           "kindLabel": INBOX_KIND_LABELS.get(kind, UNDEF), "approvable": kind in INBOX_APPROVABLE_KINDS,
                           "status": status, "reopened": reopened,
                           "decidedBy": dec.get("decidedBy", UNDEF) if dec else None,
                           "decidedAt": dec.get("decidedAt", UNDEF) if dec else None,
                           "createdDocIds": js_or(dec.get("createdDocIds", UNDEF), []) if dec else [],
                           "fiscalYear": row.get("FiscalYearRef", UNDEF), "counterparty": cp,
                           "description": self.normalizeFa(row.get("Description")), "_other": other, "rows": []}
                    byId[rid] = doc
                    order.append(doc)
                code = self._trim(js_or(row.get("ItemCode"), ""))
                sdept = js_or(self.materialClassification.get(code, UNDEF), None)
                qty = parse_float(row.get("Quantity", UNDEF))
                qty = qty if truthy(qty) else 0
                warnings = []
                if code not in known:
                    warnings.append("کالا در فهرست کالاهای سیستم نیست")
                if doc["kind"] in ("transfer_to_assembly", "return_from_assembly") and not truthy(sdept):
                    warnings.append("بخش مشخص نیست (طبقه‌بندی نشده)")
                rawinv = self.inventory.get("raw")
                rawStock = js_or(rawinv.get(code, UNDEF) if truthy(rawinv) else rawinv, 0)
                if doc["family"] == "issue" and rawStock < qty:
                    warnings.append("موجودی انبار مواد اولیه در سیستم کافی نیست (" + to_str(rawStock) + ")")
                doc["rows"].append({"index": len(doc["rows"]), "code": code, "name": self.normalizeFa(row.get("ItemTitle")),
                                    "unit": self.normalizeFa(row.get("UnitTitle")), "qty": qty, "suggestedDept": sdept,
                                    "rawStock": rawStock, "warnings": warnings})
            for d in order:
                d["snapshot"] = {"date": iso(self._date_ms(d["date"])), "other": d["_other"],
                                 "rows": [{"code": r["code"], "qty": r["qty"]} for r in d["rows"]]}
                del d["_other"]
            return order
        return build("issue", rowsIssue) + build("receipt", rowsReceipt)

    @staticmethod
    def _date_ms(v):
        """new Date(v).getTime()"""
        if is_number(v):
            return v
        return date_parse(v)

    @staticmethod
    def _jsplus(a, b):
        """a + b در JS وقتی b رشته است."""
        return to_str(a) + to_str(b)

    @route("GET", "/api/sepidar/inbox", 3698, catch=True)
    def r_inbox(self, req):
        self.checkSepidarDeletedDocs()
        self.loadData()
        days = min(max(js_or(parse_int(req.query.get("days", UNDEF)), 30), 1), 365)
        from datetime import datetime as _dt, timezone as _tz
        fms = self.now() - days * 86400000
        fms = fms - (fms % 86400000)
        frm = iso(fms)
        out = self.fetchSepidarInboxDocs(frm=frm)
        import functools

        def cmp(a, b):
            d = self._date_ms(b["date"]) - self._date_ms(a["date"])
            if d and not (isinstance(d, float) and math.isnan(d)):
                return -1 if d < 0 else 1
            return 1 if a["key"] < b["key"] else -1
        out.sort(key=functools.cmp_to_key(cmp))
        summary, sc = {}, {}
        for d in out:
            summary[d["kind"]] = js_or(summary.get(d["kind"]), 0) + 1
            st = to_str(d["status"])
            sc[st] = js_or(sc.get(st), 0) + 1
        return J({"success": True, "days": days, "total": len(out), "startDate": self.sepidarInbox.get("startDate", UNDEF),
                  "summary": summary, "statusCounts": sc, "kindLabels": dict(INBOX_KIND_LABELS), "docs": out})

    def getActiveInboxDecision(self, key):
        dec = self.sepidarInbox["decisions"].get(to_str(key), UNDEF)
        if not truthy(dec):
            return None
        if dec.get("status") != "approved":
            return dec
        ids = js_or(dec.get("createdDocIds", UNDEF), [])
        for id_ in ids:
            d = self._find_doc(id_)
            if d and d.get("status") not in ("cancelled", "rejected"):
                return dec
        return None

    @staticmethod
    def snapshotSig(sn):
        rows = sorted(to_str(r.get("code", UNDEF)) + ":" + to_str(r.get("qty", UNDEF)) for r in js_or(sn.get("rows", UNDEF), []))
        return stringify({"d": sn.get("date", UNDEF), "o": sn.get("other", UNDEF), "r": rows})

    @staticmethod
    def describeSnapshotChange(o_, n_):
        parts = []
        if not seq(o_.get("date", UNDEF), n_.get("date", UNDEF)):
            parts.append("تاریخ سند تغییر کرده")
        if not seq(o_.get("other", UNDEF), n_.get("other", UNDEF)):
            parts.append("انبار مبدأ/مقصد سند تغییر کرده")

        def sm(sn):
            m = {}
            for r in js_or(sn.get("rows", UNDEF), []):
                k = to_str(r.get("code", UNDEF))
                m[k] = add(js_or(m.get(k), 0), r.get("qty", UNDEF))
            return m
        o, n = sm(o_), sm(n_)
        allk = []
        for k in js_keys(o) + js_keys(n):
            if k not in allk:
                allk.append(k)
        for code in allk:
            if code not in n:
                parts.append("ردیف کالای " + code + " حذف شده (قبلاً " + to_str(o[code]) + ")")
            elif code not in o:
                parts.append("ردیف کالای " + code + " اضافه شده (" + to_str(n[code]) + ")")
            elif abs(sub(o[code], n[code])) > 1e-9:
                parts.append("مقدار کالای " + code + " از " + to_str(o[code]) + " به " + to_str(n[code]) + " تغییر کرده")
        return "؛ ".join(parts)[:400] or "سند تغییر کرده"

    def checkSepidarDeletedDocs(self):
        if self.sepidarDeletedCheckRunning:
            return {"checked": 0, "newlyDeleted": [], "newlyChanged": []}
        self.sepidarDeletedCheckRunning = True
        try:
            self.loadData()
            since = self.now() - 60 * 86400000
            decs = self.sepidarInbox["decisions"]
            keys = [k for k in js_keys(decs) if decs[k].get("status") == "approved" and re.match(r"^[DR]\d+$", k, re.ASCII)
                    and date_parse(decs[k].get("decidedAt", UNDEF)) >= since and self.getActiveInboxDecision(k)]
            if not keys:
                return {"checked": 0, "newlyDeleted": [], "newlyChanged": []}
            current = {d["key"]: d for d in self.fetchSepidarInboxDocs(onlyKeys=keys)}
            self.loadData()
            nd, nc = [], []
            changed = False
            for k in keys:
                dec = self.sepidarInbox["decisions"].get(k)
                if not truthy(dec) or dec.get("status") != "approved":
                    continue
                cur = current.get(k)
                if not cur:
                    if not truthy(dec.get("sepidarDeletedAt")):
                        dec["sepidarDeletedAt"] = self.now_iso()
                        dec.pop("alertDismissed", None)
                        nd.append({"key": k, "number": dec.get("number", UNDEF), "kindLabel": dec.get("kindLabel", UNDEF),
                                   "createdDocIds": js_or(dec.get("createdDocIds", UNDEF), [])})
                        changed = True
                    continue
                if truthy(dec.get("sepidarDeletedAt")):
                    dec.pop("sepidarDeletedAt", None)
                    dec.pop("alertDismissed", None)
                    changed = True
                if not truthy(dec.get("snapshot")):
                    dec["snapshot"] = cur["snapshot"]
                    changed = True
                    continue
                curSig = self.snapshotSig(cur["snapshot"])
                if curSig == self.snapshotSig(dec["snapshot"]):
                    if truthy(dec.get("sepidarChange")):
                        for x in ("sepidarChange", "sepidarChangedAt", "lastChangeSig", "alertDismissed"):
                            dec.pop(x, None)
                        changed = True
                elif not seq(dec.get("lastChangeSig", UNDEF), curSig):
                    dec["sepidarChange"] = self.describeSnapshotChange(dec["snapshot"], cur["snapshot"])
                    dec["sepidarChangedAt"] = self.now_iso()
                    dec["lastChangeSig"] = curSig
                    dec.pop("alertDismissed", None)
                    nc.append({"key": k, "number": dec.get("number", UNDEF), "kindLabel": dec.get("kindLabel", UNDEF),
                               "createdDocIds": js_or(dec.get("createdDocIds", UNDEF), []), "change": dec["sepidarChange"]})
                    changed = True
            if changed:
                self.saveData()
            for d in nd:
                self.logActivity("سیستم", "حذف سند سپیدار شناسایی شد",
                                 to_str(js_or(d["kindLabel"], d["key"])) + " شماره " + to_str(js_or(d["number"], "?")) + " (" + d["key"] +
                                 ") در سپیدار حذف شده (یا از انبار مواد اولیه خارج شده) ولی اسناد سیستم تولید (" +
                                 ", ".join(to_str(x) for x in d["createdDocIds"]) + ") هنوز هستند")
                self.sendPushToUsernames(self.usersWithRoles(["warehouse", "admin"]), {
                    "title": "⚠️ سند سپیدار حذف شده است",
                    "body": "سند " + to_str(js_or(d["kindLabel"], "")) + " شماره " + to_str(js_or(d["number"], d["key"])) +
                            " در سپیدار حذف شده؛ اسناد ثبت‌شده‌ی آن در سیستم تولید را بررسی کنید", "url": "/"})
            for d in nc:
                self.logActivity("سیستم", "ویرایش سند سپیدار شناسایی شد",
                                 to_str(js_or(d["kindLabel"], d["key"])) + " شماره " + to_str(js_or(d["number"], "?")) + " (" + d["key"] +
                                 "): " + to_str(d["change"]) + " - اسناد سیستم تولید: " + ", ".join(to_str(x) for x in d["createdDocIds"]))
                self.sendPushToUsernames(self.usersWithRoles(["warehouse", "admin"]), {
                    "title": "⚠️ سند سپیدار ویرایش شده است",
                    "body": "سند " + to_str(js_or(d["kindLabel"], "")) + " شماره " + to_str(js_or(d["number"], d["key"])) +
                            " بعد از ثبت در سپیدار ویرایش شده: " + to_str(d["change"]), "url": "/"})
            return {"checked": len(keys), "newlyDeleted": nd, "newlyChanged": nc}
        except Exception as e:
            self.log("Error checking deleted/changed sepidar docs:", js_err_message(e))
            return {"checked": 0, "newlyDeleted": [], "newlyChanged": [], "error": js_err_message(e)}
        finally:
            self.sepidarDeletedCheckRunning = False

    def inboxActor(self, username, roles):
        a = self._find_user(username)
        return a if a and a.get("role", UNDEF) in roles else None

    @route("POST", "/api/sepidar/inbox/dismiss-alert", 3848, catch=True)
    def r_inbox_dismiss(self, req):
        self.loadData()
        key, actor = g(req.body, "key"), g(req.body, "actorUsername")
        if not self.inboxActor(actor, ["warehouse", "admin"]):
            return ERR(403, "فقط انباردار یا مدیر")
        dec = self.sepidarInbox["decisions"].get(to_str(key), UNDEF)
        if not truthy(dec) or (not truthy(dec.get("sepidarDeletedAt")) and not truthy(dec.get("sepidarChange"))):
            return ERR(400, "هشداری برای این سند نیست")
        dec["alertDismissed"] = True
        self.saveData()
        self.logActivity(actor, "بستن هشدار حذف سند سپیدار", key)
        return J({"success": True})

    @route("POST", "/api/sepidar/inbox/start-date", 3873, catch=True)
    def r_inbox_start(self, req):
        self.loadData()
        sd, actor = g(req.body, "startDate"), g(req.body, "actorUsername")
        if not self.inboxActor(actor, ["admin"]):
            return ERR(403, "فقط مدیر می‌تواند تاریخ شروع را تعیین کند")
        ms = date_parse(sd) if isinstance(sd, str) else (sd if is_number(sd) else NaN)
        if is_nan(ms):
            return ERR(400, "تاریخ نامعتبر است")
        ms = ms - (ms % 86400000)
        self.sepidarInbox["startDate"] = iso(ms)
        self.saveData()
        self.logActivity(actor, "تعیین تاریخ شروع اسناد سپیدار", self.sepidarInbox["startDate"][:10])
        return J({"success": True, "startDate": self.sepidarInbox["startDate"]})

    @staticmethod
    def _jget(o, k):
        if isinstance(o, list):
            return o[k] if isinstance(k, int) and 0 <= k < len(o) else UNDEF
        if isinstance(o, dict):
            return o.get(to_str(k), UNDEF)
        return UNDEF

    @route("POST", "/api/sepidar/inbox/approve", 3900, catch=True)
    def r_inbox_approve(self, req):
        b = req.body
        key, actorUsername, rowDepts = g(b, "key"), g(b, "actorUsername"), g(b, "rowDepts")
        self.loadData()
        actor = self.inboxActor(actorUsername, ["warehouse", "admin"])
        if not actor:
            return ERR(403, "فقط انباردار یا مدیر می‌تواند این سند را تایید کند")
        if not truthy(key) or self.getActiveInboxDecision(key):
            return ERR(400, "این سند قبلاً بررسی شده است")
        if not truthy(self.sepidarInbox.get("startDate")):
            return ERR(400, "ابتدا مدیر باید «تاریخ شروع» را تعیین کند")
        lst = self.fetchSepidarInboxDocs(onlyKey=key)
        found = lst[0] if lst else None
        if not found:
            return ERR(404, "سند در سپیدار پیدا نشد")
        self.loadData()
        if self.getActiveInboxDecision(key):
            return ERR(400, "این سند همین الان توسط فرد دیگری بررسی شد")
        if not found["approvable"]:
            return ERR(400, "سند «" + to_str(found["kindLabel"]) + "» قابل ثبت نیست؛ فقط می‌توانید نادیده‌اش بگیرید")
        if self._date_ms(found["date"]) < date_parse(self.sepidarInbox["startDate"]):
            return ERR(400, "این سند قبل از تاریخ شروع است و فقط قابل نادیده گرفتن است")
        isTransfer = found["kind"] in ("transfer_to_assembly", "return_from_assembly")
        validDepts = [d["id"] for d in DEPTS if d["id"] != "raw"]
        errors = []
        plan = []
        for r in found["rows"]:
            dept = None
            if isTransfer:
                dept = js_or(self._jget(rowDepts, r["index"]) if truthy(rowDepts) else rowDepts, r["suggestedDept"])
            if not any(i.get("code") == r["code"] for i in self.items):
                errors.append("کالای " + r["code"] + " در فهرست کالاها نیست (ابتدا همگام‌سازی کالاها)")
            if not (r["qty"] > 0):
                errors.append("مقدار ردیف " + str(r["index"] + 1) + " نامعتبر است")
            if isTransfer and dept not in validDepts:
                errors.append("برای ردیف " + str(r["index"] + 1) + " (" + r["code"] + ") بخش انتخاب نشده است")
            plan.append((r, dept))
        need = {}
        for row, dept in plan:
            unit = None
            if found["family"] == "issue":
                unit = "raw"
            if found["kind"] == "return_from_assembly":
                unit = dept
            if truthy(unit):
                k = to_str(unit) + "|" + row["code"]
                need[k] = add(js_or(need.get(k), 0), row["qty"])
        for k, q in js_items(need):
            unit, code = k.split("|")[0], k.split("|")[1]
            inv = self.inventory.get(unit)
            have = js_or(inv.get(code, UNDEF) if truthy(inv) else inv, 0)
            if lt(add(have, QTY_EPS), q):
                errors.append("موجودی " + to_str(self.deptName(unit)) + " برای " + code + " کافی نیست (موجود: " + to_str(have) +
                              "، لازم: " + to_str(q) + "). اگر موجودی سیستم با سپیدار نمی‌خواند، ابتدا با «بررسی انبار» اختلاف را اصلاح کنید")
        if errors:
            return ERR(400, "\n".join(errors))
        today = self.today_fa()
        noteBase = ("سپیدار - " + to_str(found["kindLabel"]) + " شماره " + to_str(found["number"]) +
                    ((" - " + found["counterparty"]) if truthy(found["counterparty"]) else ""))
        created, createdOut = [], []
        for row, dept in plan:
            sub = "sepidar-" + to_str(key) + "-" + str(row["index"])
            if isTransfer:
                frm = dept if found["kind"] == "return_from_assembly" else "raw"
                to = "raw" if found["kind"] == "return_from_assembly" else dept
                doc = {"id": self.docSeq, "date": today, "type": "output", "unit": frm, "item": row["code"], "qty": row["qty"],
                       "fromUnit": frm, "toUnit": to, "note": noteBase, "status": "pending", "fiscalYear": self.activeFiscalYear,
                       "createdBy": actorUsername, "createdAt": self.now_iso(), "submissionId": sub, "transactionId": None,
                       "parentDocId": None}
                self.docSeq += 1
                doc["batchNumber"] = self.generateBatchNumber()
                doc.update({"orderBatchId": None, "source": "sepidar", "sepidarKey": key})
                if self.isDeptPairGated(frm, to):
                    doc["warehouseApprovedBy"] = actorUsername
                    doc["warehouseApprovedAt"] = self.now_iso()
                self.docs.append(doc)
                created.append(doc["id"])
                createdOut.append(doc)
                continue
            isIn = found["family"] == "receipt"
            txType = "receipt" if isIn else ("consume" if found["kind"] == "direct_consumption" else "shortage")
            inv = self._inv("raw")
            if not truthy(inv.get(row["code"])):
                inv[row["code"]] = 0
            inv[row["code"]] = add(inv[row["code"]], (row["qty"] if isIn else -row["qty"]))
            bn = self.generateBatchNumber()
            tx = {"id": self.seqId, "date": today, "type": txType, "unit": "raw", "item": row["code"], "qty": row["qty"],
                  "note": noteBase, "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": bn}
            self.seqId += 1
            self.transactions.append(tx)
            doc = {"id": self.docSeq, "date": today, "type": txType, "unit": "raw", "item": row["code"], "qty": row["qty"],
                   "fromUnit": "", "toUnit": "", "note": noteBase, "status": "approved", "fiscalYear": self.activeFiscalYear,
                   "createdBy": actorUsername, "transactionId": tx["id"], "parentDocId": None, "batchNumber": bn,
                   "submissionId": sub, "source": "sepidar", "sepidarKey": key, "approvedBy": actorUsername,
                   "approvedAt": self.now_iso()}
            self.docSeq += 1
            self.docs.append(doc)
            created.append(doc["id"])
        if isTransfer and truthy(g(b, "saveDefaults")):
            for row, dept in plan:
                if not truthy(self.materialClassification.get(row["code"], UNDEF)) and dept in STAGE_DEPTS:
                    self.materialClassification[row["code"]] = dept
        prev = self.sepidarInbox["decisions"].get(to_str(key), UNDEF)
        hist = []
        if truthy(prev):
            hist = list(js_or(prev.get("history", UNDEF), [])) + [{
                "status": prev.get("status", UNDEF), "decidedBy": prev.get("decidedBy", UNDEF), "decidedAt": prev.get("decidedAt", UNDEF),
                "createdDocIds": js_or(prev.get("createdDocIds", UNDEF), [])}]
        self.sepidarInbox["decisions"][to_str(key)] = {
            "status": "approved", "decidedBy": actorUsername, "decidedAt": self.now_iso(), "createdDocIds": created,
            "number": found["number"], "kindLabel": found["kindLabel"], "snapshot": found["snapshot"], "history": hist}
        self.saveData()
        self.logActivity(actorUsername, "تایید سند سپیدار", to_str(found["kindLabel"]) + " شماره " + to_str(found["number"]) + " (" +
                         to_str(key) + ") - اسناد ساخته‌شده: " + ", ".join(to_str(x) for x in created))
        resp = J({"success": True, "createdDocIds": created,
                  "message": "سند سپیدار " + to_str(found["number"]) + " ثبت شد (" + str(len(created)) + " سند)"})
        for d in createdOut:
            self.notifyOutputMessengerForOutputDoc(d)
        byT = {}
        for d in createdOut:
            byT.setdefault(to_str(d["toUnit"]), []).append(d)
        for toUnit, lst2 in js_items(byT):
            self.sendPushToUsernames(self.usersInDeptId(toUnit), {
                "title": "📤 سند خروج آماده تایید",
                "body": str(len(lst2)) + " قلم از " + to_str(self.deptName(lst2[0]["fromUnit"])) + " (ثبت از سپیدار)", "url": "/mobile/"})
        return resp

    @route("POST", "/api/sepidar/inbox/reject", 4077, catch=True)
    def r_inbox_reject(self, req):
        self.loadData()
        key, actor, reason = g(req.body, "key"), g(req.body, "actorUsername"), g(req.body, "reason")
        if not self.inboxActor(actor, ["warehouse", "admin"]):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند این سند را نادیده بگیرد")
        if not truthy(key) or self.getActiveInboxDecision(key):
            return ERR(400, "این سند قبلاً بررسی شده است")
        self.sepidarInbox["decisions"][to_str(key)] = {"status": "rejected", "decidedBy": actor, "decidedAt": self.now_iso(),
                                                       "reason": js_or(reason, ""), "createdDocIds": []}
        self.saveData()
        self.logActivity(actor, "نادیده گرفتن سند سپیدار", to_str(key) + ((" - " + to_str(reason)) if truthy(reason) else ""))
        return J({"success": True})

    @route("POST", "/api/sepidar/inbox/restore", 4096, catch=True)
    def r_inbox_restore(self, req):
        self.loadData()
        key, actor = g(req.body, "key"), g(req.body, "actorUsername")
        if not self.inboxActor(actor, ["warehouse", "admin"]):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند سند را بازگرداند")
        dec = self.sepidarInbox["decisions"].get(to_str(key), UNDEF)
        if not truthy(dec) or dec.get("status") != "rejected":
            return ERR(400, "فقط سندهای نادیده‌گرفته‌شده قابل بازگردانی‌اند")
        del self.sepidarInbox["decisions"][to_str(key)]
        self.saveData()
        self.logActivity(actor, "بازگردانی سند سپیدار", key)
        return J({"success": True})

    def resolveSepidarFiscalYear(self, explicitYear=UNDEF):
        if truthy(explicitYear):
            return {"ref": explicitYear, "source": "explicit"}
        mp = js_or(g(self.appSettings, "sepidarFiscalYears") if truthy(self.appSettings) else UNDEF, {})
        manual = parse_int(g(mp, to_str(self.activeFiscalYear)))
        if truthy(manual):
            return {"ref": manual, "source": "manual"}
        try:
            pool = self.connectToSepidar()
            if pool:
                refs = ",".join(str(w["stockRef"]) for w in RECONCILE_STOCKS)
                rs = self.sql(pool, "SELECT MAX(FiscalYearRef) AS fy FROM INV.vwItemStockSummary WHERE Quantity <> 0 AND StockRef IN (" + refs + ")")
                fy = rs[0].get("fy") if rs else None
                if truthy(fy):
                    return {"ref": fy, "source": "auto"}
        except Exception as e:
            self.log("resolveSepidarFiscalYear:", js_err_message(e))
        return {"ref": 13, "source": "fallback"}

    @route("GET", "/api/settings/sepidar-fiscal-year", 4144, catch=True)
    def r_get_sfy(self, req):
        self.loadData()
        resolved = self.resolveSepidarFiscalYear()
        mp = js_or(self.appSettings.get("sepidarFiscalYears", UNDEF), {})
        options = []
        err = None
        try:
            pool = self.connectToSepidar()
            if not pool:
                raise Exception("اتصال به سپیدار برقرار نشد")
            refs = ",".join(str(w["stockRef"]) for w in RECONCILE_STOCKS)
            rs = self.sql(pool, "\n        SELECT FiscalYearRef AS ref, COUNT(*) AS rows_, SUM(CASE WHEN Quantity <> 0 THEN 1 ELSE 0 END) AS nonzero\n"
                                "        FROM INV.vwItemStockSummary WHERE StockRef IN (" + refs + ")\n"
                                "        GROUP BY FiscalYearRef ORDER BY FiscalYearRef DESC\n      ")
            options = [{"ref": x.get("ref", UNDEF), "rows": x.get("rows_", UNDEF), "nonzero": x.get("nonzero", UNDEF)} for x in rs[:8]]
        except Exception as e:
            err = js_err_message(e)
        return J({"success": True, "activeLocalYear": self.activeFiscalYear,
                  "manualRef": js_or(g(mp, to_str(self.activeFiscalYear)), None), "map": mp, "resolved": resolved,
                  "options": options, "sepidarError": err})

    @route("POST", "/api/settings/sepidar-fiscal-year", 4178, catch=True)
    def r_set_sfy(self, req):
        self.loadData()
        ref, actor = g(req.body, "ref"), g(req.body, "actorUsername")
        if not self.inboxActor(actor, ["admin"]):
            return ERR(403, "فقط مدیر می‌تواند سال مالی سپیدار را تعیین کند")
        if not truthy(self.appSettings.get("sepidarFiscalYears")):
            self.appSettings["sepidarFiscalYears"] = {}
        n = parse_int(ref)
        ay = to_str(self.activeFiscalYear)
        if ref == "" or ref is None or ref is UNDEF:
            self.appSettings["sepidarFiscalYears"].pop(ay, None)
        elif is_number(n) and not is_nan(n) and 0 < n < 1000:
            self.appSettings["sepidarFiscalYears"][ay] = n
        else:
            return ERR(400, "شماره‌ی سال مالی سپیدار نامعتبر است")
        self.saveData()
        self.logActivity(actor, "تعیین سال مالی سپیدار", "سال برنامه " + ay + " ← FiscalYearRef " +
                         ("خودکار" if (ref == "" or ref is None or ref is UNDEF) else to_str(n)))
        return J({"success": True})

    @route("POST", "/api/doc/production-with-materials", 4207, catch=True)
    def r_prod_with_mats(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        bad = self.validateMovement(req.body, ["unit"])
        if bad:
            return ERR(400, bad)
        b = req.body
        unit, item, qty = b.get("unit"), b.get("item"), b.get("qty")
        note, obid, actorUsername = g(b, "note"), g(b, "orderBatchId"), g(b, "actorUsername")
        mats = b.get("materials") if isinstance(b.get("materials"), list) else []
        if not mats:
            return ERR(400, "حداقل یک ماده‌ی مصرفی لازم است")
        clean = []
        for m in mats:
            mm = {"unit": unit, "item": g(m, "item") if truthy(m) else m, "qty": g(m, "qty") if truthy(m) else m}
            e = self.validateMovement(mm, ["unit"])
            if e:
                return ERR(400, "ماده «" + to_str(g(m, "item") if truthy(m) else m) + "»: " + e)
            clean.append({"item": mm["item"], "qty": mm["qty"], "note": js_or(g(m, "note"), "")})
        need = {}
        for m in clean:
            need[m["item"]] = add(js_or(need.get(m["item"]), 0), m["qty"])
        errors = []
        for code, q in js_items(need):
            inv = self.inventory.get(unit)
            have = js_or(inv.get(code, UNDEF) if truthy(inv) else inv, 0)
            if lt(add(have, QTY_EPS), q):
                errors.append("موجودی «" + to_str(self.resolveItemName(code)) + "» کافی نیست (موجود: " + to_str(have) + "، لازم: " + to_str(q) + ")")
        if errors:
            return ERR(400, "\n".join(errors))
        gated = self.isProductionGated(unit)
        batch = self.generateBatchNumber()
        today = docDt
        actor = js_or(actorUsername, "سیستم")
        ptx = None
        if not gated:
            ptx = {"id": self.seqId, "date": today, "type": "production", "unit": unit, "item": item, "qty": qty,
                   "note": js_or(note, ""), "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
            self.seqId += 1
            self.transactions.append(ptx)
            inv = self._inv(unit)
            inv[item] = add(js_or(inv.get(item, UNDEF), 0), qty)
        doc = {"id": self.docSeq, "date": today, "type": "production", "unit": unit, "item": item, "qty": qty, "fromUnit": "",
               "toUnit": "", "note": js_or(note, ""), "status": "pending_production" if gated else "approved",
               "fiscalYear": self.activeFiscalYear, "createdBy": actor, "transactionId": ptx["id"] if ptx else None,
               "parentDocId": None, "batchNumber": batch, "orderBatchId": js_or(obid, None)}
        self.docSeq += 1
        self.docs.append(doc)
        children = []
        for m in clean:
            ctx = None
            dnote = js_or(m["note"], "مصرف در تولید " + to_str(self.resolveItemName(item)) + " (سند تولید " + to_str(doc["id"]) + ")")
            if not gated:
                ctx = {"id": self.seqId, "date": today, "type": "consume", "unit": unit, "item": m["item"], "qty": m["qty"],
                       "note": dnote, "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": batch}
                self.seqId += 1
                self.transactions.append(ctx)
                self.inventory[unit][m["item"]] = sub(self.inventory[unit].get(m["item"], UNDEF), m["qty"])
            c = {"id": self.docSeq, "date": today, "type": "consume", "unit": unit, "item": m["item"], "qty": m["qty"],
                 "fromUnit": "", "toUnit": "", "note": dnote, "status": "pending_production" if gated else "approved",
                 "fiscalYear": self.activeFiscalYear, "createdBy": actor, "transactionId": ctx["id"] if ctx else None,
                 "parentDocId": doc["id"], "batchNumber": batch, "orderBatchId": js_or(obid, None)}
            self.docSeq += 1
            self.docs.append(c)
            children.append(c)
        self.saveData()
        resp = J({"success": True, "doc": doc, "children": children, "batchNumber": batch, "pendingWarehouse": gated,
                  "message": ("سند تولید " + to_str(doc["id"]) + " ثبت شد و در انتظار تایید انباردار است (بعد از تایید به موجودی اضافه و مصرف مواد ثبت می‌شود)")
                  if gated else ("سند تولید " + to_str(doc["id"]) + " با " + str(len(children)) + " سند مصرف ثبت شد")})
        if gated:
            self.sendPushToUsernames(self.usersWithRoles(["warehouse", "admin"]), {
                "title": "🏭 تولید در انتظار تایید انباردار",
                "body": to_str(self.resolveItemName(item)) + " (" + self.formatNumber(qty) + ") - بخش " + to_str(self.deptName(unit)),
                "url": "/"})
        return resp

    @route("POST", "/api/doc/initial", 4292, catch=True)
    def r_doc_initial(self, req):
        self.loadData()
        docDt, err = self.resolveDocDate(req)
        if err:
            return err
        actor = self._find_user(g(req.body, "actorUsername"))
        rp = js_or(self.appSettings.get("rolePermissions", UNDEF), {})
        allowed = actor and (actor.get("role") == "admin" or "sec-initial-inv" in js_or(g(rp, to_str(actor.get("role", UNDEF))), []))
        if not allowed:
            return ERR(403, "دسترسی ثبت موجودی اول دوره را ندارید")
        bad = self.validateMovement(req.body, ["unit"])
        if bad:
            return ERR(400, bad)
        unit, item, qty = req.body["unit"], req.body["item"], req.body["qty"]
        row = {"unit": unit, "item": item, "qty": qty, "date": docDt, "fiscalYear": self.activeFiscalYear}
        self.initialInventory.append(row)
        inv = self._inv(unit)
        inv[item] = add(js_or(inv.get(item, UNDEF), 0), qty)
        doc = self.ensureInitialDoc(row, actor=actor.get("username", UNDEF), source="manual")
        self.saveData()
        self.logActivity(actor.get("username", UNDEF), "ثبت موجودی اول دوره", "کالا: " + to_str(self.resolveItemName(item)) + " (" + item +
                         "), تعداد: " + to_str(qty) + ", بخش: " + to_str(self.deptName(unit)))
        return J({"success": True, "doc": doc, "message": "موجودی اولیه " + to_str(qty) + " " + to_str(self.resolveItemName(item)) +
                  " برای " + to_str(self.deptName(unit)) + " ثبت شد"})

    @route("POST", "/api/items/add", 4319, catch=True)
    def r_items_add(self, req):
        self.loadData()
        b = req.body
        if not self.inboxActor(g(b, "actorUsername"), ["admin"]):
            return ERR(403, "فقط مدیر می‌تواند کالا اضافه کند")
        code = self._trim(to_str(js_or(g(b, "code"), "")))
        name = self.normalizeFa(g(b, "name"))
        if not code or not name:
            return ERR(400, "کد و عنوان کالا الزامی است")
        if any(i.get("code") == code for i in self.items):
            return ERR(400, "کد " + code + " قبلاً ثبت شده است")
        if any(i.get("name") == name for i in self.items):
            return ERR(400, "کالا با عنوان «" + name + "» قبلاً ثبت شده است")
        item = {"code": code, "name": name, "groupName": to_str(js_or(g(b, "groupName"), "")),
                "unit": to_str(js_or(g(b, "unit"), "عدد")), "created": self.now_iso()}
        self.items.append(item)
        for d in DEPTS:
            inv = self._inv(d["id"])
            if code not in inv:
                inv[code] = 0
        self.saveData()
        self.logActivity(g(b, "actorUsername"), "افزودن کالا", name + " (" + code + ")")
        return J({"success": True, "item": item})

    @route("POST", "/api/items/delete", 4339, catch=True)
    def r_items_delete(self, req):
        self.loadData()
        b = req.body
        if not self.inboxActor(g(b, "actorUsername"), ["admin"]):
            return ERR(403, "فقط مدیر می‌تواند کالا حذف کند")
        code = to_str(js_or(g(b, "code"), ""))
        idx = next((i for i, it in enumerate(self.items) if it.get("code") == code), -1)
        if idx == -1:
            return ERR(404, "کالا یافت نشد")
        used = (any(code in dep and not seq(dep[code], 0) for dep in js_values(self.inventory))
                or any(t.get("item") == code for t in self.transactions) or any(d.get("item") == code for d in self.docs)
                or any(t.get("item") == code for t in self.initialInventory))
        if used:
            return ERR(400, "کالای «" + to_str(self.items[idx].get("name", UNDEF)) + "» در سیستم استفاده شده است، قابل حذف نیست")
        removed = self.items.pop(idx)
        for dep in js_values(self.inventory):
            if code in dep and seq(dep[code], 0):
                del dep[code]
        self.saveData()
        self.logActivity(g(b, "actorUsername"), "حذف کالا", to_str(removed.get("name", UNDEF)) + " (" + code + ")")
        return J({"success": True})

    @route("POST", "/api/fiscal-years", 4362, catch=True)
    def r_fiscal_years(self, req):
        self.loadData()
        b = req.body
        action, year, title, sd, ed, actor = (g(b, "action"), g(b, "year"), g(b, "title"), g(b, "startDate"),
                                              g(b, "endDate"), g(b, "actorUsername"))
        if not self.inboxActor(actor, ["admin"]):
            return ERR(403, "فقط مدیر می‌تواند سال مالی را مدیریت کند")
        y = self._trim(to_str(js_or(year, "")))
        if not re.match(r"^\d{4}$", y, re.ASCII):
            return ERR(400, "سال مالی نامعتبر است (مثلاً 1406)")
        if action == "create":
            if any(f.get("year") == y for f in self.fiscalYears):
                return ERR(400, "این سال مالی قبلاً ایجاد شده است")

            def dateOk(s):
                return isinstance(s, str) and re.match(r"^\d{4}/\d{2}/\d{2}$", s, re.ASCII) is not None
            for f in self.fiscalYears:
                if f.get("status") == "active":
                    f["status"] = "closed"
            self.fiscalYears.append({"year": y, "title": to_str(js_or(title, "سال مالی " + y)), "status": "active",
                                     "startDate": sd if dateOk(sd) else y + "/01/01", "endDate": ed if dateOk(ed) else y + "/12/29"})
            self.activeFiscalYear = y
        elif action == "close":
            fy = next((f for f in self.fiscalYears if f.get("year") == y), None)
            if not fy:
                return ERR(404, "سال مالی یافت نشد")
            fy["status"] = "closed"
        elif action == "reopen":
            fy = next((f for f in self.fiscalYears if f.get("year") == y), None)
            if not fy:
                return ERR(404, "سال مالی یافت نشد")
            for f in self.fiscalYears:
                if f.get("status") == "active":
                    f["status"] = "closed"
            fy["status"] = "active"
            self.activeFiscalYear = y
        else:
            return ERR(400, "عملیات نامعتبر است")
        self.saveData()
        self.logActivity(actor, {"create": "ایجاد سال مالی", "close": "بستن سال مالی", "reopen": "بازگشایی سال مالی"}[action], y)
        return J({"success": True, "fiscalYears": self.fiscalYears, "activeFiscalYear": self.activeFiscalYear})

    def computeIntegrity(self):
        plus = ["production", "excess", "receipt", "input"]
        minus = ["consume", "output", "waste", "shortage"]

        def key(u, i):
            return to_str(u) + "|" + to_str(i)
        bal = {}
        for t in self.initialInventory:
            k = key(t.get("unit", UNDEF), t.get("item", UNDEF))
            bal[k] = add(js_or(bal.get(k), 0), t.get("qty", UNDEF))
        for t in self.transactions:
            k = key(t.get("unit", UNDEF), t.get("item", UNDEF))
            if t.get("type") in plus:
                bal[k] = add(js_or(bal.get(k), 0), t.get("qty", UNDEF))
            elif t.get("type") in minus:
                bal[k] = sub(js_or(bal.get(k), 0), t.get("qty", UNDEF))
        keys = []
        seen = set()
        for k in js_keys(bal) + [key(u, i) for u, m in js_items(self.inventory) for i in js_keys(m)]:
            if k not in seen:
                seen.add(k)
                keys.append(k)

        def r3(v):
            return num(js_round(mul(v, 1000)) / 1000)
        mism = []
        for k in keys:
            parts = k.split("|")
            u, i = parts[0], parts[1] if len(parts) > 1 else UNDEF
            inv = self.inventory.get(u)
            stored = js_or(inv.get(to_str(i), UNDEF) if truthy(inv) else inv, 0)
            calc = js_or(bal.get(k), 0)
            diff = r3(sub(stored, calc))
            if abs(diff) > 0.001:
                mism.append({"unit": u, "unitName": self.deptName(u), "item": i, "name": self.resolveItemName(i), "stored": r3(stored),
                             "fromTransactions": r3(calc), "diff": diff})
        mism.sort(key=lambda m: -abs(m["diff"]))
        negatives, nonNumeric, unknown = [], [], []
        for u, m in js_items(self.inventory):
            for i, v in js_items(m):
                if not is_number(v) or not is_finite(v):
                    nonNumeric.append({"unit": u, "unitName": self.deptName(u), "item": i, "value": to_str(v)})
                elif lt(v, 0):
                    negatives.append({"unit": u, "unitName": self.deptName(u), "item": i, "name": self.resolveItemName(i), "value": v})
                if not seq(v, 0) and not self.knownItemCode(u, i):
                    unknown.append({"unit": u, "unitName": self.deptName(u), "item": i})
        txIds, dupTx = [], []
        txset = set()
        for t in self.transactions:
            tid = t.get("id", UNDEF)
            hk = self._hkey(tid)
            if hk in txset:
                dupTx.append(tid)
            txset.add(hk)
        docset, dupDocs = set(), []
        for d in self.docs:
            hk = self._hkey(d.get("id", UNDEF))
            if hk in docset:
                dupDocs.append(d.get("id", UNDEF))
            docset.add(hk)
        used = set()
        for d in self.docs:
            if truthy(d.get("transactionId")):
                used.add(self._hkey(d["transactionId"]))
            if truthy(d.get("transactionId2")):
                used.add(self._hkey(d["transactionId2"]))
        orphan = [{"id": t.get("id", UNDEF), "type": t.get("type", UNDEF), "item": t.get("item", UNDEF), "qty": t.get("qty", UNDEF)}
                  for t in self.transactions if self._hkey(t.get("id", UNDEF)) not in used]
        needsTx = ["production", "consume", "waste", "shortage", "excess", "receipt", "output"]
        dwt = [{"id": d.get("id", UNDEF), "type": d.get("type", UNDEF), "item": d.get("item", UNDEF), "qty": d.get("qty", UNDEF)}
               for d in self.docs if d.get("status") == "approved" and d.get("type") in needsTx and not truthy(d.get("transactionId"))]
        mtd = [{"id": d.get("id", UNDEF), "type": d.get("type", UNDEF), "status": d.get("status", UNDEF), "transactionId": d.get("transactionId", UNDEF)}
               for d in self.docs if truthy(d.get("transactionId")) and self._hkey(d["transactionId"]) not in txset]
        return {"pairsChecked": len(keys), "mismatches": mism, "negatives": negatives, "nonNumeric": nonNumeric, "unknownCodes": unknown,
                "duplicateDocIds": dupDocs, "duplicateTxIds": dupTx, "orphanTransactions": orphan, "docsWithoutTx": dwt,
                "missingTxDocs": mtd,
                "pendingDocs": len([d for d in self.docs if re.match(r"^pending|^return_pending", to_str(d.get("status", UNDEF)))])}

    @staticmethod
    def _hkey(v):
        """کلیدِ Set در JS (SameValueZero): عدد با عدد، رشته با رشته."""
        if is_number(v):
            return ("n", float(v))
        if v is UNDEF:
            return ("u",)
        if isinstance(v, (dict, list)):
            return ("o", id(v))
        return (type(v).__name__, v)

    @route("POST", "/api/integrity/align-stock", 4457, catch=True)
    def r_align(self, req):
        self.loadData()
        b = req.body
        unit, item, exp, reason, actor = g(b, "unit"), g(b, "item"), g(b, "expectedStored"), g(b, "reason"), g(b, "actorUsername")
        if not self.inboxActor(actor, ["admin"]):
            return ERR(403, "فقط مدیر")
        if not truthy(reason) or len(self._trim(to_str(reason))) < 5:
            return ERR(400, "دلیل اصلاح الزامی است")
        row = next((m for m in self.computeIntegrity()["mismatches"] if seq(m["unit"], unit) and seq(m["item"], item)), None)
        if not row:
            return ERR(400, "برای این ردیف اختلافی وجود ندارد")
        e = to_number(exp)
        if not (abs(sub(row["stored"], e)) <= 0.001):
            return ERR(409, "موجودیِ ذخیره‌شده تغییر کرده (الان " + to_str(row["stored"]) + ")؛ دوباره بررسی کنید")
        if not (row["fromTransactions"] >= 0):
            return ERR(400, "مجموعِ تراکنش‌ها منفی است؛ باید دستی بررسی شود")
        old = self.inventory[unit].get(item, UNDEF)
        self.inventory[unit][item] = row["fromTransactions"]
        self.saveData()
        self.logActivity(actor, "⚠️ هم‌ترازی موجودی با تراکنش‌ها", to_str(self.deptName(unit)) + " - " + to_str(self.resolveItemName(item)) +
                         " (" + to_str(item) + "): " + to_str(old) + " ← " + to_str(row["fromTransactions"]) + " (اختلاف " +
                         to_str(row["diff"]) + ") - دلیل: " + self._trim(to_str(reason)))
        return J({"success": True, "unit": unit, "item": item, "from": old, "to": row["fromTransactions"], "diff": row["diff"]})

    @route("GET", "/api/integrity", 4479, catch=True)
    def r_integrity(self, req):
        self.loadData()
        out = {"success": True, "checkedAt": self.now_iso()}
        out.update(self.computeIntegrity())
        return J(out)

    # ---------- انبارگردانی ----------
    @staticmethod
    def faDigits(s):
        return re.sub(r"[0-9]", lambda m: "۰۱۲۳۴۵۶۷۸۹"[int(m.group(0))], to_str(s))

    def todayJalaliParts(self):
        y, m, d = jalali_parts(self.now())
        return {"y": y, "m": m, "d": d}

    def canCountUnit(self, user, unit):
        if not user:
            return False
        if user.get("role") in ("admin", "warehouse"):
            return True
        d = next((x for x in DEPTS if x["id"] == unit), None)
        return bool(d) and user.get("unit", UNDEF) == d["name"]

    def stockCountSummary(self, c):
        lines = c.get("lines", [])
        counted = len([l for l in lines if l.get("countedQty", UNDEF) is not None and l.get("countedQty", UNDEF) is not UNDEF])
        return {"id": c.get("id", UNDEF), "unit": c.get("unit", UNDEF), "unitName": self.deptName(c.get("unit", UNDEF)),
                "dateFa": c.get("dateFa", UNDEF), "dateJalali": c.get("dateJalali", UNDEF), "status": c.get("status", UNDEF),
                "note": js_or(c.get("note", UNDEF), ""), "createdBy": c.get("createdBy", UNDEF), "createdAt": c.get("createdAt", UNDEF),
                "finalizedBy": js_or(c.get("finalizedBy", UNDEF), None), "finalizedAt": js_or(c.get("finalizedAt", UNDEF), None),
                "lineCount": len(lines), "countedCount": counted, "result": js_or(c.get("result", UNDEF), None),
                "adjustmentDocIds": js_or(c.get("adjustmentDocIds", UNDEF), [])}

    def _find_count(self, idstr):
        n = parse_int(idstr)
        return next((x for x in self.stockCounts if seq(x.get("id", UNDEF), n)), None)

    @route("GET", "/api/stock-counts", 4519)
    def r_counts(self, req):
        self.loadData()
        unit = req.query.get("unit", UNDEF)
        lst = [c for c in self.stockCounts if not truthy(unit) or c.get("unit", UNDEF) == unit]
        lst = sorted(lst, key=lambda c: -c.get("id", 0))
        return J({"success": True, "counts": [self.stockCountSummary(c) for c in lst]})

    @route("GET", "/api/stock-counts/:id", 4526)
    def r_count_one(self, req):
        self.loadData()
        c = self._find_count(req.params["id"])
        if not c:
            return ERR(404, "برگهٔ انبارگردانی یافت نشد")
        lines = []
        for l in c["lines"]:
            x = dict(l)
            it = next((i for i in self.items if i.get("code") == l.get("item")), None)
            inv = self.inventory.get(to_str(c.get("unit", UNDEF)))
            x["name"] = self.resolveItemName(l.get("item", UNDEF))
            x["unitLabel"] = js_or(it.get("unit", UNDEF) if it else UNDEF, "")
            x["currentQty"] = js_or(inv.get(to_str(l.get("item", UNDEF)), UNDEF) if truthy(inv) else inv, 0)
            lines.append(x)
        out = self.stockCountSummary(c)
        out["uncountedAsZero"] = truthy(c.get("uncountedAsZero"))
        out["lines"] = lines
        return J({"success": True, "count": out})

    @route("POST", "/api/stock-counts", 4535, catch=True)
    def r_count_create(self, req):
        self.loadData()
        b = req.body
        unit, date, note, actor = g(b, "unit"), g(b, "date"), g(b, "note"), g(b, "actorUsername")
        user = self._find_user(actor)
        if not user:
            return ERR(403, "کاربر نامعتبر است")
        if not any(d["id"] == unit for d in DEPTS):
            return ERR(400, "بخش نامعتبر است")
        if not self.canCountUnit(user, unit):
            return ERR(403, "فقط انباردار، مدیر یا کاربران همان بخش می‌توانند برای این بخش انبارگردانی کنند")
        m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", to_str(js_or(date, "")), re.ASCII)
        if not m:
            return ERR(400, "تاریخ شمارش نامعتبر است (مثلاً 1405/07/13)")
        jy, jm, jd = int(m.group(1)), int(m.group(2)), int(m.group(3))
        t = self.todayJalaliParts()
        if jm < 1 or jm > 12 or jd < 1 or jd > 31:
            return ERR(400, "تاریخ شمارش نامعتبر است")
        if jy * 10000 + jm * 100 + jd > t["y"] * 10000 + t["m"] * 100 + t["d"]:
            return ERR(400, "تاریخ شمارش نمی‌تواند در آینده باشد")
        if any(c.get("unit") == unit and c.get("status") == "open" for c in self.stockCounts):
            return ERR(400, "برای «" + to_str(self.deptName(unit)) + "» یک برگهٔ انبارگردانیِ باز وجود دارد؛ ابتدا آن را تمام یا لغو کنید")
        lines = [{"item": k, "systemQty": v, "countedQty": None, "note": ""}
                 for k, v in js_items(js_or(self.inventory.get(unit), {})) if not seq(v, 0)]
        c = {"id": self.stockCountSeq, "unit": unit, "dateJalali": "%d/%02d/%02d" % (jy, jm, jd),
             "dateFa": self.faDigits("%d/%d/%d" % (jy, jm, jd)), "status": "open", "note": to_str(js_or(note, ""))[:300],
             "createdBy": actor, "createdAt": self.now_iso(), "lines": lines}
        self.stockCountSeq += 1
        self.stockCounts.append(c)
        self.saveData()
        self.logActivity(actor, "شروع انبارگردانی", "برگه " + to_str(c["id"]) + " - " + to_str(self.deptName(unit)) + " - تاریخ " +
                         c["dateJalali"] + " - " + str(len(lines)) + " قلم")
        return J({"success": True, "id": c["id"], "count": self.stockCountSummary(c)})

    @route("POST", "/api/stock-counts/:id/entries", 4569, catch=True)
    def r_count_entries(self, req):
        self.loadData()
        c = self._find_count(req.params["id"])
        if not c:
            return ERR(404, "برگهٔ انبارگردانی یافت نشد")
        b = req.body
        user = self._find_user(g(b, "actorUsername"))
        if not user or not self.canCountUnit(user, c.get("unit", UNDEF)):
            return ERR(403, "دسترسی ندارید")
        if c.get("status") != "open":
            return ERR(400, "این برگه دیگر باز نیست")
        entries = b.get("entries") if isinstance(b.get("entries"), list) else []
        errors = []
        for e in entries:
            ei = g(e, "item")
            line = next((l for l in c["lines"] if seq(l.get("item", UNDEF), ei)), None)
            if not line:
                if not self.knownItemCode(c.get("unit", UNDEF), ei):
                    errors.append("کالای «" + to_str(ei) + "» شناخته‌شده نیست")
                    continue
                inv = self.inventory.get(to_str(c.get("unit", UNDEF)))
                line = {"item": ei, "systemQty": js_or(inv.get(to_str(ei), UNDEF) if truthy(inv) else inv, 0), "countedQty": None, "note": ""}
                c["lines"].append(line)
            cnt = g(e, "counted")
            if cnt is None or cnt == "" and isinstance(cnt, str) or cnt is UNDEF:
                line["countedQty"] = None
            else:
                q = to_number(cnt)
                if not is_finite(q) or q < 0 or q > 1e9:
                    errors.append("مقدار شمارش‌شدهٔ «" + to_str(self.resolveItemName(ei)) + "» نامعتبر است")
                    continue
                line["countedQty"] = num(js_round(q * 1e6) / 1e6)
            if isinstance(g(e, "note"), str):
                line["note"] = e["note"][:200]
        if isinstance(b.get("uncountedAsZero"), bool):
            c["uncountedAsZero"] = b["uncountedAsZero"]
        if errors:
            return ERR(400, "\n".join(errors))
        self.saveData()
        return J({"success": True, "count": self.stockCountSummary(c)})

    @route("POST", "/api/stock-counts/:id/finalize", 4603, catch=True)
    def r_count_finalize(self, req):
        self.loadData()
        c = self._find_count(req.params["id"])
        if not c:
            return ERR(404, "برگهٔ انبارگردانی یافت نشد")
        b = req.body
        actor = g(b, "actorUsername")
        if not self.isAdjustmentApprover(actor):
            return ERR(403, "فقط مدیر یا نقشی که مجوز «تایید ضایعات/کسری/اضافات» دارد می‌تواند انبارگردانی را نهایی کند")
        if c.get("status") != "open":
            return ERR(400, "این برگه قبلاً نهایی یا لغو شده است")
        uaz = b.get("uncountedAsZero", UNDEF) is True or (b.get("uncountedAsZero", UNDEF) is UNDEF and c.get("uncountedAsZero") is True)
        counted = [l for l in c["lines"] if l.get("countedQty", UNDEF) is not None and l.get("countedQty", UNDEF) is not UNDEF]
        if not counted and not uaz:
            return ERR(400, "هیچ کالایی شمارش نشده است")
        today = c.get("dateFa", UNDEF)
        created = []
        unchanged = uncounted = 0
        unit = to_str(c.get("unit", UNDEF))
        for l in c["lines"]:
            target = l.get("countedQty", UNDEF)
            if target is None or target is UNDEF:
                if not uaz:
                    uncounted += 1
                    continue
                target = 0
            inv = self._inv(unit)
            it = to_str(l.get("item", UNDEF))
            current = js_or(inv.get(it, UNDEF), 0)
            diff = num(js_round(mul(sub(target, current), 1000)) / 1000)
            l["finalSystemQty"] = current
            if abs(diff) < 0.001:
                unchanged += 1
                l["diff"] = 0
                continue
            l["diff"] = diff
            typ = "excess" if diff > 0 else "shortage"
            qty = abs(diff)
            bn = self.generateBatchNumber()
            note = ("انبارگردانی شماره " + to_str(c.get("id", UNDEF)) + " (" + to_str(c.get("dateJalali", UNDEF)) + ") - موجودی سیستم " +
                    to_str(current) + " ← شمارش " + to_str(target) + ((" - " + to_str(l["note"])) if truthy(l.get("note")) else ""))
            inv[it] = num(js_round(mul(add(current, diff), 1e6)) / 1e6)
            tx = {"id": self.seqId, "date": today, "type": typ, "unit": c.get("unit", UNDEF), "item": l.get("item", UNDEF), "qty": qty,
                  "note": note, "targetUnit": "", "fiscalYear": self.activeFiscalYear, "batchNumber": bn}
            self.seqId += 1
            self.transactions.append(tx)
            doc = {"id": self.docSeq, "date": today, "type": typ, "unit": c.get("unit", UNDEF), "item": l.get("item", UNDEF), "qty": qty,
                   "fromUnit": "", "toUnit": "", "note": note, "status": "approved", "fiscalYear": self.activeFiscalYear,
                   "createdBy": actor, "transactionId": tx["id"], "parentDocId": None, "batchNumber": bn, "source": "stockcount",
                   "stockCountId": c.get("id", UNDEF), "approvedBy": actor, "approvedAt": self.now_iso()}
            self.docSeq += 1
            self.docs.append(doc)
            l["docId"] = doc["id"]
            created.append(doc["id"])
        c["status"] = "finalized"
        c["finalizedBy"] = actor
        c["finalizedAt"] = self.now_iso()
        c["uncountedAsZero"] = uaz
        c["adjustmentDocIds"] = created
        c["result"] = {"excess": len([l for l in c["lines"] if is_number(l.get("diff")) and l["diff"] > 0]),
                       "shortage": len([l for l in c["lines"] if is_number(l.get("diff")) and l["diff"] < 0]),
                       "unchanged": unchanged, "uncounted": uncounted}
        self.saveData()
        self.logActivity(actor, "نهایی‌کردن انبارگردانی", "برگه " + to_str(c.get("id", UNDEF)) + " - " + to_str(self.deptName(c.get("unit", UNDEF))) +
                         " - اضافات: " + str(c["result"]["excess"]) + "، کسری: " + str(c["result"]["shortage"]) + "، بدون تغییر: " +
                         str(unchanged) + "، شمارش‌نشده: " + str(uncounted) + " - اسناد: " + js_or(", ".join(to_str(x) for x in created), "-"))
        return J({"success": True, "count": self.stockCountSummary(c),
                  "message": "انبارگردانی نهایی شد: " + str(c["result"]["excess"]) + " سند اضافات، " + str(c["result"]["shortage"]) + " سند کسری"})

    @route("POST", "/api/stock-counts/:id/cancel", 4665, catch=True)
    def r_count_cancel(self, req):
        self.loadData()
        c = self._find_count(req.params["id"])
        if not c:
            return ERR(404, "برگهٔ انبارگردانی یافت نشد")
        actor = g(req.body, "actorUsername")
        user = self._find_user(actor)
        if not user or not self.canCountUnit(user, c.get("unit", UNDEF)):
            return ERR(403, "دسترسی ندارید")
        if c.get("status") != "open":
            return ERR(400, "فقط برگهٔ باز قابل لغو است (اسناد اصلاحِ نهایی‌شده را از «اسناد» لغو کنید)")
        c["status"] = "cancelled"
        c["cancelledBy"] = actor
        c["cancelledAt"] = self.now_iso()
        self.saveData()
        self.logActivity(actor, "لغو انبارگردانی", "برگه " + to_str(c.get("id", UNDEF)) + " - " + to_str(self.deptName(c.get("unit", UNDEF))))
        return J({"success": True})

    # ---------- محل/حداقل موجودی/هدف تولید/تحلیل ----------
    def canManageWarehouseMeta(self, username):
        u = self._find_user(username)
        return bool(u) and u.get("role") in ("admin", "warehouse")

    @route("POST", "/api/locations", 4694, catch=True)
    def r_locations(self, req):
        self.loadData()
        b = req.body
        if not self.canManageWarehouseMeta(g(b, "actorUsername")):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند محل کالا را ثبت کند")
        entries = b.get("entries") if isinstance(b.get("entries"), list) else []
        if not entries or len(entries) > 2000:
            return ERR(400, "فهرست ورودی نامعتبر است")
        errors = []
        for e in entries:
            eu, ei = g(e, "unit"), g(e, "item")
            if not any(d["id"] == eu for d in DEPTS):
                errors.append("بخش نامعتبر: " + to_str(eu))
                continue
            if not self.knownItemCode(eu, ei):
                errors.append("کالای ناشناس: " + to_str(ei))
                continue
            locv = g(e, "location")
            loc = self.normalizeFa(to_str("" if locv is None or locv is UNDEF else locv))[:40]
            key = to_str(eu) + "|" + to_str(ei)
            if loc == "":
                self.itemLocations.pop(key, None)
            else:
                self.itemLocations[key] = loc
        if errors:
            return ERR(400, "\n".join(errors[:5]))
        self.saveData()
        extra = ""
        if len(entries) == 1:
            e0 = entries[0]
            extra = " - " + to_str(self.deptName(g(e0, "unit"))) + " / " + to_str(g(e0, "item")) + " ← " + to_str(js_or(g(e0, "location"), "(حذف)"))
        self.logActivity(g(b, "actorUsername"), "ثبت محل کالا", str(len(entries)) + " ردیف" + extra)
        return J({"success": True, "count": len(entries)})

    @route("POST", "/api/min-stock", 4719, catch=True)
    def r_min_stock(self, req):
        self.loadData()
        b = req.body
        if not self.canManageWarehouseMeta(g(b, "actorUsername")):
            return ERR(403, "فقط انباردار یا مدیر می‌تواند حداقل موجودی را تعیین کند")
        entries = b.get("entries") if isinstance(b.get("entries"), list) else []
        if not entries or len(entries) > 2000:
            return ERR(400, "فهرست ورودی نامعتبر است")
        errors = []
        for e in entries:
            eu, ei = g(e, "unit"), g(e, "item")
            if not any(d["id"] == eu for d in DEPTS):
                errors.append("بخش نامعتبر: " + to_str(eu))
                continue
            if not self.knownItemCode(eu, ei):
                errors.append("کالای ناشناس: " + to_str(ei))
                continue
            key = to_str(eu) + "|" + to_str(ei)
            mn = g(e, "min")
            if mn is None or mn is UNDEF or (isinstance(mn, str) and mn == ""):
                self.minStock.pop(key, None)
                continue
            q = to_number(mn)
            if not is_finite(q) or q < 0 or q > 1e9:
                errors.append("حداقل موجودیِ «" + to_str(ei) + "» نامعتبر است")
                continue
            if q == 0:
                self.minStock.pop(key, None)
            else:
                self.minStock[key] = num(js_round(q * 1e6) / 1e6)
        if errors:
            return ERR(400, "\n".join(errors[:5]))
        self.saveData()
        self.logActivity(g(b, "actorUsername"), "تعیین حداقل موجودی", str(len(entries)) + " ردیف")
        return J({"success": True, "count": len(entries)})

    def computeMinStockAlerts(self):
        alerts = []
        for key, mn in js_items(self.minStock):
            parts = key.split("|")
            unit, item = parts[0], parts[1] if len(parts) > 1 else UNDEF
            inv = self.inventory.get(unit)
            stock = js_or(inv.get(to_str(item), UNDEF) if truthy(inv) else inv, 0)
            if lt(add(stock, QTY_EPS), mn):
                alerts.append({"unit": unit, "unitName": self.deptName(unit), "item": item, "name": self.resolveItemName(item),
                               "stock": num(js_round(mul(stock, 1000)) / 1000), "min": mn, "deficit": num(js_round(mul(sub(mn, stock), 1000)) / 1000),
                               "location": js_or(self.itemLocations.get(key, UNDEF), "")})
        alerts.sort(key=lambda a: -(a["deficit"] / js_or(a["min"], 1)))
        return alerts

    @route("GET", "/api/min-stock/alerts", 4757)
    def r_min_alerts(self, req):
        self.loadData()
        return J({"success": True, "alerts": self.computeMinStockAlerts(), "totalRules": len(self.minStock)})

    @staticmethod
    def faKey(s):
        s = to_str(js_or(s, ""))
        s = re.sub(r"[۰-۹]", lambda m: str("۰۱۲۳۴۵۶۷۸۹".index(m.group(0))), s)
        s = re.sub(r"[٠-٩]", lambda m: str("٠١٢٣٤٥٦٧٨٩".index(m.group(0))), s)
        p = s.split("/")
        if len(p) != 3:
            return None
        y, m, d = [parse_int(x) for x in p]
        if not truthy(y) or not truthy(m) or not truthy(d):
            return None
        return y * 10000 + m * 100 + d

    @staticmethod
    def keyToFa(key):
        y = math.floor(key / 10000)
        m = math.floor(math.fmod(key, 10000) / 100)
        d = int(math.fmod(key, 100))
        return to_str(y) + "/" + to_str(m).rjust(2, "0") + "/" + to_str(d).rjust(2, "0")

    def jalaliKeyOf(self, ms):
        y, m, d = jalali_parts(ms)
        return y * 10000 + m * 100 + d

    @route("GET", "/api/production-targets", 4777)
    def r_targets(self, req):
        self.loadData()
        return J({"success": True, "targets": sorted(self.productionTargets, key=lambda t: -t.get("id", 0))})

    @route("POST", "/api/production-targets", 4782, catch=True)
    def r_target_add(self, req):
        self.loadData()
        b = req.body
        u = self._find_user(g(b, "actorUsername"))
        if not u or u.get("role") not in ("admin", "supervisor"):
            return ERR(403, "فقط مدیر یا سرپرست می‌تواند هدف تولید ثبت کند")
        unit, item, sd, ed, qty, note, period = (g(b, "unit"), g(b, "item"), g(b, "startDate"), g(b, "endDate"), g(b, "qty"),
                                                 g(b, "note"), g(b, "period"))
        if unit not in STAGE_DEPTS:
            return ERR(400, "بخش تولیدی نامعتبر است")
        if truthy(item) and not self.knownItemCode(unit, item):
            return ERR(400, "کالا شناخته‌شده نیست")
        sk, ek = self.faKey(sd), self.faKey(js_or(ed, sd))
        if not sk or not ek or ek < sk:
            return ERR(400, "بازهٔ تاریخ نامعتبر است")
        q = to_number(qty)
        if not is_finite(q) or q <= 0 or q > 1e9:
            return ERR(400, "مقدار هدف نامعتبر است")
        t = {"id": self.productionTargetSeq, "unit": unit, "item": js_or(item, None),
             "period": period if period in ("day", "week", "month", "custom") else "custom",
             "startDate": self.keyToFa(sk), "endDate": self.keyToFa(ek), "qty": q, "note": to_str(js_or(note, ""))[:200],
             "createdBy": g(b, "actorUsername"), "createdAt": self.now_iso()}
        self.productionTargetSeq += 1
        self.productionTargets.append(t)
        self.saveData()
        self.logActivity(g(b, "actorUsername"), "ثبت هدف تولید", to_str(self.deptName(unit)) +
                         ((" / " + to_str(self.resolveItemName(item))) if truthy(item) else "") + ": " + to_str(q) +
                         " (" + t["startDate"] + " تا " + t["endDate"] + ")")
        return J({"success": True, "target": t})

    @route("POST", "/api/production-targets/:id/delete", 4804, catch=True)
    def r_target_del(self, req):
        self.loadData()
        u = self._find_user(g(req.body, "actorUsername"))
        if not u or u.get("role") not in ("admin", "supervisor"):
            return ERR(403, "فقط مدیر یا سرپرست")
        n = parse_int(req.params["id"])
        idx = next((i for i, t in enumerate(self.productionTargets) if seq(t.get("id", UNDEF), n)), -1)
        if idx == -1:
            return ERR(404, "هدف یافت نشد")
        t = self.productionTargets.pop(idx)
        self.saveData()
        self.logActivity(g(req.body, "actorUsername"), "حذف هدف تولید", to_str(self.deptName(t.get("unit", UNDEF))) + " " +
                         to_str(t.get("startDate", UNDEF)) + "-" + to_str(t.get("endDate", UNDEF)) + " " + to_str(t.get("qty", UNDEF)))
        return J({"success": True})

    @route("GET", "/api/analytics/production", 4822, catch=True)
    def r_analytics(self, req):
        self.loadData()
        pq = req.query.get("period", UNDEF)
        period = pq if pq in ("today", "7d", "month", "fy") else "today"
        now = self.now()
        todayK = self.jalaliKeyOf(now)
        fromK, label = todayK, "امروز"
        if period == "7d":
            fromK, label = self.jalaliKeyOf(now - 6 * 86400000), "۷ روز اخیر"
        elif period == "month":
            fromK, label = math.floor(todayK / 100) * 100 + 1, "ماه جاری"
        elif period == "fy":
            fy = next((f for f in self.fiscalYears if f.get("year", UNDEF) == self.activeFiscalYear), None) or \
                (self.fiscalYears[0] if self.fiscalYears else None)
            fk = self.faKey(fy.get("startDate", UNDEF)) if fy else None
            fromK = fk if truthy(fk) else (math.floor(todayK / 10000) * 10000 + 101)
            label = "سال مالی " + (to_str(fy.get("year", UNDEF)) if fy else "")

        def N(v):
            return 0 if v is None else v

        def inPeriod(t):
            k = self.faKey(t.get("date", UNDEF))
            return k is not None and k >= fromK and k <= todayK
        dayKeys = [self.jalaliKeyOf(now - i * 86400000) for i in range(13, -1, -1)]

        def r3(v):
            return num(js_round(mul(v, 1000)) / 1000)
        depts = []
        for unit in STAGE_DEPTS:
            prod = [t for t in self.transactions if t.get("unit") == unit and t.get("type") == "production"]
            waste = [t for t in self.transactions if t.get("unit") == unit and t.get("type") == "waste"]
            pIn, wIn = [t for t in prod if inPeriod(t)], [t for t in waste if inPeriod(t)]

            def sm(arr):
                s = 0
                for t in arr:
                    s = add(s, js_or(t.get("qty", UNDEF), 0))
                return r3(s)
            producedQty, wasteQty = sm(pIn), sm(wIn)
            its = {}
            for t in pIn:
                k = to_str(t.get("item", UNDEF))
                if not truthy(its.get(k)):
                    its[k] = {"item": t.get("item", UNDEF), "produced": 0, "waste": 0}
                its[k]["produced"] = add(its[k]["produced"], t.get("qty", UNDEF))
            for t in wIn:
                k = to_str(t.get("item", UNDEF))
                if not truthy(its.get(k)):
                    its[k] = {"item": t.get("item", UNDEF), "produced": 0, "waste": 0}
                its[k]["waste"] = add(its[k]["waste"], t.get("qty", UNDEF))
            top = [{"item": x["item"], "name": self.resolveItemName(x["item"]), "produced": r3(x["produced"]), "waste": r3(x["waste"]),
                    "wastePct": num(js_round(x["waste"] / x["produced"] * 1000) / 10) if x["produced"] > 0 else None}
                   for x in js_values(its)]
            top.sort(key=lambda a: -a["produced"])
            top = top[:8]
            overlap = [t for t in self.productionTargets if t.get("unit") == unit and N(self.faKey(t.get("endDate", UNDEF))) >= fromK
                       and N(self.faKey(t.get("startDate", UNDEF))) <= todayK]
            deptLevel = [t for t in overlap if not truthy(t.get("item"))]
            targetQty = 0
            for t in (deptLevel if deptLevel else overlap):
                targetQty = add(targetQty, t.get("qty", UNDEF))
            series = []
            for k in dayKeys:
                s = 0
                for t in prod:
                    if self.faKey(t.get("date", UNDEF)) == k:
                        s = add(s, js_or(t.get("qty", UNDEF), 0))
                series.append({"date": self.keyToFa(k), "qty": r3(s)})
            depts.append({
                "unit": unit, "name": self.deptName(unit),
                "produced": {"count": len(pIn), "qty": producedQty}, "waste": {"count": len(wIn), "qty": wasteQty},
                "wastePct": num(js_round(wasteQty / producedQty * 1000) / 10) if producedQty > 0 else None,
                "yieldPct": num(js_round(producedQty / (producedQty + wasteQty) * 1000) / 10) if (producedQty + wasteQty) > 0 else None,
                "target": {"qty": targetQty, "pct": num(js_round(producedQty / targetQty * 1000) / 10)} if targetQty > 0 else None,
                "topItems": top, "series": series})
        tp = tw = tdocs = 0
        for d in depts:
            tp = tp + d["produced"]["qty"]
            tw = tw + d["waste"]["qty"]
            tdocs = tdocs + d["produced"]["count"]
        return J({"success": True, "period": period, "label": label, "from": self.keyToFa(fromK), "to": self.keyToFa(todayK),
                  "depts": depts, "totals": {"produced": tp, "waste": tw, "docs": tdocs},
                  "minStockAlerts": len(self.computeMinStockAlerts()), "hasTargets": len(self.productionTargets) > 0})

    # ---------- لاگ فعالیت ----------
    @route("POST", "/api/activity/login", 4899, catch=True)
    def r_act_login(self, req):
        self.loadData()
        username = g(req.body, "username")
        u = self._find_user(username)
        self.logActivity(username, "ورود به سیستم", (to_str(u.get("fullname", UNDEF)) + " (" + to_str(u.get("unit", UNDEF)) + ")") if u else "")
        return J({"success": True})

    @route("GET", "/api/activity-log", 4911)
    def r_act_log(self, req):
        self.loadData()
        limit = parse_int(req.query.get("limit", UNDEF))
        limit = limit if truthy(limit) else 500
        lst = list(reversed(self.activityLog))
        lst = lst[0:limit] if limit >= 0 else lst[0:len(lst) + limit] if len(lst) + limit > 0 else []
        return J({"success": True, "log": lst})

    @route("POST", "/api/activity/log", 4921, catch=True)
    def r_act_post(self, req):
        self.loadData()
        b = req.body
        if not truthy(g(b, "action")):
            return ERR(400, "عنوان عملیات الزامی است")
        self.logActivity(g(b, "actorUsername"), g(b, "action"), g(b, "details"))
        return J({"success": True})

    # ---------- تنظیمات ----------
    @route("GET", "/api/settings/sepidar", 4937)
    def r_get_sep(self, req):
        self.loadData()
        cfg = js_or(g(self.appSettings, "sepidar") if truthy(self.appSettings) else UNDEF, DEFAULT_SEPIDAR_CONFIG)
        return J({"success": True, "sepidar": cfg})

    @route("POST", "/api/settings/sepidar", 4943, catch=True)
    def r_set_sep(self, req):
        self.loadData()
        b = req.body
        user, pw, server, db, enc, tsc = (g(b, "user"), g(b, "password"), g(b, "server"), g(b, "database"), g(b, "encrypt"),
                                          g(b, "trustServerCertificate"))
        if not truthy(user) or not truthy(pw) or not truthy(server) or not truthy(db):
            return ERR(400, "همه‌ی فیلدهای اتصال (کاربر/رمز/سرور/دیتابیس) الزامی است")
        self.appSettings["sepidar"] = {"user": user, "password": pw, "server": server, "database": db,
                                       "encrypt": truthy(enc), "trustServerCertificate": truthy(tsc)}
        self.saveData()
        self.sepidarPool = None
        self.logActivity(g(b, "actorUsername"), "تغییر تنظیمات اتصال سپیدار", "سرور: " + to_str(server) + ", دیتابیس: " + to_str(db))
        return J({"success": True, "message": "تنظیمات اتصال سپیدار ذخیره شد"})

    @route("POST", "/api/settings/sepidar/test", 4962)
    def r_test_sep(self, req):
        b = req.body
        user, pw, server, db, enc, tsc = (g(b, "user"), g(b, "password"), g(b, "server"), g(b, "database"), g(b, "encrypt"),
                                          g(b, "trustServerCertificate"))
        if not truthy(user) or not truthy(pw) or not truthy(server) or not truthy(db):
            return ERR(400, "همه‌ی فیلدهای اتصال الزامی است")
        pool = None
        try:
            pool = self.await_(self.sepidar.connect, {"user": user, "password": pw, "server": server, "database": db,
                                                      "options": {"encrypt": truthy(enc), "trustServerCertificate": truthy(tsc)},
                                                      "connectionTimeout": 15000, "requestTimeout": 15000})
            self.sql(pool, "SELECT 1")
            return J({"success": True, "message": "✅ اتصال با موفقیت برقرار شد"})
        except Exception as e:
            return ERR(400, js_err_message(e))
        finally:
            if pool is not None:
                try:
                    pool.close()
                except Exception:
                    pass

    @route("GET", "/api/settings/output-messenger", 4986)
    def r_get_om(self, req):
        self.loadData()
        return J({"success": True, "outputMessenger": self.getOutputMessengerConfig(), "depts": deep_copy(DEPTS)})

    @route("POST", "/api/settings/output-messenger", 4991, catch=True)
    def r_set_om(self, req):
        self.loadData()
        b = req.body
        enabled, host, port, apiKey, fromUser, groups, actor = (g(b, "enabled"), g(b, "host"), g(b, "port"), g(b, "apiKey"),
                                                                g(b, "fromUser"), g(b, "deptGroups"), g(b, "actorUsername"))
        if truthy(enabled) and (not truthy(host) or not truthy(port) or not truthy(apiKey)):
            return ERR(400, "برای فعال‌سازی، آدرس سرور/پورت/API-KEY الزامی است")
        p = parse_int(port)
        self.appSettings["outputMessenger"] = {"enabled": truthy(enabled), "host": js_or(host, ""), "port": p if truthy(p) else 0,
                                               "apiKey": js_or(apiKey, ""), "fromUser": js_or(fromUser, ""),
                                               "deptGroups": groups if (truthy(groups) and isinstance(groups, (dict, list))) else {}}
        self.saveData()
        self.logActivity(actor, "تغییر تنظیمات Output Messenger", "فعال: " + ("بله" if truthy(enabled) else "خیر") + ", سرور: " +
                         to_str(host) + ":" + to_str(port))
        return J({"success": True, "message": "تنظیمات Output Messenger ذخیره شد"})

    @route("POST", "/api/settings/output-messenger/test", 5016)
    def r_test_om(self, req):
        b = req.body
        host, port, apiKey, room, fromUser = g(b, "host"), g(b, "port"), g(b, "apiKey"), g(b, "room"), g(b, "fromUser")
        if not truthy(host) or not truthy(port) or not truthy(apiKey) or not truthy(room):
            return ERR(400, "آدرس سرور/پورت/API-KEY/نام گروه همه الزامی هستند")
        params = [("room", to_str(room)), ("message", "✅ پیام آزمایشی از سیستم مدیریت تولید"), ("notify", "1")]
        if truthy(fromUser):
            params.append(("from", to_str(fromUser)))
        kind, val = self.await_(self.notifier.om_request, to_str(host), parse_int(port), to_str(apiKey), params, 8.0)
        if kind == "timeout":
            return ERR(504, "اتصال به Output Messenger زمان‌گیر شد (timeout)")
        if kind == "error":
            return ERR(500, to_str(val))
        try:
            parsed = json.loads(val)
        except Exception:
            return ERR(500, "پاسخ نامعتبر از سرور Output Messenger")
        if isinstance(parsed, dict) and truthy(parsed.get("success")):
            return J({"success": True, "message": "✅ پیام آزمایشی به گروه «" + to_str(room) + "» ارسال شد"})
        return ERR(400, js_or(g(parsed, "message") if isinstance(parsed, dict) else UNDEF, "Output Messenger پاسخ ناموفق داد"))

    @route("GET", "/api/settings/warehouse-gate", 5049)
    def r_get_wg(self, req):
        self.loadData()
        cfg = js_or(g(self.appSettings, "warehouseGate") if truthy(self.appSettings) else UNDEF, DEFAULT_WAREHOUSE_GATE_CONFIG)
        return J({"success": True, "warehouseGate": cfg, "depts": deep_copy(DEPTS)})

    @route("POST", "/api/settings/warehouse-gate", 5055, catch=True)
    def r_set_wg(self, req):
        self.loadData()
        pairs, actor = g(req.body, "pairs"), g(req.body, "actorUsername")
        if not isinstance(pairs, list):
            return ERR(400, "فرمت لیست جفت‌بخش‌ها نامعتبر است")
        norm = []
        for p in pairs:
            if isinstance(p, str):
                p = p.split("|")
            if isinstance(p, list) and len(p) == 2 and any(d["id"] == p[0] for d in DEPTS) and any(d["id"] == p[1] for d in DEPTS):
                k = self.warehouseGatePairKey(p[0], p[1])
                if k not in norm:
                    norm.append(k)
        self.appSettings["warehouseGate"] = {"pairs": norm}
        self.saveData()
        self.logActivity(actor, "تغییر تنظیمات تاییدِ انباردار برای خروج بین بخش‌ها", "تعداد جفت‌بخش‌های فعال: " + str(len(norm)))
        return J({"success": True, "message": "تنظیمات ذخیره شد", "pairs": norm})

    @route("POST", "/api/settings/port", 5077, catch=True)
    def r_set_port(self, req):
        self.loadData()
        port = parse_int(g(req.body, "appPort"))
        if not truthy(port) or port < 1 or port > 65535:
            return ERR(400, "شماره پورت نامعتبر است")
        self.appSettings["appPort"] = port
        self.saveData()
        self.logActivity(g(req.body, "actorUsername"), "تغییر پورت اپ", "پورت جدید: " + str(port))
        return J({"success": True, "message": "پورت روی " + str(port) + " ذخیره شد - برای اعمال، سرور را ری‌استارت کنید"})

    @route("GET", "/api/settings/role-permissions", 5102)
    def r_get_rp(self, req):
        self.loadData()
        return J({"success": True, "rolePermissions": self.appSettings.get("rolePermissions", UNDEF),
                  "sections": list(SETTINGS_MANAGED_SECTIONS), "permissions": list(SETTINGS_MANAGED_PERMISSIONS)})

    @route("POST", "/api/settings/role-permissions", 5107, catch=True)
    def r_set_rp(self, req):
        self.loadData()
        rp, actor = g(req.body, "rolePermissions"), g(req.body, "actorUsername")
        if not truthy(rp) or not isinstance(rp, (dict, list)):
            return ERR(400, "داده‌ی مجوزها نامعتبر است")
        for role in ["supervisor", "warehouse", "user"]:
            v = g(rp, role) if isinstance(rp, dict) else UNDEF
            if isinstance(v, list):
                self.appSettings["rolePermissions"][role] = [s for s in v if isinstance(s, str) and
                                                             (s in SETTINGS_MANAGED_SECTIONS or s in SETTINGS_MANAGED_PERMISSIONS)]
        self.saveData()
        self.logActivity(actor, "تغییر دسترسی نقش‌ها", stringify(self.appSettings["rolePermissions"]))
        return J({"success": True, "message": "ماتریس دسترسی نقش‌ها ذخیره شد"})

    # ---------- Web Push ----------
    @route("GET", "/api/push/vapid-public-key", 5130)
    def r_vapid(self, req):
        self.loadData()
        self.ensurePushKeys()
        return J({"success": True, "publicKey": self.appSettings["push"]["publicKey"]})

    @route("POST", "/api/push/subscribe", 5136, catch=True)
    def r_push_sub(self, req):
        b = req.body
        username, sub, test = g(b, "username"), g(b, "subscription"), g(b, "test")
        platform = "desktop" if b.get("platform") == "desktop" else "mobile"
        if not truthy(username) or not truthy(sub) or not truthy(g(sub, "endpoint")) or not truthy(g(sub, "keys")):
            return ERR(400, "اطلاعات اشتراک ناقص است")
        self.loadData()
        self.pushSubscriptions = [s for s in self.pushSubscriptions if not seq(s.get("endpoint", UNDEF), sub["endpoint"])]
        ua = req.headers.get("user-agent", "")
        self.pushSubscriptions.append({"id": self.now(), "username": username, "endpoint": sub["endpoint"], "keys": sub["keys"],
                                       "platform": platform, "userAgent": to_str(js_or(ua, ""))[:200], "createdAt": self.now_iso()})
        self.saveData()
        testSent = 0
        if truthy(test):
            try:
                self.ensurePushKeys()
                cfg = self.appSettings["push"]
                payload = stringify({"title": "✅ اعلان فعال شد",
                                     "body": "از این پس اعلان سندهای منتظر تایید حتی با بسته بودن برنامه نمایش داده می‌شود.",
                                     "url": "/" if platform == "desktop" else "/mobile/", "tag": "wh-test"})
                status = self.await_(self.notifier.web_push, (cfg.get("subject"), cfg.get("publicKey"), cfg.get("privateKey")),
                                     sub["endpoint"], deep_copy(sub["keys"]), payload, 600, None)
                if status is not None and 200 <= status < 300:
                    testSent = 1
            except Exception as e:
                self.log("⚠️ ارسال آزمایشی Web Push ناموفق:", js_err_message(e))
        return J({"success": True, "testSent": testSent, "message": "نوتیفیکیشن این دستگاه فعال شد"})

    @route("POST", "/api/push/unsubscribe", 5180, catch=True)
    def r_push_unsub(self, req):
        ep = g(req.body, "endpoint")
        self.loadData()
        self.pushSubscriptions = [s for s in self.pushSubscriptions if not seq(s.get("endpoint", UNDEF), ep)]
        self.saveData()
        return J({"success": True, "message": "نوتیفیکیشن این دستگاه غیرفعال شد"})

    # ---------- پشتیبان ----------
    app_dir = "."          # معادلِ __dirname (برای مسیرِ پیش‌فرضِ بکاپ)
    fs_jail = None          # در حالتِ سایه: همهٔ مسیرهای بکاپ زیرِ این پوشه نگاشت می‌شوند

    def _real(self, p):
        if not self.fs_jail:
            return p
        drive, rest = os.path.splitdrive(os.path.abspath(p))
        return os.path.join(self.fs_jail, (drive.replace(":", "") + rest).lstrip("\\/"))

    def getBackupSettings(self):
        cfg = dict(DEFAULT_BACKUP_SETTINGS)
        b = g(self.appSettings, "backup") if truthy(self.appSettings) else UNDEF
        if truthy(b) and isinstance(b, dict):
            for k in js_keys(b):
                cfg[k] = b[k]
        return cfg

    def _resolve_folder(self, folder):
        return os.path.abspath(to_str(folder)) if truthy(folder) else os.path.join(self.app_dir, "backups")

    def resolveBackupFolder(self):
        return self._resolve_folder(self.getBackupSettings().get("folder"))

    @route("GET", "/api/backup/settings", 5201)
    def r_backup_settings(self, req):
        self.loadData()
        out = {"success": True}
        out.update(self.getBackupSettings())
        out["resolvedFolder"] = self.resolveBackupFolder()
        return J(out)

    @route("POST", "/api/backup/settings", 5207, catch=True)
    def r_backup_settings_set(self, req):
        self.loadData()
        b = req.body
        folder, ae, aih, kc = g(b, "folder"), g(b, "autoEnabled"), g(b, "autoIntervalHours"), g(b, "keepCount")
        target = self._resolve_folder(folder)
        try:
            real = self._real(target)
            os.makedirs(real, exist_ok=True)
            tf = os.path.join(real, ".write-test-" + str(self.now()))
            with open(tf, "w") as fh:
                fh.write("test")
            os.unlink(tf)
        except Exception as fe:
            return ERR(400, "پوشه‌ی بکاپ قابل‌نوشتن نیست: " + js_err_message(fe))
        pf, pi = parse_float(aih), parse_int(kc)
        self.appSettings["backup"] = {"folder": js_or(folder, ""), "autoEnabled": truthy(ae),
                                      "autoIntervalHours": pf if truthy(pf) else 24, "keepCount": pi if truthy(pi) else 30}
        self.saveData()
        if self.backup:
            self.backup.rearm()
        self.logActivity(g(b, "actorUsername"), "تغییر تنظیمات بکاپ", "پوشه: " + target + ", خودکار: " + ("true" if truthy(ae) else "false"))
        return J({"success": True, "message": "تنظیمات بکاپ ذخیره شد", "resolvedFolder": target})

    def _tehran_stamp(self):
        dt = local_dt(self.now())
        return "%04d-%02d-%02d_%02d-%02d-%02d" % (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)

    BACKUP_RE = re.compile(r"^backup_[\w-]+\.json$", re.ASCII)

    def createBackupFile(self):
        self.loadData()
        self.saveData()
        folder = self.resolveBackupFolder()
        real = self._real(folder)
        os.makedirs(real, exist_ok=True)
        filename = "backup_" + self._tehran_stamp() + ".json"
        with open(os.path.join(real, filename), "w", encoding="utf-8") as fh:
            fh.write(stringify(self.data, 2))
        keep = self.getBackupSettings().get("keepCount")
        files = [f for f in os.listdir(real) if self.BACKUP_RE.match(f)]
        files.sort(key=lambda f: -os.stat(os.path.join(real, f)).st_mtime)
        if is_number(keep):
            for f in files[int(keep):] if keep >= 0 else files[len(files) + int(keep):] if len(files) + int(keep) > 0 else files:
                try:
                    os.unlink(os.path.join(real, f))
                except Exception:
                    pass
        return {"filename": filename, "folder": folder}

    def latestBackupTime(self):
        try:
            real = self._real(self.resolveBackupFolder())
            ts = [os.stat(os.path.join(real, f)).st_mtime * 1000 for f in os.listdir(real) if self.BACKUP_RE.match(f)]
            return max(ts) if ts else 0
        except Exception:
            return 0

    def autoBackupIfDue(self):
        with self.lock:
            cfg = self.getBackupSettings()
            if not truthy(cfg.get("autoEnabled")):
                return
            interval = max(to_number(cfg.get("autoIntervalHours")), 0.5) * 3600 * 1000
            if time.time() * 1000 - self.latestBackupTime() < interval:
                return
            try:
                r = self.createBackupFile()
                self.log("🕐 بکاپ خودکار گرفته شد:", r["filename"])
            except Exception as e:
                self.log("❌ خطا در بکاپ خودکار:", js_err_message(e))

    @route("POST", "/api/backup/create", 5309, catch=True)
    def r_backup_create(self, req):
        r = self.createBackupFile()
        return J({"success": True, "message": "بکاپ ساخته شد: " + r["filename"], "filename": r["filename"]})

    @route("GET", "/api/backup/list", 5318, catch=True)
    def r_backup_list(self, req):
        real = self._real(self.resolveBackupFolder())
        if not os.path.exists(real):
            return J({"success": True, "backups": []})
        out = []
        for f in os.listdir(real):
            if not self.BACKUP_RE.match(f):
                continue
            st = os.stat(os.path.join(real, f))
            out.append({"filename": f, "sizeBytes": st.st_size, "createdAt": iso(int(st.st_mtime * 1000))})
        out.sort(key=lambda x: -date_parse(x["createdAt"]))
        return J({"success": True, "backups": out})

    def safeBackupFilePath(self, filename):
        if not isinstance(filename, str) or not self.BACKUP_RE.match(filename):
            return None
        folder = self.resolveBackupFolder()
        fp = os.path.join(folder, filename)
        if os.path.dirname(fp) != folder:
            return None
        return fp

    @route("GET", "/api/backup/download/:filename", 5343)
    def r_backup_download(self, req):
        fp = self.safeBackupFilePath(req.params["filename"])
        if not fp or not os.path.exists(self._real(fp)):
            return ERR(404, "فایل بکاپ یافت نشد")
        return Response(200, self._real(fp), kind="file",
                        headers={"Content-Disposition": 'attachment; filename="' + os.path.basename(fp) + '"'})

    @route("POST", "/api/backup/restore/:filename", 5351, catch=True)
    def r_backup_restore(self, req):
        fp = self.safeBackupFilePath(req.params["filename"])
        if not fp or not os.path.exists(self._real(fp)):
            return ERR(404, "فایل بکاپ یافت نشد")
        with open(self._real(fp), encoding="utf-8") as fh:
            restored = json.loads(fh.read())
        if not truthy(g(restored, "items")) or not truthy(g(restored, "users")):
            return ERR(400, "فایل بکاپ نامعتبر است")
        self.applyLoadedData(restored)
        self.saveData()
        self.logActivity(req.query.get("actorUsername", UNDEF), "بازیابی از بکاپ", req.params["filename"])
        return J({"success": True, "message": "داده‌ها با موفقیت از بکاپ بازیابی شدند"})

    @route("DELETE", "/api/backup/:filename", 5370)
    def r_backup_delete(self, req):
        fp = self.safeBackupFilePath(req.params["filename"])
        if not fp or not os.path.exists(self._real(fp)):
            return ERR(404, "فایل بکاپ یافت نشد")
        try:
            os.unlink(self._real(fp))
            return J({"success": True, "message": "بکاپ حذف شد"})
        except Exception as e:
            return ERR(500, js_err_message(e))

    @route("POST", "/api/admin/clear-fiscal-year-data", 5386, catch=True)
    def r_clear_fy(self, req):
        fy, actorUsername = g(req.body, "fiscalYear"), g(req.body, "actorUsername")
        self.loadData()
        actor = self._find_user(actorUsername)
        if not actor or actor.get("role") != "admin":
            return ERR(403, "فقط مدیر می‌تواند این عملیات را انجام دهد")
        if not truthy(fy):
            return ERR(400, "سال مالی مشخص نشده است")
        db, tb, ib = len(self.docs), len(self.transactions), len(self.initialInventory)
        self.docs = [d for d in self.docs if not seq(d.get("fiscalYear", UNDEF), fy)]
        self.transactions = [t for t in self.transactions if not seq(t.get("fiscalYear", UNDEF), fy)]
        self.initialInventory = [t for t in self.initialInventory if not seq(t.get("fiscalYear", UNDEF), fy)]
        zeroed = 0
        for dept in js_keys(self.inventory):
            inv = js_or(self.inventory[dept], {})
            for code in js_keys(inv):
                if not seq(inv[code], 0):
                    zeroed += 1
                inv[code] = 0
        self.saveData()
        dd, td, idl = db - len(self.docs), tb - len(self.transactions), ib - len(self.initialInventory)
        self.logActivity(actorUsername, "⚠️ پاک‌سازی کامل سال مالی", "سال مالی: " + to_str(fy) + " - " + str(dd) + " سند، " + str(td) +
                         " تراکنش، " + str(idl) + " ردیف موجودی اول دوره حذف شد، موجودی همه‌ی بخش‌ها صفر شد (" + str(zeroed) + " قلم)")
        return J({"success": True, "docsDeleted": dd, "txDeleted": td, "initDeleted": idl, "itemsZeroed": zeroed,
                  "message": "سال مالی " + to_str(fy) + " کامل پاک شد: " + str(dd) + " سند، " + str(td) + " تراکنش، " + str(idl) +
                             " ردیف موجودی اول دوره حذف شد و موجودی همه‌ی بخش‌ها صفر شد"})


BOM_QUERY = """
      SELECT 
        pf.[Code] AS BomCode,
        pf.[ItemCode] AS ProductCode,
        pf.[Title] AS ProductName,
        bi.[ItemCode] AS MatCode,
        bi.[ItemTitle] AS MatName,
        bi.[ItemUnitTitle] AS Unit,
        bi.[Quantity] AS Qty
      FROM WKO.[vwFormulaBomItem] bi
      INNER JOIN WKO.[vwProductFormula] pf ON bi.[ProductFormulaRef] = pf.[ProductFormulaID]
      WHERE pf.[IsActive] = 1
      ORDER BY pf.[Code]
    """


def _check_locked(self):
    """اجرای دوره‌ای (هر ۱۵ دقیقه) — مثل setInterval در Node؛ قفل را خودش می‌گیرد و در await آزاد می‌کند."""
    self._tls.after = []
    with self.lock:
        self.checkSepidarDeletedDocs()
    jobs = self._tls.after
    self._tls.after = []
    for j in jobs:
        try:
            j()
        except Exception:
            pass


Engine.checkSepidarDeletedDocs_locked = _check_locked
