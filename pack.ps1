<# 
.SYNOPSIS
    LightC Release Build Script
.DESCRIPTION
    Automates the build and packaging process for GitHub Release
#>

# Stop on error
$ErrorActionPreference = "Stop"

# ============================================================================
# 1. Read Version
# ============================================================================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  LightC Release Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Get project root directory
$ProjectRoot = $PSScriptRoot
$TauriConfigPath = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"

# Check if config file exists
if (-not (Test-Path $TauriConfigPath)) {
    Write-Host "Error: Cannot find tauri.conf.json" -ForegroundColor Red
    Write-Host "Path: $TauriConfigPath" -ForegroundColor Red
    exit 1
}

# Read and parse JSON config
Write-Host "[1/4] Reading version..." -ForegroundColor Yellow
$TauriConfig = Get-Content $TauriConfigPath -Raw | ConvertFrom-Json
$Version = $TauriConfig.version
$ProductName = $TauriConfig.productName

if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "Error: Cannot read version from config" -ForegroundColor Red
    exit 1
}

Write-Host "  Product: $ProductName" -ForegroundColor White
Write-Host "  Version: v$Version" -ForegroundColor White
Write-Host ""

# ============================================================================
# 2. Build
# ============================================================================

Write-Host "[2/4] Building..." -ForegroundColor Yellow
Write-Host "  Running: npm run tauri build" -ForegroundColor Gray

Push-Location $ProjectRoot

try {
    # Use cmd /c to run npm (npm is a script, not an exe)
    & cmd /c "npm run tauri build"
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: Build failed, exit code: $LASTEXITCODE" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    
    Write-Host "  Build completed!" -ForegroundColor Green
}
catch {
    Write-Host "Error: Build exception" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Pop-Location
    exit 1
}

Pop-Location
Write-Host ""

# ============================================================================
# 3. Package Artifacts
# ============================================================================

Write-Host "[3/4] Packaging artifacts..." -ForegroundColor Yellow

# Define paths
$ReleaseDir = Join-Path $ProjectRoot "src-tauri\target\release"
$BundleMsiDir = Join-Path $ReleaseDir "bundle\msi"
$BundleNsisDir = Join-Path $ReleaseDir "bundle\nsis"
$DistReleaseDir = Join-Path $ProjectRoot "dist_release"
$PortableFolderName = "LightC_" + $Version + "_Portable"
$PortableDir = Join-Path $DistReleaseDir $PortableFolderName

