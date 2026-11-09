# -*- coding: utf-8 -*-
"""دوقلوی پایتونیِ harness/fake_sepidar_router.js — فقط برای آزمون. هر دو باید عیناً یک جواب بدهند."""
import json
import os
import re

from jsx import date_parse, iso


def _num(rx, s):
    m = re.search(rx, s)
    return int(m.group(1)) if m else None


def route(sql_text, params, fx):
    s = re.sub(r"\s+", " ", sql_text)
    if re.match(r"^\s*SELECT 1\s*$", s):
        return [{"": 1}]
    if "FROM WKO.[vwFormulaBomItem]" in s:
        return [{"BomCode": r.get("BomCode"), "ProductCode": r.get("ProductCode"), "ProductName": r.get("ProductName"),
                 "MatCode": r.get("MatCode"), "MatName": r.get("MatName"), "Unit": r.get("Unit"), "Qty": r.get("Qty")}
                for r in fx.get("bom") or []]
    if re.search(r"FROM INV\.vwItem WHERE IsActive = 1", s):
        return [{"Code": r.get("Code"), "Title": r.get("Title"), "CodingGroupTitle": r.get("CodingGroupTitle")} for r in fx.get("items") or []]
    if "SELECT MAX(FiscalYearRef) AS fy" in s:
        refs = [int(x) for x in re.search(r"StockRef IN \(([^)]*)\)", s).group(1).split(",")]
        ys = [r["FiscalYearRef"] for r in fx.get("stock") or [] if r["Quantity"] != 0 and r["StockRef"] in refs]
        return [{"fy": max(ys) if ys else None}]
    if "GROUP BY FiscalYearRef" in s:
        refs = [int(x) for x in re.search(r"StockRef IN \(([^)]*)\)", s).group(1).split(",")]
        by = {}
        for r in fx.get("stock") or []:
            if r["StockRef"] not in refs:
                continue
            b = by.setdefault(r["FiscalYearRef"], {"ref": r["FiscalYearRef"], "rows_": 0, "nonzero": 0})
            b["rows_"] += 1
            if r["Quantity"] != 0:
                b["nonzero"] += 1
        return sorted(by.values(), key=lambda b: -b["ref"])
    if "StockTitle = 'انبار توليد - مواد اوليه'" in s:
        fy = _num(r"FiscalYearRef = (\d+)", s)
        rows = [r for r in fx.get("stock") or [] if r["StockTitle"] == "انبار توليد - مواد اوليه" and r["FiscalYearRef"] == fy and r["Quantity"] != 0]
        rows.sort(key=lambda r: r["ItemCode"])
        return [{"ItemCode": r.get("ItemCode"), "ItemTitle_En": r.get("ItemTitle_En"), "UnitTitle": r.get("UnitTitle"), "Quantity": r.get("Quantity")} for r in rows]
    if re.search(r"GROUP BY ItemCode HAVING SUM\(Quantity\) <> 0", s):
        ref, fy = _num(r"StockRef = (\d+)", s), _num(r"FiscalYearRef = (\d+)", s)
        by = {}
        for r in fx.get("stock") or []:
            if r["StockRef"] == ref and r["FiscalYearRef"] == fy:
                b = by.get(r["ItemCode"]) or {"ItemCode": r["ItemCode"], "ItemTitle": r.get("ItemTitle"), "UnitTitle": r.get("UnitTitle"), "Quantity": 0}
                b["Quantity"] += r["Quantity"]
                by[r["ItemCode"]] = b
        return [b for b in by.values() if b["Quantity"] != 0]
    fam = "issue" if "FROM INV.vwInventoryDelivery " in s else ("receipt" if "FROM INV.vwInventoryReceipt " in s else None)
    if fam:
        lst = fx.get("deliveries" if fam == "issue" else "receipts") or []
        idk = "InventoryDeliveryID" if fam == "issue" else "InventoryReceiptID"
        m = re.search(r"ID IN \(([^)]*)\)", s)
        ids = [int(x) for x in m.group(1).split(",")] if m else None
        frm = date_parse(params["from"]) if params.get("from") else None
        out = []
        sel = [d for d in lst if d["StockRef"] == 6 and (d[idk] in ids if ids is not None else date_parse(d["Date"]) >= frm)]
        sel.sort(key=lambda d: -d[idk])
        for d in sel:
            for it in sorted(d["items"], key=lambda a: a["RowNumber"]):
                row = {"id": d[idk], "Number": d.get("Number"), "Date": iso(date_parse(d["Date"])), "Type": d.get("Type")}
                if fam == "issue":
                    row.update({"DestinationStockRef": d.get("DestinationStockRef"), "DestinationStockTitle": d.get("DestinationStockTitle"), "DLTitle": d.get("DLTitle")})
                else:
                    row.update({"PurchaseType": d.get("PurchaseType"), "IsOpening": d.get("IsOpening"),
                                "BaseInventoryDeliveryStockRef": d.get("BaseInventoryDeliveryStockRef"),
                                "BaseInventoryDeliveryStockTitle": d.get("BaseInventoryDeliveryStockTitle"), "DelivererTitle": d.get("DelivererTitle")})
                row.update({"Description": d.get("Description"), "FiscalYearRef": d.get("FiscalYearRef"), "RowNumber": it.get("RowNumber"),
                            "ItemCode": it.get("ItemCode"), "ItemTitle": it.get("ItemTitle"), "UnitTitle": it.get("UnitTitle"), "Quantity": it.get("Quantity")})
                out.append(row)
        return out
    raise Exception("fake sepidar: unrouted query: " + s[:120])


class FakePool:
    def __init__(self, fixture_path, log_path):
        self.fixture_path = fixture_path
        self.log_path = log_path

    def query(self, sql_text, params=None):
        params = params or {}
        if self.log_path:
            with open(self.log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"sql": re.sub(r"\s+", " ", sql_text).strip(), "params": params}, ensure_ascii=False) + "\n")
        with open(self.fixture_path, encoding="utf-8") as fh:
            fx = json.load(fh)
        if fx.get("down"):
            raise Exception("Failed to connect: fake sepidar is down")
        return route(sql_text, params, fx)

    def close(self):
        pass


class FakeSepidar:
    def __init__(self, fixture_path=None, log_path=None):
        self.fixture_path = fixture_path or os.environ.get("FAKE_SEPIDAR")
        self.log_path = log_path if log_path is not None else os.environ.get("SQL_LOG")

    def connect(self, cfg):
        return FakePool(self.fixture_path, self.log_path)
