const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const multer = require('multer');
const XLSX = require('xlsx');
const http = require('http');
const https = require('https');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
// ثبتِ handlerِ هر مسیر برای استفاده‌ی داخلی (اقدامِ گروهیِ /api/doc/batch همان handlerها را یکی‌یکی صدا می‌زند)
const ROUTE_HANDLERS = {};
['post', 'delete'].forEach(m => {
  const orig = app[m].bind(app);
  app[m] = (path, ...hs) => { if (typeof path === 'string' && hs.length) ROUTE_HANDLERS[m + ' ' + path] = hs[hs.length - 1]; return orig(path, ...hs); };
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================
// ورود و نشست در سرور (۱۴۰۵/۰۷/۲۷)
// ============================================
// قبلاً ورود در مرورگر انجام می‌شد (فهرستِ کاربران با رمزهای ساده از /api/data می‌آمد) و سرور نامِ کاربری را که
// مرورگر در actorUsername/createdBy می‌فرستاد بی‌بررسی می‌پذیرفت. حالا:
//  - رمزها فقط به‌صورتِ هش (scrypt) ذخیره می‌شوند (passwordHash) و هرگز به مرورگر فرستاده نمی‌شوند.
//  - POST /api/auth/login یک توکن می‌دهد؛ همه‌ی مسیرهای /api جز چند مسیرِ عمومی توکن می‌خواهند
//    (هدر Authorization: Bearer … یا ?token= برای لینکِ دانلود).
//  - کاربرِ توکن جای actorUsername / createdBy ِ ارسالیِ مرورگر می‌نشیند؛ پس بررسیِ نقش‌ها واقعی است.
//  - نشست‌ها در sessions.json (کنارِ db.json) می‌مانند تا ری‌استارتِ سرویس همه را بیرون نیندازد.
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; } catch (e) { sessions = {}; }
let sessionsDirty = false;
function persistSessions() {
  if (!sessionsDirty) return;
  sessionsDirty = false;
  try { fs.writeFileSync(SESSIONS_FILE + '.tmp', JSON.stringify(sessions)); fs.renameSync(SESSIONS_FILE + '.tmp', SESSIONS_FILE); } catch (e) { console.error('ذخیره‌ی نشست‌ها:', e.message); }
}
setInterval(persistSessions, 15000).unref();
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `s1$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPassword(user, pw) {
  if (!user) return false;
  if (user.passwordHash) {
    const [v, salt, h] = String(user.passwordHash).split('$');
    if (v !== 's1' || !salt || !h) return false;
    const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pw), salt, 32);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return user.password !== undefined && String(user.password) === String(pw); // پیش از مهاجرت
}
function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { username, created: Date.now(), lastSeen: Date.now() };
  sessionsDirty = true; persistSessions();
  return token;
}
function sessionOf(token) {
  const s = token && sessions[token];
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) { delete sessions[token]; sessionsDirty = true; return null; }
  if (Date.now() - s.lastSeen > 60000) { s.lastSeen = Date.now(); sessionsDirty = true; }
  return s;
}
function publicUser(u) { return u && { username: u.username, fullname: u.fullname, unit: u.unit, role: u.role }; }
const VIEWER_ALLOWED = new Set(['/api/auth/logout', '/api/activity/login', '/api/push/subscribe', '/api/push/unsubscribe', '/api/auth/change-password']);
const VIEWER_BLOCKED_GET = new Set(['/api/sync/sepidar', '/api/sync/sepidar-items']);
const loginFails = {};
const PUBLIC_API = new Set(['POST /api/auth/login', 'GET /api/sso-verify', 'GET /api/data-version', 'GET /api/push/vapid-public-key']);
app.use('/api', (req, res, next) => {
  const full = (req.originalUrl || req.url || '').split('?')[0];
  if (req.method === 'OPTIONS' || PUBLIC_API.has(req.method + ' ' + full)) return next();
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.query && req.query.token);
  const s = sessionOf(token);
  if (s) loadData();
  const u = s && users.find(x => x.username === s.username);
  if (!u) {
    if (s) { delete sessions[token]; sessionsDirty = true; }
    return res.status(401).json({ success: false, authRequired: true, error: 'نشست شما منقضی شده یا وارد نشده‌اید؛ دوباره وارد شوید' });
  }
  req.authUser = u; req.authToken = token;
  // هویتِ واقعی جای هر نامی که مرورگر فرستاده
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    req.body.actorUsername = u.username;
    if (Object.prototype.hasOwnProperty.call(req.body, 'createdBy')) req.body.createdBy = u.username;
    if (full === '/api/activity/login' || full === '/api/push/subscribe') req.body.username = u.username;
  }
  if (req.query) req.query.actorUsername = u.username;
  // نقشِ «مشاهده‌گر»: فقط خواندن. هر درخواستِ تغییر (و همگام‌سازی‌هایی که با GET داده را عوض می‌کنند) رد می‌شود.
  if (u.role === 'viewer' && ((req.method !== 'GET' && !VIEWER_ALLOWED.has(full)) || VIEWER_BLOCKED_GET.has(full))) {
    return res.status(403).json({ success: false, readOnly: true, error: 'این کاربر فقط دسترسیِ مشاهده دارد و نمی‌تواند سند ثبت یا تغییری بدهد' });
  }
  next();
});
// لغو / رد / حذفِ سند بدونِ دلیل پذیرفته نمی‌شود (حداقل ۳ حرف)؛ دلیل روی سند و در گزارش فعالیت می‌ماند
const REASON_ROUTES = [['POST', /^\/api\/doc\/\d+\/cancel$/], ['POST', /^\/api\/doc\/initial-group\/[^/]+\/cancel$/], ['DELETE', /^\/api\/doc\/\d+$/],
  ['POST', /^\/api\/doc\/(production|pending-adjustment|return)\/reject$/], ['POST', /^\/api\/doc\/output\/warehouse-reject$/]];
// تغییر روی سندِ موجود (تایید/رد/لغو/حذف/ویرایش/اقدامِ گروهی) در دوره‌ی بسته ممنوع است. «بازگشت به بخش قبلی» سندِ تازه با تاریخِ امروز می‌سازد و مجاز است.
app.use('/api/doc', (req, res, next) => {
  if (req.method === 'GET' || !closedThrough()) return next();
  const full = (req.originalUrl || req.url || '').split('?')[0];
  if (/\/output\/request-return$/.test(full)) return next();
  try {
    loadData();
    const ids = [];
    const b = req.body || {};
    if (b.docId) ids.push(Number(b.docId));
    if (Array.isArray(b.docIds)) b.docIds.forEach(x => ids.push(Number(x)));
    let m = full.match(/^\/api\/doc\/(\d+)(\/|$)/); if (m) ids.push(Number(m[1]));
    m = full.match(/^\/api\/doc\/initial\/(\d+)\/edit$/); if (m) ids.push(Number(m[1]));
    m = full.match(/^\/api\/doc\/initial-group\/([^/]+)\//);
    const affected = docs.filter(d => ids.includes(d.id) || (m && d.type === 'initial' && String(d.groupId) === m[1]));
    for (const d of affected) { const cp = closedProblem(d.date); if (cp) return res.status(403).json({ success: false, error: `سند ${d.docNo || d.id}: ${cp}` }); }
  } catch (e) { /* در صورتِ خطا، خودِ مسیر تصمیم می‌گیرد */ }
  next();
});
app.use('/api/doc', (req, res, next) => {
  const full = (req.originalUrl || req.url || '').split('?')[0];
  if (!REASON_ROUTES.some(([m, re]) => m === req.method && re.test(full))) return next();
  const reason = String((req.body && req.body.reason) || '').trim();
  if (reason.length < 3) return res.status(400).json({ success: false, error: 'دلیلِ لغو/رد/حذف را بنویسید (حداقل ۳ حرف)' });
  req.body.reason = reason.slice(0, 300);
  next();
});
// هشدارِ «عددِ غیرعادی» (مثلاً TPV ۱٬۶۵۲٬۳۵۹ کیلو به‌جای ۱٬۶۵۲): برای ثبت‌هایی که موجودی را «زیاد» می‌کنند، اگر مقدار
// خیلی بزرگ‌تر از هر چیزی باشد که تا حالا از آن کالا دیده شده، سرور 409 + needsConfirm برمی‌گرداند؛ مرورگر از کاربر
// تایید می‌گیرد و همان درخواست را با confirmLarge:true دوباره می‌فرستد. ثبت ممنوع نیست، فقط آگاهانه است.
function abnormalQtyWarning(item, qty) {
  qty = Number(qty) || 0;
  if (qty <= 1000) return null;
  const base = splitColor(item).base;
  let ref = 0;
  Object.values(inventory || {}).forEach(m => Object.entries(m || {}).forEach(([k, v]) => { if (splitColor(k).base === base) ref = Math.max(ref, Math.abs(v || 0)); }));
  docs.forEach(d => { if (d.status !== 'cancelled' && d.status !== 'rejected' && splitColor(d.item || '').base === base) ref = Math.max(ref, d.qty || 0); });
  const limit = ref > 0 ? ref * 10 : 100000;
  if (qty <= limit) return null;
  return `مقدارِ ${formatNumber(qty)} برای «${resolveItemName(item)}» غیرعادی است` + (ref > 0 ? ` (بیشترین مقدارِ دیده‌شده تا حالا ${formatNumber(ref)})` : '') + '. مطمئن هستید؟ (مثلاً واحد گرم/کیلو یا صفرِ اضافه را چک کنید)';
}
const QTY_CHECK_ROUTES = [/^\/api\/doc\/initial$/, /^\/api\/doc\/initial-batch$/, /^\/api\/doc\/initial-group\/[^/]+\/edit$/, /^\/api\/doc\/adjust$/, /^\/api\/doc\/production$/, /^\/api\/doc\/production-with-materials$/];
app.use('/api/doc', (req, res, next) => {
  const full = (req.originalUrl || req.url || '').split('?')[0];
  if (req.method !== 'POST' || !QTY_CHECK_ROUTES.some(re => re.test(full))) return next();
  const b = req.body || {};
  if (b.confirmLarge === true || (full.endsWith('/adjust') && b.type !== 'excess')) return next();
  try {
    loadData();
    const lines = Array.isArray(b.rows) ? b.rows : [{ item: b.item, qty: b.qty }];
    const warns = lines.map(r => r && r.item ? abnormalQtyWarning(r.item, r.qty) : null).filter(Boolean);
    if (warns.length) return res.status(409).json({ success: false, needsConfirm: true, error: warns.join('\n') });
  } catch (e) { /* هشدار هرگز ثبت را نمی‌شکند */ }
  next();
});
app.post('/api/auth/login', (req, res) => {
  try {
    loadData();
    // نام/رمز در هدرِ Authorization: Basic می‌آید (نه بدنه) و توکن در هدرِ X-Auth-Token برمی‌گردد (نه بدنه)؛ چون
    // «دوشاخه»ی دوره‌ی آزمایشی بدنه‌ی درخواست/پاسخ را برای مقایسه ذخیره می‌کند ولی هدرها را نه.
    let username = String((req.body && req.body.username) || '').trim(), password = String((req.body && req.body.password) || '');
    const ah = String(req.headers.authorization || '');
    if (ah.startsWith('Basic ')) {
      const dec = Buffer.from(ah.slice(6), 'base64').toString('utf8'); const i = dec.indexOf(':');
      if (i > 0) { username = dec.slice(0, i).trim(); password = dec.slice(i + 1); }
    }
    const f = loginFails[username] || { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ success: false, error: 'چند بار رمز اشتباه وارد شد؛ چند دقیقه‌ی دیگر دوباره امتحان کنید' });
    const u = users.find(x => x.username === username);
    if (!u || !verifyPassword(u, password)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; }
      loginFails[username] = f;
      return res.status(401).json({ success: false, error: 'نام کاربری یا رمز عبور اشتباه است' });
    }
    delete loginFails[username];
    res.setHeader('X-Auth-Token', newSession(u.username));
    res.json({ success: true, user: publicUser(u) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/auth/logout', (req, res) => {
  if (req.authToken) { delete sessions[req.authToken]; sessionsDirty = true; persistSessions(); }
  res.json({ success: true });
});
app.get('/api/auth/me', (req, res) => res.json({ success: true, user: publicUser(req.authUser) }));
// تغییرِ رمزِ خودِ کاربر
app.post('/api/auth/change-password', (req, res) => {
  try {
    loadData();
    const u = users.find(x => x.username === req.authUser.username);
    if (!verifyPassword(u, (req.body || {}).oldPassword)) return res.status(400).json({ success: false, error: 'رمز فعلی اشتباه است' });
    const np = String((req.body || {}).newPassword || '');
    if (np.length < 4) return res.status(400).json({ success: false, error: 'رمز جدید باید حداقل ۴ کاراکتر باشد' });
    u.passwordHash = hashPassword(np); delete u.password;
    saveData();
    logActivity(u.username, 'تغییر رمز عبور', '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// ورود خودکار (SSO) از سامانه «دستور پرداخت»
// ============================================
// این مقدار باید عیناً همان کلید مخفی باشد که در دستور پرداخت (تنظیمات سامانه ← کلید مشترک
// ورود خودکار) ثبت شده. وقتی کاربر از آنجا روی لینک این سامانه کلیک می‌کند، یک توکن کوتاه‌عمر
// (۶۰ ثانیه) امضاشده با همین کلید در آدرس (?dp_sso=...) می‌آید؛ اینجا فقط امضا و تاریخ انقضا
// را بررسی می‌کنیم و کاربر متناظر را (بدون افشای رمز عبور) برمی‌گردانیم — نگاه کنید به مسیر
// GET /api/sso-verify پایین‌تر و public/index.html::trySsoLogin(). اگر روزی این کلید در
// دستور پرداخت بازتولید شود، باید همین‌جا هم دستی به‌روزرسانی شود وگرنه ورود خودکار قطع می‌شود
// (لینک‌ها همچنان به‌صورت معمولی کار می‌کنند، فقط بدون ورود خودکار).
const DP_SSO_SECRET = 'ef5dde8dc03b2c4cab0382397d550e56186f5bf6b73fe480b5c66b002151bd57';

// ============================================
// تنظیمات اتصال به دیتابیس سپیدار
// ============================================
// این مقادیر پیش‌فرضِ اولیه‌ان - همون چیزی که قبلاً هاردکد بود؛ اگه بعداً از تب «⚙️ تنظیمات»
// چیزی ذخیره بشه، data.appSettings.sepidar جایگزینش می‌شه (رجوع به getSepidarConfig()).
const DEFAULT_SEPIDAR_CONFIG = {
  user: 'report',
  password: '61704',
  server: '192.168.0.12\\Sepidar',
  database: 'Sepidar01',
  encrypt: false,
  trustServerCertificate: true
};

function getSepidarConfig() {
  const cfg = (data && data.appSettings && data.appSettings.sepidar) || DEFAULT_SEPIDAR_CONFIG;
  return {
    user: cfg.user,
    password: cfg.password,
    server: cfg.server,
    database: cfg.database,
    options: {
      encrypt: !!cfg.encrypt,
      trustServerCertificate: !!cfg.trustServerCertificate
    },
    connectionTimeout: 30000,
    requestTimeout: 30000
  };
}

let sepidarPool = null;
let lastSepidarConfigJSON = null;
let autoBackupTimer = null;
let autoBackupStartupTimer = null; // باید بالاتر از اولین فراخوانیِ rearmAutoBackup() تعریف شود // زودتر از loadData()/rearmAutoBackup() در پایین فایل تعریف می‌شه تا هنگام صدازدنِ اولیه‌شون از حالت "قبل از initialization" خطا نده

const DEFAULT_BACKUP_SETTINGS = { folder: '', autoEnabled: false, autoIntervalHours: 24, keepCount: 30 };

// اتصال به Output Messenger (پیام‌رسانِ داخلیِ شرکت) - وقتی سند خروج بین بخش‌ها ثبت می‌شه،
// یه پیامِ متنی (نه عکس - API رسمیِ Send Notification هیچ پارامتری برای پیوستِ فایل/عکس
// نداره، فقط message متنی می‌گیره) به گروهِ هر بخش فرستاده می‌شه. deptGroups نگاشتِ
// dept id → اسمِ دقیقِ گروه/روم توی خودِ Output Messengerه (کاربر از تب تنظیمات پر می‌کنه).
const DEFAULT_OUTPUT_MESSENGER_CONFIG = {
  enabled: false,
  host: '192.168.0.3',
  port: 14125,
  apiKey: '1N6U8JKPWLHW2MWIA70APT0N4XBC8822',
  fromUser: '',
  deptGroups: {}
};

// جفت‌بخش‌هایی که انتقال (سند خروج) بینشون، علاوه بر تاییدِ فرستنده/گیرنده، نیاز به یه
// تاییدِ سومِ اجباری از نقشِ «انباردار» هم داره - قبل از تاییدِ گیرنده (ترتیب: فرستنده ثبت
// می‌کنه → انباردار تایید می‌کنه → گیرنده تایید می‌کنه → فقط همون‌جا موجودی جابه‌جا می‌شه).
// هر عضوِ آرایه یه کلیدِ نرمالایز‌شده‌ست: دو تا dept id به‌ترتیبِ الفبایی با | جدا شده، تا
// جهتِ انتقال (برش→لحیم یا لحیم→برش، مثلاً موقعِ برگشت) فرقی نکنه - هردو جهت این قانون رو دارن.
const DEFAULT_WAREHOUSE_GATE_CONFIG = { pairs: [] };

// تلرانسِ مقایسه‌ی مقدار (خطای ممیزِ شناورِ جمع/تفریق‌های اعشاری مثل متر/کیلو): موجودی تا این مقدار کمتر از نیاز هم کافی حساب می‌شه
const QTY_EPS = 0.001;

function warehouseGatePairKey(deptA, deptB) {
  return [deptA, deptB].sort().join('|');
}

// تاییدِ انباردار برای تولید: بخش‌هایی که تولیدشون تا تاییدِ انباردار توی موجودی نمی‌شینه
const DEFAULT_PRODUCTION_GATE_CONFIG = { depts: [] };
function isProductionGated(unit) {
  const cfg = (data && data.appSettings && data.appSettings.productionGate) || DEFAULT_PRODUCTION_GATE_CONFIG;
  return (cfg.depts || []).includes(unit);
}

function isDeptPairGated(deptA, deptB) {
  const cfg = (data && data.appSettings && data.appSettings.warehouseGate) || DEFAULT_WAREHOUSE_GATE_CONFIG;
  return (cfg.pairs || []).includes(warehouseGatePairKey(deptA, deptB));
}

function getOutputMessengerConfig() {
  return (data && data.appSettings && data.appSettings.outputMessenger) || DEFAULT_OUTPUT_MESSENGER_CONFIG;
}

// پیامِ متنی رو به یه روم/گروهِ مشخص می‌فرسته - fire-and-forget: هیچ‌وقت نباید جلوی ثبتِ
// خودِ سند رو بگیره، برای همین همه‌جا با Promise برمی‌گرده و خطاش رو فقط لاگ می‌کنه، throw نمی‌کنه.
function sendOutputMessengerNotification(room, message) {
  return new Promise((resolve) => {
    const cfg = getOutputMessengerConfig();
    if (!cfg.enabled || !cfg.host || !cfg.port || !cfg.apiKey || !room) {
      return resolve({ success: false, error: 'اتصال غیرفعاله یا نام گروه برای این بخش تنظیم نشده' });
    }
    const query = new URLSearchParams({ room, message, notify: '1' });
    if (cfg.fromUser) query.set('from', cfg.fromUser);
    const options = {
      hostname: cfg.host,
      port: cfg.port,
      path: `/api/notify?${query.toString()}`,
      method: 'POST',
      // طبق مستندات API: برای POST/PUT باید Content-Length:0 صریح فرستاده بشه، وگرنه
      // سرور Output Messenger خطای 411 Length Required می‌ده.
      headers: { 'API-KEY': cfg.apiKey, 'Content-Length': 0 },
      timeout: 5000
    };
    const httpReq = http.request(options, (httpRes) => {
      let body = '';
      httpRes.on('data', chunk => { body += chunk; });
      httpRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ success: !!parsed.success, raw: parsed });
        } catch (e) {
          resolve({ success: false, error: 'پاسخ نامعتبر از سرور Output Messenger' });
        }
      });
    });
    httpReq.on('timeout', () => { httpReq.destroy(); resolve({ success: false, error: 'اتصال به Output Messenger زمان‌گیر شد (timeout)' }); });
    httpReq.on('error', (err) => resolve({ success: false, error: err.message }));
    httpReq.end();
  });
}

// برای سندِ خروجِ ثبت‌شده، پیام رو هم به گروهِ بخشِ مبدأ هم به گروهِ بخشِ مقصد می‌فرسته (هرکدوم
// که توی تنظیمات گروه داشته باشن) - چون هم فرستنده هم گیرنده باید از این جابه‌جایی خبردار بشن.
async function notifyOutputMessengerForOutputDoc(doc) {
  try {
    const cfg = getOutputMessengerConfig();
    if (!cfg.enabled) return;
    const itemName = resolveItemName(doc.item);
    const message = [
      '📤 خروج بین خطوط تولید ثبت شد',
      '',
      `🔢 شماره سند: ${doc.id}`,
      `📅 تاریخ: ${doc.date}`,
      `🏭 از بخش: ${deptName(doc.fromUnit)}`,
      `🏭 به بخش: ${deptName(doc.toUnit)}`,
      '',
      `📦 کد کالا: ${doc.item}`,
      `📝 شرح: ${itemName}`,
      `🔢 مقدار: ${doc.qty}`,
      doc.batchNumber ? `🔖 بچ: ${doc.batchNumber}` : null,
      doc.note ? `📝 توضیح: ${doc.note}` : null
    ].filter(Boolean).join('\n');

    const fromRoom = cfg.deptGroups && cfg.deptGroups[doc.fromUnit];
    const toRoom = cfg.deptGroups && cfg.deptGroups[doc.toUnit];
    const rooms = [...new Set([fromRoom, toRoom].filter(Boolean))];
    for (const room of rooms) {
      const result = await sendOutputMessengerNotification(room, message);
      if (!result.success) {
        console.error(`⚠️ ارسال پیامِ Output Messenger به گروه «${room}» برای سند ${doc.id} ناموفق بود:`, result.error);
      }
    }
  } catch (err) {
    console.error('⚠️ خطا در notifyOutputMessengerForOutputDoc:', err.message);
  }
}

// ============================================
// نوتیفیکیشن واقعیِ گوشی (Web Push) - برخلاف Output Messenger که به یه گروهِ چت بیرونی
// وصل می‌شه، این مستقیم به مرورگر/PWAِ خودِ کاربرانی که موبایل رو نصب و اجازه داده‌ن پوش
// می‌فرسته (حتی وقتی اپ بسته‌ست). کلیدهای VAPID یه‌بار تولید و توی db.json ذخیره می‌شن
// (ensurePushKeys، موقع بالا اومدنِ سرور) تا بینِ ری‌استارت‌ها ثابت بمونن - عوض شدنشون یعنی
// همه‌ی اشتراک‌های قبلی باطل می‌شن و کاربرها باید دوباره فعالش کنن.
const PUSH_SUBJECT_DEFAULT = 'mailto:ahmad.asghari@live.com';
function ensurePushKeys() {
  if (appSettings.push && appSettings.push.publicKey && appSettings.push.privateKey) {
    // آدرس نمونهٔ example.com را سرویس اعلان اپل رد می‌کند؛ مثل سامانه داخلی با آدرس واقعی جایگزین شود.
    // (کلیدها دست نمی‌خورند، پس اشتراک‌های فعلی معتبر می‌مانند.)
    if (!appSettings.push.subject || /example\.com/i.test(appSettings.push.subject)) {
      appSettings.push.subject = PUSH_SUBJECT_DEFAULT;
      saveData();
    }
    return;
  }
  const keys = webpush.generateVAPIDKeys();
  appSettings.push = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: PUSH_SUBJECT_DEFAULT };
  saveData();
  console.log('🔑 کلیدهای VAPID برای Web Push تولید شد');
}

// هر اشتراک می‌داند از کدام نسخه ثبت شده (desktop = نسخهٔ اصلی /، mobile = اپ /mobile/)؛ لینکِ
// اعلان به همان نسخه برود. اشتراک‌های قدیمی بدون platform همه از اپ موبایل بوده‌اند.
function pushUrlForPlatform(url, platform) {
  const u = url || '/';
  if (platform === 'desktop') return u.indexOf('/mobile') === 0 ? '/' : u;
  return u.indexOf('/mobile') === 0 ? u : '/mobile/';
}

function usersInDeptId(deptId) {
  const d = DEPTS.find(x => x.id === deptId);
  if (!d) return [];
  return users.filter(u => u.unit === d.name).map(u => u.username);
}

function usersWithRoles(roles) {
  return users.filter(u => roles.includes(u.role)).map(u => u.username);
}

// فرستادنِ واقعیِ پوش - اشتراکِ منقضی/لغوشده (404/410 از سرویسِ پوشِ مرورگر) رو خودکار از
// لیست پاک می‌کنه؛ fire-and-forget مثل notifyOutputMessengerForOutputDoc - هیچ‌وقت نباید جلوی
// ثبتِ خودِ سند رو بگیره یا throw کنه بیرون از خودش.
async function sendPushToUsernames(usernames, payload) {
  if (batchTx) { batchTx.pushes.push([usernames, payload]); return; } // داخلِ عملیاتِ گروهی: بعد از ثبتِ نهایی فرستاده می‌شود
  try {
    if (!usernames || usernames.length === 0) return;
    const cfg = appSettings.push;
    if (!cfg || !cfg.publicKey || !cfg.privateKey) return;
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
    const targets = pushSubscriptions.filter(s => usernames.includes(s.username));
    if (targets.length === 0) return;
    let changed = false;
    for (const sub of targets) {
      try {
        const payloadStr = JSON.stringify({ ...payload, url: pushUrlForPlatform(payload.url, sub.platform) });
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payloadStr, { TTL: 86400, urgency: 'high' });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
          changed = true;
        } else {
          console.error('⚠️ ارسال Web Push ناموفق:', err.message);
        }
      }
    }
    if (changed) { data.pushSubscriptions = pushSubscriptions; writeDB(data); }
  } catch (err) {
    console.error('⚠️ خطا در sendPushToUsernames:', err.message);
  }
}

// section idهای مجاز برای هر نقش (به‌جز admin که همیشه به همه‌چیز دسترسی داره و توی این
// نگاشت نیست) - دقیقاً همون چیزی که کاربر برای هر نقش توضیح داد؛ user = همون چیزی که امروز
// هر غیرادمینی می‌بینه.
// «مجوز» (نه section): اجازه‌ی تایید/ردِ سندهای ضایعات/کسری/اضافاتِ در انتظار. مثل sectionها داخلِ
// آرایه‌ی rolePermissions هر نقش نگه‌داری می‌شه و از همون ماتریسِ دسترسیِ تنظیمات قابل‌تنظیمه.
// مدیر همیشه دارتش (نیازی به تیک نداره).
const PERM_APPROVE_ADJUSTMENTS = 'perm-approve-adjustments';
const DEFAULT_ROLE_PERMISSIONS = {
  supervisor: ['sec-dashboard', 'sec-daily-report', 'sec-cardex', 'sec-summary',
               'sec-production', 'sec-consume', 'sec-output', 'sec-waste', 'sec-adjust',
               'sec-documents', 'sec-history', PERM_APPROVE_ADJUSTMENTS],
  warehouse: ['sec-dashboard', 'sec-cardex', 'sec-summary', 'sec-initial-inv',
              'sec-adjust', 'sec-output', 'sec-documents', 'sec-history'],
  user: ['sec-dashboard', 'sec-daily-report', 'sec-cardex', 'sec-summary', 'sec-production',
         'sec-consume', 'sec-output', 'sec-waste', 'sec-adjust', 'sec-documents', 'sec-history'],
  // مشاهده‌گر: همه‌ی گزارش‌ها و اسناد، بدونِ هیچ فرمِ ثبت (سرور هم هر تغییری را رد می‌کند)
  viewer: ['sec-home', 'sec-dashboard', 'sec-daily-report', 'sec-cardex', 'sec-summary', 'sec-documents', 'sec-history',
           'sec-forecast', 'sec-finished-in', 'sec-dispatch', 'sec-stock-check', 'sec-sepidar-inbox', 'sec-stock-count']
};
const VIEWER_SECTIONS_OK = new Set(['sec-home', 'sec-dashboard', 'sec-daily-report', 'sec-cardex', 'sec-summary', 'sec-documents', 'sec-history', 'sec-forecast', 'sec-finished-in', 'sec-dispatch', 'sec-stock-check', 'sec-sepidar-inbox', 'sec-stock-count']);

async function connectToSepidar() {
  try {
    const currentConfig = getSepidarConfig();
    const currentConfigJSON = JSON.stringify(currentConfig);
    // اگه تنظیمات از دفعه‌ی قبل عوض شده (مثلاً همین الان از تب تنظیمات ذخیره شده)، پولِ
    // کش‌شده دیگه معتبر نیست - باید با تنظیمات جدید از نو وصل بشیم.
    if (sepidarPool && currentConfigJSON !== lastSepidarConfigJSON) {
      sepidarPool = null;
    }
    if (sepidarPool) {
      try {
        await sepidarPool.request().query('SELECT 1');
        return sepidarPool;
      } catch(e) {
        sepidarPool = null;
      }
    }
    sepidarPool = await sql.connect(currentConfig);
    lastSepidarConfigJSON = currentConfigJSON;
    console.log('✅ اتصال به دیتابیس سپیدار برقرار شد');
    return sepidarPool;
  } catch (err) {
    console.error('❌ خطا در اتصال به دیتابیس سپیدار:', err.message);
    return null;
  }
}

async function getInventoryFromSepidar(fiscalYear) {
  try {
    const pool = await connectToSepidar();
    if (!pool) {
      return { success: false, error: 'اتصال به سپیدار برقرار نشد', data: [] };
    }
    const year = fiscalYear || 13;
    const query = `
      SELECT 
        ItemCode,
        ItemTitle_En,
        UnitTitle,
        Quantity
      FROM INV.vwItemStockSummary
      WHERE StockTitle = 'انبار توليد - مواد اوليه'
        AND FiscalYearRef = ${year}
        AND Quantity != 0
      ORDER BY ItemCode
    `;
    const result = await pool.request().query(query);
    return { 
      success: true, 
      data: result.recordset, 
      count: result.recordset.length,
      fiscalYear: year
    };
  } catch (err) {
    console.error('❌ خطا در دریافت داده از سپیدار:', err.message);
    return { success: false, error: err.message, data: [] };
  }
}

async function getItemsFromSepidar() {
  try {
    const pool = await connectToSepidar();
    if (!pool) {
      return { success: false, error: 'اتصال به سپیدار برقرار نشد', data: [] };
    }
    const query = `
      SELECT 
        Code,
        Title,
        CodingGroupTitle
      FROM INV.vwItem
      WHERE IsActive = 1
      ORDER BY Code
    `;
    const result = await pool.request().query(query);
    return { 
      success: true, 
      data: result.recordset, 
      count: result.recordset.length 
    };
  } catch (err) {
    console.error('❌ خطا در دریافت کالاها از سپیدار:', err.message);
    return { success: false, error: err.message, data: [] };
  }
}

// وقتی سینک با سپیدار متوجه می‌شه اسم یه کالا (با همون کد) عوض شده، باید موجودی/تراکنش‌ها/
// اسناد قبلی که زیر اسم قدیمی ثبت شدن رو به اسم جدید منتقل کنیم - وگرنه چون همه‌جای سیستم
// موجودی رو بر اساس «نام» کلید می‌زنه نه «کد»، موجودیِ قدیمی زیر اسم قدیم یتیم می‌مونه و
// انگار دو تا کالای جدا با موجودی/گردش جدا می‌شن، درحالی‌که واقعیت یه کالای واحده.
// موجودی/تراکنش/سند دیگه کلیدشون اسم نیست، کدِ کالاست (کد واقعی سپیدار از items[] وقتی
// وجود داره، وگرنه کدِ خودِ productDefinitions همون بخش - مثلاً CUT-.../LASER-.../Pack-...
// یا کدِ فرمول برای لحیم/تزریقی که کد کاتالوگ جدا ندارن). این دو تابع تنها جایی هستن که
// این قانون رو پیاده می‌کنن؛ همه‌جای دیگه فقط با «کد» به‌عنوان یه کلید مبهم کار می‌کنه.
// ============================================
// قانونِ هویتِ کالا در مراحلِ تولید (کدِ موجودی) — جزئیات در CLAUDE.md بخش «Item identity»
// ============================================
// کدِ موجودیِ هر محصولِ مرحله‌ای همیشه خودِ productDefinition.code است (هرگز productCode):
//   برش:       CUT-{کد ماده}-{طول سانت}            (بدون تغییر)
//   لحیم:      SOL-{کد سپیدار}                      نام: «{نام سپیدار} (لحیم‌شده)»
//   تزریق:     INJ-{کد سپیدار}                      نام: «{نام سپیدار} (تزریق‌شده)»
//   لیزر:      LASER-{کد سپیدار}-{برند}             نام: «{نام سپیدار} - {برند}»
//   بسته‌بندی: PACK-{کد سپیدار}-{برند}-{نوع پک}     نام: «{نام سپیدار} - {برند} - {نوع پک}»
// productCode = کدِ سپیدار (فقط برای نمایش و مقایسه با سپیدار). اگر یک کالای سپیدار چند فرمولِ فعال
// داشته باشد (مثلاً کابل داخلی/وارداتی) همه یک کد دارند؛ فرمول موقع تولید انتخاب و روی سند (formulaKey) ثبت می‌شود.
const STAGE_CODE_PREFIX = { solder: 'SOL-', inject: 'INJ-' };
const STAGE_NAME_SUFFIX = { solder: ' (لحیم‌شده)', inject: ' (تزریق‌شده)' };

function codeSlug(s) {
  return normalizeFa(String(s || '')).replace(/^پک\s+/, '').replace(/\s+/g, '_').replace(/-/g, '_');
}
function laserCode(pc, brand) { return `LASER-${pc}-${codeSlug(brand)}`; }

// ===== پکِ سفارشی به تفکیکِ برند و نوعِ کابل (۱۴۰۵/۰۸) =====
// در سپیدار «پک سفارشی» (003000184) یک کد است، ولی در عمل هر پک مالِ یک برند و یک نوع کابل است
// (مثلاً «پک FAONE-VS-600 TC 2m»). موجودیِ سیستم به تفکیک نگه داشته می‌شود: کلید = «003000184~FAONE~VS_600_TC_2m».
// - کدِ سپیدار همان 003000184 است (sepidarCodeOfKey) و در مقایسه با سپیدار جمعِ همه‌ی نسخه‌ها حساب می‌شود.
// - برند از فهرستِ «برند/نوع پک» تنظیمات؛ نوعِ کابل از فرمول‌هایی که این پک را مصرف می‌کنند (مدل از نامِ فرمول،
//   سوکت از موادِ مرحله‌ی لحیم، طول از کابلِ برش) - همان قاعده‌ی فایلِ اکسلِ تزریق.
// - ورودِ این کد از سپیدار (تایید سند) و موجودیِ اول دوره باید تفکیک شود؛ بسته‌بندی از نسخه‌ی همان برند و نوع کابل مصرف می‌کند.
const PACK_VARIANT_BASES = ['003000184'];
const PV_SEP = '~';
function isPackVariantBase(code) { return typeof code === 'string' && PACK_VARIANT_BASES.includes(code); }
function packVariantName(brand, cable) { return `پک ${brand}-${cable}`; }
function packVariantKey(base, brand, cable) { return base + PV_SEP + codeSlug(brand) + PV_SEP + codeSlug(cable); }
// نوعِ کابلِ یک فرمول: «VS-600 TC 25cm» (یا null اگر از فرمول درنمی‌آید)
function cableTypeOfFormula(f) {
  if (!f || !Array.isArray(f.materials)) return null;
  const cut = f.materials.find(m => m.stage === 'cut');
  if (!cut) return null;
  const sol = f.materials.filter(m => m.stage === 'solder').map(m => normalizeFa(m.name || '')).join(' ');
  const has = t => sol.includes(normalizeFa(t));
  const conn = /PD/i.test(sol) ? 'PD' : has('لايتينگ') || has('لایتینگ') ? 'IP' : /V8/i.test(sol) ? 'V8' : sol.includes('C.C') ? 'CC' : has('سوكت TC') || has('سوکت TC') || has('شيائومي') || has('شیائومی') ? 'TC' : null;
  if (!conn) return null;
  const nm = normalizeFa(f.name || '');
  const mm = nm.match(/VS-?\s?(\d+)/i);
  let model = mm ? 'VS-' + mm[1] : null;
  if (!model) { const kw = [['IP7 FOX', 'IP7 FOX'], ['IPXS', 'IPXS MAX'], ['S10', 'S10'], ['S22', 'S22']].find(([k]) => nm.includes(k)); model = kw ? kw[1] : null; }
  if (!model) return null;
  const q = Number(cut.qty) || 0;
  return `${model} ${conn} ${q < 0.5 ? '25cm' : q < 1.5 ? '1m' : '2m'}`;
}
let _pvCableCache = { ref: null, map: {} };
function packCableTypes(base) {
  if (_pvCableCache.ref !== bomFormulas) _pvCableCache = { ref: bomFormulas, map: {} };
  if (_pvCableCache.map[base]) return _pvCableCache.map[base];
  const set = new Set();
  Object.values(bomFormulas || {}).forEach(f => { if ((f.materials || []).some(m => m.code === base)) { const c = cableTypeOfFormula(f); if (c) set.add(c); } });
  const LEN = { '25cm': 0, '1m': 1, '2m': 2 }, CON = ['V8', 'TC', 'CC', 'IP', 'PD'];
  const list = [...set].sort((a, b) => {
    const [ma, ca, la] = a.split(' '), [mb, cb, lb] = b.split(' ');
    return ma.localeCompare(mb, 'en', { numeric: true }) || CON.indexOf(ca) - CON.indexOf(cb) || (LEN[la] || 0) - (LEN[lb] || 0);
  });
  _pvCableCache.map[base] = list;
  return list;
}
// اطلاعاتِ یک کلیدِ نسخه‌دار (یا null): اول از فهرستِ ثبت‌شده، بعد از روی فهرستِ برندها و نوع‌های کابل
function parsePackVariant(key) {
  if (typeof key !== 'string' || !key.includes(PV_SEP)) return null;
  const b = splitColor(key).base;
  const m = b.match(/^([^~]+)~([^~]+)~([^~]+)$/);
  if (!m || !isPackVariantBase(m[1])) return null;
  const reg = ((appSettings && appSettings.packVariants) || {})[b];
  if (reg) return { key: b, base: reg.base, brand: reg.brand, cable: reg.cable, name: reg.name };
  const brand = packBrandList().find(x => codeSlug(x) === m[2]);
  const cable = packCableTypes(m[1]).find(x => codeSlug(x) === m[3]);
  if (!brand || !cable) return null;
  return { key: b, base: m[1], brand, cable, name: packVariantName(brand, cable) };
}
// موجودیِ یک ماده‌ی فرمول در یک بخش؛ برای پکِ سفارشی = جمعِ نسخه‌های همان نوعِ کابل (هر برندی) + کدِ کلی
function pvStockForFormula(inv, code, f) {
  if (!isPackVariantBase(code)) return inv[code] || 0;
  const cable = cableTypeOfFormula(f);
  let t = inv[code] || 0;
  Object.keys(inv).forEach(k => { const v = k.includes(PV_SEP) ? parsePackVariant(k) : null; if (v && v.base === code && (!cable || v.cable === cable)) t += inv[k] || 0; });
  return t;
}
// بسته‌بندی: پکِ سفارشیِ مصرفی باید همان «برند پک» و همان نوعِ کابلِ محصول باشد
function packVariantProblem(unit, item, mats, formulaKey) {
  if (unit !== 'pack' || !Array.isArray(mats)) return null;
  const pm = mats.filter(m => m && (isPackVariantBase(m.item) || (typeof m.item === 'string' && m.item.includes(PV_SEP))));
  if (!pm.length) return null;
  const b = splitColor(item).base;
  const def = (productDefinitions.pack || []).find(p => p.code === b) || virtualStageDef('pack', b);
  const fks = def ? formulaKeysOfDef(def) : [];
  const f = formulaKey ? getFormula(formulaKey) : (fks.length === 1 ? getFormula(fks[0]) : null);
  const cable = cableTypeOfFormula(f), pb = def && (def.packType || def.brand);
  for (const m of pm) {
    const base = pvBase(m.item);
    const exp = cable && pb ? parsePackVariant(packVariantKey(base, pb, cable)) : null;
    if (exp && m.item !== exp.key) return `پکِ مصرفی برای این محصول باید «${exp.name}» باشد، نه «${resolveItemName(m.item)}»`;
  }
  return null;
}
function pvBase(key) { const v = parsePackVariant(key); return v ? v.base : key; }
function registerPackVariant(key) {
  const v = parsePackVariant(key);
  if (!v) return null;
  if (!appSettings.packVariants) appSettings.packVariants = {};
  if (!appSettings.packVariants[v.key]) appSettings.packVariants[v.key] = { base: v.base, brand: v.brand, cable: v.cable, name: v.name };
  return v;
}
// هر کلیدِ نسخه‌داری که در موجودی/سندها آمده در فهرست ثبت می‌شود تا نامش با حذفِ برند یا فرمول گم نشود
function registerPackVariantsInUse() {
  if (!appSettings) return;
  Object.values(inventory || {}).forEach(m => Object.keys(m || {}).forEach(k => { if (k.includes(PV_SEP)) registerPackVariant(k); }));
}
// تفکیکِ ورودی: [{brand, cable, qty} یا {key, qty}] → [{key, qty, name}] یا {error}
function resolvePackSplits(base, splits, total) {
  if (!Array.isArray(splits) || !splits.length) return { error: `«${resolveItemName(base)}» باید به تفکیکِ برند و نوع کابل وارد شود (لیستِ تفکیک خالی است)` };
  const out = new Map();
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i] || {};
    const key = s.key || (s.brand && s.cable ? packVariantKey(base, s.brand, s.cable) : null);
    const v = key ? parsePackVariant(key) : null;
    if (!v || v.base !== base) return { error: `ردیفِ ${i + 1} تفکیک: برند یا نوعِ کابل نامعتبر است` };
    const q = Number(s.qty);
    if (!Number.isFinite(q) || q <= 0) return { error: `ردیفِ ${i + 1} تفکیک (${v.name}): تعداد نامعتبر است` };
    out.set(v.key, Math.round(((out.get(v.key) || 0) + q) * 1e6) / 1e6);
  }
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  if (total != null && Math.abs(sum - total) > 1e-6) return { error: `جمعِ تفکیکِ «${resolveItemName(base)}» (${formatNumber(Math.round(sum * 1e6) / 1e6)}) با تعدادِ کل (${formatNumber(total)}) برابر نیست` };
  return { parts: [...out.entries()].map(([key, qty]) => ({ key, qty, name: parsePackVariant(key).name })) };
}
function packCode(pc, brand, packType) { return `PACK-${pc}-${codeSlug(brand)}-${codeSlug(packType)}`; }

// ===== محصولاتِ «غیرفعال در سپیدار» =====
// اگر فرمولی در سپیدار غیرفعال/حذف شود، سینکِ بعدی آن را از bomFormulas برمی‌دارد. محصولِ مرحله‌ای‌اش اگر هنوز
// موجودی یا سندِ باز دارد پاک نمی‌شود: با inactive:true می‌ماند تا باقی‌مانده تا آخرِ خط ارسال/تولید شود، و
// خودِ فرمول (برای پیشنهادِ مواد) در appSettings.archivedFormulas بایگانی می‌شود. وقتی موجودی تمام شد، سینکِ
// بعدی تعریف و فرمولِ بایگانی را پاک می‌کند. اگر فرمول دوباره فعال شود، همه‌چیز عادی می‌شود.
function getFormula(fk) {
  return bomFormulas[fk] || ((appSettings && appSettings.archivedFormulas) || {})[fk] || null;
}
// جایگزینیِ کلِ فرمول‌ها (سینک/آپلود): فرمول‌های حذف‌شده‌ای که محصولی به آن‌ها اشاره دارد بایگانی می‌شوند
function replaceBomFormulas(newBom) {
  const arch = appSettings.archivedFormulas = appSettings.archivedFormulas || {};
  const referenced = new Set();
  Object.values(productDefinitions || {}).forEach(l => (l || []).forEach(p => (p.formulaKeys || []).forEach(k => referenced.add(k))));
  Object.keys(bomFormulas || {}).forEach(k => { if (!newBom[k] && referenced.has(k)) arch[k] = { ...bomFormulas[k], archivedAt: new Date().toISOString() }; });
  Object.keys(newBom).forEach(k => { delete arch[k]; });
  bomFormulas = newBom;
}
const OPEN_DOC_STATUSES = ['pending', 'pending_warehouse', 'pending_production', 'pending_approval', 'return_pending'];
function stageCodeInUse(code) {
  const hit = k => splitColor(k).base === code;
  if (Object.values(inventory || {}).some(m => Object.entries(m || {}).some(([k, v]) => hit(k) && Math.abs(v || 0) > 1e-9))) return true;
  return docs.some(d => OPEN_DOC_STATUSES.includes(d.status) && hit(d.item));
}

// فرمول‌های فعالِ یک کدِ سپیدار (مرتب بر اساس کلیدِ فرمول)
function formulaKeysOfProductCode(pc) {
  return Object.keys(bomFormulas).filter(k => bomFormulas[k].productCode === pc)
    .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0) || String(a).localeCompare(String(b)));
}
// نامِ پایه‌ی کالا نزدِ سپیدار: اول کاتالوگ کالاها، وگرنه کوتاه‌ترین نامِ فرمول (معمولاً نسخه‌ی بدونِ «وارداتي»)
function sepidarBaseName(pc, formulaKeys) {
  const it = items.find(i => i.code === pc);
  if (it && it.name) return it.name;
  const names = (formulaKeys || []).map(k => getFormula(k) && getFormula(k).name).filter(Boolean);
  if (!names.length) return pc;
  return names.slice().sort((a, b) => a.length - b.length)[0].trim();
}
// همه‌ی فرمول‌های قابل‌استفاده برای یک تعریف محصول (سازگار با تعریف‌های قدیمیِ تک‌فرمولی)
function formulaKeysOfDef(prod) {
  if (!prod) return [];
  if (Array.isArray(prod.formulaKeys) && prod.formulaKeys.length) return prod.formulaKeys.filter(k => getFormula(k));
  const k = prod.baseFormulaCode || prod.formulaKey || prod.code;
  return getFormula(k) ? [k] : [];
}
// فرمول‌های ممکنِ یک کالای مرحله‌ای (SOL/INJ/LASER/PACK، با یا بدونِ رنگ) - برای «نوعِ کابل» در موجودی اول و لات‌ها
function stageFormulaKeys(code) {
  const base = splitColor(String(code || '')).base;
  if (!/^(SOL|INJ|LASER|PACK)-/.test(base)) return [];
  const f = findDefByCode(base);
  let prod = f && f.prod;
  if (!prod) { const m = base.match(/^(LASER|PACK)-/); if (m) prod = virtualStageDef(m[1] === 'LASER' ? 'laser' : 'pack', base); }
  return formulaKeysOfDef(prod);
}
function findDefByCode(code) {
  for (const dept of Object.keys(productDefinitions || {})) {
    const prod = (productDefinitions[dept] || []).find(p => p.code === code);
    if (prod) return { dept, prod };
  }
  // کدِ رنگی (مثلاً CUT-333000001-97@مشکی): تعریفِ پایه + رنگ
  const sc = splitColor(code);
  if (sc.colorSlug) {
    const color = colorBySlug(sc.colorSlug);
    const f = color && findDefByCode(sc.base);
    if (f) return { dept: f.dept, prod: colorizeDef(f.prod, color) };
  }
  return null;
}
// ===== رنگِ کابل =====
// رنگ فقط در برش انتخاب می‌شود و بعد از آن با کالا به لحیم، تزریق، لیزر، بسته‌بندی و انبار محصول می‌رود.
// موجودیِ هر رنگ جداست: کلیدِ موجودیِ رنگی = کدِ معمولی + «@» + رنگ (CUT-…-97@مشکی، SOL-…@طوسی،
// PACK-…-A2-سفارشی@مشکی). «سفید» رنگِ پیش‌فرض است و پسوند ندارد، پس همه‌ی کدهای قبلی یعنی سفید.
// تعریفِ محصولِ رنگی ذخیره نمی‌شود؛ از تعریفِ پایه ساخته می‌شود (colorizeDef) تا بازسازیِ BOM چیزی پاک نکند.
const DEFAULT_COLOR = 'سفید';
const DEFAULT_COLORS = ['سفید', 'مشکی', 'طوسی'];
const COLOR_SEP = '@';
function colorList() {
  const l = ((appSettings && appSettings.colors) || DEFAULT_COLORS).filter(Boolean);
  return [DEFAULT_COLOR, ...l.filter(c => c !== DEFAULT_COLOR)];
}
function splitColor(code) {
  const s = String(code == null ? '' : code);
  const i = s.indexOf(COLOR_SEP);
  return i < 0 ? { base: s, colorSlug: null } : { base: s.slice(0, i), colorSlug: s.slice(i + 1) };
}
function colorBySlug(slug) { return colorList().find(c => codeSlug(c) === slug) || null; }
function isStageKey(code) { return /^(CUT|SOL|INJ|LASER|PACK)-/.test(String(code || '')); }
// رنگِ یک کلیدِ موجودی (برای کالاهای مرحله‌ای؛ مواد خام رنگ ندارند → null)
function colorOfKey(code) {
  if (!isStageKey(code)) return null;
  const sc = splitColor(code);
  return sc.colorSlug ? (colorBySlug(sc.colorSlug) || sc.colorSlug) : DEFAULT_COLOR;
}
function withColor(code, color) {
  const base = splitColor(code).base;
  return !color || color === DEFAULT_COLOR ? base : base + COLOR_SEP + codeSlug(color);
}
function colorizeDef(prod, color) {
  if (!color || color === DEFAULT_COLOR) return prod;
  return { ...prod, code: withColor(prod.code, color), name: `${prod.name} - ${color}`, color };
}
// ===== برند (لیزر) و نوعِ پک (بسته‌بندی) هنگامِ تولید انتخاب می‌شوند =====
// محصولاتِ لیزر/بسته‌بندی دیگر از قبل برای همه‌ی کالاها تعریف نمی‌شوند: فهرستِ برندها و نوع‌پک‌ها در
// appSettings است و تعریفِ محصول («LASER-{کد}-{برند}» / «PACK-{کد}-{برند}-{نوع پک}») اولین بار که تولید
// می‌شود خودکار ساخته می‌شود (materializeStageDef). تا آن لحظه، همان کد «مجازی» است (virtualStageDef).
function brandList() { return ((appSettings && appSettings.brands) || []).filter(Boolean); }
function packTypeList() { return ((appSettings && appSettings.packTypes) || []).filter(Boolean); }
// «برندِ پک» در بسته‌بندی: پیش‌فرض همان برندِ لیزر است و در صورتِ استثنا برندِ دیگری از فهرستِ برندها.
// (نوع‌پک‌های قدیمیِ appSettings.packTypes هم برای سازگاری پذیرفته می‌شوند.) کد: PACK-{کد}-{برند لیزر}-{برند پک}
function packBrandList() {
  const seen = new Set(); return brandList().concat(packTypeList()).filter(x => { const k = codeSlug(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
function packName(base, brand, packBrand) {
  return codeSlug(brand) === codeSlug(packBrand) ? `${base} - ${brand}` : `${base} - ${brand} (پک ${packBrand})`;
}
function virtualStageDef(dept, code) {
  if (typeof code !== 'string') return null;
  if (dept === 'laser') {
    const m = code.match(/^LASER-([^-]+)-(.+)$/);
    if (!m) return null;
    const pc = m[1];
    const brand = brandList().find(b => codeSlug(b) === m[2]);
    const base = (productDefinitions.inject || []).find(p => p.productCode === pc);
    if (!brand || !base) return null;
    return { code: laserCode(pc, brand), productCode: pc, sepidarName: base.sepidarName, brand, name: `${base.sepidarName} - ${brand}`,
      formulaKeys: (base.formulaKeys || []).slice(), baseFormulaCode: (base.formulaKeys || [])[0] || null, group: 'laser', unit: 'عدد' };
  }
  if (dept === 'pack') {
    const m = code.match(/^PACK-([^-]+)-([^-]+)-(.+)$/);
    if (!m) return null;
    const pc = m[1];
    const brand = brandList().find(b => codeSlug(b) === m[2]);
    const packType = packBrandList().find(t => codeSlug(t) === m[3]);
    const base = (productDefinitions.inject || []).find(p => p.productCode === pc);
    if (!brand || !packType || !base) return null;
    return { code: packCode(pc, brand, packType), productCode: pc, sepidarName: base.sepidarName, brand, packType,
      name: packName(base.sepidarName, brand, packType), formulaKeys: (base.formulaKeys || []).slice(),
      baseFormulaCode: (base.formulaKeys || [])[0] || null, group: 'pack', unit: 'عدد' };
  }
  return null;
}
function stageDefFor(dept, code) {
  const sc = splitColor(code);
  if (sc.colorSlug) {
    const color = colorBySlug(sc.colorSlug);
    const base = color && stageDefFor(dept, sc.base);
    return base ? colorizeDef(base, color) : null;
  }
  return (productDefinitions[dept] || []).find(p => p.code === code) || virtualStageDef(dept, code);
}
// تعریفِ مجازی را (فقط برای لیزر/بسته‌بندی) واقعاً اضافه می‌کند؛ قبل از اعتبارسنجیِ سندِ تولید صدا زده می‌شود
function materializeStageDef(dept, code) {
  if (dept !== 'laser' && dept !== 'pack') return null;
  code = splitColor(code).base; // تعریف فقط برای کدِ پایه ذخیره می‌شود؛ رنگ روی آن سوار است
  if ((productDefinitions[dept] || []).some(p => p.code === code)) return null;
  const v = virtualStageDef(dept, code);
  if (!v) return null;
  if (!productDefinitions[dept]) productDefinitions[dept] = [];
  v.created = new Date().toISOString();
  productDefinitions[dept].push(v);
  return v;
}

// موجودی اول دوره / اضافات برای محصولِ لیزر/بسته‌بندی‌ای که هنوز تولید نشده: تعریفش همین‌جا ساخته می‌شود
function materializeForStock(code) {
  const b = splitColor(code).base;
  if (/^LASER-/.test(b)) materializeStageDef('laser', b);
  else if (/^PACK-/.test(b)) materializeStageDef('pack', b);
}

// کدِ سپیدار برای یک کلیدِ موجودی (برای جمع‌زدن و مقایسه با سپیدار)
function sepidarCodeOfKey(key) {
  const pv = parsePackVariant(key);
  if (pv) return pv.base;
  const f = findDefByCode(key);
  return (f && f.prod.productCode) || splitColor(key).base;
}

function resolveItemCode(deptId, itemName) {
  // محصولِ تعریف‌شده‌ی همین بخش مقدم است و کدِ موجودی‌اش همیشه خودِ code است (نه productCode)
  const prod = (productDefinitions[deptId] || []).find(p => p.name === itemName);
  if (prod) return prod.code;
  const catalogItem = items.find(i => i.name === itemName);
  return catalogItem ? catalogItem.code : null;
}

function resolveItemName(code) {
  const catalogItem = items.find(i => i.code === code);
  if (catalogItem) return catalogItem.name;
  const pv = parsePackVariant(code);
  if (pv) return pv.name;
  const f = findDefByCode(code);
  if (f) return f.prod.name;
  for (const dept of Object.keys(productDefinitions)) {
    const prod = (productDefinitions[dept] || []).find(p => p.productCode === code);
    if (prod) return prod.sepidarName || prod.name;
  }
  return code; // چیزی پیدا نشد - به‌جای کرش، خودِ کد رو نشون بده
}

function migrateItemRename(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  DEPTS.forEach(d => {
    if (!inventory[d.id]) return;
    if (inventory[d.id][oldName] !== undefined) {
      inventory[d.id][newName] = (inventory[d.id][newName] || 0) + inventory[d.id][oldName];
      delete inventory[d.id][oldName];
    }
  });
  transactions.forEach(t => { if (t.item === oldName) t.item = newName; });
  docs.forEach(d => { if (d.item === oldName) d.item = newName; });
  initialInventory.forEach(t => { if (t.item === oldName) t.item = newName; });
}

// تبدیل تاریخ شمسیِ «۱۴۰۵/۷/۸» به میلادی (فقط برای مهرِ زمانیِ اسنادِ قدیمی)
function jalaliStrToIso(str) {
  const p = String(str || '').replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).split('/').map(x => parseInt(x, 10));
  if (p.length !== 3 || p.some(isNaN)) return null;
  let [jy, jm, jd] = p; jy -= 979; jm -= 1; jd -= 1;
  const jdm = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  let jdn = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4);
  for (let i = 0; i < jm; i++) jdn += jdm[i];
  jdn += jd;
  let gdn = jdn + 79, gy = 1600 + 400 * Math.floor(gdn / 146097);
  gdn %= 146097;
  let leap = true;
  if (gdn >= 36525) { gdn--; gy += 100 * Math.floor(gdn / 36524); gdn %= 36524; if (gdn >= 365) gdn++; else leap = false; }
  gy += 4 * Math.floor(gdn / 1461); gdn %= 1461;
  if (gdn >= 366) { leap = false; gdn--; gy += Math.floor(gdn / 365); gdn %= 365; }
  const gdm = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0; while (gdn >= gdm[gm]) { gdn -= gdm[gm]; gm++; }
  return new Date(Date.UTC(gy, gm, gdn + 1)).toISOString();
}

// برای یک ردیفِ initialInventory سند (approved) و تراکنشِ initial می‌سازد یا مقدارش را هم‌گام می‌کند.
// موجودی را عوض نمی‌کند (موجودی قبلاً جای دیگر اعمال شده)؛ فقط ردپا (چه کسی، چه زمانی) و امکان لغو/پیگیری.
function ensureInitialDoc(row, { actor, source, note, createdAt, approxTime } = {}) {
  let doc = row.docId ? docs.find(d => d.id === row.docId) : null;
  if (doc && doc.status === 'cancelled') doc = null;
  if (doc) {
    if (doc.qty !== row.qty) {
      doc.qty = row.qty;
      const tx = doc.transactionId ? transactions.find(t => t.id === doc.transactionId) : null;
      if (tx) tx.qty = row.qty;
      doc.updatedAt = new Date().toISOString(); doc.updatedBy = actor || 'سیستم';
    }
    return doc;
  }
  const tx = { id: seqId++, date: row.date, type: 'initial', unit: row.unit, item: row.item, qty: row.qty, note: 'موجودی اول دوره', targetUnit: '', fiscalYear: row.fiscalYear };
  transactions.push(tx);
  doc = {
    id: docSeq++, date: row.date, type: 'initial', unit: row.unit, item: row.item, qty: row.qty, fromUnit: '', toUnit: '',
    note: note || 'موجودی اول دوره', status: 'approved', fiscalYear: row.fiscalYear, createdBy: actor || 'سیستم',
    createdAt: createdAt || new Date().toISOString(), transactionId: tx.id, parentDocId: null, source: source || 'manual'
  };
  if (approxTime) doc.createdAtApprox = true;
  docs.push(doc);
  row.docId = doc.id; row.createdBy = doc.createdBy; row.createdAt = doc.createdAt;
  return doc;
}

async function syncFromSepidar(fiscalYear, actorName) {
  console.log(`🔄 شروع همگام‌سازی موجودی با سپیدار (سال مالی: ${fiscalYear || 13})...`);
  
  loadData();
  
  const result = await getInventoryFromSepidar(fiscalYear);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (result.data.length === 0) {
    return { success: true, message: 'هیچ داده‌ای برای همگام‌سازی وجود ندارد', added: 0, updated: 0, total: 0 };
  }
  let addedItems = 0;
  let updatedItems = 0;
  let processedItems = 0;
  const rawDept = 'raw';
  for (const row of result.data) {
    processedItems++;
    const code = row.ItemCode?.toString().trim() || '';
    const name = row.ItemTitle_En?.toString().trim() || '';
    const unit = row.UnitTitle?.toString().trim() || 'عدد';
    const quantity = parseFloat(row.Quantity) || 0;
    if (!code || !name) continue;
    let existingItem = items.find(i => i.code === code);
    if (existingItem) {
      if (existingItem.name !== name) migrateItemRename(existingItem.name, name);
      existingItem.name = name;
      existingItem.unit = unit;
      updatedItems++;
    } else {
      items.push({
        code: code,
        name: name,
        unit: unit,
        groupCode: '---',
        groupName: 'مواد اولیه'
      });
      addedItems++;
      DEPTS.forEach(d => {
        if (!inventory[d.id]) inventory[d.id] = {};
        if (!inventory[d.id][code]) inventory[d.id][code] = 0;
      });
    }
    // موجودی هم مثل همه‌جای دیگه‌ی سیستم با کد کلید می‌خوره، نه اسم - وگرنه این تابع
    // (تنها منبع واقعیِ موجودیِ انبار مواد اولیه) دقیقاً همون شکافِ نام/کد رو دوباره باز می‌کنه.
    // پکِ سفارشیِ تفکیک‌شده: موجودی به تفکیکِ برند/نوع کابل در سیستم است و با عددِ کلیِ سپیدار بازنویسی نمی‌شود
    if (isPackVariantBase(code) && Object.keys(inventory[rawDept] || {}).some(k => k.startsWith(code + PV_SEP))) continue;
    const currentQty = inventory[rawDept]?.[code] || 0;
    if (currentQty !== quantity) {
      if (!inventory[rawDept]) inventory[rawDept] = {};
      inventory[rawDept][code] = quantity;

      // انبار مواد اولیه هیچ‌وقت از طریق سند «موجودی اول دوره»/تولید پر نمی‌شه - تنها
      // منبعش همین همگام‌سازیه. بدون این، کاردکس/گزارش کل چون initialInventory چیزی
      // براش ندارن، «موجودی اول دوره» رو صفر نشون می‌دن در حالی که inventory واقعی پره.
      // یک ردیفِ واحد به‌ازای هر کالا نگه می‌داریم (نه یه ردیف تازه با هر سینک) - چون
      // renderCardex/renderSummary همه‌ی ردیف‌های initialInventory رو برای این کالا/بخش
      // با هم جمع می‌زنن؛ اگه هر سینک یه ردیف جدید اضافه می‌کرد، عدد گزارش‌ها با هر بار
      // سینک به‌طور غلط بزرگ‌تر می‌شد.
      let initEntry = initialInventory.find(t => t.unit === rawDept && t.item === code);
      if (initEntry) {
        initEntry.qty = quantity;
        initEntry.date = todayJalali();
      } else {
        initEntry = {
          unit: rawDept,
          item: code,
          qty: quantity,
          date: todayJalali(),
          fiscalYear: activeFiscalYear
        };
        initialInventory.push(initEntry);
      }
      ensureInitialDoc(initEntry, { actor: actorName, source: 'sepidar-sync', note: 'موجودی اول دوره (دریافت از سپیدار)' });
    }
  }
  saveData();
  logActivity(actorName || 'سیستم', 'دریافت موجودی از سپیدار', `${processedItems} کالا پردازش شد (${addedItems} جدید)، سال مالی سپیدار: ${result.fiscalYear}`);
  console.log(`✅ همگام‌سازی موجودی کامل شد: ${addedItems} کالا جدید، ${updatedItems} کالا به‌روزرسانی شد`);
  return { 
    success: true, 
    added: addedItems, 
    updated: updatedItems,
    total: processedItems,
    fiscalYear: result.fiscalYear,
    message: `${processedItems} کالا پردازش شد (${addedItems} جدید، ${updatedItems} به‌روزرسانی)`
  };
}

async function syncItemsFromSepidar() {
  console.log('🔄 شروع همگام‌سازی کالاها از سپیدار...');
  const result = await getItemsFromSepidar();
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (result.data.length === 0) {
    return { success: true, message: 'هیچ کالایی برای همگام‌سازی وجود ندارد', added: 0, updated: 0, total: 0 };
  }
  let addedItems = 0;
  let updatedItems = 0;
  let processedItems = 0;
  for (const row of result.data) {
    processedItems++;
    const code = row.Code?.toString().trim() || '';
    const name = row.Title?.toString().trim() || '';
    const groupName = row.CodingGroupTitle?.toString().trim() || 'مواد اولیه';
    if (!code || !name) continue;
    let existingItem = items.find(i => i.code === code);
    if (existingItem) {
      if (existingItem.name !== name) migrateItemRename(existingItem.name, name);
      existingItem.name = name;
      existingItem.groupName = groupName;
      updatedItems++;
    } else {
      items.push({
        code: code,
        name: name,
        unit: 'عدد',
        groupCode: '---',
        groupName: groupName
      });
      addedItems++;
      DEPTS.forEach(d => {
        if (!inventory[d.id]) inventory[d.id] = {};
        if (!inventory[d.id][code]) inventory[d.id][code] = 0;
      });
    }
  }
  saveData();
  console.log(`✅ همگام‌سازی کالاها کامل شد: ${addedItems} کالا جدید، ${updatedItems} کالا به‌روزرسانی شد`);
  return { 
    success: true, 
    added: addedItems, 
    updated: updatedItems,
    total: processedItems,
    message: `${processedItems} کالا پردازش شد (${addedItems} جدید، ${updatedItems} به‌روزرسانی)`
  };
}

// ============================================
// دیتابیس اصلی سیستم
// ============================================
const DB_PATH = path.join(__dirname, 'db.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('❌ فایل db.json خراب است:', e.message);
    // نسخه‌ی خراب برای بررسیِ بعدی کنار گذاشته می‌شه (تا با دادهٔ پیش‌فرض بازنویسی نشه)
    try { fs.copyFileSync(DB_PATH, DB_PATH + '.corrupt-' + Date.now()); } catch (e2) {}
    try {
      const prev = JSON.parse(fs.readFileSync(DB_PATH + '.prev', 'utf8'));
      console.error('⚠️ از آخرین نسخه‌ی سالم (db.json.prev) بازیابی شد');
      return prev;
    } catch (e3) {
      console.error('❌ نسخه‌ی قبلیِ سالم هم پیدا نشد');
      // به‌جای شروعِ کار با داده‌ی خالی (که با اولین ذخیره db.json رو پاک می‌کرد)، سرور متوقف می‌شه
      throw new Error('db.json خراب است و نسخه‌ی سالمِ قبلی پیدا نشد؛ برای جلوگیری از بازنویسی با داده‌ی خالی سرور متوقف شد (نسخه‌ی خراب: db.json.corrupt-*)');
    }
  }
  return null;
}

// نوشتنِ اتمیک: اول در فایل موقت (با fsync) و بعد rename روی فایل اصلی، تا قطعِ برق/کرش وسطِ نوشتن
// هیچ‌وقت db.json نصفه نگذاره. هر ~۱۰ دقیقه یک کپیِ نسخه‌ی سالمِ قبلی (db.json.prev) هم نگه داشته می‌شه.
let lastDbPrevCopy = 0;
function writeDB(data) {
  const tmp = DB_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      if (fs.existsSync(DB_PATH) && Date.now() - lastDbPrevCopy > 10 * 60 * 1000) {
        fs.copyFileSync(DB_PATH, DB_PATH + '.prev');
        lastDbPrevCopy = Date.now();
      }
    } catch (e) { /* کپیِ پشتیبان اختیاریه */ }
    try {
      fs.renameSync(tmp, DB_PATH);
    } catch (e) {
      // بعضی آنتی‌ویروس‌ها rename روی فایلِ باز رو رد می‌کنن - آخرین راه: نوشتنِ مستقیم
      console.error('rename failed, falling back to direct write:', e.message);
      fs.writeFileSync(DB_PATH, JSON.stringify(data), 'utf8');
    }
    dbFileStamp = dbStat();
    dbSaveCount++;
    return true;
  } catch (e) {
    console.error('Error writing DB:', e);
    return false;
  }
}

const DEFAULT_USERS = [
  {username:'admin', password:'123456', fullname:'مدیر سیستم', unit:'مدیریت', role:'admin'},
  {username:'ali', password:'123456', fullname:'علی احمدی', unit:'برش', role:'user'},
  {username:'reza', password:'123456', fullname:'رضا کریمی', unit:'لحیم', role:'user'},
  {username:'mohsen', password:'123456', fullname:'محسن رضایی', unit:'تزریق', role:'user'},
  {username:'mehdi', password:'123456', fullname:'مهدی قاسمی', unit:'کنترل کیفیت', role:'user'},
  {username:'hamid', password:'123456', fullname:'حمید علیپور', unit:'بسته‌بندی', role:'user'},
  {username:'nader', password:'123456', fullname:'نادر محمدی', unit:'انبار محصول', role:'user'},
  {username:'ahmad', password:'123456', fullname:'احمد اصغری', unit:'انبار مواد اولیه', role:'user'}
];

const DEFAULT_ITEMS = [];

const DEPTS = [
  {id:'raw', name:'انبار مواد اولیه', type:'wh'},
  {id:'cut', name:'برش', type:'stage'},
  {id:'solder', name:'لحیم', type:'stage'},
  {id:'qc', name:'کنترل کیفیت', type:'qc'},
  {id:'inject', name:'تزریق', type:'stage'},
  {id:'laser', name:'لیزر', type:'stage'},
  {id:'pack', name:'بسته‌بندی', type:'stage'},
  {id:'finished', name:'انبار محصول', type:'wh'}
];

// مراحل تولیدی که BOM سپیدار براشون فرمول داره (به ترتیب زنجیره تولید)
const STAGE_DEPTS = ['cut', 'solder', 'inject', 'laser', 'pack'];

const DEFAULT_FISCAL_YEARS = [
  {year: '1405', title: 'سال مالی 1405', status: 'active', startDate: '1405/01/01', endDate: '1405/12/29'}
];

function getDefaultData() {
  const inventory = {};
  DEPTS.forEach(d => { inventory[d.id] = {}; });
  return { 
    depts: DEPTS,
    items: DEFAULT_ITEMS,
    users: DEFAULT_USERS,
    inventory: inventory,
    transactions: [],
    docs: [],
    fiscalYears: DEFAULT_FISCAL_YEARS,
    activeFiscalYear: '1405',
    initialInventory: [],
    productDefinitions: {},
    seq: {id: 1, doc: 1},
    batchCounter: 1,
    materialClassification: {},
    bomFormulas: {},
    productionOrders: [],
    orderSeq: 1,
    appSettings: {
      sepidar: { ...DEFAULT_SEPIDAR_CONFIG },
      appPort: 3000,
      backup: { folder: '', autoEnabled: false, autoIntervalHours: 24, keepCount: 30 },
      rolePermissions: { ...DEFAULT_ROLE_PERMISSIONS },
      outputMessenger: { ...DEFAULT_OUTPUT_MESSENGER_CONFIG },
      warehouseGate: { ...DEFAULT_WAREHOUSE_GATE_CONFIG },
      productionGate: { ...DEFAULT_PRODUCTION_GATE_CONFIG },
      push: null // { publicKey, privateKey, subject } - اولین بار که سرور بالا میاد خودکار ساخته می‌شه (ensurePushKeys)
    },
    pushSubscriptions: [],
    activityLog: [],
    sepidarInbox: { startDate: null, decisions: {} },
    stockCounts: [],
    stockCountSeq: 1,
    itemLocations: {},
    minStock: {},
    productionTargets: [],
    productionTargetSeq: 1
  };
}

let data = null;
let items = [];
let users = [];
let inventory = {};
let transactions = [];
let docs = [];
let fiscalYears = [];
let activeFiscalYear = '1405';
let initialInventory = [];
let productDefinitions = {};
let seqId = 1;
let docSeq = 1;
let batchCounter = 1;
// پیش‌بینی تولید: فهرست سبکِ سفارش‌های تولیدِ در حال ردیابی (فقط برای تب «پیش‌بینی
// تولید» - orderBatchId روی خودِ docs هم اختیاری ذخیره می‌شه، ولی هیچ منطق دیگه‌ای
// (موجودی/لغو/زنجیره) بهش وابسته نیست).
let productionOrders = [];
let orderSeq = 1;
// نگاشت «کد ماده اولیه سپیدار» → مرحله تولید (cut/solder/inject/laser/pack)
// این جدول دستی و داخل خود سیستم نگه‌داری می‌شه (سپیدار همچین مفهومی نداره)
let materialClassification = {};
// فرمول‌های ساخت آپلودشده از سپیدار، بر اساس «کد محصول»:
// { [کد محصول سپیدار]: { name, materials: [{code, name, unit, qty, stage}] } }
let bomFormulas = {};
// تنظیمات قابل‌ویرایش از تب «⚙️ تنظیمات»: اتصال سپیدار، پورت اپ، مسیر/زمان‌بندی بکاپ.
let appSettings = {};
let activityLog = [];
// اشتراک‌های Web Push (هر دستگاه/مرورگری که کاربری روی موبایل نوتیفیکیشن رو فعال کرده) -
// {id, username, endpoint, keys:{p256dh,auth}, createdAt}. مستقل از appSettings نگه‌داری
// می‌شه چون رکورد است نه تنظیمات (شبیه docs/transactions، نه شبیه sepidar/backup).
let pushSubscriptions = [];
// صندوق اسناد سپیدار: startDate = تاریخ شروعِ قابل‌تایید (ISO)، decisions = {کلید سند: {status, ...}}
let sepidarInbox = { startDate: null, decisions: {} };
// برگه‌های انبارگردانی (شمارش انبار) و شمارنده‌ی شناسه‌شان
let stockCounts = [];
let stockCountSeq = 1;
// محلِ قفسه ("<unit>|<code>" → متن)، حداقل موجودی ("<unit>|<code>" → عدد) و هدف‌های تولید
let itemLocations = {};
let minStock = {};
let productionTargets = [];
let productionTargetSeq = 1;

// یه شمارنده‌ی ساده که هر بار داده واقعاً ذخیره می‌شه زیاد می‌شه - کلاینت‌ها به‌جای
// polling کردنِ کل داده (که ~۷۰۰ کیلوبایته) هر چند ثانیه فقط همین عدد رو می‌پرسن؛ فقط
// وقتی عوض شده باشه سراغ /api/data کامل می‌رن. برای هماهنگیِ بی‌رفرش بین بخش‌ها کافیه -
// نیازی به وب‌سوکت/دیتابیس جدا نداره.
let dataVersion = Date.now();

// دقیقاً یه‌جا globalهای ماژول رو از یه آبجکت داده‌ی خام پر می‌کنه - هم loadData() (خوندن از
// db.json) و هم بازیابیِ بکاپ از همین تابع استفاده می‌کنن تا این نگاشت هیچ‌وقت توی دو جا
// جدا نگه‌داری نشه (دقیقاً همون باگی که در backupData() قدیمیِ سمت کلاینت افتاده بود).
function applyLoadedData(raw) {
  const def = getDefaultData();
  for (const k in def) {
    if (!raw[k]) raw[k] = def[k];
  }
  data = raw;
  items = data.items || [];
  users = data.users || [];
  inventory = data.inventory || {};
  transactions = data.transactions || [];
  docs = data.docs || [];
  fiscalYears = data.fiscalYears || DEFAULT_FISCAL_YEARS;
  activeFiscalYear = data.activeFiscalYear || '1405';
  initialInventory = data.initialInventory || [];
  productDefinitions = data.productDefinitions || {};
  seqId = data.seq?.id || 1;
  docSeq = data.seq?.doc || 1;
  batchCounter = data.batchCounter || 1;
  materialClassification = data.materialClassification || {};
  bomFormulas = data.bomFormulas || {};
  productionOrders = data.productionOrders || [];
  orderSeq = data.orderSeq || 1;
  appSettings = data.appSettings || def.appSettings;
  // db.jsonهای قدیمی‌تر ممکنه appSettings داشته باشن ولی بدون rolePermissions (فیلدیه که
  // بعداً اضافه شد) - این‌جا جبران می‌شه تا نقش‌های جدید همون پیش‌فرض‌های مستندشده رو بگیرن.
  if (!appSettings.rolePermissions) appSettings.rolePermissions = { ...DEFAULT_ROLE_PERMISSIONS };
  if (!Array.isArray(appSettings.rolePermissions.viewer)) appSettings.rolePermissions.viewer = DEFAULT_ROLE_PERMISSIONS.viewer.slice();
  if (!appSettings.viewerPermsV2) { DEFAULT_ROLE_PERMISSIONS.viewer.forEach(x => { if (!appSettings.rolePermissions.viewer.includes(x)) appSettings.rolePermissions.viewer.push(x); }); appSettings.viewerPermsV2 = true; }
  // قبلاً تاییدِ ضایعات/کسری/اضافات برای سرپرست ثابت بود؛ حالا یه مجوزِ قابل‌تنظیمه. یک بار
  // (با پرچم) به سرپرست داده می‌شه تا رفتارِ فعلی عوض نشه، بعدش کاملاً با ماتریسِ دسترسی کنترل می‌شه.
  if (!appSettings.adjApproverMigrated) {
    if (!Array.isArray(appSettings.rolePermissions.supervisor)) appSettings.rolePermissions.supervisor = [];
    if (!appSettings.rolePermissions.supervisor.includes(PERM_APPROVE_ADJUSTMENTS)) appSettings.rolePermissions.supervisor.push(PERM_APPROVE_ADJUSTMENTS);
    appSettings.adjApproverMigrated = true;
  }
  if (!appSettings.sepidarFiscalYears) appSettings.sepidarFiscalYears = { '1405': 13 };
  if (appSettings.docStampFromId == null) appSettings.docStampFromId = docSeq; // از همین سند به بعد زمانِ ثبت نگه‌داری می‌شه
  if (!appSettings.initialDocsBackfilled) {
    // ردیف‌های «موجودی اول دوره»ی قبلی (بیشترشان از دریافتِ موجودی سپیدار) سند نداشتند؛ برایشان سند ساخته می‌شود
    // (بدون تغییر موجودی). ثبت‌کنندهٔ دقیق و ساعت در سوابق قدیمی نبود، پس به‌صورت «سیستم» و فقط با روزِ ثبت علامت می‌خورد.
    let made = 0;
    initialInventory.forEach(r => {
      if (r.docId) return;
      ensureInitialDoc(r, { actor: 'سیستم', source: 'backfill', note: 'موجودی اول دوره (سند ساخته‌شده برای ثبتِ قدیمی؛ ثبت‌کننده و ساعت دقیق در سوابق قدیمی ثبت نشده بود)', createdAt: jalaliStrToIso(r.date) || undefined, approxTime: true });
      made++;
    });
    appSettings.initialDocsBackfilled = true;
    if (made) console.log('📄 سند برای ' + made + ' ردیف موجودی اول دوره ساخته شد');
  }
  if (!appSettings.analyticsMigrated) {
    // «خانه» برای همه‌ی نقش‌ها؛ «تحلیل و گزارشات تکمیلی» (قبلاً: پیش‌بینی تولید، فقط مدیر) برای سرپرست هم
    ['supervisor', 'warehouse', 'user'].forEach(r => {
      if (!Array.isArray(appSettings.rolePermissions[r])) appSettings.rolePermissions[r] = [];
      if (!appSettings.rolePermissions[r].includes('sec-home')) appSettings.rolePermissions[r].push('sec-home');
    });
    if (Array.isArray(appSettings.rolePermissions.supervisor) && !appSettings.rolePermissions.supervisor.includes('sec-forecast')) appSettings.rolePermissions.supervisor.push('sec-forecast');
    appSettings.analyticsMigrated = true;
  }
  if (!appSettings.stockCountMigrated) {
    ['warehouse', 'supervisor'].forEach(r => {
      if (!Array.isArray(appSettings.rolePermissions[r])) appSettings.rolePermissions[r] = [];
      if (!appSettings.rolePermissions[r].includes('sec-stock-count')) appSettings.rolePermissions[r].push('sec-stock-count');
    });
    appSettings.stockCountMigrated = true;
  }
  if (!appSettings.sepidarSectionsMigrated) {
    if (!Array.isArray(appSettings.rolePermissions.warehouse)) appSettings.rolePermissions.warehouse = [];
    if (!appSettings.rolePermissions.warehouse.includes('sec-sepidar-inbox')) appSettings.rolePermissions.warehouse.push('sec-sepidar-inbox');
    appSettings.sepidarSectionsMigrated = true;
  }
  if (!appSettings.outputMessenger) appSettings.outputMessenger = { ...DEFAULT_OUTPUT_MESSENGER_CONFIG };
  if (!appSettings.warehouseGate) appSettings.warehouseGate = { ...DEFAULT_WAREHOUSE_GATE_CONFIG };
  if (!appSettings.productionGate) appSettings.productionGate = { ...DEFAULT_PRODUCTION_GATE_CONFIG };
  activityLog = data.activityLog || [];
  pushSubscriptions = data.pushSubscriptions || [];
  sepidarInbox = data.sepidarInbox || { startDate: null, decisions: {} };
  if (!sepidarInbox.decisions) sepidarInbox.decisions = {};
  stockCounts = data.stockCounts || [];
  stockCountSeq = data.stockCountSeq || (stockCounts.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1);
  itemLocations = data.itemLocations || {};
  minStock = data.minStock || {};
  productionTargets = data.productionTargets || [];
  productionTargetSeq = data.productionTargetSeq || (productionTargets.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1);
  normalizeInventory();
  // اضافاتی که از «رسید انبار» سپیدار ساخته شده بود نوعِ مستقلِ receipt می‌شه (idempotent)
  docs.forEach(d => {
    if (d.source === 'sepidar' && d.type === 'excess') {
      d.type = 'receipt';
      const t = transactions.find(x => x.id === d.transactionId);
      if (t && t.type === 'excess') t.type = 'receipt';
    }
  });
  // یک‌بار: تاریخ‌های قدیمیِ «۱۴۰۵/۷/۲» (ارقام فارسی، بدون صفر) به قالبِ واحدِ «1405/07/02»
  if (!appSettings.datesNormalized) {
    const fix = o => { if (o && typeof o.date === 'string') { const n = normalizeJalaliDate(o.date); if (n.ok && n.value !== o.date) o.date = n.value; } };
    docs.forEach(fix); transactions.forEach(fix); initialInventory.forEach(fix);
    appSettings.datesNormalized = new Date().toISOString();
    pendingMigrationSave = true;
  }
  // یک‌بار: کدگذاریِ جدیدِ محصولاتِ مرحله‌ای (SOL-/INJ-/LASER-{کد سپیدار}-{برند}/PACK-...) - نگاه کنید به migrateStageCodesV2
  if (!appSettings.stageCodesV2 && Object.keys(bomFormulas).length) {
    migrateStageCodesV2();
    appSettings.stageCodesV2 = new Date().toISOString();
    pendingMigrationSave = true;
  }
  // یک‌بار: برند/نوع پک از این به بعد هنگامِ تولید انتخاب می‌شود - نگاه کنید به migrateBrandOnDemand
  if (!appSettings.brandOnDemand) {
    migrateBrandOnDemand();
    appSettings.brandOnDemand = new Date().toISOString();
    pendingMigrationSave = true;
  }
  // یک‌بار (۱۴۰۵/۰۷/۲۷، به خواستِ مالک): اسنادِ لغوشده‌ای که هیچ اثری ندارند پاک می‌شوند - بدونِ تراکنش و بدونِ
  // سندِ فعالی که به آن‌ها اشاره کند. خودِ اسناد پیش از حذف در backups/purged-cancelled-*.json بایگانی می‌شوند.
  // یک‌بار: رمزهای ساده → هش (scrypt). از این به بعد هیچ رمزی به‌صورتِ خوانا ذخیره نمی‌شود.
  if (users.some(u => u.password !== undefined)) {
    users.forEach(u => { if (u.password !== undefined) { if (!u.passwordHash) u.passwordHash = hashPassword(u.password); delete u.password; } });
    pendingMigrationSave = true;
  }
  if (!appSettings.initialCableImportedV1) {
    try { migrateInitialCablesImported(); } catch (e) { console.error('cable migration:', e.message); }
    appSettings.initialCableImportedV1 = new Date().toISOString();
    pendingMigrationSave = true;
  }
  if (!appSettings.purgeCancelledV1) {
    const n = purgeInertCancelledDocs();
    appSettings.purgeCancelledV1 = new Date().toISOString();
    pendingMigrationSave = true;
    if (n) console.log(`🧹 ${n} سندِ لغوشده‌ی بی‌اثر پاک شد (بایگانی در backups)`);
  }
  // یک‌بار: اسنادِ موجودی اول دوره‌ای که با هم (یک لیست) ثبت شده بودند یک «سندِ گروهی» می‌شوند (groupId)
  if (!appSettings.initialGroupsV1) {
    const n = migrateInitialGroups();
    appSettings.initialGroupsV1 = new Date().toISOString();
    pendingMigrationSave = true;
    if (n) console.log(`📊 اسناد موجودی اول دوره: ${n} گروه ساخته شد`);
  }
}

// ردیف‌های یک ثبتِ لیستی پشتِ‌سرِ هم ساخته شده‌اند: همان بخش/ثبت‌کننده/تاریخ و فاصله‌ی زمانیِ کم → یک گروه.
// شماره‌ی گروه = شماره‌ی اولین سندِ آن (همان چیزی که کاربر به‌عنوان «شماره سند» می‌بیند).
function migrateInitialGroups() {
  const list = docs.filter(d => d.type === 'initial' && d.groupId == null && d.source !== 'sepidar-sync').sort((a, b) => a.id - b.id);
  let groups = 0, cur = null, prev = null;
  list.forEach(d => {
    const t = Date.parse(d.createdAt || '') || 0, pt = prev ? (Date.parse(prev.createdAt || '') || 0) : 0;
    const same = prev && d.id === prev.id + 1 && d.unit === prev.unit && d.createdBy === prev.createdBy && d.date === prev.date && Math.abs(t - pt) < 120000;
    if (!same) { cur = d.id; groups++; }
    d.groupId = cur;
    const row = initialInventory.find(r => r.docId === d.id); if (row) row.groupId = cur;
    prev = d;
  });
  return groups;
}
// یک‌بار (به درخواستِ کاربر، ۱۴۰۵/۰۷/۲۷): همه‌ی موجودی اول دوره‌ی دستی (غیر از انبار مواد اولیه) کابلِ «وارداتی» است.
// ۱) کابلِ ساده (00440…) یا برش‌خورده‌اش (CUT-00440…-طول) ← معادلِ وارداتیِ یکتا (از جفت‌فرمول‌های سپیدار)؛ اگر همان
//    سند ردیفِ وارداتیِ همان کالا را دارد، با آن جمع می‌شود. ۲) کالای لحیم/تزریق/لیزر/بسته‌بندی: نوعِ کابل = فرمولِ وارداتی
//    (یا تنها فرمولِ محصول). هر موردِ مبهم/دارای گردش دست نمی‌خورد و در گزارش می‌آید. نسخه‌ی کاملِ قبل در backups.
function migrateInitialCablesImported() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolveBackupFolder(); // همه‌ی بکاپ‌ها در پوشه‌ی بکاپِ تنظیمات (مثلاً E:\\WarehouseSystem\\backups)
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `pre-cable-imported-${ts}.json`), JSON.stringify(data)); } catch (e) { console.error('backup before cable migration failed:', e.message); return; }
  // وارداتی = گروهِ 333 یا نامِ کالا «وارداتي/وارداتی» (مثلاً 001102029 کابلِ وارداتیِ S10)
  const isImp = c => String(c).startsWith('333') || /واردات[يی]/.test(((items.find(i => i.code === c) || {}).name) || '');
  const cutsOf = f => (f.materials || []).filter(m => m.stage === 'cut').map(m => m.code);
  const byPc = {};
  Object.entries(bomFormulas).forEach(([k, f]) => { if (f && f.productCode) (byPc[f.productCode] = byPc[f.productCode] || []).push(k); });
  const pairs = {};
  Object.values(byPc).forEach(ks => {
    if (ks.length < 2) return;
    const imp = ks.flatMap(k => cutsOf(bomFormulas[k]).filter(isImp)), sim = ks.flatMap(k => cutsOf(bomFormulas[k]).filter(c => !isImp(c)));
    sim.forEach(a => imp.forEach(b => { (pairs[a] = pairs[a] || new Set()).add(b); }));
  });
  const rep = { renamed: [], merged: [], fkSet: [], skipped: [] };
  const lines = docs.filter(d => d.type === 'initial' && d.status === 'approved' && d.source !== 'sepidar-sync' && d.unit !== 'raw');
  const labelOf = d => 'اول‌دوره ' + (d.docNo || '') + (d.formulaKey ? ' · ف' + d.formulaKey : '');
  const now = new Date().toISOString();
  const hist = (d, before, after) => (d.editHistory = d.editHistory || []).push({ at: now, by: 'سیستم (اصلاحِ کابلِ وارداتی)', before: { qty: before.qty, date: d.date, note: d.note, ...before }, after: { qty: after.qty, date: d.date, note: d.note, ...after } });
  // ۱) کابلِ ساده ← وارداتی
  lines.slice().forEach(d => {
    const sc = splitColor(d.item), base = sc.base;
    const cm = base.match(/^CUT-(.+)-(\d+)$/);
    const mat = cm ? cm[1] : base;
    if (!pairs[mat]) return;
    const targets = [...pairs[mat]];
    if (targets.length !== 1) { rep.skipped.push(`${d.docNo || d.id} ${deptName(d.unit)} ${d.item}: معادلِ وارداتیِ یکتا ندارد (${targets.join('/')})`); return; }
    const newBase = cm ? `CUT-${targets[0]}-${cm[2]}` : targets[0];
    if (cm && !(productDefinitions.cut || []).some(p => p.code === newBase)) { rep.skipped.push(`${d.docNo || d.id} ${d.item}: محصولِ برشِ ${newBase} تعریف نشده`); return; }
    const newKey = sc.colorSlug ? `${newBase}@${sc.colorSlug}` : newBase;
    const others = docs.some(x => x.id !== d.id && x.item === d.item && (x.unit === d.unit || x.fromUnit === d.unit || x.toUnit === d.unit) && x.status !== 'cancelled' && x.status !== 'rejected')
      || transactions.some(t => t.id !== d.transactionId && t.item === d.item && (t.unit === d.unit || t.targetUnit === d.unit));
    if (others) { rep.skipped.push(`${d.docNo || d.id} ${deptName(d.unit)} ${d.item}: بعد از موجودی اول گردش داشته؛ دستی اصلاح شود`); return; }
    const inv = inventory[d.unit] = inventory[d.unit] || {};
    if ((inv[d.item] || 0) + 1e-6 < d.qty) { rep.skipped.push(`${d.docNo || d.id} ${d.item}: موجودی کمتر از سند است`); return; }
    inv[d.item] = Math.round(((inv[d.item] || 0) - d.qty) * 1e6) / 1e6; if (Math.abs(inv[d.item]) < 1e-9) delete inv[d.item];
    inv[newKey] = Math.round(((inv[newKey] || 0) + d.qty) * 1e6) / 1e6;
    const tgt = docs.find(x => x.id !== d.id && x.type === 'initial' && x.status === 'approved' && x.unit === d.unit && x.item === newKey && String(x.groupId) === String(d.groupId) && !x.formulaKey);
    if (tgt) {
      const q0 = tgt.qty, q1 = Math.round((tgt.qty + d.qty) * 1e6) / 1e6;
      hist(tgt, { qty: q0 }, { qty: q1, mergedFrom: d.item });
      tgt.qty = q1; tgt.updatedAt = now;
      const tt = transactions.find(t => t.id === tgt.transactionId); if (tt) tt.qty = q1;
      const tr = initialInventory.find(r => r.docId === tgt.id); if (tr) tr.qty = q1;
      transactions = transactions.filter(t => t.id !== d.transactionId);
      initialInventory = initialInventory.filter(r => r.docId !== d.id);
      docs = docs.filter(x => x.id !== d.id);
      rep.merged.push(`${d.docNo || d.id} ${deptName(d.unit)}: ${d.item} (${d.qty}) با ${newKey} جمع شد → ${q1}`);
    } else {
      hist(d, { qty: d.qty, item: d.item }, { qty: d.qty, item: newKey });
      const tt = transactions.find(t => t.id === d.transactionId); if (tt) tt.item = newKey;
      const tr = initialInventory.find(r => r.docId === d.id); if (tr) tr.item = newKey;
      rep.renamed.push(`${d.docNo || d.id} ${deptName(d.unit)}: ${d.item} → ${newKey} (${d.qty})`);
      d.item = newKey;
    }
  });
  // ۲) نوعِ کابلِ کالای مرحله‌ای = فرمولِ وارداتی
  docs.filter(d => d.type === 'initial' && d.status === 'approved' && d.source !== 'sepidar-sync' && d.unit !== 'raw' && !d.formulaKey).forEach(d => {
    const ks = stageFormulaKeys(d.item);
    if (!ks.length) return;
    let fk = null;
    if (ks.length === 1) fk = ks[0];
    else {
      const imp = ks.filter(k => { const c = cutsOf(getFormula(k) || {}); return c.length && c.every(isImp); });
      if (imp.length === 1) fk = imp[0];
      else { rep.skipped.push(`${d.docNo || d.id} ${deptName(d.unit)} ${resolveItemName(d.item)}: ${imp.length ? 'چند فرمولِ وارداتی' : 'فرمولِ وارداتی ندارد'} (${ks.join('/')})؛ نوعِ کابل را دستی انتخاب کنید`); return; }
    }
    const oldL = labelOf(d);
    hist(d, { qty: d.qty, formulaKey: null }, { qty: d.qty, formulaKey: fk });
    d.formulaKey = fk;
    const tr = initialInventory.find(r => r.docId === d.id); if (tr) tr.formulaKey = fk;
    const nl = labelOf(d);
    transactions.forEach(t => { if (t.item === d.item && t.unit === d.unit && Array.isArray(t.lots)) t.lots.forEach(p => { if (p.batch === oldL) p.batch = nl; }); });
    if (ks.length > 1) rep.fkSet.push(`${d.docNo || d.id} ${deptName(d.unit)} ${resolveItemName(d.item)}: فرمول ${fk}`);
  });
  appSettings.initialCableImportedReport = { at: now, renamed: rep.renamed, merged: rep.merged, fkSetCount: rep.fkSet.length, fkSet: rep.fkSet, skipped: rep.skipped };
  try { fs.writeFileSync(path.join(dir, `cable-imported-report-${ts}.json`), JSON.stringify(rep, null, 2)); } catch (e) {}
  activityLog.push({ id: (activityLog.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1), timestamp: now, username: 'system',
    action: 'اصلاحِ موجودی اول: کابل وارداتی', details: `تبدیل: ${rep.renamed.length}، ادغام: ${rep.merged.length}، نوعِ کابل ثبت شد: ${rep.fkSet.length}، رد شده: ${rep.skipped.length}` });
  console.log('🔌 cable migration', JSON.stringify({ renamed: rep.renamed.length, merged: rep.merged.length, fk: rep.fkSet.length, skipped: rep.skipped.length }));
}
function purgeInertCancelledDocs() {
  const txIds = new Set(transactions.map(t => t.id));
  const refByActive = new Set(docs.filter(d => d.status !== 'cancelled' && d.parentDocId).map(d => d.parentDocId));
  const gone = docs.filter(d => d.status === 'cancelled' && !(d.transactionId && txIds.has(d.transactionId)) && !refByActive.has(d.id));
  if (!gone.length) return 0;
  try {
    const dir = resolveBackupFolder();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `purged-cancelled-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(gone, null, 2));
  } catch (e) { console.error('بایگانیِ اسنادِ لغوشده نوشته نشد - پاک‌سازی انجام نشد:', e.message); return 0; }
  const ids = new Set(gone.map(d => d.id));
  docs = docs.filter(d => !ids.has(d.id));
  initialInventory = initialInventory.filter(r => !ids.has(r.docId));
  activityLog.push({ id: (activityLog.reduce((m, a) => Math.max(m, a.id || 0), 0)) + 1, timestamp: new Date().toISOString(), username: 'سیستم',
    action: 'پاک‌سازی اسناد لغوشده', details: `${gone.length} سندِ لغوشده‌ی بدونِ اثر حذف شد (بایگانی در backups): ${gone.map(d => d.id).join('، ')}` });
  return gone.length;
}
function initialGroupDocs(gid) {
  return docs.filter(d => d.type === 'initial' && d.status === 'approved' && String(d.groupId) === String(gid));
}

// ============================================
// مهاجرتِ یک‌باره به کدگذاریِ جدیدِ محصولاتِ مرحله‌ای (۱۴۰۵/۰۷/۲۶)
// ============================================
// قبلاً لحیم/تزریق کدِ فرمول داشتند و کدِ موجودی‌شان (در وب) کدِ سپیدار بود، پس لحیم، تزریق و هر دو برندِ
// لیزر روی یک کلیدِ موجودی می‌افتادند؛ بسته‌بندی هم برند نداشت (Pack-{فرمول}). این تابع تعریف‌ها را به
// قانونِ جدید می‌برد و کدهای قدیمیِ لیزر/پک را در موجودی/تراکنش/اسناد هم عوض می‌کند (این دو بی‌ابهام‌اند).
// کلیدهای قدیمیِ لحیم/تزریق (کدِ خامِ سپیدار یا کدِ فرمول در بخش‌های تولیدی) مبهم‌اند (ورودی یا خروجی؟)،
// پس فقط گزارش می‌شوند تا دستی بررسی شوند - در زمانِ این تغییر هیچ موجودی/سندی با آن‌ها وجود نداشت.
let pendingMigrationSave = false;
function migrateStageCodesV2() {
  const remap = {};   // کدِ قدیمی → کدِ جدید (برای لیزر/پک، مستقل از بخش)
  const kept = [];    // تعریف‌هایی که کدِ سپیدارشان پیدا نشد و دست‌نخورده ماندند
  const brands = new Set();

  // ۱) لیزر: LASER-{فرمول}-{برند} → LASER-{کد سپیدار}-{برند}
  const newLaser = [];
  (productDefinitions.laser || []).forEach(p => {
    const fk = p.baseFormulaCode;
    const f = fk && bomFormulas[fk];
    const pc = p.productCode || (f && f.productCode);
    let brand = p.brand || null;
    if (!brand && fk && String(p.code).startsWith(`LASER-${fk}-`)) brand = String(p.code).slice(`LASER-${fk}-`.length);
    if (!pc) { kept.push(p.code); newLaser.push(p); return; }
    const fks = formulaKeysOfProductCode(pc);
    const base = sepidarBaseName(pc, fks);
    const code = brand ? laserCode(pc, brand) : `LASER-${pc}`;
    if (brand) brands.add(brand);
    if (code !== p.code) remap[p.code] = code;
    if (newLaser.some(x => x.code === code)) return; // دو فرمولِ یک کالا → یک محصول
    newLaser.push({ code, productCode: pc, sepidarName: base, brand, name: brand ? `${base} - ${brand}` : base,
      formulaKeys: fks, baseFormulaCode: fks[0] || fk, group: 'laser', unit: p.unit || 'عدد', created: p.created || new Date().toISOString() });
  });
  productDefinitions.laser = newLaser;

  // ۲) بسته‌بندی: Pack-{فرمول} (برند و نوعِ پک فقط در نام بود) → PACK-{کد سپیدار}-{برند}-{نوع پک}
  const newPack = [];
  (productDefinitions.pack || []).forEach(p => {
    const fk = p.baseFormulaCode || String(p.code).replace(/^Pack-/, '');
    const f = bomFormulas[fk];
    const pc = p.productCode || (f && f.productCode);
    const segs = String(p.name || '').replace(/\s*\([^)]*\)\s*$/, '').split(' - ').map(x => x.trim()).filter(Boolean);
    const packType = p.packType || (segs.length >= 2 ? segs[segs.length - 1] : null);
    let brand = p.brand || (segs.length >= 3 ? segs[segs.length - 2] : null);
    if (brand && brands.size && !brands.has(brand)) brand = null;
    if (!pc || !brand || !packType) { kept.push(p.code); newPack.push(p); return; }
    const fks = formulaKeysOfProductCode(pc);
    const base = sepidarBaseName(pc, fks);
    const code = packCode(pc, brand, packType);
    if (code !== p.code) remap[p.code] = code;
    if (newPack.some(x => x.code === code)) return;
    newPack.push({ code, productCode: pc, sepidarName: base, brand, packType, name: `${base} - ${brand} - ${packType}`,
      formulaKeys: fks, baseFormulaCode: fks[0] || fk, group: 'pack', unit: p.unit || 'عدد', created: p.created || new Date().toISOString() });
  });
  productDefinitions.pack = newPack;

  // ۳) کلیدهای مبهمِ قدیمیِ لحیم/تزریق را قبل از بازسازی پیدا می‌کنیم (فقط گزارش)
  const oldStageKeys = new Set();
  ['solder', 'inject'].forEach(d => (productDefinitions[d] || []).forEach(p => { oldStageKeys.add(p.code); if (p.productCode) oldStageKeys.add(p.productCode); }));
  const STAGE_UNITS = ['solder', 'inject', 'laser', 'pack', 'qc', 'finished'];
  const ambiguous = new Set();
  STAGE_UNITS.forEach(u => Object.entries(inventory[u] || {}).forEach(([k, v]) => { if (v && oldStageKeys.has(k)) ambiguous.add(u + '|' + k); }));
  transactions.forEach(t => { if (STAGE_UNITS.includes(t.unit) && oldStageKeys.has(t.item)) ambiguous.add(t.unit + '|' + t.item); });

  // ۴) لحیم/تزریق با قانونِ جدید ساخته می‌شوند
  rebuildProductDefinitionsFromBOM();

  // ۵) کدهای قدیمیِ لیزر/پک در همه‌ی ساختارها
  let renamed = 0;
  const mapKey = k => (remap[k] !== undefined ? remap[k] : k);
  Object.keys(inventory).forEach(u => {
    const inv = inventory[u] || {};
    Object.keys(inv).forEach(k => {
      if (remap[k] === undefined) return;
      inv[remap[k]] = (inv[remap[k]] || 0) + inv[k]; delete inv[k]; renamed++;
    });
  });
  transactions.forEach(t => { if (remap[t.item] !== undefined) { t.item = mapKey(t.item); renamed++; } });
  docs.forEach(d => { if (remap[d.item] !== undefined) { d.item = mapKey(d.item); renamed++; } });
  initialInventory.forEach(r => { if (remap[r.item] !== undefined) { r.item = mapKey(r.item); renamed++; } });
  [minStock, itemLocations].forEach(obj => Object.keys(obj || {}).forEach(key => {
    const [u, k] = key.split('|');
    if (remap[k] !== undefined) { obj[u + '|' + remap[k]] = obj[key]; delete obj[key]; renamed++; }
  }));
  stockCounts.forEach(c => (c.lines || []).forEach(l => { if (remap[l.item] !== undefined) { l.item = mapKey(l.item); renamed++; } }));

  const details = `لیزر: ${productDefinitions.laser.length}، بسته‌بندی: ${productDefinitions.pack.length}، لحیم/تزریق: ${(productDefinitions.solder || []).length}`
    + ` - کلیدِ جابه‌جاشده: ${renamed}`
    + (kept.length ? ` - بدون کد سپیدار (دست‌نخورده): ${kept.join(', ')}` : '')
    + (ambiguous.size ? ` - ⚠️ موجودی/تراکنش با کدِ قدیمیِ مبهم (بررسی دستی): ${[...ambiguous].join(', ')}` : '');
  console.log('🔁 مهاجرت کدگذاری محصولات مرحله‌ای: ' + details);
  const nextId = activityLog.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
  activityLog.push({ id: nextId, timestamp: new Date().toISOString(), username: 'سیستم', action: 'مهاجرت کدگذاری محصولات (SOL/INJ/LASER/PACK)', details });
}

// فهرستِ برند/نوع پک را از تعریف‌های موجود پر می‌کند و تعریف‌های لیزر/بسته‌بندی‌ای را که هیچ‌جا استفاده نشده‌اند
// (موجودی، تراکنش، سند، موجودی اول دوره، حداقل موجودی، محل قفسه، انبارگردانی) حذف می‌کند؛ از این به بعد هنگامِ تولید ساخته می‌شوند.
function migrateBrandOnDemand() {
  const brands = new Set(appSettings.brands || []);
  const packTypes = new Set(appSettings.packTypes || []);
  (productDefinitions.laser || []).forEach(p => { if (p.brand) brands.add(p.brand); });
  (productDefinitions.pack || []).forEach(p => { if (p.brand) brands.add(p.brand); if (p.packType) packTypes.add(p.packType); });
  appSettings.brands = [...brands];
  appSettings.packTypes = [...packTypes];
  const used = new Set();
  Object.values(inventory).forEach(m => Object.entries(m || {}).forEach(([k, v]) => { if (v) used.add(k); }));
  transactions.forEach(t => used.add(t.item));
  docs.forEach(d => used.add(d.item));
  initialInventory.forEach(r => used.add(r.item));
  Object.keys(minStock || {}).concat(Object.keys(itemLocations || {})).forEach(k => used.add(k.split('|')[1]));
  stockCounts.forEach(c => (c.lines || []).forEach(l => used.add(l.item)));
  const before = { laser: (productDefinitions.laser || []).length, pack: (productDefinitions.pack || []).length };
  ['laser', 'pack'].forEach(d => { productDefinitions[d] = (productDefinitions[d] || []).filter(p => used.has(p.code)); });
  // کلیدهای صفرِ باقی‌مانده از تعریف‌های حذف‌شده هم از موجودی پاک می‌شوند
  const live = new Set(Object.values(productDefinitions).flat().map(p => p.code));
  Object.values(inventory).forEach(m => Object.keys(m || {}).forEach(k => { if (m[k] === 0 && /^(LASER|PACK|Pack)-/.test(k) && !live.has(k)) delete m[k]; }));
  const details = `برندها: ${appSettings.brands.join('، ') || '—'} | نوع پک: ${appSettings.packTypes.join('، ') || '—'} | تعریف‌های استفاده‌نشده حذف شد: لیزر ${before.laser - productDefinitions.laser.length}، بسته‌بندی ${before.pack - productDefinitions.pack.length}`;
  console.log('🔁 برند/نوع پک هنگام تولید: ' + details);
  const nextId = activityLog.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
  activityLog.push({ id: nextId, timestamp: new Date().toISOString(), username: 'سیستم', action: 'مهاجرت: برند و نوع پک هنگام تولید', details });
}

// خواندنِ db.json فقط وقتی لازم است: سرور تنها نویسنده‌ی فایل است و بعد از هر نوشتن مهرِ فایل (زمان+حجم) را نگه
// می‌دارد؛ اگه فایل عوض نشده باشد (و درخواستِ قبلی با خطا تمام نشده باشد) globalهای حافظه همین الان درست‌اند و
// ۷۰۰ کیلوبایت JSON دوباره parse نمی‌شود. تغییرِ بیرونی (بازیابی بکاپ، اسکریپت دستی) با تغییرِ مهرِ فایل دیده می‌شود.
let dbFileStamp = null;
let dbForceReload = false;
let dbSaveCount = 0;
function dbStat() {
  try { const st = fs.statSync(DB_PATH); return st.mtimeMs + ':' + st.size; } catch (e) { return null; }
}
function loadData() {
  const stamp = dbStat();
  if (data && !dbForceReload && stamp && stamp === dbFileStamp) return;
  const raw = readDB();
  applyLoadedData(raw || getDefaultData());
  dbFileStamp = dbStat();
  dbForceReload = false;
}

// نویزِ اعشاریِ ممیزِ شناور (مثل 3373.6599999999995 به‌جای 3373.66) از موجودی‌ها پاک می‌شه: تا ۶ رقم
// اعشار گرد می‌شه و باقی‌مانده‌ی بی‌معنیِ منفیِ خیلی کوچک صفر می‌شه. این‌جوری مقایسه‌ها (کافی/ناکافی)،
// فیلترِ «موجودی ≠ ۰» توی گزارش‌ها و لیست‌های انتخاب کالا هم دچار ردیفِ شبح یا رد شدنِ بی‌دلیل نمی‌شن.
function normalizeInventory() {
  Object.keys(inventory).forEach(u => {
    const inv = inventory[u];
    if (!inv) return;
    Object.keys(inv).forEach(k => {
      const v = inv[k];
      if (typeof v !== 'number' || !isFinite(v) || v === 0) return;
      let r = Math.round(v * 1e6) / 1e6;
      if (r < 0 && r > -QTY_EPS) r = 0;
      if (r !== v) inv[k] = r;
    });
  });
}

// عملیاتِ گروهی (همه یا هیچ): تا وقتی batchTx فعال است ذخیره روی دیسک انجام نمی‌شود؛ در پایان یا یک‌جا ذخیره می‌شود
// یا با بارگذاریِ دوباره‌ی فایل همه‌ی تغییراتِ حافظه دور ریخته می‌شود.
var batchTx = null;
// ===== شماره‌ی سند: سری جدا برای هر نوع، در هر سال مالی (مثل H-1405-0007) =====
// شناسه‌ی داخلی (id) عوض نمی‌شود؛ docNo فقط شماره‌ی نمایشی/چاپی است. ردیف‌های یک سند شماره‌ی مشترک دارند:
// مصرف/ضایعاتِ یک تولید = شماره‌ی همان تولید؛ ردیف‌های یک ارسالِ خروج (submissionId) و یک ثبتِ موجودی اول (groupId) = یک شماره.
// شماره یک بار داده می‌شود و هرگز عوض یا دوباره استفاده نمی‌شود (حتی اگر سند لغو/حذف شود).
const DOC_SERIES = { rework: 'N', dispatch: 'D', production: 'P', output: 'H', consume: 'C', waste: 'W', shortage: 'S', excess: 'E', receipt: 'R', initial: 'I', return: 'B' };
function docSeriesCode(d) { return d.type === 'excess' && d.source === 'sepidar' ? 'R' : (DOC_SERIES[d.type] || 'X'); }
function assignDocNumbers() {
  const todo = docs.filter(d => !d.docNo);
  if (!todo.length) return;
  if (!appSettings.docSerials) appSettings.docSerials = {};
  const ser = appSettings.docSerials;
  const byId = new Map(docs.map(d => [d.id, d]));
  const bySub = new Map(), byGroup = new Map();
  // موجودی اولِ دریافتی از سپیدار (بدون groupId) برای هر بخش یک سند است - همان‌طور که در لیست اسناد نشان داده می‌شود
  const groupOf = d => d.type !== 'initial' ? null : d.groupId != null ? String(d.groupId) : d.source === 'sepidar-sync' ? 'sep|' + (d.fiscalYear || activeFiscalYear) + '|' + d.unit : null;
  docs.forEach(d => { if (!d.docNo) return; if ((d.type === 'output' || d.type === 'dispatch') && d.submissionId) bySub.set(d.submissionId, d.docNo); if (groupOf(d)) byGroup.set(groupOf(d), d.docNo); if (d.type === 'rework' && d.reworkGroup) bySub.set('rwgroup|' + d.reworkGroup, d.docNo); });
  const isChild = d => (d.type === 'consume' || d.type === 'waste') && d.parentDocId && byId.has(d.parentDocId) && ['production', 'rework'].includes(byId.get(d.parentDocId).type);
  const fresh = d => {
    const fy = String(d.fiscalYear || activeFiscalYear || '').replace(/\D/g, '') || '0';
    const code = docSeriesCode(d), key = fy + '|' + code;
    ser[key] = (ser[key] || 0) + 1;
    return `${code}-${fy}-${String(ser[key]).padStart(4, '0')}`;
  };
  todo.filter(d => !isChild(d)).sort((a, b) => a.id - b.id).forEach(d => {
    if ((d.type === 'output' || d.type === 'dispatch') && d.submissionId && bySub.has(d.submissionId)) d.docNo = bySub.get(d.submissionId);
    else if (groupOf(d) && byGroup.has(groupOf(d))) d.docNo = byGroup.get(groupOf(d));
    else if (d.type === 'rework' && d.reworkGroup && bySub.has('rwgroup|' + d.reworkGroup)) d.docNo = bySub.get('rwgroup|' + d.reworkGroup);
    else d.docNo = fresh(d);
    if (d.type === 'rework' && d.reworkGroup) bySub.set('rwgroup|' + d.reworkGroup, d.docNo);
    if ((d.type === 'output' || d.type === 'dispatch') && d.submissionId) bySub.set(d.submissionId, d.docNo);
    if (groupOf(d)) byGroup.set(groupOf(d), d.docNo);
  });
  todo.filter(isChild).forEach(d => { d.docNo = byId.get(d.parentDocId).docNo || fresh(d); });
}
// ===== ردیابی بچ (لات) - فاز ۶ =====
// بچ همراهِ کالا حرکت می‌کند: ورودِ کالا به یک بخش (تولید، اضافات، رسید، موجودی اول) یک «لات» با برچسبِ بچ می‌سازد؛
// هر خروج (مصرف، ضایعات، کسری، انتقال) از لات‌های همان بخش/کالا به ترتیبِ قدیمی‌ترین اول (FIFO) برداشت می‌کند و
// انتقال همان لات‌ها را به بخشِ گیرنده می‌برد. سهمِ برداشت هر تراکنش یک بار در tx.lots ذخیره می‌شود (ثابت می‌ماند)؛
// موجودیِ لات‌ها از بازپخشِ دفترِ تراکنش‌ها ساخته می‌شود و در پایان با موجودیِ واقعی هم‌تراز می‌شود
// (اختلافِ قدیمی/همگام‌سازی سپیدار = لاتِ «نامشخص»).
const LOT_IN = ['production', 'excess', 'receipt', 'initial'];
const LOT_OUT = ['consume', 'waste', 'shortage', 'output'];
const LOT_UNKNOWN = 'نامشخص';
function lotLabelFor(tx, doc) {
  if (tx.type === 'initial') return 'اول‌دوره ' + ((doc && doc.docNo) || '') + (doc && doc.formulaKey ? ' · ف' + doc.formulaKey : '');
  if (tx.type === 'excess' && doc && doc.source === 'stockcount') return 'انبارگردانی ' + (doc.docNo || tx.batchNumber || '');
  return tx.batchNumber || (doc && doc.docNo) || ('TX' + tx.id);
}
function buildLotLedger() {
  const docByTx = new Map(), pairedInput = new Set(), docById = new Map(docs.map(d => [d.id, d]));
  const batchFk = new Map(); // برچسبِ لات → فرمول (نوعِ کابل) - از سندِ تولید یا موجودی اول
  docs.forEach(d => { if (d.transactionId) docByTx.set(d.transactionId, d); if (d.transactionId2) { docByTx.set(d.transactionId2, d); pairedInput.add(d.transactionId2); } (d.extraTxIds || []).forEach(x => docByTx.set(x, d)); });
  const lots = new Map(); // unit|item -> [{batch, qty, seq}]
  const alloc = new Map(); // txId -> [{batch, qty}]
  const listOf = (u, i) => { const k = u + '|' + i; if (!lots.has(k)) lots.set(k, []); return lots.get(k); };
  const add = (u, i, batch, qty, seq) => {
    if (!qty) return; const L = listOf(u, i); const e = L.find(x => x.batch === batch);
    if (e) e.qty += qty; else L.push({ batch, qty, seq });
  };
  const take = (u, i, qty, preferFk) => { // FIFO؛ اگر فرمولِ تولیدِ مصرف‌کننده معلوم است، اول لات‌های همان فرمول
    const L = listOf(u, i).filter(x => x.qty > 1e-9).sort((a, b) => (preferFk ? ((batchFk.get(a.batch) === preferFk ? 0 : 1) - (batchFk.get(b.batch) === preferFk ? 0 : 1)) : 0) || a.seq - b.seq); const out = []; let left = qty;
    for (const e of L) { if (left <= 1e-9) break; const q = Math.min(e.qty, left); e.qty -= q; left -= q; out.push({ batch: e.batch, qty: q }); }
    if (left > 1e-9) out.push({ batch: LOT_UNKNOWN, qty: left });
    return out;
  };
  const takeExact = (u, i, parts) => parts.forEach(p => { const L = listOf(u, i); const e = L.find(x => x.batch === p.batch); if (e) e.qty -= p.qty; else L.push({ batch: p.batch, qty: -p.qty, seq: 0 }); });
  const seqOf = new Map(); // batch -> اولین ظهور (برای FIFO بعد از انتقال)
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const txById = new Map(transactions.map(t => [t.id, t]));
  transactions.slice().sort((a, b) => a.id - b.id).forEach(t => {
    if (pairedInput.has(t.id)) return; // «ورود»ِ جفتِ یک خروج را خودِ خروج انجام می‌دهد
    if (t.reversalOf) {
      const o = txById.get(t.reversalOf); if (!o) return;
      const oa = alloc.get(o.id) || [];
      if (LOT_IN.includes(o.type)) {
        const b = lotLabelFor(o, docByTx.get(o.id));
        takeExact(o.unit, o.item, [{ batch: b, qty: o.qty }]);
      } else if (o.type === 'output') {
        if (o.targetUnit) takeExact(o.targetUnit, o.item, oa);
        oa.forEach(p => add(o.unit, o.item, p.batch, p.qty, seqOf.get(p.batch) || o.id));
      } else if (LOT_OUT.includes(o.type)) {
        oa.forEach(p => add(o.unit, o.item, p.batch, p.qty, seqOf.get(p.batch) || o.id));
      }
      return;
    }
    if (LOT_IN.includes(t.type) || t.type === 'input') {
      const b = lotLabelFor(t, docByTx.get(t.id));
      { const dd = docByTx.get(t.id); if (t.formulaKey && t.type === 'production' && t.qty > 0) batchFk.set(b, t.formulaKey); else if (dd && dd.type !== 'rework' && dd.formulaKey && (t.type === 'production' || t.type === 'initial' || t.type === 'excess')) batchFk.set(b, dd.formulaKey); }
      if (!seqOf.has(b)) seqOf.set(b, t.id);
      add(t.unit, t.item, b, t.qty, seqOf.get(b));
      alloc.set(t.id, [{ batch: b, qty: t.qty }]);
      return;
    }
    if (!LOT_OUT.includes(t.type)) return;
    let parts;
    if (Array.isArray(t.lots) && t.lots.length) { parts = t.lots.map(p => ({ batch: p.batch, qty: p.qty })); takeExact(t.unit, t.item, parts); }
    else {
      const cd = docByTx.get(t.id), pd = cd && cd.parentDocId ? docById.get(cd.parentDocId) : null;
      parts = take(t.unit, t.item, t.qty, t.type === 'consume' && pd && pd.type === 'production' ? pd.formulaKey : null);
    }
    alloc.set(t.id, parts);
    if (t.type === 'output' && t.targetUnit) parts.forEach(p => add(t.targetUnit, t.item, p.batch, p.qty, seqOf.get(p.batch) || t.id));
  });
  // هم‌ترازی با موجودیِ واقعی: منفی‌ها با قدیمی‌ترین‌ها خنثی، کمبود = لاتِ «نامشخص»، اضافه = از قدیمی‌ترین کم
  const keys = new Set([...lots.keys(), ...Object.entries(inventory).flatMap(([u, m]) => Object.keys(m || {}).map(i => u + '|' + i))]);
  keys.forEach(k => {
    const [u, ...rest] = k.split('|'); const i = rest.join('|');
    let L = (lots.get(k) || []).map(x => ({ ...x, qty: r6(x.qty) }));
    let neg = L.filter(x => x.qty < 0).reduce((a, x) => a - x.qty, 0);
    L = L.filter(x => x.qty > 0).sort((a, b) => a.seq - b.seq);
    for (const e of L) { if (neg <= 0) break; const q = Math.min(e.qty, neg); e.qty -= q; neg -= q; }
    L = L.filter(x => x.qty > 1e-6);
    const stock = r6((inventory[u] && inventory[u][i]) || 0);
    let sum = r6(L.reduce((a, x) => a + x.qty, 0));
    if (stock > sum + 1e-6) L.push({ batch: LOT_UNKNOWN, qty: r6(stock - sum), seq: Number.MAX_SAFE_INTEGER });
    else if (sum > stock + 1e-6) { let over = sum - stock; for (const e of L) { if (over <= 0) break; const q = Math.min(e.qty, over); e.qty -= q; over -= q; } L = L.filter(x => x.qty > 1e-6); }
    if (L.length) lots.set(k, L.map(x => ({ ...x, qty: r6(x.qty) }))); else lots.delete(k);
  });
  return { lots, alloc, docByTx, batchFk };
}
// سهمِ برداشتِ تراکنش‌های تازه را ثابت می‌کند (یک بار، هنگامِ ذخیره)
function persistLotAllocations() {
  if (!transactions.some(t => LOT_OUT.includes(t.type) && !t.reversalOf && !t.lots)) return;
  const { alloc } = buildLotLedger();
  transactions.forEach(t => {
    if (LOT_OUT.includes(t.type) && !t.reversalOf && !t.lots) t.lots = (alloc.get(t.id) || []).map(p => ({ batch: p.batch, qty: Math.round(p.qty * 1e6) / 1e6 }));
  });
}
function saveData() {
  if (batchTx) return;
  try { registerPackVariantsInUse(); } catch (e) { console.error('packVariants:', e.message); }
  assignDocNumbers();
  try { persistLotAllocations(); } catch (e) { console.error('lots:', e.message); }
  normalizeInventory();
  // اسنادِ جدیدی که createdAt ندارن (تولید/مصرف/ضایعات/...) هنگام اولین ذخیره مُهر زمان می‌گیرن؛
  // اسنادِ قدیمی (شناسه‌ی کمتر از docStampFromId) دست نمی‌خورن تا زمانِ اشتباه بهشون نچسبه.
  const stampFrom = appSettings && appSettings.docStampFromId;
  if (stampFrom) {
    const nowIso = new Date().toISOString();
    docs.forEach(d => { if (!d.createdAt && d.id >= stampFrom) d.createdAt = nowIso; });
  }
  data.users = users;
  data.items = items;
  data.inventory = inventory;
  data.transactions = transactions;
  data.docs = docs;
  data.fiscalYears = fiscalYears;
  data.activeFiscalYear = activeFiscalYear;
  data.initialInventory = initialInventory;
  data.productDefinitions = productDefinitions;
  data.seq = { id: seqId, doc: docSeq };
  data.batchCounter = batchCounter;
  data.materialClassification = materialClassification;
  data.bomFormulas = bomFormulas;
  data.productionOrders = productionOrders;
  data.orderSeq = orderSeq;
  data.appSettings = appSettings;
  data.activityLog = activityLog;
  data.pushSubscriptions = pushSubscriptions;
  data.sepidarInbox = sepidarInbox;
  data.stockCounts = stockCounts;
  data.stockCountSeq = stockCountSeq;
  data.itemLocations = itemLocations;
  data.minStock = minStock;
  data.productionTargets = productionTargets;
  data.productionTargetSeq = productionTargetSeq;
  writeDB(data);
  dataVersion = Date.now();
}

loadData();
if (pendingMigrationSave) { pendingMigrationSave = false; saveData(); }
rearmAutoBackup(); // اگه بکاپ خودکار از قبل فعال بوده، همون اول بالا اومدنِ سرور هم شروع بشه
ensurePushKeys();

// ============================================
// توابع کمکی
// ============================================
function deptName(id) {
  if (id === 'customer') return 'مشتری (خارج از کارخانه)';
  const dept = DEPTS.find(d => d.id === id);
  return dept ? dept.name : id;
}

function formatNumber(num) {
  if (num === undefined || num === null) return '0';
  return num.toLocaleString('fa-IR');
}

function generateBatchNumber() {
  const now = new Date();
  const dateStr = now.getFullYear().toString().slice(2) +
                  String(now.getMonth() + 1).padStart(2, '0') +
                  String(now.getDate()).padStart(2, '0');
  const batch = String(batchCounter++).padStart(4, '0');
  return `B${dateStr}${batch}`;
}

// شناسه‌ی سفارش تولید برای تب «پیش‌بینی تولید» - کاملاً جدا از batchNumber معمولی
// (پیشوند ORD-) تا با هم قاطی نشن؛ هیچ endpoint دیگه‌ای بهش وابسته نیست.
function generateOrderBatchId() {
  const now = new Date();
  const dateStr = now.getFullYear().toString().slice(2) +
                  String(now.getMonth() + 1).padStart(2, '0') +
                  String(now.getDate()).padStart(2, '0');
  const seq = String(orderSeq++).padStart(4, '0');
  return `ORD-${dateStr}-${seq}`;
}

// ============================================
// توابع بررسی زنجیره برای لغو
// ============================================
function findRelatedDocs(doc) {
  let related = [];
  
  const outputDocs = docs.filter(d => 
    d.type === 'output' && 
    d.fromUnit === doc.toUnit && 
    d.item === doc.item && 
    d.status === 'approved' &&
    d.batchNumber === doc.batchNumber
  );
  related = related.concat(outputDocs);
  
  const consumeDocs = docs.filter(d => 
    (d.type === 'consume' || d.type === 'waste') && 
    d.unit === doc.toUnit && 
    d.item === doc.item && 
    d.status === 'approved' &&
    d.batchNumber === doc.batchNumber
  );
  related = related.concat(consumeDocs);
  
  const returnDocs = docs.filter(d => 
    d.type === 'return' && 
    d.parentDocId === doc.id &&
    (d.status === 'return_pending' || d.status === 'return_approved')
  );
  related = related.concat(returnDocs);
  
  return related;
}

function findChainForDoc(docId, chain = []) {
  const doc = docs.find(d => d.id === docId);
  if (!doc) return chain;
  
  chain.push(doc.id);
  
  const related = findRelatedDocs(doc);
  for (const r of related) {
    if (!chain.includes(r.id)) {
      findChainForDoc(r.id, chain);
    }
  }
  
  return chain;
}

// ============================================
// API Routes
// ============================================

app.get('/api/depts', (req, res) => {
  res.json(DEPTS);
});

// رمزها و کلیدهای محرمانه هرگز به مرورگر نمی‌روند
function sanitizedData() {
  const a = data.appSettings || {};
  const appSettingsSafe = { ...a };
  if (a.sepidar) appSettingsSafe.sepidar = { ...a.sepidar, password: undefined };
  if (a.push) appSettingsSafe.push = { publicKey: a.push.publicKey };
  if (a.outputMessenger) { const { password, apiKey, token, secret, ...rest } = a.outputMessenger; appSettingsSafe.outputMessenger = rest; }
  return { ...data, users: (data.users || []).map(publicUser), appSettings: appSettingsSafe };
}
app.get('/api/data', (req, res) => {
  loadData();
  res.json(sanitizedData());
});

// ورود خودکار (SSO) از «دستور پرداخت» — نگاه کنید به توضیح DP_SSO_SECRET بالای فایل.
// توکن به‌شکل «payload_base64url.امضای_hex» است؛ payload یک JSON شامل {u: یوزرنیم, exp: زمان انقضا}.
app.get('/api/sso-verify', (req, res) => {
  const token = String(req.query.token || '');
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx < 1) return res.status(400).json({ error: 'توکن نامعتبر است' });

  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto.createHmac('sha256', DP_SSO_SECRET).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return res.status(401).json({ error: 'امضای توکن نامعتبر است' });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'توکن قابل خواندن نیست' });
  }
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
    return res.status(401).json({ error: 'توکن منقضی شده — دوباره از دستور پرداخت وارد شوید' });
  }

  loadData();
  const user = users.find(u => u.username === payload.u);
  if (!user) return res.status(404).json({ error: 'کاربر متناظر در این سامانه پیدا نشد' });

  res.setHeader('X-Auth-Token', newSession(user.username));
  res.json({ username: user.username, fullname: user.fullname, unit: user.unit, role: user.role });
});

// نسخه‌ی سبکِ بالا - کلاینت‌ها هر چند ثانیه همینو poll می‌کنن؛ فقط وقتی عدد عوض شده
// سراغ /api/data کامل می‌رن. loadData() لازم نیست چون dataVersion از حافظه خونده می‌شه
// (توسط saveData() به‌روز می‌مونه، نه از دیسک).
app.get('/api/data-version', (req, res) => {
  res.json({ version: dataVersion });
});

// ذخیره‌ی انبوه از کلاینت دیگر پذیرفته نمی‌شود. آخرین کاربردش (تب «تعریف محصول») حذف شد: تعریف محصولاتِ
// برش/لحیم/تزریق از فرمول سپیدار ساخته می‌شود و لیزر/بسته‌بندی هنگامِ تولید. صفحه‌های قدیمیِ باز که هنوز این
// مسیر را صدا می‌زنند، با این پاسخ نمی‌توانند تعریف محصولاتِ کهنه را روی سرور بنویسند.
app.post('/api/data', (req, res) => {
  res.status(410).json({ success: false, error: 'نسخه‌ی صفحه‌ی شما قدیمی است؛ صفحه را با Ctrl+F5 تازه کنید' });
});

// ============================================
// API های مدیریت کاربران
// ============================================

app.get('/api/users', (req, res) => {
  loadData();
  res.json(users.map(publicUser));
});

app.post('/api/users', (req, res) => {
  loadData();
  const newUser = req.body;
  if (!req.authUser || req.authUser.role !== 'admin') return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند کاربر اضافه کند' });
  if (!String(newUser.username || '').trim() || !String(newUser.password || '').trim()) return res.status(400).json({ success: false, error: 'یوزرنیم و رمز الزامی است' });
  
  if (users.find(u => u.username === newUser.username)) {
    return res.status(400).json({ success: false, error: 'یوزرنیم تکراری است' });
  }
  if (newUser.role && !['admin', 'supervisor', 'warehouse', 'user', 'viewer'].includes(newUser.role)) return res.status(400).json({ success: false, error: 'نقش نامعتبر است' });
  
  users.push({
    username: newUser.username,
    passwordHash: hashPassword(String(newUser.password).trim()),
    fullname: newUser.fullname || newUser.username,
    unit: newUser.unit || 'مدیریت',
    role: newUser.role || 'user'
  });

  saveData();
  logActivity(newUser.actorUsername, 'افزودن کاربر', `${newUser.username} (${newUser.role || 'user'})`);
  res.json({ success: true, user: publicUser(users[users.length - 1]) });
});

// ویرایشِ کاربر (نام، بخش، نقش، رمز). قبلاً کلاینت تغییر را با POST /api/data می‌فرستاد که سرور
// فقط «تعریف محصولات» را از آن قبول می‌کند؛ پس ویرایش در ظاهر موفق بود ولی ذخیره نمی‌شد و مدیر مجبور
// به حذف و ساختِ دوباره‌ی کاربر می‌شد (لاگ‌های A.Heshmati و m.azimi).
app.post('/api/users/:username/update', (req, res) => {
  try {
    loadData();
    const { actorUsername, fullname, unit, role, password } = req.body || {};
    if (!inboxActor(actorUsername, ['admin'])) return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند کاربر را ویرایش کند' });
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).json({ success: false, error: 'کاربر یافت نشد' });
    const ROLES = ['admin', 'supervisor', 'warehouse', 'user', 'viewer'];
    const UNITS = ['مدیریت', ...DEPTS.map(d => d.name)];
    if (fullname !== undefined && !String(fullname).trim()) return res.status(400).json({ success: false, error: 'نام کامل الزامی است' });
    if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ success: false, error: 'نقش نامعتبر است' });
    if (unit !== undefined && !UNITS.includes(unit)) return res.status(400).json({ success: false, error: 'بخش نامعتبر است' });
    if (user.username === 'admin' && role !== undefined && role !== 'admin') return res.status(400).json({ success: false, error: 'نقشِ کاربرِ admin قابل تغییر نیست' });
    const changes = [];
    if (fullname !== undefined && String(fullname).trim() !== user.fullname) { user.fullname = String(fullname).trim(); changes.push('نام'); }
    if (unit !== undefined && unit !== user.unit) { changes.push(`بخش: ${user.unit} ← ${unit}`); user.unit = unit; }
    if (role !== undefined && role !== user.role) { changes.push(`نقش: ${user.role} ← ${role}`); user.role = role; }
    if (password && String(password).trim()) { user.passwordHash = hashPassword(String(password).trim()); delete user.password; changes.push('رمز عبور'); }
    if (!changes.length) return res.json({ success: true, user: { username: user.username, fullname: user.fullname, unit: user.unit, role: user.role }, message: 'تغییری نبود' });
    saveData();
    logActivity(actorUsername, 'ویرایش کاربر', `${user.username} - ${changes.join('، ')}`);
    res.json({ success: true, user: { username: user.username, fullname: user.fullname, unit: user.unit, role: user.role } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/users/:username', (req, res) => {
  loadData();
  const username = req.params.username;
  if (!req.authUser || req.authUser.role !== 'admin') return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند کاربر حذف کند' });
  
  if (username === 'admin') {
    return res.status(400).json({ success: false, error: 'نمی‌توان ادمین را حذف کرد' });
  }
  
  const index = users.findIndex(u => u.username === username);
  if (index === -1) {
    return res.status(404).json({ success: false, error: 'کاربر یافت نشد' });
  }
  
  users.splice(index, 1);
  saveData();
  logActivity(req.query.actorUsername, 'حذف کاربر', username);
  res.json({ success: true, message: 'کاربر حذف شد' });
});

// ============================================
// API های مربوط به محصولات
// ============================================

app.get('/api/products/:dept', (req, res) => {
  loadData();
  const dept = req.params.dept;
  const products = productDefinitions[dept] || [];
  res.json(products);
});

// (POST /api/products/copy حذف شد - کپیِ محصول بین بخش‌ها دیگر لازم نیست؛ لیزر/بسته‌بندی هنگامِ تولید ساخته می‌شوند)

// ============================================
// فرمول‌های ساخت (BOM) — آپلود از سپیدار + دسته‌بندی مواد بر اساس مرحله
// ============================================
// نکته: سپیدار مفهوم «مرحله تولید» رو نمی‌شناسه، فقط فرمول تخت هر محصول رو می‌ده.
// این‌که کد ماده اولیه‌ی X مال کدوم مرحله (برش/لحیم/تزریق/لیزر/بسته‌بندی) هست،
// یه دسته‌بندی دستیه که فقط داخل همین سیستم نگه‌داری می‌شه (materialClassification).

// هسته‌ی مشترک پردازش ردیف‌های BOM - چه از اکسل بیاد چه مستقیم از کوئری SQL سپیدار.
// هر ردیف این شکل رو داره: {bomCode, productCode, productName, matCode, matName, unit, qty}
// اگه bomCode مقدار داشته باشه (کد رسمی فرمول از خودِ سپیدار)، همون کلید قطعی فرمول می‌شه -
// دیگه لازم نیست حدس بزنیم. اگه خالی باشه (مثلاً فایل اکسل قدیمی‌تر بدون این ستون)، به‌همون
// روش قبلی حدس می‌زنیم: اولین فرمولی که برای یه کد محصول دیده می‌شه همون کد رو می‌گیره،
// فرمول بعدی با نام متفاوت برای همون کد، کد-2 می‌گیره، بعدی کد-3 و ...
function ingestBomRows(rows) {
  const newBomFormulas = {};
  const unclassified = {}; // کد ماده -> نام ماده (موادی که هنوز دسته‌بندی نشدن)

  const formulaKeyByCodeAndName = {};
  const formulaVariantCountByCode = {};
  function resolveGuessedFormulaKey(productCode, productName) {
    const lookupKey = `${productCode}\u0000${productName}`;
    if (formulaKeyByCodeAndName[lookupKey]) return formulaKeyByCodeAndName[lookupKey];
    const variantIndex = (formulaVariantCountByCode[productCode] || 0) + 1;
    formulaVariantCountByCode[productCode] = variantIndex;
    const formulaKey = variantIndex === 1 ? productCode : `${productCode}-${variantIndex}`;
    formulaKeyByCodeAndName[lookupKey] = formulaKey;
    return formulaKey;
  }

  let newMaterialsAdded = 0;
  let rowsProcessed = 0;
  let rowsSkipped = 0;

  for (const row of rows) {
    const bomCode = String(row.bomCode ?? '').trim();
    const productCode = String(row.productCode ?? '').trim();
    const productName = String(row.productName ?? '').trim();
    const matCode = String(row.matCode ?? '').trim();
    const matName = String(row.matName ?? '').trim();
    const unit = String(row.unit ?? '').trim() || 'عدد';
    const qty = parseFloat(row.qty) || 0;

    if (!productCode || !matCode) { rowsSkipped++; continue; }
    rowsProcessed++;

    // اگه کد رسمی BOM موجود باشه همون کلید قطعیه؛ وگرنه با روش قدیمی حدس می‌زنیم
    const formulaKey = bomCode || resolveGuessedFormulaKey(productCode, productName);
    if (!newBomFormulas[formulaKey]) {
      newBomFormulas[formulaKey] = { name: productName, productCode, bomCode: bomCode || null, materials: [] };
    }

    const stage = materialClassification[matCode] || null;
    if (!stage) unclassified[matCode] = matName;

    // محافظ در برابر ردیف‌های تکراری (مثلاً از یه join نادرست توی Power Query که هر ردیف
    // رو چندبار تولید می‌کنه): اگه این ماده قبلاً دقیقاً با همین مقدار برای همین فرمول ثبت
    // شده، ردیف تکراری‌ست و نادیده گرفته می‌شه. اگه با مقدار متفاوت اومده، واقعاً یه ردیف
    // جدای فرمول سپیداره و باید جمع بشه.
    const existingMat = newBomFormulas[formulaKey].materials.find(m => m.code === matCode);
    if (existingMat) {
      if (Math.abs(existingMat.qty - qty) > 1e-9) {
        existingMat.qty += qty;
      }
    } else {
      newBomFormulas[formulaKey].materials.push({
        code: matCode, name: matName, unit, qty, stage: stage || 'نامشخص'
      });
    }

    if (!items.find(i => i.code === matCode)) {
      items.push({
        code: matCode,
        name: matName,
        unit: unit,
        groupCode: '---',
        groupName: 'مواد اولیه (فرمول سپیدار)',
        created: new Date().toISOString()
      });
      newMaterialsAdded++;
    }
    if (!(matCode in materialClassification)) {
      materialClassification[matCode] = null; // یعنی هنوز دسته‌بندی نشده - برای مدیریت بعدی ثبتش می‌کنیم
    }
  }

  return { newBomFormulas, unclassified, newMaterialsAdded, rowsProcessed, rowsSkipped };
}

app.post('/api/bom/upload', upload.single('file'), (req, res) => {
  try {
    loadData();
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'فایلی ارسال نشده است' });
    }

    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } catch (parseErr) {
      return res.status(400).json({ success: false, error: 'فایل اکسل قابل خواندن نیست: ' + parseErr.message });
    }

    if (!rows || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'فایل خالی است' });
    }

    // نرمال‌سازی کاراکترهای عربی/فارسی (ك عربی → ک فارسی، ي عربی → ی فارسی) و فاصله‌های اضافه
    // چون هدرهای اکسل سپیدار گاهی از حروف عربی استفاده می‌کنن که چشمی یکی به‌نظر می‌رسن
    // ولی از نظر کد یکی نیستن و باعث می‌شن تطبیق دقیق رشته‌ای شکست بخوره.
    function normalizeHeader(s) {
      return String(s ?? '')
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/\u200c/g, ' ') // نیم‌فاصله را هم فاصله در نظر بگیر برای تطبیق هدر
        .trim()
        .replace(/\s+/g, ' ');
    }

    const required = ['کد محصول', 'محصول', 'کد مواد اولیه', 'مواد اولیه', 'واحد', 'تعداد مواد اولیه'];
    const firstRowKeys = Object.keys(rows[0]);
    // نگاشت هدر نرمال‌شده → هدر واقعی توی فایل (برای خوندن مقدار هر ردیف با همون کلید اصلی)
    const headerMap = {};
    firstRowKeys.forEach(k => { headerMap[normalizeHeader(k)] = k; });
    const missing = required.filter(c => !(c in headerMap));
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: `ستون‌های زیر در فایل یافت نشد: ${missing.join('، ')}\nستون‌های موجود: ${firstRowKeys.join('، ')}`
      });
    }
    // «کد BOM» اختیاریه - اگه فایل قدیمی‌تر این ستون رو نداشته باشه، همچنان با روش قدیمی
    // (حدس‌زدن از روی کد محصول + نام) کار می‌کنه؛ فقط اگه باشه دقیق‌تره.
    const hasBomCodeColumn = 'کد BOM' in headerMap;

    const normalizedRows = rows.map(row => ({
      bomCode: hasBomCodeColumn ? row[headerMap['کد BOM']] : '',
      productCode: row[headerMap['کد محصول']],
      productName: row[headerMap['محصول']],
      matCode: row[headerMap['کد مواد اولیه']],
      matName: row[headerMap['مواد اولیه']],
      unit: row[headerMap['واحد']],
      qty: row[headerMap['تعداد مواد اولیه']]
    }));

    const { newBomFormulas, unclassified, newMaterialsAdded, rowsProcessed, rowsSkipped } = ingestBomRows(normalizedRows);

    const productsProcessed = Object.keys(newBomFormulas).length;
    // مثل بقیه sync ها، فرمول‌های قبلی با نسخه جدید آپلودی جایگزین می‌شن
    replaceBomFormulas(newBomFormulas);
    // تعریف محصولات هر بخش رو هم خودکار با فرمول جدید هماهنگ کن
    const rebuildCounts = rebuildProductDefinitionsFromBOM();

    saveData();

    res.json({
      success: true,
      productsProcessed,
      rowsProcessed,
      rowsSkipped,
      newMaterialsAdded,
      usedOfficialBomCode: hasBomCodeColumn,
      unclassifiedMaterials: Object.entries(unclassified).map(([code, name]) => ({ code, name })),
      rebuildCounts,
      message: `${productsProcessed} فرمول محصول از ${rowsProcessed} ردیف پردازش شد` + (rebuildCounts.inactiveKept ? ` - ${rebuildCounts.inactiveKept} محصول که دیگر در سپیدار فعال نیست به‌خاطرِ موجودیِ باقی‌مانده «غیرفعال» نگه داشته شد` : '')
    });
  } catch (err) {
    console.error('خطا در پردازش فایل BOM:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// سینک مستقیم فرمول‌های ساخت از دیتابیس سپیدار (بدون نیاز به اکسپورت/آپلود دستی اکسل)
// دقیقاً همون داده‌ای که کوئری Power Query کاربر می‌گرفت: join بین WKO.vwProductFormula
// (فرمول‌های فعال) و WKO.vwFormulaBomItem (مواد هر فرمول) روی ProductFormulaRef=ProductFormulaID
app.post('/api/bom/sync-from-sepidar', async (req, res) => {
  try {
    loadData();
    const pool = await connectToSepidar();
    if (!pool) {
      return res.status(502).json({ success: false, error: 'اتصال به دیتابیس سپیدار برقرار نشد' });
    }

    const query = `
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
    `;
    const sqlResult = await pool.request().query(query);
    const rawRows = sqlResult.recordset || [];
    if (rawRows.length === 0) {
      return res.status(400).json({ success: false, error: 'هیچ ردیف فعالی از فرمول‌های سپیدار برنگشت' });
    }

    const normalizedRows = rawRows.map(r => ({
      bomCode: r.BomCode,
      productCode: r.ProductCode,
      productName: r.ProductName,
      matCode: r.MatCode,
      matName: r.MatName,
      unit: r.Unit,
      qty: r.Qty
    }));

    const { newBomFormulas, unclassified, newMaterialsAdded, rowsProcessed, rowsSkipped } = ingestBomRows(normalizedRows);

    const productsProcessed = Object.keys(newBomFormulas).length;
    replaceBomFormulas(newBomFormulas);
    const rebuildCounts = rebuildProductDefinitionsFromBOM();

    saveData();

    res.json({
      success: true,
      productsProcessed,
      rowsProcessed,
      rowsSkipped,
      newMaterialsAdded,
      usedOfficialBomCode: true,
      unclassifiedMaterials: Object.entries(unclassified).map(([code, name]) => ({ code, name })),
      rebuildCounts,
      message: `${productsProcessed} فرمول محصول از ${rowsProcessed} ردیف مستقیم از سپیدار سینک شد` + (rebuildCounts.inactiveKept ? ` - ${rebuildCounts.inactiveKept} محصول که دیگر در سپیدار فعال نیست به‌خاطرِ موجودیِ باقی‌مانده «غیرفعال» نگه داشته شد` : '')
    });
  } catch (err) {
    console.error('خطا در سینک مستقیم BOM از سپیدار:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// لیست همه موادی که یا دسته‌بندی شدن یا از یه فرمول آپلودی اومدن (برای مدیریت دسته‌بندی)
app.get('/api/materials/classification', (req, res) => {
  loadData();
  const codes = new Set(Object.keys(materialClassification));
  Object.values(bomFormulas).forEach(f => f.materials.forEach(m => codes.add(m.code)));

  const list = [...codes].map(code => {
    const item = items.find(i => i.code === code);
    let name = item ? item.name : code;
    let unit = item ? item.unit : '';
    if (!item) {
      for (const f of Object.values(bomFormulas)) {
        const m = f.materials.find(mm => mm.code === code);
        if (m) { name = m.name; unit = m.unit; break; }
      }
    }
    return { code, name, unit, stage: materialClassification[code] || null };
  });
  list.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
  res.json(list);
});

// تنظیم مرحله یک ماده اولیه (cut/solder/inject/laser/pack یا null = نامشخص)
// فقط کابلِ خام (واحدِ «متر» در فرمول، و خودش محصولِ تولیدی نیست) برش می‌خورد
function isCuttableMaterial(code, unit) {
  if (Object.values(bomFormulas).some(f => f.productCode === code)) return false;
  const u = unit || (Object.values(bomFormulas).flatMap(f => f.materials).find(m => m.code === code) || {}).unit || (items.find(i => i.code === code) || {}).unit || '';
  return /متر/.test(String(u));
}
app.post('/api/materials/classification', (req, res) => {
  try {
    loadData();
    const { code, stage } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'کد ماده الزامی است' });
    const validStages = ['cut', 'solder', 'inject', 'laser', 'pack', null, ''];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ success: false, error: 'مرحله نامعتبر است' });
    }
    const finalStage = stage || null;
    // «برش» فقط برای کابلِ خام است؛ کالایی که خودش فرمولِ تولید دارد (مثلاً کابلِ آماده داخلِ پاوربانک) برش نمی‌خورد
    if (finalStage === 'cut' && !isCuttableMaterial(code)) {
      return res.status(400).json({ success: false, error: `«${resolveItemName(code)}» کابلِ خام (متری) نیست و برش نمی‌خورد؛ اگر کالای آماده‌ای است که داخلِ بسته‌ی محصولِ دیگری می‌رود، مرحله‌اش را «بسته‌بندی» بگذارید` });
    }
    materialClassification[code] = finalStage;
    for (const pCode in bomFormulas) {
      bomFormulas[pCode].materials.forEach(m => {
        if (m.code === code) m.stage = finalStage || 'نامشخص';
      });
    }
    saveData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// لیست خلاصه همه فرمول‌های آپلودشده
app.get('/api/bom', (req, res) => {
  loadData();
  const productCodes = new Set(Object.values(bomFormulas).map(f => f.productCode));
  const list = Object.entries(bomFormulas).map(([formulaKey, f]) => ({
    // formulaKey همون کلیدیه که برای همه‌ی endpointهای دیگه (suggest/detail و...) لازمه -
    // اگه از سینک مستقیم سپیدار اومده باشه، دقیقاً «کد BOM» رسمیه؛ وگرنه (فایل قدیمی بدون
    // این ستون) به شکل حدسی کد/کد-2/کد-3 ساخته شده.
    formulaKey,
    bomCode: f.bomCode || null,
    productCode: f.productCode,
    name: f.name,
    materialsCount: f.materials.length,
    isCable: /كابل|کابل/.test(f.name || '') || f.materials.some(m => m.stage === 'cut' && !productCodes.has(m.code) && /متر/.test(String(m.unit || ''))),
    // موادی که مرحله‌ی تولیدشان هنوز تعیین نشده (در جزئیات «⚠️ نامشخص»)
    unclassified: f.materials.filter(m => !['cut', 'solder', 'inject', 'laser', 'pack'].includes(m.stage)).map(m => ({ code: m.code, name: m.name }))
  }));
  res.json(list);
});

// نگاشت معکوس: هر «کد قطعه‌ی برش‌خورده» (CUT-{کدماده}-{طول}) به لیست محصولات نهاییِ
// BOM که توی فرمولشون همین قطعه رو به‌عنوان ماده‌ی stage=cut نیاز دارن. کلاینت
// bomFormulas رو خودش نداره (فقط سرور توی حافظه نگهش می‌داره)، برای همین این
// محاسبه (که برای تب «پیش‌بینی تولید» لازمه) سمت سرور انجام می‌شه، نه کلاینت.
app.get('/api/bom/cut-index', (req, res) => {
  loadData();
  const cutIndex = {};
  Object.entries(bomFormulas).forEach(([formulaKey, f]) => {
    f.materials
      .filter(m => m.stage === 'cut')
      .forEach(m => {
        const lengthCm = Math.round((m.qty || 0) * 100);
        const cutCode = `CUT-${m.code}-${lengthCm}`;
        if (!cutIndex[cutCode]) cutIndex[cutCode] = [];
        cutIndex[cutCode].push({
          formulaKey,
          productCode: f.productCode || null,
          name: f.name
        });
      });
  });
  res.json(cutIndex);
});

// گزارش وضعیت مواد اولیه‌ی هر مرحله (برش/لحیم/تزریق/لیزر/بسته‌بندی) به ازای همه‌ی فرمول‌های
// سیستم - برای پنل مدیریتیِ تب «پیش‌بینی تولید». فقط موادِ خامِ مستقیمِ همون مرحله رو در نظر
// می‌گیره (نه ورودی‌های میان‌مرحله‌ای مثل CUT-...)، چون آن‌ها نیمه‌ساخته‌ی داخلی‌ان و پیشرفتشون
// از جای دیگه (ردیابی سفارش) دیده می‌شه.
app.get('/api/bom/material-availability', (req, res) => {
  loadData();
  const stagesList = ['cut', 'solder', 'inject', 'laser', 'pack'];
  const rawInv = inventory.raw || {};

  const report = Object.entries(bomFormulas).map(([formulaKey, f]) => {
    const stages = {};
    stagesList.forEach(dept => {
      const mats = f.materials.filter(m => m.stage === dept);
      if (mats.length === 0) { stages[dept] = null; return; }
      const deptInv = inventory[dept] || {};
      const detail = mats.map(m => {
        const ownQty = pvStockForFormula(deptInv, m.code, f);
        const rawQty = pvStockForFormula(rawInv, m.code, f);
        const maxFromOwn = m.qty > 0 ? Math.floor(ownQty / m.qty + 1e-6) : Infinity;
        return { code: m.code, name: m.name, unit: m.unit, qtyPerUnit: m.qty, ownQty, rawQty, maxFromOwn };
      });
      const producibleQty = Math.min(...detail.map(d => d.maxFromOwn));
      stages[dept] = {
        status: producibleQty >= 1 ? 'sufficient' : 'insufficient',
        producibleQty: Number.isFinite(producibleQty) ? producibleQty : 0,
        materials: detail
      };
    });
    const hasUnclassified = f.materials.some(m => !m.stage || m.stage === 'نامشخص');
    return { formulaKey, productCode: f.productCode || null, name: f.name, hasUnclassified, stages };
  });

  res.json(report);
});

// فرمول یک محصول، تفکیک‌شده بر اساس مرحله - برای پیش‌پرکردن سند تولید هر بخش
app.get('/api/bom/:code', (req, res) => {
  loadData();
  const formula = bomFormulas[req.params.code];
  if (!formula) return res.status(404).json({ success: false, error: 'فرمولی برای این کد یافت نشد' });
  const byStage = { cut: [], solder: [], inject: [], laser: [], pack: [], 'نامشخص': [] };
  formula.materials.forEach(m => {
    const key = byStage[m.stage] ? m.stage : 'نامشخص';
    byStage[key].push(m);
  });
  res.json({
    formulaKey: req.params.code,
    bomCode: formula.bomCode || null,
    productCode: formula.productCode,
    name: formula.name,
    materials: formula.materials,
    byStage
  });
});

// بازسازی تعریف محصولات هر بخش از روی فرمول‌های آپلودشده سپیدار
// لحیم و تزریق روی «محصول نهایی» کار می‌کنن (کدشون همون کد محصول سپیداره) و چیزی به کالا
// اضافه نمی‌کنن که هویتش رو عوض کنه - برای همین خودکار و از روی فرمول بازسازی می‌شن.
// برش هم استثناست (خروجیش طول مشخصی از یه ماده خامه) و خودکار از روی فرمول می‌سازیمش.
// لیزر و بسته‌بندی دیگه اینجا دست نمی‌خورن: هردو یه اطلاعات واقعی و متمایزکننده اضافه
// می‌کنن (لیزر: برند مشخص؛ بسته‌بندی: نوع پک) که فقط با «کپی از بخش دیگر»
// (POST /api/products/copy) و با کد واقعی سپیدار قابل تعریفه، نه با حدسِ خودکار از فرمول -
// وگرنه هر بار sync/رفرش BOM محصولات برند/پک‌دارِ دستیِ کاربر پاک می‌شد.
function rebuildProductDefinitionsFromBOM() {
  const counts = {};
  const AUTO_STAGES = ['cut', 'solder', 'inject'];
  const oldDefs = {};
  AUTO_STAGES.forEach(d => { oldDefs[d] = productDefinitions[d] || []; productDefinitions[d] = []; counts[d] = 0; });

  // لحیم و تزریق: یک محصول به‌ازای هر «کد سپیدار» (نه هر فرمول) - SOL-{کد} / INJ-{کد}.
  // اگر یک کالا چند فرمولِ فعال داشته باشد (کابل داخلی/وارداتی)، همه در formulaKeys می‌آیند و
  // فرمول موقع تولید انتخاب می‌شود. کدِ فرمول ممکن است در سپیدار عوض شود، کدِ کالا نه - برای همین کلید کدِ کالاست.
  const productCodes = [...new Set(Object.values(bomFormulas).map(f => f.productCode).filter(Boolean))].sort();
  const SAME_CODE_STAGES = ['solder', 'inject'];
  productCodes.forEach(pc => {
    const fks = formulaKeysOfProductCode(pc);
    const baseName = sepidarBaseName(pc, fks);
    SAME_CODE_STAGES.forEach(stage => {
      productDefinitions[stage].push({
        code: STAGE_CODE_PREFIX[stage] + pc,
        productCode: pc,
        sepidarName: baseName,
        name: baseName + STAGE_NAME_SUFFIX[stage],
        formulaKeys: fks,
        group: stage,
        unit: 'عدد',
        created: new Date().toISOString()
      });
      counts[stage]++;
    });
  });

  // لیزر/بسته‌بندی دستی تعریف می‌شوند (برند/نوع پک)، فقط فهرستِ فرمول‌ها و نامِ سپیدارشان هم‌گام می‌شود
  ['laser', 'pack'].forEach(stage => {
    (productDefinitions[stage] || []).forEach(p => {
      if (!p.productCode) return;
      const fresh = formulaKeysOfProductCode(p.productCode);
      if (fresh.length) {
        p.formulaKeys = fresh; p.baseFormulaCode = fresh[0];
        delete p.inactive; delete p.inactiveSince;
      } else if (!p.inactive) {
        p.inactive = true; p.inactiveSince = new Date().toISOString(); // فرمول‌های قبلی (بایگانی) می‌مانند
      }
      p.sepidarName = sepidarBaseName(p.productCode, p.formulaKeys);
    });
  });
  counts.laser = (productDefinitions.laser || []).length;
  counts.pack = (productDefinitions.pack || []).length;

  const cutSeen = new Map(); // key: کد ماده + طول -> محصول برش
  for (const code in bomFormulas) {
    const f = bomFormulas[code];
    f.materials.forEach(m => {
      if (m.stage !== 'cut') return;
      if (productCodes.includes(m.code) || !/متر/.test(String(m.unit || ''))) return; // فقط کابلِ خامِ متری برش می‌خورد (نه کابلِ آماده‌ی داخلِ پاوربانک)
      const qty = m.qty || 0;
      const qtyKey = Math.round(qty * 1000); // برای جلوگیری از خطای اعشاری در مقایسه طول‌ها
      const key = `${m.code}_${qtyKey}`;
      if (cutSeen.has(key)) return;
      const lengthCm = Math.round(qty * 100);
      cutSeen.set(key, {
        code: `CUT-${m.code}-${lengthCm}`,
        name: `${m.name} - ${lengthCm} سانت`,
        group: 'cut',
        unit: 'عدد',
        // اطلاعات مادهٔ خام مبدأ رو روی خودِ محصول برش نگه می‌داریم تا موقع ثبت تولید
        // نیازی به رفتن سراغ فرمول محصول نهایی نباشه (تبدیل ماده خام به قطعهٔ برش‌خورده ۱ به ۱ است)
        rawMaterialCode: m.code,
        rawMaterialName: m.name,
        rawMaterialUnit: m.unit,
        rawMaterialQtyPerUnit: qty,
        created: new Date().toISOString()
      });
    });
  }
  productDefinitions.cut = [...cutSeen.values()];
  counts.cut = productDefinitions.cut.length;

  // محصولاتی که دیگر در فرمول‌های فعال نیستند ولی هنوز موجودی/سندِ باز دارند → «غیرفعال در سپیدار» می‌مانند
  // «در استفاده» یعنی موجودی/سندِ باز دارد، یا ورودیِ مرحله‌ی قبلش هنوز در خط مانده (تا باقی‌مانده تمام شود):
  // برش ← خودش؛ لحیم ← خودش یا CUT-ِ فرمولش؛ تزریق ← خودش یا SOL-ِ همان کالا
  counts.inactiveKept = 0; counts.removed = 0;
  const keptCodes = new Set();
  const needed = (d, p) => {
    if (stageCodeInUse(p.code)) return true;
    if (d === 'solder') return (p.formulaKeys || []).some(k => { const f = getFormula(k); return f && f.materials.some(m => m.stage === 'cut' && keptOrActive(`CUT-${m.code}-${Math.round((m.qty || 0) * 100)}`)); });
    if (d === 'inject') return p.productCode ? keptOrActive(STAGE_CODE_PREFIX.solder + p.productCode) : false;
    return false;
  };
  const keptOrActive = c => stageCodeInUse(c);
  AUTO_STAGES.forEach(d => {
    const now = new Set(productDefinitions[d].map(p => p.code));
    oldDefs[d].forEach(p => {
      if (now.has(p.code)) return;
      if (needed(d, p)) {
        keptCodes.add(p.code);
        productDefinitions[d].push({ ...p, inactive: true, inactiveSince: p.inactiveSince || new Date().toISOString() });
        counts.inactiveKept++;
      } else counts.removed++;
    });
  });
  // فرمولِ بایگانی‌ای که دیگر هیچ محصولی به آن اشاره ندارد پاک می‌شود
  if (appSettings && appSettings.archivedFormulas) {
    const used = new Set();
    Object.values(productDefinitions).forEach(l => (l || []).forEach(p => (p.formulaKeys || []).forEach(k => used.add(k))));
    Object.keys(appSettings.archivedFormulas).forEach(k => { if (!used.has(k) || bomFormulas[k]) delete appSettings.archivedFormulas[k]; });
  }

  return counts;
}

// پاک کردن کامل همه چیزهای مربوط به BOM (فرمول‌ها، دسته‌بندی مواد، تعریف محصولات ۵ بخش، مواد اولیه وارداتی)
app.post('/api/bom/clear-all', (req, res) => {
  try {
    loadData();
    const formulasCleared = Object.keys(bomFormulas).length;
    const classificationsCleared = Object.keys(materialClassification).length;
    const importedMaterialCodes = new Set();
    Object.values(bomFormulas).forEach(f => f.materials.forEach(m => importedMaterialCodes.add(m.code)));
    const materialsRemoved = items.filter(i => i.groupName === 'مواد اولیه (فرمول سپیدار)').length;
    const stageProductsRemoved = STAGE_DEPTS.reduce((sum, d) => sum + (productDefinitions[d] || []).length, 0);

    bomFormulas = {};
    materialClassification = {};
    STAGE_DEPTS.forEach(d => { productDefinitions[d] = []; });
    items = items.filter(i => i.groupName !== 'مواد اولیه (فرمول سپیدار)');

    saveData();
    res.json({
      success: true,
      formulasCleared,
      classificationsCleared,
      materialsRemoved,
      stageProductsRemoved,
      message: 'همه جدول‌های مربوط به BOM سپیدار کاملاً پاک شد'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/products/rebuild-from-bom', (req, res) => {
  try {
    loadData();
    if (Object.keys(bomFormulas).length === 0) {
      return res.status(400).json({ success: false, error: 'هنوز هیچ فرمولی از سپیدار آپلود نشده است' });
    }
    const counts = rebuildProductDefinitionsFromBOM();
    saveData();
    res.json({
      success: true,
      counts,
      message: `تعریف محصولات ${STAGE_DEPTS.length} بخش (برش، لحیم، تزریق، لیزر، بسته‌بندی) از روی فرمول‌های سپیدار بازسازی شد`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// فرمول پیشنهادی مصرف مواد یک محصول در یک بخش مشخص - برای پیش‌پرکردن فرم تولید
// :code = کدِ محصولِ همان بخش (CUT-/SOL-/INJ-/LASER-/PACK-). برای سازگاری، کلیدِ فرمول هم پذیرفته می‌شود.
// ?formula= (اختیاری) فرمولِ انتخابی وقتی کالا چند فرمول دارد؛ اگر نیاید، فرمولی که موادش در همین بخش
// موجود است خودکار انتخاب می‌شود. «code»ِ هر ماده در پاسخ، دقیقاً کلیدِ موجودیِ آن ماده است.
app.get('/api/bom/suggest/:dept/:code', (req, res) => {
  loadData();
  const { dept } = req.params;
  // رنگ: کدِ رنگی (…@مشکی) یعنی محصولِ همان رنگ؛ ورودیِ زنجیره (برش/لحیم/تزریق/لیزر) هم از همان رنگ برداشته می‌شود
  const csplit = splitColor(req.params.code);
  const code = csplit.base;
  const color = csplit.colorSlug ? colorBySlug(csplit.colorSlug) : DEFAULT_COLOR;
  if (!color) return res.status(400).json({ success: false, error: 'رنگِ نامعتبر - فهرستِ رنگ‌ها در «تنظیمات» است' });
  const colorName = n => color === DEFAULT_COLOR ? n : `${n} - ${color}`;
  const qty = parseFloat(req.query.qty) || 1;
  const r4 = v => Math.round(v * 10000) / 10000;
  const inv = inventory[dept] || {};

  // بخش برش استثناست: «محصول»ش خودش دقیقاً یه مادهٔ خام با یه طول مشخصه (بدون تغییر نسبت به قبل)
  if (dept === 'cut') {
    const cutProduct = (productDefinitions.cut || []).find(p => p.code === code);
    if (!cutProduct) {
      return res.status(404).json({ success: false, error: 'این محصول برش در سیستم تعریف نشده (BOM سپیدار رو آپلود/بازسازی کردید؟)' });
    }
    const materials = [{
      code: cutProduct.rawMaterialCode,
      name: cutProduct.rawMaterialName,
      unit: cutProduct.rawMaterialUnit,
      qtyPerUnit: cutProduct.rawMaterialQtyPerUnit,
      suggestedQty: r4(cutProduct.rawMaterialQtyPerUnit * qty)
    }];
    const ck = withColor(code, color);
    return res.json({ success: true, code: ck, name: colorName(cutProduct.name), color, dept, productStockKey: ck, materials, unclassifiedMaterials: [], hasUnclassified: false, formulaKey: null, formulaOptions: [] });
  }

  if (!['solder', 'inject', 'laser', 'pack'].includes(dept)) {
    return res.status(400).json({ success: false, error: 'برای این بخش فرمول تولید تعریف نشده است' });
  }
  const defs = productDefinitions[dept] || [];
  const def = defs.find(p => p.code === code) || virtualStageDef(dept, code) || defs.find(p => formulaKeysOfDef(p).includes(code));
  if (!def) {
    return res.status(404).json({ success: false, error: 'این محصول در تعریف محصولاتِ این بخش نیست (BOM سپیدار رو سینک/بازسازی کردید؟)' });
  }
  const fks = formulaKeysOfDef(def);
  if (!fks.length) {
    return res.status(404).json({ success: false, error: 'فرمولِ فعالی در سپیدار برای این محصول پیدا نشد' });
  }
  const pc = def.productCode || (getFormula(fks[0]) && getFormula(fks[0]).productCode);

  // ورودیِ زنجیره‌ای هر مرحله (محصولِ مرحله‌ی قبل) - همیشه با کدِ موجودیِ همان مرحله
  const chainInput = (formula) => {
    if (dept === 'solder') {
      return formula.materials.filter(m => m.stage === 'cut').map(m => {
        const lengthCm = Math.round((m.qty || 0) * 100);
        const cutCode = `CUT-${m.code}-${lengthCm}`;
        const cutProduct = (productDefinitions.cut || []).find(p => p.code === cutCode);
        return { code: cutCode, name: cutProduct ? cutProduct.name : `${m.name} - ${lengthCm} سانت`, unit: 'عدد', qtyPerUnit: 1 };
      });
    }
    if (dept === 'inject') {
      const src = (productDefinitions.solder || []).find(p => p.code === STAGE_CODE_PREFIX.solder + pc);
      return [{ code: STAGE_CODE_PREFIX.solder + pc, name: src ? src.name : `${def.sepidarName || pc}${STAGE_NAME_SUFFIX.solder}`, unit: 'عدد', qtyPerUnit: 1 }];
    }
    if (dept === 'laser') {
      const src = (productDefinitions.inject || []).find(p => p.code === STAGE_CODE_PREFIX.inject + pc);
      return [{ code: STAGE_CODE_PREFIX.inject + pc, name: src ? src.name : `${def.sepidarName || pc}${STAGE_NAME_SUFFIX.inject}`, unit: 'عدد', qtyPerUnit: 1 }];
    }
    // بسته‌بندی: محصولِ لیزرِ «همان برند» (قبلاً همیشه اولین برند، یعنی A2، برداشته می‌شد)
    const lc = def.brand ? laserCode(pc, def.brand) : null;
    const src = lc ? (productDefinitions.laser || []).find(p => p.code === lc) : null;
    return lc ? [{ code: lc, name: src ? src.name : `${def.sepidarName || pc} - ${def.brand}`, unit: 'عدد', qtyPerUnit: 1 }] : [];
  };
  const coloredChain = (formula, c) => chainInput(formula).map(m => ({ ...m, code: withColor(m.code, c), name: c === DEFAULT_COLOR ? m.name : `${m.name} - ${c}` }));
  const build = (fk) => {
    const formula = getFormula(fk);
    const own = formula.materials.filter(m => m.stage === dept)
      .map(m => {
        // پکِ سفارشی: از نسخه‌ی همان «برند پک» و همان نوعِ کابل مصرف می‌شود (نه از کدِ کلیِ سپیدار)
        if (dept === 'pack' && isPackVariantBase(m.code)) {
          const cable = cableTypeOfFormula(formula), pb = def.packType || def.brand;
          const v = cable && pb ? parsePackVariant(packVariantKey(m.code, pb, cable)) : null;
          if (v) return { code: v.key, name: v.name, unit: m.unit, qtyPerUnit: m.qty, packVariantOf: m.code };
        }
        return { code: m.code, name: m.name, unit: m.unit, qtyPerUnit: m.qty };
      });
    const materials = [...own, ...coloredChain(formula, color)].map(m => ({ ...m, suggestedQty: r4(m.qtyPerUnit * qty) }));
    const unclassifiedMaterials = formula.materials.filter(m => !m.stage || m.stage === 'نامشخص').map(m => ({ code: m.code, name: m.name }));
    const ready = materials.length > 0 && unclassifiedMaterials.length === 0 && materials.every(m => (inv[m.code] || 0) > 0);
    return { fk, formula, materials, unclassifiedMaterials, ready };
  };
  let options = fks.map(build);
  // فرمول از روی لات‌های ورودی: کالای لحیم/تزریق/لیزرِ موجود در این بخش می‌داند از کدام فرمول (نوعِ کابل) است؛
  // اگر همه‌ی موجودیِ ورودی یک فرمول است فقط همان پیشنهاد می‌شود، وگرنه اولِ صف (FIFO) پیش‌فرض است.
  let lotFormula = null;
  if (['inject', 'laser', 'pack'].includes(dept) && fks.length > 1) {
    const chainKey = (coloredChain(getFormula(fks[0]), color)[0] || {}).code;
    if (chainKey) {
      const { lots, batchFk } = buildLotLedger();
      const L = (lots.get(dept + '|' + chainKey) || []).slice().sort((a, b) => a.seq - b.seq);
      const byFk = {}; let unknown = 0; let first = null;
      L.forEach(l => { const f = batchFk.get(l.batch); if (f && fks.includes(f)) { byFk[f] = (byFk[f] || 0) + l.qty; if (!first) first = f; } else unknown += l.qty; });
      const known = Object.keys(byFk);
      if (known.length) {
        lotFormula = { byFk, unknown: Math.round(unknown * 1e6) / 1e6, first, locked: known.length === 1 && unknown < 1e-9 };
        options.forEach(o => { o.lotQty = byFk[o.fk] || 0; });
        if (lotFormula.locked) options = options.filter(o => o.fk === known[0]);
      }
    }
  }
  const requested = req.query.formula && options.find(o => o.fk === req.query.formula);
  // اولویت: فرمولِ درخواستی → فرمولی که با همین رنگ آماده است → فرمولی که با رنگِ دیگری آماده است (فرم رنگ را عوض می‌کند)
  const readyInAnyColor = o => colorList().some(c => { const ch = coloredChain(o.formula, c); return ch.length > 0 && ch.every(m => (inv[m.code] || 0) > 0); })
    && o.unclassifiedMaterials.length === 0 && o.materials.filter(m => !isStageKey(m.code)).every(m => (inv[m.code] || 0) > 0);
  const chosen = requested || (lotFormula && lotFormula.first && options.find(o => o.fk === lotFormula.first)) || options.find(o => o.ready) || options.find(readyInAnyColor) || options[0];
  let warn = def.brand || dept !== 'pack' ? null : 'این محصولِ بسته‌بندی برند ندارد؛ آن را از «ساخت از بخش دیگر» (مبدأ: لیزر) دوباره بسازید';
  if (dept === 'pack' && chosen.materials.some(m => isPackVariantBase(m.code))) warn = (warn ? warn + '\n' : '') + 'نوعِ کابلِ این فرمول برای «پک سفارشی» مشخص نشد؛ از کدِ کلیِ پک مصرف می‌شود';
  // کدام رنگ‌ها ورودیِ زنجیره‌شان (با فرمولِ انتخاب‌شده) در این بخش موجود است - برای انتخابِ خودکارِ رنگ در فرم
  const colorAvailability = colorList().map(c => {
    const chain = coloredChain(chosen.formula, c);
    return { color: c, ready: chain.length > 0 && chain.every(m => (inv[m.code] || 0) > 0), qty: chain.length ? Math.min(...chain.map(m => inv[m.code] || 0)) : 0 };
  });
  const ck = withColor(def.code, color);
  res.json({
    success: true, code: ck, name: colorName(def.name), color, colorAvailability, dept, productStockKey: ck, productCode: pc || null,
    materials: chosen.materials, unclassifiedMaterials: chosen.unclassifiedMaterials, hasUnclassified: chosen.unclassifiedMaterials.length > 0,
    formulaKey: chosen.fk,
    formulaOptions: options.map(o => ({ key: o.fk, name: o.formula.name + (lotFormula && !lotFormula.locked ? ` — موجودیِ این نوع: ${formatNumber(o.lotQty || 0)}` : ''), ready: o.ready })),
    formulaFromLots: lotFormula ? { locked: lotFormula.locked, unknown: lotFormula.unknown } : null,
    warning: warn
  });
});

// ============================================
// API برای «پیش‌بینی تولید» - سفارش‌های در حال ردیابی
// ============================================
// یه سفارش سبک می‌سازه (فقط برای نمایش/ردیابی توی تب پیش‌بینی تولید) و یه orderBatchId
// برمی‌گردونه که کلاینت می‌تونه (اختیاری، دستی) روی سندهای بعدیِ همین سفارش بذاره.
// این هیچ اثری روی موجودی یا منطق دیگه‌ی سیستم نداره.
app.post('/api/production-orders', (req, res) => {
  try {
    const { targetFormulaKey, targetProductCode, targetProductName } = req.body;
    if (!targetFormulaKey || !targetProductName) {
      return res.status(400).json({ success: false, error: 'کد فرمول و نام محصول هدف الزامی است' });
    }

    loadData();

    const orderBatchId = generateOrderBatchId();
    const order = {
      id: orderSeq,
      orderBatchId,
      targetFormulaKey,
      targetProductCode: targetProductCode || null,
      targetProductName,
      startedAt: new Date().toLocaleDateString('fa-IR'),
      startedBy: 'سیستم',
      status: 'open'
    };
    productionOrders.push(order);

    saveData();

    res.json({ success: true, order, orderBatchId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// API برای ثبت سند تولید
// ============================================
// ============================================
// اعتبارسنجی ورودیِ حرکت‌های موجودی (سمت سرور)
// ============================================
// رابط کاربری جلوی بیشترِ ورودی‌های غلط رو می‌گیره، ولی سرور نباید فقط به کلاینت اعتماد کنه: مقدارِ
// رشته‌ای ("5") موجودی رو متن می‌کرد، مقدارِ منفی موجودی رو منفی می‌کرد و بخش/کالای ناشناس موجودیِ شبح می‌ساخت.
function knownItemCode(unit, code) {
  if (typeof code !== 'string' || !code) return false;
  if (items.some(i => i.code === code)) return true;
  if (code.includes(PV_SEP)) return !!parsePackVariant(code);
  if (inventory[unit] && Object.prototype.hasOwnProperty.call(inventory[unit], code)) return true;
  if (Object.values(productDefinitions || {}).some(list => (list || []).some(p => p.code === code || p.productCode === code))) return true;
  return splitColor(code).colorSlug ? !!findDefByCode(code) : false; // کدِ رنگیِ یک محصولِ تعریف‌شده
}

// body.qty رو به عدد نرمالایز می‌کنه (in-place) و در صورت مشکل متنِ خطا برمی‌گردونه (وگرنه null).
// unitFields: اسمِ فیلدهایی که باید شناسه‌ی یک بخشِ معتبر باشن. کالا نسبت به اولین بخش سنجیده می‌شه.
function validateMovement(body, unitFields = ['unit'], needItem = true) {
  if (!body || typeof body !== 'object') return 'درخواست نامعتبر است';
  const raw = body.qty;
  const q = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(q) || q <= 0 || q > 1e9) return 'مقدار نامعتبر است (باید عددی بزرگ‌تر از صفر باشد)';
  body.qty = q;
  const units = [];
  for (const f of unitFields) {
    if (!DEPTS.some(d => d.id === body[f])) return `بخش نامعتبر است (${f}: ${body[f]})`;
    units.push(body[f]);
  }
  if (needItem && !knownItemCode(units[0], body.item)) return `کالا یا کد «${body.item}» در سیستم شناخته‌شده نیست`;
  return null;
}

// ===== موجودیِ قابل‌استفاده = موجودی − خروج‌های در راه =====
// سندِ خروجی که ثبت شده ولی گیرنده هنوز تایید نکرده (pending / pending_warehouse) موجودیِ مبدأ را جابه‌جا
// نکرده، ولی کالا فیزیکی رفته است. قبلاً این مقدار در هیچ چکی کم نمی‌شد: می‌شد چند خروجِ پشت‌سرِهم بیشتر از
// موجودی زد یا همان کالا را مصرف کرد و خطا تازه موقعِ تاییدِ گیرنده دیده می‌شد. excludeDocId برای وقتی است
// که خودِ همان سند را می‌سنجیم.
function pendingOutQty(unit, item, excludeDocId) {
  let sum = 0;
  docs.forEach(d => {
    if (d.type === 'output' && d.fromUnit === unit && d.item === item && d.id !== excludeDocId &&
        (d.status === 'pending' || d.status === 'pending_warehouse')) sum += Number(d.qty) || 0;
  });
  return Math.round(sum * 1e6) / 1e6;
}
function availableQty(unit, item, excludeDocId) {
  const have = (inventory[unit] && inventory[unit][item]) || 0;
  return Math.round((have - pendingOutQty(unit, item, excludeDocId)) * 1e6) / 1e6;
}
// متنِ خطای کمبود (یا null) با توضیحِ مقدارِ در راه
// محافظ در برابر صفحه‌های قدیمیِ باز (قبل از کدگذاریِ SOL-/INJ-/LASER-/PACK-): آن نسخه‌ها برای محصولاتِ مرحله‌ای
// کدِ خامِ سپیدار (یا کدِ فرمول) می‌فرستادند. اگر محصولِ تولیدی در بخش‌های لحیم تا بسته‌بندی کدِ تعریف‌شده‌ی
// همان بخش نباشد، یا ماده‌ای کدِ خامِ یک محصولِ مرحله‌ای باشد، درخواست رد می‌شود تا موجودی زیرِ کلیدِ غلط ننشیند.
const STALE_CLIENT_ERROR = 'نسخه‌ی صفحه‌ی شما قدیمی است؛ صفحه را با Ctrl+F5 (در موبایل: بستن و باز کردنِ دوباره‌ی اپ) تازه کنید و دوباره ثبت کنید';
function staleStageProduct(unit, item) {
  if (!['solder', 'inject', 'laser', 'pack'].includes(unit)) return false;
  return !stageDefFor(unit, item);
}
const STAGE_UNITS_AFTER_CUT = ['solder', 'inject', 'laser', 'pack'];
// کدام محصولاتِ مرحله‌ای می‌توانند در هر بخش «موجودی» شوند: محصولِ خودِ بخش + محصولِ «فقط» مرحله‌ی قبل
// (لیزر فقط بعد از تزریق، نه لحیم). برای موجودی اول دوره و اضافات؛ مواد خام آزادند.
const STAGE_PREFIX_ALLOWED = { cut: ['CUT'], solder: ['CUT', 'SOL'], inject: ['SOL', 'INJ'], laser: ['INJ', 'LASER'], pack: ['LASER', 'PACK'], finished: ['PACK'] };
function stageKeyProblem(unit, code) {
  const m = String(code || '').match(/^(CUT|SOL|INJ|LASER|PACK)-/);
  if (!m) return null;
  const allowed = STAGE_PREFIX_ALLOWED[unit];
  if (!allowed || allowed.includes(m[1])) return null; // انبار مواد/کنترل کیفیت: محدودیتی نیست
  return `«${resolveItemName(code)}» مالِ این مرحله نیست: در بخشِ ${deptName(unit)} فقط محصولِ خودِ بخش و محصولِ مرحله‌ی قبل (${allowed.join(' / ')}) ثبت می‌شود`;
}
function staleStageMaterial(item, unit) {
  if (unit && !STAGE_UNITS_AFTER_CUT.includes(unit)) return false; // انبارها/کنترل کیفیت می‌توانند کدِ خامِ سپیدار داشته باشند
  if (findDefByCode(item)) return false;
  return Object.keys(productDefinitions || {}).some(d => d !== 'cut' && (productDefinitions[d] || []).some(p => p.productCode === item || (Array.isArray(p.formulaKeys) && p.formulaKeys.includes(item))));
}
// رنگ: کدِ رنگی باید رنگِ تعریف‌شده و کالای پایه‌ی معتبر داشته باشد، و در لحیم تا بسته‌بندی، ورودیِ مرحله‌ای
// (برش/لحیم/تزریق/لیزر) باید همرنگِ محصول باشد تا رنگ در طولِ خط گم نشود.
function colorProblem(unit, item, mats) {
  const sc = splitColor(item);
  if (sc.colorSlug) {
    if (!colorBySlug(sc.colorSlug)) return `رنگِ «${sc.colorSlug}» در فهرستِ رنگ‌ها نیست`;
    if (!isStageKey(item) || !findDefByCode(item) && !stageDefFor(unit, item)) return 'رنگ فقط برای محصولاتِ خطِ تولید (برش تا بسته‌بندی) معنا دارد';
  }
  if (STAGE_UNITS_AFTER_CUT.includes(unit) && Array.isArray(mats)) {
    const want = colorOfKey(item) || DEFAULT_COLOR;
    const bad = mats.find(m => m && isStageKey(m.item) && colorOfKey(m.item) !== want);
    if (bad) return `رنگِ ورودی با محصول یکی نیست: «${resolveItemName(bad.item)}» (${colorOfKey(bad.item)}) برای محصولِ ${want}`;
  }
  return null;
}
// زنجیره‌ی تولید: ورودیِ مرحله‌ای باید «همان محصول» از «همان مرحله‌ی قبل» باشد (کد سپیدارِ یکسان؛ در بسته‌بندی همان برندِ لیزر؛
// در لحیم، کابلِ برش‌خورده‌ای که در فرمولِ انتخاب‌شده هست) تا کد و ویژگی‌ها بینِ بخش‌ها عوض نشود. رنگ را colorProblem می‌سنجد.
const CHAIN_PREV = { solder: 'CUT', inject: 'SOL', laser: 'INJ', pack: 'LASER' };
function chainProblem(unit, item, mats, formulaKey) {
  if (!CHAIN_PREV[unit] || !Array.isArray(mats)) return null;
  const base = splitColor(item).base;
  const m = base.match(/^(SOL|INJ|LASER|PACK)-([^-]+)(?:-([^-]+))?(?:-([^-]+))?$/);
  if (!m) return null;
  const pc = m[2], laserBrand = m[1] === 'PACK' ? m[3] : null;
  for (const x of mats) {
    if (!x || !isStageKey(x.item)) continue;
    const xb = splitColor(x.item).base, xm = xb.match(/^(CUT|SOL|INJ|LASER|PACK)-(.+)$/);
    if (xm[1] !== CHAIN_PREV[unit]) return `«${resolveItemName(x.item)}» ورودیِ این مرحله نیست؛ در ${deptName(unit)} فقط محصولِ مرحله‌ی قبل (${CHAIN_PREV[unit]}) مصرف می‌شود`;
    if (unit === 'solder') {
      const ks = formulaKey && getFormula(formulaKey) ? [formulaKey] : formulaKeysOfProductCode(pc);
      const ok = ks.some(k => ((getFormula(k) || {}).materials || []).some(fm => fm.stage === 'cut' && xb === `CUT-${fm.code}-${Math.round((fm.qty || 0) * 100)}`));
      if (ks.length && !ok) return `کابلِ «${resolveItemName(x.item)}» در فرمولِ ${formulaKey || ''} این محصول نیست (نوعِ کابل یا طول با فرمول نمی‌خواند)`;
      continue;
    }
    const xparts = xm[2].split('-');
    if (xparts[0] !== pc) return `ورودیِ «${resolveItemName(x.item)}» مالِ محصولِ دیگری است (کد سپیدار ${xparts[0]} به‌جای ${pc})`;
    if (unit === 'pack' && laserBrand && xparts[1] !== laserBrand) return `برندِ لیزرِ ورودی (${xparts[1]}) با برندِ محصولِ بسته‌بندی (${laserBrand}) یکی نیست`;
  }
  return null;
}
function shortageMessage(unit, item, need, label) {
  const avail = availableQty(unit, item);
  if (avail + QTY_EPS >= need) return null;
  const have = (inventory[unit] && inventory[unit][item]) || 0;
  const pend = pendingOutQty(unit, item);
  return `${label || 'موجودی کافی نیست'}: «${resolveItemName(item)}» در ${deptName(unit)} - موجود ${formatNumber(have)}`
    + (pend ? `، در راه (خروجِ تاییدنشده) ${formatNumber(pend)}، قابل‌استفاده ${formatNumber(Math.max(avail, 0))}` : '')
    + `، لازم ${formatNumber(need)}`;
}

// ============================================
// ثبتِ لغو/تایید/برگشتِ اسناد توی لاگ فعالیت (بدون دست‌بردن به تک‌تک هندلرها)
// ============================================
const AUDITED_DOC_ROUTES = [
  [/^\/output\/approve$/, 'تایید خروج (بخش گیرنده)'],
  [/^\/(\d+)\/cancel$/, 'لغو سند'],
  [/^\/return\/approve$/, 'تایید برگشت'],
  [/^\/return\/reject$/, 'رد برگشت'],
  [/^\/output\/request-return$/, 'درخواست برگشت خروج']
];
app.use((req, res, next) => {
  const savesBefore = dbSaveCount;
  // درخواستِ ناموفق یا درخواستِ نوشتنی‌ای که چیزی ذخیره نکرده ممکنه globalها را نیمه‌کاره تغییر داده باشد → بارگذاریِ اجباریِ بعدی
  res.on('finish', () => { if (res.statusCode >= 400 || (req.method !== 'GET' && req.method !== 'HEAD' && dbSaveCount === savesBefore)) dbForceReload = true; });
  next();
});

app.use('/api/doc', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const route = AUDITED_DOC_ROUTES.find(r => r[0].test(req.path));
  if (!route) return next();
  const subPath = req.path; // داخل res.json مسیر دیگه نسبی نیست، پس همین‌جا نگه می‌داریم
  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      if (body && body.success) {
        const m = subPath.match(/^\/(\d+)\//);
        const docId = parseInt((req.body && req.body.docId) || (m && m[1]));
        const actor = (req.body && req.body.actorUsername) || 'نامشخص';
        setImmediate(() => {
          try {
            loadData();
            const d = docs.find(x => x.id === docId);
            logActivity(actor, route[1], (d
              ? `سند ${d.id} (${d.type}) - کالا: ${resolveItemName(d.item)} (${d.item}), تعداد: ${d.qty} - ${d.fromUnit || d.toUnit ? 'از ' + deptName(d.fromUnit) + ' به ' + deptName(d.toUnit) : 'بخش ' + deptName(d.unit)}`
              : `سند ${docId}`) + (req.body && req.body.reason ? ` - دلیل: ${req.body.reason}` : ''));
          } catch (e) { console.error('audit log failed:', e.message); }
        });
      }
    } catch (e) { /* لاگ هرگز نباید پاسخ را خراب کند */ }
    return origJson(body);
  };
  next();
});

// ===== تاریخ شمسیِ اسناد: پیش‌فرض امروز؛ کاربر می‌تواند تاریخ دیگری (در سال مالیِ فعال و نه آینده) انتخاب کند =====
// قاعدهٔ کبیسه: همان قاعدهٔ ۳۳ ساله‌ی تقویم رسمی (سال‌های ۱۴۰۳، ۱۴۰۸، ۱۴۱۲، ۱۴۱۶، ۱۴۲۰ ... کبیسه‌اند)
function jalaliLeap(y) { return (25 * y + 11) % 33 < 8; }
function jalaliMonthDays(y, m) { return m <= 6 ? 31 : (m <= 11 ? 30 : (jalaliLeap(y) ? 30 : 29)); }
function todayJalali() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date()).map(x => [x.type, +x.value]));
  return p.year + '/' + String(p.month).padStart(2, '0') + '/' + String(p.day).padStart(2, '0');
}
// تاریخِ datetimeِ سپیدار → «1405/07/13». درایورِ mssql مقدارِ DATETIME را همان ساعتِ دیواری با برچسبِ UTC
// برمی‌گرداند، پس روز با منطقه‌ی UTC خوانده می‌شود (با Asia/Tehran سندهای آخرِ شب یک روز جلو می‌افتادند).
function sepidarDateToJalali(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(dt).map(x => [x.type, +x.value]));
  return p.year + '/' + String(p.month).padStart(2, '0') + '/' + String(p.day).padStart(2, '0');
}
function normalizeJalaliDate(str) {
  const latin = String(str == null ? '' : str).trim().replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
  const m = latin.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return { ok: false, error: 'تاریخ را به شکل 1405/07/01 وارد کنید' };
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1300 || y > 1500 || mo < 1 || mo > 12 || d < 1) return { ok: false, error: 'تاریخ نامعتبر است' };
  if (d > jalaliMonthDays(y, mo)) return { ok: false, error: 'روز ' + d + ' در ماه ' + mo + ' سال ' + y + ' وجود ندارد (این ماه ' + jalaliMonthDays(y, mo) + ' روز دارد)' };
  return { ok: true, value: y + '/' + String(mo).padStart(2, '0') + '/' + String(d).padStart(2, '0') };
}
// تاریخِ سند از بدنهٔ درخواست (body.date)؛ خالی = امروز. در صورت نامعتبر بودن همین‌جا پاسخ ۴۰۰ می‌دهد و null برمی‌گرداند.
// ===== بستنِ روز/ماه (فاز ۶) =====
// appSettings.closedThrough = آخرین روزِ بسته (مثلاً 1405/07/30). هیچ سندی با تاریخِ تا آن روز ثبت، تایید، ویرایش،
// لغو یا حذف نمی‌شود؛ فقط مدیر می‌تواند (با دلیل و ثبت در تاریخچه) دوره را دوباره باز کند.
function closedThrough() { return (appSettings && appSettings.closedThrough) || null; }
function closedProblem(date) {
  const c = closedThrough();
  if (!c || !date) return null;
  const n = normalizeJalaliDate(date);
  const v = n.ok ? n.value : String(date);
  return v <= c ? `دوره تا تاریخ ${c} بسته شده است؛ سند با تاریخ ${v} قابل ثبت یا تغییر نیست (برای اصلاح، مدیر باید دوره را باز کند)` : null;
}
function resolveDocDate(req, res) {
  const raw = req.body && req.body.date;
  const today = todayJalali();
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    const cp = closedProblem(today); if (cp) { res.status(400).json({ success: false, error: cp }); return null; }
    return today;
  }
  const n = normalizeJalaliDate(raw);
  if (!n.ok) { res.status(400).json({ success: false, error: n.error }); return null; }
  if (n.value > today) { res.status(400).json({ success: false, error: 'تاریخ سند نمی‌تواند در آینده باشد (امروز ' + today + ')' }); return null; }
  { const cp = closedProblem(n.value); if (cp) { res.status(400).json({ success: false, error: cp }); return null; } }
  const fy = fiscalYears.find(f => String(f.year) === String(activeFiscalYear));
  if (fy && fy.startDate && fy.endDate && (n.value < fy.startDate || n.value > fy.endDate)) {
    res.status(400).json({ success: false, error: 'تاریخ سند باید در سال مالی فعال (' + fy.startDate + ' تا ' + fy.endDate + ') باشد' });
    return null;
  }
  return n.value;
}

app.post('/api/doc/production', (req, res) => {
  try {
    loadData();
    materializeStageDef(req.body && req.body.unit, req.body && req.body.item); // لیزر/بسته‌بندی: برند/نوع پک تازه
    { const b = req.body || {}; const cp = colorProblem(b.unit, b.item, Array.isArray(b.materials) ? b.materials : null) || chainProblem(b.unit, b.item, Array.isArray(b.materials) ? b.materials : null, b.formulaKey) || packVariantProblem(b.unit, b.item, Array.isArray(b.materials) ? b.materials : null, b.formulaKey); if (cp) return res.status(400).json({ success: false, error: cp }); }
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    { const bad = validateMovement(req.body, ['unit']); if (bad) return res.status(400).json({ success: false, error: bad }); }
    const { unit, item, qty, note, orderBatchId } = req.body;
    if (staleStageProduct(unit, item)) return res.status(400).json({ success: false, error: STALE_CLIENT_ERROR });

    const batchNumber = generateBatchNumber();

    // اگه برای این بخش «تاییدِ انباردار برای تولید» فعال باشه، سندِ تولید در انتظار می‌مونه: نه تراکنشی
    // ثبت می‌شه و نه موجودی اضافه می‌شه - هر دو فقط بعد از تاییدِ انباردار (production/approve).
    const gated = isProductionGated(unit);

    let tx = null;
    if (!gated) {
      tx = {
        id: seqId++,
        date: docDt,
        type: 'production',
        unit: unit,
        item: item,
        qty: qty,
        note: note || '',
        targetUnit: '',
        fiscalYear: activeFiscalYear,
        batchNumber: batchNumber
      };
      transactions.push(tx);
    }

    const doc = {
      id: docSeq++,
      date: docDt,
      type: 'production',
      unit: unit,
      item: item,
      qty: qty,
      fromUnit: '',
      toUnit: '',
      note: note || '',
      status: gated ? 'pending_production' : 'approved',
      fiscalYear: activeFiscalYear,
      createdBy: (req.body && req.body.actorUsername) || 'سیستم',
      transactionId: tx ? tx.id : null,
      parentDocId: null,
      batchNumber: batchNumber,
      orderBatchId: orderBatchId || null,
      // فرمولِ انتخاب‌شده (برای کالاهایی که چند فرمول دارند، مثلاً کابل داخلی/وارداتی) - فقط برای آمار
      formulaKey: (req.body.formulaKey && getFormula(req.body.formulaKey)) ? req.body.formulaKey : null
    };
    docs.push(doc);

    if (!gated) {
      if (!inventory[unit]) inventory[unit] = {};
      if (!inventory[unit][item]) inventory[unit][item] = 0;
      inventory[unit][item] += qty;
    }

    saveData();

    res.json({
      success: true,
      doc: doc,
      tx: tx,
      pendingWarehouse: gated,
      message: gated
        ? `سند تولید با شماره ${doc.id} ثبت شد و در انتظار تایید انباردار است (بعد از تایید به موجودی اضافه می‌شود)`
        : `سند تولید با شماره ${doc.id} ثبت شد`,
      batchNumber: batchNumber
    });

    if (gated) {
      sendPushToUsernames(usersWithRoles(['warehouse', 'admin']), {
        title: '🏭 تولید در انتظار تایید انباردار',
        body: `${resolveItemName(item)} (${formatNumber(qty)}) - بخش ${deptName(unit)}`,
        url: '/'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== تاییدِ انباردار برای تولید =====
// تولیدِ بخش‌هایی که تیکِ «تاییدِ انباردار برای تولید» دارن بعد از ثبت در انتظار می‌مونه. با تاییدِ انباردار
// هم خودِ تولید (+ موجودی، تراکنش production) و هم مصرفِ موادِ همراهش (- موجودی، تراکنش consume) با هم
// اعمال می‌شن؛ با ردِ انباردار هیچ‌کدوم اعمال نمی‌شه.
app.post('/api/doc/production/approve', (req, res) => {
  try {
    const { docId, actorUsername } = req.body;
    loadData();
    const actor = users.find(u => u.username === actorUsername);
    if (!actor || (actor.role !== 'warehouse' && actor.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند تولید را تایید کند' });
    }
    const doc = docs.find(d => d.id === docId);
    if (!doc || doc.type !== 'production') return res.status(404).json({ success: false, error: 'سند تولید یافت نشد' });
    if (doc.status !== 'pending_production') {
      return res.status(400).json({ success: false, error: 'این سند در انتظار تایید انباردار نیست' });
    }
    const children = docs.filter(d => d.parentDocId === doc.id && d.type === 'consume' && d.status === 'pending_production');

    // موجودی مواد باید همین الان هم کافی باشه (ممکنه بین ثبت و تایید عوض شده باشه)
    const need = {};
    children.forEach(c => { const k = c.unit + '|' + c.item; need[k] = (need[k] || 0) + c.qty; });
    const errors = [];
    Object.entries(need).forEach(([k, q]) => {
      const [unit, code] = k.split('|');
      const m = shortageMessage(unit, code, q);
      if (m) errors.push(m);
    });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('\n') });

    const today = (doc.date || todayJalali());
    const nowIso = new Date().toISOString();

    const ptx = {
      id: seqId++, date: today, type: 'production', unit: doc.unit, item: doc.item, qty: doc.qty,
      note: doc.note || '', targetUnit: '', fiscalYear: doc.fiscalYear || activeFiscalYear, batchNumber: doc.batchNumber
    };
    transactions.push(ptx);
    if (!inventory[doc.unit]) inventory[doc.unit] = {};
    if (!inventory[doc.unit][doc.item]) inventory[doc.unit][doc.item] = 0;
    inventory[doc.unit][doc.item] += doc.qty;
    doc.status = 'approved';
    doc.transactionId = ptx.id;
    doc.approvedBy = actorUsername;
    doc.approvedAt = nowIso;

    children.forEach(c => {
      const ctx = {
        id: seqId++, date: today, type: 'consume', unit: c.unit, item: c.item, qty: c.qty,
        note: c.note || '', targetUnit: '', fiscalYear: c.fiscalYear || activeFiscalYear, batchNumber: c.batchNumber
      };
      transactions.push(ctx);
      inventory[c.unit][c.item] -= c.qty;
      c.status = 'approved';
      c.transactionId = ctx.id;
      c.approvedBy = actorUsername;
      c.approvedAt = nowIso;
    });

    saveData();
    logActivity(actorUsername, 'تایید انباردار برای تولید', `سند ${doc.id} - ${resolveItemName(doc.item)} (${doc.qty}) در ${deptName(doc.unit)} - ${children.length} سند مصرف همراه`);
    res.json({ success: true, doc, consumeCount: children.length, message: `تولید ${doc.id} توسط انباردار تایید شد و به موجودی اضافه شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// اعلانِ رد به ثبت‌کننده‌ی سند
function notifyRejected(doc, by, reason, stage) {
  if (!doc || !doc.createdBy || doc.createdBy === by || !users.some(u => u.username === doc.createdBy)) return;
  const what = { output: 'خروج', production: 'تولید', waste: 'ضایعات', shortage: 'کسری', excess: 'اضافات' }[doc.type] || 'سند';
  sendPushToUsernames([doc.createdBy], { title: `❌ سند ${what} شما رد شد${stage ? ' (' + stage + ')' : ''}`,
    body: `${doc.docNo || doc.id}: ${resolveItemName(doc.item)} (${formatNumber(doc.qty)})${reason ? ' - دلیل: ' + reason : ''}`, url: '/mobile/' });
}
app.post('/api/doc/production/reject', (req, res) => {
  try {
    const { docId, actorUsername, reason } = req.body;
    loadData();
    const actor = users.find(u => u.username === actorUsername);
    if (!actor || (actor.role !== 'warehouse' && actor.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند تولید را رد کند' });
    }
    const doc = docs.find(d => d.id === docId);
    if (!doc || doc.type !== 'production') return res.status(404).json({ success: false, error: 'سند تولید یافت نشد' });
    if (doc.status !== 'pending_production') {
      return res.status(400).json({ success: false, error: 'این سند در انتظار تایید انباردار نیست' });
    }
    const nowIso = new Date().toISOString();
    const reasonText = reason ? ` | دلیل رد: ${reason}` : '';
    doc.status = 'rejected';
    doc.rejectedBy = actorUsername;
    doc.rejectedAt = nowIso;
    if (reason) doc.note = (doc.note || '') + reasonText;
    docs.filter(d => d.parentDocId === doc.id && d.type === 'consume' && d.status === 'pending_production').forEach(c => {
      c.status = 'rejected';
      c.rejectedBy = actorUsername;
      c.rejectedAt = nowIso;
    });
    saveData();
    doc.rejectReason = reason || '';
    logActivity(actorUsername, 'رد انباردار برای تولید', `سند ${doc.id} - ${resolveItemName(doc.item)} (${doc.qty}) در ${deptName(doc.unit)}${reasonText}`);
    notifyRejected(doc, actorUsername, reason, 'انباردار');
    res.json({ success: true, doc, message: `تولید ${doc.id} رد شد و هیچ تغییری روی موجودی اعمال نشد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تنظیمات: فهرستِ برندهای لیزر و نوع‌پک‌های بسته‌بندی (برای انتخاب هنگامِ تولید)
app.get('/api/settings/brands', (req, res) => {
  loadData();
  res.json({ success: true, brands: brandList(), packTypes: packTypeList(), colors: colorList() });
});
app.post('/api/settings/brands', (req, res) => {
  try {
    loadData();
    if (!inboxActor(req.body.actorUsername, ['admin'])) return res.status(403).json({ success: false, error: 'فقط مدیر' });
    const clean = arr => [...new Set((Array.isArray(arr) ? arr : []).map(x => normalizeFa(x)).filter(Boolean))];
    const brands = clean(req.body.brands);
    // برندِ پک از همان فهرستِ برندهاست؛ packTypes فقط اگر فرستاده شود عوض می‌شود (سازگاری)
    const packTypes = Array.isArray(req.body.packTypes) ? clean(req.body.packTypes) : packTypeList();
    if (!brands.length) return res.status(400).json({ success: false, error: 'حداقل یک برند لازم است' });
    const slugs = list => list.map(codeSlug);
    if (new Set(slugs(brands)).size !== brands.length || new Set(slugs(packTypes)).size !== packTypes.length) {
      return res.status(400).json({ success: false, error: 'دو مورد از فهرست بعد از تبدیل به کد یکسان می‌شوند (مثلاً فقط در فاصله یا خط تیره فرق دارند)' });
    }
    // برند/نوع‌پکی که محصولش در سیستم ساخته شده قابل حذف نیست (کدِ موجودی‌اش به آن وابسته است)
    const usedB = new Set((productDefinitions.laser || []).concat(productDefinitions.pack || []).map(p => p.brand).filter(Boolean));
    const usedP = new Set((productDefinitions.pack || []).map(p => p.packType).filter(Boolean));
    const missing = [...usedB].filter(b => !brands.includes(b)).concat([...usedP].filter(t => !brands.includes(t) && !packTypes.includes(t)));
    if (missing.length) return res.status(400).json({ success: false, error: 'این موارد در محصولاتِ ساخته‌شده استفاده شده‌اند و حذف‌شدنی نیستند: ' + missing.join('، ') });
    // رنگ‌ها: «سفید» همیشه هست (پیش‌فرض، بدون پسوند)؛ رنگی که کالایش در موجودی/اسناد هست حذف‌شدنی نیست
    let colors = colorList();
    if (Array.isArray(req.body.colors)) {
      colors = [DEFAULT_COLOR, ...clean(req.body.colors).filter(c => c !== DEFAULT_COLOR)];
      if (new Set(slugs(colors)).size !== colors.length) return res.status(400).json({ success: false, error: 'دو رنگ بعد از تبدیل به کد یکسان می‌شوند' });
      const keys = new Set();
      Object.values(inventory).forEach(m => Object.keys(m || {}).forEach(k => keys.add(k)));
      docs.forEach(d => keys.add(d.item)); transactions.forEach(t => keys.add(t.item));
      const usedSlugs = new Set([...keys].map(k => splitColor(k).colorSlug).filter(Boolean));
      const lost = colorList().filter(c => usedSlugs.has(codeSlug(c)) && !slugs(colors).includes(codeSlug(c)));
      if (lost.length) return res.status(400).json({ success: false, error: 'این رنگ‌ها در موجودی یا اسناد استفاده شده‌اند و حذف‌شدنی نیستند: ' + lost.join('، ') });
    }
    appSettings.brands = brands;
    appSettings.packTypes = packTypes;
    appSettings.colors = colors;
    saveData();
    logActivity(req.body.actorUsername, 'تغییر فهرست برندها، نوع پک و رنگ', `برندها: ${brands.join('، ')} | نوع پک: ${packTypes.join('، ')} | رنگ: ${colors.join('، ')}`);
    res.json({ success: true, brands, packTypes, colors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تنظیمات: بخش‌هایی که تولیدشان نیاز به تایید انباردار دارد
app.get('/api/settings/production-gate', (req, res) => {
  loadData();
  const cfg = (appSettings && appSettings.productionGate) || DEFAULT_PRODUCTION_GATE_CONFIG;
  res.json({ success: true, productionGate: cfg, depts: DEPTS.filter(d => d.type !== 'wh') });
});

app.post('/api/settings/production-gate', (req, res) => {
  try {
    loadData();
    const { depts, actorUsername } = req.body;
    if (!Array.isArray(depts)) return res.status(400).json({ success: false, error: 'فرمت لیست بخش‌ها نامعتبر است' });
    const valid = DEPTS.filter(d => d.type !== 'wh').map(d => d.id);
    const clean = [...new Set(depts.filter(id => valid.includes(id)))];
    appSettings.productionGate = { depts: clean };
    saveData();
    logActivity(actorUsername, 'تغییر تنظیمات تاییدِ انباردار برای تولید', `بخش‌های فعال: ${clean.map(deptName).join('، ') || 'هیچ'}`);
    res.json({ success: true, message: 'تنظیمات ذخیره شد', depts: clean });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== API برای ثبت سند مصرف =====
app.post('/api/doc/consume', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    { const bad = validateMovement(req.body, ['unit']); if (bad) return res.status(400).json({ success: false, error: bad }); }
    const { unit, item, qty, note, batchNumber, parentDocId, orderBatchId } = req.body;
    if (staleStageMaterial(item, unit)) return res.status(400).json({ success: false, error: STALE_CLIENT_ERROR });

    { const m = shortageMessage(unit, item, qty); if (m) return res.status(400).json({ success: false, error: m }); }

    const batch = batchNumber || generateBatchNumber();

    // مصرفِ مواد یک سند تولیدِ «در انتظار تایید انباردار» همراه خودِ تولید منتظر می‌مونه
    const parentDoc = parentDocId ? docs.find(d => d.id === parentDocId) : null;
    const deferred = !!(parentDoc && parentDoc.status === 'pending_production');

    let tx = null;
    if (!deferred) {
      tx = {
        id: seqId++,
        date: docDt,
        type: 'consume',
        unit: unit,
        item: item,
        qty: qty,
        note: note || '',
        targetUnit: '',
        fiscalYear: activeFiscalYear,
        batchNumber: batch
      };
      transactions.push(tx);
    }

    const doc = {
      id: docSeq++,
      date: docDt,
      type: 'consume',
      unit: unit,
      item: item,
      qty: qty,
      fromUnit: '',
      toUnit: '',
      note: note || '',
      status: deferred ? 'pending_production' : 'approved',
      fiscalYear: activeFiscalYear,
      createdBy: (req.body && req.body.actorUsername) || 'سیستم',
      transactionId: tx ? tx.id : null,
      parentDocId: parentDocId || null,
      batchNumber: batch,
      orderBatchId: orderBatchId || null
    };
    docs.push(doc);

    if (!deferred) inventory[unit][item] -= qty;

    saveData();

    res.json({
      success: true,
      doc: doc,
      tx: tx,
      deferred: deferred,
      message: `سند مصرف با شماره ${doc.id} ثبت شد`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// سندهای ضایعات/کسری/اضافات وقتی توسط نقشِ «کاربر عادی» یا «انباردار» ثبت می‌شن، باید قبل
// از اعمال روی موجودی توسط سرپرست یا مدیر تایید بشن؛ خودِ سرپرست/مدیر نیازی به تاییدِ خودش
// نداره. نقشِ واقعی از روی users[] سرور خونده می‌شه (نه چیزی که کلاینت ادعا می‌کنه).
// نقش‌های مجاز به تایید: مدیر (همیشه) + هر نقشی که مجوز «تایید ضایعات/کسری/اضافات» رو توی ماتریسِ
// دسترسی داره.
function adjustmentApproverRoles() {
  const perms = (appSettings && appSettings.rolePermissions) || {};
  return ['admin', ...['supervisor', 'warehouse', 'user'].filter(r => (perms[r] || []).includes(PERM_APPROVE_ADJUSTMENTS))];
}
function isAdjustmentApprover(username) {
  const user = users.find(u => u.username === username);
  return !!user && adjustmentApproverRoles().includes(user.role);
}

// ===== API برای ثبت سند ضایعات =====
app.post('/api/doc/waste', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    { const bad = validateMovement(req.body, ['unit']); if (bad) return res.status(400).json({ success: false, error: bad }); }
    const { unit, item, qty, note, batchNumber, actorUsername } = req.body;

    { const m = shortageMessage(unit, item, qty); if (m) return res.status(400).json({ success: false, error: m }); }

    const batch = batchNumber || generateBatchNumber();

    if (!isAdjustmentApprover(actorUsername)) {
      const doc = {
        id: docSeq++,
        date: docDt,
        type: 'waste',
        unit: unit,
        item: item,
        qty: qty,
        fromUnit: '',
        toUnit: '',
        note: note || '',
        status: 'pending_approval',
        fiscalYear: activeFiscalYear,
        createdBy: actorUsername || 'سیستم',
        transactionId: null,
        parentDocId: null,
        batchNumber: batch
      };
      docs.push(doc);
      saveData();
      logActivity(actorUsername, 'ثبت سند ضایعات (در انتظار تایید)', `کالا: ${item}, تعداد: ${qty}, بخش: ${unit}`);
      sendPushToUsernames(usersWithRoles(adjustmentApproverRoles()), {
        title: '🗑️ سند ضایعات نیازمند تایید',
        body: `${resolveItemName(item)} (${formatNumber(qty)}) در ${deptName(unit)}`,
        url: '/mobile/'
      });
      return res.json({
        success: true,
        doc: doc,
        pendingApproval: true,
        message: `سند ضایعات با شماره ${doc.id} ثبت شد و در انتظار تایید سرپرست/مدیر است`
      });
    }

    const tx = {
      id: seqId++,
      date: docDt,
      type: 'waste',
      unit: unit,
      item: item,
      qty: qty,
      note: note || '',
      targetUnit: '',
      fiscalYear: activeFiscalYear,
      batchNumber: batch
    };
    transactions.push(tx);

    const doc = {
      id: docSeq++,
      date: docDt,
      type: 'waste',
      unit: unit,
      item: item,
      qty: qty,
      fromUnit: '',
      toUnit: '',
      note: note || '',
      status: 'approved',
      fiscalYear: activeFiscalYear,
      createdBy: actorUsername || 'سیستم',
      transactionId: tx.id,
      parentDocId: null,
      batchNumber: batch
    };
    docs.push(doc);

    inventory[unit][item] -= qty;

    saveData();
    logActivity(actorUsername, 'ثبت سند ضایعات', `کالا: ${item}, تعداد: ${qty}, بخش: ${unit}`);

    res.json({
      success: true,
      doc: doc,
      tx: tx,
      message: `سند ضایعات با شماره ${doc.id} ثبت شد`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== API برای ثبت سند کسری/اضافات =====
app.post('/api/doc/adjust', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    if (req.body.type === 'excess' && !stageKeyProblem(req.body.unit, req.body.item)) materializeForStock(req.body.item);
    { const bad = validateMovement(req.body, ['unit']); if (bad) return res.status(400).json({ success: false, error: bad }); }
    if (req.body.type !== 'shortage' && req.body.type !== 'excess') return res.status(400).json({ success: false, error: 'نوع سند باید کسری یا اضافات باشد' });
    if (req.body.type === 'excess') { const sp = stageKeyProblem(req.body.unit, req.body.item); if (sp) return res.status(400).json({ success: false, error: sp }); }
    const { unit, item, qty, type, note, actorUsername } = req.body;
    // اضافاتِ کالای مرحله‌ایِ چندفرمولی: نوعِ کابل (فرمول) اجباری است تا بچِ ساخته‌شده نوعش معلوم باشد
    let excessFk = null;
    if (type === 'excess') { const ff = initialFormulaFor(item, req.body.formulaKey); if (ff.error) return res.status(400).json({ success: false, error: ff.error }); excessFk = ff.fk; }

    if (!inventory[unit]) inventory[unit] = {};
    if (!inventory[unit][item]) inventory[unit][item] = 0;

    const txType = type === 'shortage' ? 'shortage' : 'excess';
    const label = type === 'shortage' ? 'کسری' : 'اضافات';
    const batchNumber = generateBatchNumber();

    if (type === 'shortage') { const m = shortageMessage(unit, item, qty); if (m) return res.status(400).json({ success: false, error: m }); }

    if (!isAdjustmentApprover(actorUsername)) {
      const doc = {
        id: docSeq++,
        date: docDt,
        type: txType,
        unit: unit,
        item: item,
        qty: qty,
        fromUnit: '',
        toUnit: '',
        note: note || '',
        status: 'pending_approval',
        fiscalYear: activeFiscalYear,
        createdBy: actorUsername || 'سیستم',
        transactionId: null,
        parentDocId: null,
        batchNumber: batchNumber
      };
      if (excessFk) doc.formulaKey = excessFk;
      docs.push(doc);
      saveData();
      logActivity(actorUsername, `ثبت سند ${label} (در انتظار تایید)`, `کالا: ${item}, تعداد: ${qty}, بخش: ${unit}`);
      sendPushToUsernames(usersWithRoles(adjustmentApproverRoles()), {
        title: `⚙️ سند ${label} نیازمند تایید`,
        body: `${resolveItemName(item)} (${formatNumber(qty)}) در ${deptName(unit)}`,
        url: '/mobile/'
      });
      return res.json({
        success: true,
        doc: doc,
        pendingApproval: true,
        message: `سند ${label} با شماره ${doc.id} ثبت شد و در انتظار تایید سرپرست/مدیر است`
      });
    }

    if (type === 'shortage') {
      inventory[unit][item] -= qty;
    } else {
      inventory[unit][item] += qty;
    }

    const tx = {
      id: seqId++,
      date: docDt,
      type: txType,
      unit: unit,
      item: item,
      qty: qty,
      note: note || '',
      targetUnit: '',
      fiscalYear: activeFiscalYear,
      batchNumber: batchNumber
    };
    transactions.push(tx);

    const doc = {
      id: docSeq++,
      date: docDt,
      type: txType,
      unit: unit,
      item: item,
      qty: qty,
      fromUnit: '',
      toUnit: '',
      note: note || '',
      status: 'approved',
      fiscalYear: activeFiscalYear,
      createdBy: actorUsername || 'سیستم',
      transactionId: tx.id,
      parentDocId: null,
      batchNumber: batchNumber
    };
    if (excessFk) doc.formulaKey = excessFk;
    docs.push(doc);

    saveData();
    logActivity(actorUsername, `ثبت سند ${label}`, `کالا: ${item}, تعداد: ${qty}, بخش: ${unit}`);

    res.json({
      success: true,
      doc: doc,
      tx: tx,
      message: `سند تعدیل با شماره ${doc.id} ثبت شد`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تایید/ردِ سندهای ضایعات/کسری/اضافاتِ در انتظار تاییدِ سرپرست یا مدیر. این دو نقش سراسری
// هستن (نه مخصوص یه بخش خاص)، پس هر سرپرست/مدیری می‌تونه سندِ در-انتظارِ هر بخشی رو تایید/رد
// کنه - محدودیتِ بخش اینجا معنا نداره.
app.post('/api/doc/pending-adjustment/approve', (req, res) => {
  try {
    const { docId, actorUsername } = req.body;

    loadData();

    if (!isAdjustmentApprover(actorUsername)) {
      return res.status(403).json({ success: false, error: 'فقط مدیر یا نقش‌هایی که مجوز «تایید ضایعات/کسری/اضافات» دارند می‌توانند این سند را تایید کنند' });
    }

    const doc = docs.find(d => d.id === docId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    if (doc.status !== 'pending_approval') {
      return res.status(400).json({ success: false, error: 'این سند در وضعیت مناسب برای تایید نیست' });
    }
    if (!['waste', 'shortage', 'excess'].includes(doc.type)) {
      return res.status(400).json({ success: false, error: 'نوع سند برای این عملیات پشتیبانی نمی‌شود' });
    }

    if (!inventory[doc.unit]) inventory[doc.unit] = {};
    if (!inventory[doc.unit][doc.item]) inventory[doc.unit][doc.item] = 0;

    // موجودی ممکنه بین لحظه‌ی ثبت و لحظه‌ی تایید عوض شده باشه - دوباره چک می‌کنیم.
    if (doc.type === 'waste' || doc.type === 'shortage') { const m = shortageMessage(doc.unit, doc.item, doc.qty); if (m) return res.status(400).json({ success: false, error: m }); }

    if (doc.type === 'excess') {
      inventory[doc.unit][doc.item] += doc.qty;
    } else {
      inventory[doc.unit][doc.item] -= doc.qty;
    }

    const tx = {
      id: seqId++,
      date: (doc.date || todayJalali()),
      type: doc.type,
      unit: doc.unit,
      item: doc.item,
      qty: doc.qty,
      note: doc.note || '',
      targetUnit: '',
      fiscalYear: doc.fiscalYear || activeFiscalYear,
      batchNumber: doc.batchNumber
    };
    transactions.push(tx);

    doc.status = 'approved';
    doc.transactionId = tx.id;
    doc.approvedBy = actorUsername;
    doc.approvedAt = new Date().toISOString();

    saveData();

    const typeLabels = { waste: 'ضایعات', shortage: 'کسری', excess: 'اضافات' };
    logActivity(actorUsername, `تایید سند ${typeLabels[doc.type] || doc.type}`, `سند ${doc.id} - کالا: ${doc.item}, تعداد: ${doc.qty}, بخش: ${doc.unit}`);

    res.json({ success: true, doc: doc, tx: tx, message: `سند ${doc.id} تایید و اعمال شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/doc/pending-adjustment/reject', (req, res) => {
  try {
    const { docId, actorUsername, reason } = req.body;

    loadData();

    if (!isAdjustmentApprover(actorUsername)) {
      return res.status(403).json({ success: false, error: 'فقط مدیر یا نقش‌هایی که مجوز «تایید ضایعات/کسری/اضافات» دارند می‌توانند این سند را رد کنند' });
    }

    const doc = docs.find(d => d.id === docId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    if (doc.status !== 'pending_approval') {
      return res.status(400).json({ success: false, error: 'این سند در وضعیت مناسب برای رد نیست' });
    }

    doc.status = 'rejected';
    doc.rejectedBy = actorUsername; doc.rejectedAt = new Date().toISOString(); doc.rejectReason = reason || '';
    if (reason) doc.note = doc.note ? `${doc.note} | دلیل رد: ${reason}` : `دلیل رد: ${reason}`;

    saveData();
    notifyRejected(doc, actorUsername, reason, 'سرپرست/مدیر');

    const typeLabels = { waste: 'ضایعات', shortage: 'کسری', excess: 'اضافات' };
    logActivity(actorUsername, `رد سند ${typeLabels[doc.type] || doc.type}`, `سند ${doc.id} - کالا: ${doc.item}, تعداد: ${doc.qty}, بخش: ${doc.unit}`);

    res.json({ success: true, doc: doc, message: `سند ${doc.id} رد شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// پنجره‌ی گاردِ ثبتِ تکراری برای سند خروج (میلی‌ثانیه)
const DUPLICATE_OUTPUT_WINDOW_MS = 10 * 1000;

// ===== API برای ثبت خروج به بخش =====
app.post('/api/doc/output', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    { const bad = validateMovement(req.body, ['from', 'to']); if (bad) return res.status(400).json({ success: false, error: bad }); }
    if (req.body.from === req.body.to) return res.status(400).json({ success: false, error: 'بخش مبدأ و مقصد نمی‌تواند یکی باشد' });
    const { from, to, item, qty, note, orderBatchId, createdBy, submissionId } = req.body;
    if (staleStageMaterial(item, from)) return res.status(400).json({ success: false, error: STALE_CLIENT_ERROR });
    // کالای مرحله‌ای فقط به بخشی می‌رود که آن کد را می‌پذیرد (مرحله‌ی بعد، یا برگشت به مرحله‌ی قبل) - پرشِ مرحله ممنوع
    { const sp = stageKeyProblem(to, item); if (sp) return res.status(400).json({ success: false, error: `ارسال به ${deptName(to)} ممکن نیست: ${sp}` }); }


    // گاردِ ثبتِ تکراری: یه خروجِ ۱۰ ردیفی به برش با کلیکِ دوباره روی دکمه کاملاً دو بار ثبت شد
    // (اسناد ۱۲۳ تا ۱۴۲)، و چون چکِ موجودیِ بالا اسنادِ pending رو کم نمی‌کنه، کلیکِ دوم رد
    // نمی‌شد. اگه همین مبدأ/مقصد/کالا/مقدار توی ۱۰ ثانیه‌ی اخیر ثبت شده باشه، رد می‌کنیم.
    // استثنا: ردیف‌هایی که توی «همون یک ارسال» (submissionId یکسان) عمداً تکرار شدن - اونا
    // خواسته‌ی خودِ کاربرن، نه کلیکِ دوباره. اسنادِ ردشده حساب نمی‌شن.
    const now = Date.now();
    const recentDuplicate = docs.find(d =>
      d.type === 'output' &&
      d.status !== 'rejected' &&
      d.fromUnit === from &&
      d.toUnit === to &&
      d.item === item &&
      Number(d.qty) === Number(qty) &&
      d.createdAt &&
      now - Date.parse(d.createdAt) < DUPLICATE_OUTPUT_WINDOW_MS &&
      !(submissionId && d.submissionId === submissionId)
    );
    if (recentDuplicate) {
      return res.status(409).json({
        success: false,
        duplicate: true,
        error: `سند خروجِ مشابه (سند ${recentDuplicate.id}) همین چند ثانیه پیش ثبت شده است - احتمالاً ثبتِ تکراری؛ اگر واقعاً دوباره لازم است، چند ثانیه بعد دوباره ثبت کنید`
      });
    }

    // بعد از گاردِ تکراری (تا کلیکِ دوم پیامِ «ثبتِ تکراری» بگیرد، نه «کمبود»): خروج‌های در راه هم کم می‌شوند
    { const m = shortageMessage(from, item, qty, 'موجودی مبدأ کافی نیست'); if (m) return res.status(400).json({ success: false, error: m }); }

    const batchNumber = generateBatchNumber();

    // اگه این جفت‌بخش توی لیستِ «نیاز به تاییدِ انباردار» باشه، سند به‌جای pendingِ معمولی
    // (که مستقیم برای تاییدِ گیرنده می‌ره) روی pending_warehouse می‌ایسته - فقط بعد از
    // اینکه انباردار تاییدش کنه، به pendingِ عادی تبدیل می‌شه و برای تاییدِ گیرنده آماده می‌شه.
    const needsWarehouseGate = isDeptPairGated(from, to);

    const doc = {
      id: docSeq++,
      date: docDt,
      type: 'output',
      unit: from,
      item: item,
      qty: qty,
      fromUnit: from,
      toUnit: to,
      note: note || '',
      status: needsWarehouseGate ? 'pending_warehouse' : 'pending',
      fiscalYear: activeFiscalYear,
      createdBy: createdBy || 'سیستم',
      createdAt: new Date(now).toISOString(),
      submissionId: submissionId || null,
      transactionId: null,
      parentDocId: null,
      batchNumber: batchNumber,
      orderBatchId: orderBatchId || null,
      returnOfDocId: null
    };
    // خروجِ «بازگشت به بخش قبلی»: فقط اگر واقعاً عکسِ مسیرِ یک خروجِ تاییدشده با همان کالا باشد ثبت می‌شود
    if (req.body.returnOfDocId) {
      const src = docs.find(d => d.id === Number(req.body.returnOfDocId));
      if (src && src.type === 'output' && src.status === 'approved' && src.fromUnit === to && src.toUnit === from && src.item === item) doc.returnOfDocId = src.id;
    }
    docs.push(doc);

    saveData();

    res.json({
      success: true,
      doc: doc,
      message: `سند خروج با شماره ${doc.id} ثبت شد`,
      batchNumber: batchNumber
    });

    // fire-and-forget - ارسال به Output Messenger هیچ‌وقت نباید جواب/ثبتِ خودِ سند رو
    // کند کنه یا خرابش کنه؛ برای همین بعد از res.json و بدون await صدا زده می‌شه.
    notifyOutputMessengerForOutputDoc(doc);

    // نوتیفیکیشنِ گوشی به کسی که الان باید اقدام کنه: اگه جفت‌بخش نیاز به تاییدِ انباردار
    // داره به نقشِ انباردار، وگرنه مستقیم به کاربرانِ بخشِ مقصد.
    const outputPushTargets = needsWarehouseGate ? usersWithRoles(['warehouse']) : usersInDeptId(to);
    sendPushToUsernames(outputPushTargets, {
      title: needsWarehouseGate ? '📤 سند خروج نیازمند تایید انباردار' : '📤 سند خروج جدید',
      body: `${resolveItemName(item)} (${formatNumber(qty)}) از ${deptName(from)} به ${deptName(to)}`,
      url: '/mobile/'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== API برای تایید خروج =====
app.post('/api/doc/output/approve', (req, res) => {
  try {
    const { docId } = req.body;
    
    loadData();
    
    const doc = docs.find(d => d.id === docId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'این سند قبلاً تایید شده است' });
    }
    if (doc.type !== 'output') {
      return res.status(400).json({ success: false, error: 'این سند نیاز به تایید ندارد' });
    }
    {
      // دریافت را فقط خودِ بخشِ مقصد (یا مدیر) تایید می‌کنه؛ قبلاً سرور هیچ چکی نداشت و کلاینت به انباردار/سرپرست
      // هم اجازه‌ی تایید به‌جای بخشِ گیرنده می‌داد (مثلاً انتقالِ سپیدار به برش توسط خودِ انباردار تایید می‌شد).
      const approver = users.find(u => u.username === (req.body && req.body.actorUsername));
      const allowedReceiver = approver && (approver.role === 'admin' || usersInDeptId(doc.toUnit).includes(approver.username));
      if (!allowedReceiver) {
        return res.status(403).json({ success: false, error: `دریافت این کالا را فقط کاربرانِ بخش «${deptName(doc.toUnit)}» (یا مدیر) می‌توانند تایید کنند` });
      }
    }
    
    const fromUnit = doc.fromUnit;
    const toUnit = doc.toUnit;
    const item = doc.item;
    const qty = doc.qty;
    const batchNumber = doc.batchNumber || generateBatchNumber();
    
    if (!inventory[fromUnit] || !inventory[fromUnit][item] || inventory[fromUnit][item] + QTY_EPS < qty) {
      return res.status(400).json({ success: false, error: 'موجودی مبدأ کافی نیست' });
    }
    
    inventory[fromUnit][item] -= qty;
    
    if (!inventory[toUnit]) inventory[toUnit] = {};
    if (!inventory[toUnit][item]) inventory[toUnit][item] = 0;
    inventory[toUnit][item] += qty;
    
    const txFrom = {
      id: seqId++,
      date: (doc.date || todayJalali()),
      type: 'output',
      unit: fromUnit,
      item: item,
      qty: qty,
      note: doc.note || `خروج به ${deptName(toUnit)}`,
      targetUnit: toUnit,
      fiscalYear: activeFiscalYear,
      batchNumber: batchNumber
    };
    transactions.push(txFrom);
    
    const txTo = {
      id: seqId++,
      date: (doc.date || todayJalali()),
      type: 'input',
      unit: toUnit,
      item: item,
      qty: qty,
      note: doc.note || `ورود از ${deptName(fromUnit)}`,
      sourceUnit: fromUnit,
      fiscalYear: activeFiscalYear,
      batchNumber: batchNumber
    };
    transactions.push(txTo);
    
    if (doc.reworkId && !doc.reworkRepair) { const rw = docs.find(d => d.id === doc.reworkId && d.type === 'rework'); if (rw && !rw.dueAt) setReworkDue(rw, reworkDefaultDueDays(), 'سیستم'); }
    // برگشت/ارسالِ دوباره‌کاری: همان لات‌هایی که از تولیدِ معیوب برگشته‌اند جابه‌جا می‌شوند (ردیابیِ بچ قطع نمی‌شود)
    if (Array.isArray(doc.reworkLots) && doc.reworkLots.length && Math.abs(doc.reworkLots.reduce((a, p) => a + p.qty, 0) - qty) < 1e-6) txFrom.lots = doc.reworkLots.map(p => ({ batch: p.batch, qty: p.qty }));
    doc.transactionId = txFrom.id;
    doc.transactionId2 = txTo.id;
    doc.status = 'approved';
    doc.approvedBy = (req.body && req.body.actorUsername) || null;
    doc.approvedAt = new Date().toISOString();
    doc.batchNumber = batchNumber;
    
    saveData();
    
    res.json({ 
      success: true, 
      message: `سند خروج ${docId} تایید شد`,
      txFrom: txFrom,
      txTo: txTo,
      batchNumber: batchNumber
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تاییدِ انباردار برای اسنادی که جفت‌بخششون به تاییدِ سوم نیاز داره - این مرحله فقط
// pending_warehouse رو به pendingِ عادی تبدیل می‌کنه، هیچ اثری روی موجودی نداره؛ خودِ
// جابه‌جاییِ موجودی همچنان توسطِ تاییدِ گیرنده (endpoint بالا) انجام می‌شه، بدون تغییر.
app.post('/api/doc/output/warehouse-approve', (req, res) => {
  try {
    const { docId, actorUsername } = req.body;

    loadData();

    const actor = users.find(u => u.username === actorUsername);
    if (!actor || (actor.role !== 'warehouse' && actor.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند این سند را تایید کند' });
    }

    const doc = docs.find(d => d.id === docId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    if (doc.status !== 'pending_warehouse') {
      return res.status(400).json({ success: false, error: 'این سند در وضعیت مناسب برای تایید انباردار نیست' });
    }
    // برگشتِ معیوب (تزریق ← لحیم): انباردار مهلتِ برگشتِ تعمیرشده را (به روز) تعیین می‌کند
    const rwDue = doc.reworkId && !doc.reworkRepair ? docs.find(d => d.id === doc.reworkId && d.type === 'rework') : null;
    if (rwDue) {
      const days = Number(req.body.dueDays);
      if (!(days >= 1 && days <= 60)) return res.status(400).json({ success: false, needDueDays: true, error: 'مهلتِ برگشتِ تعمیرشده از لحیم (چند روز) را وارد کنید (۱ تا ۶۰)' });
      setReworkDue(rwDue, days, actorUsername);
    }

    doc.status = 'pending';
    doc.warehouseApprovedBy = actorUsername;
    doc.warehouseApprovedAt = new Date().toISOString();

    saveData();
    logActivity(actorUsername, 'تایید انباردار برای خروج بین بخش‌ها', `سند ${doc.id} - از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)} - کالا: ${doc.item}, تعداد: ${doc.qty}`);

    res.json({ success: true, doc: doc, message: `سند ${doc.id} توسط انباردار تایید شد و برای تاییدِ ${deptName(doc.toUnit)} آماده است` });

    sendPushToUsernames(usersInDeptId(doc.toUnit), {
      title: '📤 سند خروج آماده تایید',
      body: `${resolveItemName(doc.item)} (${formatNumber(doc.qty)}) از ${deptName(doc.fromUnit)} - انباردار تایید کرد`,
      url: '/mobile/'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ردِ گیرنده (قبلاً «رد» سند را کامل حذف می‌کرد و فرستنده چیزی نمی‌دید): سند می‌ماند با وضعیت «رد شده»، دلیل و ردکننده
app.post('/api/doc/output/reject', (req, res) => {
  try {
    loadData();
    const { docId, actorUsername } = req.body || {};
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) return res.status(400).json({ success: false, error: 'دلیلِ رد را بنویسید (حداقل ۳ حرف)' });
    const doc = docs.find(d => d.id === Number(docId));
    if (!doc || doc.type !== 'output') return res.status(404).json({ success: false, error: 'سند خروج یافت نشد' });
    if (doc.status !== 'pending') return res.status(400).json({ success: false, error: doc.status === 'pending_warehouse' ? 'این سند هنوز منتظر تایید انباردار است' : 'این سند در وضعیت قابل رد نیست' });
    const actor = users.find(u => u.username === actorUsername);
    if (!actor || (actor.role !== 'admin' && !usersInDeptId(doc.toUnit).includes(actor.username))) return res.status(403).json({ success: false, error: `رد این سند فقط برای کاربرانِ ${deptName(doc.toUnit)} (یا مدیر) است` });
    doc.status = 'rejected';
    doc.rejectedBy = actorUsername; doc.rejectedAt = new Date().toISOString(); doc.rejectReason = reason.slice(0, 300); doc.rejectStage = 'receiver';
    doc.note = doc.note ? `${doc.note} | دلیل رد: ${doc.rejectReason}` : `دلیل رد: ${doc.rejectReason}`;
    saveData();
    logActivity(actorUsername, 'رد سند خروج توسط گیرنده', `سند ${doc.docNo || doc.id} - از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)} - ${resolveItemName(doc.item)} × ${doc.qty} - دلیل: ${doc.rejectReason}`);
    notifyRejected(doc, actorUsername, doc.rejectReason, deptName(doc.toUnit));
    res.json({ success: true, doc, message: `سند ${doc.docNo || doc.id} رد شد؛ کالا نزدِ ${deptName(doc.fromUnit)} می‌ماند` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/doc/output/warehouse-reject', (req, res) => {
  try {
    const { docId, actorUsername, reason } = req.body;

    loadData();

    const actor = users.find(u => u.username === actorUsername);
    if (!actor || (actor.role !== 'warehouse' && actor.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند این سند را رد کند' });
    }

    const doc = docs.find(d => d.id === docId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    if (doc.status !== 'pending_warehouse') {
      return res.status(400).json({ success: false, error: 'این سند در وضعیت مناسب برای رد انباردار نیست' });
    }

    doc.status = 'rejected';
    doc.rejectedBy = actorUsername; doc.rejectedAt = new Date().toISOString(); doc.rejectReason = reason || ''; doc.rejectStage = 'warehouse';
    if (reason) doc.note = doc.note ? `${doc.note} | دلیل رد: ${reason}` : `دلیل رد: ${reason}`;

    saveData();
    notifyRejected(doc, actorUsername, reason, 'انباردار');
    logActivity(actorUsername, 'رد انباردار برای خروج بین بخش‌ها', `سند ${doc.id} - از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)} - کالا: ${doc.item}, تعداد: ${doc.qty}`);

    res.json({ success: true, doc: doc, message: `سند ${doc.id} توسط انباردار رد شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// API های برگشت از خروج
// ============================================

// بازگشت به بخش قبلی (یک مسیرِ واحد برای وب و موبایل): یک سندِ «خروج» عادی در جهتِ عکس ثبت می‌شود
// (returnOfDocId = سندِ اصلی) با همان چک‌های خروج: کمبودِ موجودی، تاییدِ انباردار در صورتِ نیاز، تاییدِ گیرنده.
// مسیرِ قدیمیِ سندِ «برگشت» (return_pending) فقط برای اسنادِ قدیمی باقی است (return/approve و return/reject).
// مقدارِ برگشت‌خورده (یا در حالِ برگشت) از یک خروج: خروج‌های عکسِ فعال + اسنادِ «برگشتِ» قدیمی
function returnedQtyOf(parentId) {
  let s = 0;
  docs.forEach(d => {
    if (d.returnOfDocId === parentId && ['pending', 'pending_warehouse', 'approved'].includes(d.status)) s += Number(d.qty) || 0;
    if (d.type === 'return' && d.parentDocId === parentId && (d.status === 'return_pending' || d.status === 'return_approved')) s += Number(d.qty) || 0;
  });
  return Math.round(s * 1e6) / 1e6;
}
// بازگشت به بخش قبلی (یک مسیرِ واحد برای وب و موبایل): یک سندِ «خروج» عادی در جهتِ عکس ثبت می‌شود
// (returnOfDocId = سندِ اصلی) با همان چک‌های خروج: کمبودِ موجودی، تاییدِ انباردار در صورتِ نیاز، تاییدِ گیرنده.
// مقدار می‌تواند بخشی از حواله باشد (qty)؛ جمعِ برگشتی‌ها از مقدارِ حواله بیشتر نمی‌شود.
// مسیرِ قدیمیِ سندِ «برگشت» (return_pending) فقط برای اسنادِ قدیمی باقی است (return/approve و return/reject).
app.post('/api/doc/output/request-return', (req, res) => {
  try {
    const { docId, actorUsername } = req.body;
    loadData();
    const parentDoc = docs.find(d => d.id === Number(docId));
    if (!parentDoc) return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    if (parentDoc.type !== 'output') return res.status(400).json({ success: false, error: 'فقط اسناد خروج قابل برگشت هستند' });
    if (parentDoc.status !== 'approved') return res.status(400).json({ success: false, error: 'فقط اسناد تایید شده قابل برگشت هستند' });
    const actor = users.find(u => u.username === actorUsername);
    if (!actor || (actor.role !== 'admin' && !usersInDeptId(parentDoc.toUnit).includes(actor.username))) {
      return res.status(403).json({ success: false, error: `بازگشتِ این کالا را فقط کاربرانِ بخش «${deptName(parentDoc.toUnit)}» (یا مدیر) می‌توانند ثبت کنند` });
    }
    const remaining = Math.round((parentDoc.qty - returnedQtyOf(parentDoc.id)) * 1e6) / 1e6;
    if (remaining <= QTY_EPS) return res.status(400).json({ success: false, error: `کلِ مقدارِ سند ${parentDoc.docNo || parentDoc.id} قبلاً برگشت داده شده (یا در حالِ برگشت است)` });
    const qty = req.body.qty === undefined || req.body.qty === null || req.body.qty === '' ? remaining : Number(req.body.qty);
    if (!(qty > 0)) return res.status(400).json({ success: false, error: 'مقدارِ برگشت نامعتبر است' });
    if (qty > remaining + QTY_EPS) return res.status(400).json({ success: false, error: `حداکثر قابلِ برگشت از این سند ${remaining} است (از ${parentDoc.qty}، ${Math.round((parentDoc.qty - remaining) * 1e6) / 1e6} قبلاً برگشت خورده)` });
    const userNote = String(req.body.note || '').trim().slice(0, 300);
    const r = Object.create(req);
    r.body = { from: parentDoc.toUnit, to: parentDoc.fromUnit, item: parentDoc.item, qty,
      note: `بازگشت کالای سند خروج ${parentDoc.docNo || parentDoc.id}` + (userNote ? ` - ${userNote}` : ''), date: req.body.date, createdBy: actorUsername, actorUsername, returnOfDocId: parentDoc.id };
    return ROUTE_HANDLERS['post /api/doc/output'](r, res);
  } catch (err) {
    console.error('Error in request-return:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/doc/return/approve', (req, res) => {
  try {
    const { docId } = req.body;
    
    loadData();
    
    const returnDoc = docs.find(d => d.id === docId);
    if (!returnDoc) {
      return res.status(404).json({ success: false, error: 'سند برگشت یافت نشد' });
    }
    if (returnDoc.status !== 'return_pending') {
      return res.status(400).json({ success: false, error: 'این سند در وضعیت مناسب نیست' });
    }
    if (returnDoc.type !== 'return') {
      return res.status(400).json({ success: false, error: 'فقط اسناد برگشت قابل تایید هستند' });
    }
    {
      const approver = users.find(u => u.username === (req.body && req.body.actorUsername));
      const allowedReceiver = approver && (approver.role === 'admin' || usersInDeptId(returnDoc.toUnit).includes(approver.username));
      if (!allowedReceiver) {
        return res.status(403).json({ success: false, error: `برگشت را فقط کاربرانِ بخش «${deptName(returnDoc.toUnit)}» (یا مدیر) می‌توانند تایید کنند` });
      }
    }
    
    const parentDoc = docs.find(d => d.id === returnDoc.parentDocId);
    if (!parentDoc) {
      return res.status(404).json({ success: false, error: 'سند اصلی یافت نشد' });
    }
    
    const fromUnit = returnDoc.fromUnit;
    const toUnit = returnDoc.toUnit;
    const item = returnDoc.item;
    const qty = returnDoc.qty;
    const batchNumber = returnDoc.batchNumber || generateBatchNumber();
    
    if (!inventory[fromUnit] || !inventory[fromUnit][item] || inventory[fromUnit][item] + QTY_EPS < qty) {
      return res.status(400).json({ success: false, error: 'موجودی مبدأ برگشت کافی نیست' });
    }
    
    inventory[fromUnit][item] -= qty;
    if (!inventory[toUnit]) inventory[toUnit] = {};
    if (!inventory[toUnit][item]) inventory[toUnit][item] = 0;
    inventory[toUnit][item] += qty;
    
    if (parentDoc.transactionId) {
      const txIdx = transactions.findIndex(t => t.id === parentDoc.transactionId);
      if (txIdx > -1) {
        transactions.splice(txIdx, 1);
        parentDoc.transactionId = null;
      }
    }
    if (parentDoc.transactionId2) {
      const txIdx2 = transactions.findIndex(t => t.id === parentDoc.transactionId2);
      if (txIdx2 > -1) {
        transactions.splice(txIdx2, 1);
        parentDoc.transactionId2 = null;
      }
    }
    
    const tx = {
      id: seqId++,
      date: todayJalali(),
      type: 'return',
      unit: fromUnit,
      item: item,
      qty: qty,
      note: returnDoc.note || `برگشت به ${deptName(toUnit)}`,
      targetUnit: toUnit,
      fiscalYear: returnDoc.fiscalYear,
      batchNumber: batchNumber
    };
    transactions.push(tx);
    
    returnDoc.transactionId = tx.id;
    returnDoc.status = 'return_approved';
    returnDoc.approvedBy = (req.body && req.body.actorUsername) || null;
    returnDoc.approvedAt = new Date().toISOString();
    parentDoc.status = 'returned';
    returnDoc.batchNumber = batchNumber;
    
    saveData();
    
    res.json({ 
      success: true, 
      message: `✅ برگشت سند ${docId} تایید شد`,
      doc: returnDoc,
      batchNumber: batchNumber
    });
  } catch (err) {
    console.error('Error in approve-return:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/doc/return/reject', (req, res) => {
  try {
    const { docId } = req.body;
    
    loadData();
    
    const returnDoc = docs.find(d => d.id === docId);
    if (!returnDoc) {
      return res.status(404).json({ success: false, error: 'سند برگشت یافت نشد' });
    }
    if (returnDoc.status !== 'return_pending') {
      return res.status(400).json({ success: false, error: 'این سند قابل لغو نیست' });
    }
    if (returnDoc.type !== 'return') {
      return res.status(400).json({ success: false, error: 'فقط اسناد برگشت قابل لغو هستند' });
    }
    
    returnDoc.status = 'return_rejected';
    if (req.body.reason) { returnDoc.rejectedBy = req.body.actorUsername; returnDoc.note = returnDoc.note ? `${returnDoc.note} | دلیل رد: ${req.body.reason}` : `دلیل رد: ${req.body.reason}`; }
    
    saveData();
    
    res.json({ 
      success: true, 
      message: `❌ برگشت سند ${docId} لغو شد`,
      doc: returnDoc
    });
  } catch (err) {
    console.error('Error in reject-return:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// صادرکننده (یا مدیر) فقط تا قبل از «اولین تایید» می‌تواند سندش را حذف/ویرایش کند. اولین تایید: تاییدِ انباردار، تاییدِ گیرنده،
// تاییدِ تولید/تعدیل یا ارسالِ حواله. اسنادِ ساخته‌شده توسط «برگشتِ معیوب» از مسیرِ خودش لغو می‌شوند.
const SENDER_EDITABLE = ['pending', 'pending_warehouse', 'pending_production', 'pending_approval', 'pending_dispatch'];
function senderModifyProblem(doc, actorUsername, verb) {
  const u = users.find(x => x.username === actorUsername);
  if (!u) return { code: 403, msg: 'کاربر شناخته نشد' };
  if (u.role !== 'admin' && doc.createdBy !== actorUsername) return { code: 403, msg: `${verb}ِ سند فقط برای صادرکننده‌ی آن (یا مدیر) است` };
  if (!SENDER_EDITABLE.includes(doc.status) || (doc.status === 'pending' && doc.warehouseApprovedBy)) return { code: 400, msg: `این سند اولین تایید را گرفته (${doc.warehouseApprovedBy ? 'تاییدِ انباردار' : 'تایید شده'})؛ ${verb} دیگر ممکن نیست${doc.type === 'output' && doc.status === 'pending' ? ' - گیرنده می‌تواند آن را رد کند' : ''}` };
  if (doc.reworkId) return { code: 400, msg: 'این سند بخشی از «برگشتِ معیوب» است؛ از همان‌جا لغو کنید' };
  if (doc.type === 'consume' && doc.parentDocId) return { code: 400, msg: 'موادِ تولید جدا تغییر نمی‌کنند؛ خودِ سندِ تولید را ویرایش/حذف کنید' };
  return null;
}
// ویرایشِ تعداد/توضیحِ سندِ در انتظار توسط صادرکننده (قبل از اولین تایید)
app.post('/api/doc/:id/edit', (req, res) => {
  try {
    loadData();
    const doc = docs.find(d => d.id === parseInt(req.params.id, 10));
    if (!doc) return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    if (!['output', 'production', 'waste', 'shortage', 'excess', 'dispatch'].includes(doc.type)) return res.status(400).json({ success: false, error: 'این نوع سند ویرایش نمی‌شود' });
    { const why = senderModifyProblem(doc, req.body && req.body.actorUsername, 'ویرایش'); if (why) return res.status(why.code).json({ success: false, error: why.msg }); }
    const qty = Math.round(Number(req.body.qty) * 1e6) / 1e6;
    if (!(qty > 0 && qty <= 1e9)) return res.status(400).json({ success: false, error: 'تعداد باید عددی بزرگ‌تر از صفر باشد' });
    const note = req.body.note === undefined ? doc.note : String(req.body.note || '').trim().slice(0, 300);
    const unitOf = doc.type === 'output' ? doc.fromUnit : doc.unit;
    if (doc.type === 'output' || doc.type === 'waste' || doc.type === 'shortage') {
      const avail = availableQty(unitOf, doc.item, doc.id);
      if (avail + QTY_EPS < qty) return res.status(400).json({ success: false, error: `موجودیِ قابل‌استفاده‌ی «${resolveItemName(doc.item)}» در ${deptName(unitOf)} ${formatNumber(avail)} است` });
    }
    if (doc.type === 'output' && doc.returnOfDocId) {
      const src = docs.find(d => d.id === doc.returnOfDocId);
      if (src && returnedQtyOf(src.id) - doc.qty + qty > src.qty + QTY_EPS) return res.status(400).json({ success: false, error: `حداکثر قابلِ برگشت از سند ${src.docNo || src.id}: ${formatNumber(src.qty - returnedQtyOf(src.id) + doc.qty)}` });
    }
    let kids = [];
    if (doc.type === 'production') {
      kids = docs.filter(d => d.parentDocId === doc.id && d.type === 'consume' && d.status === 'pending_production');
      const k = qty / doc.qty;
      const errs = kids.map(c => { const nq = Math.round(c.qty * k * 1e6) / 1e6; return availableQty(doc.unit, c.item) + QTY_EPS < nq ? `«${resolveItemName(c.item)}»: لازم ${formatNumber(nq)}، موجود ${formatNumber(availableQty(doc.unit, c.item))}` : null; }).filter(Boolean);
      if (errs.length) return res.status(400).json({ success: false, error: 'موادِ کافی نیست:\n' + errs.join('\n') });
      kids.forEach(c => { c.qty = Math.round(c.qty * k * 1e6) / 1e6; });
    }
    const before = { qty: doc.qty, note: doc.note };
    doc.qty = qty; doc.note = note;
    if (doc.type === 'dispatch' && doc.orderedQty != null && doc.status === 'pending_dispatch') doc.orderedQty = qty;
    doc.editHistory = doc.editHistory || [];
    doc.editHistory.push({ at: new Date().toISOString(), by: req.body.actorUsername, from: before, to: { qty, note } });
    saveData();
    logActivity(req.body.actorUsername, 'ویرایشِ سندِ در انتظار', `سند ${doc.docNo || doc.id} (${doc.type}) - ${resolveItemName(doc.item)}: ${before.qty} ← ${qty}${kids.length ? ` (${kids.length} ردیف مواد به همان نسبت)` : ''}`);
    res.json({ success: true, doc, message: `سند ${doc.docNo || doc.id} ویرایش شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.delete('/api/doc/:id', (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    
    loadData();
    
    const idx = docs.findIndex(d => d.id === docId);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    
    const doc = docs[idx];
    // pending_warehouse هم قابل‌حذفه (سند خروجی که هنوز حتی نوبتِ انباردار نرسیده) - فرستنده
    // باید بتونه همون اول پشیمون بشه، نه فقط بعد از رد شدن توسط انباردار.
    if (doc.status !== 'pending' && doc.status !== 'pending_warehouse' && doc.status !== 'pending_production' && doc.status !== 'pending_dispatch' && doc.status !== 'pending_approval') {
      return res.status(400).json({ success: false, error: 'فقط اسناد در انتظار تایید قابل حذف هستند' });
    }
    if (doc.type === 'consume' && doc.status === 'pending_production') {
      return res.status(400).json({ success: false, error: 'سند مصرفِ همراهِ تولید جدا حذف نمی‌شود؛ سند تولید را حذف کنید' });
    }
    { const why = senderModifyProblem(doc, req.body && req.body.actorUsername, 'حذف'); if (why) return res.status(why.code).json({ success: false, error: why.msg }); }

    // حذف، سند رو کاملاً از docs پاک می‌کنه - بدون این لاگ هیچ ردی ازش نمی‌مونه (اسناد
    // ۱۲۳ تا ۱۴۲ همین‌طوری حذف شدن و فقط از روی بکاپ‌ها قابل بازسازی بودن).
    const { actorUsername } = req.body || {};
    const warehouseNote = doc.warehouseApprovedBy
      ? `بله (${doc.warehouseApprovedBy})`
      : (doc.status === 'pending_warehouse' ? 'خیر (در انتظار انباردار)' : 'خیر');
    const route = doc.fromUnit || doc.toUnit
      ? `از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)}`
      : `بخش ${deptName(doc.unit)}`;

    docs.splice(idx, 1);
    if (doc.type === 'production' && doc.status === 'pending_production') {
      for (let i = docs.length - 1; i >= 0; i--) {
        if (docs[i].parentDocId === doc.id && docs[i].status === 'pending_production') docs.splice(i, 1);
      }
    }

    // logActivity خودش saveData() رو صدا می‌زنه، پس حذفِ سند و رکوردِ لاگ با یک نوشتن ذخیره می‌شن
    logActivity(
      actorUsername,
      'حذف سند',
      `سند ${doc.id} (${doc.type}) - کالا: ${resolveItemName(doc.item)} (${doc.item}), تعداد: ${doc.qty} - ${route} - وضعیت: ${doc.status} - تایید انباردار: ${warehouseNote} - ثبت‌کننده: ${doc.createdBy || 'نامشخص'} - دلیل: ${(req.body && req.body.reason) || '-'}`
    );

    res.json({ success: true, message: `سند ${docId} حذف شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== سند معکوس (لغوِ سندِ اثرگذاشته روی موجودی) =====
// شماره‌ی سری V در همان سال مالیِ سندِ اصلی؛ همه‌ی ردیف‌هایی که در یک عملیات باطل می‌شوند (تولید + مصرف‌ها) یک شماره دارند.
function newReversal(doc, by, reason) {
  if (!appSettings.docSerials) appSettings.docSerials = {};
  const fy = String(doc.fiscalYear || activeFiscalYear || '').replace(/\D/g, '') || '0';
  const key = fy + '|V';
  appSettings.docSerials[key] = (appSettings.docSerials[key] || 0) + 1;
  return { no: `V-${fy}-${String(appSettings.docSerials[key]).padStart(4, '0')}`, at: new Date().toISOString(), by: by || null, reason: reason || '' };
}
// اثرِ تراکنش‌های یک سند را با تراکنش‌های معکوس خنثی می‌کند (موجودی هم به همان اندازه برمی‌گردد)
function reverseDocTransactions(doc, rv) {
  const ids = [doc.transactionId, doc.transactionId2, ...(doc.extraTxIds || [])].filter(Boolean);
  const made = [];
  const bump = (u, i, q) => { if (!inventory[u]) inventory[u] = {}; inventory[u][i] = (inventory[u][i] || 0) + q; };
  ids.forEach(tid => {
    const tx = transactions.find(t => t.id === tid);
    if (!tx || tx.reversalOf) return;
    if (transactions.some(t => t.reversalOf === tx.id)) return; // قبلاً معکوس شده
    const r = { ...tx, id: seqId++, qty: -tx.qty, note: `لغو سند ${doc.docNo || doc.id} (سند معکوس ${rv.no})`, reversalOf: tx.id, reversalDocId: doc.id, reversalNo: rv.no, createdAt: rv.at };
    transactions.push(r);
    made.push(r.id);
    // اثر روی موجودی: ورودی‌ها کم، خروجی‌ها زیاد. تراکنشِ «خروج» هر دو طرف را جابه‌جا می‌کند؛ «ورود»ِ جفتش اثرِ جدا ندارد.
    if (['production', 'excess', 'receipt', 'initial'].includes(tx.type)) bump(tx.unit, tx.item, -tx.qty);
    else if (['consume', 'waste', 'shortage'].includes(tx.type)) bump(tx.unit, tx.item, tx.qty);
    else if (tx.type === 'output') { bump(tx.unit, tx.item, tx.qty); if (tx.targetUnit && tx.targetUnit !== 'customer') bump(tx.targetUnit, tx.item, -tx.qty); }
    else if (tx.type === 'input' && !doc.transactionId2) bump(tx.unit, tx.item, -tx.qty);
  });
  doc.reversal = { no: rv.no, at: rv.at, by: rv.by, reason: rv.reason, txIds: made };
  return made;
}

// ============================================
// حواله‌ی ارسال بار (خروج از انبار محصول به مشتری) - ۱۴۰۵/۰۷/۲۸
// ============================================
// جریان: دفتر مرکزی (مدیر یا نقشِ دارای «perm-dispatch-issue») حواله صادر می‌کند ← سرپرستِ انبار محصول (کاربرانِ
// همان بخش، انباردار یا مدیر) کالا را ارسال و تایید می‌کند (موجودی همان لحظه کم می‌شود؛ مقدارِ هر ردیف قابلِ کم‌کردن است)
// ← بارنامه‌ی باربری (عکس/PDF) همان موقع یا بعداً ضمیمه می‌شود؛ تا ضمیمه نشده سند «منتظر بارنامه» است.
// هر ردیف یک سندِ dispatch است (submissionId مشترک، شماره‌ی سری D)؛ تراکنشِ ارسال = output از finished به 'customer'
// (بدونِ ورود به جایی) تا کاردکس/گزارش‌ها آن را خروجی ببینند و لات‌ها (بچ) تا مشتری ردیابی شوند.
const PERM_DISPATCH_ISSUE = 'perm-dispatch-issue';
const DISPATCH_DESTS = ['مشتری', 'انبار مرکزی', 'انبار فروشگاه', 'دفتر مرکزی', 'سایر'];
const ATTACH_DIR = path.join(__dirname, 'attachments');
function canIssueDispatch(u) { return !!u && (u.role === 'admin' || ((appSettings.rolePermissions || {})[u.role] || []).includes(PERM_DISPATCH_ISSUE)); }
function canShipDispatch(u) { return !!u && (u.role === 'admin' || u.role === 'warehouse' || usersInDeptId('finished').includes(u.username)); }
function dispatchGroup(sid) { return docs.filter(d => d.type === 'dispatch' && d.submissionId === sid).sort((a, b) => a.id - b.id); }
async function notifyDispatch(lines, text) {
  try {
    const cfg = getOutputMessengerConfig();
    const room = cfg.enabled && cfg.deptGroups && cfg.deptGroups.finished;
    const msg = [text, '', `🔢 حواله: ${lines[0].docNo || lines[0].id}`, `👤 ${lines[0].destination || 'مشتری'}: ${lines[0].customer || '-'}`, '',
      ...lines.map(l => `📦 ${resolveItemName(l.item)} — ${formatNumber(l.qty)}`), lines[0].note ? `📝 ${lines[0].note}` : null].filter(Boolean).join('\n');
    if (room) { const r = await sendOutputMessengerNotification(room, msg); if (!r.success) console.error('OM dispatch:', r.error); }
  } catch (e) { console.error('notifyDispatch:', e.message); }
}
app.post('/api/dispatch', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    const u = req.authUser && users.find(x => x.username === req.authUser.username);
    if (!canIssueDispatch(u)) return res.status(403).json({ success: false, error: 'صدورِ حواله‌ی ارسال بار فقط برای مدیر یا نقش‌های دارای مجوزِ «صدور حواله ارسال» است' });
    const customer = String(req.body.customer || '').trim().slice(0, 150);
    if (customer.length < 2) return res.status(400).json({ success: false, error: 'نامِ مشتری / گیرنده را بنویسید' });
    const destination = DISPATCH_DESTS.includes(req.body.destination) ? req.body.destination : 'مشتری';
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ success: false, error: 'حداقل یک ردیف کالا لازم است' });
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], q = Number(l && l.qty);
      if (!l || !l.item || !(q > 0)) return res.status(400).json({ success: false, error: `ردیف ${i + 1}: کالا و مقدار لازم است` });
      const sp = stageKeyProblem('finished', l.item); if (sp) return res.status(400).json({ success: false, error: `ردیف ${i + 1}: ${sp}` });
      if (seen.has(l.item)) return res.status(400).json({ success: false, error: `ردیف ${i + 1}: «${resolveItemName(l.item)}» تکراری است` });
      seen.add(l.item);
    }
    const sid = 'dsp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const note = String(req.body.note || '').trim().slice(0, 500);
    const nowIso = new Date().toISOString();
    const created = lines.map(l => {
      const doc = { id: docSeq++, date: docDt, type: 'dispatch', unit: 'finished', item: l.item, qty: Math.round(Number(l.qty) * 1e6) / 1e6, fromUnit: 'finished', toUnit: 'customer',
        note, status: 'pending_dispatch', fiscalYear: activeFiscalYear, createdBy: u.username, createdAt: nowIso, submissionId: sid, transactionId: null, parentDocId: null,
        customer, destination, orderedQty: Math.round(Number(l.qty) * 1e6) / 1e6 };
      docs.push(doc); return doc;
    });
    saveData();
    logActivity(u.username, 'صدور حواله ارسال بار', `${created[0].docNo} - ${destination}: ${customer} - ${created.length} ردیف`);
    res.json({ success: true, docs: created, docNo: created[0].docNo, message: `حواله‌ی ارسال ${created[0].docNo} صادر شد و برای انبار محصول فرستاده شد` });
    notifyDispatch(created, '🚚 حواله‌ی ارسال بار صادر شد');
    sendPushToUsernames(usersInDeptId('finished').concat(usersWithRoles(['warehouse'])), { title: '🚚 حواله‌ی ارسال بار', body: `${destination}: ${customer} - ${created.length} قلم`, url: '/mobile/' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
// ارسال: lines = [{docId, qty}] (مقدارِ واقعاً ارسال‌شده؛ ۰ = این ردیف ارسال نشد)
app.post('/api/dispatch/:sid/ship', (req, res) => {
  try {
    loadData();
    const u = req.authUser && users.find(x => x.username === req.authUser.username);
    if (!canShipDispatch(u)) return res.status(403).json({ success: false, error: 'تاییدِ ارسال فقط برای کاربرانِ انبار محصول، انباردار یا مدیر است' });
    const group = dispatchGroup(req.params.sid).filter(d => d.status === 'pending_dispatch');
    if (!group.length) return res.status(404).json({ success: false, error: 'حواله‌ی در انتظارِ ارسال پیدا نشد (قبلاً ارسال یا حذف شده)' });
    { const cp = closedProblem(todayJalali()); if (cp) return res.status(400).json({ success: false, error: cp }); }
    const want = new Map((Array.isArray(req.body.lines) ? req.body.lines : []).map(l => [Number(l.docId), Number(l.qty)]));
    const plan = group.map(d => { const q = want.has(d.id) ? want.get(d.id) : d.qty; return { d, q: Math.round((isFinite(q) ? q : d.qty) * 1e6) / 1e6 }; });
    for (const p of plan) {
      if (p.q < 0 || p.q > p.d.qty + QTY_EPS) return res.status(400).json({ success: false, error: `«${resolveItemName(p.d.item)}»: مقدارِ ارسال باید بین ۰ و ${p.d.qty} باشد` });
    }
    if (!plan.some(p => p.q > QTY_EPS)) return res.status(400).json({ success: false, error: 'هیچ مقداری برای ارسال وارد نشده؛ برای لغوِ کلِ حواله آن را حذف کنید' });
    const need = {}; plan.forEach(p => { if (p.q > 0) need[p.d.item] = (need[p.d.item] || 0) + p.q; });
    const errs = Object.entries(need).map(([it, q]) => shortageMessage('finished', it, q)).filter(Boolean);
    if (errs.length) return res.status(400).json({ success: false, error: errs.join('\n') });
    const today = todayJalali(), nowIso = new Date().toISOString();
    const carrier = String(req.body.carrier || '').trim().slice(0, 150), waybillNo = String(req.body.waybillNo || '').trim().slice(0, 80);
    const shipNote = String(req.body.note || '').trim().slice(0, 300);
    plan.forEach(({ d, q }) => {
      d.shippedBy = u.username; d.shippedAt = nowIso; d.carrier = carrier; d.waybillNo = waybillNo; if (shipNote) d.shipNote = shipNote;
      if (q <= QTY_EPS) { d.status = 'cancelled'; d.cancelledBy = u.username; d.cancelledAt = nowIso; d.cancelReason = 'در زمانِ ارسال، این ردیف ارسال نشد' + (shipNote ? ' - ' + shipNote : ''); return; }
      if (q < d.qty) d.qty = q;
      const tx = { id: seqId++, date: today, type: 'output', unit: 'finished', item: d.item, qty: q, note: `ارسال به ${d.destination || 'مشتری'}: ${d.customer || ''} (حواله ${d.docNo || d.id})`,
        targetUnit: 'customer', fiscalYear: activeFiscalYear, batchNumber: null };
      transactions.push(tx);
      inventory.finished[d.item] = Math.round(((inventory.finished[d.item] || 0) - q) * 1e6) / 1e6;
      d.transactionId = tx.id; d.status = 'approved'; d.approvedBy = u.username; d.approvedAt = nowIso; d.shipDate = today;
      d.waybillPending = !(d.attachments && d.attachments.length);
    });
    saveData();
    const shipped = plan.filter(p => p.q > 0).map(p => p.d);
    logActivity(u.username, 'ارسال بار از انبار محصول', `${group[0].docNo} - ${group[0].customer} - ${shipped.map(d => `${resolveItemName(d.item)}: ${d.qty}`).join('، ')}${carrier ? ' - باربری: ' + carrier : ''}${waybillNo ? ' - بارنامه: ' + waybillNo : ''}`);
    res.json({ success: true, message: `ارسالِ حواله ${group[0].docNo} ثبت شد` + (shipped.some(d => d.waybillPending) ? ' - بارنامه را ضمیمه کنید' : '') });
    notifyDispatch(shipped, '✅ بار ارسال شد');
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
// ضمیمه‌ی بارنامه (یا هر سندِ حمل): {name, type, data: base64}؛ عکس/PDF تا ۸ مگابایت
app.post('/api/dispatch/:sid/attach', (req, res) => {
  try {
    loadData();
    const u = req.authUser && users.find(x => x.username === req.authUser.username);
    const group = dispatchGroup(req.params.sid).filter(d => d.status !== 'cancelled');
    if (!group.length) return res.status(404).json({ success: false, error: 'حواله پیدا نشد' });
    if (!canShipDispatch(u) && !(u && group[0].createdBy === u.username)) return res.status(403).json({ success: false, error: 'اجازه‌ی ضمیمه‌ی بارنامه ندارید' });
    const type = String(req.body.type || '');
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[type];
    if (!ext) return res.status(400).json({ success: false, error: 'فقط عکس (jpg/png/webp) یا PDF' });
    const buf = Buffer.from(String(req.body.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length || buf.length > 8 * 1024 * 1024) return res.status(400).json({ success: false, error: 'فایل خالی یا بزرگ‌تر از ۸ مگابایت است' });
    if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const file = `${String(group[0].docNo || group[0].id).replace(/[^\w-]/g, '_')}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(ATTACH_DIR, file), buf);
    const att = { file, name: String(req.body.name || file).slice(0, 120), type, size: buf.length, at: new Date().toISOString(), by: u.username, kind: 'waybill' };
    group.forEach(d => { (d.attachments = d.attachments || []).push(att); if (d.status === 'approved') d.waybillPending = false; });
    if (req.body.waybillNo) group.forEach(d => { d.waybillNo = String(req.body.waybillNo).slice(0, 80); });
    saveData();
    logActivity(u.username, 'ضمیمه‌ی بارنامه', `${group[0].docNo} - ${att.name} (${Math.round(buf.length / 1024)}KB)`);
    res.json({ success: true, attachment: att, message: 'بارنامه ضمیمه شد' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/attachments/:file', (req, res) => {
  const f = path.basename(String(req.params.file || ''));
  const full = path.join(ATTACH_DIR, f);
  if (!/^[\w.-]+$/.test(f) || !fs.existsSync(full)) return res.status(404).json({ success: false, error: 'فایل پیدا نشد' });
  res.sendFile(full);
});
// فهرستِ مشتریانِ قبلی (برای پیشنهاد در فرم)
app.get('/api/dispatch/customers', (req, res) => {
  loadData();
  res.json({ success: true, customers: [...new Set(docs.filter(d => d.type === 'dispatch' && d.customer).map(d => d.customer))].slice(-300) });
});

// ===== بستن/بازکردنِ دوره =====
function pendingDocsThrough(date) {
  return docs.filter(d => /^pending|^return_pending/.test(d.status) && d.date && (normalizeJalaliDate(d.date).value || d.date) <= date)
    .map(d => ({ id: d.id, docNo: d.docNo || String(d.id), type: d.type, status: d.status, date: d.date, item: resolveItemName(d.item), qty: d.qty }));
}
app.get('/api/period-close', (req, res) => {
  loadData();
  const through = req.query.through ? normalizeJalaliDate(req.query.through) : null;
  res.json({ success: true, closedThrough: closedThrough(), today: todayJalali(), history: (appSettings.closeHistory || []).slice(-30).reverse(),
    pendingInRange: through && through.ok ? pendingDocsThrough(through.value) : undefined });
});
app.post('/api/period-close', (req, res) => {
  try {
    loadData();
    if (!req.authUser || req.authUser.role !== 'admin') return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند دوره را ببندد یا باز کند' });
    const { action, through, reason } = req.body || {};
    const n = through ? normalizeJalaliDate(through) : null;
    const cur = closedThrough();
    const today = todayJalali();
    if (action === 'close') {
      if (!n || !n.ok) return res.status(400).json({ success: false, error: 'تاریخِ بستن نامعتبر است' });
      if (n.value > today) return res.status(400).json({ success: false, error: 'روزِ آینده را نمی‌شود بست' });
      if (cur && n.value <= cur) return res.status(400).json({ success: false, error: `دوره همین الان تا ${cur} بسته است` });
      const pend = pendingDocsThrough(n.value);
      if (pend.length) return res.status(400).json({ success: false, pending: pend, error: `${pend.length} سندِ در انتظار با تاریخ تا ${n.value} هست؛ اول تکلیفشان را روشن کنید (تایید/رد/حذف):\n` + pend.slice(0, 15).map(d => `${d.docNo} (${d.date}) - ${d.item} ${d.qty}`).join('\n') });
      const sc = stockCounts.find(c => c.status === 'open' && c.dateJalali <= n.value);
      if (sc) return res.status(400).json({ success: false, error: `برگه‌ی انبارگردانیِ باز (شماره ${sc.id}، ${deptName(sc.unit)}، ${sc.dateJalali}) در این دوره هست؛ اول نهایی یا لغوش کنید` });
      appSettings.closedThrough = n.value;
    } else if (action === 'reopen') {
      if (!cur) return res.status(400).json({ success: false, error: 'دوره‌ی بسته‌ای وجود ندارد' });
      if (String(reason || '').trim().length < 5) return res.status(400).json({ success: false, error: 'دلیلِ بازکردنِ دوره را بنویسید (حداقل ۵ حرف)' });
      if (n && !n.ok) return res.status(400).json({ success: false, error: 'تاریخ نامعتبر است' });
      if (n && n.value >= cur) return res.status(400).json({ success: false, error: 'برای بازکردن، تاریخی قبل از ' + cur + ' بدهید (یا خالی برای بازکردنِ کامل)' });
      appSettings.closedThrough = n ? n.value : null;
    } else return res.status(400).json({ success: false, error: 'عملیات نامعتبر است' });
    (appSettings.closeHistory = appSettings.closeHistory || []).push({ at: new Date().toISOString(), by: req.authUser.username, action, from: cur, to: appSettings.closedThrough, reason: String(reason || '').slice(0, 300) });
    saveData();
    logActivity(req.authUser.username, action === 'close' ? 'بستن دوره' : 'بازکردن دوره', `${cur || '-'} ← ${appSettings.closedThrough || 'باز'}${reason ? ' - دلیل: ' + reason : ''}`);
    res.json({ success: true, closedThrough: appSettings.closedThrough, message: appSettings.closedThrough ? `دوره تا ${appSettings.closedThrough} بسته است` : 'همه‌ی دوره‌ها باز شد' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== گزارش‌های بچ =====
// لات‌های فعلیِ یک بخش (اختیاری: یک کالا)
app.get('/api/lots/stock', (req, res) => {
  try {
    loadData();
    const { unit, item } = req.query;
    const { lots } = buildLotLedger();
    const rows = [];
    lots.forEach((L, k) => {
      const [u, ...rest] = k.split('|'); const i = rest.join('|');
      if (unit && u !== unit) return; if (item && i !== item) return;
      L.forEach(x => rows.push({ unit: u, unitName: deptName(u), item: i, name: resolveItemName(i), batch: x.batch, qty: x.qty }));
    });
    res.json({ success: true, rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
// ردیابیِ یک بچ: از کجا آمده (موادِ مصرف‌شده و بچ‌هایشان، چند مرحله عقب) و به کجا رفته (انتقال/مصرف در تولیدِ بعدی، چند مرحله جلو) + الان کجاست
app.get('/api/lots/trace', (req, res) => {
  try {
    loadData();
    const batch = String(req.query.batch || '').trim();
    if (!batch) return res.status(400).json({ success: false, error: 'شماره‌ی بچ را وارد کنید' });
    const { lots, alloc, docByTx } = buildLotLedger();
    const txs = transactions.filter(t => !t.reversalOf);
    const reversed = new Set(transactions.filter(t => t.reversalOf).map(t => t.reversalOf));
    const docInfo = d => d ? { id: d.id, docNo: d.docNo || String(d.id), type: d.type, status: d.status, date: d.date } : null;
    const origin = b => txs.filter(t => LOT_IN.includes(t.type) && lotLabelFor(t, docByTx.get(t.id)) === b)
      .map(t => ({ txId: t.id, type: t.type, unit: t.unit, unitName: deptName(t.unit), item: t.item, name: resolveItemName(t.item), qty: t.qty, date: t.date, doc: docInfo(docByTx.get(t.id)), cancelled: reversed.has(t.id) }));
    // عقب: برای بچِ تولید، مصرف‌هایی که همان بچِ تولید را دارند (consume.batchNumber = بچِ تولید) و لات‌هایی که برداشته‌اند
    const back = (b, depth, seen) => {
      if (depth > 8 || seen.has(b)) return [];
      seen.add(b);
      const prod = txs.filter(t => t.type === 'production' && t.batchNumber === b);
      if (!prod.length) return [];
      const prodDocIds = new Set(prod.map(t => docByTx.get(t.id)).filter(Boolean).map(d => d.id));
      const cons = txs.filter(t => (t.type === 'consume' || t.type === 'waste') && t.batchNumber === b && (() => { const d = docByTx.get(t.id); return !d || !d.parentDocId || prodDocIds.has(d.parentDocId); })());
      return cons.flatMap(t => (alloc.get(t.id) || []).map(p => ({ item: t.item, name: resolveItemName(t.item), unitName: deptName(t.unit), batch: p.batch, qty: Math.round(p.qty * 1e6) / 1e6, cancelled: reversed.has(t.id),
        from: p.batch === LOT_UNKNOWN ? [] : back(p.batch, depth + 1, seen) })));
    };
    // جلو: هر برداشتی که از این بچ شده
    const fwd = (b, depth, seen) => {
      if (depth > 8 || seen.has(b)) return [];
      seen.add(b);
      const out = [];
      txs.forEach(t => {
        if (!LOT_OUT.includes(t.type)) return;
        const part = (alloc.get(t.id) || []).filter(p => p.batch === b).reduce((a, p) => a + p.qty, 0);
        if (part <= 1e-9) return;
        const d = docByTx.get(t.id);
        const e = { type: t.type, unitName: deptName(t.unit), toUnitName: t.type === 'output' ? deptName(t.targetUnit) : '', item: t.item, name: resolveItemName(t.item), qty: Math.round(part * 1e6) / 1e6, date: t.date, doc: docInfo(d), cancelled: reversed.has(t.id) };
        if ((t.type === 'consume' || t.type === 'waste') && t.batchNumber && t.batchNumber !== b) {
          e.intoBatch = t.batchNumber;
          const p = txs.find(x => x.type === 'production' && x.batchNumber === t.batchNumber);
          if (p) { e.intoItem = p.item; e.intoName = resolveItemName(p.item); e.next = fwd(t.batchNumber, depth + 1, seen); }
        }
        out.push(e);
      });
      return out;
    };
    const now = [];
    lots.forEach((L, k) => { const [u, ...rest] = k.split('|'); const i = rest.join('|'); L.forEach(x => { if (x.batch === batch) now.push({ unitName: deptName(u), item: i, name: resolveItemName(i), qty: x.qty }); }); });
    const org = origin(batch);
    if (!org.length && !now.length && !txs.some(t => (alloc.get(t.id) || []).some(p => p.batch === batch))) return res.status(404).json({ success: false, error: 'این بچ در سیستم پیدا نشد' });
    res.json({ success: true, batch, origin: org, consumed: back(batch, 0, new Set()), usedIn: fwd(batch, 0, new Set()), now });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================
// اقدامِ گروهی روی چند سند (یک «سندِ چندردیفی»): تایید/رد/لغو/حذفِ همه‌ی ردیف‌ها با هم - همه یا هیچ.
// همان endpointهای تک‌سندی (با همه‌ی چک‌هایشان) یکی‌یکی صدا زده می‌شوند؛ اگر یکی خطا بدهد کلِ کار برمی‌گردد.
// ============================================
const BATCH_ACTIONS = {
  'output-approve': ['post', '/api/doc/output/approve'],
  'output-warehouse-approve': ['post', '/api/doc/output/warehouse-approve'],
  'output-warehouse-reject': ['post', '/api/doc/output/warehouse-reject', true],
  'output-reject': ['post', '/api/doc/output/reject', true],
  'production-approve': ['post', '/api/doc/production/approve'],
  'production-reject': ['post', '/api/doc/production/reject', true],
  'cancel': ['post', '/api/doc/:id/cancel', true],
  'delete': ['delete', '/api/doc/:id', true]
};
// ============================================
// دوباره‌کاری (برگشتِ معیوب) - ۱۴۰۵/۰۷/۲۹
// ============================================
// الگوی استاندارد (NCR + Unbuild + Rework order): تزریق کالای معیوب را با «علت» ثبت می‌کند؛ اگر کالا تزریق‌شده (INJ) باشد
// سیستم آن را «باز» می‌کند: تولیدِ همان بچ به اندازه‌ی معیوب منفی می‌شود و کابلِ لحیم‌شده‌ی مصرف‌شده‌اش (با همان لات‌ها)
// به موجودیِ تزریق برمی‌گردد (موادِ تزریق مثل TPV از دست رفته و فقط گزارش می‌شوند)؛ بعد یک خروجِ عادی (برگشت) به لحیم
// ثبت می‌شود که لحیم تحویل می‌گیرد. لحیم با «تعمیر شد» موادِ مرحله‌ی لحیمِ فرمول (سوکت/USB) را به اندازه‌ی تعمیرشده
// ضایعات می‌زند (سوکت‌های قبلی دور ریخته شده‌اند)، باقیِ غیرقابل‌تعمیر را ضایعات می‌کند و تعمیرشده‌ها را با خروجِ عادی
// به تزریق می‌فرستد. هیچ «تولیدِ» جدیدی ثبت نمی‌شود (کابل دوباره مصرف نمی‌شود). همه‌چیز یک‌جا (همه یا هیچ).
const REWORK_REASONS_DEFAULT = ['جدا شدن کابل از سوکت', 'سوکت خراب', 'قطعی کابل', 'سایر'];
const REWORK_ROUTE = { inject: 'solder' }; // بخشِ کشفِ خرابی ← بخشی که تعمیر می‌کند
function reworkReasons() { const r = appSettings && appSettings.reworkReasons; return Array.isArray(r) && r.length ? r : REWORK_REASONS_DEFAULT; }
const rwR = v => Math.round(v * 1e6) / 1e6;
const scaleLots = (lots, k) => (lots || []).map(p => ({ batch: p.batch, qty: rwR(p.qty * k) })).filter(p => Math.abs(p.qty) > 1e-9);
const mergeLots = arr => { const m = new Map(); arr.forEach(p => m.set(p.batch, rwR((m.get(p.batch) || 0) + p.qty))); return [...m.entries()].map(([batch, qty]) => ({ batch, qty })).filter(p => p.qty > 1e-9); };
// برداشت از لات‌های یک کالا: جدیدترین اول (کالای معیوب معمولاً همان تولیدِ اخیر است)
function takeNewestLots(ledger, unit, item, qty) {
  const L = (ledger.lots.get(unit + '|' + item) || []).slice().sort((a, b) => b.seq - a.seq);
  const out = []; let left = qty;
  for (const e of L) { if (left <= 1e-9) break; const q = Math.min(e.qty, left); if (q > 1e-9) { out.push({ batch: e.batch, qty: rwR(q) }); left -= q; } }
  if (left > 1e-9) out.push({ batch: LOT_UNKNOWN, qty: rwR(left) });
  return out;
}
// موادِ مرحله‌ی لحیم (سوکت، USB، …) برای هر عدد کالای لحیم‌شده، از فرمول
function reworkRepairMaterials(solItem, preferFk) {
  const pc = splitColor(solItem).base.replace(/^SOL-/, '');
  const ks = formulaKeysOfProductCode(pc);
  const fk = preferFk && getFormula(preferFk) ? preferFk : ks[0] || null;
  const f = fk ? getFormula(fk) : null;
  const mats = f ? (f.materials || []).filter(m => m.stage === 'solder' && !isStageKey(m.code) && Number(m.qty) > 0).map(m => ({ item: m.code, qty: Number(m.qty) })) : [];
  return { formulaKey: fk, perUnit: mats };
}
// نقشه‌ی برگشت: چه چیزی باز می‌شود و چه چیزی به بخشِ تعمیر برمی‌گردد (بدونِ هیچ تغییری)
function reworkPlan(unit, item, qty) {
  const target = REWORK_ROUTE[unit];
  if (!target) return { error: `برگشتِ معیوب فعلاً فقط از ${deptName('inject')} به ${deptName('solder')} است` };
  if (!(qty > 0)) return { error: 'تعداد نامعتبر است' };
  const avail = availableQty(unit, item);
  if (avail + QTY_EPS < qty) return { error: `موجودیِ قابل‌استفاده‌ی «${resolveItemName(item)}» در ${deptName(unit)} ${formatNumber(avail)} است` };
  const ledger = buildLotLedger();
  const base = splitColor(item).base;
  if (/^SOL-/.test(base)) { // هنوز تزریق نشده: فقط برگشت
    const lots = takeNewestLots(ledger, unit, item, qty);
    const fk = lots.map(p => ledger.batchFk.get(p.batch)).find(Boolean) || null;
    return { kind: 'direct', target, unbuild: [], returnLines: [{ item, qty, lots }], lost: [], ...reworkRepairMaterials(item, fk) };
  }
  if (!/^INJ-/.test(base)) return { error: 'فقط کابلِ لحیم‌شده یا محصولِ تزریق‌شده قابلِ برگشت به لحیم است' };
  const parts = takeNewestLots(ledger, unit, item, qty);
  const unbuild = [], ret = new Map(), lost = new Map();
  let fk = null;
  const addLost = (code, q) => { if (q > 1e-9) lost.set(code, rwR((lost.get(code) || 0) + q)); };
  for (const part of parts) {
    const P = docs.find(d => d.type === 'production' && d.unit === unit && d.item === item && d.batchNumber === part.batch && d.status === 'approved' && !d.reversal);
    const sol = [];
    if (P && P.qty > 0) {
      const kids = docs.filter(c => c.parentDocId === P.id && c.type === 'consume' && c.status === 'approved');
      kids.forEach(c => {
        const q = c.qty * part.qty / P.qty;
        if (!isStageKey(c.item)) return addLost(c.item, q);
        const ctx = transactions.find(t => t.id === c.transactionId);
        const lots = ctx && Array.isArray(ctx.lots) && ctx.qty > 0 ? scaleLots(ctx.lots, q / ctx.qty) : [{ batch: LOT_UNKNOWN, qty: rwR(q) }];
        sol.push({ item: c.item, qty: rwR(q), lots });
      });
      fk = fk || P.formulaKey || null;
    }
    if (!sol.length) { // موجودی اول/اضافاتِ بدونِ سندِ تولید: معادلِ لحیم‌شده‌ی همان کالا
      const solItem = item.replace(/^INJ-/, 'SOL-');
      if (!knownItemCode(unit, solItem) && !stageDefFor('solder', solItem)) return { error: `کالای لحیم‌شده‌ی معادلِ «${resolveItemName(item)}» پیدا نشد` };
      sol.push({ item: solItem, qty: part.qty, lots: [{ batch: part.batch, qty: part.qty }] });
      const pfk = ledger.batchFk.get(part.batch) || null; fk = fk || pfk;
      const f = getFormula(pfk) || getFormula(formulaKeysOfProductCode(base.replace(/^INJ-/, '').split('-')[0])[0]);
      ((f && f.materials) || []).filter(m => m.stage === 'inject' && !isStageKey(m.code)).forEach(m => addLost(m.code, Number(m.qty) * part.qty));
    }
    sol.forEach(s => { const r = ret.get(s.item) || { item: s.item, qty: 0, lots: [] }; r.qty = rwR(r.qty + s.qty); r.lots = mergeLots(r.lots.concat(s.lots)); ret.set(s.item, r); });
    unbuild.push({ batch: part.batch, qty: part.qty, prodDocId: P ? P.id : null, sol });
  }
  const returnLines = [...ret.values()];
  if (returnLines.length !== 1) return { error: 'این کالا از چند نوع کابلِ لحیم‌شده ساخته شده؛ برگشتِ خودکار ممکن نیست (با مدیر هماهنگ کنید)' };
  return { kind: 'unbuild', target, unbuild, returnLines, lost: [...lost.entries()].map(([item, q]) => ({ item, qty: q })), ...reworkRepairMaterials(returnLines[0].item, fk) };
}
// کابل‌های لحیم‌شده‌ی جایگزین (برای «سوکتِ نوعِ دیگر»): هر محصولِ لحیمِ دیگری؛ آن‌هایی که همان کابلِ برش (کد و طول) را دارند اول
function reworkAlternatives(rw) {
  const line = (rw.returnLines || [])[0]; if (!line) return [];
  const sc = splitColor(line.item), oldPc = sc.base.replace(/^SOL-/, '');
  const of = getFormula(rw.formulaKey) || getFormula(formulaKeysOfProductCode(oldPc)[0]);
  const cuts = ((of && of.materials) || []).filter(m => m.stage === 'cut');
  const seen = new Map();
  Object.keys(bomFormulas || {}).sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0)).forEach(fk => {
    const f = bomFormulas[fk]; if (!f || !f.productCode || f.productCode === oldPc) return;
    const base = 'SOL-' + f.productCode; if (!stageDefFor('solder', base)) return;
    const item = sc.colorSlug ? base + COLOR_SEP + sc.colorSlug : base;
    const perUnit = (f.materials || []).filter(m => m.stage === 'solder' && !isStageKey(m.code) && Number(m.qty) > 0).map(m => ({ item: m.code, qty: Number(m.qty) }));
    if (!perUnit.length) return;
    const sameCable = cuts.length > 0 && cuts.every(c => (f.materials || []).some(m => m.stage === 'cut' && m.code === c.code && Math.abs(Number(m.qty) - Number(c.qty)) < 1e-6));
    const prev = seen.get(item);
    if (!prev || (sameCable && !prev.sameCable)) seen.set(item, { item, formulaKey: fk, sameCable, perUnit });
  });
  return [...seen.values()].sort((a, b) => (b.sameCable - a.sameCable) || resolveItemName(a.item).localeCompare(resolveItemName(b.item), 'fa'));
}
app.get('/api/rework/:id/alternatives', (req, res) => {
  loadData();
  const rw = docs.find(d => d.id === Number(req.params.id) && d.type === 'rework');
  if (!rw) return res.status(404).json({ success: false, error: 'سندِ دوباره‌کاری پیدا نشد' });
  res.json({ success: true, list: reworkAlternatives(rw).map(a => ({ ...a, name: resolveItemName(a.item), perUnit: a.perUnit.map(m => ({ ...m, name: resolveItemName(m.item) })) })) });
});
// ===== مهلتِ برگشتِ تعمیرشده و هشدارِ دیرکرد =====
function reworkDefaultDueDays() { const n = Number(appSettings && appSettings.reworkDefaultDueDays); return n >= 1 && n <= 60 ? n : 3; }
function setReworkDue(rw, days, by) {
  rw.dueDays = days; rw.dueAt = new Date(Date.now() + days * 86400000).toISOString(); rw.dueSetBy = by || null; rw.dueSetAt = new Date().toISOString();
  rw.overdueAlertedAt = null;
}
function reworkOverdue(rw) { const st = reworkState(rw); return !!rw.dueAt && (st === 'in_transit' || st === 'at_repair') && Date.parse(rw.dueAt) < Date.now(); }
app.post('/api/rework/:id/due', (req, res) => {
  loadData();
  const u = users.find(x => x.username === (req.body && req.body.actorUsername));
  if (!u || !['admin', 'warehouse'].includes(u.role)) return res.status(403).json({ success: false, error: 'تعیینِ مهلت فقط برای انباردار یا مدیر است' });
  const rw = docs.find(d => d.id === Number(req.params.id) && d.type === 'rework');
  if (!rw) return res.status(404).json({ success: false, error: 'سندِ دوباره‌کاری پیدا نشد' });
  const days = Number(req.body.days);
  if (!(days >= 1 && days <= 60)) return res.status(400).json({ success: false, error: 'مهلت باید ۱ تا ۶۰ روز باشد' });
  setReworkDue(rw, days, u.username);
  saveData();
  logActivity(u.username, 'تعیینِ مهلتِ برگشتِ تعمیر', `${rw.docNo || rw.id}: ${days} روز`);
  res.json({ success: true, message: `مهلت: ${formatNumber(days)} روز از الان`, dueAt: rw.dueAt });
});
// هر ۳۰ دقیقه: دیرکردها به انباردار و مدیر (پوش)؛ هر مورد حداکثر روزی یک بار یادآوری می‌شود
function checkReworkOverdue() {
  try {
    loadData();
    const now = Date.now(), late = docs.filter(d => d.type === 'rework' && reworkOverdue(d) && (!d.overdueAlertedAt || now - Date.parse(d.overdueAlertedAt) > 86400000));
    if (!late.length) return;
    late.forEach(d => { d.overdueAlertedAt = new Date().toISOString(); });
    saveData();
    const targets = usersWithRoles(['warehouse', 'admin']);
    const groups = new Map(); late.forEach(rw => { const k = rw.reworkGroup || rw.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(rw); });
    groups.forEach(list => {
      const days = Math.floor((now - Math.min(...list.map(r => Date.parse(r.dueAt)))) / 86400000);
      const what = list.map(rw => `${formatNumber(rwR(reworkReturnQty(rw) - reworkDoneQty(rw)))} عدد «${resolveItemName(((rw.returnLines || [])[0] || {}).item || rw.item)}»`).join('، ');
      sendPushToUsernames(targets, { title: '⏰ دیرکردِ برگشتِ تعمیر از لحیم', body: `${list[0].docNo || list[0].id}: ${what}${days > 0 ? ` - ${formatNumber(days)} روز از مهلت گذشته` : ' - مهلت تمام شد'}`, url: '/mobile/' });
    });
    logActivity('سیستم', 'هشدارِ دیرکردِ برگشتِ تعمیر', [...new Set(late.map(d => d.docNo || d.id))].join('، '));
  } catch (e) { console.error('rework overdue check:', e.message); }
}
setTimeout(checkReworkOverdue, 90 * 1000);
setInterval(checkReworkOverdue, 30 * 60 * 1000);
function reworkReturnDocs(rw) { return (rw.returnLines || []).map(l => docs.find(d => d.id === l.docId) || null); }
function reworkDoneQty(rw) { return rwR((rw.repairs || []).reduce((a, r) => a + (r.qty || 0) + (r.scrapQty || 0), 0)); }
function reworkReturnQty(rw) { return rwR((rw.returnLines || []).reduce((a, l) => a + l.qty, 0)); }
function reworkState(rw) {
  if (rw.status === 'cancelled') return 'cancelled';
  const ds = reworkReturnDocs(rw);
  if (ds.some(d => !d || ['rejected', 'cancelled'].includes(d.status))) return 'return_rejected';
  if (ds.some(d => d.status !== 'approved')) return 'in_transit';
  return reworkReturnQty(rw) - reworkDoneQty(rw) > QTY_EPS ? 'at_repair' : 'done';
}
// اجرای یک handler داخلی (مثلِ /api/doc/batch)؛ خطا = استثنا
async function callInternal(method, p, req, body) {
  const r = Object.create(req); r.params = {}; r.body = body;
  const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, set() { return this; }, setHeader() {} };
  await ROUTE_HANDLERS[method + ' ' + p](r, out);
  if (out.statusCode >= 400 || !out.body || out.body.success === false) throw Object.assign(new Error((out.body && out.body.error) || 'خطای نامشخص'), { code: out.statusCode >= 400 ? out.statusCode : 400 });
  return out.body;
}
async function inReworkTx(res, fn) {
  if (batchTx) return res.status(409).json({ success: false, error: 'یک عملیاتِ دیگر در حال انجام است؛ چند لحظه بعد دوباره امتحان کنید' });
  batchTx = { pushes: [] };
  try {
    const result = await fn();
    const pushes = batchTx.pushes; batchTx = null;
    saveData();
    pushes.forEach(([u, pl]) => sendPushToUsernames(u, pl));
    res.json({ success: true, ...result });
  } catch (err) {
    batchTx = null; dbForceReload = true; loadData();
    res.status(err.code || 500).json({ success: false, error: err.message });
  }
}
function rwActorOk(username, dept) { const u = users.find(x => x.username === username); return !!u && (u.role === 'admin' || usersInDeptId(dept).includes(u.username)); }
const rwErr = (msg, code = 400) => Object.assign(new Error(msg), { code });

app.get('/api/rework/plan', (req, res) => {
  loadData();
  const p = reworkPlan(String(req.query.unit || ''), String(req.query.item || ''), Number(req.query.qty));
  if (p.error) return res.json({ success: false, error: p.error });
  res.json({ success: true, kind: p.kind, target: p.target, targetName: deptName(p.target),
    returnLines: p.returnLines.map(l => ({ item: l.item, name: resolveItemName(l.item), qty: l.qty })),
    lost: p.lost.map(l => ({ ...l, name: resolveItemName(l.item) })), perUnit: p.perUnit.map(m => ({ ...m, name: resolveItemName(m.item) })), formulaKey: p.formulaKey });
});

app.post('/api/rework', (req, res) => {
  loadData();
  const b = req.body || {};
  const unit = String(b.unit || ''), actor = b.actorUsername;
  // چند نوع کابل در یک فرم: lines[{item, qty, reason, note}]؛ سازگار با فرمِ تک‌ردیفی قدیمی
  const raw = Array.isArray(b.lines) && b.lines.length ? b.lines : [{ item: b.item, qty: b.qty, reason: b.reason, note: b.note }];
  const lines = raw.map(l => ({ item: String((l && l.item) || ''), qty: Number(l && l.qty), reason: String((l && l.reason) || b.reason || '').trim().slice(0, 100), note: String((l && l.note) || b.note || '').trim().slice(0, 300) }));
  if (lines.length > 30) return res.status(400).json({ success: false, error: 'حداکثر ۳۰ ردیف در یک فرم' });
  for (const [i, l] of lines.entries()) {
    if (!l.item) return res.status(400).json({ success: false, error: `ردیف ${i + 1}: کالا را انتخاب کنید` });
    if (!(l.qty > 0)) return res.status(400).json({ success: false, error: `ردیف ${i + 1}: تعداد را وارد کنید` });
    if (!l.reason) return res.status(400).json({ success: false, error: `ردیف ${i + 1}: علتِ خرابی را انتخاب کنید` });
  }
  // یک کابل می‌تواند چند بار با عیب‌های مختلف بیاید؛ ردیف‌های هم‌کالا و هم‌علت یکی می‌شوند
  for (let i = lines.length - 1; i > 0; i--) { const j = lines.findIndex(x => x.item === lines[i].item && x.reason === lines[i].reason); if (j < i) { lines[j].qty += lines[i].qty; if (lines[i].note && !lines[j].note) lines[j].note = lines[i].note; lines.splice(i, 1); } }
  if (!rwActorOk(actor, unit)) return res.status(403).json({ success: false, error: `برگشتِ معیوب را فقط کاربرانِ ${deptName(unit)} (یا مدیر) ثبت می‌کنند` });
  const date = todayJalali();
  { const cp = closedProblem(date); if (cp) return res.status(400).json({ success: false, error: cp }); }
  return inReworkTx(res, async () => {
    const plans = lines.map((l, i) => { const p = reworkPlan(unit, l.item, l.qty); if (p.error) throw rwErr(lines.length > 1 ? `ردیف ${i + 1}: ${p.error}` : p.error); return p; });
    // دو ردیف ممکن است به یک کابلِ لحیم‌شده برگردند (مثلاً تزریق‌شده + لحیم‌شده‌ی همان محصول): خروج‌ها جدا ثبت می‌شوند
    let groupId = null; const made = [];
    const bump = (u, i, q) => { if (!inventory[u]) inventory[u] = {}; inventory[u][i] = rwR((inventory[u][i] || 0) + q); };
    for (const [idx, l] of lines.entries()) {
      const plan = idx === 0 ? plans[0] : reworkPlan(unit, l.item, l.qty); // بعد از ردیفِ قبلی دوباره سنجیده می‌شود
      if (plan.error) throw rwErr(`ردیف ${idx + 1}: ${plan.error}`);
      const rw = { id: docSeq++, date, type: 'rework', unit, item: l.item, qty: l.qty, fromUnit: unit, toUnit: plan.target, reason: l.reason, note: l.note,
        status: 'approved', fiscalYear: activeFiscalYear, createdBy: actor, createdAt: new Date().toISOString(), transactionId: null, extraTxIds: [],
        parentDocId: null, batchNumber: generateBatchNumber(), kind: plan.kind, formulaKey: plan.formulaKey, repairPerUnit: plan.perUnit, lost: plan.lost,
        unbuild: plan.unbuild.map(u => ({ batch: u.batch, qty: u.qty, prodDocId: u.prodDocId })), returnLines: [], repairs: [] };
      if (groupId === null) groupId = rw.id;
      rw.reworkGroup = groupId;
      docs.push(rw);
      plan.unbuild.forEach(u => {
        const ptx = { id: seqId++, date, type: 'production', unit, item: l.item, qty: -u.qty, note: `باز کردنِ معیوب (دوباره‌کاری ${rw.id}) - ${l.reason}`, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber: u.batch, reworkId: rw.id };
        transactions.push(ptx); rw.extraTxIds.push(ptx.id); bump(unit, l.item, -u.qty);
        u.sol.forEach(x => {
          const ctx = { id: seqId++, date, type: 'consume', unit, item: x.item, qty: -x.qty, lots: x.lots.map(p => ({ batch: p.batch, qty: -p.qty })), note: `برگشتِ ورودی از تولیدِ معیوب (دوباره‌کاری ${rw.id})`, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber: u.batch, reworkId: rw.id };
          transactions.push(ctx); rw.extraTxIds.push(ctx.id); bump(unit, x.item, x.qty);
        });
      });
      rw.transactionId = rw.extraTxIds.shift() || null;
      for (const rl of plan.returnLines) {
        const out = await callInternal('post', '/api/doc/output', req, { from: unit, to: plan.target, item: rl.item, qty: rl.qty, date,
          note: `برگشتِ معیوب (${l.reason})${l.note ? ' - ' + l.note : ''}`, createdBy: actor, actorUsername: actor, submissionId: 'rwg-' + groupId });
        const od = docs.find(d => d.id === out.doc.id);
        od.reworkId = rw.id; od.reworkLots = rl.lots;
        rw.returnLines.push({ item: rl.item, qty: rl.qty, lots: rl.lots, docId: od.id });
      }
      made.push(rw);
    }
    logActivity(actor, 'برگشتِ معیوب (دوباره‌کاری)', made.map(rw => `${resolveItemName(rw.item)} × ${rw.qty} (${rw.reason})`).join('، ') + ` - از ${deptName(unit)} به ${deptName(made[0].toUnit)}`);
    const tot = made.reduce((a, rw) => a + reworkReturnQty(rw), 0);
    return { doc: made[0], docs: made, message: made.length > 1
      ? `برگشتِ معیوب ثبت شد: ${formatNumber(made.length)} ردیف، جمعاً ${formatNumber(tot)} عدد برای ${deptName(made[0].toUnit)} ارسال شد`
      : `برگشتِ معیوب ثبت شد: ${formatNumber(made[0].returnLines[0].qty)} عدد «${resolveItemName(made[0].returnLines[0].item)}» برای ${deptName(made[0].toUnit)} ارسال شد` };
  });
});

app.post('/api/rework/:id/repair', (req, res) => {
  loadData();
  const b = req.body || {}, actor = b.actorUsername;
  const rw = docs.find(d => d.id === Number(req.params.id) && d.type === 'rework');
  if (!rw) return res.status(404).json({ success: false, error: 'سندِ دوباره‌کاری پیدا نشد' });
  if (!rwActorOk(actor, rw.toUnit)) return res.status(403).json({ success: false, error: `تعمیر را فقط کاربرانِ ${deptName(rw.toUnit)} (یا مدیر) ثبت می‌کنند` });
  const st = reworkState(rw);
  if (st === 'in_transit') return res.status(400).json({ success: false, error: 'اول کالا را «تحویل گرفتم» بزنید' });
  if (st !== 'at_repair') return res.status(400).json({ success: false, error: st === 'done' ? 'این مورد قبلاً کامل انجام شده' : 'این سند قابلِ تعمیر نیست' });
  const qty = Number(b.qty) || 0, scrapQty = Number(b.scrapQty) || 0;
  if (qty < 0 || scrapQty < 0 || qty + scrapQty <= 0) return res.status(400).json({ success: false, error: 'تعداد نامعتبر است' });
  const rem = rwR(reworkReturnQty(rw) - reworkDoneQty(rw));
  if (qty + scrapQty > rem + QTY_EPS) return res.status(400).json({ success: false, error: `حداکثر ${formatNumber(rem)} عدد باقی مانده است` });
  const date = todayJalali();
  { const cp = closedProblem(date); if (cp) return res.status(400).json({ success: false, error: cp }); }
  const unit = rw.toUnit, line = rw.returnLines[0], sol = line.item;
  // قطعاتِ نو: none = همان سوکتِ قبلی دوباره لحیم شد (بدون مصرف)، formula = سوکتِ نو طبقِ فرمول، custom = سوکت با کدِ دیگر
  // قطعاتِ نو: none = همان سوکتِ قبلی دوباره لحیم شد؛ formula = سوکتِ نو طبقِ فرمول (فقط سرهایی که عوض شده‌اند)؛
  // convert = سوکتِ نوعِ دیگر خورد ← کالا به «کابلِ لحیم‌شده‌ی دیگری» تبدیل می‌شود و سوکت‌های (عوض‌شده‌ی) فرمولِ آن مصرف می‌شود
  const mode = ['none', 'formula', 'convert'].includes(b.mode) ? b.mode : 'formula';
  const pick = list => Array.isArray(b.materials) ? list.filter(m => b.materials.map(String).includes(m.item)) : list;
  let per = [], alt = null;
  if (mode === 'formula') per = pick(rw.repairPerUnit || []);
  else if (mode === 'convert') {
    alt = reworkAlternatives(rw).find(a => a.item === String(b.newItem || ''));
    if (!alt) return res.status(400).json({ success: false, error: 'کابلِ جدید را انتخاب کنید' });
    if (!(qty > 0)) return res.status(400).json({ success: false, error: 'تعدادِ تعمیرشده را وارد کنید' });
    per = pick(alt.perUnit);
  }
  if (mode !== 'none' && qty > 0 && !per.length) return res.status(400).json({ success: false, error: 'حداقل یک سوکتِ عوض‌شده را علامت بزنید (یا «همان سوکتِ قبلی» را انتخاب کنید)' });
  const need = per.map(m => ({ item: m.item, qty: rwR(m.qty * qty) })).filter(m => m.qty > 1e-9);
  const errs = need.map(m => shortageMessage(unit, m.item, m.qty, `برای تعمیر «${resolveItemName(m.item)}» کافی نیست`)).filter(Boolean);
  { const m = shortageMessage(unit, sol, qty + scrapQty); if (m) errs.push(m); }
  if (errs.length) return res.status(400).json({ success: false, error: errs.join('\n') });
  return inReworkTx(res, async () => {
    const wasteIds = [];
    const waste = (item, q, note) => {
      const tx = { id: seqId++, date, type: 'waste', unit, item, qty: q, note, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber: rw.batchNumber, reworkId: rw.id };
      transactions.push(tx); inventory[unit][item] = rwR((inventory[unit][item] || 0) - q);
      const d = { id: docSeq++, date, type: 'waste', unit, item, qty: q, fromUnit: '', toUnit: '', note, status: 'approved', fiscalYear: activeFiscalYear,
        createdBy: actor, createdAt: new Date().toISOString(), transactionId: tx.id, parentDocId: rw.id, batchNumber: rw.batchNumber, reworkId: rw.id };
      docs.push(d); wasteIds.push(d.id);
    };
    need.forEach(m => waste(m.item, m.qty, `مصرفِ دوباره‌کاری${alt ? ` (تبدیل به «${resolveItemName(alt.item)}»)` : ''}: ${formatNumber(qty)} عدد «${resolveItemName(sol)}» (علت: ${rw.reason})`));
    if (scrapQty > 0) waste(sol, scrapQty, `غیرقابلِ تعمیر - دوباره‌کاری ${rw.docNo || rw.id} (علت: ${rw.reason})`);
    let outputDocId = null, outItem = sol, outLots = null;
    if (alt && qty > 0) { // تبدیل: کابلِ لحیم‌شده‌ی قبلی (با همان لات‌ها) کم و کابلِ جدید اضافه می‌شود؛ آمارِ تولیدِ خالص صفر است
      const tot = reworkReturnQty(rw);
      const parts = tot > 0 ? scaleLots(line.lots, qty / tot) : [{ batch: LOT_UNKNOWN, qty }];
      const nb = rw.batchNumber + '-T' + ((rw.repairs || []).length + 1);
      parts.forEach(pt => { const t = { id: seqId++, date, type: 'production', unit, item: sol, qty: -pt.qty, note: `تبدیل به «${resolveItemName(alt.item)}» (دوباره‌کاری ${rw.docNo || rw.id})`, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber: pt.batch, reworkId: rw.id };
        transactions.push(t); rw.extraTxIds.push(t.id); inventory[unit][sol] = rwR((inventory[unit][sol] || 0) - pt.qty); });
      const t2 = { id: seqId++, date, type: 'production', unit, item: alt.item, qty, note: `تبدیل از «${resolveItemName(sol)}» با سوکتِ نوعِ دیگر (دوباره‌کاری ${rw.docNo || rw.id})`, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber: nb, formulaKey: alt.formulaKey, reworkId: rw.id };
      transactions.push(t2); rw.extraTxIds.push(t2.id); inventory[unit][alt.item] = rwR((inventory[unit][alt.item] || 0) + qty);
      outItem = alt.item; outLots = [{ batch: nb, qty }];
    }
    if (qty > 0) {
      const out = await callInternal('post', '/api/doc/output', req, { from: unit, to: rw.fromUnit, item: outItem, qty, date,
        note: `تعمیرشده (دوباره‌کاری ${rw.docNo || rw.id})`, createdBy: actor, actorUsername: actor, submissionId: 'rwr-' + rw.id + '-' + ((rw.repairs || []).length + 1) });
      const od = docs.find(d => d.id === out.doc.id);
      od.reworkId = rw.id; od.reworkRepair = true;
      const tot = reworkReturnQty(rw); if (outLots) od.reworkLots = outLots; else if (tot > 0) od.reworkLots = scaleLots(line.lots, qty / tot);
      outputDocId = od.id;
    }
    rw.repairs = rw.repairs || [];
    rw.repairs.push({ at: new Date().toISOString(), date, by: actor, qty, scrapQty, mode, newItem: alt ? alt.item : null, newFormulaKey: alt ? alt.formulaKey : null, materials: need, wasteDocIds: wasteIds, outputDocId });
    logActivity(actor, 'تعمیرِ دوباره‌کاری', `${rw.docNo || rw.id}: تعمیر ${qty}${scrapQty ? '، ضایعات ' + scrapQty : ''}`);
    return { message: (qty ? `${formatNumber(qty)} عدد تعمیرشده برای ${deptName(rw.fromUnit)} ارسال شد` : '') + (scrapQty ? `${qty ? '؛ ' : ''}${formatNumber(scrapQty)} عدد ضایعات ثبت شد` : '') };
  });
});

function reworkCancel(rw, actor, reason, res) {
  const u = users.find(x => x.username === actor);
  if (!u || (u.role !== 'admin' && rw.createdBy !== actor && !usersInDeptId(rw.fromUnit).includes(actor))) return res.status(403).json({ success: false, error: 'لغوِ این سند فقط برای ثبت‌کننده، کاربرانِ همان بخش یا مدیر است' });
  if (rw.status === 'cancelled') return res.status(400).json({ success: false, error: 'این سند قبلاً لغو شده است' });
  if ((rw.repairs || []).length) return res.status(400).json({ success: false, error: 'تعمیر روی این مورد ثبت شده؛ دیگر قابلِ لغو نیست' });
  const ds = reworkReturnDocs(rw);
  if (ds.some(d => d && d.status === 'approved')) return res.status(400).json({ success: false, error: `${deptName(rw.toUnit)} کالا را تحویل گرفته؛ برای لغو، اول باید کالا با خروجِ عادی برگردد` });
  ds.forEach(d => { if (d && ['pending', 'pending_warehouse'].includes(d.status)) { d.status = 'cancelled'; d.cancelReason = 'لغوِ برگشتِ معیوب: ' + reason; d.cancelledBy = actor; d.cancelledAt = new Date().toISOString(); } });
  const rv = newReversal(rw, actor, reason);
  reverseDocTransactions(rw, rv);
  rw.status = 'cancelled'; rw.cancelReason = reason; rw.cancelledBy = actor; rw.cancelledAt = rv.at;
  saveData();
  logActivity(actor, 'لغوِ برگشتِ معیوب', `${rw.docNo || rw.id} - ${reason}`);
  return res.json({ success: true, message: `برگشتِ معیوب ${rw.docNo || rw.id} لغو شد (سند معکوس ${rv.no})` });
}
app.post('/api/rework/:id/cancel', (req, res) => {
  loadData();
  const rw = docs.find(d => d.id === Number(req.params.id) && d.type === 'rework');
  if (!rw) return res.status(404).json({ success: false, error: 'سندِ دوباره‌کاری پیدا نشد' });
  const reason = String((req.body && req.body.reason) || '').trim();
  if (reason.length < 3) return res.status(400).json({ success: false, error: 'دلیلِ لغو را بنویسید (حداقل ۳ حرف)' });
  return reworkCancel(rw, req.body.actorUsername, reason.slice(0, 300), res);
});

app.post('/api/settings/rework-reasons', (req, res) => {
  loadData();
  const u = users.find(x => x.username === (req.body && req.body.actorUsername));
  if (!u || u.role !== 'admin') return res.status(403).json({ success: false, error: 'فقط مدیر' });
  const list = (Array.isArray(req.body.reasons) ? req.body.reasons : []).map(s => String(s).trim().slice(0, 60)).filter(Boolean);
  if (!list.length) return res.status(400).json({ success: false, error: 'حداقل یک علت لازم است' });
  appSettings.reworkReasons = [...new Set(list)];
  saveData();
  res.json({ success: true, reasons: appSettings.reworkReasons });
});

// گزارش: هر برگشتِ معیوب با وضعیت، علت، بچ و موادِ هدررفته
app.get('/api/reports/rework', (req, res) => {
  loadData();
  const list = docs.filter(d => d.type === 'rework').sort((a, b) => b.id - a.id).map(rw => {
    const mats = {}; (rw.repairs || []).forEach(r => (r.materials || []).forEach(m => { mats[m.item] = rwR((mats[m.item] || 0) + m.qty); }));
    return { id: rw.id, docNo: rw.docNo, date: rw.date, unit: rw.unit, unitName: deptName(rw.unit), toName: deptName(rw.toUnit), item: rw.item, name: resolveItemName(rw.item),
      qty: rw.qty, reason: rw.reason, note: rw.note, createdBy: rw.createdBy, state: reworkState(rw), kind: rw.kind,
      returnQty: reworkReturnQty(rw), repaired: rwR((rw.repairs || []).reduce((a, r) => a + r.qty, 0)), scrapped: rwR((rw.repairs || []).reduce((a, r) => a + (r.scrapQty || 0), 0)),
      batches: [...new Set((rw.unbuild || []).map(u => u.batch).concat((rw.returnLines || []).flatMap(l => (l.lots || []).map(p => p.batch))))],
      dueAt: rw.dueAt || null, dueDays: rw.dueDays || null, overdue: reworkOverdue(rw), doneAt: reworkState(rw) === 'done' ? ((rw.repairs || []).slice(-1)[0] || {}).at || null : null,
      conversions: (rw.repairs || []).filter(r => r.newItem).map(r => ({ item: r.newItem, name: resolveItemName(r.newItem), qty: r.qty })),
      modes: (rw.repairs || []).reduce((a, r) => { const k = r.mode || 'formula'; a[k] = rwR((a[k] || 0) + r.qty); return a; }, {}),
      lost: (rw.lost || []).map(l => ({ ...l, name: resolveItemName(l.item) })), repairMaterials: Object.entries(mats).map(([item, qty]) => ({ item, qty, name: resolveItemName(item) })) };
  });
  res.json({ success: true, list, reasons: reworkReasons() });
});

function routeHandler(method, path) { return ROUTE_HANDLERS[method + ' ' + path]; }
app.post('/api/doc/batch', async (req, res) => {
  const { action, docIds, reason, actorUsername } = req.body || {};
  const spec = BATCH_ACTIONS[action];
  if (!spec) return res.status(400).json({ success: false, error: 'عملیات نامعتبر است' });
  const ids = [...new Set((Array.isArray(docIds) ? docIds : []).map(Number).filter(Boolean))];
  if (!ids.length || ids.length > 300) return res.status(400).json({ success: false, error: 'فهرست اسناد نامعتبر است' });
  const why = String(reason || '').trim();
  if (spec[2] && why.length < 3) return res.status(400).json({ success: false, error: 'دلیلِ لغو/رد/حذف را بنویسید (حداقل ۳ حرف)' });
  if (batchTx) return res.status(409).json({ success: false, error: 'یک عملیاتِ گروهیِ دیگر در حال انجام است؛ چند لحظه بعد دوباره امتحان کنید' });
  const handler = routeHandler(spec[0], spec[1]);
  if (!handler) return res.status(500).json({ success: false, error: 'مسیرِ داخلی پیدا نشد' });
  loadData();
  // لغو/حذف از ردیفِ آخر به اول (معکوسِ ترتیبِ ثبت)، تایید از اول به آخر
  ids.sort((a, b) => spec[1].includes(':id') ? b - a : a - b);
  batchTx = { pushes: [] };
  const done = [];
  try {
    for (const id of ids) {
      const r = Object.create(req);
      r.params = { id: String(id) };
      r.body = { docId: id, actorUsername, reason: why.slice(0, 300) || undefined, dueDays: req.body.dueDays };
      const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, set() { return this; }, setHeader() {} };
      await handler(r, out);
      if (out.statusCode >= 400 || !out.body || out.body.success === false) {
        const err = (out.body && out.body.error) || 'خطای نامشخص';
        throw Object.assign(new Error(`سند ${id}: ${err}`), { code: out.statusCode >= 400 ? out.statusCode : 400 });
      }
      done.push(id);
    }
    const pushes = batchTx.pushes;
    batchTx = null;
    saveData();
    logActivity(actorUsername, 'اقدامِ گروهی روی سند', `${action} - اسناد ${ids.join('، ')}${why ? ' - دلیل: ' + why : ''}`);
    pushes.forEach(([u, p]) => sendPushToUsernames(u, p));
    res.json({ success: true, count: done.length, docIds: done, message: `${formatNumber(done.length)} ردیف انجام شد` });
  } catch (err) {
    batchTx = null;
    dbForceReload = true; loadData(); // همه‌ی تغییراتِ حافظه دور ریخته می‌شود
    res.status(err.code || 500).json({ success: false, error: err.message + (done.length ? '\nهیچ ردیفی تغییر نکرد (همه یا هیچ).' : '') });
  }
});

// ============================================
// API لغو سند با بررسی کامل زنجیره
// ============================================
app.post('/api/doc/:id/cancel', (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    
    loadData();
    
    const doc = docs.find(d => d.id === docId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'سند یافت نشد' });
    }
    
    if (doc.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'این سند قبلاً لغو شده است' });
    }
    // چه کسی می‌تواند لغو کند (قبلاً سرور هیچ چکی نداشت و هر کاربرِ واردشده هر سندی را لغو می‌کرد):
    // موجودی اول دوره فقط مدیر یا نقشِ دارای دسترسیِ «موجودی اول دوره»؛ بقیه: مدیر/سرپرست/انباردار، ثبت‌کننده، یا کاربرِ بخشِ سند
    {
      const who = (req.body && req.body.actorUsername) || null, u = users.find(x => x.username === who);
      if (!u) return res.status(403).json({ success: false, error: 'کاربر شناخته نشد' });
      if (doc.type === 'initial') {
        if (!initialActorAllowed(who)) return res.status(403).json({ success: false, error: 'لغوِ موجودی اول دوره فقط برای مدیر (یا نقشی که دسترسیِ «موجودی اول دوره» دارد) مجاز است' });
      } else if (doc.status === 'pending') {
        const why = senderModifyProblem(doc, who, 'لغو'); if (why) return res.status(why.code).json({ success: false, error: why.msg });
      } else if (u.role === 'user' && doc.createdBy !== who && ![doc.unit, doc.fromUnit, doc.toUnit].some(x => x && usersInDeptId(x).includes(who))) {
        return res.status(403).json({ success: false, error: 'فقط ثبت‌کننده، کاربرانِ همان بخش یا مدیر می‌توانند این سند را لغو کنند' });
      }
    }
    if (doc.type === 'rework') { const why = String((req.body && req.body.reason) || '').trim(); if (why.length < 3) return res.status(400).json({ success: false, error: 'دلیلِ لغو را بنویسید (حداقل ۳ حرف)' }); return reworkCancel(doc, req.body && req.body.actorUsername, why.slice(0, 300), res); }
    if (doc.reworkId && (doc.type === 'waste' || doc.reworkRepair)) return res.status(400).json({ success: false, error: 'این سند بخشی از دوباره‌کاری است و جداگانه لغو نمی‌شود' });
    if (doc.type === 'production' && docs.some(r => r.type === 'rework' && r.status !== 'cancelled' && (r.unbuild || []).some(u => u.prodDocId === doc.id))) {
      return res.status(400).json({ success: false, error: 'بخشی از این تولید با «برگشتِ معیوب» باز شده؛ اول آن سندِ دوباره‌کاری را لغو کنید' });
    }
    
    if (doc.status !== 'approved' && doc.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'فقط سندهای در انتظار یا تایید شده قابل لغو هستند' });
    }

    // findChainForDoc/findRelatedDocs فقط اسناد output/consume رو با توجه به toUnit دنبال
    // می‌کنن، ولی سند مصرفِ موادِ خودِ یک تولید (parentDocId) اصلاً toUnit نداره - پس این
    // زنجیره‌یاب چیزی براش پیدا نمی‌کنه و لغوش هیچ‌وقت مسدود نمی‌شه، حتی اگه سند تولیدِ
    // مادرش هنوز تایید شده باشه و کالای تولیدی‌ش قبلاً به بخش‌های بعدی منتقل و آنجا هم
    // مصرف/تولید شده باشه. نتیجه: موجودیِ ماده خام بی‌دلیل برمی‌گرده انگار هیچ‌وقت مصرف
    // نشده، در حالی که تولیدی که با اون ساخته شده و هرچی روش ساخته شده هنوز پابرجاست.
    // راه درست برگردوندنش، لغو خودِ سند تولید مادره (که این‌کارو با کاسکید خودکار انجام
    // می‌ده - همون بخش reversedMaterialDocs پایین‌تر) - و اون لغو خودش قبلاً چک می‌کنه که
    // آیا کالای تولیدی به بخش دیگه‌ای منتقل شده یا نه.
    if ((doc.type === 'consume' || doc.type === 'waste') && doc.parentDocId) {
      const parentDoc = docs.find(d => d.id === doc.parentDocId);
      if (parentDoc && parentDoc.status === 'approved') {
        return res.status(400).json({
          success: false,
          error: `❌ این سند مصرف قابل لغو نیست!\nاین سند بخشی از موادِ سند تولید ${parentDoc.id} (${resolveItemName(parentDoc.item)}) است که هنوز تایید شده.\nبرای برگرداندن این ماده، ابتدا خودِ سند تولید ${parentDoc.id} را لغو کنید؛ لغو آن به‌صورت خودکار همه‌ی مصرف‌های موادش (از جمله همین سند) را هم برمی‌گرداند و اگر کالای تولیدی به بخش دیگری منتقل شده باشد جلوی لغو را می‌گیرد.`
        });
      }
    }

    const chain = findChainForDoc(docId);
    
    if (chain.length > 1 && chain[0] === docId) {
      const chainDetails = chain.map(id => {
        const d = docs.find(doc => doc.id === id);
        if (!d) return `سند ${id}`;
        let typeName = '';
        if (d.type === 'production') typeName = 'تولید';
        else if (d.type === 'output') typeName = 'خروج به بخش';
        else if (d.type === 'consume') typeName = 'مصرف';
        else if (d.type === 'waste') typeName = 'ضایعات';
        else if (d.type === 'input') typeName = 'ورود به بخش';
        else if (d.type === 'return') typeName = 'برگشت';
        else if (d.type === 'shortage') typeName = 'کسری';
        else if (d.type === 'excess') typeName = 'اضافات';
        else if (d.type === 'receipt') typeName = 'رسید انبار';
        return `سند ${id} (${typeName})`;
      }).join('\n');
      
      return res.status(400).json({
        success: false,
        error: `❌ این سند قابل لغو نیست!\nزنجیره اسناد وابسته:\n${chainDetails}\n\nلطفاً ابتدا اسناد بعدی را لغو کنید.`
      });
    }
    
    if (doc.type === 'production') {
      // status هم approved هم pending رو می‌گیریم: یه انتقال pending هنوز موجودی رو جابه‌جا
      // نکرده، ولی همین الان توی کارتابل یه بخش دیگه منتظر تاییده - لغو تولید زیرِ پای یه
      // انتقالِ در جریان، تناقض ایجاد می‌کنه (چه موجودی رو منفی کنه، چه بعداً با موجودیِ
      // نامرتبط تایید بشه).
      const outputDocs = docs.filter(d =>
        d.type === 'output' &&
        d.fromUnit === doc.unit &&
        d.item === doc.item &&
        (d.status === 'approved' || d.status === 'pending' || d.status === 'pending_warehouse') && // در انتظارِ انباردار هم «در حال انتقال» است
        d.id !== docId
      );

      // فقط وقتی مانع است که کالا واقعاً از بخش رفته باشد: اگر خروجی برگشت خورده (یا موجودیِ دیگری هست) و موجودیِ
      // قابل‌استفاده (منهای در راه) به اندازه‌ی این سند هست، لغو مجاز است. قبلاً هر خروجِ تاییدشده‌ای - حتی اگر همان
      // کالا با «بازگشت به بخش قبل» برگشته بود - لغو را برای همیشه قفل می‌کرد.
      if (outputDocs.length > 0 && availableQty(doc.unit, doc.item) + QTY_EPS < doc.qty) {
        const outputDetails = outputDocs.map(d =>
          `سند خروج ${d.id} به ${deptName(d.toUnit)} (${formatNumber(d.qty)} عدد)${d.status === 'pending' ? ' - در انتظار تایید' : d.status === 'pending_warehouse' ? ' - در انتظار تایید انباردار' : ''}`
        ).join('\n');
        return res.status(400).json({
          success: false,
          error: `❌ این سند تولید قابل لغو نیست!\nکالا به بخش‌های دیگر منتقل شده یا در حال انتقال است:\n${outputDetails}\n\nلطفاً ابتدا خروج‌های مربوطه را لغو/رد کنید.`
        });
      }
      
      const consumeDocs = docs.filter(d => 
        (d.type === 'consume' || d.type === 'waste') && 
        d.unit === doc.unit && 
        d.item === doc.item && 
        d.status === 'approved' &&
        d.id !== docId
      );
      
      if (consumeDocs.length > 0 && availableQty(doc.unit, doc.item) + QTY_EPS < doc.qty) {
        return res.status(400).json({ 
          success: false, 
          error: `❌ این سند تولید قابل لغو نیست!\nاز این کالا مصرف/ضایعات ثبت شده است.\nلطفاً ابتدا اسناد مصرف/ضایعات مربوطه را لغو کنید.`
        });
      }
    }
    
    if (doc.type === 'output') {
      const nextOutputs = docs.filter(d =>
        d.type === 'output' &&
        d.fromUnit === doc.toUnit &&
        d.item === doc.item &&
        (d.status === 'approved' || d.status === 'pending' || d.status === 'pending_warehouse') &&
        d.id !== docId
      );

      if (nextOutputs.length > 0 && availableQty(doc.toUnit, doc.item) + QTY_EPS < doc.qty) {
        const outputDetails = nextOutputs.map(d =>
          `سند خروج ${d.id} از ${deptName(d.fromUnit)} به ${deptName(d.toUnit)} (${formatNumber(d.qty)} عدد)${d.status === 'pending' ? ' - در انتظار تایید' : d.status === 'pending_warehouse' ? ' - در انتظار تایید انباردار' : ''}`
        ).join('\n');
        return res.status(400).json({
          success: false,
          error: `❌ این سند خروج قابل لغو نیست!\nکالا از بخش مقصد به بخش‌های دیگر منتقل شده یا در حال انتقال است:\n${outputDetails}\n\nلطفاً ابتدا خروج‌های بعدی را لغو/رد کنید.`
        });
      }
      
      const nextConsumes = docs.filter(d => 
        (d.type === 'consume' || d.type === 'waste') && 
        d.unit === doc.toUnit && 
        d.item === doc.item && 
        d.status === 'approved' &&
        d.id !== docId
      );
      
      if (nextConsumes.length > 0 && availableQty(doc.toUnit, doc.item) + QTY_EPS < doc.qty) {
        return res.status(400).json({ 
          success: false, 
          error: `❌ این سند خروج قابل لغو نیست!\nاز این کالا در بخش مقصد مصرف/ضایعات ثبت شده است.\nلطفاً ابتدا اسناد مصرف/ضایعات مربوطه را لغو کنید.`
        });
      }
    }
    
    // نکته: برخلاف قبل، دیگه چک نمی‌کنیم که آیا بعد از این سند مصرف/ضایعات، خروجی از همون
    // کالا/بخش ثبت شده یا نه. لغو یه سند مصرف/ضایعات همیشه فقط موجودی رو "زیاد" می‌کنه
    // (هیچ‌وقت کم نمی‌کنه)، پس نمی‌تونه باعث منفی شدن موجودی یا ناسازگاری با خروج‌های
    // بعدی (که مستقل و بر اساس موجودی لحظه‌ای بررسی می‌شن) بشه. چک قبلی فقط باعث می‌شد
    // به محض یک بار خروجِ همون کالا از اون بخش، لغوِ اسناد مصرف/ضایعاتِ قبلی و بعدی
    // (حتی کاملاً بی‌ربط) برای همیشه قفل بشه.
    
    const actorName = (req.body && req.body.actorUsername) || null;
    const why = (req.body && req.body.reason) || '';
    if (doc.status === 'pending') {
      // هنوز روی موجودی اثری نگذاشته: فقط باطل می‌شود (سند معکوس لازم ندارد)
      doc.status = 'cancelled';
      doc.cancelledBy = actorName; doc.cancelledAt = new Date().toISOString(); if (why) doc.cancelReason = why;
      saveData();
      return res.json({ success: true, message: `سند ${doc.docNo || docId} لغو شد` });
    }

    {
      const preTx = doc.transactionId ? transactions.find(t => t.id === doc.transactionId) : null;
      if (preTx) {
        // برگشتِ این تراکنش از کدام بخش «کم» می‌کنه؟
        let drainUnit = null;
        if (['production', 'excess', 'initial', 'receipt', 'input'].includes(preTx.type)) drainUnit = preTx.unit;
        else if (preTx.type === 'output') drainUnit = preTx.targetUnit === 'customer' ? null : preTx.targetUnit;
        if (drainUnit) {
          // موجودیِ قابل‌استفاده (منهای خروج‌های در راه) - کالایی که برایش سندِ خروجِ در انتظار هست دیگر در بخش نیست
          const haveNow = availableQty(drainUnit, preTx.item);
          if (haveNow + QTY_EPS < preTx.qty) {
            return res.status(400).json({
              success: false,
              error: `❌ این سند قابل لغو نیست!\nموجودیِ فعلیِ «${resolveItemName(preTx.item)}» در ${deptName(drainUnit)} (${haveNow}) کمتر از مقدارِ این سند (${preTx.qty}) است؛ یعنی بخشی از آن قبلاً مصرف یا خارج شده و با لغوش موجودی منفی می‌شود.\nابتدا اسنادِ مصرف/تولید/خروجِ بعدیِ همین کالا را لغو کنید، بعد این سند را لغو کنید.`
            });
          }
        }
      }
    }

    // فاز ۵ - لغو با «سند معکوس»: تراکنش‌های اصلی پاک نمی‌شوند؛ برای هرکدام یک تراکنشِ معکوس (همان نوع، مقدارِ منفی،
    // همان تاریخِ سند) ثبت می‌شود و سند با یک شماره‌ی معکوس (V-سال-شماره) باطل می‌شود. کاردکس/گزارش‌ها خالصِ صفر می‌بینند
    // و تاریخچه کامل می‌ماند. سندِ تولید، مصرف‌های موادش را هم با همان سندِ معکوس برمی‌گرداند.
    const rv = newReversal(doc, actorName, why);
    reverseDocTransactions(doc, rv);
    let reversedMaterialDocs = [];
    if (doc.type === 'production') {
      docs.filter(d => d.parentDocId === doc.id && (d.type === 'consume' || d.type === 'waste') && d.status === 'approved').forEach(matDoc => {
        reverseDocTransactions(matDoc, rv);
        matDoc.status = 'cancelled';
        matDoc.cancelledBy = actorName; matDoc.cancelledAt = rv.at; if (why) matDoc.cancelReason = why;
        reversedMaterialDocs.push({ id: matDoc.id, item: matDoc.item, qty: matDoc.qty });
      });
    }

    doc.status = 'cancelled';
    doc.cancelledBy = actorName || doc.cancelledBy; doc.cancelledAt = rv.at;
    if (why) doc.cancelReason = why;
    if (doc.type === 'initial') {
      // کاردکس/گزارش کل «موجودی اول» را از ردیف‌های initialInventory می‌خوانند؛ با لغوِ سند باید همراهش برود
      initialInventory = initialInventory.filter(r => r.docId !== doc.id);
    }
    
    saveData();
    
    res.json({ 
      success: true, 
      message: `سند ${doc.docNo || docId} با سند معکوس ${doc.reversal ? doc.reversal.no : ''} لغو شد`,
      reversalNo: doc.reversal ? doc.reversal.no : undefined,
      reversedMaterialDocs: reversedMaterialDocs.length > 0 ? reversedMaterialDocs : undefined
    });
  } catch (err) {
    console.error('Error cancelling document:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// API های سپیدار
// ============================================
app.get('/api/sync/sepidar', async (req, res) => {
  try {
    loadData();
    if (closedThrough()) return res.status(400).json({ success: false, error: `دوره تا ${closedThrough()} بسته است؛ همگام‌سازیِ موجودیِ اول دوره از سپیدار در دوره‌ی بسته مجاز نیست` });
    // این همگام‌سازی موجودیِ «مواد اولیه» رو کاملاً با سپیدار بازنویسی می‌کنه و ردیفِ «موجودی اول
    // دوره» رو هم عوض می‌کنه. بعد از راه‌اندازیِ صندوق اسنادِ سپیدار (تاریخ شروع تعیین شده) موجودی
    // با تاییدِ اسناد به‌روز می‌شه، پس اجرای دوباره ممکنه حرکت‌های ثبت‌شده رو بپوشونه: فقط با تاییدِ
    // صریحِ مدیر (force=1) اجرا می‌شه.
    if (sepidarInbox.startDate && req.query.force !== '1') {
      return res.status(409).json({
        success: false,
        locked: true,
        error: 'صندوق اسناد سپیدار فعاله و موجودی با تاییدِ اسناد به‌روز می‌شه. اجرای این همگام‌سازی موجودیِ انبار مواد اولیه رو کاملاً با سپیدار بازنویسی می‌کنه و حرکت‌های ثبت‌شده رو می‌پوشونه.'
      });
    }
    if (req.query.force === '1' && !inboxActor(req.query.actor, ['admin'])) {
      return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند این همگام‌سازی را با تایید صریح اجرا کند' });
    }
    const fiscalYear = (await resolveSepidarFiscalYear(parseInt(req.query.year))).ref;
    if (req.query.force === '1') logActivity(req.query.actor, '⚠️ همگام‌سازی موجودی سپیدار (با وجود قفل صندوق)', `سال مالی سپیدار: ${fiscalYear}`);
    const result = await syncFromSepidar(fiscalYear, req.query.actor);
    if (result.success) {
      res.json({ 
        success: true, 
        message: result.message,
        added: result.added || 0,
        updated: result.updated || 0,
        total: result.total || 0,
        fiscalYear: result.fiscalYear
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || 'خطا در همگام‌سازی'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sync/sepidar-items', async (req, res) => {
  try {
    const result = await syncItemsFromSepidar();
    if (result.success) {
      res.json({ 
        success: true, 
        message: result.message,
        added: result.added || 0,
        updated: result.updated || 0,
        total: result.total || 0
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error || 'خطا در همگام‌سازی کالاها'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// بررسی انبار: مقایسه‌ی فقط‌خواندنیِ موجودی سیستم تولید با سپیدار
// ============================================
// هیچ چیزی در db.json یا سپیدار نمی‌نویسه - فقط SELECT و مقایسه در حافظه.
// نگاشت بخش محلی ← انبار سپیدار (StockRef): مواد اولیه = ۶، محصول = ۳۷.
// ===== بازه‌ی تاریخ در «بررسی انبار» (۱۴۰۵/۰۸/۰۲) =====
// سیستم: موجودیِ اول دوره + تراکنش‌ها روز به روز (همان قاعده‌ی بررسی یکپارچگی). سپیدار: رسید − حواله‌ی هر انبار روز به روز
// (برابرِ دقیقِ vwItemStockSummary). مانده تا یک تاریخ = جمعِ حرکت‌های تا آن روز.
const MOVE_PLUS = ['production', 'excess', 'receipt', 'input'], MOVE_MINUS = ['consume', 'output', 'waste', 'shortage'];
const dayKey = d => { const n = normalizeJalaliDate(d); return n.ok ? n.value : String(d || ''); };
function systemDailyMoves() {
  const m = new Map();
  const add = (u, i, day, q) => { if (!q) return; const k = u + '|' + i; if (!m.has(k)) m.set(k, []); m.get(k).push({ day: dayKey(day), q }); };
  initialInventory.forEach(r => add(r.unit, r.item, r.date, Number(r.qty) || 0));
  transactions.forEach(t => { if (MOVE_PLUS.includes(t.type)) add(t.unit, t.item, t.date, Number(t.qty) || 0); else if (MOVE_MINUS.includes(t.type)) add(t.unit, t.item, t.date, -(Number(t.qty) || 0)); });
  return m;
}
function inventoryAt(to) {
  const inv = {};
  systemDailyMoves().forEach((list, k) => {
    const i = k.indexOf('|'), u = k.slice(0, i), item = k.slice(i + 1);
    const q = list.filter(x => !to || x.day <= to).reduce((a, x) => a + x.q, 0);
    if (Math.abs(q) > 1e-9) { (inv[u] = inv[u] || {})[item] = Math.round(q * 1e6) / 1e6; }
  });
  return inv;
}
// حرکت‌های روزانه‌ی سپیدار برای چند انبار: [{stock, code, day, q}]
async function sepidarDailyMoves(pool, refs, fy) {
  const r = await pool.request().query(`
    SELECT StockRef, ItemCode, MAX(ItemTitle) AS ItemTitle, MAX(UnitTitle) AS UnitTitle, d, SUM(q) AS q FROM (
      SELECT r.StockRef, i.ItemCode, i.ItemTitle, i.UnitTitle, CAST(r.Date AS date) AS d, i.Quantity AS q
      FROM INV.vwInventoryReceipt r JOIN INV.vwInventoryReceiptItem i ON i.InventoryReceiptRef = r.InventoryReceiptID
      WHERE r.StockRef IN (${refs.join(',')}) AND r.FiscalYearRef = ${fy}
      UNION ALL
      SELECT d.StockRef, i.ItemCode, i.ItemTitle, i.UnitTitle, CAST(d.Date AS date), -i.Quantity
      FROM INV.vwInventoryDelivery d JOIN INV.vwInventoryDeliveryItem i ON i.InventoryDeliveryRef = d.InventoryDeliveryID
      WHERE d.StockRef IN (${refs.join(',')}) AND d.FiscalYearRef = ${fy}
    ) x GROUP BY StockRef, ItemCode, d`);
  return r.recordset.map(row => ({ stock: row.StockRef, code: String(row.ItemCode || '').trim(), title: String(row.ItemTitle || '').trim(), unit: String(row.UnitTitle || '').trim(), day: sepidarDateToJalali(row.d), q: parseFloat(row.q) || 0 }));
}
function rangeParams(req) {
  const f = req.query.from ? normalizeJalaliDate(req.query.from) : null, t = req.query.to ? normalizeJalaliDate(req.query.to) : null;
  if ((f && !f.ok) || (t && !t.ok)) return { error: (f && !f.ok ? f.error : t.error) };
  if (f && t && f.value > t.value) return { error: '«از تاریخ» بعد از «تا تاریخ» است' };
  return { from: f ? f.value : null, to: t ? t.value : null };
}
const RECONCILE_STOCKS = [
  { dept: 'raw', stockRef: 6, title: 'انبار تولید - مواد اولیه' },
  { dept: 'finished', stockRef: 37, title: 'انبار تولید - محصول' }
];

// مقایسه در بازه: ماندهٔ اول (قبل از «از»)، ورود و خروجِ داخلِ بازه و ماندهٔ پایانِ «تا»، برای سپیدار و سیستم
async function reconcileByRange(pool, fiscalYear, fySource, rng) {
  const sepMoves = await sepidarDailyMoves(pool, RECONCILE_STOCKS.map(w => w.stockRef), fiscalYear);
  const sysMoves = systemDailyMoves();
  const r3 = v => Math.round((v || 0) * 1000) / 1000;
  const inR = d => (!rng.from || d >= rng.from) && (!rng.to || d <= rng.to);
  const before = d => rng.from && d < rng.from;
  const firstSys = [...sysMoves.values()].flat().reduce((a, x) => (!a || x.day < a ? x.day : a), null);
  const warehouses = RECONCILE_STOCKS.map(w => {
    const acc = {}; const get = c => acc[c] || (acc[c] = { code: c, name: '', sOpen: 0, sIn: 0, sOut: 0, lOpen: 0, lIn: 0, lOut: 0 });
    sepMoves.filter(m => m.stock === w.stockRef).forEach(m => {
      const a = get(m.code); if (!a.name) a.name = m.title;
      if (before(m.day)) a.sOpen += m.q; else if (inR(m.day)) { if (m.q > 0) a.sIn += m.q; else a.sOut -= m.q; }
    });
    sysMoves.forEach((list, k) => {
      const i = k.indexOf('|'); if (k.slice(0, i) !== w.dept) return;
      const a = get(sepidarCodeOfKey(k.slice(i + 1)));
      list.forEach(m => { if (before(m.day)) a.lOpen += m.q; else if (inR(m.day)) { if (m.q > 0) a.lIn += m.q; else a.lOut -= m.q; } });
    });
    const rows = Object.values(acc).map(a => {
      const sClose = r3(a.sOpen + a.sIn - a.sOut), lClose = r3(a.lOpen + a.lIn - a.lOut);
      const diff = r3(lClose - sClose), moveDiff = r3((a.lIn - a.lOut) - (a.sIn - a.sOut));
      const status = Math.abs(diff) < 0.0005 ? (Math.abs(moveDiff) < 0.0005 ? 'ok' : 'move_diff') : (!sClose && !a.sIn && !a.sOut ? 'only_local' : (!lClose && !a.lIn && !a.lOut ? 'only_sepidar' : 'diff'));
      return { code: a.code, name: resolveItemName(a.code) !== a.code ? resolveItemName(a.code) : (a.name || a.code),
        sOpen: r3(a.sOpen), sIn: r3(a.sIn), sOut: r3(a.sOut), sClose, lOpen: r3(a.lOpen), lIn: r3(a.lIn), lOut: r3(a.lOut), lClose, diff, moveDiff, status,
        sepidar: sClose, local: lClose };
    }).filter(r => r.sOpen || r.sIn || r.sOut || r.lOpen || r.lIn || r.lOut)
      .sort((a, b) => (a.status === 'ok') - (b.status === 'ok') || Math.abs(b.diff) - Math.abs(a.diff));
    const okCount = rows.filter(r => r.status === 'ok').length;
    return { dept: w.dept, title: w.title, stockRef: w.stockRef, total: rows.length, okCount, mismatchCount: rows.length - okCount, rows };
  });
  return { success: true, range: rng, fiscalYear, fiscalYearSource: fySource, checkedAt: new Date().toISOString(), systemStart: firstSys, warehouses };
}
app.get('/api/sepidar/reconcile', async (req, res) => {
  try {
    loadData();
    const fyInfo = await resolveSepidarFiscalYear(parseInt(req.query.year));
    const fiscalYear = fyInfo.ref;
    const pool = await connectToSepidar();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'اتصال به سپیدار برقرار نشد' });
    }
    const rng = rangeParams(req);
    if (rng.error) return res.status(400).json({ success: false, error: rng.error });
    if (rng.from || rng.to) return res.json(await reconcileByRange(pool, fiscalYear, fyInfo.source, rng));
    const warehouses = [];
    for (const w of RECONCILE_STOCKS) {
      const r = await pool.request().query(`
        SELECT ItemCode, MAX(ItemTitle) AS ItemTitle, MAX(UnitTitle) AS UnitTitle, SUM(Quantity) AS Quantity
        FROM INV.vwItemStockSummary
        WHERE StockRef = ${w.stockRef} AND FiscalYearRef = ${fiscalYear}
        GROUP BY ItemCode
        HAVING SUM(Quantity) <> 0
      `);
      const sepidarQty = {};
      const sepidarTitle = {};
      for (const row of r.recordset) {
        const code = (row.ItemCode || '').toString().trim();
        if (!code) continue;
        sepidarQty[code] = parseFloat(row.Quantity) || 0;
        sepidarTitle[code] = (row.ItemTitle || '').toString().trim();
      }
      // کلیدهای داخلیِ محصول (PACK-/LASER-/INJ-/SOL-) برای مقایسه به کدِ سپیدار برگردانده و جمع می‌شوند؛
      // مثلاً پکِ A2 و ANKERِ یک کالا در سپیدار یک کدند.
      const local = {};
      Object.entries(inventory[w.dept] || {}).forEach(([k, v]) => {
        const sc = sepidarCodeOfKey(k);
        local[sc] = (local[sc] || 0) + (parseFloat(v) || 0);
      });
      // خروج‌های در انتظار تأیید هنوز موجودی محلی رو جابه‌جا نکرده‌ن ولی ممکنه در سپیدار
      // ثبت شده باشن - فقط برای توضیح اختلاف کنارش نشون داده می‌شه، در محاسبه‌ی اختلاف نمی‌آد.
      const pendingOut = {};
      docs.forEach(d => {
        if (d.type === 'output' && d.fromUnit === w.dept && (d.status === 'pending' || d.status === 'pending_warehouse')) {
          const sc = sepidarCodeOfKey(d.item);
          pendingOut[sc] = (pendingOut[sc] || 0) + (parseFloat(d.qty) || 0);
        }
      });
      const codes = new Set([
        ...Object.keys(sepidarQty),
        ...Object.keys(local).filter(k => (parseFloat(local[k]) || 0) !== 0)
      ]);
      const rows = [];
      let okCount = 0;
      for (const code of codes) {
        const s = code in sepidarQty ? sepidarQty[code] : 0;
        const l = parseFloat(local[code]) || 0;
        const diff = Math.round((l - s) * 1000) / 1000;
        const status = Math.abs(diff) < 0.0005 ? 'ok' : (!(code in sepidarQty) ? 'only_local' : (l === 0 ? 'only_sepidar' : 'diff'));
        if (status === 'ok') okCount++;
        rows.push({
          code,
          name: (resolveItemName(code) !== code ? resolveItemName(code) : (sepidarTitle[code] || code)),
          sepidar: s,
          local: l,
          diff,
          status,
          pendingOut: pendingOut[code] || 0
        });
      }
      rows.sort((a, b) => (a.status === 'ok') - (b.status === 'ok') || Math.abs(b.diff) - Math.abs(a.diff));
      warehouses.push({
        dept: w.dept,
        title: w.title,
        stockRef: w.stockRef,
        total: rows.length,
        okCount,
        mismatchCount: rows.length - okCount,
        rows
      });
    }
    res.json({ success: true, fiscalYear, fiscalYearSource: fyInfo.source, checkedAt: new Date().toISOString(), warehouses });
  } catch (err) {
    console.error('Error in sepidar reconcile:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// صندوق اسناد سپیدار (فقط نمایش - مرحله ۱)
// ============================================
// اسناد حواله/رسیدِ انبار مواد اولیه‌ی سپیدار (StockRef=6) رو می‌خونه، نوعش رو تشخیص می‌ده و
// بخش پیشنهادی رو از طبقه‌بندی مواد (materialClassification که BOM هم از همون استفاده می‌کنه)
// پیدا می‌کنه. هیچ‌چیز در db.json یا سپیدار نمی‌نویسه و روی موجودی اثری نداره.
const INBOX_RAW_STOCK_REF = 6;
// انبارهای خانواده‌ی «مونتاژ / نیمه‌ساخته» در سپیدار (مونتاژ، واسط کابل، واير، مونتاژ مرکزی)
const INBOX_ASSEMBLY_STOCK_REFS = [16, 17, 14, 44];

function normalizeFa(s) {
  return (s == null ? '' : String(s)).replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
}

const INBOX_KIND_LABELS = {
  transfer_to_assembly: 'انتقال به مونتاژ',
  transfer_out_other: 'انتقال به انبار دیگر',
  direct_consumption: 'مصرف مستقیم',
  other_out: 'سایر خروجی',
  purchase_receipt: 'رسید خرید',
  return_from_assembly: 'برگشتی از مونتاژ/واسط',
  transfer_in: 'انتقال از انبار دیگر',
  code_fix: 'اصلاح کد کالا',
  other_in: 'سایر ورودی',
  opening: 'ابتدای دوره'
};

function classifyInboxDoc(family, row) {
  if (family === 'issue') {
    if (row.Type === 4) return INBOX_ASSEMBLY_STOCK_REFS.includes(row.DestinationStockRef) ? 'transfer_to_assembly' : 'transfer_out_other';
    if (row.Type === 2) return 'direct_consumption';
    return 'other_out';
  }
  if (row.IsOpening) return 'opening';
  if (row.Type === 1) return 'purchase_receipt';
  if (row.Type === 5) return INBOX_ASSEMBLY_STOCK_REFS.includes(row.BaseInventoryDeliveryStockRef) ? 'return_from_assembly' : 'transfer_in';
  if (row.Type === 3) return /اصلاح/.test(normalizeFa(row.Description)) ? 'code_fix' : 'other_in';
  return 'other_in';
}

const INBOX_APPROVABLE_KINDS = ['transfer_to_assembly', 'return_from_assembly', 'direct_consumption',
  'purchase_receipt', 'transfer_in', 'other_in', 'other_out', 'transfer_out_other'];

// اسنادِ انبار مواد اولیه‌ی سپیدار رو (از یه تاریخ به بعد، یا فقط یه سندِ مشخص با کلید D<id>/R<id>)
// می‌خونه و به شکل سند + ردیف برمی‌گردونه. فقط SELECT.
async function fetchSepidarInboxDocs({ from, onlyKey, onlyKeys }) {
  const pool = await connectToSepidar();
  if (!pool) throw new Error('اتصال به سپیدار برقرار نشد');
  const keyList = onlyKeys || (onlyKey ? [onlyKey] : null);
  if (keyList && !keyList.every(k => /^[DR]\d+$/.test(k))) throw new Error('کلید سند نامعتبر است');
  const idsOf = p => keyList ? keyList.filter(k => k[0] === p).map(k => parseInt(k.slice(1))) : null;
  const issueIds = idsOf('D');
  const receiptIds = idsOf('R');

  const rowsIssue = [];
  const rowsReceipt = [];
  if (!keyList || issueIds.length) {
    const rq = pool.request();
    let cond = `d.StockRef = ${INBOX_RAW_STOCK_REF}`;
    if (keyList) { cond += ` AND d.InventoryDeliveryID IN (${issueIds.join(',')})`; }
    else { rq.input('from', sql.DateTime, from); cond += ' AND d.Date >= @from'; }
    const r = await rq.query(`
      SELECT d.InventoryDeliveryID AS id, d.Number, d.Date, d.Type, d.DestinationStockRef, d.DestinationStockTitle,
             d.DLTitle, d.Description, d.FiscalYearRef,
             i.RowNumber, i.ItemCode, i.ItemTitle, i.UnitTitle, i.Quantity
      FROM INV.vwInventoryDelivery d
      JOIN INV.vwInventoryDeliveryItem i ON i.InventoryDeliveryRef = d.InventoryDeliveryID
      WHERE ${cond}
      ORDER BY d.InventoryDeliveryID DESC, i.RowNumber
    `);
    rowsIssue.push(...r.recordset);
  }
  if (!keyList || receiptIds.length) {
    const rq = pool.request();
    let cond = `r.StockRef = ${INBOX_RAW_STOCK_REF}`;
    if (keyList) { cond += ` AND r.InventoryReceiptID IN (${receiptIds.join(',')})`; }
    else { rq.input('from', sql.DateTime, from); cond += ' AND r.Date >= @from'; }
    const r = await rq.query(`
      SELECT r.InventoryReceiptID AS id, r.Number, r.Date, r.Type, r.PurchaseType, r.IsOpening,
             r.BaseInventoryDeliveryStockRef, r.BaseInventoryDeliveryStockTitle, r.DelivererTitle,
             r.Description, r.FiscalYearRef,
             i.RowNumber, i.ItemCode, i.ItemTitle, i.UnitTitle, i.Quantity
      FROM INV.vwInventoryReceipt r
      JOIN INV.vwInventoryReceiptItem i ON i.InventoryReceiptRef = r.InventoryReceiptID
      WHERE ${cond}
      ORDER BY r.InventoryReceiptID DESC, i.RowNumber
    `);
    rowsReceipt.push(...r.recordset);
  }

  const knownCodes = new Set(items.map(i => i.code));
  const startMs = sepidarInbox.startDate ? Date.parse(sepidarInbox.startDate) : null;
  const buildDocs = (fam, rows) => {
    const byId = new Map();
    for (const row of rows) {
      let doc = byId.get(row.id);
      if (!doc) {
        const kind = classifyInboxDoc(fam, row);
        const key = (fam === 'issue' ? 'D' : 'R') + row.id;
        const decision = getActiveInboxDecision(key);
        const reopened = !decision && !!sepidarInbox.decisions[key];
        let status = decision ? decision.status : 'new';
        if (status === 'new' && (startMs === null || new Date(row.Date).getTime() < startMs)) status = 'old';
        doc = {
          key,
          family: fam,
          number: row.Number,
          date: row.Date,
          kind,
          kindLabel: INBOX_KIND_LABELS[kind],
          approvable: INBOX_APPROVABLE_KINDS.includes(kind),
          status,
          reopened,
          decidedBy: decision ? decision.decidedBy : null,
          decidedAt: decision ? decision.decidedAt : null,
          createdDocIds: decision ? (decision.createdDocIds || []) : [],
          fiscalYear: row.FiscalYearRef,
          counterparty: fam === 'issue'
            ? normalizeFa(row.DestinationStockTitle) || normalizeFa(row.DLTitle)
            : normalizeFa(row.BaseInventoryDeliveryStockTitle) || normalizeFa(row.DelivererTitle),
          description: normalizeFa(row.Description),
          _other: fam === 'issue' ? String(row.DestinationStockRef) : row.BaseInventoryDeliveryStockRef + ':' + row.Type,
          rows: []
        };
        byId.set(row.id, doc);
      }
      const code = (row.ItemCode || '').toString().trim();
      const suggestedDept = materialClassification[code] || null;
      const qty = parseFloat(row.Quantity) || 0;
      const warnings = [];
      if (!knownCodes.has(code)) warnings.push('کالا در فهرست کالاهای سیستم نیست');
      const needsDept = doc.kind === 'transfer_to_assembly' || doc.kind === 'return_from_assembly';
      if (needsDept && !suggestedDept) warnings.push('بخش مشخص نیست (طبقه‌بندی نشده)');
      const rawStock = isPackVariantBase(code) ? pvStockForFormula(inventory.raw || {}, code, null) : ((inventory.raw && inventory.raw[code]) || 0);
      if (isPackVariantBase(code)) warnings.push('پک سفارشی: هنگامِ تایید باید به تفکیکِ برند و نوع کابل وارد شود');
      if (doc.family === 'issue' && rawStock < qty) warnings.push(`موجودی انبار مواد اولیه در سیستم کافی نیست (${rawStock})`);
      doc.rows.push({
        index: doc.rows.length,
        code,
        name: normalizeFa(row.ItemTitle),
        unit: normalizeFa(row.UnitTitle),
        qty,
        suggestedDept,
        rawStock,
        packSplit: isPackVariantBase(code),
        warnings
      });
    }
    const list = [...byId.values()];
    // عکسِ لحظه‌ای از سند (برای تشخیصِ ویرایش‌شدن بعد از ثبت): تاریخ، انبارِ مقابل و ردیف‌ها
    list.forEach(d => {
      d.snapshot = {
        date: new Date(d.date).toISOString(),
        other: d._other,
        rows: d.rows.map(r => ({ code: r.code, qty: r.qty }))
      };
      delete d._other;
    });
    return list;
  };
  return [...buildDocs('issue', rowsIssue), ...buildDocs('receipt', rowsReceipt)];
}

app.get('/api/sepidar/inbox', async (req, res) => {
  try {
    await checkSepidarDeletedDocs();
    loadData();
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const from = new Date(Date.now() - days * 86400000);
    from.setUTCHours(0, 0, 0, 0);
    const docsOut = (await fetchSepidarInboxDocs({ from }))
      .sort((a, b) => new Date(b.date) - new Date(a.date) || (a.key < b.key ? 1 : -1));
    const summary = {};
    const statusCounts = {};
    docsOut.forEach(d => {
      summary[d.kind] = (summary[d.kind] || 0) + 1;
      statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
    });
    res.json({
      success: true,
      days,
      total: docsOut.length,
      startDate: sepidarInbox.startDate,
      summary,
      statusCounts,
      kindLabels: INBOX_KIND_LABELS,
      docs: docsOut
    });
  } catch (err) {
    console.error('Error in sepidar inbox:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// یه سندِ سپیدارِ «ثبت‌شده» فقط تا وقتی ثبت‌شده حساب می‌شه که حداقل یکی از اسنادی که ازش ساخته
// شده هنوز سرِ جاشه و لغو/رد نشده. اگه همه‌شون لغو، رد یا حذف بشن، سند برمی‌گرده به «جدید» و
// دوباره قابل ثبته (سابقه‌ی تاییدِ قبلی توی history نگه داشته می‌شه).
function getActiveInboxDecision(key) {
  const dec = sepidarInbox.decisions[key];
  if (!dec) return null;
  if (dec.status !== 'approved') return dec;
  const ids = dec.createdDocIds || [];
  const anyLive = ids.some(id => {
    const d = docs.find(x => x.id === id);
    return d && d.status !== 'cancelled' && d.status !== 'rejected';
  });
  return anyLive ? dec : null;
}

// بررسیِ خودکارِ اسنادِ سپیدارِ «ثبت‌شده»: اگه سندش دیگه توی سپیدار وجود نداشته باشه (حذف شده)
// ولی اسنادِ ساخته‌شده ازش هنوز توی سیستم تولید سرِ جاشونن، هشدار ثبت می‌شه (یک بار: لاگ فعالیت +
// Push به انبارداران/مدیر + نشان و بنر توی تب). هیچ سندی خودکار لغو نمی‌شه - تصمیمش با انباردار.
let sepidarDeletedCheckRunning = false;

function snapshotSig(sn) {
  const rows = (sn.rows || []).map(r => r.code + ':' + r.qty).sort();
  return JSON.stringify({ d: sn.date, o: sn.other, r: rows });
}

// توضیحِ فارسیِ تفاوتِ دو عکس (قبل/بعد از ویرایش در سپیدار)
function describeSnapshotChange(oldSn, newSn) {
  const parts = [];
  if (oldSn.date !== newSn.date) parts.push('تاریخ سند تغییر کرده');
  if (oldSn.other !== newSn.other) parts.push('انبار مبدأ/مقصد سند تغییر کرده');
  const sum = sn => { const m = {}; (sn.rows || []).forEach(r => { m[r.code] = (m[r.code] || 0) + r.qty; }); return m; };
  const o = sum(oldSn), n = sum(newSn);
  new Set([...Object.keys(o), ...Object.keys(n)]).forEach(code => {
    if (!(code in n)) parts.push(`ردیف کالای ${code} حذف شده (قبلاً ${o[code]})`);
    else if (!(code in o)) parts.push(`ردیف کالای ${code} اضافه شده (${n[code]})`);
    else if (Math.abs(o[code] - n[code]) > 1e-9) parts.push(`مقدار کالای ${code} از ${o[code]} به ${n[code]} تغییر کرده`);
  });
  return parts.join('؛ ').slice(0, 400) || 'سند تغییر کرده';
}

// بررسیِ خودکارِ اسنادِ سپیدارِ «ثبت‌شده» (۶۰ روزِ اخیر): اگه سندش دیگه توی سپیدار وجود نداشته باشه
// (حذف شده) یا بعد از ثبت ویرایش شده (مقدار/ردیف/تاریخ/انبارِ مقابل) و اسنادِ ساخته‌شده ازش هنوز توی
// سیستم تولید سرِ جاشونن، هشدار ثبت می‌شه (یک بار: لاگ فعالیت + Push به انبارداران/مدیر + نشان و
// بنر توی تب). هیچ سندی خودکار لغو یا اصلاح نمی‌شه - تصمیمش با انباردار.
async function checkSepidarDeletedDocs() {
  if (sepidarDeletedCheckRunning) return { checked: 0, newlyDeleted: [], newlyChanged: [] };
  sepidarDeletedCheckRunning = true;
  try {
    loadData();
    const since = Date.now() - 60 * 86400000;
    const keys = Object.keys(sepidarInbox.decisions).filter(k => {
      const dec = sepidarInbox.decisions[k];
      return dec.status === 'approved' && /^[DR]\d+$/.test(k) && Date.parse(dec.decidedAt) >= since && getActiveInboxDecision(k);
    });
    if (!keys.length) return { checked: 0, newlyDeleted: [], newlyChanged: [] };
    const current = new Map((await fetchSepidarInboxDocs({ onlyKeys: keys })).map(d => [d.key, d]));
    // بعد از await دوباره از فایل می‌خونیم تا تغییرِ هم‌زمانِ کس دیگه رو نپوشونیم
    loadData();
    const newlyDeleted = [];
    const newlyChanged = [];
    let changed = false;
    keys.forEach(k => {
      const dec = sepidarInbox.decisions[k];
      if (!dec || dec.status !== 'approved') return;
      const cur = current.get(k);
      if (!cur) {
        if (!dec.sepidarDeletedAt) {
          dec.sepidarDeletedAt = new Date().toISOString();
          delete dec.alertDismissed;
          newlyDeleted.push({ key: k, number: dec.number, kindLabel: dec.kindLabel, createdDocIds: dec.createdDocIds || [] });
          changed = true;
        }
        return;
      }
      if (dec.sepidarDeletedAt) { delete dec.sepidarDeletedAt; delete dec.alertDismissed; changed = true; } // دوباره پیدا شد
      if (!dec.snapshot) { dec.snapshot = cur.snapshot; changed = true; return; } // ثبت‌های قدیمی: از همین لحظه مبنا
      const curSig = snapshotSig(cur.snapshot);
      if (curSig === snapshotSig(dec.snapshot)) {
        if (dec.sepidarChange) { delete dec.sepidarChange; delete dec.sepidarChangedAt; delete dec.lastChangeSig; delete dec.alertDismissed; changed = true; }
      } else if (dec.lastChangeSig !== curSig) {
        dec.sepidarChange = describeSnapshotChange(dec.snapshot, cur.snapshot);
        dec.sepidarChangedAt = new Date().toISOString();
        dec.lastChangeSig = curSig;
        delete dec.alertDismissed;
        newlyChanged.push({ key: k, number: dec.number, kindLabel: dec.kindLabel, createdDocIds: dec.createdDocIds || [], change: dec.sepidarChange });
        changed = true;
      }
    });
    if (changed) saveData();
    const targets = () => usersWithRoles(['warehouse', 'admin']);
    newlyDeleted.forEach(d => {
      logActivity('سیستم', 'حذف سند سپیدار شناسایی شد', `${d.kindLabel || d.key} شماره ${d.number || '?'} (${d.key}) در سپیدار حذف شده (یا از انبار مواد اولیه خارج شده) ولی اسناد سیستم تولید (${d.createdDocIds.join(', ')}) هنوز هستند`);
      sendPushToUsernames(targets(), {
        title: '⚠️ سند سپیدار حذف شده است',
        body: `سند ${d.kindLabel || ''} شماره ${d.number || d.key} در سپیدار حذف شده؛ اسناد ثبت‌شده‌ی آن در سیستم تولید را بررسی کنید`,
        url: '/'
      });
    });
    newlyChanged.forEach(d => {
      logActivity('سیستم', 'ویرایش سند سپیدار شناسایی شد', `${d.kindLabel || d.key} شماره ${d.number || '?'} (${d.key}): ${d.change} - اسناد سیستم تولید: ${d.createdDocIds.join(', ')}`);
      sendPushToUsernames(targets(), {
        title: '⚠️ سند سپیدار ویرایش شده است',
        body: `سند ${d.kindLabel || ''} شماره ${d.number || d.key} بعد از ثبت در سپیدار ویرایش شده: ${d.change}`,
        url: '/'
      });
    });
    return { checked: keys.length, newlyDeleted, newlyChanged };
  } catch (err) {
    console.error('Error checking deleted/changed sepidar docs:', err.message);
    return { checked: 0, newlyDeleted: [], newlyChanged: [], error: err.message };
  } finally {
    sepidarDeletedCheckRunning = false;
  }
}
// هر ۱۵ دقیقه (و یک بار کمی بعد از بالا آمدن سرور) - unref تا جلوی بسته شدنِ پروسه رو نگیره
setTimeout(() => checkSepidarDeletedDocs(), 60 * 1000).unref();
setInterval(() => checkSepidarDeletedDocs(), 15 * 60 * 1000).unref();

// «متوجه شدم»: هشدارِ حذف‌شدن رو می‌بنده (اسناد ساخته‌شده دست‌نخورده می‌مونن)
app.post('/api/sepidar/inbox/dismiss-alert', (req, res) => {
  try {
    loadData();
    const { key, actorUsername } = req.body;
    if (!inboxActor(actorUsername, ['warehouse', 'admin'])) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر' });
    }
    const dec = sepidarInbox.decisions[key];
    if (!dec || (!dec.sepidarDeletedAt && !dec.sepidarChange)) return res.status(400).json({ success: false, error: 'هشداری برای این سند نیست' });
    dec.alertDismissed = true;
    saveData();
    logActivity(actorUsername, 'بستن هشدار حذف سند سپیدار', key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function inboxActor(username, roles) {
  const actor = users.find(u => u.username === username);
  return actor && roles.includes(actor.role) ? actor : null;
}

// تاریخِ شروعِ قابل‌تایید: اسنادِ قدیمی‌تر از این فقط قابل «نادیده گرفتن»ن (موجودیِ پایه از قبل
// شاملشون شده). فقط مدیر.
app.post('/api/sepidar/inbox/start-date', (req, res) => {
  try {
    loadData();
    const { startDate, actorUsername } = req.body;
    if (!inboxActor(actorUsername, ['admin'])) {
      return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند تاریخ شروع را تعیین کند' });
    }
    const ms = Date.parse(startDate);
    if (isNaN(ms)) return res.status(400).json({ success: false, error: 'تاریخ نامعتبر است' });
    const d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    sepidarInbox.startDate = d.toISOString();
    saveData();
    logActivity(actorUsername, 'تعیین تاریخ شروع اسناد سپیدار', sepidarInbox.startDate.slice(0, 10));
    res.json({ success: true, startDate: sepidarInbox.startDate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// تایید یه سندِ سپیدار: سند از خودِ سپیدار دوباره خونده می‌شه (به داده‌ی کلاینت اعتماد نمی‌کنیم)،
// بعد با همون منطقِ موجودی/تاییدِ سیستم به سندهای عادی تبدیل می‌شه و همه‌چیز در یک saveData():
//  - انتقال به/از بخش: سند output معمولی (وضعیت pending) - جابه‌جاییِ موجودی هنوز با تاییدِ
//    بخشِ گیرنده انجام می‌شه؛ اگه جفت‌بخش در دروازه‌ی انباردار باشه، تاییدِ همین انباردار همان
//    warehouse-approve حساب می‌شه.
//  - مصرف مستقیم: سند consume، ورودی‌ها: receipt («رسید انبار» - نوعِ مستقل از اضافات)، سایر خروجی‌ها: shortage - همه با تراکنش
//    هم‌نوعِ خودشون، پس گزارش‌ها/کاردکس/لغو دقیقاً مثل بقیه‌ی اسناد کار می‌کنن.
app.post('/api/sepidar/inbox/approve', async (req, res) => {
  try {
    const { key, actorUsername, rowDepts } = req.body;
    const packSplits = (req.body && req.body.packSplits) || {};
    loadData();
    const actor = inboxActor(actorUsername, ['warehouse', 'admin']);
    if (!actor) return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند این سند را تایید کند' });
    if (!key || getActiveInboxDecision(key)) {
      return res.status(400).json({ success: false, error: 'این سند قبلاً بررسی شده است' });
    }
    if (!sepidarInbox.startDate) {
      return res.status(400).json({ success: false, error: 'ابتدا مدیر باید «تاریخ شروع» را تعیین کند' });
    }

    const found = (await fetchSepidarInboxDocs({ onlyKey: key }))[0];
    if (!found) return res.status(404).json({ success: false, error: 'سند در سپیدار پیدا نشد' });

    // بعد از await دوباره از فایل بخون و دوباره چک کن (تاییدِ هم‌زمانِ دو نفر)
    loadData();
    if (getActiveInboxDecision(key)) {
      return res.status(400).json({ success: false, error: 'این سند همین الان توسط فرد دیگری بررسی شد' });
    }
    if (!found.approvable) return res.status(400).json({ success: false, error: `سند «${found.kindLabel}» قابل ثبت نیست؛ فقط می‌توانید نادیده‌اش بگیرید` });
    if (new Date(found.date).getTime() < Date.parse(sepidarInbox.startDate)) {
      return res.status(400).json({ success: false, error: 'این سند قبل از تاریخ شروع است و فقط قابل نادیده گرفتن است' });
    }

    const isTransfer = found.kind === 'transfer_to_assembly' || found.kind === 'return_from_assembly';
    const validDepts = DEPTS.filter(d => d.id !== 'raw').map(d => d.id);
    const errors = [];
    const plan = found.rows.map(r => {
      const dept = isTransfer ? ((rowDepts && rowDepts[r.index]) || r.suggestedDept) : null;
      if (!items.some(i => i.code === r.code)) errors.push(`کالای ${r.code} در فهرست کالاها نیست (ابتدا همگام‌سازی کالاها)`);
      if (!(r.qty > 0)) errors.push(`مقدار ردیف ${r.index + 1} نامعتبر است`);
      if (isTransfer && !validDepts.includes(dept)) errors.push(`برای ردیف ${r.index + 1} (${r.code}) بخش انتخاب نشده است`);
      // پکِ سفارشی: انباردار باید تعداد را به تفکیکِ برند و نوع کابل وارد کند (جمع = تعدادِ سپیدار)
      let parts = [{ key: r.code, qty: r.qty }];
      if (isPackVariantBase(r.code) && r.qty > 0) {
        const sp = resolvePackSplits(r.code, packSplits[r.index], r.qty);
        if (sp.error) errors.push(`ردیف ${r.index + 1}: ${sp.error}`); else parts = sp.parts;
      }
      return { row: r, dept, parts };
    });
    // موجودیِ منبع باید کافی باشه (مثل همه‌ی خروج‌های دیگرِ سیستم) - جمعِ چند ردیفِ هم‌کالا حساب می‌شه
    const need = {};
    plan.forEach(({ row, dept, parts }) => {
      let unit = null;
      if (found.family === 'issue') unit = 'raw';
      if (found.kind === 'return_from_assembly') unit = dept;
      if (unit) parts.forEach(pt => { const k = unit + '|' + pt.key; need[k] = (need[k] || 0) + pt.qty; });
    });
    Object.entries(need).forEach(([k, q]) => {
      const [unit, code] = k.split('|');
      const m = shortageMessage(unit, code, q);
      if (m) errors.push(m + '. اگر موجودی سیستم با سپیدار نمی‌خواند، ابتدا با «بررسی انبار» اختلاف را اصلاح کنید');
    });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('\n') });

    // تاریخِ سند = تاریخِ خودِ سندِ سپیدار (نه روزِ تایید)، با همان قالبِ بقیه‌ی اسناد. اگر آن تاریخ خارج از سال
    // مالیِ فعال یا در آینده باشد، امروز گذاشته می‌شود و تاریخِ اصلی در شرح می‌ماند.
    const sepidarDay = sepidarDateToJalali(found.date);
    const fyNow = fiscalYears.find(f => String(f.year) === String(activeFiscalYear));
    const dateOk = sepidarDay && sepidarDay <= todayJalali() && !closedProblem(sepidarDay) && (!fyNow || !fyNow.startDate || (sepidarDay >= fyNow.startDate && sepidarDay <= fyNow.endDate));
    const today = dateOk ? sepidarDay : todayJalali();
    const noteBase = `سپیدار - ${found.kindLabel} شماره ${found.number}${found.counterparty ? ' - ' + found.counterparty : ''}${!dateOk && sepidarDay ? ` (تاریخ سند در سپیدار: ${sepidarDay})` : ''}`;
    const createdDocIds = [];
    const createdOutputDocs = [];

    plan.forEach(({ row: row0, dept, parts }) => parts.forEach(pt => {
      const row = { ...row0, code: pt.key, qty: pt.qty };
      const submissionId = `sepidar-${key}-${row.index}`;
      if (isTransfer) {
        const from = found.kind === 'return_from_assembly' ? dept : 'raw';
        const to = found.kind === 'return_from_assembly' ? 'raw' : dept;
        const doc = {
          id: docSeq++,
          date: today,
          type: 'output',
          unit: from,
          item: row.code,
          qty: row.qty,
          fromUnit: from,
          toUnit: to,
          note: noteBase,
          status: 'pending',
          fiscalYear: activeFiscalYear,
          createdBy: actorUsername,
          createdAt: new Date().toISOString(),
          submissionId,
          transactionId: null,
          parentDocId: null,
          batchNumber: generateBatchNumber(),
          orderBatchId: null,
          source: 'sepidar',
          sepidarKey: key
        };
        // تاییدِ انباردار همین‌جا انجام شد (معادل warehouse-approve) - فقط برای جفت‌بخش‌های دروازه‌دار
        if (isDeptPairGated(from, to)) { doc.warehouseApprovedBy = actorUsername; doc.warehouseApprovedAt = new Date().toISOString(); }
        docs.push(doc);
        createdDocIds.push(doc.id);
        createdOutputDocs.push(doc);
        return;
      }
      // سندهای فوری روی انبار مواد اولیه
      const isIn = found.family === 'receipt';
      const txType = isIn ? 'receipt' : (found.kind === 'direct_consumption' ? 'consume' : 'shortage');
      if (!inventory.raw) inventory.raw = {};
      if (!inventory.raw[row.code]) inventory.raw[row.code] = 0;
      inventory.raw[row.code] += isIn ? row.qty : -row.qty;
      const batchNumber = generateBatchNumber();
      const tx = {
        id: seqId++,
        date: today,
        type: txType,
        unit: 'raw',
        item: row.code,
        qty: row.qty,
        note: noteBase,
        targetUnit: '',
        fiscalYear: activeFiscalYear,
        batchNumber
      };
      transactions.push(tx);
      const doc = {
        id: docSeq++,
        date: today,
        type: txType,
        unit: 'raw',
        item: row.code,
        qty: row.qty,
        fromUnit: '',
        toUnit: '',
        note: noteBase,
        status: 'approved',
        fiscalYear: activeFiscalYear,
        createdBy: actorUsername,
        transactionId: tx.id,
        parentDocId: null,
        batchNumber,
        submissionId,
        source: 'sepidar',
        sepidarKey: key,
        approvedBy: actorUsername,
        approvedAt: new Date().toISOString()
      };
      docs.push(doc);
      createdDocIds.push(doc.id);
    }));

    // «ذخیره‌ی بخش انتخابی به‌عنوان پیش‌فرض» فقط برای کالاهایی که هنوز طبقه‌بندی نشده‌ن
    if (isTransfer && req.body.saveDefaults) {
      plan.forEach(({ row, dept }) => {
        if (!materialClassification[row.code] && STAGE_DEPTS.includes(dept)) materialClassification[row.code] = dept;
      });
    }

    const prevDecision = sepidarInbox.decisions[key];
    sepidarInbox.decisions[key] = {
      status: 'approved',
      decidedBy: actorUsername,
      decidedAt: new Date().toISOString(),
      createdDocIds,
      number: found.number,
      kindLabel: found.kindLabel,
      snapshot: found.snapshot,
      history: prevDecision ? [...(prevDecision.history || []), { status: prevDecision.status, decidedBy: prevDecision.decidedBy, decidedAt: prevDecision.decidedAt, createdDocIds: prevDecision.createdDocIds || [] }] : []
    };
    saveData();
    logActivity(actorUsername, 'تایید سند سپیدار', `${found.kindLabel} شماره ${found.number} (${key}) - اسناد ساخته‌شده: ${createdDocIds.join(', ')}`);

    res.json({ success: true, createdDocIds, message: `سند سپیدار ${found.number} ثبت شد (${createdDocIds.length} سند)` });

    // اعلان‌ها بعد از پاسخ و مثل ثبت دستی: هر سند output برای بخش گیرنده (push تجمیعی به‌ازای هر بخش)
    createdOutputDocs.forEach(d => notifyOutputMessengerForOutputDoc(d));
    const byTarget = {};
    createdOutputDocs.forEach(d => { (byTarget[d.toUnit] = byTarget[d.toUnit] || []).push(d); });
    Object.entries(byTarget).forEach(([toUnit, list]) => {
      sendPushToUsernames(usersInDeptId(toUnit), {
        title: '📤 سند خروج آماده تایید',
        body: `${list.length} قلم از ${deptName(list[0].fromUnit)} (ثبت از سپیدار)`,
        url: '/mobile/'
      });
    });
  } catch (err) {
    console.error('Error approving sepidar inbox doc:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// نادیده گرفتن (حذف نرم): سند دوباره در صندوق نمی‌آد، ولی با «بازگردانی» برمی‌گرده
app.post('/api/sepidar/inbox/reject', (req, res) => {
  try {
    loadData();
    const { key, actorUsername, reason } = req.body;
    if (!inboxActor(actorUsername, ['warehouse', 'admin'])) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند این سند را نادیده بگیرد' });
    }
    if (!key || getActiveInboxDecision(key)) {
      return res.status(400).json({ success: false, error: 'این سند قبلاً بررسی شده است' });
    }
    sepidarInbox.decisions[key] = { status: 'rejected', decidedBy: actorUsername, decidedAt: new Date().toISOString(), reason: reason || '', createdDocIds: [] };
    saveData();
    logActivity(actorUsername, 'نادیده گرفتن سند سپیدار', `${key}${reason ? ' - ' + reason : ''}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sepidar/inbox/restore', (req, res) => {
  try {
    loadData();
    const { key, actorUsername } = req.body;
    if (!inboxActor(actorUsername, ['warehouse', 'admin'])) {
      return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند سند را بازگرداند' });
    }
    const dec = sepidarInbox.decisions[key];
    if (!dec || dec.status !== 'rejected') {
      return res.status(400).json({ success: false, error: 'فقط سندهای نادیده‌گرفته‌شده قابل بازگردانی‌اند' });
    }
    delete sepidarInbox.decisions[key];
    saveData();
    logActivity(actorUsername, 'بازگردانی سند سپیدار', key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// سالِ مالیِ سپیدار (FiscalYearRef) - جایگزینِ عددِ ثابتِ ۱۳
// ============================================
// شماره‌ی سال مالی در سپیدار (FiscalYearRef) پشت‌سرهم و قابل‌حدس نیست (مثلاً ۱، ۴، ۷، ۸، ۱۲، ۱۳)، و
// با سالِ مالیِ خودِ برنامه (۱۴۰۵) یکی نیست. ترتیبِ انتخاب:
//   ۱) پارامتر صریحِ درخواست (?year=)
//   ۲) نگاشتِ دستیِ ثبت‌شده برای «سالِ مالیِ فعالِ برنامه» (appSettings.sepidarFiscalYears)
//   ۳) خودکار: جدیدترین سالی که توی انبارهای مواد اولیه/محصول موجودیِ غیرصفر داره
// حالتِ خودکار تا وقتی حسابدار «ابتدای دوره»ی سالِ جدید رو ثبت نکرده، روی سالِ قبل می‌مونه.
async function resolveSepidarFiscalYear(explicitYear) {
  if (explicitYear) return { ref: explicitYear, source: 'explicit' };
  const map = (appSettings && appSettings.sepidarFiscalYears) || {};
  const manual = parseInt(map[activeFiscalYear]);
  if (manual) return { ref: manual, source: 'manual' };
  try {
    const pool = await connectToSepidar();
    if (pool) {
      const stockRefs = RECONCILE_STOCKS.map(w => w.stockRef).join(',');
      const r = await pool.request().query(`SELECT MAX(FiscalYearRef) AS fy FROM INV.vwItemStockSummary WHERE Quantity <> 0 AND StockRef IN (${stockRefs})`);
      const fy = r.recordset[0] && r.recordset[0].fy;
      if (fy) return { ref: fy, source: 'auto' };
    }
  } catch (e) {
    console.error('resolveSepidarFiscalYear:', e.message);
  }
  return { ref: 13, source: 'fallback' };
}

app.get('/api/settings/sepidar-fiscal-year', async (req, res) => {
  try {
    loadData();
    const resolved = await resolveSepidarFiscalYear();
    const map = appSettings.sepidarFiscalYears || {};
    let options = [];
    let sepidarError = null;
    try {
      const pool = await connectToSepidar();
      if (!pool) throw new Error('اتصال به سپیدار برقرار نشد');
      const stockRefs = RECONCILE_STOCKS.map(w => w.stockRef).join(',');
      const r = await pool.request().query(`
        SELECT FiscalYearRef AS ref, COUNT(*) AS rows_, SUM(CASE WHEN Quantity <> 0 THEN 1 ELSE 0 END) AS nonzero
        FROM INV.vwItemStockSummary WHERE StockRef IN (${stockRefs})
        GROUP BY FiscalYearRef ORDER BY FiscalYearRef DESC
      `);
      options = r.recordset.slice(0, 8).map(x => ({ ref: x.ref, rows: x.rows_, nonzero: x.nonzero }));
    } catch (e) {
      sepidarError = e.message;
    }
    res.json({
      success: true,
      activeLocalYear: activeFiscalYear,
      manualRef: map[activeFiscalYear] || null,
      map,
      resolved,
      options,
      sepidarError
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/sepidar-fiscal-year', (req, res) => {
  try {
    loadData();
    const { ref, actorUsername } = req.body;
    if (!inboxActor(actorUsername, ['admin'])) {
      return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند سال مالی سپیدار را تعیین کند' });
    }
    if (!appSettings.sepidarFiscalYears) appSettings.sepidarFiscalYears = {};
    const n = parseInt(ref);
    if (ref === '' || ref === null || ref === undefined) {
      delete appSettings.sepidarFiscalYears[activeFiscalYear];
    } else if (n > 0 && n < 1000) {
      appSettings.sepidarFiscalYears[activeFiscalYear] = n;
    } else {
      return res.status(400).json({ success: false, error: 'شماره‌ی سال مالی سپیدار نامعتبر است' });
    }
    saveData();
    logActivity(actorUsername, 'تعیین سال مالی سپیدار', `سال برنامه ${activeFiscalYear} ← FiscalYearRef ${ref === '' || ref == null ? 'خودکار' : n}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// ثبتِ تولید از مواد در «یک» درخواستِ اتمیک (به‌جای تولید + چند مصرفِ جدا از کلاینت)
// ============================================
// یا همه‌چیز (سند تولید + همه‌ی مصرف‌ها) ثبت می‌شه یا هیچ‌چیز: موجودیِ همه‌ی مواد قبلاً با هم سنجیده می‌شه
// و همه‌ی تغییرات در یک saveData() انجام می‌شن. برای بخش‌های «تاییدِ انباردار برای تولید» همه در انتظار می‌مونن.
app.post('/api/doc/production-with-materials', (req, res) => {
  try {
    loadData();
    materializeStageDef(req.body && req.body.unit, req.body && req.body.item); // لیزر/بسته‌بندی: برند/نوع پک تازه
    { const b = req.body || {}; const cp = colorProblem(b.unit, b.item, Array.isArray(b.materials) ? b.materials : null) || chainProblem(b.unit, b.item, Array.isArray(b.materials) ? b.materials : null, b.formulaKey) || packVariantProblem(b.unit, b.item, Array.isArray(b.materials) ? b.materials : null, b.formulaKey); if (cp) return res.status(400).json({ success: false, error: cp }); }
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    const bad = validateMovement(req.body, ['unit']);
    if (bad) return res.status(400).json({ success: false, error: bad });
    const { unit, item, qty, note, orderBatchId, actorUsername } = req.body;
    const mats = Array.isArray(req.body.materials) ? req.body.materials : [];
    if (mats.length === 0) return res.status(400).json({ success: false, error: 'حداقل یک ماده‌ی مصرفی لازم است' });
    if (staleStageProduct(unit, item) || mats.some(m => m && staleStageMaterial(m.item, unit))) return res.status(400).json({ success: false, error: STALE_CLIENT_ERROR });

    const clean = [];
    for (const m of mats) {
      const mm = { unit, item: m && m.item, qty: m && m.qty };
      const e = validateMovement(mm, ['unit']);
      if (e) return res.status(400).json({ success: false, error: `ماده «${m && m.item}»: ${e}` });
      clean.push({ item: mm.item, qty: mm.qty, note: m.note || '' });
    }
    // موجودیِ همه‌ی مواد (با جمعِ ردیف‌های هم‌کالا) قبل از هر تغییری سنجیده می‌شه
    const need = {};
    clean.forEach(m => { need[m.item] = (need[m.item] || 0) + m.qty; });
    const errors = [];
    Object.entries(need).forEach(([code, q]) => {
      const m = shortageMessage(unit, code, q);
      if (m) errors.push(m);
    });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('\n') });

    const gated = isProductionGated(unit);
    const batchNumber = generateBatchNumber();
    const today = docDt;
    const actor = actorUsername || 'سیستم';

    let ptx = null;
    if (!gated) {
      ptx = { id: seqId++, date: today, type: 'production', unit, item, qty, note: note || '', targetUnit: '', fiscalYear: activeFiscalYear, batchNumber };
      transactions.push(ptx);
      if (!inventory[unit]) inventory[unit] = {};
      inventory[unit][item] = (inventory[unit][item] || 0) + qty;
    }
    const doc = {
      id: docSeq++, date: today, type: 'production', unit, item, qty, fromUnit: '', toUnit: '', note: note || '',
      status: gated ? 'pending_production' : 'approved', fiscalYear: activeFiscalYear, createdBy: actor,
      transactionId: ptx ? ptx.id : null, parentDocId: null, batchNumber, orderBatchId: orderBatchId || null,
      formulaKey: (req.body.formulaKey && getFormula(req.body.formulaKey)) ? req.body.formulaKey : null
    };
    docs.push(doc);

    const children = clean.map(m => {
      let ctx = null;
      if (!gated) {
        ctx = { id: seqId++, date: today, type: 'consume', unit, item: m.item, qty: m.qty, note: m.note || `مصرف در تولید ${resolveItemName(item)} (سند تولید ${doc.id})`, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber };
        transactions.push(ctx);
        inventory[unit][m.item] -= m.qty;
      }
      const c = {
        id: docSeq++, date: today, type: 'consume', unit, item: m.item, qty: m.qty, fromUnit: '', toUnit: '',
        note: m.note || `مصرف در تولید ${resolveItemName(item)} (سند تولید ${doc.id})`,
        status: gated ? 'pending_production' : 'approved', fiscalYear: activeFiscalYear, createdBy: actor,
        transactionId: ctx ? ctx.id : null, parentDocId: doc.id, batchNumber, orderBatchId: orderBatchId || null
      };
      docs.push(c);
      return c;
    });

    saveData();
    res.json({
      success: true, doc, children, batchNumber, pendingWarehouse: gated,
      message: gated
        ? `سند تولید ${doc.id} ثبت شد و در انتظار تایید انباردار است (بعد از تایید به موجودی اضافه و مصرف مواد ثبت می‌شود)`
        : `سند تولید ${doc.id} با ${children.length} سند مصرف ثبت شد`
    });
    if (gated) {
      sendPushToUsernames(usersWithRoles(['warehouse', 'admin']), {
        title: '🏭 تولید در انتظار تایید انباردار',
        body: `${resolveItemName(item)} (${formatNumber(qty)}) - بخش ${deptName(unit)}`,
        url: '/'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// موجودی اول دوره (قبلاً فقط داخل کلاینت انجام می‌شد و روی سرور ذخیره نمی‌شد)
// ============================================
app.post('/api/doc/initial', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    const actor = users.find(u => u.username === req.body.actorUsername);
    const allowed = actor && (actor.role === 'admin' || ((appSettings.rolePermissions || {})[actor.role] || []).includes('sec-initial-inv'));
    if (!allowed) return res.status(403).json({ success: false, error: 'دسترسی ثبت موجودی اول دوره را ندارید' });
    if (!stageKeyProblem(req.body.unit, req.body.item)) materializeForStock(req.body.item);
    const bad = validateMovement(req.body, ['unit']) || stageKeyProblem(req.body.unit, req.body.item);
    if (bad) return res.status(400).json({ success: false, error: bad });
    const { unit, item, qty } = req.body;
    const today = docDt;
    const initRow = { unit, item, qty, date: today, fiscalYear: activeFiscalYear };
    initialInventory.push(initRow);
    if (!inventory[unit]) inventory[unit] = {};
    inventory[unit][item] = (inventory[unit][item] || 0) + qty;
    const doc = ensureInitialDoc(initRow, { actor: actor.username, source: 'manual' });
    doc.groupId = doc.id; initRow.groupId = doc.id;
    saveData();
    logActivity(actor.username, 'ثبت موجودی اول دوره', `کالا: ${resolveItemName(item)} (${item}), تعداد: ${qty}, بخش: ${deptName(unit)}`);
    res.json({ success: true, doc, message: `موجودی اولیه ${qty} ${resolveItemName(item)} برای ${deptName(unit)} ثبت شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ثبتِ لیستیِ موجودی اول دوره برای یک بخش: همهٔ ردیف‌ها اعتبارسنجی می‌شوند و بعد یک‌جا اعمال (یا هیچ‌کدام)
// «نوعِ کابل» (فرمول) برای موجودی اولِ کالای مرحله‌ای چندفرمولی (لحیم به بعد) اجباری است؛ تک‌فرمولی خودکار
function initialFormulaFor(item, fk) {
  const ks = stageFormulaKeys(item);
  if (ks.length <= 1) return { fk: ks[0] || null };
  if (!fk) return { error: `نوعِ کابل (فرمول) را انتخاب کنید - این محصول ${ks.length} فرمول دارد` };
  if (!ks.includes(String(fk))) return { error: 'فرمولِ انتخاب‌شده مالِ این محصول نیست' };
  return { fk: String(fk) };
}
const initLineKey = (item, fk) => item + '|' + (fk || '');
app.post('/api/doc/initial-batch', (req, res) => {
  try {
    loadData();
    const docDt = resolveDocDate(req, res); if (!docDt) return;
    const actor = users.find(u => u.username === req.body.actorUsername);
    const allowed = actor && (actor.role === 'admin' || ((appSettings.rolePermissions || {})[actor.role] || []).includes('sec-initial-inv'));
    if (!allowed) return res.status(403).json({ success: false, error: 'دسترسی ثبت موجودی اول دوره را ندارید' });
    const unit = req.body.unit;
    if (!DEPTS.some(d => d.id === unit)) return res.status(400).json({ success: false, error: 'بخش نامعتبر است' });
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'هیچ ردیفی برای ثبت نیست' });
    if (rows.length > 1000) return res.status(400).json({ success: false, error: 'حداکثر ۱۰۰۰ ردیف در هر ثبت' });
    const seen = new Set(), clean = [];
    for (let i = 0; i < rows.length; i++) {
      const r = { unit, item: rows[i] && rows[i].item, qty: rows[i] && rows[i].qty };
      if (!stageKeyProblem(unit, r.item)) materializeForStock(r.item);
      const bad = validateMovement(r, ['unit']) || stageKeyProblem(unit, r.item);
      if (bad) return res.status(400).json({ success: false, error: 'ردیف ' + (i + 1) + ': ' + bad });
      const ff = initialFormulaFor(r.item, rows[i].formulaKey);
      if (ff.error) return res.status(400).json({ success: false, error: 'ردیف ' + (i + 1) + ' («' + resolveItemName(r.item) + '»): ' + ff.error });
      r.formulaKey = ff.fk;
      const lk = initLineKey(r.item, r.formulaKey);
      if (seen.has(lk)) return res.status(400).json({ success: false, error: 'ردیف ' + (i + 1) + ': کالای «' + resolveItemName(r.item) + '» (با همین نوعِ کابل) تکراری است' });
      seen.add(lk); clean.push(r);
    }
    const created = [];
    const groupId = docSeq; // = شماره‌ی اولین سندِ همین ثبت
    clean.forEach(r => {
      const initRow = { unit, item: r.item, qty: r.qty, date: docDt, fiscalYear: activeFiscalYear, groupId };
      if (r.formulaKey) initRow.formulaKey = r.formulaKey;
      initialInventory.push(initRow);
      if (!inventory[unit]) inventory[unit] = {};
      inventory[unit][r.item] = (inventory[unit][r.item] || 0) + r.qty;
      const dd = ensureInitialDoc(initRow, { actor: actor.username, source: 'manual' }); dd.groupId = groupId;
      if (r.formulaKey) dd.formulaKey = r.formulaKey;
      created.push(dd.id);
    });
    saveData();
    logActivity(actor.username, 'ثبت موجودی اول دوره (لیستی)', clean.length + ' کالا برای بخش ' + deptName(unit) + ' - تاریخ ' + docDt + ' - اسناد ' + created[0] + ' تا ' + created[created.length - 1]);
    res.json({ success: true, count: clean.length, docIds: created, groupId, message: 'موجودی اول دوره ' + clean.length + ' کالا برای ' + deptName(unit) + ' در سند ' + groupId + ' ثبت شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== سندِ گروهیِ موجودی اول دوره =====
// هر ثبتِ لیستی یک سند است (groupId). داخلِ دفتر، هر کالا همچنان ردیفِ سند/تراکنشِ خودش را دارد (گزارش‌ها،
// کاردکس و لغو به همان تکیه دارند)، ولی کاربر آن را یک سند می‌بیند و یک‌جا ویرایش/لغو می‌کند.
function initialActorAllowed(username) {
  const actor = users.find(u => u.username === username);
  return actor && (actor.role === 'admin' || ((appSettings.rolePermissions || {})[actor.role] || []).includes('sec-initial-inv')) ? actor : null;
}
function removeInitialLine(doc, actor, reason) {
  // سند معکوس به‌جای پاک کردنِ تراکنش؛ ردیف‌های یک سندِ گروهی که در یک درخواست باطل می‌شوند یک شماره‌ی معکوس دارند
  const rv = (removeInitialLine.ctx && removeInitialLine.ctx.docNo === doc.docNo && doc.docNo) ? removeInitialLine.ctx.rv : newReversal(doc, actor, reason);
  removeInitialLine.ctx = { docNo: doc.docNo, rv, t: Date.now() };
  const hadTx = doc.transactionId && transactions.some(t => t.id === doc.transactionId);
  reverseDocTransactions(doc, rv);
  if (!hadTx) { inventory[doc.unit] = inventory[doc.unit] || {}; inventory[doc.unit][doc.item] = Math.round(((inventory[doc.unit][doc.item] || 0) - doc.qty) * 1e6) / 1e6; }
  initialInventory = initialInventory.filter(r => r.docId !== doc.id);
  doc.status = 'cancelled';
  doc.cancelledBy = actor; doc.cancelledAt = rv.at; if (reason) doc.cancelReason = reason;
}
app.post('/api/doc/initial-group/:gid/edit', (req, res) => {
  try {
    loadData();
    const actor = initialActorAllowed(req.body.actorUsername);
    if (!actor) return res.status(403).json({ success: false, error: 'دسترسی ویرایش موجودی اول دوره را ندارید' });
    const gid = req.params.gid;
    const old = initialGroupDocs(gid);
    if (!old.length) return res.status(404).json({ success: false, error: 'سند موجودی اول دوره پیدا نشد (یا لغو شده)' });
    if (old.some(d => d.source === 'sepidar-sync')) return res.status(400).json({ success: false, error: 'موجودیِ دریافتی از سپیدار ویرایش نمی‌شود؛ در سپیدار اصلاح کنید' });
    const unit = old[0].unit;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'سند خالی می‌شود؛ برای حذفِ کامل از «لغو سند» استفاده کنید' });
    const want = new Map(); // کلید = کالا|فرمول
    for (let i = 0; i < rows.length; i++) {
      const r = { unit, item: rows[i] && rows[i].item, qty: rows[i] && Number(rows[i].qty) };
      if (!stageKeyProblem(unit, r.item)) materializeForStock(r.item);
      const bad = validateMovement(r, ['unit']) || (old.some(d => d.item === r.item) ? null : stageKeyProblem(unit, r.item));
      if (bad) return res.status(400).json({ success: false, error: 'ردیف ' + (i + 1) + ': ' + bad });
      let ff = initialFormulaFor(r.item, rows[i].formulaKey);
      // ردیفِ قدیمیِ بدونِ نوعِ کابل می‌تواند فعلاً همان‌طور بماند (اصلاحِ تدریجی)؛ ردیفِ تازه باید نوع داشته باشد
      if (ff.error && !rows[i].formulaKey && old.some(d => d.item === r.item && !d.formulaKey)) ff = { fk: null };
      if (ff.error) return res.status(400).json({ success: false, error: 'ردیف ' + (i + 1) + ' («' + resolveItemName(r.item) + '»): ' + ff.error });
      const lk = initLineKey(r.item, ff.fk);
      if (want.has(lk)) return res.status(400).json({ success: false, error: 'ردیف ' + (i + 1) + ': کالای «' + resolveItemName(r.item) + '» (با همین نوعِ کابل) تکراری است' });
      want.set(lk, Math.round(r.qty * 1e6) / 1e6);
    }
    // ردیف‌های قدیمیِ بدونِ فرمول: اگر برای همان کالا فقط یک ردیفِ جدید با فرمول آمده، فرمول روی همان ردیف ثبت می‌شود (بدونِ لغو/ثبتِ دوباره)
    const fkAssign = new Map(); // docId → fk
    old.forEach(d => {
      if (d.formulaKey || want.has(initLineKey(d.item, null))) return;
      const cands = [...want.keys()].filter(k => k.startsWith(d.item + '|') && k !== initLineKey(d.item, null) && !old.some(o => initLineKey(o.item, o.formulaKey) === k));
      if (cands.length === 1 && old.filter(o => o.item === d.item && !o.formulaKey).length === 1) fkAssign.set(d.id, cands[0].slice(d.item.length + 1));
    });
    let newDate = old[0].date;
    if (req.body.date !== undefined && String(req.body.date).trim() !== '') { newDate = resolveDocDate(req, res); if (!newDate) return; }
    const newNote = req.body.note !== undefined && String(req.body.note).trim() ? String(req.body.note).trim() : (old[0].note || 'موجودی اول دوره');
    const oldByItem = new Map(old.map(d => [initLineKey(d.item, fkAssign.get(d.id) || d.formulaKey), d]));
    const itemOf = k => k.slice(0, k.lastIndexOf('|')), fkOfKey = k => k.slice(k.lastIndexOf('|') + 1) || null;
    // اول همه‌ی کاهش‌ها سنجیده می‌شوند (یا همه یا هیچ) - جمعِ تغییرِ هر کالا (همه‌ی نوع‌هایش)
    const problems = [];
    const items = new Set([...oldByItem.keys(), ...want.keys()]);
    const deltaByItem = {};
    items.forEach(k => { deltaByItem[itemOf(k)] = (deltaByItem[itemOf(k)] || 0) + (want.get(k) || 0) - (oldByItem.has(k) ? oldByItem.get(k).qty : 0); });
    Object.entries(deltaByItem).forEach(([it, delta]) => {
      if (delta < 0 && availableQty(unit, it) + delta < -1e-9) problems.push(`«${resolveItemName(it)}»: کاهش ${formatNumber(-delta)} ولی موجودیِ قابل‌استفاده ${formatNumber(availableQty(unit, it))}`);
    });
    if (problems.length) return res.status(400).json({ success: false, error: 'این تغییرات ممکن نیست چون بخشی از کالا مصرف یا ارسال شده:\n' + problems.join('\n') });
    const now = new Date().toISOString();
    const changes = [];
    removeInitialLine.ctx = null;
    items.forEach(k => {
      const it = itemOf(k), fk = fkOfKey(k);
      const d = oldByItem.get(k), q = want.get(k);
      if (d && q === undefined) { removeInitialLine(d, actor.username, 'حذف از سند در ویرایش'); changes.push(`حذف ${resolveItemName(it)}${d.formulaKey ? ' (فرمول ' + d.formulaKey + ')' : ''} (${d.qty})`); return; }
      if (d && fkAssign.has(d.id)) {
        (d.editHistory = d.editHistory || []).push({ at: now, by: actor.username, before: { qty: d.qty, date: d.date, note: d.note, formulaKey: null }, after: { qty: d.qty, date: d.date, note: d.note, formulaKey: fkAssign.get(d.id) } });
        d.formulaKey = fkAssign.get(d.id);
        const row0 = initialInventory.find(r => r.docId === d.id); if (row0) row0.formulaKey = d.formulaKey;
        changes.push(`${resolveItemName(it)}: نوعِ کابل = فرمول ${d.formulaKey}`);
      }
      if (!d) {
        const initRow = { unit, item: it, qty: q, date: newDate, fiscalYear: old[0].fiscalYear || activeFiscalYear, groupId: old[0].groupId };
        if (fk) initRow.formulaKey = fk;
        initialInventory.push(initRow);
        inventory[unit] = inventory[unit] || {};
        inventory[unit][it] = Math.round(((inventory[unit][it] || 0) + q) * 1e6) / 1e6;
        const nd = ensureInitialDoc(initRow, { actor: actor.username, source: 'manual', note: newNote });
        nd.groupId = old[0].groupId;
        if (fk) nd.formulaKey = fk;
        changes.push(`افزودن ${resolveItemName(it)} (${q})`);
        return;
      }
      const before = { qty: d.qty, date: d.date, note: d.note };
      if (q === d.qty && newDate === d.date && newNote === d.note) return;
      const delta = Math.round((q - d.qty) * 1e6) / 1e6;
      if (delta) {
        inventory[unit][it] = Math.round(((inventory[unit][it] || 0) + delta) * 1e6) / 1e6;
        changes.push(`${resolveItemName(it)}: ${d.qty} → ${q}`);
      }
      d.qty = q; d.date = newDate; d.note = newNote; d.updatedAt = now; d.updatedBy = actor.username;
      (d.editHistory = d.editHistory || []).push({ at: now, by: actor.username, before, after: { qty: q, date: newDate, note: newNote } });
      const tx = d.transactionId ? transactions.find(t => t.id === d.transactionId) : null;
      if (tx) { tx.qty = q; tx.date = newDate; }
      const row = initialInventory.find(r => r.docId === d.id);
      if (row) { row.qty = q; row.date = newDate; }
    });
    if (old[0].date !== newDate && !changes.length) changes.push(`تاریخ ${old[0].date} → ${newDate}`);
    saveData();
    logActivity(actor.username, 'ویرایش سند موجودی اول دوره', `سند ${gid} - ${deptName(unit)}: ${changes.join('، ') || 'بدون تغییر در اقلام'}`);
    res.json({ success: true, groupId: old[0].groupId, changes, message: `سند ${gid} ویرایش شد` + (changes.length ? ` (${changes.length} تغییر)` : '') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ===== پکِ سفارشی: گزینه‌ها و تفکیکِ موجودیِ اول دوره =====
function pvInitialLines(unit, base) {
  return docs.filter(d => d.type === 'initial' && d.status === 'approved' && d.unit === unit && String(d.fiscalYear || activeFiscalYear) === String(activeFiscalYear)
    && (d.item === base || pvBase(d.item) === base)).sort((a, b) => a.id - b.id);
}
app.get('/api/pack-variants/options', (req, res) => {
  loadData();
  const bases = PACK_VARIANT_BASES.map(code => {
    const initial = ['raw', 'pack'].concat(DEPTS.map(d => d.id).filter(u => !['raw', 'pack'].includes(u))).map(unit => {
      const lines = pvInitialLines(unit, code);
      if (!lines.length) return null;
      const total = Math.round(lines.reduce((a, d) => a + (Number(d.qty) || 0), 0) * 1e6) / 1e6;
      return { unit, unitName: deptName(unit), total, docNo: lines[0].docNo || String(lines[0].id),
        generic: Math.round(lines.filter(d => d.item === code).reduce((a, d) => a + d.qty, 0) * 1e6) / 1e6,
        lines: lines.filter(d => d.item !== code).map(d => { const v = parsePackVariant(d.item) || {}; return { key: d.item, name: v.name || d.item, brand: v.brand, cable: v.cable, qty: d.qty }; }) };
    }).filter(Boolean);
    const stock = {};
    Object.entries(inventory || {}).forEach(([u, m]) => Object.entries(m || {}).forEach(([k, q]) => { if (Math.abs(q) > 1e-9 && (k === code || pvBase(k) === code)) (stock[u] = stock[u] || {})[k] = q; }));
    return { code, name: resolveItemName(code), cables: packCableTypes(code), initial, stock };
  });
  res.json({ success: true, brands: packBrandList(), bases });
});
app.post('/api/pack-variants/split-initial', (req, res) => {
  try {
    loadData();
    // تفکیکِ پک: مدیر، نقش‌های دارای «موجودی اول دوره» و انباردار
    const actor = initialActorAllowed(req.body.actorUsername) || users.find(u => u.username === req.body.actorUsername && u.role === 'warehouse');
    if (!actor) return res.status(403).json({ success: false, error: 'دسترسی تفکیک پک را ندارید (فقط مدیر و انباردار)' });
    const { unit, base } = req.body;
    if (!isPackVariantBase(base)) return res.status(400).json({ success: false, error: 'این کالا پکِ تفکیک‌پذیر نیست' });
    const lines = pvInitialLines(unit, base);
    if (!lines.length) return res.status(404).json({ success: false, error: `موجودیِ اول دوره‌ای برای «${resolveItemName(base)}» در ${deptName(unit)} ثبت نشده` });
    const total = Math.round(lines.reduce((a, d) => a + (Number(d.qty) || 0), 0) * 1e6) / 1e6;
    const sp = resolvePackSplits(base, req.body.splits, total);
    if (sp.error) return res.status(400).json({ success: false, error: sp.error });
    const want = new Map(sp.parts.map(p => [p.key, p.qty]));
    const oldBy = new Map();
    lines.forEach(d => { if (!oldBy.has(d.item)) oldBy.set(d.item, []); oldBy.get(d.item).push(d); });
    const keys = new Set([...oldBy.keys(), ...want.keys()]);
    const oldQ = k => (oldBy.get(k) || []).reduce((a, d) => a + d.qty, 0);
    const problems = [];
    keys.forEach(k => {
      const delta = (want.get(k) || 0) - oldQ(k);
      if (delta < -1e-9 && availableQty(unit, k) + delta < -1e-6) problems.push(`«${resolveItemName(k)}»: کاهش ${formatNumber(-delta)} ولی موجودیِ قابل‌استفاده ${formatNumber(availableQty(unit, k))}`);
    });
    if (problems.length) return res.status(400).json({ success: false, error: 'این تفکیک ممکن نیست چون بخشی از کالا مصرف یا ارسال شده:\n' + problems.join('\n') });
    const tmpl = (oldBy.get(base) || lines)[0];
    const now = new Date().toISOString();
    const changes = [];
    removeInitialLine.ctx = null;
    keys.forEach(k => {
      const q = want.get(k) || 0, old = oldBy.get(k) || [];
      if (old.length === 1 && q > 0) {
        const d = old[0];
        if (Math.abs(d.qty - q) < 1e-9) return;
        const before = { qty: d.qty, date: d.date, note: d.note };
        inventory[unit] = inventory[unit] || {};
        inventory[unit][k] = Math.round(((inventory[unit][k] || 0) + q - d.qty) * 1e6) / 1e6;
        changes.push(`${resolveItemName(k)}: ${d.qty} → ${q}`);
        d.qty = q; d.updatedAt = now; d.updatedBy = actor.username;
        (d.editHistory = d.editHistory || []).push({ at: now, by: actor.username, before, after: { qty: q, date: d.date, note: d.note }, reason: 'تفکیک پک سفارشی' });
        const tx = d.transactionId ? transactions.find(t => t.id === d.transactionId) : null; if (tx) tx.qty = q;
        const row = initialInventory.find(r => r.docId === d.id); if (row) row.qty = q;
        return;
      }
      old.forEach(d => { removeInitialLine(d, actor.username, 'تفکیک پک سفارشی'); changes.push(`حذف ${resolveItemName(k)} (${d.qty})`); });
      if (q > 0) {
        registerPackVariant(k);
        const initRow = { unit, item: k, qty: q, date: tmpl.date, fiscalYear: tmpl.fiscalYear || activeFiscalYear };
        if (tmpl.groupId != null) initRow.groupId = tmpl.groupId;
        initialInventory.push(initRow);
        inventory[unit] = inventory[unit] || {};
        inventory[unit][k] = Math.round(((inventory[unit][k] || 0) + q) * 1e6) / 1e6;
        const nd = ensureInitialDoc(initRow, { actor: actor.username, source: tmpl.source || 'manual', note: tmpl.note });
        if (tmpl.groupId != null) nd.groupId = tmpl.groupId;
        nd.splitFrom = base;
        changes.push(`افزودن ${resolveItemName(k)} (${q})`);
      }
    });
    saveData();
    logActivity(actor.username, 'تفکیک پک سفارشی در موجودی اول دوره', `${deptName(unit)} - ${resolveItemName(base)} (${formatNumber(total)}): ${changes.join('، ') || 'بدون تغییر'}`);
    res.json({ success: true, changes, message: `موجودیِ اول دوره‌ی «${resolveItemName(base)}» در ${deptName(unit)} تفکیک شد (${sp.parts.length} نوع)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/doc/initial-group/:gid/cancel', (req, res) => {
  try {
    loadData();
    const actor = initialActorAllowed(req.body.actorUsername);
    if (!actor) return res.status(403).json({ success: false, error: 'دسترسی لغو موجودی اول دوره را ندارید' });
    const gid = req.params.gid;
    const list = initialGroupDocs(gid);
    if (!list.length) return res.status(404).json({ success: false, error: 'سند پیدا نشد (یا قبلاً لغو شده)' });
    const problems = list.filter(d => availableQty(d.unit, d.item) - d.qty < -1e-9)
      .map(d => `«${resolveItemName(d.item)}»: ${formatNumber(d.qty)} ولی موجودیِ قابل‌استفاده ${formatNumber(availableQty(d.unit, d.item))}`);
    if (problems.length) return res.status(400).json({ success: false, error: 'لغو ممکن نیست چون بخشی از این کالاها مصرف یا ارسال شده:\n' + problems.join('\n') });
    removeInitialLine.ctx = null;
    list.forEach(d => removeInitialLine(d, actor.username, req.body.reason || 'لغو کل سند'));
    saveData();
    logActivity(actor.username, 'لغو سند موجودی اول دوره', `سند ${gid} - ${deptName(list[0].unit)} - ${list.length} قلم - دلیل: ${req.body.reason || '-'}`);
    res.json({ success: true, message: `سند ${gid} (${list.length} قلم) لغو شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ویرایشِ سندِ موجودی اول دوره: تعداد، تاریخ و توضیح (کالا و بخش عوض نمی‌شوند - برای آن لغو و ثبتِ دوباره).
// اختلافِ تعداد مستقیم روی موجودی اعمال می‌شود؛ کاهشی که موجودیِ قابل‌استفاده را منفی کند رد می‌شود.
// اسنادی که از سپیدار آمده‌اند (انبار مواد اولیه) ویرایش نمی‌شوند چون سینکِ بعدی دوباره بازنویسی‌شان می‌کند.
app.post('/api/doc/initial/:id/edit', (req, res) => {
  try {
    loadData();
    const actor = users.find(u => u.username === req.body.actorUsername);
    const allowed = actor && (actor.role === 'admin' || ((appSettings.rolePermissions || {})[actor.role] || []).includes('sec-initial-inv'));
    if (!allowed) return res.status(403).json({ success: false, error: 'دسترسی ویرایش موجودی اول دوره را ندارید' });
    const doc = docs.find(d => d.id === parseInt(req.params.id, 10));
    if (!doc || doc.type !== 'initial') return res.status(404).json({ success: false, error: 'سند موجودی اول دوره پیدا نشد' });
    if (doc.status !== 'approved') return res.status(400).json({ success: false, error: 'فقط سندِ تاییدشده (لغونشده) قابل ویرایش است' });
    if (doc.source === 'sepidar-sync') return res.status(400).json({ success: false, error: 'این سند از سپیدار آمده و با دریافتِ بعدیِ موجودی بازنویسی می‌شود؛ مقدار را در سپیدار اصلاح کنید' });
    const qty = Number(req.body.qty);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ success: false, error: 'تعداد باید عددی بزرگ‌تر از صفر باشد' });
    const newQty = Math.round(qty * 1e6) / 1e6;
    let newDate = doc.date;
    if (req.body.date !== undefined && String(req.body.date).trim() !== '') { newDate = resolveDocDate(req, res); if (!newDate) return; }
    const newNote = req.body.note !== undefined ? String(req.body.note).trim() || 'موجودی اول دوره' : doc.note;
    const delta = Math.round((newQty - doc.qty) * 1e6) / 1e6;
    if (delta < 0 && availableQty(doc.unit, doc.item) + delta < -1e-9) {
      return res.status(400).json({ success: false, error: `کاهش ${formatNumber(-delta)} ممکن نیست: موجودیِ قابل‌استفاده‌ی «${resolveItemName(doc.item)}» در ${deptName(doc.unit)} فقط ${formatNumber(availableQty(doc.unit, doc.item))} است (بخشی مصرف یا ارسال شده)` });
    }
    if (delta === 0 && newDate === doc.date && newNote === doc.note) return res.json({ success: true, doc, message: 'تغییری نبود' });
    if (!inventory[doc.unit]) inventory[doc.unit] = {};
    inventory[doc.unit][doc.item] = Math.round(((inventory[doc.unit][doc.item] || 0) + delta) * 1e6) / 1e6;
    const row = initialInventory.find(r => r.docId === doc.id);
    if (row) { row.qty = newQty; row.date = newDate; }
    const tx = doc.transactionId ? transactions.find(t => t.id === doc.transactionId) : null;
    if (tx) { tx.qty = newQty; tx.date = newDate; }
    const before = { qty: doc.qty, date: doc.date, note: doc.note };
    doc.qty = newQty; doc.date = newDate; doc.note = newNote;
    doc.updatedAt = new Date().toISOString(); doc.updatedBy = actor.username;
    (doc.editHistory = doc.editHistory || []).push({ at: doc.updatedAt, by: actor.username, before, after: { qty: newQty, date: newDate, note: newNote } });
    saveData();
    logActivity(actor.username, 'ویرایش موجودی اول دوره', `سند ${doc.id} - ${resolveItemName(doc.item)} (${doc.item}) در ${deptName(doc.unit)}: تعداد ${before.qty} → ${newQty}` + (before.date !== newDate ? `، تاریخ ${before.date} → ${newDate}` : ''));
    res.json({ success: true, doc, message: `سند ${doc.id} ویرایش شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// کالاها: افزودن/حذف (قبلاً فقط داخل کلاینت انجام می‌شد و روی سرور ذخیره نمی‌شد)
// ============================================
app.post('/api/items/add', (req, res) => {
  try {
    loadData();
    if (!inboxActor(req.body.actorUsername, ['admin'])) return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند کالا اضافه کند' });
    const code = String(req.body.code || '').trim();
    const name = normalizeFa(req.body.name);
    if (!code || !name) return res.status(400).json({ success: false, error: 'کد و عنوان کالا الزامی است' });
    if (items.some(i => i.code === code)) return res.status(400).json({ success: false, error: `کد ${code} قبلاً ثبت شده است` });
    if (items.some(i => i.name === name)) return res.status(400).json({ success: false, error: `کالا با عنوان «${name}» قبلاً ثبت شده است` });
    const item = { code, name, groupName: String(req.body.groupName || ''), unit: String(req.body.unit || 'عدد'), created: new Date().toISOString() };
    items.push(item);
    DEPTS.forEach(d => { if (!inventory[d.id]) inventory[d.id] = {}; if (inventory[d.id][code] === undefined) inventory[d.id][code] = 0; });
    saveData();
    logActivity(req.body.actorUsername, 'افزودن کالا', `${name} (${code})`);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/items/delete', (req, res) => {
  try {
    loadData();
    if (!inboxActor(req.body.actorUsername, ['admin'])) return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند کالا حذف کند' });
    const code = String(req.body.code || '');
    const idx = items.findIndex(i => i.code === code);
    if (idx === -1) return res.status(404).json({ success: false, error: 'کالا یافت نشد' });
    const used = Object.values(inventory).some(dep => dep[code] !== undefined && dep[code] !== 0)
      || transactions.some(t => t.item === code) || docs.some(d => d.item === code) || initialInventory.some(t => t.item === code);
    if (used) return res.status(400).json({ success: false, error: `کالای «${items[idx].name}» در سیستم استفاده شده است، قابل حذف نیست` });
    const [removed] = items.splice(idx, 1);
    Object.values(inventory).forEach(dep => { if (dep[code] === 0) delete dep[code]; });
    saveData();
    logActivity(req.body.actorUsername, 'حذف کالا', `${removed.name} (${code})`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// سال مالی: ایجاد/بستن/بازگشایی (قبلاً از مسیرِ ذخیره‌ی کلاینت می‌رفت و روی سرور ذخیره نمی‌شد)
// ============================================
app.post('/api/fiscal-years', (req, res) => {
  try {
    loadData();
    const { action, year, title, startDate, endDate, actorUsername } = req.body;
    if (!inboxActor(actorUsername, ['admin'])) return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند سال مالی را مدیریت کند' });
    const y = String(year || '').trim();
    if (!/^\d{4}$/.test(y)) return res.status(400).json({ success: false, error: 'سال مالی نامعتبر است (مثلاً 1406)' });
    if (action === 'create') {
      if (fiscalYears.some(f => f.year === y)) return res.status(400).json({ success: false, error: 'این سال مالی قبلاً ایجاد شده است' });
      const dateOk = s => typeof s === 'string' && /^\d{4}\/\d{2}\/\d{2}$/.test(s);
      fiscalYears.forEach(f => { if (f.status === 'active') f.status = 'closed'; });
      fiscalYears.push({
        year: y, title: String(title || `سال مالی ${y}`), status: 'active',
        startDate: dateOk(startDate) ? startDate : `${y}/01/01`, endDate: dateOk(endDate) ? endDate : `${y}/12/29`
      });
      activeFiscalYear = y;
    } else if (action === 'close') {
      const fy = fiscalYears.find(f => f.year === y);
      if (!fy) return res.status(404).json({ success: false, error: 'سال مالی یافت نشد' });
      fy.status = 'closed';
    } else if (action === 'reopen') {
      const fy = fiscalYears.find(f => f.year === y);
      if (!fy) return res.status(404).json({ success: false, error: 'سال مالی یافت نشد' });
      fiscalYears.forEach(f => { if (f.status === 'active') f.status = 'closed'; });
      fy.status = 'active';
      activeFiscalYear = y;
    } else {
      return res.status(400).json({ success: false, error: 'عملیات نامعتبر است' });
    }
    saveData();
    logActivity(actorUsername, ({ create: 'ایجاد سال مالی', close: 'بستن سال مالی', reopen: 'بازگشایی سال مالی' })[action], y);
    res.json({ success: true, fiscalYears, activeFiscalYear });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// بررسی یکپارچگی داده (فقط‌خواندنی): موجودیِ ذخیره‌شده با مجموعِ تراکنش‌ها + چند چکِ ساختاری
// ============================================
function computeIntegrity() {
  const plus = ['production', 'excess', 'receipt', 'input'];
  const minus = ['consume', 'output', 'waste', 'shortage'];
  const key = (u, i) => u + '|' + i;
  const bal = {};
  initialInventory.forEach(t => { bal[key(t.unit, t.item)] = (bal[key(t.unit, t.item)] || 0) + t.qty; });
  // تراکنشِ نوع initial در گزارش‌ها حساب نمی‌شه (مبنا همان ردیف‌های initialInventory است)
  transactions.forEach(t => {
    const k = key(t.unit, t.item);
    if (plus.includes(t.type)) bal[k] = (bal[k] || 0) + t.qty;
    else if (minus.includes(t.type)) bal[k] = (bal[k] || 0) - t.qty;
  });
  const keys = new Set([...Object.keys(bal), ...Object.entries(inventory).flatMap(([u, m]) => Object.keys(m).map(i => key(u, i)))]);
  const r3 = v => Math.round(v * 1000) / 1000;
  const mismatches = [];
  keys.forEach(k => {
    const [u, i] = k.split('|');
    const stored = (inventory[u] && inventory[u][i]) || 0;
    const calc = bal[k] || 0;
    const diff = r3(stored - calc);
    if (Math.abs(diff) > 0.001) mismatches.push({ unit: u, unitName: deptName(u), item: i, name: resolveItemName(i), stored: r3(stored), fromTransactions: r3(calc), diff });
  });
  mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const negatives = [];
  const nonNumeric = [];
  const unknownCodes = [];
  Object.entries(inventory).forEach(([u, m]) => Object.entries(m).forEach(([i, v]) => {
    if (typeof v !== 'number' || !isFinite(v)) nonNumeric.push({ unit: u, unitName: deptName(u), item: i, value: String(v) });
    else if (v < 0) negatives.push({ unit: u, unitName: deptName(u), item: i, name: resolveItemName(i), value: v });
    if (v !== 0 && !knownItemCode(u, i)) unknownCodes.push({ unit: u, unitName: deptName(u), item: i });
  }));
  const txIds = new Set();
  const dupTx = [];
  transactions.forEach(t => { if (txIds.has(t.id)) dupTx.push(t.id); txIds.add(t.id); });
  const docIds = new Set();
  const dupDocs = [];
  docs.forEach(d => { if (docIds.has(d.id)) dupDocs.push(d.id); docIds.add(d.id); });
  const usedTx = new Set();
  docs.forEach(d => { if (d.transactionId) usedTx.add(d.transactionId); if (d.transactionId2) usedTx.add(d.transactionId2); (d.extraTxIds || []).forEach(x => usedTx.add(x)); ((d.reversal && d.reversal.txIds) || []).forEach(x => usedTx.add(x)); });
  const orphanTransactions = transactions.filter(t => !usedTx.has(t.id)).map(t => ({ id: t.id, type: t.type, item: t.item, qty: t.qty }));
  const needsTx = ['production', 'consume', 'waste', 'shortage', 'excess', 'receipt', 'output'];
  const docsWithoutTx = docs.filter(d => d.status === 'approved' && needsTx.includes(d.type) && !d.transactionId).map(d => ({ id: d.id, type: d.type, item: d.item, qty: d.qty }));
  const missingTxDocs = docs.filter(d => d.transactionId && !txIds.has(d.transactionId)).map(d => ({ id: d.id, type: d.type, status: d.status, transactionId: d.transactionId }));
  // روالِ بینِ بخش‌ها: کالای مرحله‌ای در بخشِ نامجاز، و تولیدهایی که ورودیِ مرحله‌ایِ ناهمخوان (کد/برند/رنگ/نوعِ کابل) مصرف کرده‌اند
  const chainIssues = [];
  Object.entries(inventory).forEach(([u, m]) => Object.entries(m || {}).forEach(([i, v]) => {
    if (Math.abs(v) < 1e-9) return;
    const sp = stageKeyProblem(u, i) || (u === 'raw' && isStageKey(i) ? 'کالای مرحله‌ای در انبار مواد اولیه' : null);
    if (sp) chainIssues.push({ kind: 'موجودی در بخشِ نامجاز', unitName: deptName(u), item: i, name: resolveItemName(i), detail: sp });
  }));
  docs.forEach(d => {
    if (d.type !== 'production' || d.status !== 'approved') return;
    const mats = docs.filter(c => c.parentDocId === d.id && (c.type === 'consume' || c.type === 'waste') && c.status === 'approved').map(c => ({ item: c.item, qty: c.qty }));
    const p = colorProblem(d.unit, d.item, mats) || chainProblem(d.unit, d.item, mats, d.formulaKey);
    if (p) chainIssues.push({ kind: 'تولیدِ ناهمخوان با ورودی', unitName: deptName(d.unit), item: d.item, name: resolveItemName(d.item), docNo: d.docNo || String(d.id), detail: p });
  });
  docs.forEach(d => {
    if (d.type !== 'output' || !['approved', 'pending', 'pending_warehouse'].includes(d.status)) return;
    const sp = stageKeyProblem(d.toUnit, d.item);
    if (sp) chainIssues.push({ kind: 'خروج به بخشِ نامجاز', unitName: deptName(d.fromUnit) + ' ← ' + deptName(d.toUnit), item: d.item, name: resolveItemName(d.item), docNo: d.docNo || String(d.id), detail: sp });
  });
  return {
    chainIssues,
    pairsChecked: keys.size, mismatches, negatives, nonNumeric, unknownCodes,
    duplicateDocIds: dupDocs, duplicateTxIds: dupTx, orphanTransactions, docsWithoutTx, missingTxDocs,
    pendingDocs: docs.filter(d => /^pending|^return_pending/.test(d.status)).length
  };
}

// هم‌ترازیِ موجودیِ ذخیره‌شده‌ی «یک ردیف» با مجموعِ تراکنش‌ها (فقط مدیر، با دلیل و لاگِ کامل).
// برای وقتی که موجودیِ ذخیره‌شده (مثلاً به‌خاطر باگِ قدیمیِ لغو) از دفترِ تراکنش‌ها جدا افتاده: تراکنشِ جدیدی
// ساخته نمی‌شه، فقط عددِ ذخیره‌شده برابر با مجموعِ تراکنش‌ها می‌شه. expectedStored باید با مقدار فعلی بخونه
// (تا اگه بین بررسی و اصلاح چیزی عوض شده، اصلاحِ کور انجام نشه).
app.post('/api/integrity/align-stock', (req, res) => {
  try {
    loadData();
    const { unit, item, expectedStored, reason, actorUsername } = req.body;
    if (!inboxActor(actorUsername, ['admin'])) return res.status(403).json({ success: false, error: 'فقط مدیر' });
    if (!reason || String(reason).trim().length < 5) return res.status(400).json({ success: false, error: 'دلیل اصلاح الزامی است' });
    const row = computeIntegrity().mismatches.find(m => m.unit === unit && m.item === item);
    if (!row) return res.status(400).json({ success: false, error: 'برای این ردیف اختلافی وجود ندارد' });
    if (Math.abs(row.stored - Number(expectedStored)) > 0.001) {
      return res.status(409).json({ success: false, error: `موجودیِ ذخیره‌شده تغییر کرده (الان ${row.stored})؛ دوباره بررسی کنید` });
    }
    if (!(row.fromTransactions >= 0)) return res.status(400).json({ success: false, error: 'مجموعِ تراکنش‌ها منفی است؛ باید دستی بررسی شود' });
    const old = inventory[unit][item];
    inventory[unit][item] = row.fromTransactions;
    saveData();
    logActivity(actorUsername, '⚠️ هم‌ترازی موجودی با تراکنش‌ها', `${deptName(unit)} - ${resolveItemName(item)} (${item}): ${old} ← ${row.fromTransactions} (اختلاف ${row.diff}) - دلیل: ${String(reason).trim()}`);
    res.json({ success: true, unit, item, from: old, to: row.fromTransactions, diff: row.diff });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/integrity', (req, res) => {
  try {
    loadData();
    res.json({ success: true, checkedAt: new Date().toISOString(), ...computeIntegrity() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// انبارگردانی (شمارش انبار) با سندِ خودکارِ اصلاح
// ============================================
// جریان: ۱) شروعِ شمارش برای یک بخش در یک تاریخ (فهرستِ کالاهای دارای موجودی با عکسِ موجودیِ سیستم ساخته می‌شه)
// ۲) شمارنده مقدارِ شمارش‌شده‌ی هر کالا رو وارد می‌کنه (می‌شه چند بار ذخیره کرد) ۳) مدیر یا نقشِ دارای مجوزِ تاییدِ
// اضافات/کسری «پایان» می‌زنه: برای هر کالایی که شمارش‌شده‌اش با موجودیِ لحظه‌ی پایان فرق داره، یک سندِ اضافات (اگه
// بیشتره) یا کسری (اگه کمتره) با تاریخِ شمارش ثبت می‌شه. کالای شمارش‌نشده دست نمی‌خوره (مگر با گزینه‌ی صریح).
function faDigits(str) { return String(str).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]); }

function todayJalaliParts() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).map(x => [x.type, +x.value]));
  return { y: p.year, m: p.month, d: p.day };
}

function canCountUnit(user, unit) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'warehouse') return true;
  const d = DEPTS.find(x => x.id === unit);
  return !!d && user.unit === d.name;
}

function stockCountSummary(c) {
  const counted = c.lines.filter(l => l.countedQty !== null && l.countedQty !== undefined).length;
  return {
    id: c.id, unit: c.unit, unitName: deptName(c.unit), dateFa: c.dateFa, dateJalali: c.dateJalali, status: c.status, note: c.note || '',
    createdBy: c.createdBy, createdAt: c.createdAt, finalizedBy: c.finalizedBy || null, finalizedAt: c.finalizedAt || null,
    lineCount: c.lines.length, countedCount: counted, result: c.result || null, adjustmentDocIds: c.adjustmentDocIds || []
  };
}

app.get('/api/stock-counts', (req, res) => {
  loadData();
  const unit = req.query.unit;
  const list = stockCounts.filter(c => !unit || c.unit === unit).slice().sort((a, b) => b.id - a.id).map(stockCountSummary);
  res.json({ success: true, counts: list });
});

app.get('/api/stock-counts/:id', (req, res) => {
  loadData();
  const c = stockCounts.find(x => x.id === parseInt(req.params.id));
  if (!c) return res.status(404).json({ success: false, error: 'برگهٔ انبارگردانی یافت نشد' });
  // موجودیِ لحظه‌ای هم کنارِ عکسِ اولیه برگردونده می‌شه تا تغییرِ حین شمارش دیده بشه
  const lines = c.lines.map(l => {
    const currentQty = (inventory[c.unit] && inventory[c.unit][l.item]) || 0;
    const pendingOut = pendingOutQty(c.unit, l.item);
    // «انتظار» = چیزی که باید فیزیکی در بخش باشد: موجودیِ سیستم منهای خروج‌های در راه؛ برای ردیفِ شمارش‌شده
    // همان عکسی است که لحظه‌ی ثبتِ شمارش گرفته شد
    const expectedQty = (l.countedQty !== null && l.countedQty !== undefined && l.expectedAtCount !== undefined)
      ? l.expectedAtCount : Math.round((currentQty - pendingOut) * 1e6) / 1e6;
    return { ...l, name: resolveItemName(l.item), unitLabel: (items.find(i => i.code === l.item) || {}).unit || '', currentQty, pendingOut, expectedQty };
  });
  res.json({ success: true, count: { ...stockCountSummary(c), uncountedAsZero: !!c.uncountedAsZero, lines } });
});

app.post('/api/stock-counts', (req, res) => {
  try {
    loadData();
    const { unit, date, note, actorUsername } = req.body;
    const user = users.find(u => u.username === actorUsername);
    if (!user) return res.status(403).json({ success: false, error: 'کاربر نامعتبر است' });
    if (!DEPTS.some(d => d.id === unit)) return res.status(400).json({ success: false, error: 'بخش نامعتبر است' });
    if (!canCountUnit(user, unit)) return res.status(403).json({ success: false, error: 'فقط انباردار، مدیر یا کاربران همان بخش می‌توانند برای این بخش انبارگردانی کنند' });
    const m = String(date || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return res.status(400).json({ success: false, error: 'تاریخ شمارش نامعتبر است (مثلاً 1405/07/13)' });
    const jy = +m[1], jm = +m[2], jd = +m[3];
    const t = todayJalaliParts();
    if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return res.status(400).json({ success: false, error: 'تاریخ شمارش نامعتبر است' });
    if (jy * 10000 + jm * 100 + jd > t.y * 10000 + t.m * 100 + t.d) return res.status(400).json({ success: false, error: 'تاریخ شمارش نمی‌تواند در آینده باشد' });
    { const cp = closedProblem(`${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`); if (cp) return res.status(400).json({ success: false, error: cp }); }
    if (stockCounts.some(c => c.unit === unit && c.status === 'open')) {
      return res.status(400).json({ success: false, error: `برای «${deptName(unit)}» یک برگهٔ انبارگردانیِ باز وجود دارد؛ ابتدا آن را تمام یا لغو کنید` });
    }
    const lines = Object.entries(inventory[unit] || {}).filter(([k, v]) => v !== 0)
      .map(([item, qty]) => ({ item, systemQty: qty, countedQty: null, note: '' }));
    const c = {
      id: stockCountSeq++, unit, dateJalali: `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`,
      dateFa: faDigits(`${jy}/${jm}/${jd}`), status: 'open', note: String(note || '').slice(0, 300),
      createdBy: actorUsername, createdAt: new Date().toISOString(), lines
    };
    stockCounts.push(c);
    saveData();
    logActivity(actorUsername, 'شروع انبارگردانی', `برگه ${c.id} - ${deptName(unit)} - تاریخ ${c.dateJalali} - ${lines.length} قلم`);
    res.json({ success: true, id: c.id, count: stockCountSummary(c) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ذخیره‌ی شمارش‌ها: entries = [{item, counted: عدد≥۰ یا null (پاک‌کردنِ شمارش), note}] - کالای تازه (بدون موجودی) هم می‌شه اضافه کرد
app.post('/api/stock-counts/:id/entries', (req, res) => {
  try {
    loadData();
    const c = stockCounts.find(x => x.id === parseInt(req.params.id));
    if (!c) return res.status(404).json({ success: false, error: 'برگهٔ انبارگردانی یافت نشد' });
    const user = users.find(u => u.username === req.body.actorUsername);
    if (!user || !canCountUnit(user, c.unit)) return res.status(403).json({ success: false, error: 'دسترسی ندارید' });
    if (c.status !== 'open') return res.status(400).json({ success: false, error: 'این برگه دیگر باز نیست' });
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    const errors = [];
    entries.forEach(e => {
      let line = c.lines.find(l => l.item === e.item);
      if (!line) {
        if (!knownItemCode(c.unit, e.item)) { errors.push(`کالای «${e.item}» شناخته‌شده نیست`); return; }
        line = { item: e.item, systemQty: (inventory[c.unit] && inventory[c.unit][e.item]) || 0, countedQty: null, note: '' };
        c.lines.push(line);
      }
      if (e.counted === null || e.counted === '' || e.counted === undefined) {
        // ردیفی که فقط یادداشتش عوض شده (بدون کلیدِ counted) شمارشش پاک نمی‌شود - قبلاً پاک می‌شد
        if (Object.prototype.hasOwnProperty.call(e, 'counted')) { line.countedQty = null; delete line.expectedAtCount; delete line.countedAt; }
      } else {
        const q = Number(e.counted);
        if (!Number.isFinite(q) || q < 0 || q > 1e9) { errors.push(`مقدار شمارش‌شدهٔ «${resolveItemName(e.item)}» نامعتبر است`); return; }
        const newQ = Math.round(q * 1e6) / 1e6;
        // عکسِ «موجودیِ مورد انتظار» در لحظه‌ی ثبتِ شمارش: موجودی − خروج‌های در راه. اختلاف بعداً نسبت به همین
        // عکس حساب می‌شود، نه موجودیِ لحظه‌ی نهایی‌کردن؛ پس تولید/خروجی که بین شمارش و نهایی‌کردن ثبت شود
        // اختلاف را خراب نمی‌کند، و کالایی که فرستاده شده ولی هنوز تایید نشده «کسری» حساب نمی‌شود.
        if (newQ !== line.countedQty || line.expectedAtCount === undefined) {
          const cur = (inventory[c.unit] && inventory[c.unit][e.item]) || 0;
          line.expectedAtCount = Math.round((cur - pendingOutQty(c.unit, e.item)) * 1e6) / 1e6;
          line.countedAt = new Date().toISOString();
        }
        line.countedQty = newQ;
      }
      if (typeof e.note === 'string') line.note = e.note.slice(0, 200);
    });
    if (typeof req.body.uncountedAsZero === 'boolean') c.uncountedAsZero = req.body.uncountedAsZero;
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('\n') });
    saveData();
    res.json({ success: true, count: stockCountSummary(c) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/stock-counts/:id/finalize', (req, res) => {
  try {
    loadData();
    const c = stockCounts.find(x => x.id === parseInt(req.params.id));
    if (!c) return res.status(404).json({ success: false, error: 'برگهٔ انبارگردانی یافت نشد' });
    const { actorUsername } = req.body;
    if (!isAdjustmentApprover(actorUsername)) {
      return res.status(403).json({ success: false, error: 'فقط مدیر یا نقشی که مجوز «تایید ضایعات/کسری/اضافات» دارد می‌تواند انبارگردانی را نهایی کند' });
    }
    if (c.status !== 'open') return res.status(400).json({ success: false, error: 'این برگه قبلاً نهایی یا لغو شده است' });
    { const cp = closedProblem(c.dateJalali); if (cp) return res.status(400).json({ success: false, error: cp }); }
    const uncountedAsZero = req.body.uncountedAsZero === true || (req.body.uncountedAsZero === undefined && c.uncountedAsZero === true);
    const counted = c.lines.filter(l => l.countedQty !== null && l.countedQty !== undefined);
    if (counted.length === 0 && !uncountedAsZero) return res.status(400).json({ success: false, error: 'هیچ کالایی شمارش نشده است' });

    const today = c.dateJalali; // همان قالبِ «1405/07/13» بقیه‌ی اسناد (قبلاً با ارقام فارسی ذخیره می‌شد)
    const created = [];
    let unchanged = 0, uncounted = 0;
    if (!inventory[c.unit]) inventory[c.unit] = {};
    // اختلاف = شمارش − «موجودیِ مورد انتظار» در لحظه‌ی شمارش (موجودی − خروج‌های در راه)؛ اصلاح روی موجودیِ
    // فعلی اعمال می‌شود. اگر موجودی از آن لحظه آن‌قدر کم شده که اصلاح منفی‌اش کند، نهایی‌کردن متوقف می‌شود.
    const plan = [];
    const blockers = [];
    c.lines.forEach(l => {
      let target = l.countedQty;
      const current = inventory[c.unit][l.item] || 0;
      const pend = pendingOutQty(c.unit, l.item);
      let expected;
      if (target === null || target === undefined) {
        if (!uncountedAsZero) { uncounted++; return; }
        target = 0;
        expected = Math.round((current - pend) * 1e6) / 1e6;
      } else {
        expected = l.expectedAtCount !== undefined ? l.expectedAtCount : Math.round((current - pend) * 1e6) / 1e6;
      }
      const diff = Math.round((target - expected) * 1000) / 1000;
      if (Math.abs(diff) < 0.001) { plan.push({ l, current, expected, target, diff: 0, pend }); return; }
      if (current + diff < -QTY_EPS) blockers.push(`«${resolveItemName(l.item)}»: اصلاحِ ${diff} موجودیِ فعلی (${current}) را منفی می‌کند`);
      plan.push({ l, current, expected, target, diff, pend });
    });
    if (blockers.length) return res.status(400).json({ success: false, error: 'نهایی‌کردن انجام نشد - موجودی از زمانِ شمارش تغییر کرده:\n' + blockers.join('\n') });
    plan.forEach(({ l, current, expected, target, diff, pend }) => {
      l.finalSystemQty = current;
      l.expectedUsed = expected;
      if (Math.abs(diff) < 0.001) { unchanged++; l.diff = 0; return; }
      l.diff = diff;
      const type = diff > 0 ? 'excess' : 'shortage';
      const qty = Math.abs(diff);
      const batchNumber = generateBatchNumber();
      const note = `انبارگردانی شماره ${c.id} (${c.dateJalali}) - مورد انتظار ${expected}${pend ? ` (موجودی ${current}، در راه ${pend})` : ''} ← شمارش ${target}${l.note ? ' - ' + l.note : ''}`;
      inventory[c.unit][l.item] = Math.round((current + diff) * 1e6) / 1e6;
      const tx = { id: seqId++, date: today, type, unit: c.unit, item: l.item, qty, note, targetUnit: '', fiscalYear: activeFiscalYear, batchNumber };
      transactions.push(tx);
      const doc = {
        id: docSeq++, date: today, type, unit: c.unit, item: l.item, qty, fromUnit: '', toUnit: '', note, status: 'approved',
        fiscalYear: activeFiscalYear, createdBy: actorUsername, transactionId: tx.id, parentDocId: null, batchNumber,
        source: 'stockcount', stockCountId: c.id, approvedBy: actorUsername, approvedAt: new Date().toISOString()
      };
      docs.push(doc);
      l.docId = doc.id;
      created.push(doc.id);
    });
    c.status = 'finalized';
    c.finalizedBy = actorUsername;
    c.finalizedAt = new Date().toISOString();
    c.uncountedAsZero = uncountedAsZero;
    c.adjustmentDocIds = created;
    c.result = {
      excess: c.lines.filter(l => l.diff > 0).length, shortage: c.lines.filter(l => l.diff < 0).length,
      unchanged, uncounted
    };
    saveData();
    logActivity(actorUsername, 'نهایی‌کردن انبارگردانی', `برگه ${c.id} - ${deptName(c.unit)} - اضافات: ${c.result.excess}، کسری: ${c.result.shortage}، بدون تغییر: ${unchanged}، شمارش‌نشده: ${uncounted} - اسناد: ${created.join(', ') || '-'}`);
    res.json({ success: true, count: stockCountSummary(c), message: `انبارگردانی نهایی شد: ${c.result.excess} سند اضافات، ${c.result.shortage} سند کسری` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/stock-counts/:id/cancel', (req, res) => {
  try {
    loadData();
    const c = stockCounts.find(x => x.id === parseInt(req.params.id));
    if (!c) return res.status(404).json({ success: false, error: 'برگهٔ انبارگردانی یافت نشد' });
    const user = users.find(u => u.username === req.body.actorUsername);
    if (!user || !canCountUnit(user, c.unit)) return res.status(403).json({ success: false, error: 'دسترسی ندارید' });
    if (c.status !== 'open') return res.status(400).json({ success: false, error: 'فقط برگهٔ باز قابل لغو است (اسناد اصلاحِ نهایی‌شده را از «اسناد» لغو کنید)' });
    c.status = 'cancelled';
    c.cancelledBy = req.body.actorUsername;
    c.cancelledAt = new Date().toISOString();
    saveData();
    logActivity(req.body.actorUsername, 'لغو انبارگردانی', `برگه ${c.id} - ${deptName(c.unit)}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// محلِ قفسه، حداقل موجودی، هدفِ تولید و تحلیلِ تولید
// ============================================
function canManageWarehouseMeta(username) {
  const u = users.find(x => x.username === username);
  return !!u && (u.role === 'admin' || u.role === 'warehouse');
}

// ---------- محل قفسه / مکان در انبار ----------
// itemLocations = { "<unit>|<itemCode>": "A-02-3" } ؛ مقدارِ خالی = حذف
app.post('/api/locations', (req, res) => {
  try {
    loadData();
    if (!canManageWarehouseMeta(req.body.actorUsername)) return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند محل کالا را ثبت کند' });
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!entries.length || entries.length > 2000) return res.status(400).json({ success: false, error: 'فهرست ورودی نامعتبر است' });
    const errors = [];
    entries.forEach(e => {
      if (!DEPTS.some(d => d.id === e.unit)) { errors.push(`بخش نامعتبر: ${e.unit}`); return; }
      if (!knownItemCode(e.unit, e.item)) { errors.push(`کالای ناشناس: ${e.item}`); return; }
      const loc = normalizeFa(String(e.location == null ? '' : e.location)).slice(0, 40);
      const key = e.unit + '|' + e.item;
      if (loc === '') delete itemLocations[key]; else itemLocations[key] = loc;
    });
    if (errors.length) return res.status(400).json({ success: false, error: errors.slice(0, 5).join('\n') });
    saveData();
    logActivity(req.body.actorUsername, 'ثبت محل کالا', `${entries.length} ردیف` + (entries.length === 1 ? ` - ${deptName(entries[0].unit)} / ${entries[0].item} ← ${entries[0].location || '(حذف)'}` : ''));
    res.json({ success: true, count: entries.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- حداقل موجودی ----------
// minStock = { "<unit>|<itemCode>": عدد } ؛ null/خالی = حذف
app.post('/api/min-stock', (req, res) => {
  try {
    loadData();
    if (!canManageWarehouseMeta(req.body.actorUsername)) return res.status(403).json({ success: false, error: 'فقط انباردار یا مدیر می‌تواند حداقل موجودی را تعیین کند' });
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!entries.length || entries.length > 2000) return res.status(400).json({ success: false, error: 'فهرست ورودی نامعتبر است' });
    const errors = [];
    entries.forEach(e => {
      if (!DEPTS.some(d => d.id === e.unit)) { errors.push(`بخش نامعتبر: ${e.unit}`); return; }
      if (!knownItemCode(e.unit, e.item)) { errors.push(`کالای ناشناس: ${e.item}`); return; }
      const key = e.unit + '|' + e.item;
      if (e.min === null || e.min === '' || e.min === undefined) { delete minStock[key]; return; }
      const q = Number(e.min);
      if (!Number.isFinite(q) || q < 0 || q > 1e9) { errors.push(`حداقل موجودیِ «${e.item}» نامعتبر است`); return; }
      if (q === 0) delete minStock[key]; else minStock[key] = Math.round(q * 1e6) / 1e6;
    });
    if (errors.length) return res.status(400).json({ success: false, error: errors.slice(0, 5).join('\n') });
    saveData();
    logActivity(req.body.actorUsername, 'تعیین حداقل موجودی', `${entries.length} ردیف`);
    res.json({ success: true, count: entries.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function computeMinStockAlerts() {
  const alerts = [];
  Object.entries(minStock).forEach(([key, min]) => {
    const [unit, item] = key.split('|');
    const stock = (inventory[unit] && inventory[unit][item]) || 0;
    if (stock + QTY_EPS < min) {
      alerts.push({ unit, unitName: deptName(unit), item, name: resolveItemName(item), stock: Math.round(stock * 1000) / 1000, min, deficit: Math.round((min - stock) * 1000) / 1000, location: itemLocations[key] || '' });
    }
  });
  alerts.sort((a, b) => (b.deficit / (b.min || 1)) - (a.deficit / (a.min || 1)));
  return alerts;
}

app.get('/api/min-stock/alerts', (req, res) => {
  loadData();
  res.json({ success: true, alerts: computeMinStockAlerts(), totalRules: Object.keys(minStock).length });
});

// ---------- هدف / برنامهٔ تولید (آماده برای زمانی که برنامهٔ تولید داشته باشید) ----------
// هر هدف: بخش + (اختیاری) کالا + بازهٔ شمسی + تعداد. فعلاً فقط ثبت می‌شود و داشبورد در صورت وجود آن را با تولیدِ واقعی مقایسه می‌کند.
function faKey(str) {
  const p = String(str || '').replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).split('/');
  if (p.length !== 3) return null;
  const [y, m, d] = p.map(x => parseInt(x, 10));
  if (!y || !m || !d) return null;
  return y * 10000 + m * 100 + d;
}
function keyToFa(key) { const y = Math.floor(key / 10000), m = Math.floor((key % 10000) / 100), d = key % 100; return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`; }
function jalaliKeyOf(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date).map(x => [x.type, +x.value]));
  return p.year * 10000 + p.month * 100 + p.day;
}

app.get('/api/production-targets', (req, res) => {
  loadData();
  res.json({ success: true, targets: productionTargets.slice().sort((a, b) => b.id - a.id) });
});

app.post('/api/production-targets', (req, res) => {
  try {
    loadData();
    const u = users.find(x => x.username === req.body.actorUsername);
    if (!u || !['admin', 'supervisor'].includes(u.role)) return res.status(403).json({ success: false, error: 'فقط مدیر یا سرپرست می‌تواند هدف تولید ثبت کند' });
    const { unit, item, startDate, endDate, qty, note, period } = req.body;
    if (!STAGE_DEPTS.includes(unit)) return res.status(400).json({ success: false, error: 'بخش تولیدی نامعتبر است' });
    if (item && !knownItemCode(unit, item)) return res.status(400).json({ success: false, error: 'کالا شناخته‌شده نیست' });
    const sk = faKey(startDate), ek = faKey(endDate || startDate);
    if (!sk || !ek || ek < sk) return res.status(400).json({ success: false, error: 'بازهٔ تاریخ نامعتبر است' });
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0 || q > 1e9) return res.status(400).json({ success: false, error: 'مقدار هدف نامعتبر است' });
    const t = { id: productionTargetSeq++, unit, item: item || null, period: ['day', 'week', 'month', 'custom'].includes(period) ? period : 'custom', startDate: keyToFa(sk), endDate: keyToFa(ek), qty: q, note: String(note || '').slice(0, 200), createdBy: req.body.actorUsername, createdAt: new Date().toISOString() };
    productionTargets.push(t);
    saveData();
    logActivity(req.body.actorUsername, 'ثبت هدف تولید', `${deptName(unit)}${item ? ' / ' + resolveItemName(item) : ''}: ${q} (${t.startDate} تا ${t.endDate})`);
    res.json({ success: true, target: t });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/production-targets/:id/delete', (req, res) => {
  try {
    loadData();
    const u = users.find(x => x.username === req.body.actorUsername);
    if (!u || !['admin', 'supervisor'].includes(u.role)) return res.status(403).json({ success: false, error: 'فقط مدیر یا سرپرست' });
    const idx = productionTargets.findIndex(t => t.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ success: false, error: 'هدف یافت نشد' });
    const [t] = productionTargets.splice(idx, 1);
    saveData();
    logActivity(req.body.actorUsername, 'حذف هدف تولید', `${deptName(t.unit)} ${t.startDate}-${t.endDate} ${t.qty}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- تحلیلِ تولید (داشبوردِ مدیر تولید) ----------
// period: today | 7d | month | fy. همه از روی تراکنش‌ها حساب می‌شود (فقط‌خواندنی).
// ============================================
// گزارش «مواد اولیه‌ی در جریان»: موجودیِ هر بخش (کالای نیمه‌ساخته، محصول و موادِ آزاد) به مواد اولیه‌ی
// سازنده‌اش باز می‌شود. محصولِ هر مرحله = همه‌ی موادِ فرمولش که مرحله‌شان تا همان مرحله است
// (لحیم‌شده = کابلِ برش + موادِ لحیم؛ تزریق‌شده = آن + موادِ تزریق؛ ...). اگر کالا چند فرمول دارد، سهمِ هر
// فرمول از روی سوابقِ تولیدِ همان کالا (formulaKey اسناد) حساب می‌شود، وگرنه فرمولِ اول.
// ============================================
const WIP_STAGE_IDX = { cut: 0, solder: 1, inject: 2, laser: 3, pack: 4 };
const WIP_PREFIX_IDX = { CUT: 0, SOL: 1, INJ: 2, LASER: 3, PACK: 4 };
function wipFormulaWeights(pc) {
  const keys = formulaKeysOfProductCode(pc);
  const def = Object.values(productDefinitions).flat().find(p => p && p.productCode === pc && (p.formulaKeys || []).length);
  const all = keys.length ? keys : ((def && def.formulaKeys) || []).filter(k => getFormula(k));
  if (!all.length) return [];
  const prod = {};
  docs.forEach(d => {
    if (d.type !== 'production' || d.status !== 'approved' || !d.formulaKey || !all.includes(d.formulaKey)) return;
    const m = splitColor(d.item).base.match(/^(?:SOL|INJ)-(.+)$|^(?:LASER|PACK)-([^-]+)-/);
    if (m && (m[1] || m[2]) === pc) prod[d.formulaKey] = (prod[d.formulaKey] || 0) + (d.qty || 0);
  });
  const tot = Object.values(prod).reduce((a, b) => a + b, 0);
  if (!tot) return [{ fk: all[0], w: 1, estimated: all.length > 1 }];
  return all.filter(k => prod[k]).map(k => ({ fk: k, w: prod[k] / tot, estimated: true }));
}
function global_inventory_ref() { return inventory; }
function computeWipMaterials(invOverride) {
    const inventory = invOverride || global_inventory_ref();
    const REPORT_DEPTS = ['raw', 'cut', 'solder', 'inject', 'laser', 'pack', 'qc', 'finished']; // انبار مواد اولیه = موادِ آزاد
    const wipLots = buildLotLedger();
    const mats = {};      // کدِ ماده → { code, name, unit, byDept, total, from: [] }
    const unknown = [];   // کالاهایی که فرمولشان پیدا نشد
    const multi = new Set();
    const unitOf = {};
    Object.values(bomFormulas).concat(Object.values((appSettings && appSettings.archivedFormulas) || {}))
      .forEach(f => (f.materials || []).forEach(m => { if (!unitOf[m.code]) unitOf[m.code] = { name: m.name, unit: m.unit }; }));
    const add = (code, qty, dept, srcKey, srcQty) => {
      if (!qty) return;
      const it = items.find(i => i.code === code);
      const m = mats[code] || (mats[code] = { code, name: (it && it.name) || (unitOf[code] && unitOf[code].name) || resolveItemName(code),
        unit: (it && it.unit) || (unitOf[code] && unitOf[code].unit) || 'عدد', byDept: {}, total: 0, from: [] });
      m.byDept[dept] = (m.byDept[dept] || 0) + qty; m.total += qty;
      m.from.push({ dept, item: srcKey, name: resolveItemName(srcKey), stock: srcQty, qty });
    };
    REPORT_DEPTS.forEach(dept => {
      Object.entries(inventory[dept] || {}).forEach(([key, stock]) => {
        if (!(stock > 1e-9)) return;
        const base = splitColor(key).base;
        const pm = base.match(/^(CUT|SOL|INJ|LASER|PACK)-/);
        if (!pm) { add(pvBase(base), stock, dept, key, stock); return; }        // ماده‌ی آزاد = خودش
        const S = WIP_PREFIX_IDX[pm[1]];
        if (pm[1] === 'CUT') {
          const def = (productDefinitions.cut || []).find(p => p.code === base);
          const cm = base.match(/^CUT-(.+)-(\d+)$/);
          const raw = def ? def.rawMaterialCode : cm && cm[1];
          const per = def ? def.rawMaterialQtyPerUnit : cm && Number(cm[2]) / 100;
          if (!raw || !per) { unknown.push({ dept, item: key, name: resolveItemName(key), stock }); return; }
          add(raw, stock * per, dept, key, stock); return;
        }
        const mm = base.match(/^(?:SOL|INJ)-(.+)$|^(?:LASER|PACK)-([^-]+)-/);
        const pc = mm && (mm[1] || mm[2]);
        let weights = pc ? wipFormulaWeights(pc) : [];
        if (!weights.length) { unknown.push({ dept, item: key, name: resolveItemName(key), stock }); return; }
        // سهمِ هر فرمول از روی لات‌ها (نوعِ کابلِ معلوم)؛ فقط باقی‌مانده‌ی نامعلوم با تخمین تقسیم می‌شود
        {
          const L = wipLots.lots.get(dept + '|' + key) || [];
          const fksAll = stageFormulaKeys(key);
          const byFk = {}; let knownQ = 0;
          L.forEach(l => { const f = wipLots.batchFk.get(l.batch); if (f && fksAll.includes(f)) { byFk[f] = (byFk[f] || 0) + l.qty; knownQ += l.qty; } });
          if (knownQ > 1e-9) {
            const unk = Math.max(0, stock - knownQ) / stock;
            weights = Object.entries(byFk).map(([fk, q]) => ({ fk, w: Math.min(q, stock) / stock, estimated: false }))
              .concat(unk > 1e-9 ? weights.map(x => ({ fk: x.fk, w: x.w * unk, estimated: x.estimated })) : []);
          }
        }
        if (weights.some(w => w.estimated)) multi.add(pc);
        const per = {};
        weights.forEach(({ fk, w }) => (getFormula(fk).materials || []).forEach(m => {
          const idx = WIP_STAGE_IDX[m.stage];
          if (idx === undefined || idx > S) return;   // موادِ مراحلِ بعد (یا دسته‌بندی‌نشده) هنوز مصرف نشده‌اند
          per[m.code] = (per[m.code] || 0) + w * (m.qty || 0);
        }));
        Object.entries(per).forEach(([code, q]) => add(code, Math.round(stock * q * 1e6) / 1e6, dept, key, stock));
      });
    });
    const list = Object.values(mats).map(m => ({ ...m, total: Math.round(m.total * 1e4) / 1e4,
      byDept: Object.fromEntries(Object.entries(m.byDept).map(([d, q]) => [d, Math.round(q * 1e4) / 1e4])) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fa'));
    return { depts: REPORT_DEPTS.map(id => ({ id, name: deptName(id) })), materials: list, unknown,
      multiFormulaProducts: [...multi].map(pc => ({ code: pc, name: sepidarBaseName(pc, formulaKeysOfProductCode(pc)) })) };
}
app.get('/api/reports/wip-materials', (req, res) => {
  try {
    loadData();
    res.json({ success: true, ...computeWipMaterials() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// مغایرتِ «مواد اولیه‌ی در جریان» با انبارِ مونتاژِ سپیدار (۱۴۰۵/۰۸/۰۲)
// در سپیدار مواد از انبار مواد اولیه (۶) یک‌جا به انبار مونتاژ (۱۶ و …) منتقل می‌شوند و معلوم نیست به کدام بخش رفته‌اند.
// این‌جا همه‌ی موادِ بیرون از انبار مواد اولیه‌ی سیستم (موادِ آزادِ بخش‌ها + موادِ داخلِ کالاهای نیمه‌ساخته طبقِ فرمول،
// همان گزارشِ «مواد اولیه‌ی در جریان») با موجودیِ آن انبارها مقایسه می‌شود. موادِ داخلِ محصولاتِ انبار محصول و خروج‌های
// در راهِ انبار مواد ← بخش‌ها جدا نشان داده می‌شوند تا علتِ اختلاف معلوم باشد. فقط خواندنی.
// ============================================
const ASSEMBLY_STOCKS = [{ ref: 16, title: 'انبار بخش مونتاژ (نیمه ساخته)' }, { ref: 17, title: 'انبار بخش وایر (نیمه ساخته)' }, { ref: 44, title: 'انبار مونتاژ مرکزی' }, { ref: 14, title: 'انبار واسط کابل (نیمه ساخته)' }];
const ASSEMBLY_LINE_DEPTS = ['cut', 'solder', 'inject', 'laser', 'pack', 'qc'];
app.get('/api/sepidar/assembly-reconcile', async (req, res) => {
  try {
    loadData();
    const refs = String(req.query.stocks || '16').split(',').map(Number).filter(r => ASSEMBLY_STOCKS.some(a => a.ref === r));
    if (!refs.length) return res.status(400).json({ success: false, error: 'انباری انتخاب نشده' });
    const fyInfo = await resolveSepidarFiscalYear(parseInt(req.query.year));
    const pool = await connectToSepidar();
    if (!pool) return res.status(500).json({ success: false, error: 'اتصال به سپیدار برقرار نشد' });
    const rng = rangeParams(req);
    if (rng.error) return res.status(400).json({ success: false, error: rng.error });
    const asOf = rng.to && rng.to < todayJalali() ? rng.to : null; // مانده تا «تا تاریخ» (خالی یا امروز = الان)
    const sep = {}, sepBy = {}, title = {}, unitT = {};
    (await sepidarDailyMoves(pool, refs, fyInfo.ref)).forEach(m => {
      if (!m.code || (asOf && m.day > asOf)) return;
      sep[m.code] = (sep[m.code] || 0) + m.q; (sepBy[m.code] = sepBy[m.code] || {})[m.stock] = ((sepBy[m.code] || {})[m.stock] || 0) + m.q;
      title[m.code] = m.title; unitT[m.code] = m.unit;
    });
    Object.keys(sep).forEach(c => { if (Math.abs(sep[c]) < 1e-9) delete sep[c]; });
    const wip = computeWipMaterials(asOf ? inventoryAt(asOf) : null);
    const byCode = {};
    wip.materials.forEach(m => { byCode[m.code] = m; });
    // خروج‌های در راهِ انبار مواد اولیه ← بخش‌ها (در سپیدار ممکن است انتقال ثبت شده باشد)
    const transit = {};
    if (!asOf) docs.forEach(d => { if (d.type === 'output' && d.fromUnit === 'raw' && ASSEMBLY_LINE_DEPTS.includes(d.toUnit) && ['pending', 'pending_warehouse'].includes(d.status) && !isStageKey(d.item)) transit[pvBase(d.item)] = (transit[pvBase(d.item)] || 0) + (Number(d.qty) || 0); });
    const r4 = v => Math.round((v || 0) * 1e4) / 1e4;
    const codes = new Set([...Object.keys(sep), ...wip.materials.filter(m => ASSEMBLY_LINE_DEPTS.concat('finished').some(d => (m.byDept[d] || 0) > 1e-9)).map(m => m.code)]);
    const rows = [...codes].map(code => {
      const m = byCode[code] || { byDept: {}, from: [] };
      const byDept = {}; let line = 0;
      ASSEMBLY_LINE_DEPTS.forEach(d => { if (m.byDept[d]) { byDept[d] = r4(m.byDept[d]); line += m.byDept[d]; } });
      // موادِ داخلِ محصولاتِ انبار محصول هم جزوِ جمعِ سیستم است (در سپیدار تا سند تولید نخورده در انبار مونتاژ می‌ماند)
      const fin = r4(m.byDept.finished || 0);
      if (fin) byDept.finished = fin;
      line = r4(line + fin);
      const s = r4(sep[code] || 0), tr = r4(transit[code] || 0);
      const diff = r4(line - s);
      const tol = Math.max(0.01, Math.abs(s) * 0.0005);
      const status = Math.abs(diff) <= tol ? 'ok' : (!s ? 'only_local' : (!line ? 'only_sepidar' : 'diff'));
      return { code, name: m.name || title[code] || resolveItemName(code), unit: m.unit || unitT[code] || '', sepidar: s, sepidarBy: sepBy[code] || {}, line, byDept, finished: fin, transit: tr, diff,
        diffWithTransit: r4(line + tr - s), status,
        from: (m.from || []).filter(f => ASSEMBLY_LINE_DEPTS.includes(f.dept) || f.dept === 'finished').sort((a, b) => b.qty - a.qty).slice(0, 12).map(f => ({ dept: deptName(f.dept), name: f.name, stock: f.stock, qty: r4(f.qty) })) };
    }).sort((a, b) => (a.status === 'ok') - (b.status === 'ok') || Math.abs(b.diff) - Math.abs(a.diff));
    res.json({ success: true, asOf, fiscalYear: fyInfo.ref, checkedAt: new Date().toISOString(), stocks: ASSEMBLY_STOCKS.filter(a => refs.includes(a.ref)),
      depts: ASSEMBLY_LINE_DEPTS.concat('finished').map(id => ({ id, name: deptName(id) })), rows, okCount: rows.filter(x => x.status === 'ok').length,
      unknown: wip.unknown.filter(u => ASSEMBLY_LINE_DEPTS.includes(u.dept) || u.dept === 'finished'), multiFormulaProducts: wip.multiFormulaProducts });
  } catch (err) {
    console.error('assembly reconcile:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/production', (req, res) => {
  try {
    loadData();
    const period = ['today', '7d', 'month', 'fy'].includes(req.query.period) ? req.query.period : 'today';
    const now = new Date();
    const todayK = jalaliKeyOf(now);
    let fromK = todayK, label = 'امروز';
    if (period === '7d') { fromK = jalaliKeyOf(new Date(now.getTime() - 6 * 86400000)); label = '۷ روز اخیر'; }
    else if (period === 'month') { fromK = Math.floor(todayK / 100) * 100 + 1; label = 'ماه جاری'; }
    else if (period === 'fy') {
      const fy = fiscalYears.find(f => f.year === activeFiscalYear) || fiscalYears[0];
      fromK = (fy && faKey(fy.startDate)) || (Math.floor(todayK / 10000) * 10000 + 101); label = `سال مالی ${fy ? fy.year : ''}`;
    }
    const inPeriod = t => { const k = faKey(t.date); return k !== null && k >= fromK && k <= todayK; };
    // سریِ ۱۴ روزِ اخیر برای نمودارِ ساده
    const dayKeys = [];
    for (let i = 13; i >= 0; i--) dayKeys.push(jalaliKeyOf(new Date(now.getTime() - i * 86400000)));

    const depts = STAGE_DEPTS.map(unit => {
      const prod = transactions.filter(t => t.unit === unit && t.type === 'production');
      const waste = transactions.filter(t => t.unit === unit && t.type === 'waste');
      const pIn = prod.filter(inPeriod), wIn = waste.filter(inPeriod);
      const sum = arr => Math.round(arr.reduce((s, t) => s + (t.qty || 0), 0) * 1000) / 1000;
      const producedQty = sum(pIn), wasteQty = sum(wIn);
      const items = {};
      pIn.forEach(t => { (items[t.item] = items[t.item] || { item: t.item, produced: 0, waste: 0 }).produced += t.qty; });
      wIn.forEach(t => { (items[t.item] = items[t.item] || { item: t.item, produced: 0, waste: 0 }).waste += t.qty; });
      const topItems = Object.values(items).map(x => ({
        item: x.item, name: resolveItemName(x.item), produced: Math.round(x.produced * 1000) / 1000, waste: Math.round(x.waste * 1000) / 1000,
        wastePct: x.produced > 0 ? Math.round(x.waste / x.produced * 1000) / 10 : null
      })).sort((a, b) => b.produced - a.produced).slice(0, 8);
      // هدف: اگه هدفِ سطحِ بخش (بدون کالا) باشه همان؛ وگرنه جمعِ هدف‌های کالایی که با بازه هم‌پوشانی دارند
      const overlap = productionTargets.filter(t => t.unit === unit && faKey(t.endDate) >= fromK && faKey(t.startDate) <= todayK);
      const deptLevel = overlap.filter(t => !t.item);
      const targetQty = (deptLevel.length ? deptLevel : overlap).reduce((s, t) => s + t.qty, 0);
      return {
        unit, name: deptName(unit),
        produced: { count: pIn.length, qty: producedQty },
        waste: { count: wIn.length, qty: wasteQty },
        // «تقریبی»: واحدهای مختلفِ کالاها با هم جمع شده‌اند؛ جزئیاتِ دقیق در topItems است
        wastePct: producedQty > 0 ? Math.round(wasteQty / producedQty * 1000) / 10 : null,
        yieldPct: (producedQty + wasteQty) > 0 ? Math.round(producedQty / (producedQty + wasteQty) * 1000) / 10 : null,
        target: targetQty > 0 ? { qty: targetQty, pct: Math.round(producedQty / targetQty * 1000) / 10 } : null,
        topItems,
        series: dayKeys.map(k => ({ date: keyToFa(k), qty: Math.round(prod.filter(t => faKey(t.date) === k).reduce((s, t) => s + (t.qty || 0), 0) * 1000) / 1000 }))
      };
    });
    res.json({
      success: true, period, label, from: keyToFa(fromK), to: keyToFa(todayK), depts,
      totals: { produced: depts.reduce((s, d) => s + d.produced.qty, 0), waste: depts.reduce((s, d) => s + d.waste.qty, 0), docs: depts.reduce((s, d) => s + d.produced.count, 0) },
      minStockAlerts: computeMinStockAlerts().length,
      hasTargets: productionTargets.length > 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// ===== لاگ فعالیت =====
// ============================================
function logActivity(username, action, details) {
  // شناسه از بزرگ‌ترین id موجود ادامه پیدا می‌کنه - قبلاً یه شمارنده‌ی درون‌حافظه‌ای بود که با هر
  // ری‌استارتِ سرور از ۱ شروع می‌شد و idهای تکراری می‌ساخت (۲۱۹ رکورد با فقط ۴۶ id متمایز).
  const nextId = activityLog.reduce((max, e) => Math.max(max, e.id || 0), 0) + 1;
  activityLog.push({
    id: nextId,
    timestamp: new Date().toISOString(),
    username: username || 'نامشخص',
    action,
    details: details || ''
  });
  // فقط ۲۰۰۰ رکورد اخیر نگه داشته می‌شه تا db.json نامحدود بزرگ نشه
  if (activityLog.length > 2000) activityLog = activityLog.slice(activityLog.length - 2000);
  saveData();
}

app.post('/api/activity/login', (req, res) => {
  try {
    loadData();
    const { username } = req.body;
    const user = users.find(u => u.username === username);
    logActivity(username, 'ورود به سیستم', user ? `${user.fullname} (${user.unit})` : '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/activity-log', (req, res) => {
  loadData();
  const limit = parseInt(req.query.limit, 10) || 500;
  const list = activityLog.slice().reverse().slice(0, limit);
  res.json({ success: true, log: list });
});

// برای اکشن‌هایی که از قبل مسیر اختصاصیِ سرور ندارن (مثلاً CRUD کاربر/سال مالی که از طریق
// ذخیره‌ی عمومیِ POST /api/data انجام می‌شن) - کلاینت بعد از موفقیتِ عملیات، مستقیم همین
// endpoint رو برای ثبت در لاگ صدا می‌زنه.
app.post('/api/activity/log', (req, res) => {
  try {
    loadData();
    const { actorUsername, action, details } = req.body;
    if (!action) return res.status(400).json({ success: false, error: 'عنوان عملیات الزامی است' });
    logActivity(actorUsername, action, details);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// ===== تنظیمات (اتصال سپیدار / پورت / بکاپ / دسترسی نقش‌ها) =====
// ============================================

app.get('/api/settings/sepidar', (req, res) => {
  loadData();
  if (!req.authUser || req.authUser.role !== 'admin') return res.status(403).json({ success: false, error: 'فقط مدیر' });
  const cfg = (appSettings && appSettings.sepidar) || DEFAULT_SEPIDAR_CONFIG;
  res.json({ success: true, sepidar: cfg });
});

app.post('/api/settings/sepidar', (req, res) => {
  try {
    loadData();
    const { user, password, server, database, encrypt, trustServerCertificate } = req.body;
    if (!user || !password || !server || !database) {
      return res.status(400).json({ success: false, error: 'همه‌ی فیلدهای اتصال (کاربر/رمز/سرور/دیتابیس) الزامی است' });
    }
    appSettings.sepidar = { user, password, server, database, encrypt: !!encrypt, trustServerCertificate: !!trustServerCertificate };
    saveData();
    sepidarPool = null; // پول کش‌شده با تنظیمات قدیمی دیگه معتبر نیست
    logActivity(req.body.actorUsername, 'تغییر تنظیمات اتصال سپیدار', `سرور: ${server}, دیتابیس: ${database}`);
    res.json({ success: true, message: 'تنظیمات اتصال سپیدار ذخیره شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// اتصال آزمایشی با مقادیر ارسالی (نه لزوماً چیزی که قبلاً ذخیره شده) - چیزی ذخیره نمی‌کنه،
// فقط برای دکمه‌ی «تست اتصال» قبل از ذخیره‌ی نهایی.
app.post('/api/settings/sepidar/test', async (req, res) => {
  const { user, password, server, database, encrypt, trustServerCertificate } = req.body;
  if (!user || !password || !server || !database) {
    return res.status(400).json({ success: false, error: 'همه‌ی فیلدهای اتصال الزامی است' });
  }
  let testPool = null;
  try {
    testPool = await sql.connect({
      user, password, server, database,
      options: { encrypt: !!encrypt, trustServerCertificate: !!trustServerCertificate },
      connectionTimeout: 15000,
      requestTimeout: 15000
    });
    await testPool.request().query('SELECT 1');
    res.json({ success: true, message: '✅ اتصال با موفقیت برقرار شد' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  } finally {
    if (testPool) {
      try { await testPool.close(); } catch (e) {}
    }
  }
});

app.get('/api/settings/output-messenger', (req, res) => {
  loadData();
  if (!req.authUser || req.authUser.role !== 'admin') return res.status(403).json({ success: false, error: 'فقط مدیر' });
  res.json({ success: true, outputMessenger: getOutputMessengerConfig(), depts: DEPTS });
});

app.post('/api/settings/output-messenger', (req, res) => {
  try {
    loadData();
    const { enabled, host, port, apiKey, fromUser, deptGroups, actorUsername } = req.body;
    if (enabled && (!host || !port || !apiKey)) {
      return res.status(400).json({ success: false, error: 'برای فعال‌سازی، آدرس سرور/پورت/API-KEY الزامی است' });
    }
    appSettings.outputMessenger = {
      enabled: !!enabled,
      host: host || '',
      port: parseInt(port, 10) || 0,
      apiKey: apiKey || '',
      fromUser: fromUser || '',
      deptGroups: (deptGroups && typeof deptGroups === 'object') ? deptGroups : {}
    };
    saveData();
    logActivity(actorUsername, 'تغییر تنظیمات Output Messenger', `فعال: ${enabled ? 'بله' : 'خیر'}, سرور: ${host}:${port}`);
    res.json({ success: true, message: 'تنظیمات Output Messenger ذخیره شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// پیامِ آزمایشی با مقادیرِ ارسالی (نه لزوماً چیزی که قبلاً ذخیره شده) - برای دکمه‌ی «تست
// اتصال» قبل از ذخیره‌ی نهایی. چیزی رو دائمی ذخیره نمی‌کنه.
app.post('/api/settings/output-messenger/test', async (req, res) => {
  const { host, port, apiKey, room, fromUser } = req.body;
  if (!host || !port || !apiKey || !room) {
    return res.status(400).json({ success: false, error: 'آدرس سرور/پورت/API-KEY/نام گروه همه الزامی هستند' });
  }
  const query = new URLSearchParams({ room, message: '✅ پیام آزمایشی از سیستم مدیریت تولید', notify: '1' });
  if (fromUser) query.set('from', fromUser);
  const options = {
    hostname: host,
    port: parseInt(port, 10),
    path: `/api/notify?${query.toString()}`,
    method: 'POST',
    headers: { 'API-KEY': apiKey, 'Content-Length': 0 },
    timeout: 8000
  };
  const httpReq = http.request(options, (httpRes) => {
    let body = '';
    httpRes.on('data', chunk => { body += chunk; });
    httpRes.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.success) res.json({ success: true, message: `✅ پیام آزمایشی به گروه «${room}» ارسال شد` });
        else res.status(400).json({ success: false, error: parsed.message || 'Output Messenger پاسخ ناموفق داد' });
      } catch (e) {
        res.status(500).json({ success: false, error: 'پاسخ نامعتبر از سرور Output Messenger' });
      }
    });
  });
  httpReq.on('timeout', () => { httpReq.destroy(); res.status(504).json({ success: false, error: 'اتصال به Output Messenger زمان‌گیر شد (timeout)' }); });
  httpReq.on('error', (err) => res.status(500).json({ success: false, error: err.message }));
  httpReq.end();
});

app.get('/api/settings/warehouse-gate', (req, res) => {
  loadData();
  const cfg = (appSettings && appSettings.warehouseGate) || DEFAULT_WAREHOUSE_GATE_CONFIG;
  res.json({ success: true, warehouseGate: cfg, depts: DEPTS });
});

app.post('/api/settings/warehouse-gate', (req, res) => {
  try {
    loadData();
    const { pairs, actorUsername } = req.body;
    if (!Array.isArray(pairs)) {
      return res.status(400).json({ success: false, error: 'فرمت لیست جفت‌بخش‌ها نامعتبر است' });
    }
    // هر جفت رو دوباره نرمالایز می‌کنیم (نه صرفاً اعتماد به چیزی که کلاینت فرستاده) تا
    // همیشه یه فرمتِ یکسان (الفبایی، با |) ذخیره بشه، مهم نیست کلاینت چه ترتیبی فرستاده.
    const normalized = [...new Set(pairs
      .map(p => (typeof p === 'string' ? p.split('|') : p))
      .filter(p => Array.isArray(p) && p.length === 2 && DEPTS.some(d => d.id === p[0]) && DEPTS.some(d => d.id === p[1]))
      .map(([a, b]) => warehouseGatePairKey(a, b)))];
    appSettings.warehouseGate = { pairs: normalized };
    saveData();
    logActivity(actorUsername, 'تغییر تنظیمات تاییدِ انباردار برای خروج بین بخش‌ها', `تعداد جفت‌بخش‌های فعال: ${normalized.length}`);
    res.json({ success: true, message: 'تنظیمات ذخیره شد', pairs: normalized });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/port', (req, res) => {
  try {
    loadData();
    const port = parseInt(req.body.appPort, 10);
    if (!port || port < 1 || port > 65535) {
      return res.status(400).json({ success: false, error: 'شماره پورت نامعتبر است' });
    }
    appSettings.appPort = port;
    saveData();
    logActivity(req.body.actorUsername, 'تغییر پورت اپ', `پورت جدید: ${port}`);
    res.json({ success: true, message: `پورت روی ${port} ذخیره شد - برای اعمال، سرور را ری‌استارت کنید` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const SETTINGS_MANAGED_SECTIONS = [
  'sec-dashboard', 'sec-daily-report', 'sec-cardex', 'sec-summary',
  'sec-production', 'sec-consume', 'sec-output', 'sec-waste', 'sec-adjust',
  'sec-documents', 'sec-history', 'sec-initial-inv',
  'sec-stock-check', 'sec-sepidar-inbox', 'sec-stock-count', 'sec-forecast', 'sec-home', 'sec-dispatch', 'sec-finished-in'
];
// مجوزهای غیر-section که از همین ماتریس تنظیم می‌شن
const SETTINGS_MANAGED_PERMISSIONS = [PERM_APPROVE_ADJUSTMENTS, 'perm-dispatch-issue'];

app.get('/api/settings/role-permissions', (req, res) => {
  loadData();
  res.json({ success: true, rolePermissions: appSettings.rolePermissions, sections: SETTINGS_MANAGED_SECTIONS, permissions: SETTINGS_MANAGED_PERMISSIONS });
});

app.post('/api/settings/role-permissions', (req, res) => {
  try {
    loadData();
    const { rolePermissions, actorUsername } = req.body;
    if (!rolePermissions || typeof rolePermissions !== 'object') {
      return res.status(400).json({ success: false, error: 'داده‌ی مجوزها نامعتبر است' });
    }
    ['supervisor', 'warehouse', 'user', 'viewer'].forEach(role => {
      if (Array.isArray(rolePermissions[role])) {
        appSettings.rolePermissions[role] = rolePermissions[role].filter(s => role === 'viewer' ? VIEWER_SECTIONS_OK.has(s) : (SETTINGS_MANAGED_SECTIONS.includes(s) || SETTINGS_MANAGED_PERMISSIONS.includes(s)));
      }
    });
    saveData();
    logActivity(actorUsername, 'تغییر دسترسی نقش‌ها', JSON.stringify(appSettings.rolePermissions));
    res.json({ success: true, message: 'ماتریس دسترسی نقش‌ها ذخیره شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// API های Web Push (نوتیفیکیشن واقعیِ گوشی برای نسخه موبایل)
// ============================================
app.get('/api/push/vapid-public-key', (req, res) => {
  loadData();
  ensurePushKeys();
  res.json({ success: true, publicKey: appSettings.push.publicKey });
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { username, subscription, test } = req.body;
    const platform = req.body.platform === 'desktop' ? 'desktop' : 'mobile';
    if (!username || !subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ success: false, error: 'اطلاعات اشتراک ناقص است' });
    }
    loadData();
    // یه endpoint فقط باید یه‌بار ثبت باشه (اگه کاربر قبلاً همین دستگاه رو ثبت کرده، جایگزین می‌شه)
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
    pushSubscriptions.push({
      id: Date.now(),
      username,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      platform,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      createdAt: new Date().toISOString()
    });
    saveData();
    // ارسال آزمایشی فقط به همین دستگاه (مثل سامانه داخلی) تا کاربر همان لحظه ببیند کار می‌کند
    let testSent = 0;
    if (test) {
      try {
        ensurePushKeys();
        const cfg = appSettings.push;
        webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
        await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify({
          title: '✅ اعلان فعال شد',
          body: 'از این پس اعلان سندهای منتظر تایید حتی با بسته بودن برنامه نمایش داده می‌شود.',
          url: platform === 'desktop' ? '/' : '/mobile/',
          tag: 'wh-test'
        }), { TTL: 600 });
        testSent = 1;
      } catch (err) {
        console.error('⚠️ ارسال آزمایشی Web Push ناموفق:', err.statusCode || '', err.message);
      }
    }
    res.json({ success: true, testSent, message: 'نوتیفیکیشن این دستگاه فعال شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    loadData();
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
    saveData();
    res.json({ success: true, message: 'نوتیفیکیشن این دستگاه غیرفعال شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function getBackupSettings() {
  return { ...DEFAULT_BACKUP_SETTINGS, ...((appSettings && appSettings.backup) || {}) };
}

function resolveBackupFolder() {
  const cfg = getBackupSettings();
  return cfg.folder ? path.resolve(cfg.folder) : path.join(__dirname, 'backups');
}

// همه‌ی عملیاتِ تغییردهنده‌ی بکاپ فقط برای مدیر (قبلاً هر درخواستی در شبکه می‌توانست کل داده را با یک بکاپ
// قدیمی عوض یا بکاپ‌ها را پاک کند). نام کاربر از بدنه یا querystring خوانده می‌شود.
function backupAdmin(req) {
  loadData();
  const name = (req.body && req.body.actorUsername) || (req.query && req.query.actorUsername);
  return inboxActor(name, ['admin']);
}
function backupActor(req) { return (req.authUser && req.authUser.username) || (req.body && req.body.actorUsername) || (req.query && req.query.actorUsername) || null; }
const BACKUP_ADMIN_ERROR = { success: false, error: 'فقط مدیر می‌تواند بکاپ‌ها را مدیریت کند' };

app.get('/api/backup/settings', (req, res) => {
  loadData();
  const cfg = getBackupSettings();
  const last = latestBackupTime();
  res.json({ success: true, ...cfg, resolvedFolder: resolveBackupFolder(), lastAutoAt: last ? new Date(last).toISOString() : null,
    nextAutoAt: cfg.autoEnabled ? new Date(Math.max(Date.now() + 60000, (last || 0) + Math.max(cfg.autoIntervalHours, 0.5) * 3600000)).toISOString() : null });
});

app.post('/api/backup/settings', (req, res) => {
  try {
    if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
    const { folder, autoEnabled, autoIntervalHours, keepCount } = req.body;
    const targetFolder = folder ? path.resolve(folder) : path.join(__dirname, 'backups');
    // قبل از قبول‌کردن، مطمئن می‌شیم پوشه واقعاً قابل‌نوشتنه (می‌سازیمش اگه نیست + یه
    // فایل تستِ کوچیک می‌نویسیم/پاک می‌کنیم) - وگرنه بعداً موقع خودِ بکاپ‌گیری ساکت شکست می‌خوره.
    try {
      fs.mkdirSync(targetFolder, { recursive: true });
      const testFile = path.join(targetFolder, `.write-test-${Date.now()}`);
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (fsErr) {
      return res.status(400).json({ success: false, error: `پوشه‌ی بکاپ قابل‌نوشتن نیست: ${fsErr.message}` });
    }
    appSettings.backup = {
      folder: folder || '',
      autoEnabled: !!autoEnabled,
      autoIntervalHours: parseFloat(autoIntervalHours) || 24,
      keepCount: parseInt(keepCount, 10) || 30
    };
    saveData();
    rearmAutoBackup();
    logActivity(req.body.actorUsername, 'تغییر تنظیمات بکاپ', `پوشه: ${targetFolder}, خودکار: ${!!autoEnabled}`);
    res.json({ success: true, message: 'تنظیمات بکاپ ذخیره شد', resolvedFolder: targetFolder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// دقیقاً همون آبجکتی که saveData() می‌نویسه رو به فایل می‌بره - برخلاف بکاپ قدیمیِ سمت
// کلاینت که فیلدهاش دستی لیست شده بودن و با هر فیلد جدیدِ داده (مثلاً bomFormulas) از قلم
// می‌افتادن، این‌جا چون از خودِ data استفاده می‌کنیم هیچ‌وقت این باگ تکرار نمی‌شه.
// توضیح/نوعِ هر بکاپ در فایلِ کناری backups-meta.json (در همان پوشه‌ی بکاپ): { filename: { kind, note, by, at } }
// kind: auto | manual | pre-restore. بکاپ‌های قدیمیِ بدونِ توضیح «نامشخص» نشان داده می‌شوند.
function backupMetaPath() { return path.join(resolveBackupFolder(), 'backups-meta.json'); }
function readBackupMeta() { try { return JSON.parse(fs.readFileSync(backupMetaPath(), 'utf8')) || {}; } catch (e) { return {}; } }
function writeBackupMeta(m) { try { fs.writeFileSync(backupMetaPath(), JSON.stringify(m, null, 2), 'utf8'); } catch (e) { console.error('backup meta:', e.message); } }
function createBackupFile(kind, note, by) {
  loadData();
  saveData(); // مطمئن می‌شیم globalهای در حافظه قبل از بکاپ روی دیسک sync ان
  const folder = resolveBackupFolder();
  fs.mkdirSync(folder, { recursive: true });
  const now = new Date();
  // نامِ فایل به وقتِ ایران (قبلاً UTC بود و ساعت‌ها ۳:۳۰ با ساعتِ ایران فرق داشت)
  const tp = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  const stamp = `${tp.year}-${tp.month}-${tp.day}_${tp.hour}-${tp.minute}-${tp.second}`;
  // نامِ تکراری (دو بکاپ در یک ثانیه، مثلاً بکاپِ ایمنیِ قبل از بازیابی) فایلِ قبلی را بازنویسی نکند
  let filename = `backup_${stamp}.json`;
  for (let n = 2; fs.existsSync(path.join(folder, filename)); n++) filename = `backup_${stamp}-${n}.json`;
  const filePath = path.join(folder, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  const meta = readBackupMeta();
  meta[filename] = { kind: kind || 'manual', note: String(note || '').slice(0, 300), by: by || null, at: now.toISOString() };

  // فقط N تای اخیرِ بکاپ‌های خودکار/قبل‌ازبازیابی (و قدیمی‌های بی‌توضیح) نگه داشته می‌شن؛ بکاپِ دستی (با توضیح) پاک نمی‌شود.
  const keepCount = getBackupSettings().keepCount;
  const files = fs.readdirSync(folder)
    .filter(f => /^backup_[\w-]+\.json$/.test(f) && !(meta[f] && meta[f].kind === 'manual'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(folder, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(keepCount).forEach(f => {
    try { fs.unlinkSync(path.join(folder, f.name)); delete meta[f.name]; } catch (e) {}
  });
  writeBackupMeta(meta);

  return { filename, folder };
}

// زمانِ جدیدترین بکاپِ «خودکار» (۰ اگه نباشه). قبلاً هر بکاپی (دستی، قبل از بازیابی، …) شمارنده را صفر می‌کرد
// و چون روزهای کاری چند بکاپِ دستی گرفته می‌شد، بکاپِ خودکار عملاً هیچ‌وقت نوبتش نمی‌رسید.
function latestBackupTime() {
  try {
    const folder = resolveBackupFolder(), meta = readBackupMeta();
    const times = fs.readdirSync(folder)
      .filter(f => /^backup_[\w-]+\.json$/.test(f) && meta[f] && meta[f].kind === 'auto')
      .map(f => fs.statSync(path.join(folder, f)).mtimeMs);
    return times.length ? Math.max(...times) : 0;
  } catch (e) {
    return 0;
  }
}

// بکاپِ خودکار «بر اساس زمانِ آخرین بکاپِ واقعی» انجام می‌شه، نه یک تایمرِ ۲۴ساعته‌ی بعد از بالا اومدنِ سرور.
// قبلاً هر ری‌استارتِ سرویس شمارنده‌ی ۲۴ ساعته رو از نو شروع می‌کرد؛ پس اگه سرویس چند بار در روز ری‌استارت
// می‌شد (آپدیت، خاموش/روشنِ سرور) هیچ‌وقت نوبتِ بکاپ نمی‌رسید (بکاپِ ۱۴۰۵/۰۷/۱۲ همین‌طور از قلم افتاد).
// حالا هر ۱۰ دقیقه چک می‌شه و اگه از آخرین بکاپ بیشتر از بازه گذشته باشه همان لحظه بکاپ گرفته می‌شه، و
// یک چکِ اضافه هم ۱ دقیقه بعد از بالا آمدنِ سرور انجام می‌شه.
function autoBackupIfDue() {
  const cfg = getBackupSettings();
  if (!cfg.autoEnabled) return;
  const intervalMs = Math.max(cfg.autoIntervalHours, 0.5) * 60 * 60 * 1000;
  if (Date.now() - latestBackupTime() < intervalMs) return;
  try {
    const result = createBackupFile('auto', 'بکاپ خودکار');
    console.log(`🕐 بکاپ خودکار گرفته شد: ${result.filename}`);
  } catch (err) {
    console.error('❌ خطا در بکاپ خودکار:', err.message);
  }
}

function rearmAutoBackup() {
  if (autoBackupTimer) { clearInterval(autoBackupTimer); autoBackupTimer = null; }
  if (autoBackupStartupTimer) { clearTimeout(autoBackupStartupTimer); autoBackupStartupTimer = null; }
  const cfg = getBackupSettings();
  if (!cfg.autoEnabled) return;
  autoBackupTimer = setInterval(autoBackupIfDue, 10 * 60 * 1000);
  autoBackupStartupTimer = setTimeout(autoBackupIfDue, 60 * 1000);
}

app.post('/api/backup/create', (req, res) => {
  try {
    if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
    const result = createBackupFile('manual', req.body && req.body.note, backupActor(req));
    logActivity(backupActor(req), 'بکاپ دستی', `${result.filename}${req.body && req.body.note ? ' - ' + String(req.body.note).slice(0, 200) : ''}`);
    res.json({ success: true, message: `بکاپ ساخته شد: ${result.filename}`, filename: result.filename });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/backup/list', (req, res) => {
  try {
    const folder = resolveBackupFolder();
    if (!fs.existsSync(folder)) return res.json({ success: true, backups: [] });
    const meta = readBackupMeta();
    const backups = fs.readdirSync(folder)
      .filter(f => /^backup_[\w-]+\.json$/.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(folder, f));
        const m = meta[f] || {};
        return { filename: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind: m.kind || null, note: m.note || '', by: m.by || null };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, backups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function safeBackupFilePath(filename) {
  if (!/^backup_[\w-]+\.json$/.test(filename)) return null;
  const folder = resolveBackupFolder();
  const filePath = path.join(folder, filename);
  if (path.dirname(filePath) !== folder) return null; // محافظ در برابر path traversal
  return filePath;
}

app.get('/api/backup/download/:filename', (req, res) => {
  const filePath = safeBackupFilePath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'فایل بکاپ یافت نشد' });
  }
  res.download(filePath);
});

// پیش‌نمایشِ بازیابی: چه اسنادی از دست می‌روند (در وضعِ فعلی هست، در بکاپ نیست) - قبل از تایید به مدیر نشان داده می‌شود
app.get('/api/backup/preview/:filename', (req, res) => {
  try {
    if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
    const filePath = safeBackupFilePath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'فایل بکاپ یافت نشد' });
    loadData();
    const b = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const ids = new Set((b.docs || []).map(d => d.id));
    const lost = docs.filter(d => !ids.has(d.id));
    const last = (b.docs || []).reduce((m, d) => (d.createdAt && d.createdAt > m ? d.createdAt : m), '');
    res.json({ success: true, docsInBackup: (b.docs || []).length, docsNow: docs.length, lostCount: lost.length,
      lost: lost.slice(-15).map(d => ({ id: d.id, type: d.type, date: d.date, item: resolveItemName(d.item), qty: d.qty, createdBy: d.createdBy })), lastDocAt: last });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backup/restore/:filename', (req, res) => {
  try {
    const filePath = safeBackupFilePath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'فایل بکاپ یافت نشد' });
    }
    if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
    const restored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(restored.items) || !Array.isArray(restored.users)) {
      return res.status(400).json({ success: false, error: 'فایل بکاپ نامعتبر است' });
    }
    const safety = createBackupFile('pre-restore', `وضعِ قبل از بازیابیِ ${req.params.filename}`, backupActor(req)); // وضعِ فعلی قبل از بازیابی، تا اشتباه قابل‌برگشت باشد
    applyLoadedData(restored);
    saveData();
    logActivity(req.query.actorUsername || (req.body && req.body.actorUsername), 'بازیابی از بکاپ', `${req.params.filename} (بکاپِ وضعِ قبلی: ${safety.filename})`);
    res.json({ success: true, safetyBackup: safety.filename, message: `داده‌ها از بکاپ بازیابی شدند. وضعِ قبلی در ${safety.filename} ذخیره شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// بازیابی از فایلی که کاربر از کامپیوتر خودش انتخاب می‌کند (قبلاً کلاینت آن را با POST /api/data می‌فرستاد
// که سرور فقط «تعریف محصولات»ش را برمی‌داشت؛ پیام موفقیت می‌آمد ولی بقیه‌ی داده بازیابی نمی‌شد).
// کلیدهایی که در فایل نیستند (مثلاً تنظیمات در فایل‌های قدیمیِ «دریافت بکاپ به فایل») از وضعِ فعلی حفظ می‌شوند.
app.post('/api/backup/restore-upload', (req, res) => {
  try {
    if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
    const restored = req.body && req.body.backup;
    if (!restored || typeof restored !== 'object' || !Array.isArray(restored.items) || !Array.isArray(restored.users)) {
      return res.status(400).json({ success: false, error: 'فایل بکاپ نامعتبر است' });
    }
    const safety = createBackupFile('pre-restore', `وضعِ قبل از بازیابی از فایلِ ${String(req.body.fileName || '').slice(0, 80)}`, backupActor(req));
    const current = JSON.parse(JSON.stringify(data));
    const merged = { ...current };
    Object.keys(getDefaultData()).forEach(k => { if (restored[k] !== undefined) merged[k] = restored[k]; });
    const kept = Object.keys(getDefaultData()).filter(k => restored[k] === undefined);
    applyLoadedData(merged);
    saveData();
    logActivity(req.body.actorUsername, 'بازیابی از فایل', `${String(req.body.fileName || 'فایل').slice(0, 80)} - بکاپِ وضعِ قبلی: ${safety.filename}${kept.length ? ' - بخش‌هایی که در فایل نبود و دست نخورد: ' + kept.join(', ') : ''}`);
    res.json({ success: true, safetyBackup: safety.filename, keptFromCurrent: kept, message: `بازیابی انجام شد. وضعِ قبلی در ${safety.filename} ذخیره شد` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ویرایشِ توضیحِ یک بکاپ
app.post('/api/backup/note/:filename', (req, res) => {
  if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
  const filePath = safeBackupFilePath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'فایل بکاپ یافت نشد' });
  const m = readBackupMeta();
  m[req.params.filename] = { ...(m[req.params.filename] || { kind: null, at: fs.statSync(filePath).mtime.toISOString() }), note: String((req.body && req.body.note) || '').slice(0, 300), noteBy: backupActor(req) };
  writeBackupMeta(m);
  res.json({ success: true, message: 'توضیح ذخیره شد' });
});
app.delete('/api/backup/:filename', (req, res) => {
  if (!backupAdmin(req)) return res.status(403).json(BACKUP_ADMIN_ERROR);
  const filePath = safeBackupFilePath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'فایل بکاپ یافت نشد' });
  }
  try {
    fs.unlinkSync(filePath);
    { const m = readBackupMeta(); if (m[req.params.filename]) { delete m[req.params.filename]; writeBackupMeta(m); } }
    logActivity(req.query.actorUsername, 'حذف بکاپ', req.params.filename);
    res.json({ success: true, message: 'بکاپ حذف شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ⚠️ عملیاتِ کاملاً مخرب و غیرقابل‌برگشت (به‌جز از طریق بکاپ) - فقط برای مدیر. اسناد/
// تراکنش‌ها/موجودی‌اول‌دورهٔ یک سال مالی رو کامل حذف می‌کنه و موجودیِ همهٔ بخش‌ها رو صفر
// می‌کنه (چون خودِ inventory سال مالی نداره تا فقط همون سال ازش پاک بشه).
app.post('/api/admin/clear-fiscal-year-data', (req, res) => {
  try {
    const { fiscalYear, actorUsername } = req.body;

    loadData();

    const actor = users.find(u => u.username === actorUsername);
    if (!actor || actor.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'فقط مدیر می‌تواند این عملیات را انجام دهد' });
    }
    if (!fiscalYear) {
      return res.status(400).json({ success: false, error: 'سال مالی مشخص نشده است' });
    }

    const docsBefore = docs.length;
    const txBefore = transactions.length;
    const initBefore = initialInventory.length;

    docs = docs.filter(d => d.fiscalYear !== fiscalYear);
    transactions = transactions.filter(t => t.fiscalYear !== fiscalYear);
    initialInventory = initialInventory.filter(t => t.fiscalYear !== fiscalYear);

    let itemsZeroed = 0;
    Object.keys(inventory).forEach(deptId => {
      Object.keys(inventory[deptId] || {}).forEach(code => {
        if (inventory[deptId][code] !== 0) itemsZeroed++;
        inventory[deptId][code] = 0;
      });
    });

    saveData();

    const docsDeleted = docsBefore - docs.length;
    const txDeleted = txBefore - transactions.length;
    const initDeleted = initBefore - initialInventory.length;

    logActivity(actorUsername, '⚠️ پاک‌سازی کامل سال مالی', `سال مالی: ${fiscalYear} - ${docsDeleted} سند، ${txDeleted} تراکنش، ${initDeleted} ردیف موجودی اول دوره حذف شد، موجودی همه‌ی بخش‌ها صفر شد (${itemsZeroed} قلم)`);

    res.json({
      success: true,
      docsDeleted, txDeleted, initDeleted, itemsZeroed,
      message: `سال مالی ${fiscalYear} کامل پاک شد: ${docsDeleted} سند، ${txDeleted} تراکنش، ${initDeleted} ردیف موجودی اول دوره حذف شد و موجودی همه‌ی بخش‌ها صفر شد`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// گواهیِ CAِ محلی (فقط بخشِ عمومی - نه کلید خصوصی) برای نصب/تاییدِ یک‌باره روی هر گوشی؛
// همیشه از روی HTTPِ معمولی هم در دسترسه چون قبل از نصبِ همین گواهی، خودِ HTTPS هنوز روی
// گوشی معتبر شناخته نمی‌شه. ساخته می‌شه توسط generate-https-cert.js (npm run https-cert).
// گواهی HTTPS: اولویت با گواهیِ «سامانه داخلی» (همان IP 192.168.0.16) است که روی همهٔ دستگاه‌ها از قبل
// مورد اعتماد است؛ گواهی‌ها به پورت وابسته نیستند، پس همان گواهی برای پورت ۳۴۴۳ هم معتبر است و
// نیازی به نصب گواهی جدید روی دستگاه‌ها نیست. اگر نبود، گواهیِ ساخت generate-https-cert.js استفاده می‌شود.
const SHARED_CERT_DIR = process.env.SHARED_CERT_DIR || 'C:\\dastoor-pardakht\\app\\certs';
function resolveHttpsCertFiles() {
  const shared = { key: path.join(SHARED_CERT_DIR, 'dastoor.key'), cert: path.join(SHARED_CERT_DIR, 'dastoor.crt'), ca: path.join(SHARED_CERT_DIR, 'dastoor.crt'), source: 'سامانه داخلی' };
  if (fs.existsSync(shared.key) && fs.existsSync(shared.cert)) return shared;
  return {
    key: path.join(__dirname, 'certs', 'server-key.pem'),
    cert: path.join(__dirname, 'certs', 'server-cert.pem'),
    ca: path.join(__dirname, 'certs', 'ca-cert.pem'),
    source: 'certs/ مدیریت تولید'
  };
}

app.get('/ca.crt', (req, res) => {
  const caPath = resolveHttpsCertFiles().ca;
  if (!fs.existsSync(caPath)) {
    return res.status(404).send('هنوز گواهی HTTPS ساخته نشده - روی سرور «node generate-https-cert.js» را اجرا کنید.');
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="warehouse-lan-ca.crt"');
  res.sendFile(caPath);
});

// اولویت پورت: env var (برای استقرارهای فعلی/اسکریپت‌هایی که از بیرون تزریقش می‌کنن) >
// تنظیمِ ذخیره‌شده از تب «⚙️ تنظیمات» > پیش‌فرض ۳۰۰۰.
const CONFIGURED_PORT = parseInt(process.env.PORT, 10) || (appSettings && appSettings.appPort) || 3000;

// اگه پورت اشغال بود (مثلاً یه نمونه‌ی قبلی از خودِ همین برنامه هنوز کامل بسته نشده - چیزی
// که همین چند بار موقع تست‌های همین پروژه هم پیش اومد)، به‌جای کرش‌کردن با EADDRINUSE،
// خودش پورت بعدی رو امتحان می‌کنه. برای یه بسته‌بندیِ آینده‌ی Electron هم این مقاومت لازمه.
function startServer(port, attemptsLeft) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`\n✅ سرور با موفقیت راه‌اندازی شد!`);
    console.log(`📌 آدرس دسترسی: http://localhost:${port}`);
    console.log(`🌐 برای دسترسی از شبکه: http://192.168.0.16:${port}\n`);
    console.log('👤 اطلاعات ورود:');
    console.log('   کاربر: admin');
    console.log('   رمز: 123456\n');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`⚠️ پورت ${port} اشغاله، تلاش روی پورت ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      console.error('❌ خطا در راه‌اندازی سرور:', err.message);
      process.exit(1);
    }
  });
}

startServer(CONFIGURED_PORT, 10);

// ===== HTTPS محلی (اختیاری) - فقط اگه certs/ از قبل با generate-https-cert.js ساخته شده
// باشه بالا میاد؛ نبودش هیچ اثری روی سرورِ HTTP بالا نداره (کاملاً مستقل). این فقط برای
// قابلیت‌هایی لازمه که مرورگر بدونِ HTTPS اصلاً اجازه‌شون رو نمی‌ده (مثل Web Push روی موبایل).
function startHttpsServer() {
  const files = resolveHttpsCertFiles();
  const keyPath = files.key;
  const certPath = files.cert;
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.log('ℹ️ certs/ پیدا نشد - HTTPS محلی غیرفعاله (برای فعال‌سازی: node generate-https-cert.js)');
    return;
  }
  const httpsPort = parseInt(process.env.HTTPS_PORT, 10) || 3443;
  const options = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  const httpsServer = https.createServer(options, app);
  httpsServer.listen(httpsPort, '0.0.0.0', () => {
    console.log(`🔒 HTTPS محلی هم روی همین سرور فعاله: https://192.168.0.16:${httpsPort} (گواهی: ${files.source})`);
    console.log(`   گواهیِ CA برای نصبِ یک‌بار روی گوشی: https://192.168.0.16:${httpsPort}/ca.crt یا http://192.168.0.16:${CONFIGURED_PORT}/ca.crt\n`);
  });
  httpsServer.on('error', (err) => {
    console.error('❌ خطا در راه‌اندازی HTTPS محلی:', err.message);
  });
}

startHttpsServer();