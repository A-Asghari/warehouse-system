# -*- coding: utf-8 -*-
"""خواندنِ اولین برگهٔ یک فایل xlsx، معادلِ XLSX.utils.sheet_to_json(sheet, {defval: ''}) در SheetJS.

فقط برای «آپلود اکسلِ BOM» (مسیرِ قدیمی؛ مسیرِ اصلی سینکِ مستقیم از سپیدار است). بدون وابستگی بیرونی.
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}


def _col(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref)
    c = 0
    for ch in m.group(1):
        c = c * 26 + (ord(ch) - 64)
    return c - 1, int(m.group(2)) - 1


def _text(el):
    return "".join(t.text or "" for t in el.iter("{%s}t" % NS["m"]))


def _num(s):
    f = float(s)
    return int(f) if f.is_integer() and abs(f) < 2 ** 53 else f


def _fmt(v):
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        from jsx import num_str
        return num_str(v)
    return str(v)


def sheet_to_json(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    first = wb.find("m:sheets/m:sheet", NS)
    rid = first.get("{%s}id" % NS["r"])
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = next(r.get("Target") for r in rels.findall("pr:Relationship", NS) if r.get("Id") == rid)
    path = target.lstrip("/") if target.startswith("/") else "xl/" + target
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        shared = [_text(si) for si in sst.findall("m:si", NS)]
    sh = ET.fromstring(z.read(path))
    cells = {}
    maxc = maxr = -1
    minc = minr = None
    for c in sh.iter("{%s}c" % NS["m"]):
        ref = c.get("r")
        col, row = _col(ref)
        t = c.get("t", "n")
        v = c.find("m:v", NS)
        if t == "inlineStr":
            val = _text(c.find("m:is", NS)) if c.find("m:is", NS) is not None else ""
        elif v is None:
            continue
        elif t == "s":
            val = shared[int(v.text)]
        elif t in ("str", "e"):
            val = v.text or ""
        elif t == "b":
            val = v.text == "1"
        else:
            val = _num(v.text)
        cells[(row, col)] = val
    dim = sh.find("m:dimension", NS)
    if dim is not None and ":" in (dim.get("ref") or ""):
        a, b = dim.get("ref").split(":")
        minc, minr = _col(a)
        maxc, maxr = _col(b)
    elif cells:
        minr = min(r for r, _ in cells)
        maxr = max(r for r, _ in cells)
        minc = min(c for _, c in cells)
        maxc = max(c for _, c in cells)
    else:
        return []
    headers = []
    seen = {}
    for c in range(minc, maxc + 1):
        v = cells.get((minr, c))
        h = _fmt(v) if v is not None else "__EMPTY"
        base = h
        if h in seen:
            seen[base] += 1
            h = base + "_" + str(seen[base])
            while h in seen:
                seen[base] += 1
                h = base + "_" + str(seen[base])
        seen.setdefault(h, 0)
        headers.append(h)
    out = []
    for r in range(minr + 1, maxr + 1):
        if not any((r, c) in cells for c in range(minc, maxc + 1)):
            continue
        row = {}
        for i, c in enumerate(range(minc, maxc + 1)):
            row[headers[i]] = cells.get((r, c), "")
        out.append(row)
    return out
