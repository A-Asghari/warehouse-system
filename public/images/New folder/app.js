// ============================================
// تنظیمات
// ============================================
const API_URL = window.location.origin;

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

const INPUT_ALLOWED_UNITS = ['مدیریت', 'برش'];

const DEFAULT_FISCAL_YEARS = [
  {year: '1405', title: 'سال مالی 1405', status: 'active', startDate: '1405/01/01', endDate: '1405/12/29'}
];

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
let currentUser = null;
let isAppActive = false;
let selectedItemCode = null;
let selectedProductForDelete = null;
let editingProduct = null;
let editingUser = null;
let materialRows = [];
let materialRowId = 0;
let selectedMaterialsForProduction = [];

// ===== متغیرهای مودال انتخاب بخش =====
let pendingOutputData = null;
let pendingOutputCallback = null;

// ============================================
// توابع ذخیره و بارگذاری
// ============================================
function saveToLocalStorage() {
    try {
        const data = {
            users: users,
            items: items,
            inventory: inventory,
            transactions: transactions,
            docs: docs,
            fiscalYears: fiscalYears,
            activeFiscalYear: activeFiscalYear,
            initialInventory: initialInventory,
            productDefinitions: productDefinitions,
            seq: { id: seqId, doc: docSeq },
            depts: DEPTS
        };
        localStorage.setItem('warehouseData', JSON.stringify(data));
        return true;
    } catch(e) {
        console.error('❌ خطا در ذخیره localStorage:', e);
        return false;
    }
}

function loadFromLocalStorage() {
    try {
        const saved = localStorage.getItem('warehouseData');
        if (saved) {
            const data = JSON.parse(saved);
            users = data.users || [];
            items = data.items || [];
            inventory = data.inventory || {};
            transactions = data.transactions || [];
            docs = data.docs || [];
            fiscalYears = data.fiscalYears || DEFAULT_FISCAL_YEARS;
            activeFiscalYear = data.activeFiscalYear || '1405';
            initialInventory = data.initialInventory || [];
            productDefinitions = data.productDefinitions || {};
            seqId = data.seq?.id || 1;
            docSeq = data.seq?.doc || 1;
            return true;
        }
        return false;
    } catch(e) {
        console.error('❌ خطا در بارگذاری localStorage:', e);
        return false;
    }
}

async function loadData() {
    try {
        const response = await fetch(`${API_URL}/api/data`);
        if (response.ok) {
            const data = await response.json();
            users = data.users || [];
            items = data.items || [];
            inventory = data.inventory || {};
            transactions = data.transactions || [];
            docs = data.docs || [];
            fiscalYears = data.fiscalYears || DEFAULT_FISCAL_YEARS;
            activeFiscalYear = data.activeFiscalYear || '1405';
            initialInventory = data.initialInventory || [];
            productDefinitions = data.productDefinitions || {};
            seqId = data.seq?.id || 1;
            docSeq = data.seq?.doc || 1;
            saveToLocalStorage();
            updateConnectionStatus(true);
            return true;
        }
    } catch(e) {
        if (loadFromLocalStorage()) {
            updateConnectionStatus(false);
            return true;
        }
    }
    return false;
}

async function saveData() {
    saveToLocalStorage();
    try {
        const data = {
            users, items, inventory, transactions, docs,
            fiscalYears, activeFiscalYear, initialInventory,
            productDefinitions,
            seq: { id: seqId, doc: docSeq }
        };
        const response = await fetch(`${API_URL}/api/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (response.ok) {
            updateConnectionStatus(true);
            return true;
        }
    } catch(e) {
        updateConnectionStatus(false);
        return true;
    }
    return false;
}

function updateConnectionStatus(online) {
  const el = document.getElementById('connectionStatus');
  if (online) {
    el.textContent = '✅ آنلاین';
    el.className = 'connection-status online';
  } else {
    el.textContent = '💾 آفلاین (ذخیره محلی)';
    el.className = 'connection-status offline';
  }
}

// ============================================
// توابع کمکی
// ============================================
function formatNumber(num) {
  if (num === undefined || num === null) return '0';
  return num.toLocaleString('fa-IR');
}

function getItemCode(itemName) {
  const item = items.find(i => i.name === itemName);
  return item ? item.code : '---';
}

function getItemUnit(itemName) {
  const item = items.find(i => i.name === itemName);
  return item ? item.unit : 'عدد';
}

function deptName(id) {
  const dept = DEPTS.find(d => d.id === id);
  return dept ? dept.name : id;
}

function getDeptProducts(deptId) {
  if (!productDefinitions) return [];
  return productDefinitions[deptId] || [];
}

function showToast(msg, err=false) {
  // پیام‌های طولانی/چندخطی خوانا نیستن داخل toast کوچیک؛
  // به‌جاش توی مودال با فرمت‌بندی درست نمایش داده می‌شن.
  if (typeof msg === 'string' && (msg.includes('\n') || msg.length > 90)) {
    showAlertModal(msg, { danger: err });
    return;
  }
  const t=document.getElementById('toast'); 
  t.textContent=msg; 
  t.className='toast show'+(err?' error':''); 
  clearTimeout(t._timer); 
  t._timer=setTimeout(()=>t.classList.remove('show'),4000); 
}

// ============================================
// مودال تایید سفارشی (جایگزین تابع confirm بومی مرورگر)
// ============================================
function customConfirmModal(message, opts = {}) {
  const { danger = false, okLabel = '✅ تایید', cancelLabel = '❌ انصراف' } = opts;
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmModalOverlay');
    const iconEl = document.getElementById('confirmModalIcon');
    const msgEl = document.getElementById('confirmModalMsg');
    const detailsEl = document.getElementById('confirmModalDetails');
    const actionsEl = document.getElementById('confirmModalActions');

    const { headline, details } = splitMessageForModal(message);
    iconEl.textContent = danger ? '🛑' : '⚠️';
    msgEl.textContent = headline;
    if (details) {
      detailsEl.style.display = 'block';
      detailsEl.textContent = details;
    } else {
      detailsEl.style.display = 'none';
      detailsEl.textContent = '';
    }

    actionsEl.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cm-cancel';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.className = 'cm-ok' + (danger ? ' danger' : '');
    okBtn.textContent = okLabel;
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    function cleanup(result) {
      overlay.classList.remove('open');
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    }
    cancelBtn.onclick = () => cleanup(false);
    okBtn.onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', onKeydown);

    overlay.classList.add('open');
    okBtn.focus();
  });
}

// نمایش پیام (خطا/موفقیت) طولانی به‌صورت مودال قابل خواندن، با فقط یک دکمه
function showAlertModal(message, opts = {}) {
  const { danger = false } = opts;
  const overlay = document.getElementById('confirmModalOverlay');
  const iconEl = document.getElementById('confirmModalIcon');
  const msgEl = document.getElementById('confirmModalMsg');
  const detailsEl = document.getElementById('confirmModalDetails');
  const actionsEl = document.getElementById('confirmModalActions');

  const { headline, details } = splitMessageForModal(message);
  iconEl.textContent = danger ? '❌' : 'ℹ️';
  msgEl.textContent = headline;
  if (details) {
    detailsEl.style.display = 'block';
    detailsEl.textContent = details;
  } else {
    detailsEl.style.display = 'none';
    detailsEl.textContent = '';
  }

  actionsEl.innerHTML = '';
  const okBtn = document.createElement('button');
  okBtn.className = 'cm-single';
  okBtn.textContent = 'متوجه شدم';
  actionsEl.appendChild(okBtn);

  function cleanup() {
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) { if (e.key === 'Escape' || e.key === 'Enter') cleanup(); }
  okBtn.onclick = cleanup;
  overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
  document.addEventListener('keydown', onKeydown);

  overlay.classList.add('open');
  okBtn.focus();
}

// اولین خط پیام رو به‌عنوان تیتر خلاصه نشون میده و بقیه رو به‌عنوان جزئیات قابل اسکرول
function splitMessageForModal(message) {
  const clean = String(message).replace(/^[❌⚠️🛑ℹ️✅\s]+/, '').trim();
  const lines = clean.split('\n').filter(Boolean);
  if (lines.length <= 1) return { headline: clean, details: '' };
  return { headline: lines[0], details: lines.slice(1).join('\n') };
}

// ============================================
// اعتبارسنجی فرم‌ها با هایلایت فیلد خالی/نامعتبر
// ============================================
function highlightInvalidFields(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('input-error');
    void el.offsetWidth; // ری‌استارت انیمیشن
    el.classList.add('input-error');
    setTimeout(() => el.classList.remove('input-error'), 2500);
  });
}

// fields: [{ id: 'prod-unit', label: 'بخش', valid: !!unit }, ...]
// در صورت نامعتبر بودن، فیلدها هایلایت و لیست موارد ناقص برگردونده می‌شه
function validateFields(fields) {
  const invalid = fields.filter(f => !f.valid);
  if (invalid.length > 0) {
    highlightInvalidFields(invalid.map(f => f.id));
  }
  return {
    valid: invalid.length === 0,
    missingLabels: invalid.map(f => f.label)
  };
}

// ============================================
// لایه بارگذاری سراسری
// ============================================
function showAppLoading(text) {
  const overlay = document.getElementById('appLoadingOverlay');
  if (!overlay) return;
  if (text) document.getElementById('appLoadingText').textContent = text;
  overlay.classList.add('open');
}
function hideAppLoading() {
  const overlay = document.getElementById('appLoadingOverlay');
  if (overlay) overlay.classList.remove('open');
}

function convertPersianToEnglish(str) {
  const persian = {
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'
  };
  return str.replace(/[۰-۹٠-٩]/g, m => persian[m] || m);
}

function parseDate(dateStr) {
  if(!dateStr) return null;
  const clean = convertPersianToEnglish(dateStr.trim());
  const parts = clean.split('/');
  if(parts.length !== 3) return null;
  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]);
  const day = parseInt(parts[2]);
  if(isNaN(year) || isNaN(month) || isNaN(day)) return null;
  return {year, month, day};
}

function compareDates(d1, d2) {
  if(!d1 || !d2) return true;
  if(d1.year !== d2.year) return d1.year < d2.year;
  if(d1.month !== d2.month) return d1.month < d2.month;
  return d1.day <= d2.day;
}

function isDateInRange(dateStr, fromStr, toStr) {
  const date = parseDate(dateStr);
  if(!date) return true;
  const from = parseDate(fromStr);
  const to = parseDate(toStr);
  if(from && !compareDates(from, date)) return false;
  if(to && !compareDates(date, to)) return false;
  return true;
}

function isAdmin() { return currentUser && currentUser.role==='admin'; }
function getUserUnit() { return currentUser ? currentUser.unit : null; }
function getUserDeptId() { 
  const unit = getUserUnit();
  if(!unit) return null;
  const dept = DEPTS.find(d=>d.name===unit);
  return dept ? dept.id : null;
}
function getUserDeptName() { return getUserUnit() || ''; }

function restrictToUserUnit(selectId, lockId) {
  const select = document.getElementById(selectId);
  const lock = document.getElementById(lockId);
  if(!select) return;
  
  select.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    select.appendChild(option);
  });
  
  if(!isAdmin() && getUserDeptId()) {
    const userDeptId = getUserDeptId();
    select.value = userDeptId;
    select.disabled = true;
    if(lock) {
      lock.textContent = `🔒 فقط ${deptName(userDeptId)}`;
      lock.style.display = 'block';
    }
  } else if(isAdmin()) {
    select.disabled = false;
    if(lock) {
      lock.textContent = '';
      lock.style.display = 'none';
    }
  }
}

function checkFiscalYearAndProceed(callback) {
  const activeFY = fiscalYears.find(fy => fy.status === 'active');
  if(!activeFY) {
    showToast('⛔ سال مالی فعال نیست.', true);
    return false;
  }
  return callback();
}

// ============================================
// توابع لاگین
// ============================================
async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value.trim();
  const status = document.getElementById('loginStatus');
  const btn = document.getElementById('loginBtn');
  
  if(!username || !password) { 
    status.textContent='⚠️ نام کاربری و رمز عبور را وارد کنید'; 
    status.className='login-status error'; 
    return; 
  }
  
  btn.disabled = true;
  btn.textContent = '⏳ در حال بررسی...';
  
  await loadData();
  
  const user = users.find(u=>u.username===username && u.password===password);
  
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '🚪 ورود به سیستم';
    
    if(!user) { 
      status.textContent='❌ نام کاربری یا رمز عبور اشتباه است'; 
      status.className='login-status error';
      return; 
    }
    
    currentUser = user;
    isAppActive = true;
    sessionStorage.setItem('currentUser', JSON.stringify(user));
    
    status.textContent=`✅ خوش آمدید ${user.fullname}`;
    status.className='login-status success';
    
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('appContainer').classList.add('active');
    
    document.getElementById('userName').textContent = user.fullname;
    document.getElementById('userUnit').textContent = user.unit;
    
    populateFiscalYears();
    updateFiscalUI();
    buildNav(); 
    renderAll();
    fillReportForm();
  }, 500);
}

function doLogout() {
  currentUser = null;
  isAppActive = false;
  sessionStorage.removeItem('currentUser');
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('appContainer').classList.remove('active');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginStatus').textContent = '';
  document.getElementById('loginStatus').className = 'login-status';
}

function checkSession() {
  const savedUser = sessionStorage.getItem('currentUser');
  if (savedUser) {
    try {
      const user = JSON.parse(savedUser);
      const validUser = users.find(u => u.username === user.username);
      if (validUser) {
        currentUser = validUser;
        isAppActive = true;
        document.getElementById('loginPage').style.display = 'none';
        document.getElementById('appContainer').classList.add('active');
        document.getElementById('userName').textContent = validUser.fullname;
        document.getElementById('userUnit').textContent = validUser.unit;
        populateFiscalYears();
        updateFiscalUI();
        buildNav(); 
        renderAll();
        fillReportForm();
        return true;
      }
    } catch(e) {}
  }
  return false;
}

// ============================================
// توابع سال مالی
// ============================================
function getActiveFiscalYear() {
  return fiscalYears.find(fy => fy.status === 'active') || fiscalYears[0];
}

function populateFiscalYears() {
  const select = document.getElementById('fiscalYearSelect');
  select.innerHTML = '';
  fiscalYears.forEach(fy => {
    const option = document.createElement('option');
    option.value = fy.year;
    const statusText = fy.status === 'active' ? ' (فعال)' : fy.status === 'closed' ? ' (بسته)' : '';
    option.textContent = `${fy.title}${statusText}`;
    if(fy.year === activeFiscalYear) option.selected = true;
    select.appendChild(option);
  });
}

function updateFiscalUI() {
  const activeFY = getActiveFiscalYear();
  const badge = document.getElementById('fyStatusBadge');
  if(activeFY) {
    badge.textContent = `فعال: ${activeFY.title}`;
    badge.className = 'fy-status active';
  }
  populateFiscalYears();
  renderFiscalList();
}

function changeFiscalYear() {
  const selected = document.getElementById('fiscalYearSelect').value;
  const fy = fiscalYears.find(f => f.year === selected);
  if(fy) {
    activeFiscalYear = fy.year;
    if(fy.status === 'active') {
      updateFiscalUI();
      showToast(`📅 سال مالی ${fy.title} انتخاب شد`);
    } else {
      showToast(`⚠️ سال مالی ${fy.title} فعال نیست`, true);
    }
    renderAll();
  }
}

async function createFiscalYear() {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  
  const year = document.getElementById('fy-new-year').value.trim();
  const title = document.getElementById('fy-new-title').value.trim() || `سال مالی ${year}`;
  
  if(!year || isNaN(parseInt(year))) {
    highlightInvalidFields(['fy-new-year']);
    showToast('⚠️ سال مالی معتبر وارد کنید (فقط عدد)', true);
    return;
  }
  
  if(fiscalYears.find(f => f.year === year)) {
    showToast('⚠️ این سال مالی قبلاً ایجاد شده است', true);
    return;
  }
  
  fiscalYears.forEach(f => {
    if(f.status === 'active') f.status = 'closed';
  });
  
  const newFY = {
    year: year,
    title: title,
    status: 'active',
    startDate: `${year}/01/01`,
    endDate: `${year}/12/29`
  };
  
  fiscalYears.push(newFY);
  activeFiscalYear = year;
  
  await saveData();
  document.getElementById('fy-new-year').value = '';
  document.getElementById('fy-new-title').value = '';
  updateFiscalUI();
  showToast(`✅ سال مالی ${title} با موفقیت ایجاد شد`);
  renderAll();
}

async function closeFiscalYear(year) {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  const fy = fiscalYears.find(f => f.year === year);
  if(!fy) { showToast('⚠️ سال مالی یافت نشد', true); return; }
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید سال مالی ${fy.title} را ببندید؟`)) return;
  fy.status = 'closed';
  await saveData();
  updateFiscalUI();
  showToast(`✅ سال مالی ${fy.title} بسته شد`);
  renderAll();
}

async function reopenFiscalYear(year) {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  fiscalYears.forEach(f => {
    if(f.status === 'active') f.status = 'closed';
  });
  const fy = fiscalYears.find(f => f.year === year);
  if(!fy) { showToast('⚠️ سال مالی یافت نشد', true); return; }
  fy.status = 'active';
  activeFiscalYear = year;
  await saveData();
  updateFiscalUI();
  showToast(`✅ سال مالی ${fy.title} دوباره فعال شد`);
  renderAll();
}

function renderFiscalList() {
  const container = document.getElementById('fy-list');
  if(!isAdmin()) { container.innerHTML = ''; return; }
  if(fiscalYears.length === 0) {
    container.innerHTML = '<div class="empty">📭 هنوز سال مالی ایجاد نشده است</div>';
    return;
  }
  
  container.innerHTML = fiscalYears.slice().reverse().map(fy => `
    <div class="fy-card">
      <div>
        <span class="fy-name">📅 ${fy.title}</span>
        <span class="fy-dates">${fy.startDate} تا ${fy.endDate}</span>
      </div>
      <div>
        <span class="fy-status ${fy.status === 'active' ? 'active' : 'closed'}">${fy.status === 'active' ? 'فعال' : 'بسته شده'}</span>
        ${fy.status === 'active' ? `<button class="warning" onclick="closeFiscalYear('${fy.year}')" style="padding:4px 12px;font-size:11px">🔒 بستن</button>` : 
                                   `<button class="success" onclick="reopenFiscalYear('${fy.year}')" style="padding:4px 12px;font-size:11px">🔓 بازگشایی</button>`}
        ${fy.status === 'active' ? `<span style="font-size:11px;color:var(--green);font-weight:700">✅ فعال</span>` : 
                                   `<span style="font-size:11px;color:var(--danger);font-weight:700">⛔ غیرفعال</span>`}
      </div>
    </div>
  `).join('');
}

// ============================================
// توابع منو و ناوبری
// ============================================
function buildNav() {
  const isAdminUser = isAdmin();

  // منو به‌جای یک لیست تخت، به گروه‌های منطقی تقسیم شده تا پیدا کردن
  // گزینه‌ی موردنظر (به‌خصوص برای ادمین با ۱۴ تب) راحت‌تر باشه.
  const groups = [
    {
      title: '📊 گزارش‌ها و موجودی',
      tabs: [
        {id:'sec-dashboard', label:'موجودی', icon:'📊'},
        {id:'sec-daily-report', label:'گزارش روزانه', icon:'📋'},
        {id:'sec-cardex', label:'کاردکس', icon:'📇'},
        {id:'sec-summary', label:'گزارش کل', icon:'📈'},
      ]
    },
    {
      title: '🏭 عملیات روزانه',
      tabs: [
        {id:'sec-production', label:'تولید', icon:'🏭'},
        {id:'sec-consume', label:'مصرف', icon:'📥'},
        {id:'sec-output', label:'خروج به بخش', icon:'📤'},
        {id:'sec-waste', label:'ضایعات', icon:'🗑️'},
        {id:'sec-adjust', label:'کسری و اضافات', icon:'⚙️'},
        {id:'sec-documents', label:'اسناد', icon:'📋'},
        {id:'sec-history', label:'تاریخچه', icon:'📜'}
      ]
    }
  ];

  if (isAdminUser) {
    groups.push({
      title: '📅 راه‌اندازی و سال مالی',
      tabs: [
        {id:'sec-sync', label:'همگام‌سازی سپیدار', icon:'🔄'},
        {id:'sec-fiscal', label:'سال مالی', icon:'📅'},
        {id:'sec-initial-inv', label:'موجودی اول دوره', icon:'🧮'},
        {id:'sec-products-mgmt', label:'تعریف محصول', icon:'🏷️'}
      ]
    });
    groups.push({
      title: '👤 مدیریت سیستم',
      tabs: [
        {id:'sec-items', label:'مدیریت کالاها', icon:'📦'},
        {id:'sec-users-mgmt', label:'مدیریت کاربران', icon:'👤'},
        {id:'sec-backup', label:'بکاپ', icon:'💾'}
      ]
    });
  }

  // لیست تخت هم برای منطق پیش‌فرض (اولین تب فعال) لازمه
  const allTabs = groups.flatMap(g => g.tabs);

  const desktopNav = document.getElementById('desktopNav');
  desktopNav.innerHTML = groups.map((g, gi) => {
    const sep = gi > 0 ? '<span class="nav-group-sep" aria-hidden="true"></span>' : '';
    const label = `<span class="nav-group-label">${g.title}</span>`;
    const buttons = g.tabs.map(t => {
      let badge = '';
      if (t.id === 'sec-documents') {
        badge = `<span class="nav-badge hidden" id="desktopDocBadge">0</span>`;
      }
      return `<button data-target="${t.id}" title="${t.label}">${t.icon || '📄'} ${t.label} ${badge}</button>`;
    }).join('');
    return sep + label + buttons;
  }).join('');

  desktopNav.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      desktopNav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchTab(btn.dataset.target);
    };
  });

  const fullMenuGrid = document.getElementById('fullMenuGrid');
  fullMenuGrid.innerHTML = groups.map(g => `
    <div class="menu-grid-group-title">${g.title}</div>
    ${g.tabs.map(t => `
      <button class="menu-item" onclick="switchTab('${t.id}'); closeFullMenu();">
        <span class="icon">${t.icon || '📄'}</span>
        <span>${t.label}</span>
      </button>
    `).join('')}
  `).join('');

  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
  const firstTab = allTabs[0];
  if(firstTab) {
    document.getElementById(firstTab.id).classList.add('active');
    desktopNav.querySelector('button[data-target="' + firstTab.id + '"]')?.classList.add('active');
  }
  
  setTimeout(updateNotificationBadge, 100);
}

