$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  LightC Release Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$ProjectRoot = $PSScriptRoot
$TauriConfigPath = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"
$PrivateKeyPath = Join-Path $ProjectRoot ".tauri\lightc.key"

function Convert-ToReleaseSignature {
    param([string]$SignatureText)

    $TrimmedSignature = $SignatureText.Trim()
    if ($TrimmedSignature.StartsWith("untrusted comment:")) {
        return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($TrimmedSignature))
    }
    return $TrimmedSignature
}

function New-ExeSignatureAsset {
    param(
        [string]$ExecutablePath,
        [string]$OutputPath
    )

    if (-not (Test-Path $ExecutablePath)) {
        throw "Cannot find executable to sign: $ExecutablePath"
    }

    $GeneratedSigPath = "$ExecutablePath.sig"
    if (Test-Path $GeneratedSigPath) {
        Remove-Item $GeneratedSigPath -Force
    }
    $SignatureOutput = npx tauri signer sign $ExecutablePath
    if ($LASTEXITCODE -ne 0) {
        throw "Executable signing failed: $ExecutablePath"
    }
    if (Test-Path $GeneratedSigPath) {
        $SignatureText = [System.IO.File]::ReadAllText($GeneratedSigPath, [System.Text.Encoding]::UTF8)
        $SignatureBase64 = Convert-ToReleaseSignature $SignatureText
    } else {
        $SignatureBase64 = ($SignatureOutput -split "`r?`n" | Where-Object { $_ -match '^[A-Za-z0-9+/=]+$' } | Select-Object -Last 1)
    }

    if ([string]::IsNullOrWhiteSpace($SignatureBase64)) {
        throw "Signature output not found for: $ExecutablePath"
    }

    $SignatureBase64 | Out-File -FilePath $OutputPath -Encoding utf8 -NoNewline
    Write-Host "    Created: $([System.IO.Path]::GetFileName($OutputPath))" -ForegroundColor Green
}

if (-not (Test-Path $TauriConfigPath)) {
    Write-Host "Error: Cannot find tauri.conf.json at $TauriConfigPath" -ForegroundColor Red
    exit 1
}

Write-Host "[1/4] Reading version..." -ForegroundColor Yellow

$RawJson = [System.IO.File]::ReadAllText($TauriConfigPath, [System.Text.Encoding]::UTF8)
if ($RawJson.Length -gt 0 -and [int][char]$RawJson[0] -eq 65279) {
    $RawJson = $RawJson.Substring(1)
}

$TauriConfig = $RawJson | ConvertFrom-Json
$Version = $TauriConfig.version
$ProductName = $TauriConfig.productName

if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "Error: Cannot read version from tauri.conf.json" -ForegroundColor Red
    exit 1
}

Write-Host "  Product: $ProductName" -ForegroundColor White
Write-Host "  Version: v$Version" -ForegroundColor White
Write-Host ""

Write-Host "[2/4] Building..." -ForegroundColor Yellow
Write-Host "  Running: npm run tauri build" -ForegroundColor Gray

if (Test-Path $PrivateKeyPath) {
    $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText($PrivateKeyPath, [System.Text.Encoding]::UTF8).Trim()
    $SigningPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    if ([string]::IsNullOrWhiteSpace($SigningPassword)) {
        $SigningPassword = $env:TAURI_PRIVATE_KEY_PASSWORD
    }
    if ([string]::IsNullOrWhiteSpace($SigningPassword)) {
        throw "Signing password is required in TAURI_SIGNING_PRIVATE_KEY_PASSWORD or TAURI_PRIVATE_KEY_PASSWORD"
    }
    # 使用调用方注入的密码，避免把私钥密码写入脚本或提交到仓库。
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $SigningPassword
    # Tauri 构建和独立 signer 使用不同的环境变量名，两者都设置才能保证每种包都能生成签名。
    $env:TAURI_PRIVATE_KEY = $env:TAURI_SIGNING_PRIVATE_KEY
    $env:TAURI_PRIVATE_KEY_PASSWORD = $SigningPassword
    Write-Host "  Private key loaded from $PrivateKeyPath" -ForegroundColor Gray
} else {
    throw "Private key is required to generate installer and portable exe signature assets: $PrivateKeyPath"
}

