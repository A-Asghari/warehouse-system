# نصبِ «دورهٔ آزمایشیِ موازی» سیستم تولید — فقط با هماهنگی و در زمانِ توافق‌شده اجرا شود (Run as Administrator)
# کاری که می‌کند:
#   ۱) کدِ نسخهٔ جدید را در C:\WarehouseSystem-py کپی می‌کند (پوشهٔ C:\WarehouseSystem دست نمی‌خورد، جز فایلِ تنظیمِ سرویس)
#   ۲) سیستمِ فعلی (Node) را از پورتِ ۳۰۰۰ به پورتِ داخلیِ ۳۱۰۰ می‌برد (حدود ۱۰ ثانیه قطعی)
#   ۳) «دوشاخه» روی ۳۰۰۰/۳۴۴۳ هر درخواست را به Node می‌دهد (کاربر فقط پاسخِ Node را می‌بیند) و یک کپی به «سایه» (۳۲۰۰، فقط داخلی)
# بازگشت: rollback_shadow.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$Pkg   = $PSScriptRoot
$Dst   = "C:\WarehouseSystem-py"
$NodeDir = "C:\WarehouseSystem"
$NodeSvc = "WarehouseSystem"
$NodeXml = Join-Path $NodeDir "service\WarehouseSystem.xml"
$WinSW   = Join-Path $NodeDir "service\winsw.exe"

function Say($m) { Write-Host $m }
function Fail($m) { Write-Host "[خطا] $m" -ForegroundColor Red; exit 1 }
function Wait-Http($url, $sec) {
  for ($i = 0; $i -lt $sec; $i++) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; if ($r.StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

# ---- ۰) پیش‌نیازها ----
$py = (& py -3 -c "import sys;print(sys.executable)" 2>$null)
if (-not $py) { Fail "پایتون پیدا نشد (py -3)" }
$ver = (& py -3 -c "import sys;print(sys.version_info[0]*100+sys.version_info[1])")
if ([int]$ver -lt 310) { Fail "پایتون ۳.۱۰ یا جدیدتر لازم است" }
if (-not (Get-Service $NodeSvc -ErrorAction SilentlyContinue)) { Fail "سرویسِ $NodeSvc پیدا نشد" }
if (-not (Test-Path $WinSW)) { Fail "WinSW پیدا نشد: $WinSW" }
foreach ($p in 3100, 3200, 3543) { if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { Fail "پورت $p اشغال است" } }
Say "پایتون: $py"

# ---- ۱) کپیِ کد ----
New-Item -ItemType Directory -Force -Path "$Dst\app", "$Dst\shadow-data", "$Dst\reports", "$Dst\service\logs", "$Dst\backup-of-node-config" | Out-Null
Copy-Item "$Pkg\app\*.py" "$Dst\app\" -Force
Copy-Item $NodeXml "$Dst\backup-of-node-config\WarehouseSystem.xml" -Force
$key = [guid]::NewGuid().ToString("N")

function Write-Svc($id, $name, $svcArgs) {
  Copy-Item $WinSW "$Dst\service\$id.exe" -Force
  if (Test-Path "$WinSW.config") { Copy-Item "$WinSW.config" "$Dst\service\$id.exe.config" -Force }
  $xml = @"
<service>
  <id>$id</id>
  <name>$name</name>
  <description>$name</description>
  <executable>$py</executable>
  <arguments>$svcArgs</arguments>
  <workingdirectory>$Dst\app</workingdirectory>
  <env name="PYTHONUTF8" value="1"/>
  <env name="SHADOW_KEY" value="$key"/>
  <logpath>$Dst\service\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
  <onfailure action="restart" delay="5 sec" />
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
</service>
"@
  [System.IO.File]::WriteAllText("$Dst\service\$id.xml", $xml, (New-Object System.Text.UTF8Encoding($true)))
  & "$Dst\service\$id.exe" install | Out-Null
}
Write-Svc "WarehouseShadow" "سیستم تولید - نسخهٔ جدید (سایه)" "server.py --mode shadow --port 3200 --data $Dst\shadow-data --public $NodeDir\public --app-dir $Dst --cert-dir C:\dastoor-pardakht\app\certs --node-db $NodeDir\db.json --reports $Dst\reports"
Write-Svc "WarehouseTee" "سیستم تولید - دوشاخهٔ دورهٔ آزمایشی" "tee.py --node-http 127.0.0.1:3100 --shadow 127.0.0.1:3200 --listen 3000 --listen-https 3443"

# ---- ۲) جابه‌جاییِ Node به ۳۱۰۰ (از این‌جا تا آخر ~۱۰ ثانیه قطعی) ----
Say "توقفِ سیستمِ فعلی ..."
Stop-Service $NodeSvc
try {
  [xml]$x = Get-Content $NodeXml -Encoding UTF8
  foreach ($n in @(@("PORT","3100"), @("HTTPS_PORT","3543"))) {
    $e = $x.CreateElement("env"); $e.SetAttribute("name", $n[0]); $e.SetAttribute("value", $n[1]); $x.service.AppendChild($e) | Out-Null
  }
  $x.Save($NodeXml)
  # عکسِ لحظه‌ای از داده در لحظه‌ای که Node خاموش است → نقطهٔ شروعِ مشترکِ هر دو
  Copy-Item "$NodeDir\db.json" "$Dst\shadow-data\seed-db.json" -Force
  & py -3 "$Dst\app\migrate.py" --from "$Dst\shadow-data\seed-db.json" --to "$Dst\shadow-data" --replace
  if ($LASTEXITCODE -ne 0) { throw "migrate failed" }
  Start-Service $NodeSvc
  if (-not (Wait-Http "http://127.0.0.1:3100/api/data-version" 30)) { throw "Node روی ۳۱۰۰ بالا نیامد" }
  Start-Service WarehouseShadow
  Start-Service WarehouseTee
  if (-not (Wait-Http "http://127.0.0.1:3000/api/data-version" 30)) { throw "دوشاخه روی ۳۰۰۰ بالا نیامد" }
  Say "✅ انجام شد. کاربران مثل قبل به ۳۰۰۰/۳۴۴۳ وصل‌اند؛ گزارش‌ها: $Dst\reports"
} catch {
  Write-Host "[خطا] $_ — بازگرداندنِ خودکار ..." -ForegroundColor Red
  & "$Pkg\rollback_shadow.ps1"
  exit 1
}