function switchTab(tabId) {
  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
  
  document.querySelectorAll('.desktop-nav button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === tabId);
  });
  
  document.querySelectorAll('.mobile-bottom-nav .nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === tabId);
  });
  
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleFullMenu() {
  const overlay = document.getElementById('fullMenuOverlay');
  overlay.classList.toggle('open');
  document.body.style.overflow = overlay.classList.contains('open') ? 'hidden' : '';
}

function closeFullMenu(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('fullMenuOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ============================================
// نوتیفیکیشن اسناد در انتظار تایید
// ============================================
function updateNotificationBadge() {
  const allDocs = docs || [];
  const userDeptName = getUserDeptName();
  const userDeptId = getUserDeptId();
  const isAdminUser = isAdmin();
  
  let pendingDocs = allDocs.filter(d => 
    d.status === 'pending' && 
    d.type === 'output'
  );
  
  if(!isAdminUser) {
    pendingDocs = pendingDocs.filter(d => 
      d.toUnit === userDeptName || 
      d.toUnit === userDeptId
    );
  }
  
  let returnPendingDocs = allDocs.filter(d => 
    d.status === 'return_pending' && 
    d.type === 'return'
  );
  
  if(!isAdminUser) {
    returnPendingDocs = returnPendingDocs.filter(d => 
      d.toUnit === userDeptName || 
      d.toUnit === userDeptId
    );
  }
  
  const totalCount = pendingDocs.length + returnPendingDocs.length;
  
  const desktopBadge = document.getElementById('desktopDocBadge');
  if (desktopBadge) {
    if (totalCount > 0) {
      desktopBadge.textContent = totalCount;
      desktopBadge.classList.remove('hidden');
    } else {
      desktopBadge.classList.add('hidden');
    }
  }
  
  const mobileBadge = document.getElementById('mobileDocBadge');
  if (mobileBadge) {
    if (totalCount > 0) {
      mobileBadge.textContent = totalCount;
      mobileBadge.style.display = 'flex';
    } else {
      mobileBadge.style.display = 'none';
    }
  }
  
  const quickBadge = document.getElementById('quickDocBadge');
  if (quickBadge) {
    if (totalCount > 0) {
      quickBadge.textContent = totalCount;
      quickBadge.classList.remove('hidden');
    } else {
      quickBadge.classList.add('hidden');
    }
  }
}

// ============================================
// ===== مودال انتخاب بخش =====
// ============================================
function showSelectDeptModal(callback) {
  const modal = document.getElementById('selectDeptModal');
  const list = document.getElementById('select-dept-list');
  
  // پر کردن لیست بخش‌ها
  list.innerHTML = '<option value="">-- انتخاب بخش --</option>';
  DEPTS.forEach(d => {
    // حذف بخش فعلی از لیست
    if (d.id !== pendingOutputData?.fromUnit) {
      const option = document.createElement('option');
      option.value = d.id;
      option.textContent = d.name;
      list.appendChild(option);
    }
  });
  
  pendingOutputCallback = callback;
  modal.classList.add('open');
}

function closeSelectDeptModal() {
  document.getElementById('selectDeptModal').classList.remove('open');
  pendingOutputCallback = null;
  pendingOutputData = null;
}

function confirmSelectDept() {
  const list = document.getElementById('select-dept-list');
  const selectedDept = list.value;
  
  if (!selectedDept) {
    showToast('⚠️ لطفاً بخش مقصد را انتخاب کنید', true);
    return;
  }
  
  if (pendingOutputCallback) {
    pendingOutputCallback(selectedDept);
  }
  
  closeSelectDeptModal();
}

// ============================================
// ===== کاردکس - کامل =====
// ============================================
function fillCardexForm() {
  const unit = document.getElementById('cardex-unit');
  const currentUnit = getUserDeptId();
  
  unit.innerHTML = '';
  const deptList = isAdmin() ? DEPTS : DEPTS.filter(d => d.id === currentUnit);
  deptList.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    if(d.id === currentUnit) option.selected = true;
    unit.appendChild(option);
  });
  
  const activeFY = getActiveFiscalYear();
  if(!document.getElementById('cardex-date-from').value) {
    document.getElementById('cardex-date-from').value = activeFY ? activeFY.startDate : `${activeFiscalYear}/01/01`;
    document.getElementById('cardex-date-to').value = activeFY ? activeFY.endDate : `${activeFiscalYear}/12/29`;
  }
  
  fillCardexItems();
}

function fillCardexItems() {
  const unitId = document.getElementById('cardex-unit').value;
  const item = document.getElementById('cardex-item');
  const inv = inventory[unitId] || {};
  const itemList = Object.keys(inv).filter(k => inv[k] !== 0);
  const txItems = transactions.filter(t => t.unit === unitId).map(t => t.item);
  const initItems = initialInventory.filter(t => t.unit === unitId).map(t => t.item);
  const allItems = [...new Set([...itemList, ...txItems, ...initItems])];
  item.innerHTML = allItems.map(name => {
    const code = getItemCode(name);
    return `<option value="${name}">${code} - ${name}</option>`;
  }).join('');
  if(allItems.length === 0) item.innerHTML = '<option value="">⚠️ کالایی یافت نشد</option>';
  renderCardex();
}

function renderCardex() {
  const unitId = document.getElementById('cardex-unit').value;
  const itemName = document.getElementById('cardex-item').value;
  const dateFrom = document.getElementById('cardex-date-from').value;
  const dateTo = document.getElementById('cardex-date-to').value;
  const container = document.getElementById('cardex-container');
  
  if(!unitId || !itemName || itemName === '') { 
    container.innerHTML='<div class="empty">بخش و کالا را انتخاب کنید</div>'; 
    return; 
  }
  
  const unitName = deptName(unitId);
  const currentQty = (inventory[unitId] && inventory[unitId][itemName]) || 0;
  const itemCode = getItemCode(itemName);
  const itemUnit = getItemUnit(itemName);
  
  // ===== موجودی ابتدای دوره =====
  const initEntries = initialInventory.filter(t => t.unit === unitId && t.item === itemName);
  let initialQty = initEntries.reduce((sum, t) => sum + t.qty, 0);
  
  // ===== تراکنش‌های قبل از تاریخ شروع =====
  const beforeTx = transactions.filter(t => 
    t.unit === unitId && t.item === itemName && 
    (!dateFrom || compareDates(parseDate(t.date), parseDate(dateFrom)))
  );
  
  beforeTx.forEach(t => {
    if(t.type === 'production' || t.type === 'excess' || t.type === 'input') initialQty += t.qty;
    else if(t.type === 'consume' || t.type === 'output' || t.type === 'waste' || t.type === 'shortage') initialQty -= t.qty;
  });
  
  // ===== تراکنش‌های در بازه =====
  const relatedTx = transactions.filter(t => 
    t.unit === unitId && t.item === itemName && isDateInRange(t.date, dateFrom, dateTo)
  );
  
  let totalProduction=0, totalInput=0, totalOutput=0, totalConsume=0, totalWaste=0, totalShortage=0, totalExcess=0;
  relatedTx.forEach(t => {
    if(t.type === 'production') totalProduction += t.qty;
    else if(t.type === 'input') totalInput += t.qty;
    else if(t.type === 'output') totalOutput += t.qty;
    else if(t.type === 'consume') totalConsume += t.qty;
    else if(t.type === 'waste') totalWaste += t.qty;
    else if(t.type === 'shortage') totalShortage += t.qty;
    else if(t.type === 'excess') totalExcess += t.qty;
  });
  
  const runningQty = initialQty + totalProduction + totalInput + totalExcess - totalOutput - totalConsume - totalWaste - totalShortage;
  
  // ===== نمایش کاردکس =====
  let html = `<div style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:8px;background:var(--accent-l);border-radius:8px">
      <span style="font-weight:700">🏭 ${unitName} - 📦 ${itemCode} - ${itemName}</span>
      <span style="font-size:12px;color:var(--sub)">واحد: ${itemUnit} | بازه: ${dateFrom || 'از ابتدا'} تا ${dateTo || 'تا کنون'} | موجودی فعلی: ${formatNumber(currentQty)}</span>
    </div>
  </div>`;
  
  if(relatedTx.length === 0 && initialQty === 0) {
    html += '<div class="empty">📭 هیچ تراکنشی در این بازه یافت نشد</div>';
    container.innerHTML = html;
    return;
  }
  
  html += `<table class="cardex-table"><thead><tr>
    <th>ردیف</th><th>شماره</th><th>تاریخ</th><th>کد کالا</th><th>نام کالا</th>
    <th>واحد</th><th>موجودی اول</th><th>تولید</th><th>ورود از بخش</th>
    <th style="color:var(--danger);">خروجی</th><th style="color:var(--danger);">مصرف</th>
    <th style="color:var(--danger);">ضایعات</th><th style="color:var(--danger);">کسری</th>
    <th>اضافات</th><th>موجودی</th>
  </tr></thead><tbody>
  <tr><td>1</td><td>-</td><td>${dateFrom || 'ابتدا'}</td><td>${itemCode}</td><td>${itemName}</td><td>${itemUnit}</td>
  <td><strong>${formatNumber(initialQty)}</strong></td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td><strong>${formatNumber(initialQty)}</strong></td></tr>`;
  
  let rowNum = 2;
  let running = initialQty;
  const sortedTx = [...relatedTx].sort((a,b) => {
    const da = parseDate(a.date), db = parseDate(b.date);
    if(!da || !db) return 0;
    if(da.year !== db.year) return da.year - db.year;
    if(da.month !== db.month) return da.month - db.month;
    return da.day - db.day;
  });
  
  sortedTx.forEach(t => {
    let prod='-', inp='-', out='-', cons='-', was='-', sh='-', exc='-';
    
    if(t.type === 'production') { prod = formatNumber(t.qty); running += t.qty; }
    else if(t.type === 'input') { inp = formatNumber(t.qty); running += t.qty; }
    else if(t.type === 'output') { out = formatNumber(t.qty); running -= t.qty; }
    else if(t.type === 'consume') { cons = formatNumber(t.qty); running -= t.qty; }
    else if(t.type === 'waste') { was = formatNumber(t.qty); running -= t.qty; }
    else if(t.type === 'shortage') { sh = formatNumber(t.qty); running -= t.qty; }
    else if(t.type === 'excess') { exc = formatNumber(t.qty); running += t.qty; }
    
    html += `<tr><td>${rowNum}</td><td>${t.id}</td><td>${t.date}</td><td>${itemCode}</td><td>${itemName}</td>
      <td>${itemUnit}</td>
      <td>${rowNum === 2 ? formatNumber(running) : '-'}</td>
      <td>${prod}</td><td>${inp}</td>
      <td style="color:var(--danger);">${out !== '-' ? '-'+out : '-'}</td>
      <td style="color:var(--danger);">${cons !== '-' ? '-'+cons : '-'}</td>
      <td style="color:var(--danger);">${was !== '-' ? '-'+was : '-'}</td>
      <td style="color:var(--danger);">${sh !== '-' ? '-'+sh : '-'}</td>
      <td>${exc}</td>
      <td><strong>${formatNumber(running)}</strong></td></tr>`;
    rowNum++;
  });
  
  html += `<tr class="total-row"><td colspan="6">جمع کل</td>
    <td>${formatNumber(initialQty)}</td>
    <td>${formatNumber(totalProduction)}</td>
    <td>${formatNumber(totalInput)}</td>
    <td style="color:var(--danger);">-${formatNumber(totalOutput)}</td>
    <td style="color:var(--danger);">-${formatNumber(totalConsume)}</td>
    <td style="color:var(--danger);">-${formatNumber(totalWaste)}</td>
    <td style="color:var(--danger);">-${formatNumber(totalShortage)}</td>
    <td>${formatNumber(totalExcess)}</td>
    <td><strong>${formatNumber(running)}</strong></td>
  </tr></tbody></table>
  <div style="margin-top:8px;font-size:11px;color:var(--sub)">
    📊 خلاصه: اول دوره: ${formatNumber(initialQty)} | 
    + تولید: ${formatNumber(totalProduction)} | 
    + ورود: ${formatNumber(totalInput)} | 
    - خروجی: ${formatNumber(totalOutput)} | 
    - مصرف: ${formatNumber(totalConsume)} | 
    - ضایعات: ${formatNumber(totalWaste)} | 
    - کسری: ${formatNumber(totalShortage)} | 
    + اضافات: ${formatNumber(totalExcess)} | 
    = موجودی: ${formatNumber(running)}
  </div>`;
  
  container.innerHTML = html;
}

function setCardexYearRange() {
  const activeFY = getActiveFiscalYear();
  document.getElementById('cardex-date-from').value = activeFY ? activeFY.startDate : `${activeFiscalYear}/01/01`;
  document.getElementById('cardex-date-to').value = activeFY ? activeFY.endDate : `${activeFiscalYear}/12/29`;
  renderCardex();
}

// ============================================
// ===== گزارش موجودی کل =====
// ============================================
function renderSummary() {
  const container = document.getElementById('summary-container');
  const isAdminUser = isAdmin();
  const deptId = getUserDeptId();
  const dateFrom = document.getElementById('summary-date-from').value;
  const dateTo = document.getElementById('summary-date-to').value;
  
  let units = [];
  if(isAdminUser) {
    units = DEPTS;
  } else {
    const userDept = DEPTS.find(d => d.id === deptId);
    if(userDept) units = [userDept];
  }
  
  let allHtml = '';
  
  units.forEach(unit => {
    const inv = inventory[unit.id] || {};
    const txItems = transactions.filter(t => t.unit === unit.id).map(t => t.item);
    const initItems = initialInventory.filter(t => t.unit === unit.id).map(t => t.item);
    const allItems = [...new Set([...Object.keys(inv), ...txItems, ...initItems])].filter(name => 
      inv[name] !== 0 || txItems.some(t => t === name) || initItems.some(t => t === name)
    );
    
    if(allItems.length === 0) { 
      if(!isAdminUser) allHtml = '<div class="empty">📭 هیچ موجودی برای نمایش وجود ندارد</div>'; 
      return; 
    }
    
    let html = `<div style="margin-bottom:20px;border-bottom:2px solid var(--line);padding-bottom:12px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:8px;background:var(--purple-l);border-radius:8px">
        <span style="font-weight:700">🏭 ${unit.name}</span>
        <span style="font-size:12px;color:var(--sub)">بازه: ${dateFrom || 'از ابتدا'} تا ${dateTo || 'تا کنون'} | تعداد کالاها: ${allItems.length}</span>
      </div>
      <table class="summary-table"><thead><tr>
        <th>ردیف</th><th>کد کالا</th><th>نام کالا</th><th>واحد</th>
        <th>موجودی اول</th><th>تولید</th><th>ورود از بخش</th>
        <th style="color:var(--danger);">خروجی</th>
        <th style="color:var(--danger);">مصرف</th>
        <th style="color:var(--danger);">ضایعات</th>
        <th style="color:var(--danger);">کسری</th>
        <th>اضافات</th><th>موجودی</th>
      </tr></thead><tbody>`;
    
    let rowNum=1, tProd=0,tInput=0,tOut=0,tCons=0,tWaste=0,tShort=0,tExcess=0;
    allItems.forEach(itemName => {
      const qty = inv[itemName] || 0;
      const itemCode = getItemCode(itemName);
      const unitType = getItemUnit(itemName);
      
      const initEntries = initialInventory.filter(t => t.unit === unit.id && t.item === itemName);
      let initialQty = initEntries.reduce((sum, t) => sum + t.qty, 0);
      
      const beforeTx = transactions.filter(t => 
        t.unit === unit.id && t.item === itemName && 
        (!dateFrom || compareDates(parseDate(t.date), parseDate(dateFrom)))
      );
      beforeTx.forEach(t => {
        if(t.type === 'production' || t.type === 'excess' || t.type === 'input') initialQty += t.qty;
        else if(t.type === 'consume' || t.type === 'output' || t.type === 'waste' || t.type === 'shortage') initialQty -= t.qty;
      });
      
      const relatedTx = transactions.filter(t => 
        t.unit === unit.id && t.item === itemName && isDateInRange(t.date, dateFrom, dateTo)
      );
      let pr=0,inp=0,out1=0,co=0,wa=0,sh=0,ex=0;
      relatedTx.forEach(t => { 
        if(t.type==='production') pr+=t.qty; 
        else if(t.type==='input') inp+=t.qty;
        else if(t.type==='output') out1+=t.qty; 
        else if(t.type==='consume') co+=t.qty; 
        else if(t.type==='waste') wa+=t.qty; 
        else if(t.type==='shortage') sh+=t.qty; 
        else if(t.type==='excess') ex+=t.qty; 
      });
      tProd+=pr; tInput+=inp; tOut+=out1; tCons+=co; tWaste+=wa; tShort+=sh; tExcess+=ex;
      
      const finalQty = initialQty + pr + ex + inp - out1 - co - wa - sh;
      
      html += `<tr>
        <td>${rowNum}</td>
        <td>${itemCode}</td><td>${itemName}</td><td>${unitType}</td>
        <td><strong>${formatNumber(initialQty)}</strong></td>
        <td>${formatNumber(pr)}</td><td>${formatNumber(inp)}</td>
        <td style="color:var(--danger);">-${formatNumber(out1)}</td>
        <td style="color:var(--danger);">-${formatNumber(co)}</td>
        <td style="color:var(--danger);">-${formatNumber(wa)}</td>
        <td style="color:var(--danger);">-${formatNumber(sh)}</td>
        <td>${formatNumber(ex)}</td>
        <td><strong>${formatNumber(finalQty)}</strong></td>
      </tr>`;
      rowNum++;
    });
    
    const totalQty = Object.values(inv).reduce((s,v) => s+v, 0);
    
    html += `<tr class="total-row"><td colspan="3">جمع کل</td><td>-</td>
      <td><strong>${formatNumber(totalQty)}</strong></td>
      <td><strong>${formatNumber(tProd)}</strong></td>
      <td><strong>${formatNumber(tInput)}</strong></td>
      <td style="color:var(--danger);"><strong>-${formatNumber(tOut)}</strong></td>
      <td style="color:var(--danger);"><strong>-${formatNumber(tCons)}</strong></td>
      <td style="color:var(--danger);"><strong>-${formatNumber(tWaste)}</strong></td>
      <td style="color:var(--danger);"><strong>-${formatNumber(tShort)}</strong></td>
      <td><strong>${formatNumber(tExcess)}</strong></td>
      <td><strong>${formatNumber(totalQty)}</strong></td>
    </tr></tbody></table></div>`;
    allHtml += html;
  });
  if(!allHtml) allHtml = '<div class="empty">📭 هیچ موجودی برای نمایش وجود ندارد</div>';
  container.innerHTML = allHtml;
}

function setSummaryYearRange() {
  const activeFY = getActiveFiscalYear();
  document.getElementById('summary-date-from').value = activeFY ? activeFY.startDate : `${activeFiscalYear}/01/01`;
  document.getElementById('summary-date-to').value = activeFY ? activeFY.endDate : `${activeFiscalYear}/12/29`;
  renderSummary();
}