Push-Location $ProjectRoot
# 注意：npm 会把 "npm notice ..." 写到 stderr，而脚本开头是 $ErrorActionPreference = "Stop"。
# 不合并输出的话，PowerShell 会把它当成 NativeCommandError 抛异常，
# 脚本会在构建已经成功、exit code 还是 0 的情况下直接中止（后面的打包/签名/校验全不执行）。
& cmd /c "npm run tauri build 2>&1"
$buildExit = $LASTEXITCODE
Pop-Location

if ($buildExit -ne 0) {
    Write-Host "Error: Build failed, exit code: $buildExit" -ForegroundColor Red
    exit 1
}

Write-Host "  Build completed!" -ForegroundColor Green
Write-Host ""

Write-Host "[3/4] Packaging artifacts..." -ForegroundColor Yellow

$ReleaseDir = Join-Path $ProjectRoot "src-tauri\target\release"
$BundleMsiDir = Join-Path $ReleaseDir "bundle\msi"
$BundleNsisDir = Join-Path $ReleaseDir "bundle\nsis"
$DistReleaseDir = Join-Path $ProjectRoot "dist_release"
$PortableDir = Join-Path $DistReleaseDir ("LightC_" + $Version + "_Portable")

if (Test-Path $DistReleaseDir) {
    Write-Host "  Cleaning old dist_release..." -ForegroundColor Gray
    Remove-Item $DistReleaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $DistReleaseDir -Force | Out-Null
Write-Host "  Created: $DistReleaseDir" -ForegroundColor Gray

Write-Host "  Processing MSI installer..." -ForegroundColor Gray
$MsiFiles = Get-ChildItem -Path $BundleMsiDir -Filter "*.msi" -ErrorAction SilentlyContinue
if ($null -eq $MsiFiles -or $MsiFiles.Count -eq 0) {
    Write-Host "  Warning: No MSI found, skipping..." -ForegroundColor Yellow
} else {
    $TargetMsiName = "LightC_" + $Version + "_x64_Installer.msi"
    Copy-Item $MsiFiles[0].FullName (Join-Path $DistReleaseDir $TargetMsiName) -Force
    Write-Host "    Copied: $TargetMsiName" -ForegroundColor White
}

Write-Host "  Processing NSIS installer..." -ForegroundColor Gray
$NsisFiles = Get-ChildItem -Path $BundleNsisDir -Filter "*.exe" -ErrorAction SilentlyContinue
if ($null -eq $NsisFiles -or $NsisFiles.Count -eq 0) {
    Write-Host "  Warning: No NSIS installer found, skipping..." -ForegroundColor Yellow
} else {
    $TargetNsisName = "LightC_" + $Version + "_x64_Setup.exe"
    Copy-Item $NsisFiles[0].FullName (Join-Path $DistReleaseDir $TargetNsisName) -Force
    Write-Host "    Copied: $TargetNsisName" -ForegroundColor White

    $NsisSignatureSource = "$($NsisFiles[0].FullName).sig"
    if (-not (Test-Path $NsisSignatureSource)) {
        throw "NSIS installer signature is missing: $NsisSignatureSource"
    }
    Copy-Item $NsisSignatureSource (Join-Path $DistReleaseDir "$TargetNsisName.sig") -Force
    Write-Host "    Copied: $TargetNsisName.sig" -ForegroundColor White
}

Write-Host "  Processing Portable version..." -ForegroundColor Gray
New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null

$ExePath = Join-Path $ReleaseDir "LightC.exe"
if (-not (Test-Path $ExePath)) {
    Write-Host "Error: Cannot find LightC.exe at $ExePath" -ForegroundColor Red
    exit 1
}
Copy-Item $ExePath $PortableDir -Force
Write-Host "    Copied: LightC.exe" -ForegroundColor White

# 旧 marker 继续保留；manifest 让新版程序能够校验数据目录采用相对路径。
Set-Content -Path (Join-Path $PortableDir "LightC.portable") -Value "portable" -Encoding UTF8
$PortableManifest = [ordered]@{
    schema_version = 1
    mode = "portable"
    data_layout = "relative"
}
$PortableManifest | ConvertTo-Json | Out-File -FilePath (Join-Path $PortableDir "LightC.portable.json") -Encoding utf8
Write-Host "    Created: portable mode manifest" -ForegroundColor White

# 安装版和便携版校验的都是当前运行时 exe，分别输出固定资产名供完整性校验下载。
$InstallerSignaturePath = Join-Path $DistReleaseDir "LightC_installer_exe.sig"
$PortableSignaturePath = Join-Path $DistReleaseDir "LightC_portable_exe.sig"
New-ExeSignatureAsset -ExecutablePath $ExePath -OutputPath $InstallerSignaturePath
New-ExeSignatureAsset -ExecutablePath (Join-Path $PortableDir "LightC.exe") -OutputPath $PortableSignaturePath

$ResourcesDir = Join-Path $ReleaseDir "resources"
if (Test-Path $ResourcesDir) {
    $ResItems = Get-ChildItem $ResourcesDir -ErrorAction SilentlyContinue
    if ($null -ne $ResItems -and $ResItems.Count -gt 0) {
        Copy-Item $ResourcesDir (Join-Path $PortableDir "resources") -Recurse -Force
        Write-Host "    Copied: resources" -ForegroundColor White
    }
}

$DllFiles = Get-ChildItem -Path $ReleaseDir -Filter "*.dll" -ErrorAction SilentlyContinue
if ($null -ne $DllFiles) {
    foreach ($dll in $DllFiles) {
        Copy-Item $dll.FullName $PortableDir -Force
        Write-Host "    Copied: $($dll.Name)" -ForegroundColor White
    }
}

$ZipFileName = "LightC_" + $Version + "_x64_Portable.zip"
$ZipFilePath = Join-Path $DistReleaseDir $ZipFileName
Write-Host "  Compressing portable version..." -ForegroundColor Gray
Compress-Archive -Path $PortableDir -DestinationPath $ZipFilePath -Force
Write-Host "    Created: $ZipFileName" -ForegroundColor White
Remove-Item $PortableDir -Recurse -Force

Write-Host ""

Write-Host "[4/4] Calculating SHA256 checksums..." -ForegroundColor Yellow

$Sha256SumsPath = Join-Path $DistReleaseDir "SHA256SUMS.txt"
$Sha256Lines = [System.Collections.Generic.List[string]]::new()

$FilesToHash = Get-ChildItem -Path $DistReleaseDir -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" }

foreach ($file in $FilesToHash) {
    $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
    $hashLine = "$($hash.Hash)  $($file.Name)"
    $Sha256Lines.Add($hashLine)
    Write-Host "  $($file.Name)" -ForegroundColor White
    Write-Host "    SHA256: $($hash.Hash)" -ForegroundColor Gray
}

[System.IO.File]::WriteAllLines($Sha256SumsPath, $Sha256Lines, (New-Object System.Text.UTF8Encoding $false))
Write-Host "  Generated: SHA256SUMS.txt" -ForegroundColor White
Write-Host ""

Write-Host "========================================" -ForegroundColor Green
Write-Host "  Build Success!" -ForegroundColor Green
Write-Host "  Artifacts are in dist_release folder" -ForegroundColor Green
Write-Host "  Please upload to GitHub Release" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

Write-Host "Artifacts:" -ForegroundColor Cyan
Get-ChildItem -Path $DistReleaseDir | ForEach-Object {
    if ($_.Length -gt 1MB) {
        $size = "{0:N2} MB" -f ($_.Length / 1MB)
    } else {
        $size = "{0:N2} KB" -f ($_.Length / 1KB)
    }
    Write-Host "  - $($_.Name) ($size)" -ForegroundColor White
}

Write-Host ""
Write-Host "Version: v$Version" -ForegroundColor Cyan
Write-Host "Path:    $DistReleaseDir" -ForegroundColor Cyan

Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:\TAURI_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\TAURI_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
