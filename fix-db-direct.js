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

// ============================================
// محصولات تست مستقیم
// ============================================
const data = readDB();

if (data) {
  console.log('📋 دیتابیس قبل از تغییر:');
  console.log('productDefinitions:', data.productDefinitions);
  
  // محصولات رو مستقیم تنظیم کن
  data.productDefinitions = {
    "cut": [
      {
        "code": "P-1001",
        "name": "کابل نمونه برش",
        "group": "تست برش",
        "unit": "عدد",
        "created": new Date().toISOString()
      },
      {
        "code": "P-1002",
        "name": "محصول برش 2",
        "group": "تست برش",
        "unit": "متر",
        "created": new Date().toISOString()
      }
    ],
    "solder": [
      {
        "code": "P-2001",
        "name": "کابل نمونه لحیم",
        "group": "تست لحیم",
        "unit": "عدد",
        "created": new Date().toISOString()
      }
    ],
    "inject": [
      {
        "code": "P-3001",
        "name": "محصول نمونه تزریق",
        "group": "تست تزریق",
        "unit": "عدد",
        "created": new Date().toISOString()
      }
    ],
    "laser": [
      {
        "code": "P-4001",
        "name": "محصول نمونه لیزر",
        "group": "تست لیزر",
        "unit": "عدد",
        "created": new Date().toISOString()
      }
    ],
    "pack": [
      {
        "code": "P-5001",
        "name": "محصول نمونه بسته‌بندی",
        "group": "تست بسته‌بندی",
        "unit": "عدد",
        "created": new Date().toISOString()
      }
    ]
  };
  
  // ذخیره
  writeDB(data);
  
  console.log('\n✅ دیتابیس با موفقیت به‌روزرسانی شد');
  console.log('📋 محصولات تعریف شده:');
  console.log(JSON.stringify(data.productDefinitions, null, 2));
  console.log('\n🎯 حالا برو به بخش تولید و تست کن');
} else {
  console.log('❌ دیتابیس یافت نشد');
}