[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$AppDisplayName = "سیستم انبار"
$AppId          = "WarehouseSystem"
$InstallDir     = "C:\WarehouseSystem"
$TaskName       = "WarehouseSystem"
$ServiceId      = "WarehouseSystem"

Write-Host "===================================================="
Write-Host " حذف نصب $AppDisplayName"
Write-Host "===================================================="
Write-Host ""

Write-Host "توقف اجرای خودکار ..."
schtasks /delete /tn $TaskName /f 2>$null | Out-Null

Write-Host "توقف و حذف سرویس ویندوز ..."
$ServiceExe = Join-Path $InstallDir "service\$ServiceId.exe"
if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
    if (Test-Path $ServiceExe) {
        & $ServiceExe stop 2>$null | Out-Null
        Start-Sleep -Seconds 3
        & $ServiceExe uninstall 2>$null | Out-Null
    } else {
        sc.exe stop $ServiceId | Out-Null
        sc.exe delete $ServiceId | Out-Null
    }
}

Write-Host "حذف میانبر Start Menu ..."
$startMenuDir = [Environment]::GetFolderPath("CommonPrograms")
$urlShortcutPath = Join-Path $startMenuDir "$AppDisplayName.url"
if (Test-Path $urlShortcutPath) { Remove-Item $urlShortcutPath -Force }

Write-Host "حذف از فهرست برنامه‌های ویندوز ..."
$uninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppId"
if (Test-Path $uninstallKey) { Remove-Item $uninstallKey -Recurse -Force }

Write-Host ""
Write-Host "===================================================="
Write-Host " انجام شد — برنامه دیگه خودکار اجرا نمی‌شه و از فهرست"
Write-Host " برنامه‌ها حذف شد."
Write-Host ""
Write-Host " توجه: عمداً هیچ فایلی از پوشهٔ $InstallDir"
Write-Host " (شامل db.json، بکاپ‌ها و لاگ‌ها) پاک نشد تا اطلاعاتتون"
Write-Host " در امان بمونه. اگه واقعاً می‌خواید این پوشه رو هم پاک"
Write-Host " کنید، خودتون دستی از روی سیستم حذفش کنید."
Write-Host "===================================================="
Write-Host ""
Read-Host "برای بستن، اینتر رو بزنید"
