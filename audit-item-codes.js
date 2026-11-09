// گزارش تطبیق نام↔کد کالاها - فقط خواندنی، هیچ تغییری در db.json ایجاد نمی‌کند.
// فاز ۱ از پروژه‌ی «مهاجرت موجودی از کلیدشدن بر اساس نام به کلیدشدن بر اساس کد»:
// قبل از دست‌زدن به هیچ endpoint/فرمی، می‌بینیم روی داده‌ی واقعی چند تا از نام‌های
// استفاده‌شده در inventory/transactions/docs اصلاً یه کدِ یکتا و بی‌ابهام دارن یا نه.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function loadDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

// name -> Map(code -> Set(منبعی که این تطبیق ازش اومده، برای دیباگ))
function buildNameToCodeMap(data) {
  const map = new Map();
  function add(name, code, source) {
    if (!name || !code) return;
    if (!map.has(name)) map.set(name, new Map());
    const codeMap = map.get(name);
    if (!codeMap.has(code)) codeMap.set(code, new Set());
    codeMap.get(code).add(source);
  }

  (data.items || []).forEach(it => add(it.name, it.code, 'items'));

  const productDefinitions = data.productDefinitions || {};
  Object.keys(productDefinitions).forEach(deptId => {
    (productDefinitions[deptId] || []).forEach(p => add(p.name, p.code, `productDefinitions.${deptId}`));
  });

  return map;
}

function resolve(nameToCodeMap, name) {
  const codeMap = nameToCodeMap.get(name);
  if (!codeMap || codeMap.size === 0) return { status: 'unresolved', codes: [] };
  if (codeMap.size === 1) return { status: 'resolved', codes: [...codeMap.keys()] };
  return { status: 'ambiguous', codes: [...codeMap.keys()] };
}

