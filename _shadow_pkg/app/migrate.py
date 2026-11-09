# -*- coding: utf-8 -*-
"""انتقالِ db.json سیستم تولید به پایگاهِ SQLite نسخهٔ جدید — با بررسیِ کاملِ برابری.

  python migrate.py --from C:\\WarehouseSystem\\db.json --to <پوشهٔ داده> [--replace]

فایلِ db.json فقط خوانده می‌شود (هیچ تغییری در آن داده نمی‌شود). اگر هر بررسی شکست بخورد، خروجی با کدِ ۱ تمام
می‌شود و چیزی جایگزین نمی‌شود.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store  # noqa: E402


def deep_equal(a, b, path="$", out=None):
    if out is None:
        out = []
    if len(out) > 20:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            out.append(path + ": کلیدها فرق دارند")
        for k in a:
            if k in b:
                deep_equal(a[k], b[k], path + "." + k, out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(path + ": طول فرق دارد")
        for i, (x, y) in enumerate(zip(a, b)):
            deep_equal(x, y, "%s[%d]" % (path, i), out)
    elif isinstance(a, bool) or isinstance(b, bool):
        if a is not b:
            out.append(path)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a != b:
            out.append(path)
    elif a != b or type(a) != type(b):
        out.append(path)
    return out


def summary(d):
    inv = {u: round(sum(v for v in m.values() if isinstance(v, (int, float))), 6) for u, m in (d.get("inventory") or {}).items()}
    return {
        "docs": len(d.get("docs") or []), "transactions": len(d.get("transactions") or []), "items": len(d.get("items") or []),
        "users": len(d.get("users") or []), "initialInventory": len(d.get("initialInventory") or []),
        "activityLog": len(d.get("activityLog") or []), "bomFormulas": len(d.get("bomFormulas") or {}),
        "pushSubscriptions": len(d.get("pushSubscriptions") or []), "stockCounts": len(d.get("stockCounts") or []),
        "sepidarDecisions": len(((d.get("sepidarInbox") or {}).get("decisions")) or {}),
        "seq": d.get("seq"), "inventoryTotals": inv,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--to", dest="dst", required=True)
    ap.add_argument("--replace", action="store_true")
    a = ap.parse_args()
    with open(a.src, "rb") as fh:
        raw_bytes = fh.read()
    src = json.loads(raw_bytes.decode("utf-8"))
    tmpdir = tempfile.mkdtemp(prefix="wh_migrate_")
    tmp_db = os.path.join(tmpdir, "production.sqlite3")
    st = Store(tmp_db)
    st.save(src)
    back = json.loads(Store(tmp_db).export_json())
    problems = deep_equal(src, back)
    s1, s2 = summary(src), summary(back)
    if s1 != s2:
        problems.append("خلاصه‌ها فرق دارند")
    print(json.dumps({"source": a.src, "bytes": len(raw_bytes), "summary": s1}, ensure_ascii=False, indent=1))
    if problems:
        print("❌ بررسی ناموفق:", problems[:20])
        sys.exit(1)
    os.makedirs(a.dst, exist_ok=True)
    final = os.path.join(a.dst, "production.sqlite3")
    if os.path.exists(final) and not a.replace:
        print("❌ در مقصد از قبل پایگاه داده هست (برای جایگزینی --replace)")
        sys.exit(1)
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(final + ext):
            os.unlink(final + ext)
    Store(tmp_db).export_json()  # checkpoint
    import sqlite3
    c = sqlite3.connect(tmp_db)
    c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    c.close()
    shutil.copy(tmp_db, final)
    again = json.loads(Store(final).export_json())
    if deep_equal(src, again):
        print("❌ بعد از کپی برابر نیست")
        sys.exit(1)
    Store(final).set_meta("imported_from", {"path": a.src, "bytes": len(raw_bytes)})
    shutil.rmtree(tmpdir, ignore_errors=True)
    print("✅ انتقال کامل و برابر بود:", final)


if __name__ == "__main__":
    main()
