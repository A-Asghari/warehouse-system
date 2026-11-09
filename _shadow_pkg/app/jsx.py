# -*- coding: utf-8 -*-
"""ابزارهای «رفتار مثل جاوااسکریپت».

این بخش جایگزینِ سرورِ Node.js فعلی (C:\\WarehouseSystem\\server.js) است و باید خروجیِ آن را بایت‌به‌بایت
تکرار کند (همان JSON، همان متن پیام‌ها، همان گرد کردن‌ها). هر جا JS و پایتون رفتار متفاوتی دارند
(truthiness، parseInt، Math.round، تبدیل عدد به متن، toLocaleString('fa-IR')، JSON.stringify و ...)
تابعی این‌جا هست که دقیقاً رفتار JS را تقلید می‌کند. همهٔ این‌ها با آزمونِ تفاضلی در برابر خودِ Node
سنجیده می‌شوند.
"""
import json
import math
import re
from datetime import datetime, timedelta, timezone

NaN = float("nan")


class _Undefined:
    """معادلِ undefined در JS: کلیدی که مقدارش این باشد در JSON نوشته نمی‌شود."""
    __slots__ = ()

    def __bool__(self):
        return False

    def __repr__(self):
        return "undefined"


UNDEF = _Undefined()


def truthy(v):
    if v is None or v is UNDEF or v is False:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return not (v == 0 or (isinstance(v, float) and math.isnan(v)))
    if isinstance(v, str):
        return v != ""
    return True  # آرایه و آبجکتِ خالی در JS درست‌اند


def js_or(*vals):
    for v in vals[:-1]:
        if truthy(v):
            return v
    return vals[-1]