// ============================================
// ===== گزارش روزانه =====
// ============================================
function fillReportForm() {
  const unit = document.getElementById('report-unit');
  
  unit.innerHTML = '';
  const deptList = isAdmin() ? DEPTS : DEPTS.filter(d => d.id === getUserDeptId());
  deptList.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    if(d.id === getUserDeptId()) option.selected = true;
    unit.appendChild(option);
  });
  
  const today = new Date().toLocaleDateString('fa-IR');
  document.getElementById('report-date').value = today;
  
  generateDailyReport();
}

function generateDailyReport() {
  const unitId = document.getElementById('report-unit').value;
  const reportDate = document.getElementById('report-date').value;
  const container = document.getElementById('report-container');
  
  if(!unitId) {
    container.innerHTML = '<div class="empty">لطفاً بخش را انتخاب کنید</div>';
    return;
  }
  
  const unitName = deptName(unitId);
  const inv = inventory[unitId] || {};
  const allItems = Object.keys(inv).filter(k => inv[k] !== 0);
  
  const todayTx = transactions.filter(t => 
    t.unit === unitId && t.date === reportDate
  );
  
  let totalProduction = 0, totalInput = 0, totalOutput = 0, totalConsume = 0, totalWaste = 0, totalShortage = 0, totalExcess = 0;
  const itemSummary = {};
  
  todayTx.forEach(t => {
    if(!itemSummary[t.item]) {
      itemSummary[t.item] = { production: 0, input: 0, output: 0, consume: 0, waste: 0, shortage: 0, excess: 0 };
    }
    if(t.type === 'production') { totalProduction += t.qty; itemSummary[t.item].production += t.qty; }
    else if(t.type === 'input') { totalInput += t.qty; itemSummary[t.item].input += t.qty; }
    else if(t.type === 'output') { totalOutput += t.qty; itemSummary[t.item].output += t.qty; }
    else if(t.type === 'consume') { totalConsume += t.qty; itemSummary[t.item].consume += t.qty; }
    else if(t.type === 'waste') { totalWaste += t.qty; itemSummary[t.item].waste += t.qty; }
    else if(t.type === 'shortage') { totalShortage += t.qty; itemSummary[t.item].shortage += t.qty; }
    else if(t.type === 'excess') { totalExcess += t.qty; itemSummary[t.item].excess += t.qty; }
  });
  
  let html = `
    <div class="report-header">
      <h2>📋 گزارش عملکرد روزانه</h2>
      <div class="report-meta">
        <span>🏭 بخش: <strong>${unitName}</strong></span>
        <span>📅 تاریخ: <strong>${reportDate}</strong></span>
        <span>🕐 زمان: <strong>${new Date().toLocaleTimeString('fa-IR')}</strong></span>
      </div>
    </div>
    
    <div class="report-summary">
      <div class="item"><div class="label">موجودی اول</div><div class="value gold">${formatNumber(0)}</div></div>
      <div class="item"><div class="label">🏭 تولید</div><div class="value gold">${formatNumber(totalProduction)}</div></div>
      <div class="item"><div class="label">📥 ورود از بخش</div><div class="value gold">${formatNumber(totalInput)}</div></div>
      <div class="item"><div class="label">📤 خروجی</div><div class="value danger">-${formatNumber(totalOutput)}</div></div>
      <div class="item"><div class="label">📤 مصرف</div><div class="value danger">-${formatNumber(totalConsume)}</div></div>
      <div class="item"><div class="label">🗑️ ضایعات</div><div class="value danger">-${formatNumber(totalWaste)}</div></div>
      <div class="item"><div class="label">📉 کسری</div><div class="value danger">-${formatNumber(totalShortage)}</div></div>
      <div class="item"><div class="label">📈 اضافات</div><div class="value gold">${formatNumber(totalExcess)}</div></div>
    </div>
  `;
  
  if(allItems.length > 0) {
    html += `
      <table class="report-table">
        <thead>
          <tr>
            <th>ردیف</th><th>کد</th><th>نام کالا</th><th>واحد</th>
            <th>موجودی اول</th><th>تولید</th><th>ورود از بخش</th>
            <th style="color:var(--danger);">خروجی</th>
            <th style="color:var(--danger);">مصرف</th>
            <th style="color:var(--danger);">ضایعات</th>
            <th style="color:var(--danger);">کسری</th>
            <th>اضافات</th>
            <th>موجودی پایان</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    let rowNum = 1;
    allItems.forEach(item => {
      const code = getItemCode(item);
      const unit = getItemUnit(item);
      const sum = itemSummary[item] || { production: 0, input: 0, output: 0, consume: 0, waste: 0, shortage: 0, excess: 0 };
      const endQty = inv[item] || 0;
      
      // محاسبه موجودی اول
      let startQty = endQty;
      todayTx.filter(t => t.item === item).forEach(t => {
        if(t.type === 'production' || t.type === 'input' || t.type === 'excess') startQty -= t.qty;
        else if(t.type === 'output' || t.type === 'consume' || t.type === 'waste' || t.type === 'shortage') startQty += t.qty;
      });
      
      html += `
        <tr>
          <td>${rowNum}</td>
          <td>${code}</td>
          <td>${item}</td>
          <td>${unit}</td>
          <td><strong>${formatNumber(startQty)}</strong></td>
          <td>${formatNumber(sum.production)}</td>
          <td>${formatNumber(sum.input)}</td>
          <td style="color:var(--danger);">-${formatNumber(sum.output)}</td>
          <td style="color:var(--danger);">-${formatNumber(sum.consume)}</td>
          <td style="color:var(--danger);">-${formatNumber(sum.waste)}</td>
          <td style="color:var(--danger);">-${formatNumber(sum.shortage)}</td>
          <td>${formatNumber(sum.excess)}</td>
          <td><strong>${formatNumber(endQty)}</strong></td>
        </tr>
      `;
      rowNum++;
    });
    
    html += `
        </tbody>
        <tfoot>
          <tr class="total-row">
            <td colspan="3">جمع کل</td><td>-</td>
            <td>-</td>
            <td>${formatNumber(totalProduction)}</td>
            <td>${formatNumber(totalInput)}</td>
            <td style="color:var(--danger);">-${formatNumber(totalOutput)}</td>
            <td style="color:var(--danger);">-${formatNumber(totalConsume)}</td>
            <td style="color:var(--danger);">-${formatNumber(totalWaste)}</td>
            <td style="color:var(--danger);">-${formatNumber(totalShortage)}</td>
            <td>${formatNumber(totalExcess)}</td>
            <td>-</td>
          </tr>
        </tfoot>
      </table>
    `;
  } else {
    html += `<div class="empty">📭 هیچ کالایی در این بخش وجود ندارد</div>`;
  }
  
  html += `
    <div class="report-signature">
      <div class="sig-item"><div class="line"></div><div class="label">امضاسرپرست بخش</div></div>
      <div class="sig-item"><div class="line"></div><div class="label">امضای مدیر انبار</div></div>
      <div class="sig-item"><div class="line"></div><div class="label">امضای مدیر کارخانه</div></div>
    </div>
  `;
  
  container.innerHTML = html;
}

function printReport() {
  window.print();
}

// ============================================
// ===== توابع داشبورد و تاریخچه =====
// ============================================
function renderDashboard() {
  const grid = document.getElementById('dash-grid');
  const title = document.getElementById('dash-title');
  const hint = document.getElementById('dash-hint');
  grid.innerHTML = '';
  const isAdminUser = isAdmin();
  const userUnit = getUserUnit();
  const list = isAdminUser ? DEPTS : DEPTS.filter(d => d.name===userUnit);
  title.textContent = isAdminUser ? '📊 موجودی همه بخش‌ها' : `📊 موجودی ${userUnit}`;
  hint.textContent = isAdminUser ? '' : 'فقط موجودی بخش خود را می‌بینید.';
  
  list.forEach(d => {
    const inv = inventory[d.id] || {};
    const rows = Object.entries(inv).filter(([k,v]) => v!==0);
    const card = document.createElement('div'); card.className = 'card';
    const itemsList = rows.map(([k,v]) => {
      const code = getItemCode(k);
      const unit = getItemUnit(k);
      const statusClass = v <= 0 ? 'low' : 'high';
      return `<tr><td><span class="code-cell">${code}</span>${k}</td><td class="${statusClass}">${formatNumber(v)} ${unit}</td></tr>`;
    }).join('');
    card.innerHTML = `<h3>${d.name} <span class="pill ${d.type==='wh'?'wh':d.type==='qc'?'qc':'stage'}">${d.type==='wh'?'انبار':d.type==='qc'?'کنترل کیفیت':'ایستگاه'}</span></h3>
      <table>${rows.length ? itemsList : '<tr><td colspan=2 style="color:var(--sub)">خالی</td></tr>'}</table>`;
    grid.appendChild(card);
  });
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const isAdminUser = isAdmin();
  const userUnit = getUserUnit();
  document.getElementById('history-title').textContent = isAdminUser ? '📜 تاریخچه کامل' : `📜 تاریخچه ${userUnit}`;
  const userDeptId = getUserDeptId();
  const list2 = isAdminUser ? transactions : transactions.filter(t => t.unit===userDeptId);
  
  if(!list2.length) { 
    list.innerHTML='<div class="empty">تاریخچه خالی</div>'; 
    return; 
  }
  
  const typeLabels = {
    'production':'🏭 تولید','consume':'📤 مصرف','output':'📤 خروج',
    'waste':'🗑️ ضایعات','shortage':'📉 کسری','excess':'📈 اضافات',
    'initial':'📊 موجودی اولیه','return':'↩️ برگشت','input':'📥 ورود از بخش'
  };
  
  // ===== نمایش به صورت جدول =====
  let html = `
    <div style="overflow-x:auto;margin-top:8px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;direction:rtl;">
        <thead>
          <tr style="background:var(--purple);color:#fff;">
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">ردیف</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">تاریخ</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">نوع</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">کالا</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">تعداد</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">از بخش</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">به بخش</th>
            <th style="padding:6px 8px;text-align:center;border:1px solid var(--purple);">توضیح</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  const sortedTx = [...list2].reverse();
  sortedTx.forEach((t, index) => {
    const fromDept = t.sourceUnit ? deptName(t.sourceUnit) : (t.unit ? deptName(t.unit) : '');
    const toDept = t.targetUnit ? deptName(t.targetUnit) : '';
    const typeName = typeLabels[t.type] || t.type;
    
    // تعیین علامت عدد
    let qtyDisplay = formatNumber(t.qty);
    if (t.type === 'output' || t.type === 'consume' || t.type === 'waste' || t.type === 'shortage') {
      qtyDisplay = '-' + qtyDisplay;
    }
    
    html += `
      <tr style="border-bottom:1px solid var(--line);${index % 2 === 0 ? 'background:#f8fafc;' : ''}">
        <td style="padding:4px 8px;text-align:center;">${index + 1}</td>
        <td style="padding:4px 8px;text-align:center;">${t.date}</td>
        <td style="padding:4px 8px;text-align:center;">${typeName}</td>
        <td style="padding:4px 8px;text-align:center;">${t.item}</td>
        <td style="padding:4px 8px;text-align:center;font-weight:700;${t.type === 'output' || t.type === 'consume' || t.type === 'waste' || t.type === 'shortage' ? 'color:var(--danger);' : 'color:var(--green);'}">
          ${qtyDisplay}
        </td>
        <td style="padding:4px 8px;text-align:center;">${fromDept}</td>
        <td style="padding:4px 8px;text-align:center;">${toDept}</td>
        <td style="padding:4px 8px;text-align:center;font-size:11px;color:var(--sub);">${t.note || ''}</td>
      </tr>
    `;
  });
  
  html += `
        </tbody>
        <tfoot>
          <tr style="background:var(--purple-l);font-weight:700;">
            <td colspan="8" style="padding:6px 8px;text-align:center;">
              📊 تعداد کل تراکنش‌ها: ${sortedTx.length}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
  
  list.innerHTML = html;
}

// ============================================
// ===== توابع ثبت موجودی اولیه =====
// ============================================
function fillInitialInventoryForm() {
  const unit = document.getElementById('initial-unit');
  
  unit.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    unit.appendChild(option);
  });
  
  document.getElementById('initial-item-search').placeholder = 'جستجوی کالا...';
  document.getElementById('initial-item').value = '';
}

function filterInitialItems() {
  const search = document.getElementById('initial-item-search').value.trim();
  const suggestions = document.getElementById('initial-suggestions');
  
  if(!search) {
    suggestions.classList.remove('show');
    return;
  }
  
  const filtered = items.filter(i => 
    i.name.toLowerCase().includes(search.toLowerCase()) || 
    i.code.toLowerCase().includes(search.toLowerCase())
  );
  
  if(filtered.length === 0) {
    suggestions.innerHTML = '<div style="color:var(--sub);padding:8px 12px;">کالایی یافت نشد</div>';
    suggestions.classList.add('show');
    return;
  }
  
  suggestions.innerHTML = filtered.map(i => 
    `<div onclick="selectInitialItem('${i.name}')">
      <span>${i.name}</span>
      <span class="code">${i.code}</span>
    </div>`
  ).join('');
  suggestions.classList.add('show');
}

function selectInitialItem(name) {
  document.getElementById('initial-item-search').value = name;
  document.getElementById('initial-item').value = name;
  document.getElementById('initial-suggestions').classList.remove('show');
}

async function registerInitialInventory() {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  
  const unit = document.getElementById('initial-unit').value;
  const item = document.getElementById('initial-item').value;
  const qty = parseInt(document.getElementById('initial-qty').value)||0;
  const msg = document.getElementById('initial-msg');
  
  if(!unit || !item) { msg.innerHTML='<span class="tag-waste">⚠️ بخش و کالا را انتخاب کنید</span>'; return; }
  if(qty < 0) { msg.innerHTML='<span class="tag-waste">⚠️ تعداد نمی‌تواند منفی باشد</span>'; return; }
  
  if(!items.find(i => i.name === item)) {
    msg.innerHTML='<span class="tag-waste">⚠️ کالا در لیست کالاها وجود ندارد</span>';
    return;
  }
  
  initialInventory.push({
    unit: unit,
    item: item,
    qty: qty,
    date: new Date().toLocaleDateString('fa-IR'),
    fiscalYear: activeFiscalYear
  });
  
  if(!inventory[unit]) inventory[unit] = {};
  if(!inventory[unit][item]) inventory[unit][item] = 0;
  inventory[unit][item] += qty;
  
  const tx = {
    id: seqId++, 
    date: new Date().toLocaleDateString('fa-IR'), 
    type: 'initial',
    unit: unit,
    item: item,
    qty: qty,
    note: 'موجودی اول دوره',
    targetUnit: '',
    fiscalYear: activeFiscalYear
  };
  transactions.push(tx);
  
  const doc = {
    id: docSeq++,
    date: new Date().toLocaleDateString('fa-IR'),
    type: 'initial',
    unit: unit,
    item: item,
    qty: qty,
    fromUnit: '',
    toUnit: '',
    note: 'موجودی اول دوره',
    status: 'approved',
    fiscalYear: activeFiscalYear,
    createdBy: currentUser ? currentUser.username : 'سیستم',
    transactionId: tx.id,
    parentDocId: null
  };
  docs.push(doc);
  
  await saveData();
  msg.innerHTML=`<span style="color:var(--accent)">✅ موجودی اولیه ${formatNumber(qty)} ${item} برای ${deptName(unit)} ثبت شد</span>`;
  document.getElementById('initial-qty').value = 0;
  document.getElementById('initial-item-search').value = '';
  document.getElementById('initial-item').value = '';
  showToast(`✅ موجودی اولیه ثبت شد`);
  renderAll();
}

// ============================================
// ===== توابع مدیریت محصولات بخش (خلاصه) =====
// ============================================
function fillProductMgmtForm() {
  const select = document.getElementById('product-dept');
  select.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    select.appendChild(option);
  });
  document.getElementById('product-code').value = '';
  document.getElementById('product-name').value = '';
  document.getElementById('product-group').value = '';
  
  setTimeout(() => {
    loadDeptProducts();
  }, 300);
}

async function saveProductDefinition() {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  
  const dept = document.getElementById('product-dept').value;
  const code = document.getElementById('product-code').value.trim();
  const name = document.getElementById('product-name').value.trim();
  const group = document.getElementById('product-group').value.trim() || 'متفرقه';
  const unit = document.getElementById('product-unit').value;
  const msg = document.getElementById('product-msg');
  
  if(!dept) {
    msg.innerHTML = '⚠️ بخش را انتخاب کنید';
    msg.style.color = 'var(--danger)';
    return;
  }
  
  if(!code || !name) {
    msg.innerHTML = '⚠️ کد و عنوان محصول الزامی است';
    msg.style.color = 'var(--danger)';
    return;
  }
  
  const products = getDeptProducts(dept);
  if(products.find(p => p.code === code)) {
    msg.innerHTML = `⚠️ کد ${code} قبلاً برای این بخش ثبت شده است`;
    msg.style.color = 'var(--danger)';
    return;
  }
  
  if(products.find(p => p.name === name)) {
    msg.innerHTML = `⚠️ محصول "${name}" قبلاً برای این بخش ثبت شده است`;
    msg.style.color = 'var(--danger)';
    return;
  }
  
  if(!productDefinitions[dept]) {
    productDefinitions[dept] = [];
  }
  
  productDefinitions[dept].push({
    code: code,
    name: name,
    group: group,
    unit: unit,
    created: new Date().toISOString()
  });
  
  await saveData();
  
  document.getElementById('product-code').value = '';
  document.getElementById('product-name').value = '';
  document.getElementById('product-group').value = '';
  
  msg.innerHTML = `✅ محصول "${name}" با کد ${code} برای ${deptName(dept)} با موفقیت تعریف شد`;
  msg.style.color = 'var(--green)';
  
  loadDeptProducts();
  showToast(`✅ محصول "${name}" برای ${deptName(dept)} تعریف شد`);
}

function openEditProductModal(deptId, productCode) {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  
  const products = getDeptProducts(deptId);
  const product = products.find(p => p.code === productCode);
  if(!product) {
    showToast('⚠️ محصول یافت نشد', true);
    return;
  }
  
  editingProduct = { dept: deptId, code: productCode };
  
  document.getElementById('edit-product-dept').value = deptId;
  document.getElementById('edit-product-old-code').value = productCode;
  document.getElementById('edit-product-code').value = product.code;
  document.getElementById('edit-product-name').value = product.name;
  document.getElementById('edit-product-group').value = product.group || 'متفرقه';
  document.getElementById('edit-product-unit').value = product.unit || 'عدد';
  
  document.getElementById('editProductModal').classList.add('open');
}

function closeEditProductModal() {
  document.getElementById('editProductModal').classList.remove('open');
  editingProduct = null;
}

async function saveProductEdit() {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  
  const dept = document.getElementById('edit-product-dept').value;
  const oldCode = document.getElementById('edit-product-old-code').value;
  const code = document.getElementById('edit-product-code').value.trim();
  const name = document.getElementById('edit-product-name').value.trim();
  const group = document.getElementById('edit-product-group').value.trim() || 'متفرقه';
  const unit = document.getElementById('edit-product-unit').value;
  
  if(!name) {
    showToast('⚠️ عنوان محصول الزامی است', true);
    return;
  }
  
  const products = getDeptProducts(dept);
  const index = products.findIndex(p => p.code === oldCode);
  if(index === -1) {
    showToast('⚠️ محصول یافت نشد', true);
    return;
  }
  
  if(code !== oldCode && products.find(p => p.code === code && p.code !== oldCode)) {
    showToast(`⚠️ کد ${code} قبلاً برای این بخش ثبت شده است`, true);
    return;
  }
  
  if(name !== products[index].name && products.find(p => p.name === name && p.code !== oldCode)) {
    showToast(`⚠️ محصول "${name}" قبلاً برای این بخش ثبت شده است`, true);
    return;
  }
  
  products[index].code = code;
  products[index].name = name;
  products[index].group = group;
  products[index].unit = unit;
  
  await saveData();
  closeEditProductModal();
  loadDeptProducts();
  showToast(`✅ محصول "${name}" با موفقیت ویرایش شد`);
}

async function deleteDeptProduct(deptId, productCode) {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  
  const products = getDeptProducts(deptId);
  const product = products.find(p => p.code === productCode);
  if(!product) {
    showToast('⚠️ محصول یافت نشد', true);
    return;
  }
  
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید محصول "${product.name}" را حذف کنید؟`)) return;
  
  const inTransactions = transactions.some(t => t.item === product.name && t.type === 'production' && t.unit === deptId);
  const inDocs = docs.some(d => d.item === product.name && d.type === 'production' && d.unit === deptId);
  
  if(inTransactions || inDocs) {
    showToast(`⚠️ محصول "${product.name}" در تولید استفاده شده است، قابل حذف نیست`, true);
    return;
  }
  
  const index = products.findIndex(p => p.code === productCode);
  if(index !== -1) {
    products.splice(index, 1);
    await saveData();
    selectedProductForDelete = null;
    loadDeptProducts();
    showToast(`🗑️ محصول "${product.name}" حذف شد`);
  }
}

