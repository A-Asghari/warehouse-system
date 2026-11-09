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
    console.error('Error reading DB:', e);
  }
  return null;
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) {
    console.error('Error writing DB:', e);
    return false;
  }
}

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
  
  // ریست شمارنده‌ها
  data.seq = { id: 1, doc: 1 };
  
  writeDB(data);
  console.log('✅ همه داده‌ها با موفقیت پاک شدند');
} else {
  console.log('❌ خطا در خواندن دیتابیس');
}