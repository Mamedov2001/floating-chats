# FloatingChats - floating Discord chat tiles for Vencord
# Copyright (c) 2026 Mamedov2001
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds the ready-to-install archive release\out\FloatingChats-<version>-windows.zip:
#   Vencord (sibling ..\..\Vencord, with the plugin linked by setup.ps1) built with its updater disabled,
#   plus install/uninstall scripts, README.txt and LICENSE.
# Afterwards Vencord is rebuilt normally, so the developer's own Discord keeps a regular dev build.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)

param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = "Stop"
$plugin = Split-Path $PSScriptRoot -Parent
$vencord = Join-Path (Split-Path $plugin -Parent) "Vencord"
if (-not (Test-Path (Join-Path $vencord "package.json"))) { throw "Vencord not found at $vencord" }

function Run-Build([string[]]$extra) {
    Push-Location $vencord
    try {
        & pnpm build @extra
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit code $LASTEXITCODE)" }
    } finally { Pop-Location }
}

Write-Host "Building Vencord + FloatingChats with the updater disabled ..."
Run-Build @("--disable-updater")
$vencordCommit = (& git -C $vencord rev-parse --short HEAD).Trim()

$name = "FloatingChats-$Version-windows"
$out = Join-Path $PSScriptRoot "out"
$stage = Join-Path $out $name
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage "dist") | Out-Null

# Only what Discord loads (patcher -> preload, renderer, renderer.css) plus third-party license notices.
$distFiles = "patcher.js", "patcher.js.LEGAL.txt", "preload.js", "renderer.js", "renderer.js.LEGAL.txt", "renderer.css"
foreach ($file in $distFiles) {
    Copy-Item (Join-Path $vencord "dist\$file") (Join-Path $stage "dist\$file")
}

foreach ($file in "install.ps1", "uninstall.ps1", "install.cmd", "uninstall.cmd") {
    Copy-Item (Join-Path $PSScriptRoot $file) (Join-Path $stage $file)
}
Copy-Item (Join-Path $plugin "LICENSE") (Join-Path $stage "LICENSE")

$readme = Get-Content (Join-Path $PSScriptRoot "README.txt") -Raw -Encoding UTF8
$readme = $readme.Replace("{VERSION}", $Version).Replace("{VENCORD_COMMIT}", $vencordCommit)
# Windows line endings: README.txt is opened by people in Notepad.
[IO.File]::WriteAllText((Join-Path $stage "README.txt"), ($readme -replace "`r?`n", "`r`n"))

$zip = Join-Path $out "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# Entries are added one by one with "/" in names: on Windows PowerShell 5.1 (old .NET) both
# Compress-Archive and ZipFile.CreateFromDirectory write "dist\file", which some unzip tools mishandle.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem $stage -Recurse -File) {
        $entryName = $file.FullName.Substring($stage.Length + 1).Replace("\", "/")
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName)
    }
} finally {
    $archive.Dispose()
}

Write-Host "Restoring the regular dev build ..."
Run-Build @()

Write-Host ""
Write-Host "Archive: $zip" -ForegroundColor Green