function loadDeptProducts() {
  const dept = document.getElementById('product-dept').value;
  const container = document.getElementById('dept-products-list');
  const search = document.getElementById('product-search-filter')?.value.trim().toLowerCase() || '';
  
  let products = getDeptProducts(dept);
  
  if(search) {
    products = products.filter(p => 
      (p.code && p.code.toLowerCase().includes(search)) || 
      (p.name && p.name.toLowerCase().includes(search)) || 
      (p.group && p.group.toLowerCase().includes(search))
    );
  }
  
  if(products.length === 0) {
    container.innerHTML = '<div class="empty">📭 هیچ محصولی برای این بخش تعریف نشده است</div>';
    return;
  }
  
  products.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fa'));
  
  let html = `
    <div style="overflow-x:auto;">
      <table class="products-table">
        <thead>
          <tr>
            <th style="width:40px;">#</th>
            <th>کد محصول</th>
            <th>عنوان محصول</th>
            <th>گروه</th>
            <th>واحد</th>
            <th>تاریخ ایجاد</th>
            <th style="width:180px;">عملیات</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  products.forEach((p, index) => {
    const isSelected = selectedProductForDelete === p.code;
    const createdDate = p.created ? new Date(p.created).toLocaleDateString('fa-IR') : '---';
    
    html += `
      <tr class="${isSelected ? 'selected-row' : ''}">
        <td style="text-align:center;">${index + 1}</td>
        <td style="font-weight:700;color:var(--accent);">${p.code || '---'}</td>
        <td>${p.name}</td>
        <td><span style="background:var(--purple-l);padding:2px 8px;border-radius:12px;font-size:11px;">${p.group || 'متفرقه'}</span></td>
        <td><span style="background:var(--accent-l);padding:2px 8px;border-radius:12px;font-size:11px;">${p.unit || 'عدد'}</span></td>
        <td style="font-size:11px;color:var(--sub);">${createdDate}</td>
        <td style="text-align:center;">
          <button onclick="openEditProductModal('${dept}', '${p.code}')" class="edit-btn" style="margin:2px;">✏️ ویرایش</button>
          <button onclick="selectProductForDelete('${p.code}')" 
                  style="background:${isSelected ? 'var(--danger)' : 'var(--accent)'};color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">
            ${isSelected ? '✅ انتخاب' : '☐ انتخاب'}
          </button>
          <button class="danger" onclick="deleteDeptProduct('${dept}', '${p.code}')" style="padding:4px 10px;font-size:11px;margin:2px;">🗑️</button>
        </td>
      </tr>
    `;
  });
  
  html += `
        </tbody>
        <tfoot>
          <tr class="total-row">
            <td colspan="7" style="padding:8px;text-align:center;">
              📊 تعداد کل محصولات: ${products.length} 
              ${search ? `(فیلتر شده از ${getDeptProducts(dept).length})` : ''}
              ${selectedProductForDelete ? ` | ✅ محصول انتخاب شده: ${selectedProductForDelete}` : ''}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
  
  container.innerHTML = html;
}

function filterProductList() {
  loadDeptProducts();
}

function selectProductForDelete(code) {
  if(selectedProductForDelete === code) {
    selectedProductForDelete = null;
  } else {
    selectedProductForDelete = code;
  }
  loadDeptProducts();
}

async function generateProductsFromDept() {
    if(!isAdmin()) {
        showToast('⚠️ فقط مدیر', true);
        return;
    }
    
    const targetDept = document.getElementById('product-dept').value;
    if(!targetDept) {
        showToast('⚠️ ابتدا بخش مقصد را انتخاب کنید', true);
        return;
    }
    
    const deptOptions = DEPTS.map(d => `${d.id}: ${d.name}`).join('\n');
    const sourceDeptId = prompt(
        `📂 بخش مبدأ را انتخاب کنید (محصولات از کدام بخش خوانده شوند)\n\n` +
        `بخش‌های موجود:\n${deptOptions}\n\n` +
        `شناسه بخش را وارد کنید (مثال: cut, solder, laser, ...)`
    );
    
    if(!sourceDeptId) {
        showToast('⚠️ عملیات لغو شد', true);
        return;
    }
    
    const cleanSourceDept = sourceDeptId.trim();
    const sourceDept = DEPTS.find(d => d.id === cleanSourceDept);
    if(!sourceDept) {
        showToast(`⚠️ بخش "${cleanSourceDept}" یافت نشد`, true);
        return;
    }
    
    const sourceProducts = productDefinitions[cleanSourceDept] || [];
    if(sourceProducts.length === 0) {
        showToast(`⚠️ بخش ${sourceDept.name} هیچ محصولی ندارد`, true);
        return;
    }
    
    const suffix = prompt(
        `📝 متنی که باید به انتهای نام محصولات اضافه شود را وارد کنید\n` +
        `مثال: A2  یا  Z MAX  یا  ANKER\n\n` +
        `📌 ${sourceProducts.length} محصول از بخش ${sourceDept.name} خوانده خواهد شد`
    );
    
    if(suffix === null) {
        showToast('⚠️ عملیات لغو شد', true);
        return;
    }
    
    if(!suffix.trim()) {
        showToast('⚠️ متنی برای اضافه کردن وارد نشد', true);
        return;
    }
    
    const cleanSuffix = suffix.trim();
    
    const targetProducts = productDefinitions[targetDept] || [];
    let lastCode = 0;
    for (const p of targetProducts) {
        const codeNum = parseInt(p.code);
        if(!isNaN(codeNum) && codeNum > lastCode) {
            lastCode = codeNum;
        }
    }
    
    let startCode = lastCode + 1;
    if(lastCode === 0) {
        const codeInput = prompt(
            `🔢 کد شروع را وارد کنید\n` +
            `(چون بخش ${deptName(targetDept)} محصولی ندارد، کد شروع را مشخص کنید)\n` +
            `مثال: 333000015400`
        );
        if(!codeInput) {
            showToast('⚠️ عملیات لغو شد', true);
            return;
        }
        startCode = parseInt(codeInput);
        if(isNaN(startCode)) {
            showToast('⚠️ کد شروع معتبر نیست', true);
            return;
        }
    } else {
        if(!await customConfirmModal(`✅ آخرین کد محصول: ${lastCode}\nکدهای جدید از ${startCode} شروع می‌شوند. ادامه؟`)) {
            showToast('⚠️ عملیات لغو شد', true);
            return;
        }
    }
    
    let counter = startCode;
    let created = 0;
    let skipped = 0;
    
    const statusEl = document.getElementById('laser-generate-status');
    if(statusEl) {
        statusEl.innerHTML = `⏳ در حال ایجاد محصولات با پسوند "${cleanSuffix}"...`;
        statusEl.style.color = 'var(--blue)';
    }
    
    if(!productDefinitions[targetDept]) {
        productDefinitions[targetDept] = [];
    }
    
    for (const p of sourceProducts) {
        const newName = `${p.name} - ${cleanSuffix}`;
        const code = String(counter++);
        
        const existing = productDefinitions[targetDept].find(item => 
            item.code === code || item.name === newName
        );
        
        if(existing) {
            skipped++;
            continue;
        }
        
        productDefinitions[targetDept].push({
            code: code,
            name: newName,
            group: p.group || deptName(targetDept),
            unit: p.unit || 'عدد',
            created: new Date().toISOString()
        });
        created++;
    }
    
    if(created === 0) {
        if(statusEl) {
            statusEl.innerHTML = `⚠️ هیچ محصول جدیدی ایجاد نشد (${skipped} مورد تکراری)`;
            statusEl.style.color = 'var(--warn)';
        }
        showToast('⚠️ هیچ محصول جدیدی ایجاد نشد', true);
        return;
    }
    
    await saveData();
    
    if(statusEl) {
        statusEl.innerHTML = `✅ ${created} محصول با پسوند "${cleanSuffix}" ایجاد شد`;
        statusEl.style.color = 'var(--green)';
    }
    
    loadDeptProducts();
    showToast(`✅ ${created} محصول با پسوند "${cleanSuffix}" ایجاد شد`);
    fillProductionForm();
}

async function clearDeptProducts() {
    if(!isAdmin()) {
        showToast('⚠️ فقط مدیر', true);
        return;
    }
    
    const dept = document.getElementById('product-dept').value;
    if(!dept) {
        showToast('⚠️ ابتدا بخش را انتخاب کنید', true);
        return;
    }
    
    const count = productDefinitions[dept] ? productDefinitions[dept].length : 0;
    
    if(count === 0) {
        showToast(`⚠️ بخش ${deptName(dept)} محصولی ندارد`, true);
        return;
    }
    
    if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید همه ${count} محصول بخش ${deptName(dept)} را حذف کنید؟`)) {
        return;
    }
    
    const statusEl = document.getElementById('laser-generate-status');
    if(statusEl) {
        statusEl.innerHTML = '⏳ در حال حذف محصولات...';
        statusEl.style.color = 'var(--danger)';
    }
    
    if(productDefinitions[dept]) {
        productDefinitions[dept] = [];
        await saveData();
        loadDeptProducts();
        if(statusEl) {
            statusEl.innerHTML = `🗑️ ${count} محصول از بخش ${deptName(dept)} حذف شد`;
            statusEl.style.color = 'var(--danger)';
        }
        showToast(`🗑️ ${count} محصول از بخش ${deptName(dept)} حذف شد`);
        fillProductionForm();
    }
}

// ============================================
// ===== توابع فرم تولید =====
// ============================================
function fillProductionForm() {
  const unit = document.getElementById('prod-unit');
  restrictToUserUnit('prod-unit', 'prod-unit-lock');
  
  const deptId = unit.value;
  const products = getDeptProducts(deptId);
  
  const searchInput = document.getElementById('prod-item-search');
  searchInput.placeholder = 'جستجوی محصول...';
  document.getElementById('prod-item').value = '';
  
  if(products.length === 0) {
    searchInput.placeholder = '⚠️ ابتدا محصول تعریف کنید';
    searchInput.style.color = 'var(--danger)';
  } else {
    searchInput.placeholder = 'جستجوی محصول...';
    searchInput.style.color = 'inherit';
  }
  
  searchInput.oninput = function() {
    const search = this.value.trim();
    const suggestions = document.getElementById('prod-suggestions');
    
    if(!search) {
      suggestions.classList.remove('show');
      return;
    }
    
    const filtered = products.filter(p => 
      (p.name && p.name.toLowerCase().includes(search.toLowerCase())) || 
      (p.code && p.code.toLowerCase().includes(search.toLowerCase()))
    );
    
    if(filtered.length === 0) {
      suggestions.innerHTML = '<div style="color:var(--sub);padding:8px 12px;">محصولی یافت نشد</div>';
      suggestions.classList.add('show');
      return;
    }
    
    suggestions.innerHTML = filtered.map(p => 
      `<div onclick="selectProdItem('${p.name}')" style="cursor:pointer;padding:8px 12px;border-bottom:1px solid var(--line);">
        <span style="font-weight:700;color:var(--accent);">${p.code || '---'}</span>
        <span>${p.name}</span>
        <span style="font-size:10px;color:var(--sub);background:var(--accent-l);padding:2px 8px;border-radius:12px;margin-right:8px;">${p.unit || 'عدد'}</span>
      </div>`
    ).join('');
    suggestions.classList.add('show');
  };
  
  unit.onchange = function() {
    const newDeptId = this.value;
    const newProducts = getDeptProducts(newDeptId);
    
    document.getElementById('prod-item-search').value = '';
    document.getElementById('prod-item').value = '';
    document.getElementById('prod-suggestions').classList.remove('show');
    
    if(newProducts.length === 0) {
      const searchInput = document.getElementById('prod-item-search');
      searchInput.placeholder = '⚠️ ابتدا محصول تعریف کنید';
      searchInput.style.color = 'var(--danger)';
    } else {
      const searchInput = document.getElementById('prod-item-search');
      searchInput.placeholder = 'جستجوی محصول...';
      searchInput.style.color = 'inherit';
    }
    
    loadAvailableMaterialsForTable();
  };
  
  materialRows = [];
  materialRowId = 0;
  renderMaterialTable();
  
  setTimeout(() => {
    loadAvailableMaterialsForTable();
  }, 500);
}

function filterProdItems() {}

function selectProdItem(name) {
  document.getElementById('prod-item-search').value = name;
  document.getElementById('prod-item').value = name;
  document.getElementById('prod-suggestions').classList.remove('show');
  
  const deptId = document.getElementById('prod-unit').value;
  const products = getDeptProducts(deptId);
  const product = products.find(p => p.name === name);
  if(product && product.unit) {
    document.getElementById('prod-unit-type').value = product.unit;
  }
}

function toggleProdMethod() {
  const method = document.getElementById('prod-method').value;
  const section = document.getElementById('prod-materials-section');
  
  if (method === 'from-materials') {
    section.style.display = 'block';
    loadAvailableMaterialsForTable();
  } else {
    section.style.display = 'none';
    materialRows = [];
    renderMaterialTable();
  }
}

function renderMaterialTable() {
  const tbody = document.getElementById('materials-tbody');
  if (!tbody) return;
  document.querySelectorAll('#materials-tbody tr').forEach((tr, index) => {
    const td = tr.querySelector('td:first-child');
    if (td) td.textContent = index + 1;
  });
  updateMaterialSummary();
}

function loadAvailableMaterialsForTable() {
  const unit = document.getElementById('prod-unit').value;
  if (!unit) return;
  
  const inputDocs = docs.filter(d => 
    d.type === 'output' && 
    d.toUnit === unit && 
    d.status === 'approved'
  );
  const returnDocs = docs.filter(d => 
    d.type === 'return' && 
    d.toUnit === unit && 
    d.status === 'return_approved'
  );
  const materialMap = {};
  
  inputDocs.forEach(d => {
    if (!materialMap[d.item]) {
      materialMap[d.item] = {
        item: d.item,
        totalReceived: 0,
        consumed: 0,
        available: 0,
        sourceUnit: d.fromUnit,
        unit: getItemUnit(d.item)
      };
    }
    materialMap[d.item].totalReceived += d.qty;
  });
  returnDocs.forEach(d => {
    if (!materialMap[d.item]) {
      materialMap[d.item] = {
        item: d.item,
        totalReceived: 0,
        consumed: 0,
        available: 0,
        sourceUnit: d.fromUnit,
        unit: getItemUnit(d.item)
      };
    }
    materialMap[d.item].totalReceived += d.qty;
  });
  const consumeDocs = docs.filter(d => 
    (d.type === 'consume' || d.type === 'waste') && 
    d.unit === unit && 
    d.status === 'approved'
  );
  consumeDocs.forEach(d => {
    if (materialMap[d.item]) {
      materialMap[d.item].consumed += d.qty;
    }
  });
  
  const inv = inventory[unit] || {};
  const availableMaterials = Object.values(materialMap)
    .map(m => ({
      ...m,
      available: inv[m.item] || 0
    }))
    .filter(m => m.available > 0);
  
  Object.keys(inv).forEach(itemName => {
    if (inv[itemName] > 0 && !materialMap[itemName]) {
      availableMaterials.push({
        item: itemName,
        totalReceived: 0,
        consumed: 0,
        available: inv[itemName],
        sourceUnit: 'موجودی موجود',
        unit: getItemUnit(itemName)
      });
    }
  });
  
  if (materialRows.length === 0 && availableMaterials.length > 0) {
    addMaterialRow();
  }
  updateMaterialSelects(availableMaterials);
}

function updateMaterialSelects(availableMaterials) {
  const selects = document.querySelectorAll('.material-select');
  const inv = inventory[document.getElementById('prod-unit').value] || {};
  
  selects.forEach(select => {
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- انتخاب کالا --</option>';
    
    availableMaterials.forEach(m => {
      const option = document.createElement('option');
      option.value = m.item;
      const actualQty = inv[m.item] || 0;
      option.textContent = `${m.item} (موجود: ${formatNumber(actualQty)} ${m.unit})`;
      option.dataset.unit = m.unit;
      option.dataset.available = actualQty;
      select.appendChild(option);
    });
    
    if (currentValue && availableMaterials.find(m => m.item === currentValue)) {
      select.value = currentValue;
    }
  });
  
  document.querySelectorAll('.material-select').forEach(select => {
    select.onchange = function() {
      const row = this.closest('tr');
      const unitInput = row.querySelector('.material-unit');
      const selectedOption = this.options[this.selectedIndex];
      if (selectedOption && selectedOption.dataset.unit) {
        unitInput.value = selectedOption.dataset.unit;
      }
      updateMaterialSummary();
    };
  });
  
  updateMaterialSummary();
}

function addMaterialRow() {
  const tbody = document.getElementById('materials-tbody');
  const rowId = ++materialRowId;
  const unit = document.getElementById('prod-unit').value;
  const inv = inventory[unit] || {};
  
  const availableItems = Object.keys(inv)
    .filter(name => inv[name] > 0)
    .map(name => ({
      item: name,
      unit: getItemUnit(name),
      available: inv[name]
    }));
  
  let options = '<option value="">-- انتخاب کالا --</option>';
  availableItems.forEach(m => {
    options += `<option value="${m.item}" data-unit="${m.unit}" data-available="${m.available}">${m.item} (موجود: ${formatNumber(m.available)} ${m.unit})</option>`;
  });
  
  const row = document.createElement('tr');
  row.id = `material-row-${rowId}`;
  row.innerHTML = `
    <td style="text-align:center;">${rowId}</td>
    <td><select class="material-select" style="width:100%;padding:4px 6px;border:1px solid var(--line);border-radius:4px;font-size:12px;">${options}</select></td>
    <td><input type="text" class="material-unit" value="" readonly style="width:100%;padding:4px 6px;border:1px solid var(--line);border-radius:4px;font-size:12px;background:#f5f5f5;"></td>
    <td><input type="number" class="material-qty" min="1" value="1" style="width:100%;padding:4px 6px;border:1px solid var(--line);border-radius:4px;font-size:12px;"></td>
    <td><button class="remove-row-btn" onclick="removeMaterialRow(${rowId})">✕</button></td>
  `;
  tbody.appendChild(row);
  
  const select = row.querySelector('.material-select');
  select.onchange = function() {
    const unitInput = row.querySelector('.material-unit');
    const selectedOption = this.options[this.selectedIndex];
    if (selectedOption && selectedOption.dataset.unit) {
      unitInput.value = selectedOption.dataset.unit;
    }
    updateMaterialSummary();
  };
  
  const qtyInput = row.querySelector('.material-qty');
  qtyInput.onchange = function() { updateMaterialSummary(); };
  qtyInput.oninput = function() { updateMaterialSummary(); };
  
  updateMaterialSummary();
  renderMaterialTable();
}

function removeMaterialRow(rowId) {
  const row = document.getElementById(`material-row-${rowId}`);
  if (row) {
    row.remove();
    updateMaterialSummary();
    renderMaterialTable();
    showToast('🗑️ ردیف حذف شد');
  }
}

function clearAllMaterialRows() {
  const tbody = document.getElementById('materials-tbody');
  tbody.innerHTML = '';
  materialRowId = 0;
  materialRows = [];
  selectedMaterialsForProduction = [];
  updateMaterialSummary();
  renderMaterialTable();
  showToast('🗑️ همه ردیف‌ها حذف شدند');
}

function updateMaterialSummary() {
  const rows = document.querySelectorAll('#materials-tbody tr');
  const totalCount = rows.length;
  document.getElementById('materials-total-count').textContent = totalCount;
  
  const selectedMaterials = [];
  rows.forEach(row => {
    const select = row.querySelector('.material-select');
    const qtyInput = row.querySelector('.material-qty');
    const unitInput = row.querySelector('.material-unit');
    if (select && select.value && qtyInput) {
      const qty = parseInt(qtyInput.value) || 0;
      if (qty > 0) {
        selectedMaterials.push({
          item: select.value,
          qty: qty,
          unit: unitInput ? unitInput.value : 'عدد'
        });
      }
    }
  });
  
  selectedMaterialsForProduction = selectedMaterials;
  
  const container = document.getElementById('selected-materials-list');
  if (selectedMaterials.length === 0) {
    container.innerHTML = '<div style="color:var(--sub);font-size:12px;">هیچ ماده‌ای انتخاب نشده است</div>';
    return;
  }
  
  let html = `<div class="selected-materials-box"><div class="title">📦 مواد انتخاب شده برای مصرف:</div>`;
  selectedMaterials.forEach((m, index) => {
    html += `<div class="selected-material-row"><span>${index + 1}. ${m.item}</span><span style="font-weight:700;color:var(--danger);">${formatNumber(m.qty)} ${m.unit}</span></div>`;
  });
  html += `<div style="font-size:10px;color:var(--sub);margin-top:6px;">⚠️ مجموع: ${selectedMaterials.length} قلم کالا</div></div>`;
  container.innerHTML = html;
}

function getSelectedMaterialsFromTable() {
  return selectedMaterialsForProduction;
}

// ============================================
// ===== ثبت تولید =====
// ============================================
async function registerProduction() {
  if(!checkFiscalYearAndProceed(() => true)) return;
  
  const unit = document.getElementById('prod-unit').value;
  const item = document.getElementById('prod-item').value;
  const qty = parseInt(document.getElementById('prod-qty').value)||0;
  const note = document.getElementById('prod-note').value.trim();
  const method = document.getElementById('prod-method').value;
  const msg = document.getElementById('prod-msg');
  
  const check = validateFields([
    {id:'prod-unit', label:'بخش', valid: !!unit},
    {id:'prod-item', label:'کالا', valid: !!item},
    {id:'prod-qty', label:'تعداد (بزرگ‌تر از صفر)', valid: qty>0},
  ]);
  if (!check.valid) {
    msg.innerHTML=`<span class="tag-waste">⚠️ این فیلدها را تکمیل کنید: ${check.missingLabels.join('، ')}</span>`;
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/api/doc/production`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit, item, qty, note })
    });
    
    const result = await response.json();
    
    if (!result.success) {
      msg.innerHTML=`<span class="tag-waste">❌ ${result.error || 'خطا در ثبت تولید'}</span>`;
      return;
    }
    
    const productionDoc = result.doc;
    const batchNumber = result.batchNumber || '---';
    
    if (method === 'from-materials') {
      const selectedMaterials = getSelectedMaterialsFromTable();
      
      if (selectedMaterials.length === 0) {
        msg.innerHTML = `<span style="color:var(--warn)">⚠️ تولید ثبت شد، اما هیچ ماده‌ای برای مصرف انتخاب نشده است</span>`;
      } else {
        let consumeErrors = [];
        let consumeSuccess = 0;
        
        for (const material of selectedMaterials) {
          const consumeQty = material.qty;
          
          const currentQty = inventory[unit]?.[material.item] || 0;
          if (currentQty < consumeQty) {
            consumeErrors.push(`موجودی ${material.item} ناکافی است (موجودی: ${formatNumber(currentQty)}، نیاز: ${formatNumber(consumeQty)})`);
            continue;
          }
          
          try {
            const consumeResponse = await fetch(`${API_URL}/api/doc/consume`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                unit: unit,
                item: material.item,
                qty: consumeQty,
                note: `مصرف در تولید ${item} (سند تولید ${productionDoc.id})`,
                batchNumber: batchNumber,
                parentDocId: productionDoc.id
              })
            });
            
            const consumeResult = await consumeResponse.json();
            
            if (consumeResult.success) {
              consumeSuccess++;
              if (inventory[unit] && inventory[unit][material.item] !== undefined) {
                inventory[unit][material.item] -= consumeQty;
                if (inventory[unit][material.item] < 0) inventory[unit][material.item] = 0;
              }
            } else {
              consumeErrors.push(`خطا در ثبت مصرف ${material.item}: ${consumeResult.error || 'نامشخص'}`);
            }
          } catch(e) {
            consumeErrors.push(`خطا در ثبت مصرف ${material.item}: ${e.message}`);
          }
        }
        
        if (consumeErrors.length > 0) {
          msg.innerHTML = `
            <span style="color:var(--warn)">⚠️ تولید ثبت شد، اما در ثبت مصرف مشکلاتی وجود دارد:</span><br>
            <span style="color:var(--danger);font-size:12px;">${consumeErrors.join('<br>')}</span>
          `;
        } else {
          msg.innerHTML = `
            <span style="color:var(--green)">✅ تولید ${formatNumber(qty)} ${item} با موفقیت ثبت شد</span><br>
            <span style="color:var(--accent);font-size:12px;">📦 ${consumeSuccess} کالا به عنوان مصرف ثبت شد</span>
            <span class="batch-badge" style="display:block;margin-top:4px;">🔢 بچ: ${batchNumber}</span>
          `;
        }
        
        clearAllMaterialRows();
        await saveData();
      }
      
    } else {
      msg.innerHTML = `
        <span style="color:var(--purple)">🏭 ${formatNumber(qty)} ${item} تولید شد</span>
        <span class="batch-badge" style="display:block;margin-top:4px;">🔢 بچ: ${batchNumber}</span>
      `;
    }
    
    document.getElementById('prod-qty').value=1;
    document.getElementById('prod-note').value='';
    document.getElementById('prod-item-search').value='';
    document.getElementById('prod-item').value='';
    
    await loadData();
    renderAll();
    generateDailyReport();
    updateNotificationBadge();
    
    // ===== سوال برای خروج به بخش دیگر با مودال =====
    if (await customConfirmModal(`✅ تولید ${qty} ${item} ثبت شد.\nآیا می‌خواهید این محصول را به بخش دیگری ارسال کنید؟`)) {
      pendingOutputData = { fromUnit: unit, item: item, qty: qty, note: `خروج محصول ${item} پس از تولید`, batchNumber: batchNumber };
      showSelectDeptModal(async function(targetDept) {
        if (targetDept) {
          await performOutputAfterProduction(unit, targetDept, item, qty, `خروج محصول ${item} پس از تولید`, batchNumber);
        }
        pendingOutputData = null;
      });
    }
    
    showToast(`🏭 ${formatNumber(qty)} ${item} تولید شد`);
    
  } catch(e) {
    console.error('Error in registerProduction:', e);
    msg.innerHTML=`<span class="tag-waste">❌ خطا در ثبت: ${e.message}</span>`;
    showToast('❌ خطا در ثبت تولید', true);
  }
}

