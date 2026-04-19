Set-Location $PSScriptRoot

# ===== LightC官方 hash =====
$allowedHashes = @(
    "902EFD92334CF7904666DB651D91607D236A8636F20F454F067FEA616C8A91CF",
    "83424650C1675F8D1F651AA5FC0DF1BF78FECD8A00747CE4ABA42BB7890C1D7D"
)

$files = Get-ChildItem -Path . -File | Where-Object {
    $_.Extension -in ".exe", ".msi"
}

if ($files.Count -eq 0) {
    Write-Host "No exe or msi found"
    Pause
    exit
}

foreach ($file in $files) {
    $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash

    if ($allowedHashes -contains $hash) {
        Write-Host "$($file.Name): OK (official file)."
    } else {
        Write-Host "$($file.Name): WARNING (NOT official) !!!"
    }
}

Pause
