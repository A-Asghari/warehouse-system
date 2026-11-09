[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ==================== تنظیمات این برنامه ====================
$AppDisplayName = "سیستم انبار"
$AppId          = "WarehouseSystem"
$Publisher      = "نوین کابل همراه"
$AppVersion     = "1.0.0"
$InstallDir     = "C:\WarehouseSystem"
$IconPath       = Join-Path $InstallDir "app.ico"
$UninstallPs1   = Join-Path $InstallDir "Uninstall.ps1"
$AppUrl         = "http://127.0.0.1:3000"
$TaskName       = "WarehouseSystem"
$LauncherBat    = Join-Path $InstallDir "start_warehouse.bat"
# --- سرویس ویندوز ---
$ServiceId      = "WarehouseSystem"
$AppPort        = 3000
$ServiceWorkDir = $InstallDir
$ServiceArgs    = "server.js"
$ServiceEnv     = @{}
$ServiceExePath = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $ServiceExePath)) {
    Write-Host "[خطا] Node.js پیدا نشد: $ServiceExePath" -ForegroundColor Red
    exit 1
}
# ==============================================================

Write-Host "===================================================="
Write-Host " نصب/به‌روزرسانی $AppDisplayName"
Write-Host "===================================================="
Write-Host ""

if (-not (Test-Path $InstallDir)) {
    Write-Host "[خطا] پوشهٔ برنامه پیدا نشد: $InstallDir" -ForegroundColor Red
    Write-Host "این نصب‌کننده باید همیشه کنار همون پوشهٔ WarehouseSystem بمونه."
    exit 1
}

# ---- ۱) میانبر در Start Menu (به‌صورت Internet Shortcut که مستقیم آدرس برنامه رو باز می‌کنه) ----
Write-Host "[۱/۳] ساخت میانبر در Start Menu ..."
$startMenuDir = [Environment]::GetFolderPath("CommonPrograms")
$urlShortcutPath = Join-Path $startMenuDir "$AppDisplayName.url"
$urlShortcutContent = @"
[InternetShortcut]
URL=$AppUrl
IconFile=$IconPath
IconIndex=0
"@
Set-Content -Path $urlShortcutPath -Value $urlShortcutContent -Encoding ASCII -Force
Write-Host "      انجام شد: $urlShortcutPath"

# ---- ۲) ثبت در «برنامه‌ها و ویژگی‌ها» (Add/Remove Programs) ----
Write-Host "[۲/۳] ثبت در فهرست برنامه‌های ویندوز ..."
$uninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppId"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName"     -Value $AppDisplayName
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"  -Value $AppVersion
Set-ItemProperty -Path $uninstallKey -Name "Publisher"       -Value $Publisher
Set-ItemProperty -Path $uninstallKey -Name "DisplayIcon"     -Value $IconPath
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $InstallDir
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UninstallPs1`""
Set-ItemProperty -Path $uninstallKey -Name "NoModify"        -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name "NoRepair"        -Value 1 -Type DWord
Write-Host "      انجام شد."

# ---- ۳) نصب به‌عنوان سرویس ویندوز (WinSW) ----
# سرویس ویندوز با بالا اومدنِ سیستم خودکار روشن می‌شه (حتی بدون لاگین)، محدودیتِ زمانی نداره،
# و اگه برنامه به هر دلیلی بسته/کرش کنه، خودِ ویندوز دوباره روشنش می‌کنه.
Write-Host "[۳/۳] نصب به‌عنوان سرویس ویندوز ..."
$ServiceDir = Join-Path $InstallDir "service"
$ServiceExe = Join-Path $ServiceDir "$ServiceId.exe"
$ServiceXml = Join-Path $ServiceDir "$ServiceId.xml"
$WinswSrc   = Join-Path $ServiceDir "winsw.exe"
if (-not (Test-Path $WinswSrc)) {
    Write-Host "[خطا] فایل $WinswSrc پیدا نشد." -ForegroundColor Red
    exit 1
}

# اجرای خودکارِ قدیمی (Task Scheduler) حذف می‌شه تا دو نسخه هم‌زمان اجرا نشن
schtasks /end /tn $TaskName 2>$null | Out-Null
schtasks /delete /tn $TaskName /f 2>$null | Out-Null

# اگه سرویس از قبل نصبه، اول متوقف و حذفش کن (برای نصبِ دوباره با تنظیماتِ جدید)
if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
    Write-Host "      سرویسِ قبلی پیدا شد — متوقف و حذف می‌شه ..."
    & $ServiceExe stop 2>$null | Out-Null
    Start-Sleep -Seconds 3
    & $ServiceExe uninstall 2>$null | Out-Null
    Start-Sleep -Seconds 3
}

# اگه برنامه هنوز جایی (مثلاً پنجره‌ی دستی) روی همین پورت در حالِ اجراست، ببندش
$ownerPids = Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $ownerPids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and ($proc.ProcessName -match '^(python|pythonw|py|node)$')) {
        Write-Host "      بستنِ نسخه‌ی در حالِ اجرا (PID $p) ..."
        Stop-Process -Id $p -Force
    }
}
Start-Sleep -Seconds 2

Copy-Item $WinswSrc $ServiceExe -Force
Copy-Item "$WinswSrc.config" "$ServiceExe.config" -Force   # لازم برای اجرا روی .NET 4
$envXml = ""
foreach ($k in $ServiceEnv.Keys) { $envXml += "  <env name=`"$k`" value=`"$($ServiceEnv[$k])`" />`r`n" }
$serviceConfig = @"
<service>
  <id>$ServiceId</id>
  <name>$AppDisplayName</name>
  <description>$AppDisplayName — $AppUrl</description>
  <executable>$ServiceExePath</executable>
  <arguments>$ServiceArgs</arguments>
  <workingdirectory>$ServiceWorkDir</workingdirectory>
$envXml  <logpath>$ServiceDir\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
</service>
"@
[System.IO.File]::WriteAllText($ServiceXml, $serviceConfig, (New-Object System.Text.UTF8Encoding($true)))
New-Item -ItemType Directory -Path (Join-Path $ServiceDir "logs") -Force | Out-Null

& $ServiceExe install | Out-Null
& $ServiceExe start | Out-Null
Start-Sleep -Seconds 5
$svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "      انجام شد — سرویس «$ServiceId» نصب و روشن شد." -ForegroundColor Green
} else {
    Write-Host "      [هشدار] سرویس نصب شد ولی روشن نیست. لاگ‌ها: $ServiceDir\logs" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===================================================="
Write-Host " نصب/به‌روزرسانی با موفقیت انجام شد."
Write-Host " برنامه از فهرست Start Menu یا آدرس $AppUrl در دسترسه."
Write-Host " هیچ فایل داده‌ای (db.json/بکاپ‌ها/لاگ‌ها) دست نخورد."
Write-Host "===================================================="