async function performOutputAfterProduction(fromUnit, toUnit, item, qty, note, batchNumber) {
  try {
    const response = await fetch(`${API_URL}/api/doc/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromUnit, to: toUnit, item, qty, note })
    });
    
    const result = await response.json();
    
    if (result.success) {
      showToast(`📤 سند خروج ${result.doc.id} به ${deptName(toUnit)} ارسال شد. منتظر تایید گیرنده باشید.`);
      await loadData();
      renderAll();
      updateNotificationBadge();
    } else {
      showToast(`❌ خطا در ثبت خروج: ${result.error || 'نامشخص'}`, true);
    }
  } catch(e) {
    console.error('Error in performOutputAfterProduction:', e);
    showToast('❌ خطا در ثبت خروج', true);
  }
}

// ============================================
// ===== توابع فرم مصرف =====
// ============================================
function fillConsumeForm() {
  console.log('🔄 fillConsumeForm اجرا شد');
  const unit = document.getElementById('consume-unit');
  const item = document.getElementById('consume-item');
  if (!unit || !item) {
    console.error('❌ عناصر فرم پیدا نشدند');
    return;
  }
  unit.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    unit.appendChild(option);
  });
  if (!isAdmin() && getUserDeptId()) {
    unit.value = getUserDeptId();
    unit.disabled = true;
    const lock = document.getElementById('consume-unit-lock');
    if (lock) {
      lock.textContent = `🔒 فقط ${deptName(getUserDeptId())}`;
      lock.style.display = 'block';
    }
  } else {
    unit.disabled = false;
    const lock = document.getElementById('consume-unit-lock');
    if (lock) {
      lock.textContent = '';
      lock.style.display = 'none';
    }
  }
  loadConsumeItems();
  unit.onchange = function() {
    console.log('🔄 بخش مصرف تغییر کرد:', this.value);
    loadConsumeItems();
  };
  console.log('✅ fillConsumeForm با موفقیت اجرا شد');
}

function loadConsumeItems() {
  const unitId = document.getElementById('consume-unit').value;
  const item = document.getElementById('consume-item');
  if (!unitId || !item) {
    item.innerHTML = '<option value="">ابتدا بخش را انتخاب کنید</option>';
    return;
  }
  const inv = inventory[unitId] || {};
  const availableItems = Object.keys(inv).filter(name => inv[name] > 0);
  
  item.innerHTML = '';
  if(availableItems.length === 0) {
    item.innerHTML = '<option value="">⚠️ کالایی با موجودی یافت نشد</option>';
  } else {
    availableItems.forEach(name => {
      const code = getItemCode(name);
      const unitType = getItemUnit(name);
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${code} - ${name} (موجودی: ${formatNumber(inv[name])} ${unitType})`;
      item.appendChild(option);
    });
  }
  updateConsumeUnit();
  console.log(`   تعداد کالاهای موجود: ${availableItems.length}`);
}

function updateConsumeUnit() {
  const selectedItem = document.getElementById('consume-item').value;
  const unit = getItemUnit(selectedItem);
  if(unit) {
    document.getElementById('consume-unit-type').value = unit;
  }
}

async function registerConsume() {
  if(!checkFiscalYearAndProceed(() => true)) return;
  
  const unit = document.getElementById('consume-unit').value;
  const item = document.getElementById('consume-item').value;
  const qty = parseInt(document.getElementById('consume-qty').value)||0;
  const note = document.getElementById('consume-note').value.trim();
  const msg = document.getElementById('consume-msg');
  
  const check = validateFields([
    {id:'consume-unit', label:'بخش', valid: !!unit},
    {id:'consume-item', label:'کالا', valid: !!item},
    {id:'consume-qty', label:'تعداد (بزرگ‌تر از صفر)', valid: qty>0},
  ]);
  if (!check.valid) {
    msg.innerHTML=`<span class="tag-waste">⚠️ این فیلدها را تکمیل کنید: ${check.missingLabels.join('، ')}</span>`;
    return;
  }
  
  const currentQty = inventory[unit]?.[item] || 0;
  if (currentQty < qty) {
    msg.innerHTML=`<span class="tag-waste">❌ موجودی کافی نیست! (موجودی: ${formatNumber(currentQty)}، نیاز: ${formatNumber(qty)})</span>`;
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/api/doc/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit, item, qty, note })
    });
    
    const result = await response.json();
    
    if (result.success) {
      if (inventory[unit] && inventory[unit][item] !== undefined) {
        inventory[unit][item] -= qty;
        if (inventory[unit][item] < 0) inventory[unit][item] = 0;
      }
      
      const newQty = inventory[unit]?.[item] || 0;
      msg.innerHTML=`<span style="color:var(--danger)">📤 ${formatNumber(qty)} ${item} مصرف شد (مانده: ${formatNumber(newQty)})</span>`;
      document.getElementById('consume-qty').value=1;
      document.getElementById('consume-note').value='';
      showToast(`📤 ${formatNumber(qty)} ${item} مصرف شد`);
      
      await saveData();
      renderAll();
      generateDailyReport();
    } else {
      msg.innerHTML=`<span class="tag-waste">❌ ${result.error || 'خطا در ثبت مصرف'}</span>`;
    }
  } catch(e) {
    if(!inventory[unit]) inventory[unit] = {};
    if(!inventory[unit][item]) inventory[unit][item] = 0;
    inventory[unit][item] -= qty;
    if (inventory[unit][item] < 0) inventory[unit][item] = 0;
    
    const tx = {
      id: seqId++, date: new Date().toLocaleDateString('fa-IR'), type: 'consume',
      unit: unit, item: item, qty: qty, note: note,
      targetUnit: '', fiscalYear: activeFiscalYear
    };
    transactions.push(tx);
    const doc = {
      id: docSeq++, date: new Date().toLocaleDateString('fa-IR'), type: 'consume',
      unit: unit, item: item, qty: qty, fromUnit: '', toUnit: '',
      note: note, status: 'approved', fiscalYear: activeFiscalYear,
      createdBy: currentUser ? currentUser.username : 'سیستم',
      transactionId: tx.id, parentDocId: null
    };
    docs.push(doc);
    await saveData();
    msg.innerHTML=`<span style="color:var(--danger)">📤 ${formatNumber(qty)} ${item} مصرف شد (آفلاین - مانده: ${formatNumber(inventory[unit][item])})</span>`;
    document.getElementById('consume-qty').value=1;
    document.getElementById('consume-note').value='';
    showToast(`📤 ${formatNumber(qty)} ${item} مصرف شد (آفلاین)`);
    renderAll();
    generateDailyReport();
  }
}

// ============================================
// ===== توابع فرم خروج به بخش =====
// ============================================
function fillOutputForm() {
  console.log('🔄 fillOutputForm اجرا شد');
  const from = document.getElementById('output-from');
  const to = document.getElementById('output-to');
  const item = document.getElementById('output-item');
  if (!from || !to || !item) {
    console.error('❌ عناصر فرم پیدا نشدند');
    return;
  }
  from.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    from.appendChild(option);
  });
  if (!isAdmin() && getUserDeptId()) {
    from.value = getUserDeptId();
    from.disabled = true;
    const lock = document.getElementById('output-from-lock');
    if (lock) {
      lock.textContent = `🔒 فقط ${deptName(getUserDeptId())}`;
      lock.style.display = 'block';
    }
  } else {
    from.disabled = false;
    const lock = document.getElementById('output-from-lock');
    if (lock) {
      lock.textContent = '';
      lock.style.display = 'none';
    }
  }
  fillOutputDestinations();
  updateOutputItems();
  from.onchange = function() {
    console.log('🔄 بخش مبدأ تغییر کرد:', this.value);
    fillOutputDestinations();
    updateOutputItems();
  };
  to.onchange = function() {
    console.log('🔄 بخش مقصد تغییر کرد:', this.value);
    updateOutputItems();
  };
  console.log('✅ fillOutputForm با موفقیت اجرا شد');
}

function fillOutputDestinations() {
  const from = document.getElementById('output-from');
  const to = document.getElementById('output-to');
  if (!from || !to) return;
  const fromId = from.value;
  const currentUnit = getUserDeptId();
  to.innerHTML = '<option value="">-- انتخاب بخش مقصد --</option>';
  let deptList = [];
  if (isAdmin()) {
    deptList = DEPTS.filter(d => d.id !== fromId);
  } else {
    deptList = DEPTS.filter(d => d.id !== currentUnit && d.id !== fromId);
  }
  deptList.forEach(d => {
    const option = document.createElement('option');
    option.value = d.id;
    option.textContent = d.name;
    to.appendChild(option);
  });
  console.log(`   تعداد بخش‌های مقصد: ${to.options.length - 1}`);
}

// ===== تابع کمکی برای نرمال‌سازی نام =====
function normalizeName(name) {
  if (!name) return '';
  return name.replace(/\s+/g, ' ').trim();
}

// ===== تابع updateOutputItems - فقط از محصولات بخش =====
function updateOutputItems() {
  const fromId = document.getElementById('output-from').value;
  const toId = document.getElementById('output-to').value;
  const item = document.getElementById('output-item');
  
  if (!fromId || !toId || toId === '') {
    item.innerHTML = '<option value="">ابتدا بخش مبدأ و مقصد را انتخاب کنید</option>';
    return;
  }
  
  // 📦 محصولات تعریف شده برای این بخش
  const products = getDeptProducts(fromId);
  const inv = inventory[fromId] || {};
  
  // 🟢 فقط کالاهایی که در محصولات بخش تعریف شده‌اند و موجودی دارند
  const availableProducts = products.filter(p => {
    const qty = inv[p.name] || 0;
    return qty > 0;
  });
  
  console.log('📦 محصولات بخش:', products.map(p => `${p.code} - ${p.name} (${p.unit})`));
  console.log('📦 موجودی:', Object.keys(inv).filter(k => inv[k] > 0));
  
  item.innerHTML = '';
  if(availableProducts.length === 0) {
    item.innerHTML = '<option value="">⚠️ محصولی با موجودی یافت نشد</option>';
  } else {
    availableProducts.forEach(product => {
      const code = product.code;
      const name = product.name;
      const unit = product.unit || 'عدد';
      const qty = inv[name] || 0;
      
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${code} - ${name} (موجودی: ${formatNumber(qty)} ${unit})`;
      option.dataset.unit = unit;
      item.appendChild(option);
    });
  }
  
  // واحد را تنظیم کن
  if (item.options.length > 0) {
    const firstOption = item.options[0];
    const unit = firstOption.dataset.unit || 'عدد';
    document.getElementById('output-unit-type').value = unit;
    console.log(`✅ واحد انتخاب شده: ${unit}`);
  }
}

// ===== تابع updateOutputUnit - فقط از محصولات بخش =====
function updateOutputUnit() {
  const selectedItem = document.getElementById('output-item').value;
  const fromDept = document.getElementById('output-from').value;
  
  if (!selectedItem) return;
  
  // 🔍 از محصولات بخش واحد را بگیر
  const products = getDeptProducts(fromDept);
  const product = products.find(p => p.name === selectedItem);
  
  if (product && product.unit) {
    document.getElementById('output-unit-type').value = product.unit;
    console.log(`✅ واحد از محصولات بخش: ${product.unit} برای کالا: "${selectedItem}"`);
  } else {
    // اگر در محصولات بخش نبود، از data-attribute استفاده کن
    const select = document.getElementById('output-item');
    const option = select.options[select.selectedIndex];
    if (option && option.dataset.unit) {
      document.getElementById('output-unit-type').value = option.dataset.unit;
      console.log(`✅ واحد از data-attribute: ${option.dataset.unit}`);
    } else {
      document.getElementById('output-unit-type').value = 'عدد';
      console.log(`⚠️ کالا در محصولات بخش یافت نشد، پیش‌فرض: عدد`);
    }
  }
}

async function registerOutput() {
  if(!checkFiscalYearAndProceed(() => true)) return;
  
  const from = document.getElementById('output-from').value;
  const to = document.getElementById('output-to').value;
  const item = document.getElementById('output-item').value;
  const qty = parseInt(document.getElementById('output-qty').value)||0;
  const note = document.getElementById('output-note').value.trim();
  const msg = document.getElementById('output-msg');
  
  const check = validateFields([
    {id:'output-from', label:'بخش مبدأ', valid: !!from},
    {id:'output-to', label:'بخش مقصد', valid: !!to},
    {id:'output-item', label:'کالا', valid: !!item},
    {id:'output-qty', label:'تعداد (بزرگ‌تر از صفر)', valid: qty>0},
  ]);
  if (!check.valid) {
    msg.innerHTML=`<span class="tag-waste">⚠️ این فیلدها را تکمیل کنید: ${check.missingLabels.join('، ')}</span>`;
    return;
  }
  if(from === to) {
    msg.innerHTML='<span class="tag-waste">⚠️ مبدأ و مقصد یکی است</span>';
    return;
  }
  
  const currentQty = inventory[from]?.[item] || 0;
  if (currentQty < qty) {
    msg.innerHTML=`<span class="tag-waste">❌ موجودی مبدأ کافی نیست! (موجودی: ${formatNumber(currentQty)}، نیاز: ${formatNumber(qty)})</span>`;
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/api/doc/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, item, qty, note })
    });
    const result = await response.json();
    if (result.success) {
      const batch = result.batchNumber || '---';
      msg.innerHTML=`<span style="color:var(--accent)">📤 ${formatNumber(qty)} ${item} از ${deptName(from)} به ${deptName(to)} ثبت شد. منتظر تایید ${deptName(to)} باشید.</span><span class="batch-badge" style="display:block;margin-top:4px;">🔢 بچ: ${batch}</span>`;
      document.getElementById('output-qty').value=1;
      document.getElementById('output-note').value='';
      showToast(`📤 سند خروج ثبت شد، منتظر تایید ${deptName(to)}`);
      await loadData();
      renderAll();
      updateNotificationBadge();
    } else {
      msg.innerHTML=`<span class="tag-waste">❌ ${result.error || 'خطا در ثبت خروج'}</span>`;
    }
  } catch(e) {
    console.error('❌ خطا در ثبت خروج:', e);
    msg.innerHTML=`<span class="tag-waste">❌ خطا در ارتباط با سرور: ${e.message}</span>`;
    showToast(`❌ خطا در ثبت خروج: ${e.message}`, true);
    const useOffline = await customConfirmModal(`❌ اتصال به سرور برقرار نیست!\nآیا می‌خواهید خروج را به صورت آفلاین ثبت کنید؟`);
    if (useOffline) {
      if(!inventory[from]) inventory[from] = {};
      if(!inventory[from][item]) inventory[from][item] = 0;
      inventory[from][item] -= qty;
      if (inventory[from][item] < 0) inventory[from][item] = 0;
      
      const tx = {
        id: seqId++, date: new Date().toLocaleDateString('fa-IR'), type: 'output',
        unit: from, item: item, qty: qty, note: note,
        targetUnit: to, fiscalYear: activeFiscalYear
      };
      transactions.push(tx);
      const doc = {
        id: docSeq++, date: new Date().toLocaleDateString('fa-IR'), type: 'output',
        unit: from, item: item, qty: qty, fromUnit: from, toUnit: to,
        note: note, status: 'pending', fiscalYear: activeFiscalYear,
        createdBy: currentUser ? currentUser.username : 'سیستم',
        transactionId: tx.id, parentDocId: null
      };
      docs.push(doc);
      await saveData();
      msg.innerHTML=`<span style="color:var(--accent)">📤 ${formatNumber(qty)} ${item} از ${deptName(from)} به ${deptName(to)} ثبت شد (آفلاین)</span>`;
      document.getElementById('output-qty').value=1;
      document.getElementById('output-note').value='';
      showToast(`📤 سند خروج ثبت شد (آفلاین)`);
      renderAll();
      updateNotificationBadge();
    }
  }
}

// ============================================
// ===== توابع فرم ضایعات =====
// ============================================
function fillWasteForm() {
  const unit = document.getElementById('waste-unit');
  const item = document.getElementById('waste-item');
  restrictToUserUnit('waste-unit', 'waste-unit-lock');
  const unitId = unit.value;
  const inv = inventory[unitId] || {};
  const availableItems = Object.keys(inv).filter(k => inv[k] > 0);
  item.innerHTML = '';
  if(availableItems.length === 0) {
    item.innerHTML = '<option value="">⚠️ کالایی با موجودی یافت نشد</option>';
  } else {
    availableItems.forEach(name => {
      const code = getItemCode(name);
      const unitType = getItemUnit(name);
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${code} - ${name} (موجودی: ${formatNumber(inv[name])} ${unitType})`;
      item.appendChild(option);
    });
  }
  item.onchange = function() { updateWasteUnit(); };
  updateWasteUnit();
}

