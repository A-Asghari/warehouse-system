# معماری «سیستم مدیریت تولید» (WarehouseSystem)

نقشهٔ کلی سیستم برای کسی (یا Claude) که فقط همین ریپو را دارد. جزئیات فنی دقیق هر بخش
(قواعد کد کالا، اسناد، BOM، امنیت، فازهای ۱ تا ۶ و …) در **`CLAUDE.md`** است — این فایل
چیزهایی را می‌گوید که آنجا نیست: محیط اجرا، ارتباط با سیستم‌های دیگر، آنچه در گیت نیست،
و راه‌اندازی دوباره. آخرین بازبینی: ۱۴۰۵/۰۸/۱۸.

---

## ۱. سیستم چیست

وب‌اپ داخلی انبار و تولید که سرپرست‌ها و انباردارهای هر بخش تولید (مواد اولیه، برش، لحیم،
تزریق، لیزر، کنترل کیفیت، بسته‌بندی، انبار محصول) با آن موجودی و جابه‌جایی کالا بین مراحل را
ثبت می‌کنند — چیزی که سپیدار مدل نمی‌کند. کالا، موجودی مواد اولیه و فرمول‌های BOM از سپیدار
خوانده می‌شود (**فقط SELECT**، `memory/feedback-sepidar-read-only.md`).

## ۲. اجزای فنی

| بخش | توضیح |
|---|---|
| زبان | Node.js (روی سرور: `C:\Program Files\nodejs\node.exe`)، CommonJS، بدون build |
| وابستگی‌ها | `package.json`: express، cors، multer، lowdb، mssql، node-forge، web-push، xlsx |
| کد سرور | `server.js` (~۸۱۰۰ خط، ~۱۳۶ مسیر API) |
| کلاینت دسکتاپ | `public/index.html` (یک فایل: HTML + CSS + کل JS) |
| کلاینت موبایل (PWA) | `public/mobile/` |
| دیتابیس | فایل JSON: `db.json` + `db.json.prev` (در گیت نیست) |
| نشست‌ها | `sessions.json` (در گیت نیست) |
| سرویس ویندوز | `WarehouseSystem` با WinSW (`service/`)، نصب با `Install.bat` → `install.ps1` |
| گواهی HTTPS | `certs/` — اولویت با گواهی سامانه داخلی (`C:\dastoor-pardakht\app\certs`)؛ کلیدهای خصوصی در گیت نیستند |

### پورت‌ها (وضعیت فعلی — دورهٔ آزمایشی موازی)

| سرویس | پورت | توضیح |
|---|---|---|
| `WarehouseTee` (دوشاخه) | ۳۰۰۰ / ۳۴۴۳ | آدرسی که کاربران می‌زنند؛ هر درخواست را به Node می‌دهد و یک کپی به سایه |
| `WarehouseSystem` (Node، همین ریپو) | ۳۱۰۰ / ۳۵۴۳ | سیستم اصلی؛ پاسخ کاربر از همین است (`env` در `service/WarehouseSystem.xml`) |
| `WarehouseShadow` (نسخهٔ پایتون) | ۳۲۰۰ | فقط داخلی، برای مقایسه |

بدون دورهٔ آزمایشی (یا بعد از `_shadow_pkg/rollback_shadow.ps1`)، Node مستقیم روی ۳۰۰۰ / ۳۴۴۳ است.

## ۳. نسخهٔ پایتون و دورهٔ آزمایشی موازی

قرار است این سیستم به «سامانه داخلی» (ریپوی `dastoor-pardakht`) منتقل شود، ولی فقط بعد از
یک دورهٔ موازی که ثابت کند هیچ داده یا منطقی عوض نمی‌شود.

- `_shadow_pkg/` = بستهٔ نصب نسخهٔ پایتون (بازنویسی خط‌به‌خط `server.js` در `app/engine.py`) +
  دوشاخه (`app/tee.py`) + مقایسه‌گر شبانه (`app/shadowcmp.py`).
- `install_shadow.ps1` آن را در **`C:\WarehouseSystem-py`** نصب می‌کند (پوشهٔ جدا؛ بک‌آپ گیت جداگانه
  لازم دارد) و `rollback_shadow.ps1` همه‌چیز را به حالت قبل برمی‌گرداند.
- هر تغییری در `server.js` باید در `engine.py` هم اعمال شود، وگرنه مقایسهٔ شبانه اختلاف نشان می‌دهد.