# Clean and create dist_release directory
if (Test-Path $DistReleaseDir) {
    Write-Host "  Cleaning old dist_release..." -ForegroundColor Gray
    Remove-Item $DistReleaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $DistReleaseDir -Force | Out-Null
Write-Host "  Created: $DistReleaseDir" -ForegroundColor Gray

# --------------------------------------------------------------------------
# 3.1 Copy MSI Installer
# --------------------------------------------------------------------------

Write-Host "  Processing MSI installer..." -ForegroundColor Gray

$MsiFiles = Get-ChildItem -Path $BundleMsiDir -Filter "*.msi" -ErrorAction SilentlyContinue

if ($null -eq $MsiFiles -or $MsiFiles.Count -eq 0) {
    Write-Host "  Warning: No MSI found, skipping..." -ForegroundColor Yellow
}
else {
    $SourceMsi = $MsiFiles[0].FullName
    $TargetMsiName = "LightC_" + $Version + "_x64_Installer.msi"
    $TargetMsi = Join-Path $DistReleaseDir $TargetMsiName
    
    Copy-Item $SourceMsi $TargetMsi -Force
    Write-Host "    Copied: $TargetMsiName" -ForegroundColor White
}

# --------------------------------------------------------------------------
# 3.2 Copy NSIS Installer
# --------------------------------------------------------------------------

Write-Host "  Processing NSIS installer..." -ForegroundColor Gray

$NsisFiles = Get-ChildItem -Path $BundleNsisDir -Filter "*.exe" -ErrorAction SilentlyContinue

if ($null -eq $NsisFiles -or $NsisFiles.Count -eq 0) {
    Write-Host "  Warning: No NSIS installer found, skipping..." -ForegroundColor Yellow
}
else {
    $SourceNsis = $NsisFiles[0].FullName
    $TargetNsisName = "LightC_" + $Version + "_x64_Setup.exe"
    $TargetNsis = Join-Path $DistReleaseDir $TargetNsisName
    
    Copy-Item $SourceNsis $TargetNsis -Force
    Write-Host "    Copied: $TargetNsisName" -ForegroundColor White
}

# --------------------------------------------------------------------------
# 3.3 Create Portable Version
# --------------------------------------------------------------------------

Write-Host "  Processing Portable version..." -ForegroundColor Gray

New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null

# Copy main exe
$ExePath = Join-Path $ReleaseDir "LightC.exe"

if (-not (Test-Path $ExePath)) {
    Write-Host "Error: Cannot find LightC.exe" -ForegroundColor Red
    Write-Host "Path: $ExePath" -ForegroundColor Red
    exit 1
}

Copy-Item $ExePath $PortableDir -Force
Write-Host "    Copied: LightC.exe" -ForegroundColor White

# Copy resources directory if exists
$ResourcesDir = Join-Path $ReleaseDir "resources"
if (Test-Path $ResourcesDir) {
    $ResourcesItems = Get-ChildItem $ResourcesDir -ErrorAction SilentlyContinue
    if ($null -ne $ResourcesItems -and $ResourcesItems.Count -gt 0) {
        Copy-Item $ResourcesDir (Join-Path $PortableDir "resources") -Recurse -Force
        Write-Host "    Copied: resources" -ForegroundColor White
    }
}

# Copy DLL files if exist
$DllFiles = Get-ChildItem -Path $ReleaseDir -Filter "*.dll" -ErrorAction SilentlyContinue
if ($null -ne $DllFiles) {
    foreach ($dll in $DllFiles) {
        Copy-Item $dll.FullName $PortableDir -Force
        Write-Host "    Copied: $($dll.Name)" -ForegroundColor White
    }
}

# Compress to ZIP
$ZipFileName = "LightC_" + $Version + "_x64_Portable.zip"
$ZipFilePath = Join-Path $DistReleaseDir $ZipFileName

Write-Host "  Compressing portable version..." -ForegroundColor Gray

Compress-Archive -Path $PortableDir -DestinationPath $ZipFilePath -Force
Write-Host "    Created: $ZipFileName" -ForegroundColor White

# Remove temp portable folder
Remove-Item $PortableDir -Recurse -Force

Write-Host ""

# ============================================================================
# 4. SHA256 Checksum
# ============================================================================

Write-Host "[4/4] Calculating SHA256 checksums..." -ForegroundColor Yellow

$Sha256SumsPath = Join-Path $DistReleaseDir "SHA256SUMS.txt"
$Sha256Content = @()

$FilesToHash = Get-ChildItem -Path $DistReleaseDir -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" }

foreach ($file in $FilesToHash) {
    $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
    $hashLine = "$($hash.Hash)  $($file.Name)"
    $Sha256Content += $hashLine
    Write-Host "  $($file.Name)" -ForegroundColor White
    Write-Host "    SHA256: $($hash.Hash)" -ForegroundColor Gray
}

$Sha256Content | Out-File -FilePath $Sha256SumsPath -Encoding UTF8
Write-Host "  Generated: SHA256SUMS.txt" -ForegroundColor White

Write-Host ""

# ============================================================================
# Done
# ============================================================================

Write-Host "========================================" -ForegroundColor Green
Write-Host "  Build Success!" -ForegroundColor Green
Write-Host "  Artifacts are in dist_release folder" -ForegroundColor Green
Write-Host "  Please upload to GitHub Release" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# List artifacts
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
Write-Host "Path: $DistReleaseDir" -ForegroundColor Cyan