function main() {
  const data = loadDb();
  const nameToCodeMap = buildNameToCodeMap(data);

  const DEPTS = (data.depts || []).map(d => d.id);
  const inventory = data.inventory || {};
  const transactions = data.transactions || [];
  const docs = data.docs || [];

  console.log('='.repeat(70));
  console.log('گزارش تطبیق نام↔کد کالاها (فقط خواندنی - هیچ تغییری در db.json داده نمی‌شود)');
  console.log('='.repeat(70));

  // ===== موجودی هر بخش =====
  console.log('\n--- موجودی هر بخش (inventory) ---');
  let totalInvResolved = 0, totalInvUnresolved = 0, totalInvAmbiguous = 0;

  DEPTS.forEach(deptId => {
    const inv = inventory[deptId] || {};
    const names = Object.keys(inv);
    if (names.length === 0) return;

    const unresolved = [];
    const ambiguous = [];
    let resolvedCount = 0;

    names.forEach(name => {
      const r = resolve(nameToCodeMap, name);
      if (r.status === 'resolved') resolvedCount++;
      else if (r.status === 'unresolved') unresolved.push({ name, qty: inv[name] });
      else ambiguous.push({ name, codes: r.codes });
    });

    totalInvResolved += resolvedCount;
    totalInvUnresolved += unresolved.length;
    totalInvAmbiguous += ambiguous.length;

    console.log(`\n[${deptId}] کل اقلام: ${names.length} | حل‌شده: ${resolvedCount} | بدون کد: ${unresolved.length} | متناقض: ${ambiguous.length}`);
    if (unresolved.length > 0) {
      console.log('  بدون کد (هیچ محصول/کالایی با این اسم دقیق پیدا نشد):');
      unresolved.forEach(u => console.log(`    - "${u.name}" (موجودی فعلی: ${u.qty})`));
    }
    if (ambiguous.length > 0) {
      console.log('  متناقض (این اسم به چند کدِ متفاوت وصل می‌شه، بسته به این‌که کجا نگاه کنی):');
      ambiguous.forEach(a => console.log(`    - "${a.name}" -> [${a.codes.join(', ')}]`));
    }
  });

  console.log(`\nجمع کل موجودی: حل‌شده=${totalInvResolved} / بدون‌کد=${totalInvUnresolved} / متناقض=${totalInvAmbiguous}`);

  // ===== تراکنش‌ها =====
  const txNames = [...new Set(transactions.map(t => t.item).filter(Boolean))];
  const txUnresolved = [];
  const txAmbiguous = [];
  txNames.forEach(name => {
    const r = resolve(nameToCodeMap, name);
    if (r.status === 'unresolved') {
      const ids = transactions.filter(t => t.item === name).map(t => t.id);
      txUnresolved.push({ name, count: ids.length, sampleIds: ids.slice(0, 5) });
    } else if (r.status === 'ambiguous') {
      txAmbiguous.push({ name, codes: r.codes });
    }
  });

  console.log('\n--- تراکنش‌ها (transactions) ---');
  console.log(`کل نام‌های یکتا: ${txNames.length} | بدون کد: ${txUnresolved.length} | متناقض: ${txAmbiguous.length}`);
  if (txUnresolved.length > 0) {
    console.log('  بدون کد:');
    txUnresolved.forEach(u => console.log(`    - "${u.name}" (${u.count} تراکنش، نمونه id: ${u.sampleIds.join(', ')})`));
  }
  if (txAmbiguous.length > 0) {
    console.log('  متناقض:');
    txAmbiguous.forEach(a => console.log(`    - "${a.name}" -> [${a.codes.join(', ')}]`));
  }

  // ===== اسناد =====
  const docNames = [...new Set(docs.map(d => d.item).filter(Boolean))];
  const docUnresolved = [];
  const docAmbiguous = [];
  docNames.forEach(name => {
    const r = resolve(nameToCodeMap, name);
    if (r.status === 'unresolved') {
      const ids = docs.filter(d => d.item === name).map(d => d.id);
      docUnresolved.push({ name, count: ids.length, sampleIds: ids.slice(0, 5) });
    } else if (r.status === 'ambiguous') {
      docAmbiguous.push({ name, codes: r.codes });
    }
  });

  console.log('\n--- اسناد (docs) ---');
  console.log(`کل نام‌های یکتا: ${docNames.length} | بدون کد: ${docUnresolved.length} | متناقض: ${docAmbiguous.length}`);
  if (docUnresolved.length > 0) {
    console.log('  بدون کد:');
    docUnresolved.forEach(u => console.log(`    - "${u.name}" (${u.count} سند، نمونه id: ${u.sampleIds.join(', ')})`));
  }
  if (docAmbiguous.length > 0) {
    console.log('  متناقض:');
    docAmbiguous.forEach(a => console.log(`    - "${a.name}" -> [${a.codes.join(', ')}]`));
  }

  // ===== ابهام داخل خودِ کاتالوگ (items + productDefinitions) =====
  // این بخش به موجودی/تراکنش/سند فعلی کاری نداره - حتی اگه سیستم تازه پاک شده باشه و
  // هیچ سند/موجودی‌ای نباشه، بازم می‌شه دید که آیا خودِ کاتالوگ (items[] +
  // productDefinitions) یه اسم رو به چند کدِ متفاوت وصل کرده یا نه؛ این نوع ابهام هر وقت
  // دوباره تولید/مصرف ثبت بشه سر و کله‌ش پیدا می‌شه، پس همین الان هم قابل بررسیه.
  const catalogAmbiguous = [];
  nameToCodeMap.forEach((codeMap, name) => {
    if (codeMap.size > 1) {
      const sources = [];
      codeMap.forEach((srcSet, code) => sources.push(`${code} (از: ${[...srcSet].join('، ')})`));
      catalogAmbiguous.push({ name, sources });
    }
  });

  console.log('\n--- ابهام داخل کاتالوگ (items + productDefinitions، مستقل از موجودی/سند فعلی) ---');
  console.log(`تعداد اسم‌هایی که به چند کدِ متفاوت وصل می‌شن: ${catalogAmbiguous.length}`);
  if (catalogAmbiguous.length > 0) {
    catalogAmbiguous.forEach(a => {
      console.log(`  - "${a.name}":`);
      a.sources.forEach(s => console.log(`      ${s}`));
    });
  }

  console.log('\n' + '='.repeat(70));
  console.log('پایان گزارش. هیچ فایلی تغییر نکرد.');
  if (transactions.length === 0 && docs.length === 0) {
    console.log('توجه: transactions و docs الان خالی هستن (احتمالاً سیستم تازه پاک شده) - بخش‌های');
    console.log('«موجودی/تراکنش/اسناد» بالا چیزی برای گزارش نداشتن. بخش «ابهام داخل کاتالوگ» بالا');
    console.log('همچنان معتبره. بعد از تست‌های بعدی (ثبت چند سند تولید/مصرف/خروج)، اسکریپت رو');
    console.log('دوباره اجرا کنید تا گزارش کامل روی داده‌ی واقعی هم دیده بشه.');
  }
  console.log('='.repeat(70));
}

main();