## ۴. اتصال‌های خارجی

| سیستم | آدرس | کاربرد | تنظیم در |
|---|---|---|---|
| سپیدار | `192.168.0.12\Sepidar`، `Sepidar01`، کاربر `report` | کالا، موجودی مواد اولیه، BOM — فقط خواندنی | `appSettings.sepidar` در db.json (پیش‌فرض: `DEFAULT_SEPIDAR_CONFIG` در server.js) |
| Output Messenger | `192.168.0.3:14125` | پیام به گروه هر بخش هنگام ثبت سند خروج | `appSettings.outputMessenger` (پیش‌فرض در server.js) |
| سامانه داخلی | `C:\dastoor-pardakht` | ورود خودکار (SSO) با توکن HMAC؛ کلید مشترک = `DP_SSO_SECRET` در server.js و «تنظیمات سامانه» سامانه داخلی | — |
| Web Push | اینترنت | اعلان موبایل/دسکتاپ | کلید VAPID در db.json |

> **توجه:** پسورد کاربر `report` سپیدار، کلید API مسنجر و کلید SSO مستقیم در `server.js` و
> `_shadow_pkg/app/engine.py` نوشته شده‌اند و در این ریپو (Private) هستند. اگر ریپو روزی
> با کس دیگری به اشتراک گذاشته شد، اول این سه را عوض کنید.

## ۵. چیزهایی که در گیت نیست

| چیز | کجاست | بک‌آپ |
|---|---|---|
| دیتابیس | `db.json`، `db.json.prev`، `db.backup-*.json` | بک‌آپ داخلی سیستم (تب تنظیمات ← بکاپ؛ پوشه در `appSettings.backup.folder`) |
| نشست‌ها | `sessions.json` | لازم نیست (کاربران فقط دوباره لاگین می‌کنند) |
| کلیدهای HTTPS | `certs/server-key.pem`، `certs/ca-key.pem` | **دستی جای امن نگه دارید**؛ بدون `ca-key.pem` گواهی تازه روی گوشی‌ها دوباره باید نصب شود |
| کتابخانه‌ها | `node_modules/` | با `npm install` بازسازی می‌شود |
| لاگ‌ها، `graphify-out/`، `_BACKUP_BEFORE_PWA/` | — | لازم نیست |

## ۶. فایل‌های قدیمی (گیج نشوید)

- `public/images/index.html` و `public/images/New folder/`: کپی‌های قدیمی کل برنامه — زنده نیستند.
- `start.bat`، `Logs/`: مربوط به نصب قدیمی در `C:\Program Files (x86)\WarehouseSystem`.
- `start_warehouse.bat`، `service.log`: روش اجرای قدیمی با Task Scheduler.
- `clear*.js`، `fix-db*.js`: اسکریپت‌های نگهداری **مخرب** روی db.json (جدول آن‌ها در CLAUDE.md).
- `iran-list.rsc`: لیست آدرس میکروتیک؛ ربطی به برنامه ندارد.

## ۷. راه‌اندازی دوباره روی سرور خالی

1. Node.js (LTS) را نصب کنید.
2. `git clone https://github.com/A-Asghari/<نام-ریپو>.git C:\WarehouseSystem`
3. `cd C:\WarehouseSystem` و `npm install`
4. آخرین بک‌آپ (`backup_*.json`) را به‌عنوان `db.json` در همین پوشه بگذارید
   (یا بعد از اولین اجرا از تب بکاپ بازگردانی کنید). بدون آن، سیستم با دادهٔ پیش‌فرض بالا می‌آید.
5. کلیدهای `certs/` را برگردانید یا `node generate-https-cert.js` بزنید.
6. در `service/WarehouseSystem.xml` پورت‌ها را چک کنید (بدون دورهٔ موازی: `PORT` = 3000،
   `HTTPS_PORT` = 3443 یا حذف هر دو خط) و `Install.bat` را با Administrator اجرا کنید.
7. باز کنید: `http://<server>:3000` و از تب تنظیمات اتصال سپیدار و مسنجر را چک کنید.

## ۸. کار با سرویس

- ری‌استارت بعد از تغییر کد: `Restart-Service WarehouseSystem` (در دورهٔ موازی، `WarehouseTee` و
  `WarehouseShadow` جدا هستند).
- همزمان `npm start` را اجرا نکنید.
- جزئیات: `memory/reference-windows-service.md`
