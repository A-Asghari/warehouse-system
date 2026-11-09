# بازگشتِ کامل به حالتِ قبل: دوشاخه و سایه حذف، Node دوباره روی ۳۰۰۰ (Run as Administrator)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Dst = "C:\WarehouseSystem-py"
$NodeXml = "C:\WarehouseSystem\service\WarehouseSystem.xml"
foreach ($s in "WarehouseTee", "WarehouseShadow") {
  if (Get-Service $s -ErrorAction SilentlyContinue) {
    Stop-Service $s -Force -ErrorAction SilentlyContinue
    & "$Dst\service\$s.exe" uninstall | Out-Null
  }
}
Stop-Service WarehouseSystem -ErrorAction SilentlyContinue
if (Test-Path "$Dst\backup-of-node-config\WarehouseSystem.xml") {
  Copy-Item "$Dst\backup-of-node-config\WarehouseSystem.xml" $NodeXml -Force
}
Start-Service WarehouseSystem
Write-Host "سیستمِ فعلی دوباره مستقیماً روی ۳۰۰۰ است. (داده‌های Node هیچ‌وقت دست نخورده بودند)"
