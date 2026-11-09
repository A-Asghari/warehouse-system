const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

// ============================================
// ساختار پیش‌فرض دیتابیس
// ============================================
const DEFAULT_USERS = [
  {username:'admin', password:'123456', fullname:'مدیر سیستم', unit:'مدیریت', role:'admin'},
  {username:'ali', password:'123456', fullname:'علی احمدی', unit:'برش', role:'user'},
  {username:'reza', password:'123456', fullname:'رضا کریمی', unit:'لحیم', role:'user'},
  {username:'mohsen', password:'123456', fullname:'محسن رضایی', unit:'تزریق', role:'user'},
  {username:'mehdi', password:'123456', fullname:'مهدی قاسمی', unit:'کنترل کیفیت', role:'user'},
  {username:'hamid', password:'123456', fullname:'حمید علیپور', unit:'بسته‌بندی', role:'user'},
  {username:'nader', password:'123456', fullname:'نادر محمدی', unit:'انبار محصول', role:'user'}
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
    seq: {id: 1, doc: 1} 
  };
}

// ============================================
// توابع خواندن و نوشتن
// ============================================
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
console.log('\n🔄 در حال پاکسازی دیتابیس...\n');

const data = readDB();

if (data) {
  // پاک کردن موجودی
  data.inventory = {};
  data.depts.forEach(d => { data.inventory[d.id] = {}; });
  
  // پاک کردن تراکنش‌ها
  data.transactions = [];
  
  // پاک کردن اسناد
  data.docs = [];
  
  // پاک کردن موجودی اولیه
  data.initialInventory = [];
  
  // پاک کردن محصولات تعریف شده
  data.productDefinitions = {};
  
  // ریست شمارنده‌ها
  data.seq = { id: 1, doc: 1 };
  
  // حفظ کاربران (اختیاری - اگه میخوای همه کاربران هم پاک بشن، این خط رو حذف کن)
  // data.users = [];
  
  writeDB(data);
  
  console.log('✅ همه داده‌ها با موفقیت پاک شدند');
  console.log('📊 ساختار دیتابیس ریست شد:');
  console.log(`   - موجودی: ${Object.keys(data.inventory).length} بخش`);
  console.log(`   - تراکنش‌ها: ${data.transactions.length}`);
  console.log(`   - اسناد: ${data.docs.length}`);
  console.log(`   - موجودی اولیه: ${data.initialInventory.length}`);
  console.log(`   - شمارنده‌ها: ID=${data.seq.id}, DOC=${data.seq.doc}`);
  console.log('\n👤 کاربران موجود:');
  data.users.forEach(u => console.log(`   - ${u.username} (${u.fullname})`));
  console.log('\n✅ عملیات پاکسازی با موفقیت انجام شد!\n');
  
} else {
  console.log('❌ دیتابیس موجود نیست. ایجاد دیتابیس جدید...');
  
  // ایجاد دیتابیس جدید
  const newData = getDefaultData();
  writeDB(newData);
  console.log('✅ دیتابیس جدید با موفقیت ایجاد شد!\n');
}