def is_nan(v):
    return isinstance(v, float) and math.isnan(v)


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def to_str(v):
    """String(v) در JS."""
    if v is None:
        return "null"
    if v is UNDEF:
        return "undefined"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if is_number(v):
        return num_str(v)
    if isinstance(v, list):
        return ",".join("" if (x is None or x is UNDEF) else to_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def num_str(x):
    """Number.prototype.toString() در JS (کوتاه‌ترین نمایشِ رفت‌وبرگشتی، با قواعدِ نمایِ JS)."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    if x == int(x) and abs(x) < 2 ** 53:
        return str(int(x))
    r = repr(x)
    sign = ""
    if r[0] == "-":
        sign, r = "-", r[1:]
    if "e" in r:
        mant, exp = r.split("e")
        exp = int(exp)
    else:
        mant, exp = r, 0
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = (ip + fp).lstrip("0")
    # موقعیتِ نقطه نسبت به ابتدای digits
    lead_zeros = len(ip + fp) - len((ip + fp).lstrip("0"))
    point = len(ip) + exp - lead_zeros
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    es = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + digits + "e" + es
    return sign + digits[0] + "." + digits[1:] + "e" + es


_INT_PREFIX = re.compile(r"^[\s\u00a0\ufeff]*([+-]?\d+)")
_FLOAT_PREFIX = re.compile(r"^[\s\u00a0\ufeff]*([+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))")


def parse_int(v):
    s = to_str(v) if not isinstance(v, str) else v
    m = _INT_PREFIX.match(s)
    if not m:
        return NaN
    return int(m.group(1))


def parse_float(v):
    s = to_str(v) if not isinstance(v, str) else v
    m = _FLOAT_PREFIX.match(s)
    if not m:
        return NaN
    t = m.group(1)
    if "Infinity" in t:
        return -math.inf if t.startswith("-") else math.inf
    f = float(t)
    return int(f) if f == int(f) and abs(f) < 2 ** 53 and not re.search(r"[.eE]", t) else f


def to_number(v):
    """Number(v) در JS."""
    if v is None:
        return 0
    if v is UNDEF:
        return NaN
    if isinstance(v, bool):
        return 1 if v else 0
    if is_number(v):
        return v
    if isinstance(v, str):
        s = v.strip(" \t\n\r\v\f\u00a0\ufeff\u2028\u2029")
        if s == "":
            return 0
        if re.fullmatch(r"[+-]?Infinity", s):
            return -math.inf if s.startswith("-") else math.inf
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", s):
            return int(s, 16)
        if re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", s):
            f = float(s)
            if re.fullmatch(r"[+-]?\d+", s):
                return int(s)
            return f
        return NaN
    if isinstance(v, list):
        if len(v) == 0:
            return 0
        if len(v) == 1:
            return to_number(to_str(v[0]))
        return NaN
    return NaN


def is_finite(v):
    return is_number(v) and not math.isnan(v) and not math.isinf(v)


def _prim(v):
    if isinstance(v, list):
        return to_str(v)
    if isinstance(v, dict):
        return "[object Object]"
    return v


def add(a, b):
    """عملگرِ + در JS (عدد+عدد، و گرنه اگر یکی متن باشد، چسباندنِ متن)."""
    if is_number(a) and is_number(b):
        return a + b
    pa, pb = _prim(a), _prim(b)
    if isinstance(pa, str) or isinstance(pb, str):
        return to_str(pa) + to_str(pb)
    return to_number(pa) + to_number(pb)


def sub(a, b):
    if is_number(a) and is_number(b):
        return a - b
    return to_number(_prim(a)) - to_number(_prim(b))


def mul(a, b):
    if is_number(a) and is_number(b):
        return a * b
    return to_number(_prim(a)) * to_number(_prim(b))


def lt(a, b):
    """a < b در JS"""
    if is_number(a) and is_number(b):
        return a < b
    pa, pb = _prim(a), _prim(b)
    if isinstance(pa, str) and isinstance(pb, str):
        return pa.encode("utf-16-be") < pb.encode("utf-16-be")
    x, y = to_number(pa), to_number(pb)
    if is_nan(x) or is_nan(y):
        return False
    return x < y


def js_floor(x):
    if not is_finite(x):
        return x
    return math.floor(x)


def js_min(vals):
    out = math.inf
    for v in vals:
        v = to_number(v) if not is_number(v) else v
        if is_nan(v):
            return NaN
        if v < out:
            out = v
    return out


def js_round(x):
    """Math.round: نیمه همیشه رو به بالا."""
    if not is_finite(x):
        return x
    if isinstance(x, int) or x == math.floor(x):
        return x
    return float(math.floor(x + 0.5))


def num(x):
    """عدد را مثل JS نگه می‌دارد: اعشاریِ صحیح‌مقدار به int تبدیل می‌شود (فقط برای ظاهر؛ مقدار یکی است)."""
    if isinstance(x, float) and x.is_integer() and abs(x) < 2 ** 53:
        return int(x)
    return x


# ---------------- ترتیبِ کلیدهای آبجکت در JS ----------------
_IDX = re.compile(r"^(0|[1-9][0-9]*)$")


def _is_index(k):
    return isinstance(k, str) and _IDX.match(k) is not None and int(k) < 4294967295


def js_keys(d):
    """Object.keys: کلیدهای عددیِ «اندیس‌مانند» اول و صعودی، بعد بقیه به ترتیبِ درج."""
    idx = [k for k in d if _is_index(k)]
    if not idx:
        return list(d)
    idx.sort(key=int)
    return idx + [k for k in d if not _is_index(k)]


def js_items(d):
    return [(k, d[k]) for k in js_keys(d)]


def js_values(d):
    return [d[k] for k in js_keys(d)]


# ---------------- JSON.stringify ----------------
def _enc(o, out, indent, level):
    if o is None or (isinstance(o, float) and (math.isnan(o) or math.isinf(o))):
        out.append("null")
    elif o is True:
        out.append("true")
    elif o is False:
        out.append("false")
    elif isinstance(o, (int, float)):
        out.append(num_str(o))
    elif isinstance(o, str):
        out.append(json.dumps(o, ensure_ascii=False))
    elif isinstance(o, dict):
        items = [(k, o[k]) for k in js_keys(o) if o[k] is not UNDEF and not callable(o[k])]
        if not items:
            out.append("{}")
            return
        if indent:
            pad = "\n" + " " * (indent * (level + 1))
            out.append("{")
            for i, (k, v) in enumerate(items):
                out.append(("," if i else "") + pad + json.dumps(str(k), ensure_ascii=False) + ": ")
                _enc(v, out, indent, level + 1)
            out.append("\n" + " " * (indent * level) + "}")
        else:
            out.append("{")
            for i, (k, v) in enumerate(items):
                if i:
                    out.append(",")
                out.append(json.dumps(str(k), ensure_ascii=False) + ":")
                _enc(v, out, indent, level + 1)
            out.append("}")
    elif isinstance(o, (list, tuple)):
        if not o:
            out.append("[]")
            return
        if indent:
            pad = "\n" + " " * (indent * (level + 1))
            out.append("[")
            for i, v in enumerate(o):
                out.append(("," if i else "") + pad)
                _enc(None if v is UNDEF else v, out, indent, level + 1)
            out.append("\n" + " " * (indent * level) + "]")
        else:
            out.append("[")
            for i, v in enumerate(o):
                if i:
                    out.append(",")
                _enc(None if v is UNDEF else v, out, indent, level + 1)
            out.append("]")
    else:
        out.append(json.dumps(str(o), ensure_ascii=False))


def stringify_slow(o, indent=0):
    out = []
    _enc(o, out, indent, 0)
    return "".join(out)


class _NeedSlow(Exception):
    pass


def _reject(o):
    raise _NeedSlow()


# الگوهایی که نشان می‌دهند خروجیِ json.dumps با JSON.stringify فرق دارد:
#  ۱) عددِ اعشاریِ صحیح (5.0) یا نمادِ علمیِ پایتون (1e-07، 1e+16)
#  ۲) کلیدِ «اندیس‌مانند» (ترتیبِ کلیدها در JS متفاوت است)
_BAD_EXP = re.compile(r"[0-9]e[+-]")
_IDX_KEY = re.compile(r'[{,]"(?:0|[1-9][0-9]*)":')
_dumps = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=_reject).encode


def _fast(o):
    try:
        s = _dumps(o)
    except (_NeedSlow, ValueError, TypeError):
        return None
    if (".0," in s or ".0}" in s or ".0]" in s or s.endswith(".0") or "e+" in s and _BAD_EXP.search(s)
            or "e-" in s and _BAD_EXP.search(s) or _IDX_KEY.search(s)):
        return None
    return s


def _hybrid(o, out):
    s = _fast(o)
    if s is not None:
        out.append(s)
        return
    if isinstance(o, dict):
        items = [(k, o[k]) for k in js_keys(o) if o[k] is not UNDEF and not callable(o[k])]
        out.append("{")
        for i, (k, v) in enumerate(items):
            if i:
                out.append(",")
            out.append(json.dumps(str(k), ensure_ascii=False) + ":")
            _hybrid(v, out)
        out.append("}")
    elif isinstance(o, (list, tuple)):
        out.append("[")
        for i, v in enumerate(o):
            if i:
                out.append(",")
            _hybrid(None if v is UNDEF else v, out)
        out.append("]")
    else:
        _enc(o, out, 0, 0)


def stringify(o, indent=0):
    """JSON.stringify — مسیرِ سریع با json.dumps (کدِ C)؛ هر جا خروجی ممکن است با JS فرق کند، همان بخش با روشِ دقیق."""
    if indent:
        return stringify_slow(o, indent)
    out = []
    _hybrid(o, out)
    return "".join(out)


def loads(s):
    """JSON.parse: اعداد صحیح int و بقیه float."""
    return json.loads(s)


# ---------------- زمان ----------------
TEHRAN = timezone(timedelta(hours=3, minutes=30))  # ایران از ۱۴۰۱ ساعت تابستانی ندارد


def iso(ms):
    """Date.prototype.toISOString()"""
    dt = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=int(ms))
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)


def local_dt(ms):
    return datetime(1970, 1, 1, tzinfo=timezone.utc).astimezone(TEHRAN) + timedelta(milliseconds=int(ms))


_ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:\d{2})?)?$")


def date_parse(s):
    """Date.parse برای قالب‌های ISO (تنها قالب‌هایی که این سیستم استفاده می‌کند). NaN اگر نامعتبر."""
    if not isinstance(s, str):
        if is_number(s):
            return s
        return NaN
    m = _ISO_RE.match(s.strip())
    if not m:
        return NaN
    y, mo, d, hh, mi, ss, ms, tz = m.groups()
    try:
        base = datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0))
    except ValueError:
        return NaN
    msec = int((ms or "0").ljust(3, "0"))
    if hh is None:
        offset = timedelta(0)  # فقط تاریخ = UTC
    elif tz is None:
        offset = timedelta(hours=3, minutes=30)  # تاریخ-ساعت بدون منطقه = وقتِ محلیِ سرور
    elif tz == "Z":
        offset = timedelta(0)
    else:
        sign = 1 if tz[0] == "+" else -1
        offset = sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[4:6]))
    epoch = datetime(1970, 1, 1)
    return int(((base - offset) - epoch).total_seconds() * 1000) + msec


# ---------------- تقویم شمسی ----------------
def _div(a, b):
    return int(a / b)


def g2j(gy, gm, gd):
    """میلادی → شمسی (الگوریتم jalaali-js، معادلِ تقویم رسمی برای این بازه)."""
    def jal_cal(jy):
        breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178]
        bl = len(breaks)
        gy_ = jy + 621
        leapJ = -14
        jp = breaks[0]
        jump = 0
        for i in range(1, bl):
            jm = breaks[i]
            jump = jm - jp
            if jy < jm:
                break
            leapJ = leapJ + _div(jump, 33) * 8 + _div(jump % 33, 4)
            jp = jm
        n = jy - jp
        leapJ = leapJ + _div(n, 33) * 8 + _div((n % 33) + 3, 4)
        if (jump % 33) == 4 and jump - n == 4:
            leapJ += 1
        leapG = _div(gy_, 4) - _div((_div(gy_, 100) + 1) * 3, 4) - 150
        march = 20 + leapJ - leapG
        if jump - n < 6:
            n = n - jump + _div(jump + 4, 33) * 33
        leap = (((n + 1) % 33) - 1) % 4
        if leap == -1:
            leap = 4
        return leap, gy_, march

    def g2d(gy, gm, gd):
        d = _div((gy + _div(gm - 8, 6) + 100100) * 1461, 4) + _div(153 * ((gm + 9) % 12) + 2, 5) + gd - 34840408
        d = d - _div(_div(gy + 100100 + _div(gm - 8, 6), 100) * 3, 4) + 752
        return d

    def d2g(jdn):
        j = 4 * jdn + 139361631
        j = j + _div(_div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908
        i = _div(j % 1461, 4) * 5 + 308
        gd = _div(i % 153, 5) + 1
        gm = (_div(i, 153) % 12) + 1
        gy = _div(j, 1461) - 100100 + _div(8 - gm, 6)
        return gy, gm, gd

    jdn = g2d(gy, gm, gd)
    jy = gy - 621
    leap, _, march = jal_cal(jy)
    jdn1f = g2d(gy, 3, march)
    k = jdn - jdn1f
    if k >= 0:
        if k <= 185:
            return jy, 1 + _div(k, 31), (k % 31) + 1
        k -= 186
    else:
        jy -= 1
        k += 179
        if leap == 1:
            k += 1
    return jy, 7 + _div(k, 30), (k % 30) + 1


def jalali_parts(ms):
    """{y, m, d} امروزِ تهران برای لحظهٔ ms (مثل Intl با calendar=persian و timeZone=Asia/Tehran)."""
    dt = local_dt(ms)
    return g2j(dt.year, dt.month, dt.day)


FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹"


def fa_digits(s):
    return re.sub(r"\d", lambda m: FA_DIGITS[int(m.group(0))], str(s))


def fa_date(ms):
    """new Date(ms).toLocaleDateString('fa-IR') — مثل «۱۴۰۵/۷/۲۰»."""
    y, m, d = jalali_parts(ms)
    return fa_digits("%d/%d/%d" % (y, m, d))


def fa_number(x):
    """Number.prototype.toLocaleString('fa-IR')"""
    if x is None:
        return fa_digits("0")
    if not is_number(x):
        x = to_number(x)
    if math.isnan(x):
        return "ناعدد"
    if math.isinf(x):
        return ("‎−" if x < 0 else "") + "∞"
    neg = x < 0
    a = abs(x)
    # maximumFractionDigits=3 با گرد کردنِ halfExpand روی نمایشِ دهدهیِ عدد
    from decimal import Decimal, ROUND_HALF_UP, localcontext
    with localcontext() as ctx:
        ctx.prec = 500
        dec = Decimal(repr(float(a))) if isinstance(a, float) else Decimal(a)
        dec = dec.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
    s = format(dec, "f")
    ip, _, fp = s.partition(".")
    fp = fp.rstrip("0")
    groups = []
    while len(ip) > 3:
        groups.insert(0, ip[-3:])
        ip = ip[:-3]
    groups.insert(0, ip)
    out = "٬".join(groups)
    if fp:
        out += "٫" + fp
    out = fa_digits(out)
    if neg:
        out = "‎−" + out
    return out
