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
  // اطمینان از وجود productDefinitions
  if (!data.productDefinitions) {
    data.productDefinitions = {};
  }
  
  // اضافه کردن محصولات تست برای هر بخش
  const testProducts = {
    'cut': [
      { code: 'P-1001', name: 'کابل نمونه برش', group: 'تست برش', unit: 'عدد', created: new Date().toISOString() },
      { code: 'P-1002', name: 'محصول برش 2', group: 'تست برش', unit: 'متر', created: new Date().toISOString() }
    ],
    'solder': [
      { code: 'P-2001', name: 'کابل نمونه لحیم', group: 'تست لحیم', unit: 'عدد', created: new Date().toISOString() }
    ],
    'inject': [
      { code: 'P-3001', name: 'محصول نمونه تزریق', group: 'تست تزریق', unit: 'عدد', created: new Date().toISOString() }
    ]
  };
  
  // اضافه کردن محصولات تست اگر بخش خالی باشه
  for (const [deptId, products] of Object.entries(testProducts)) {
    if (!data.productDefinitions[deptId] || data.productDefinitions[deptId].length === 0) {
      data.productDefinitions[deptId] = products;
      console.log(`✅ محصولات تست برای بخش ${deptId} اضافه شد`);
    } else {
      console.log(`ℹ️ بخش ${deptId} قبلاً ${data.productDefinitions[deptId].length} محصول دارد`);
    }
  }
  
  // ذخیره
  writeDB(data);
  console.log('\n✅ فایل دیتابیس به‌روزرسانی شد');
  console.log('📋 محصولات تعریف شده:');
  console.log(JSON.stringify(data.productDefinitions, null, 2));
} else {
  console.log('❌ دیتابیس یافت نشد');
}