function updateWasteUnit() {
  const selectedItem = document.getElementById('waste-item').value;
  const unit = getItemUnit(selectedItem);
  if(unit) {
    document.getElementById('waste-unit-type').value = unit;
  }
}

async function registerWaste() {
  if(!checkFiscalYearAndProceed(() => true)) return;
  
  const unit = document.getElementById('waste-unit').value;
  const item = document.getElementById('waste-item').value;
  const qty = parseInt(document.getElementById('waste-qty').value)||0;
  const note = document.getElementById('waste-note').value.trim();
  const msg = document.getElementById('waste-msg');
  
  const check = validateFields([
    {id:'waste-unit', label:'بخش', valid: !!unit},
    {id:'waste-item', label:'کالا', valid: !!item},
    {id:'waste-qty', label:'تعداد (بزرگ‌تر از صفر)', valid: qty>0},
  ]);
  if (!check.valid) {
    msg.innerHTML=`<span class="tag-waste">⚠️ این فیلدها را تکمیل کنید: ${check.missingLabels.join('، ')}</span>`;
    return;
  }
  
  const currentQty = inventory[unit]?.[item] || 0;
  if (currentQty < qty) {
    msg.innerHTML=`<span class="tag-waste">❌ موجودی کافی نیست! (موجودی: ${formatNumber(currentQty)}، نیاز: ${formatNumber(qty)})</span>`;
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/api/doc/waste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit, item, qty, note })
    });
    const result = await response.json();
    if (result.success) {
      if (inventory[unit] && inventory[unit][item] !== undefined) {
        inventory[unit][item] -= qty;
        if (inventory[unit][item] < 0) inventory[unit][item] = 0;
      }
      const newQty = inventory[unit]?.[item] || 0;
      msg.innerHTML=`<span style="color:var(--danger)">🗑️ ${formatNumber(qty)} ${item} ضایعات ثبت شد (مانده: ${formatNumber(newQty)})</span>`;
      document.getElementById('waste-qty').value=1;
      document.getElementById('waste-note').value='';
      showToast(`🗑️ ${formatNumber(qty)} ${item} ضایعات ثبت شد`);
      await saveData();
      renderAll();
      generateDailyReport();
    } else {
      msg.innerHTML=`<span class="tag-waste">❌ ${result.error || 'خطا در ثبت ضایعات'}</span>`;
    }
  } catch(e) {
    if(!inventory[unit]) inventory[unit] = {};
    if(!inventory[unit][item]) inventory[unit][item] = 0;
    inventory[unit][item] -= qty;
    if (inventory[unit][item] < 0) inventory[unit][item] = 0;
    const tx = {
      id: seqId++, date: new Date().toLocaleDateString('fa-IR'), type: 'waste',
      unit: unit, item: item, qty: qty, note: note,
      targetUnit: '', fiscalYear: activeFiscalYear
    };
    transactions.push(tx);
    const doc = {
      id: docSeq++, date: new Date().toLocaleDateString('fa-IR'), type: 'waste',
      unit: unit, item: item, qty: qty, fromUnit: '', toUnit: '',
      note: note, status: 'approved', fiscalYear: activeFiscalYear,
      createdBy: currentUser ? currentUser.username : 'سیستم',
      transactionId: tx.id, parentDocId: null
    };
    docs.push(doc);
    await saveData();
    msg.innerHTML=`<span style="color:var(--danger)">🗑️ ${formatNumber(qty)} ${item} ضایعات ثبت شد (آفلاین - مانده: ${formatNumber(inventory[unit][item])})</span>`;
    document.getElementById('waste-qty').value=1;
    document.getElementById('waste-note').value='';
    showToast(`🗑️ ${formatNumber(qty)} ${item} ضایعات ثبت شد (آفلاین)`);
    renderAll();
    generateDailyReport();
  }
}

// ============================================
// ===== توابع فرم کسری و اضافات =====
// ============================================
function fillAdjustForm() {
  const unit = document.getElementById('adjust-unit');
  const item = document.getElementById('adjust-item');
  restrictToUserUnit('adjust-unit', 'adjust-unit-lock');
  const unitId = unit.value;
  const inv = inventory[unitId] || {};
  const availableItems = Object.keys(inv).filter(k => inv[k] >= 0);
  item.innerHTML = '';
  if(availableItems.length === 0) {
    item.innerHTML = '<option value="">⚠️ کالایی یافت نشد</option>';
  } else {
    availableItems.forEach(name => {
      const code = getItemCode(name);
      const unitType = getItemUnit(name);
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${code} - ${name} (موجودی: ${formatNumber(inv[name])} ${unitType})`;
      item.appendChild(option);
    });
  }
  item.onchange = function() { updateAdjustUnit(); };
  updateAdjustUnit();
}

function updateAdjustUnit() {
  const selectedItem = document.getElementById('adjust-item').value;
  const unit = getItemUnit(selectedItem);
  if(unit) {
    document.getElementById('adjust-unit-type').value = unit;
  }
}

async function registerAdjust() {
  if(!checkFiscalYearAndProceed(() => true)) return;
  
  const unit = document.getElementById('adjust-unit').value;
  const item = document.getElementById('adjust-item').value;
  const qty = parseInt(document.getElementById('adjust-qty').value)||0;
  const type = document.getElementById('adjust-type').value;
  const note = document.getElementById('adjust-note').value.trim();
  const msg = document.getElementById('adjust-msg');
  
  const check = validateFields([
    {id:'adjust-unit', label:'بخش', valid: !!unit},
    {id:'adjust-item', label:'کالا', valid: !!item},
    {id:'adjust-qty', label:'تعداد (بزرگ‌تر از صفر)', valid: qty>0},
  ]);
  if (!check.valid) {
    msg.innerHTML=`<span class="tag-waste">⚠️ این فیلدها را تکمیل کنید: ${check.missingLabels.join('، ')}</span>`;
    return;
  }
  
  if (type === 'shortage') {
    const currentQty = inventory[unit]?.[item] || 0;
    if (currentQty < qty) {
      msg.innerHTML=`<span class="tag-waste">❌ موجودی کافی نیست! (موجودی: ${formatNumber(currentQty)}، نیاز: ${formatNumber(qty)})</span>`;
      return;
    }
  }
  
  try {
    const response = await fetch(`${API_URL}/api/doc/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit, item, qty, type, note })
    });
    const result = await response.json();
    if (result.success) {
      if (!inventory[unit]) inventory[unit] = {};
      if (!inventory[unit][item]) inventory[unit][item] = 0;
      
      if (type === 'shortage') {
        inventory[unit][item] -= qty;
        if (inventory[unit][item] < 0) inventory[unit][item] = 0;
      } else {
        inventory[unit][item] += qty;
      }
      
      const newQty = inventory[unit]?.[item] || 0;
      const label = type === 'shortage' ? 'کسری' : 'اضافات';
      msg.innerHTML=`<span style="color:var(--accent)">✅ ${label} ${formatNumber(qty)} ${item} ثبت شد (موجودی: ${formatNumber(newQty)})</span>`;
      document.getElementById('adjust-qty').value=1;
      document.getElementById('adjust-note').value='';
      showToast(`✅ ${label} ثبت شد`);
      await saveData();
      renderAll();
      generateDailyReport();
    } else {
      msg.innerHTML=`<span class="tag-waste">❌ ${result.error || 'خطا در ثبت تعدیل'}</span>`;
    }
  } catch(e) {
    if(!inventory[unit]) inventory[unit] = {};
    if(!inventory[unit][item]) inventory[unit][item] = 0;
    const txType = type === 'shortage' ? 'shortage' : 'excess';
    if(type === 'shortage') {
      inventory[unit][item] -= qty;
      if (inventory[unit][item] < 0) inventory[unit][item] = 0;
    } else {
      inventory[unit][item] += qty;
    }
    const tx = {
      id: seqId++, date: new Date().toLocaleDateString('fa-IR'), type: txType,
      unit: unit, item: item, qty: qty, note: note,
      targetUnit: '', fiscalYear: activeFiscalYear
    };
    transactions.push(tx);
    const doc = {
      id: docSeq++, date: new Date().toLocaleDateString('fa-IR'), type: txType,
      unit: unit, item: item, qty: qty, fromUnit: '', toUnit: '',
      note: note, status: 'approved', fiscalYear: activeFiscalYear,
      createdBy: currentUser ? currentUser.username : 'سیستم',
      transactionId: tx.id, parentDocId: null
    };
    docs.push(doc);
    await saveData();
    msg.innerHTML=`<span style="color:var(--accent)">✅ ${type === 'shortage' ? 'کسری' : 'اضافات'} ${formatNumber(qty)} ${item} ثبت شد (آفلاین - موجودی: ${formatNumber(inventory[unit][item])})</span>`;
    document.getElementById('adjust-qty').value=1;
    document.getElementById('adjust-note').value='';
    showToast(`✅ ${type === 'shortage' ? 'کسری' : 'اضافات'} ثبت شد (آفلاین)`);
    renderAll();
    generateDailyReport();
  }
}

// ============================================
// ===== توابع مدیریت کالاها =====
// ============================================
async function addItem() {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  const code = document.getElementById('item-code').value.trim();
  const name = document.getElementById('item-name').value.trim();
  const group = document.getElementById('item-group').value.trim() || 'متفرقه';
  const unit = document.getElementById('item-unit').value;
  const msg = document.getElementById('item-msg');
  if(!code || !name) {
    msg.innerHTML = '⚠️ کد و عنوان کالا الزامی است';
    msg.style.color = 'var(--danger)';
    return;
  }
  if(items.find(i => i.code === code)) {
    msg.innerHTML = `⚠️ کد ${code} قبلاً ثبت شده است`;
    msg.style.color = 'var(--danger)';
    return;
  }
  if(items.find(i => i.name === name)) {
    msg.innerHTML = `⚠️ کالا با عنوان "${name}" قبلاً ثبت شده است`;
    msg.style.color = 'var(--danger)';
    return;
  }
  items.push({ code, name, groupName: group, unit, created: new Date().toISOString() });
  await saveData();
  msg.innerHTML = `✅ کالا "${name}" با کد ${code} با موفقیت افزوده شد`;
  msg.style.color = 'var(--green)';
  document.getElementById('item-code').value = '';
  document.getElementById('item-name').value = '';
  document.getElementById('item-group').value = '';
  renderItemsList();
  showToast(`✅ کالا "${name}" افزوده شد`);
}

function selectItemForDelete(code) {
  if(selectedItemCode === code) {
    selectedItemCode = null;
  } else {
    selectedItemCode = code;
  }
  renderItemsList();
}

async function deleteSelectedItem() {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  if(!selectedItemCode) {
    showToast('⚠️ ابتدا یک کالا را انتخاب کنید', true);
    return;
  }
  const item = items.find(i => i.code === selectedItemCode);
  if(!item) {
    showToast('⚠️ کالا یافت نشد', true);
    return;
  }
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید کالا "${item.name}" را حذف کنید؟`)) return;
  const inInventory = Object.values(inventory).some(dep => dep[item.name] !== undefined && dep[item.name] !== 0);
  const inTransactions = transactions.some(t => t.item === item.name);
  const inDocs = docs.some(d => d.item === item.name);
  const inInitial = initialInventory.some(t => t.item === item.name);
  if(inInventory || inTransactions || inDocs || inInitial) {
    showToast(`⚠️ کالا "${item.name}" در سیستم استفاده شده است، قابل حذف نیست`, true);
    return;
  }
  const index = items.findIndex(i => i.code === selectedItemCode);
  if(index !== -1) {
    items.splice(index, 1);
    await saveData();
    selectedItemCode = null;
    renderItemsList();
    showToast(`🗑️ کالا "${item.name}" حذف شد`);
  }
}

function filterItemsList() { renderItemsList(); }

function renderItemsList() {
  const list = document.getElementById('items-list');
  const search = document.getElementById('item-search-filter')?.value.trim().toLowerCase() || '';
  let filteredItems = items;
  if(search) {
    filteredItems = items.filter(i => 
      i.code.toLowerCase().includes(search) || 
      i.name.toLowerCase().includes(search) || 
      (i.groupName && i.groupName.toLowerCase().includes(search))
    );
  }
  if(filteredItems.length === 0) {
    list.innerHTML = '<div class="empty">📭 کالایی تعریف نشده است. از دکمه همگام‌سازی یا فرم افزودن استفاده کنید.</div>';
    return;
  }
  filteredItems.sort((a, b) => a.code.localeCompare(b.code, 'fa'));
  let html = `<div style="overflow-x:auto;"><table class="items-table"><thead><tr><th style="width:40px;">#</th><th>کد</th><th>عنوان</th><th>گروه</th><th>واحد</th><th style="width:80px;">انتخاب</th></tr></thead><tbody>`;
  filteredItems.forEach((item, index) => {
    const isSelected = selectedItemCode === item.code;
    html += `<tr style="${isSelected ? 'background:var(--accent-l);' : ''}">
      <td style="text-align:center;">${index + 1}</td>
      <td style="font-weight:700;">${item.code}</td>
      <td>${item.name}</td>
      <td>${item.groupName || '---'}</td>
      <td>${item.unit || 'عدد'}</td>
      <td style="text-align:center;">
        <button onclick="selectItemForDelete('${item.code}')" 
          style="background:${isSelected ? 'var(--danger)' : 'var(--accent)'};color:#fff;border:none;padding:4px 12px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;">
          ${isSelected ? '✅ انتخاب' : '☐ انتخاب'}
        </button>
      </td>
    </tr>`;
  });
  html += `</tbody><tfoot><tr style="background:var(--purple-l);font-weight:700;"><td colspan="6" style="padding:8px;text-align:center;">📊 تعداد کل کالاها: ${filteredItems.length} ${search ? `(فیلتر شده از ${items.length})` : ''}</td></tr></tfoot></table></div>`;
  list.innerHTML = html;
}

// ============================================
// ===== توابع همگام‌سازی با سپیدار =====
// ============================================
async function testSepidarConnection() {
  const statusEl = document.getElementById('sync-status');
  const resultEl = document.getElementById('sync-result');
  statusEl.textContent = '⏳ در حال تست اتصال...';
  resultEl.innerHTML = '';
  try {
    const response = await fetch(`${API_URL}/api/sepidar/test`);
    const result = await response.json();
    if (result.success) {
      statusEl.textContent = '✅ اتصال برقرار است';
      resultEl.innerHTML = `<div style="background:var(--green-l);padding:12px;border-radius:8px;border:1px solid var(--green)">✅ ${result.message}</div>`;
    } else {
      statusEl.textContent = '❌ اتصال برقرار نیست';
      resultEl.innerHTML = `<span style="color:var(--danger)">❌ ${result.message}</span>`;
    }
  } catch(e) {
    statusEl.textContent = '❌ خطا';
    resultEl.innerHTML = `<span style="color:var(--danger)">❌ خطا در تست اتصال</span>`;
  }
}

async function syncFromSepidar() {
  const statusEl = document.getElementById('sync-status');
  const resultEl = document.getElementById('sync-result');
  const yearInput = document.getElementById('sync-fiscal-year');
  const year = parseInt(yearInput.value) || 13;
  if (!await customConfirmModal(`⚠️ آیا می‌خواهید کالاها و موجودی را از سپیدار دریافت کنید؟\nسال مالی: ${year}`)) return;
  statusEl.textContent = '⏳ در حال همگام‌سازی...';
  resultEl.innerHTML = '<span style="color:var(--sub)">⏳ لطفاً صبر کنید...</span>';
  try {
    const response = await fetch(`${API_URL}/api/sync/sepidar?year=${year}`);
    const result = await response.json();
    if (result.success) {
      statusEl.textContent = '✅ همگام‌سازی کامل شد';
      resultEl.innerHTML = `<div style="background:var(--green-l);padding:12px;border-radius:8px;border:1px solid var(--green)"><div style="font-weight:700;color:var(--green)">✅ همگام‌سازی با موفقیت انجام شد</div><div style="margin-top:4px;font-size:12px;color:var(--sub)">📊 ${result.total} کالا پردازش شد<br>➕ ${result.added} کالا جدید اضافه شد<br>🔄 ${result.updated} کالا به‌روزرسانی شد<br>📅 سال مالی: ${result.fiscalYear || year}</div></div>`;
      await loadData();
      renderAll();
      showToast(`✅ همگام‌سازی با سپیدار کامل شد (${result.total} کالا)`);
    } else {
      statusEl.textContent = '❌ خطا در همگام‌سازی';
      resultEl.innerHTML = `<span style="color:var(--danger)">❌ ${result.error || 'خطا در همگام‌سازی'}</span>`;
    }
  } catch(e) {
    statusEl.textContent = '❌ خطا';
    resultEl.innerHTML = `<span style="color:var(--danger)">❌ خطا در ارتباط با سرور</span>`;
    showToast('❌ خطا در همگام‌سازی', true);
  }
}

async function syncItemsFromSepidar() {
  const statusEl = document.getElementById('sync-items-status');
  const resultEl = document.getElementById('sync-items-result');
  if (!await customConfirmModal('⚠️ آیا می‌خواهید لیست کالاها را از سپیدار دریافت کنید؟\nکالاهای موجود به‌روزرسانی می‌شوند و کالاهای جدید اضافه می‌شوند.')) return;
  statusEl.textContent = '⏳ در حال همگام‌سازی...';
  resultEl.innerHTML = '<span style="color:var(--sub)">⏳ لطفاً صبر کنید...</span>';
  try {
    const response = await fetch(`${API_URL}/api/sync/sepidar-items`);
    const result = await response.json();
    if (result.success) {
      statusEl.textContent = '✅ همگام‌سازی کامل شد';
      if(result.items && result.items.length > 0) {
        let added = 0, updated = 0;
        result.items.forEach(newItem => {
          const existing = items.find(i => i.code === newItem.code);
          if(existing) {
            existing.name = newItem.name || existing.name;
            existing.groupName = newItem.groupName || existing.groupName;
            existing.unit = newItem.unit || existing.unit;
            updated++;
          } else {
            items.push({
              code: newItem.code,
              name: newItem.name,
              groupName: newItem.groupName || 'متفرقه',
              unit: newItem.unit || 'عدد',
              created: new Date().toISOString()
            });
            added++;
          }
        });
        await saveData();
        resultEl.innerHTML = `<div style="background:var(--green-l);padding:12px;border-radius:8px;border:1px solid var(--green)"><div style="font-weight:700;color:var(--green)">✅ همگام‌سازی کالاها با موفقیت انجام شد</div><div style="margin-top:4px;font-size:12px;color:var(--sub)">📊 ${result.total} کالا پردازش شد<br>➕ ${added} کالا جدید اضافه شد<br>🔄 ${updated} کالا به‌روزرسانی شد</div></div>`;
        renderItemsList();
        showToast(`✅ همگام‌سازی کالاها کامل شد (${result.total} کالا)`);
      } else {
        resultEl.innerHTML = `<div style="background:var(--warn-l);padding:12px;border-radius:8px;border:1px solid var(--warn)">⚠️ هیچ کالایی از سپیدار دریافت نشد</div>`;
      }
    } else {
      statusEl.textContent = '❌ خطا';
      resultEl.innerHTML = `<span style="color:var(--danger)">❌ ${result.error || 'خطا در همگام‌سازی'}</span>`;
    }
  } catch(e) {
    statusEl.textContent = '❌ خطا';
    resultEl.innerHTML = `<span style="color:var(--danger)">❌ خطا در ارتباط با سرور</span>`;
    showToast('❌ خطا در همگام‌سازی کالاها', true);
  }
}

