# -*- coding: utf-8 -*-
"""مقایسهٔ پاسخ‌ها و داده‌ی Node با نسخهٔ سایه (فقط در دورهٔ آزمایشی). همهٔ کارِ سنگین این‌جا و داخلِ فرایندِ سایه
انجام می‌شود تا «دوشاخه» سبک بماند و هیچ کُندی‌ای به کاربر نرسد."""
import json
import os
import re
import threading
import time
from datetime import datetime, timezone, timedelta

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
TEHRAN = timezone(timedelta(hours=3, minutes=30))
VOLATILE_KEYS = {"version", "dataVersion"}


def parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000


def compare(a, b, path="$", out=None, tol_ms=5000, limit=20):
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k in VOLATILE_KEYS:
                continue
            if k not in b:
                out.append({"path": path + "." + k, "node": a[k], "shadow": "(نیست)"})
            else:
                compare(a[k], b[k], path + "." + k, out, tol_ms, limit)
        for k in b:
            if k not in a and k not in VOLATILE_KEYS:
                out.append({"path": path + "." + k, "node": "(نیست)", "shadow": b[k]})
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append({"path": path, "node": "len %d" % len(a), "shadow": "len %d" % len(b)})
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, "%s[%d]" % (path, i), out, tol_ms, limit)
    elif isinstance(a, str) and isinstance(b, str) and ISO_RE.match(a) and ISO_RE.match(b):
        if abs(parse_iso(a) - parse_iso(b)) > tol_ms:
            out.append({"path": path, "node": a, "shadow": b})
    elif isinstance(a, bool) or isinstance(b, bool):
        if a is not b:
            out.append({"path": path, "node": a, "shadow": b})
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a != b and not (path.endswith(".id") and a > 1e12 and abs(a - b) <= tol_ms):
            out.append({"path": path, "node": a, "shadow": b})
    elif a != b:
        out.append({"path": path, "node": a, "shadow": b})
    return out


def _trim(v):
    s = json.dumps(v, ensure_ascii=False, default=str)
    return v if len(s) <= 300 else s[:300] + "…"


class Recorder:
    def __init__(self, out_dir):
        self.out_dir = out_dir
        os.makedirs(out_dir, exist_ok=True)
        self.lock = threading.Lock()
        self.stats = {}
        self.slow = []

    def day(self):
        return datetime.now(TEHRAN).strftime("%Y-%m-%d")

    def write(self, kind, obj):
        with self.lock:
            with open(os.path.join(self.out_dir, "%s-%s.jsonl" % (kind, self.day())), "a", encoding="utf-8") as fh:
                fh.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")

    def count(self, key, field, ms=None):
        with self.lock:
            s = self.stats.setdefault(key, {"total": 0, "same": 0, "diff": 0, "skipped": 0, "shadowMsMax": 0, "nodeMsMax": 0})
            s[field] += 1
            if field != "skipped":
                s["total"] += 1
            if ms:
                s["shadowMsMax"] = max(s["shadowMsMax"], round(ms[0], 1))
                s["nodeMsMax"] = max(s["nodeMsMax"], round(ms[1], 1))


def route_key(method, path):
    return method + " " + re.sub(r"/\d+(?=/|$)", "/:id", path.split("?")[0])


def compare_response(rec, env, s_status, s_body, shadow_ms):
    key = route_key(env["method"], env["path"])
    if env["status"] == 304 or env["path"].startswith("/api/backup/download"):
        rec.count(key, "skipped")
        return
    n_body = env["respBody"]
    diffs = []
    if s_status != env["status"]:
        diffs.append({"path": "status", "node": env["status"], "shadow": s_status})
    if n_body != s_body:
        try:
            diffs += compare(json.loads(n_body.decode("utf-8")), json.loads(s_body.decode("utf-8")))
        except Exception:
            if "text/html" not in env.get("respType", ""):
                diffs.append({"path": "body", "node": n_body[:300].decode("utf-8", "replace"), "shadow": s_body[:300].decode("utf-8", "replace")})
    ms = (shadow_ms, env.get("nodeMs", 0))
    if diffs:
        rec.count(key, "diff", ms)
        body = env["body"][:4000].decode("utf-8", "replace") if env["body"] else ""
        rec.write("diffs", {"t": env["t"], "seq": env.get("seq"), "req": key, "path": env["path"], "body": body,
                            "kind": "write" if env["method"] != "GET" else "read",
                            "diffs": [{k: _trim(v) for k, v in d.items()} for d in diffs[:20]]})
    else:
        rec.count(key, "same", ms)


def nightly_compare(engine, node_db, rec, reseed=True):
    with open(node_db, encoding="utf-8") as fh:
        node_state = json.load(fh)
    with engine.lock:
        engine.loadData()
        from jsx import stringify
        shadow_state = json.loads(stringify(engine.data))
    diffs = compare(node_state, shadow_state, tol_ms=60000, limit=50)
    day = rec.day()
    with rec.lock:
        stats, rec.stats = rec.stats, {}
    tot = {k: sum(v.get(k, 0) for v in stats.values()) for k in ("total", "same", "diff", "skipped")}
    summary = {"day": day, "at": datetime.now(TEHRAN).isoformat(), "stateEqual": not diffs, "stateDiffs": [{k: _trim(v) for k, v in d.items()} for d in diffs],
               "totals": tot, "byRoute": stats}
    with open(os.path.join(rec.out_dir, "report-%s.json" % day), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=1, default=str)
    if reseed:
        engine.reseed(node_state)
    return summary


def nightly_loop(engine, node_db, rec, hour=2):
    while True:
        now = datetime.now(TEHRAN)
        nxt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        time.sleep((nxt - now).total_seconds())
        try:
            nightly_compare(engine, node_db, rec)
        except Exception as e:
            rec.write("errors", {"where": "nightly", "error": repr(e)})
