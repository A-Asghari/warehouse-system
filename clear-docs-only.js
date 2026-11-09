const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function readDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch(e) {
    console.error('❌ خطا در خواندن دیتابیس:', e.message);
  }
  return null;
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) {
    console.error('❌ خطا در نوشتن دیتابیس:', e.message);
    return false;
  }
}

// ============================================
// اجرای اصلی
// ============================================
console.log('\n🔄 در حال پاکسازی اسناد و تراکنش‌ها...\n');

const data = readDB();

if (data) {
  // نمایش تعداد اسناد قبل از پاکسازی
  const docCount = data.docs ? data.docs.length : 0;
  const txCount = data.transactions ? data.transactions.length : 0;
  const initCount = data.initialInventory ? data.initialInventory.length : 0;
  
  console.log(`📊 وضعیت قبل از پاکسازی:`);
  console.log(`   - اسناد: ${docCount} عدد`);
  console.log(`   - تراکنش‌ها: ${txCount} عدد`);
  console.log(`   - موجودی اولیه: ${initCount} عدد`);
  console.log(`   - کالاها: ${data.items ? data.items.length : 0} عدد`);
  console.log(`   - کاربران: ${data.users ? data.users.length : 0} عدد`);
  console.log(`   - محصولات تعریف شده: ${data.productDefinitions ? Object.keys(data.productDefinitions).length : 0} بخش`);
  
  // پاک کردن اسناد
  data.docs = [];
  
  // پاک کردن تراکنش‌ها
  data.transactions = [];
  
  // پاک کردن موجودی اولیه
  data.initialInventory = [];
  
  // ریست موجودی انبار (همه بخش‌ها خالی)
  data.inventory = {};
  data.depts.forEach(d => { data.inventory[d.id] = {}; });
  
  // ریست شمارنده‌ها (از 1 شروع میشن)
  data.seq = { id: 1, doc: 1 };
  
  // ذخیره
  writeDB(data);
  
  console.log('\n✅ پاکسازی با موفقیت انجام شد!');
  console.log(`📊 وضعیت بعد از پاکسازی:`);
  console.log(`   - اسناد: ${data.docs.length} عدد`);
  console.log(`   - تراکنش‌ها: ${data.transactions.length} عدد`);
  console.log(`   - موجودی اولیه: ${data.initialInventory.length} عدد`);
  console.log(`   - موجودی انبار: خالی`);
  console.log(`   - کالاها: ${data.items.length} عدد (حفظ شده)`);
  console.log(`   - کاربران: ${data.users.length} عدد (حفظ شده)`);
  console.log(`   - محصولات تعریف شده: ${Object.keys(data.productDefinitions).length} بخش (حفظ شده)`);
  console.log(`   - شمارنده‌ها: ID=${data.seq.id}, DOC=${data.seq.doc}`);
  
  console.log('\n✅ عملیات با موفقیت انجام شد!\n');
  
} else {
  console.log('❌ دیتابیس یافت نشد!');
}