// ============================================
// ===== توابع مدیریت اسناد =====
// ============================================
async function approveByReceiver(docId) {
  if(!checkFiscalYearAndProceed(() => true)) return;
  const doc = docs.find(d => d.id === docId);
  if(!doc) { showToast('⚠️ سند یافت نشد', true); return; }
  if(doc.status !== 'pending') { showToast('⚠️ این سند قبلاً اقدام شده است', true); return; }
  if(doc.type !== 'output') { showToast('⚠️ فقط اسناد خروج قابل تایید هستند', true); return; }
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید خروج ${formatNumber(doc.qty)} ${doc.item} از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)} را تایید کنید؟`)) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/output/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: docId })
    });
    const result = await response.json();
    if (result.success) {
      showToast(`✅ سند ${docId} توسط گیرنده تایید شد`);
      await loadData();
      renderAll();
      generateDailyReport();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در تایید'}`, true);
    }
  } catch(e) {
    showToast('❌ خطا در تایید سند', true);
  }
}

async function requestReturn(docId) {
  if(!checkFiscalYearAndProceed(() => true)) return;
  const doc = docs.find(d => d.id === docId);
  if(!doc) { showToast('⚠️ سند یافت نشد', true); return; }
  if(doc.status !== 'approved') { showToast('⚠️ فقط اسناد تایید شده قابل برگشت هستند', true); return; }
  if(doc.type !== 'output') { showToast('⚠️ فقط اسناد خروج قابل برگشت هستند', true); return; }
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید درخواست برگشت ${formatNumber(doc.qty)} ${doc.item} از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)} را ثبت کنید؟`)) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/output/request-return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: docId })
    });
    const result = await response.json();
    if (result.success) {
      showToast(`🔄 سند برگشت ${result.doc.id} ثبت شد، منتظر تایید گیرنده`);
      await loadData();
      renderAll();
      generateDailyReport();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در ثبت برگشت'}`, true);
    }
  } catch(e) {
    console.error('Error in requestReturn:', e);
    showToast('❌ خطا در ثبت برگشت', true);
  }
}

async function approveReturn(docId) {
  if(!checkFiscalYearAndProceed(() => true)) return;
  const doc = docs.find(d => d.id === docId);
  if(!doc) { showToast('⚠️ سند یافت نشد', true); return; }
  if(doc.status !== 'return_pending') { showToast('⚠️ این سند در وضعیت مناسب نیست', true); return; }
  if(doc.type !== 'return') { showToast('⚠️ فقط اسناد برگشت قابل تایید هستند', true); return; }
  const parentDoc = docs.find(d => d.id === doc.parentDocId);
  if(!parentDoc) { showToast('⚠️ سند اصلی یافت نشد', true); return; }
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید برگشت ${formatNumber(doc.qty)} ${doc.item} از ${deptName(doc.fromUnit)} به ${deptName(doc.toUnit)} را تایید کنید؟\n(موجودی به حالت قبل برمی‌گردد)`)) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/return/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: docId })
    });
    const result = await response.json();
    if (result.success) {
      showToast(`✅ برگشت سند ${docId} تایید شد`);
      await loadData();
      renderAll();
      generateDailyReport();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در تایید برگشت'}`, true);
    }
  } catch(e) {
    console.error('Error in approveReturn:', e);
    showToast('❌ خطا در تایید برگشت', true);
  }
}

async function rejectReturn(docId) {
  const doc = docs.find(d => d.id === docId);
  if(!doc) { showToast('⚠️ سند یافت نشد', true); return; }
  if(doc.status !== 'return_pending') { showToast('⚠️ این سند قابل لغو نیست', true); return; }
  if(doc.type !== 'return') { showToast('⚠️ فقط اسناد برگشت قابل لغو هستند', true); return; }
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید برگشت ${formatNumber(doc.qty)} ${doc.item} را لغو کنید؟\n(موجودی تغییری نمی‌کند)`)) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/return/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: docId })
    });
    const result = await response.json();
    if (result.success) {
      showToast(`❌ برگشت سند ${docId} لغو شد`);
      await loadData();
      renderAll();
      generateDailyReport();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در لغو برگشت'}`, true);
    }
  } catch(e) {
    console.error('Error in rejectReturn:', e);
    showToast('❌ خطا در لغو برگشت', true);
  }
}

async function deleteDocument(docId) {
  if(!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  if(!await customConfirmModal('⚠️ آیا مطمئن هستید؟')) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/${docId}`, { method: 'DELETE' });
    const result = await response.json();
    if (result.success) {
      showToast(`🗑️ سند ${docId} حذف شد`);
      await loadData();
      renderAll();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در حذف'}`, true);
    }
  } catch(e) {
    showToast('❌ خطا در حذف سند', true);
  }
}

async function cancelProductionDoc(docId) {
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید این سند تولید را لغو کنید؟\nموجودی کالا برگشت داده می‌شود.`)) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/${docId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (result.success) {
      if (result.reversedMaterialDocs && result.reversedMaterialDocs.length > 0) {
        const list = result.reversedMaterialDocs.map(m => `${m.item} (${formatNumber(m.qty)})`).join('، ');
        showToast(`✅ سند تولید ${docId} لغو شد و مصرف مواد اولیه‌ی مرتبط هم برگشت داده شد: ${list}`);
      } else {
        showToast(`✅ سند تولید ${docId} لغو شد`);
      }
      await loadData();
      renderAll();
      generateDailyReport();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در لغو'}`, true);
    }
  } catch(e) {
    console.error('Error in cancelProductionDoc:', e);
    showToast('❌ خطا در لغو سند', true);
  }
}

async function cancelGeneralDoc(docId) {
  if(!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید این سند را لغو کنید؟\nموجودی به حالت قبل برمی‌گردد.`)) return;
  try {
    const response = await fetch(`${API_URL}/api/doc/${docId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (result.success) {
      showToast(`✅ سند ${docId} لغو شد`);
      await loadData();
      renderAll();
      generateDailyReport();
      updateNotificationBadge();
    } else {
      showToast(`❌ ${result.error || 'خطا در لغو'}`, true);
    }
  } catch(e) {
    console.error('Error in cancelGeneralDoc:', e);
    showToast('❌ خطا در لغو سند', true);
  }
}

// ============================================
// ===== لیست اسناد =====
// ============================================
function renderDocuments() {
  const container = document.getElementById('documents-list');
  const isAdminUser = isAdmin();
  const userDeptName = getUserDeptName();
  const userDeptId = getUserDeptId();
  const currentUserName = currentUser ? currentUser.username : '';
  const statusFilter = document.getElementById('doc-filter-status').value;
  const typeFilter = document.getElementById('doc-filter-type').value;
  let filtered = docs;
  if(!isAdminUser) {
    filtered = filtered.filter(d => {
      const docUnit = d.unit || '';
      const docFrom = d.fromUnit || '';
      const docTo = d.toUnit || '';
      return docUnit === userDeptName || docUnit === userDeptId ||
             docFrom === userDeptName || docFrom === userDeptId ||
             docTo === userDeptName || docTo === userDeptId ||
             d.createdBy === currentUserName;
    });
  }
  if(statusFilter !== 'all') {
    filtered = filtered.filter(d => d.status === statusFilter);
  }
  if(typeFilter !== 'all') {
    filtered = filtered.filter(d => d.type === typeFilter);
  }
  filtered = filtered.slice().sort((a, b) => {
    const dateA = parseDate(a.date);
    const dateB = parseDate(b.date);
    if (!dateA || !dateB) return 0;
    if (dateA.year !== dateB.year) return dateB.year - dateA.year;
    if (dateA.month !== dateB.month) return dateB.month - dateA.month;
    return dateB.day - dateA.day;
  });
  if(filtered.length === 0) { 
    container.innerHTML = '<div class="empty">📭 سندی یافت نشد</div>'; 
    updateNotificationBadge();
    return; 
  }
  const typeLabels = {
    'production': 'تولید', 'consume': 'مصرف', 'output': 'خروج به بخش دیگر',
    'return': 'برگشت از خروج', 'waste': 'ضایعات', 'shortage': 'کسری',
    'excess': 'اضافات', 'initial': 'موجودی اولیه'
  };
  const typeIcons = {
    'production': '🏭', 'consume': '📤', 'output': '📤',
    'return': '↩️', 'waste': '🗑️', 'shortage': '📉',
    'excess': '📈', 'initial': '📊'
  };
  const statusLabels = {
    'pending': 'در انتظار تایید گیرنده', 'approved': 'تایید شده',
    'cancelled': 'لغو شده', 'return_pending': 'در انتظار تایید برگشت',
    'return_approved': 'برگشت تایید شده', 'return_rejected': 'برگشت لغو شده'
  };
  const statusColors = {
    'pending': '#854F0B', 'approved': '#16a34a', 'cancelled': '#791F1F',
    'return_pending': '#2563EB', 'return_approved': '#16a34a', 'return_rejected': '#791F1F'
  };
  const statusBgColors = {
    'pending': '#FAEEDA', 'approved': '#dcfce7', 'cancelled': '#FCEBEB',
    'return_pending': '#DBEAFE', 'return_approved': '#dcfce7', 'return_rejected': '#FCEBEB'
  };
  let html = `<div style="overflow-x:auto;margin-top:12px;"><table style="width:100%;border-collapse:collapse;font-size:12px;direction:rtl;"><thead><tr style="background:#0F6E56;color:#fff;">
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">ردیف</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">صادر کننده</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">شماره سند</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">تاریخ</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">تحویل دهنده</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">تحویل گیرنده</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">نوع سند</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">کالا</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">واحد</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">تعداد</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">وضعیت</th>
    <th style="padding:8px 6px;text-align:center;border:1px solid #0F6E56;">عملیات</th>
  </tr></thead><tbody>`;
  filtered.forEach((d, index) => {
    const rowNum = index + 1;
    const typeName = typeLabels[d.type] || d.type;
    const typeIcon = typeIcons[d.type] || '📄';
    const statusName = statusLabels[d.status] || d.status;
    const statusColor = statusColors[d.status] || '#6B7268';
    const statusBg = statusBgColors[d.status] || '#F0F2F5';
    const itemUnit = getItemUnit(d.item) || 'عدد';
    let deliverer = '', receiver = '';
    if (d.type === 'output' || d.type === 'return') {
      deliverer = d.fromUnit ? deptName(d.fromUnit) : '';
      receiver = d.toUnit ? deptName(d.toUnit) : '';
    } else if (d.type === 'production') {
      deliverer = 'سیستم'; receiver = d.unit ? deptName(d.unit) : '';
    } else if (d.type === 'consume') {
      deliverer = d.unit ? deptName(d.unit) : ''; receiver = 'مصرف';
    } else if (d.type === 'waste') {
      deliverer = d.unit ? deptName(d.unit) : ''; receiver = 'ضایعات';
    } else if (d.type === 'shortage') {
      deliverer = d.unit ? deptName(d.unit) : ''; receiver = 'کسری';
    } else if (d.type === 'excess') {
      deliverer = 'اضافات'; receiver = d.unit ? deptName(d.unit) : '';
    } else if (d.type === 'initial') {
      deliverer = 'سیستم'; receiver = d.unit ? deptName(d.unit) : '';
    }
    let issuer = '';
    if (d.type === 'output' || d.type === 'return') {
      issuer = d.fromUnit ? deptName(d.fromUnit) : (d.unit ? deptName(d.unit) : 'سیستم');
    } else {
      issuer = d.unit ? deptName(d.unit) : 'سیستم';
    }
    let actions = '';
    const isOutput = d.type === 'output';
    const isReturn = d.type === 'return';
    const isPending = d.status === 'pending';
    const isApproved = d.status === 'approved';
    const isReturnPending = d.status === 'return_pending';
    const isSender = d.createdBy === currentUserName;
    const isReceiver = d.toUnit === userDeptName || d.toUnit === userDeptId;
    const isFromUnit = d.fromUnit === userDeptName || d.fromUnit === userDeptId;
    const isDocUnit = d.unit === userDeptName || d.unit === userDeptId;
    if (isOutput) {
      if (isPending) {
        if (isReceiver || isAdminUser) {
          actions += `<button onclick="approveByReceiver(${d.id})" style="background:#16a34a;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">✅ تایید</button>`;
          actions += `<button onclick="deleteDocument(${d.id})" style="background:#791F1F;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">❌ لغو</button>`;
        }
        if (isSender || isAdminUser) {
          actions += `<button onclick="deleteDocument(${d.id})" style="background:#791F1F;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">🗑️ حذف</button>`;
        }
      }
      else if (isApproved) {
        if (isSender || isReceiver || isAdminUser) {
          actions += `<button onclick="requestReturn(${d.id})" style="background:#2563EB;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">↩️ درخواست برگشت</button>`;
        }
      }
    }
    if (isReturn) {
      if (isReturnPending) {
        if (isReceiver || isAdminUser) {
          actions += `<button onclick="approveReturn(${d.id})" style="background:#16a34a;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">✅ تایید برگشت</button>`;
          actions += `<button onclick="rejectReturn(${d.id})" style="background:#791F1F;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">❌ لغو برگشت</button>`;
        }
        if (isSender || isAdminUser) {
          actions += `<button onclick="deleteDocument(${d.id})" style="background:#791F1F;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">🗑️ حذف</button>`;
        }
      }
    }
    if (d.type === 'production') {
      if (isApproved) {
        if (isAdminUser || isSender || isDocUnit) {
          actions += `<button onclick="cancelProductionDoc(${d.id})" style="background:#854F0B;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">↩️ لغو تولید</button>`;
        }
      }
    }
    if (d.type === 'consume' || d.type === 'waste' || d.type === 'shortage' || d.type === 'excess' || d.type === 'initial') {
      if (isApproved) {
        if (isAdminUser || isSender || isDocUnit) {
          actions += `<button onclick="cancelGeneralDoc(${d.id})" style="background:#854F0B;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">↩️ لغو</button>`;
        }
      }
      if (isPending && (isAdminUser || isSender || isDocUnit)) {
        actions += `<button onclick="deleteDocument(${d.id})" style="background:#791F1F;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:'Vazirmatn',sans-serif;margin:2px;">🗑️ حذف</button>`;
      }
    }
    if (!actions) actions = `<span style="font-size:10px;color:var(--sub);">—</span>`;
    html += `<tr style="border-bottom:1px solid #DDE0D8;${isReturn ? 'background:#EEEDFE;' : ''}">
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;font-weight:700;">${rowNum}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${issuer}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;font-weight:700;direction:ltr;">${d.id}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${d.date}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${deliverer}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${receiver}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${typeIcon} ${typeName}${d.note ? `<br><span style="font-size:10px;color:#6B7268;">${d.note}</span>` : ''}${d.parentDocId ? `<br><span style="font-size:9px;color:var(--sub);">سند اصلی: ${d.parentDocId}</span>` : ''}${d.batchNumber ? `<br><span class="batch-badge">🔢 ${d.batchNumber}</span>` : ''}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${d.item || '---'}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;">${itemUnit}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;font-weight:700;">${formatNumber(d.qty)}</td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;"><span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:${statusBg};color:${statusColor};">${statusName}</span></td>
      <td style="padding:6px;text-align:center;border:1px solid #DDE0D8;"><div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;">${actions}</div></td>
    </tr>`;
  });
  const totalCount = filtered.length;
  const pendingCount = filtered.filter(d => d.status === 'pending').length;
  const approvedCount = filtered.filter(d => d.status === 'approved').length;
  const cancelledCount = filtered.filter(d => d.status === 'cancelled').length;
  const returnPendingCount = filtered.filter(d => d.status === 'return_pending').length;
  const returnApprovedCount = filtered.filter(d => d.status === 'return_approved').length;
  const returnRejectedCount = filtered.filter(d => d.status === 'return_rejected').length;
  html += `</tbody><tfoot><tr style="background:#E1F5EE;font-weight:700;"><td colspan="12" style="padding:8px;text-align:center;border:1px solid #DDE0D8;">📊 جمع کل: ${totalCount} سند | <span style="color:#854F0B;">⏳ در انتظار تایید: ${pendingCount}</span> | <span style="color:#16a34a;">✅ تایید شده: ${approvedCount}</span> | <span style="color:#791F1F;">⛔ لغو شده: ${cancelledCount}</span> | <span style="color:#2563EB;">🔄 در انتظار برگشت: ${returnPendingCount}</span> | <span style="color:#16a34a;">✅ برگشت تایید: ${returnApprovedCount}</span> | <span style="color:#791F1F;">⛔ برگشت لغو: ${returnRejectedCount}</span></td></tr></tfoot></table></div>`;
  container.innerHTML = html;
  updateNotificationBadge();
}

// ============================================
// ===== خروجی اکسل =====
// ============================================
function exportDocumentsToExcel() {
  if (!isAdmin()) {
    showToast('⚠️ فقط مدیر سیستم می‌تواند خروجی اکسل دریافت کند', true);
    return;
  }
  showToast('📊 خروجی اکسل آماده می‌شود');
}

// ============================================
// ===== توابع مدیریت کاربران =====
// ============================================
function fillUserForm() {
  console.log('🔄 fillUserForm اجرا شد');
  const unit = document.getElementById('user-unit');
  if (!unit) {
    console.error('❌ عنصر user-unit پیدا نشد');
    return;
  }
  unit.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.name;
    option.textContent = d.name;
    unit.appendChild(option);
  });
  renderUsersList();
  console.log('✅ fillUserForm با موفقیت اجرا شد');
}

function renderUsersList() {
  const list = document.getElementById('users-list');
  if (!list) { console.error('❌ عنصر users-list پیدا نشد'); return; }
  if (!isAdmin()) {
    list.innerHTML = '<div class="empty">برای مشاهده لیست کاربران وارد حساب مدیر شوید</div>';
    return;
  }
  if (users.length === 0) {
    list.innerHTML = '<div class="empty">👤 کاربری تعریف نشده است</div>';
    return;
  }
  let html = `<div style="overflow-x:auto;"><table class="users-table"><thead><tr><th style="width:40px;">#</th><th>یوزرنیم</th><th>نام کامل</th><th>بخش</th><th>نقش</th><th style="width:160px;">عملیات</th></tr></thead><tbody>`;
  users.forEach((user, index) => {
    const isAdminUser = user.role === 'admin';
    html += `<tr><td style="text-align:center;">${index + 1}</td><td><strong>${user.username}</strong></td><td>${user.fullname}</td><td>${user.unit}</td><td><span class="pill ${isAdminUser ? 'admin' : ''}">${isAdminUser ? '👑 مدیر' : 'کاربر'}</span></td><td style="text-align:center;"><button onclick="openEditUserModal('${user.username}')" class="edit-btn" style="margin:2px;">✏️ ویرایش</button>${user.username !== 'admin' ? `<button class="danger" onclick="deleteUserByUsername('${user.username}')" style="padding:2px 8px;font-size:11px;margin:2px;">🗑️</button>` : '—'}</td></tr>`;
  });
  html += `</tbody><tfoot><tr style="background:var(--purple-l);font-weight:700;"><td colspan="6" style="padding:8px;text-align:center;">📊 تعداد کل کاربران: ${users.length}</td></tr></tfoot></table></div>`;
  list.innerHTML = html;
}

function openEditUserModal(username) {
  if (!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  const user = users.find(u => u.username === username);
  if (!user) { showToast('⚠️ کاربر یافت نشد', true); return; }
  editingUser = username;
  document.getElementById('edit-user-username').value = user.username;
  document.getElementById('edit-user-password').value = '';
  document.getElementById('edit-user-fullname').value = user.fullname;
  document.getElementById('edit-user-unit').value = user.unit;
  document.getElementById('edit-user-role').value = user.role;
  const unitSelect = document.getElementById('edit-user-unit');
  unitSelect.innerHTML = '';
  DEPTS.forEach(d => {
    const option = document.createElement('option');
    option.value = d.name;
    option.textContent = d.name;
    if (d.name === user.unit) option.selected = true;
    unitSelect.appendChild(option);
  });
  document.getElementById('editUserModal').classList.add('open');
}

function closeEditUserModal() {
  document.getElementById('editUserModal').classList.remove('open');
  editingUser = null;
}

async function saveUserEdit() {
  if (!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  const username = document.getElementById('edit-user-username').value.trim();
  const password = document.getElementById('edit-user-password').value.trim();
  const fullname = document.getElementById('edit-user-fullname').value.trim();
  const unit = document.getElementById('edit-user-unit').value;
  const role = document.getElementById('edit-user-role').value;
  if (!fullname) { showToast('⚠️ نام کامل الزامی است', true); return; }
  const user = users.find(u => u.username === username);
  if (!user) { showToast('⚠️ کاربر یافت نشد', true); return; }
  user.fullname = fullname;
  user.unit = unit;
  user.role = role;
  if (password && password.trim() !== '') {
    user.password = password.trim();
  }
  await saveData();
  closeEditUserModal();
  renderUsersList();
  showToast(`✅ کاربر "${username}" با موفقیت ویرایش شد`);
  if (currentUser && currentUser.username === username) {
    currentUser = user;
    document.getElementById('userName').textContent = user.fullname;
    document.getElementById('userUnit').textContent = user.unit;
    sessionStorage.setItem('currentUser', JSON.stringify(user));
  }
}

async function deleteUserByUsername(username) {
  if (!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  if (!username) {
    document.getElementById('user-msg').innerHTML = '⚠️ یوزرنیم را وارد کنید';
    document.getElementById('user-msg').style.color = 'var(--danger)';
    return;
  }
  if (username === 'admin') {
    document.getElementById('user-msg').innerHTML = '⚠️ نمی‌توان ادمین را حذف کرد';
    document.getElementById('user-msg').style.color = 'var(--danger)';
    return;
  }
  if (!await customConfirmModal(`⚠️ آیا مطمئن هستید که می‌خواهید کاربر "${username}" را حذف کنید؟`)) return;
  try {
    const response = await fetch(`${API_URL}/api/users/${username}`, { method: 'DELETE' });
    const result = await response.json();
    if (result.success) {
      const usersRes = await fetch(`${API_URL}/api/users`);
      users = await usersRes.json();
      saveToLocalStorage();
      document.getElementById('user-msg').innerHTML = '🗑️ کاربر حذف شد';
      document.getElementById('user-msg').style.color = 'var(--danger)';
      showToast('🗑️ کاربر حذف شد');
      renderUsersList();
      document.getElementById('user-username').value = '';
    } else {
      document.getElementById('user-msg').innerHTML = `⚠️ ${result.error || 'خطا در حذف کاربر'}`;
      document.getElementById('user-msg').style.color = 'var(--danger)';
    }
  } catch(e) {
    console.error('❌ خطا در حذف کاربر:', e);
    document.getElementById('user-msg').innerHTML = '❌ خطا در ارتباط با سرور';
    document.getElementById('user-msg').style.color = 'var(--danger)';
    showToast('❌ خطا در حذف کاربر', true);
  }
}

async function addUser() {
  if (!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  const username = document.getElementById('user-username').value.trim();
  const password = document.getElementById('user-password').value.trim();
  const fullname = document.getElementById('user-fullname').value.trim();
  const unit = document.getElementById('user-unit').value;
  const role = document.getElementById('user-role').value;
  const msg = document.getElementById('user-msg');
  const check = validateFields([
    {id:'user-username', label:'یوزرنیم', valid: !!username},
    {id:'user-password', label:'رمز عبور', valid: !!password},
    {id:'user-fullname', label:'نام کامل', valid: !!fullname},
  ]);
  if (!check.valid) {
    msg.innerHTML = `⚠️ این فیلدها را تکمیل کنید: ${check.missingLabels.join('، ')}`;
    msg.style.color = 'var(--danger)';
    return;
  }
  try {
    const response = await fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, fullname, unit, role })
    });
    const result = await response.json();
    if (result.success) {
      const usersRes = await fetch(`${API_URL}/api/users`);
      users = await usersRes.json();
      saveToLocalStorage();
      msg.innerHTML = '✅ کاربر اضافه شد';
      msg.style.color = 'var(--green)';
      document.getElementById('user-username').value = '';
      document.getElementById('user-password').value = '';
      document.getElementById('user-fullname').value = '';
      showToast('✅ کاربر اضافه شد');
      renderUsersList();
    } else {
      msg.innerHTML = `⚠️ ${result.error || 'خطا در افزودن کاربر'}`;
      msg.style.color = 'var(--danger)';
    }
  } catch(e) {
    console.error('❌ خطا در افزودن کاربر:', e);
    msg.innerHTML = '❌ خطا در ارتباط با سرور';
    msg.style.color = 'var(--danger)';
    showToast('❌ خطا در افزودن کاربر', true);
  }
}

async function deleteUser() {
  if (!isAdmin()) { showToast('⚠️ فقط مدیر', true); return; }
  const username = document.getElementById('user-username').value.trim();
  if (!username) {
    document.getElementById('user-msg').innerHTML = '⚠️ یوزرنیم را وارد کنید';
    document.getElementById('user-msg').style.color = 'var(--danger)';
    return;
  }
  await deleteUserByUsername(username);
}

// ============================================
// ===== توابع بکاپ =====
// ============================================
function backupData() {
  const dataToBackup = {
    version: '9.0',
    date: new Date().toISOString(),
    fiscalYears, activeFiscalYear, items, users,
    inventory, transactions, docs, initialInventory,
    productDefinitions, seq: {id: seqId, doc: docSeq}
  };
  const blob = new Blob([JSON.stringify(dataToBackup, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup_${activeFiscalYear}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ بکاپ با موفقیت دریافت شد');
}

async function restoreData(event) {
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const restored = JSON.parse(e.target.result);
      if(!restored.items || !restored.users) { showToast('⚠️ فایل بکاپ نامعتبر است', true); return; }
      if(!await customConfirmModal('⚠️ تمام داده‌های فعلی با داده‌های بکاپ جایگزین می‌شوند. ادامه؟')) return;
      items = restored.items;
      users = restored.users;
      inventory = restored.inventory || {};
      transactions = restored.transactions || [];
      docs = restored.docs || [];
      fiscalYears = restored.fiscalYears || DEFAULT_FISCAL_YEARS;
      activeFiscalYear = restored.activeFiscalYear || '1405';
      initialInventory = restored.initialInventory || [];
      productDefinitions = restored.productDefinitions || {};
      seqId = restored.seq?.id || 1;
      docSeq = restored.seq?.doc || 1;
      await saveData();
      updateFiscalUI();
      showToast('✅ داده‌ها با موفقیت بازیابی شدند');
      renderAll();
    } catch(err) {
      showToast('❌ خطا در بازیابی فایل: ' + err.message, true);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ============================================
// ===== پرینت فرم‌ها =====
// ============================================
function printProductionForm() {
  const unit = document.getElementById('prod-unit').value;
  const item = document.getElementById('prod-item').value;
  const qty = document.getElementById('prod-qty').value;
  const note = document.getElementById('prod-note').value;
  const method = document.getElementById('prod-method').value;
  const selectedMaterials = getSelectedMaterialsFromTable();
  const printWindow = window.open('', '_blank', 'width=800,height=600');
  printWindow.document.write(`<html dir="rtl"><head><title>فرم تولید</title><style>body{font-family:Tahoma,sans-serif;padding:30px;direction:rtl}.header{text-align:center;border-bottom:2px solid #0F6E56;padding-bottom:15px;margin-bottom:20px}.header h1{color:#0F6E56;margin:0}.info{display:flex;justify-content:space-between;margin:15px 0;padding:10px;background:#f5f5f5;border-radius:8px;flex-wrap:wrap;gap:10px}.info-item{font-size:14px}.info-item strong{color:#0F6E56}table{width:100%;border-collapse:collapse;margin:15px 0}th{background:#0F6E56;color:#fff;padding:8px;text-align:center}td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:center}.total-row{background:#E1F5EE;font-weight:700}.signature{display:flex;justify-content:space-between;margin-top:30px;padding-top:20px;border-top:2px solid #ddd}.sig-item{text-align:center;min-width:150px}.sig-item .line{width:150px;border-bottom:1px solid #000;margin:30px auto 5px}.sig-item .label{font-size:11px;color:#666}.batch{background:#EEEDFE;padding:4px 12px;border-radius:12px;font-size:12px;display:inline-block}.footer{text-align:center;margin-top:20px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:10px}</style></head><body>
    <div class="header"><h1>🏭 فرم ثبت تولید</h1><p>تاریخ: ${new Date().toLocaleDateString('fa-IR')} | ساعت: ${new Date().toLocaleTimeString('fa-IR')}</p></div>
    <div class="info"><div class="info-item">🏭 بخش: <strong>${deptName(unit)}</strong></div><div class="info-item">📦 محصول: <strong>${item}</strong></div><div class="info-item">🔢 تعداد: <strong>${qty}</strong></div><div class="info-item">📝 توضیح: <strong>${note || '---'}</strong></div></div>
    <div class="info" style="background:#EEEDFE;"><div class="info-item">🎯 روش تولید: <strong>${method === 'manual' ? 'تولید دستی' : 'تولید از مواد دریافتی'}</strong></div><div class="info-item"><span class="batch">🔢 بچ: ${new Date().getTime().toString().slice(-8)}</span></div></div>
    ${method === 'from-materials' && selectedMaterials.length > 0 ? `<h3>📋 مواد مصرفی</h3><table><thead><tr><th>ردیف</th><th>نام کالا</th><th>واحد</th><th>تعداد مصرف</th></tr></thead><tbody>${selectedMaterials.map((m,i)=>`<tr><td>${i+1}</td><td>${m.item}</td><td>${m.unit}</td><td>${formatNumber(m.qty)}</td></tr>`).join('')}<tr class="total-row"><td colspan="3">جمع کل</td><td>${selectedMaterials.length} قلم</td></tr></tbody></table>` : `<div style="text-align:center;color:#666;padding:20px;">⚠️ این تولید به صورت دستی ثبت شده و مصرف جداگانه ثبت می‌شود</div>`}
    <div class="signature"><div class="sig-item"><div class="line"></div><div class="label">امضای سرپرست بخش</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر انبار</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر کارخانه</div></div></div>
    <div class="footer">این سند به صورت خودکار توسط سیستم مدیریت انبار صادر شده است.</div>
    <script>window.print();setTimeout(()=>window.close(),1000);<\/script></body></html>`);
}

function printConsumeForm() {
  const unit = document.getElementById('consume-unit').value;
  const item = document.getElementById('consume-item').value;
  const qty = document.getElementById('consume-qty').value;
  const note = document.getElementById('consume-note').value;
  const printWindow = window.open('', '_blank', 'width=800,height=600');
  printWindow.document.write(`<html dir="rtl"><head><title>فرم مصرف</title><style>body{font-family:Tahoma,sans-serif;padding:30px;direction:rtl}.header{text-align:center;border-bottom:2px solid #791F1F;padding-bottom:15px;margin-bottom:20px}.header h1{color:#791F1F;margin:0}.info{display:flex;justify-content:space-between;margin:15px 0;padding:10px;background:#f5f5f5;border-radius:8px;flex-wrap:wrap;gap:10px}.info-item{font-size:14px}.info-item strong{color:#791F1F}.signature{display:flex;justify-content:space-between;margin-top:30px;padding-top:20px;border-top:2px solid #ddd}.sig-item{text-align:center;min-width:150px}.sig-item .line{width:150px;border-bottom:1px solid #000;margin:30px auto 5px}.sig-item .label{font-size:11px;color:#666}.footer{text-align:center;margin-top:20px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:10px}</style></head><body>
    <div class="header"><h1>📤 فرم ثبت مصرف</h1><p>تاریخ: ${new Date().toLocaleDateString('fa-IR')} | ساعت: ${new Date().toLocaleTimeString('fa-IR')}</p></div>
    <div class="info"><div class="info-item">🏭 بخش: <strong>${deptName(unit)}</strong></div><div class="info-item">📦 کالا: <strong>${item}</strong></div><div class="info-item">🔢 تعداد: <strong>${qty}</strong></div><div class="info-item">📝 توضیح: <strong>${note || '---'}</strong></div></div>
    <div class="signature"><div class="sig-item"><div class="line"></div><div class="label">امضای سرپرست بخش</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر انبار</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر کارخانه</div></div></div>
    <div class="footer">این سند به صورت خودکار توسط سیستم مدیریت انبار صادر شده است.</div>
    <script>window.print();setTimeout(()=>window.close(),1000);<\/script></body></html>`);
}

function printOutputForm() {
  const from = document.getElementById('output-from').value;
  const to = document.getElementById('output-to').value;
  const item = document.getElementById('output-item').value;
  const qty = document.getElementById('output-qty').value;
  const note = document.getElementById('output-note').value;
  const printWindow = window.open('', '_blank', 'width=800,height=600');
  printWindow.document.write(`<html dir="rtl"><head><title>فرم خروج</title><style>body{font-family:Tahoma,sans-serif;padding:30px;direction:rtl}.header{text-align:center;border-bottom:2px solid #0F6E56;padding-bottom:15px;margin-bottom:20px}.header h1{color:#0F6E56;margin:0}.info{display:flex;justify-content:space-between;margin:15px 0;padding:10px;background:#f5f5f5;border-radius:8px;flex-wrap:wrap;gap:10px}.info-item{font-size:14px}.info-item strong{color:#0F6E56}.status-badge{background:#FAEEDA;color:#854F0B;padding:4px 12px;border-radius:12px;font-size:12px}.signature{display:flex;justify-content:space-between;margin-top:30px;padding-top:20px;border-top:2px solid #ddd}.sig-item{text-align:center;min-width:150px}.sig-item .line{width:150px;border-bottom:1px solid #000;margin:30px auto 5px}.sig-item .label{font-size:11px;color:#666}.footer{text-align:center;margin-top:20px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:10px}</style></head><body>
    <div class="header"><h1>📤 فرم ثبت خروج به بخش دیگر</h1><p>تاریخ: ${new Date().toLocaleDateString('fa-IR')} | ساعت: ${new Date().toLocaleTimeString('fa-IR')}</p></div>
    <div class="info"><div class="info-item">🏭 از بخش: <strong>${deptName(from)}</strong></div><div class="info-item">🏭 به بخش: <strong>${deptName(to)}</strong></div><div class="info-item">📦 کالا: <strong>${item}</strong></div><div class="info-item">🔢 تعداد: <strong>${qty}</strong></div><div class="info-item">📝 توضیح: <strong>${note || '---'}</strong></div><div class="info-item"><span class="status-badge">⏳ در انتظار تایید گیرنده</span></div></div>
    <div class="signature"><div class="sig-item"><div class="line"></div><div class="label">امضای تحویل دهنده</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای تحویل گیرنده</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر انبار</div></div></div>
    <div class="footer">این سند به صورت خودکار توسط سیستم مدیریت انبار صادر شده است.</div>
    <script>window.print();setTimeout(()=>window.close(),1000);<\/script></body></html>`);
}

function printWasteForm() {
  const unit = document.getElementById('waste-unit').value;
  const item = document.getElementById('waste-item').value;
  const qty = document.getElementById('waste-qty').value;
  const note = document.getElementById('waste-note').value;
  const printWindow = window.open('', '_blank', 'width=800,height=600');
  printWindow.document.write(`<html dir="rtl"><head><title>فرم ضایعات</title><style>body{font-family:Tahoma,sans-serif;padding:30px;direction:rtl}.header{text-align:center;border-bottom:2px solid #791F1F;padding-bottom:15px;margin-bottom:20px}.header h1{color:#791F1F;margin:0}.info{display:flex;justify-content:space-between;margin:15px 0;padding:10px;background:#f5f5f5;border-radius:8px;flex-wrap:wrap;gap:10px}.info-item{font-size:14px}.info-item strong{color:#791F1F}.signature{display:flex;justify-content:space-between;margin-top:30px;padding-top:20px;border-top:2px solid #ddd}.sig-item{text-align:center;min-width:150px}.sig-item .line{width:150px;border-bottom:1px solid #000;margin:30px auto 5px}.sig-item .label{font-size:11px;color:#666}.footer{text-align:center;margin-top:20px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:10px}</style></head><body>
    <div class="header"><h1>🗑️ فرم ثبت ضایعات</h1><p>تاریخ: ${new Date().toLocaleDateString('fa-IR')} | ساعت: ${new Date().toLocaleTimeString('fa-IR')}</p></div>
    <div class="info"><div class="info-item">🏭 بخش: <strong>${deptName(unit)}</strong></div><div class="info-item">📦 کالا: <strong>${item}</strong></div><div class="info-item">🔢 تعداد: <strong>${qty}</strong></div><div class="info-item">📝 توضیح: <strong>${note || '---'}</strong></div></div>
    <div class="signature"><div class="sig-item"><div class="line"></div><div class="label">امضای سرپرست بخش</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر انبار</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر کارخانه</div></div></div>
    <div class="footer">این سند به صورت خودکار توسط سیستم مدیریت انبار صادر شده است.</div>
    <script>window.print();setTimeout(()=>window.close(),1000);<\/script></body></html>`);
}

function printAdjustForm() {
  const unit = document.getElementById('adjust-unit').value;
  const item = document.getElementById('adjust-item').value;
  const qty = document.getElementById('adjust-qty').value;
  const type = document.getElementById('adjust-type').value;
  const note = document.getElementById('adjust-note').value;
  const typeLabel = type === 'shortage' ? '📉 کسری' : '📈 اضافات';
  const printWindow = window.open('', '_blank', 'width=800,height=600');
  printWindow.document.write(`<html dir="rtl"><head><title>فرم تعدیل</title><style>body{font-family:Tahoma,sans-serif;padding:30px;direction:rtl}.header{text-align:center;border-bottom:2px solid #3C3489;padding-bottom:15px;margin-bottom:20px}.header h1{color:#3C3489;margin:0}.info{display:flex;justify-content:space-between;margin:15px 0;padding:10px;background:#f5f5f5;border-radius:8px;flex-wrap:wrap;gap:10px}.info-item{font-size:14px}.info-item strong{color:#3C3489}.signature{display:flex;justify-content:space-between;margin-top:30px;padding-top:20px;border-top:2px solid #ddd}.sig-item{text-align:center;min-width:150px}.sig-item .line{width:150px;border-bottom:1px solid #000;margin:30px auto 5px}.sig-item .label{font-size:11px;color:#666}.footer{text-align:center;margin-top:20px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:10px}</style></head><body>
    <div class="header"><h1>⚙️ فرم ثبت تعدیل</h1><p>تاریخ: ${new Date().toLocaleDateString('fa-IR')} | ساعت: ${new Date().toLocaleTimeString('fa-IR')}</p></div>
    <div class="info"><div class="info-item">🏭 بخش: <strong>${deptName(unit)}</strong></div><div class="info-item">📦 کالا: <strong>${item}</strong></div><div class="info-item">🔢 تعداد: <strong>${qty}</strong></div><div class="info-item">📊 نوع: <strong>${typeLabel}</strong></div><div class="info-item">📝 توضیح: <strong>${note || '---'}</strong></div></div>
    <div class="signature"><div class="sig-item"><div class="line"></div><div class="label">امضای سرپرست بخش</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر انبار</div></div><div class="sig-item"><div class="line"></div><div class="label">امضای مدیر کارخانه</div></div></div>
    <div class="footer">این سند به صورت خودکار توسط سیستم مدیریت انبار صادر شده است.</div>
    <script>window.print();setTimeout(()=>window.close(),1000);<\/script></body></html>`);
}

// ============================================
// ===== رندر کل =====
// ============================================
function renderAll() {
  renderDashboard();
  fillCardexForm();
  renderSummary();
  fillInitialInventoryForm();
  fillProductMgmtForm();
  fillProductionForm();
  fillConsumeForm();
  fillOutputForm();
  fillWasteForm();
  fillAdjustForm();
  renderDocuments();
  fillUserForm();
  renderItemsList();
  renderHistory();
  renderFiscalList();
  fillReportForm();
  updateNotificationBadge();
}

// ============================================
// ===== شروع برنامه =====
// ============================================
(async function init() {
  // قبلاً در بار اول بازکردن اپ، تا اتمام دانلود کل داده صفحه خالی/بدون بازخورد بود.
  // حالا یک اسپینر واضح نشون داده می‌شه تا کاربر بدونه چیزی در حال بارگذاریه.
  showAppLoading('در حال بارگذاری اطلاعات سیستم...');
  await loadData();
  hideAppLoading();
  const hasSession = checkSession();
  if(!hasSession) {
    document.getElementById('appContainer').classList.remove('active');
  }
  console.log('✅ سیستم آماده است');
  console.log('👤 تعداد کاربران:', users.length);
  console.log('📦 تعداد کالاها:', items.length);
  console.log('📋 تعداد محصولات تعریف شده:', Object.keys(productDefinitions).length);
})();
