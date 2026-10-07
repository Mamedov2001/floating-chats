# FloatingChats - floating Discord chat tiles for Vencord
# Copyright (c) 2026 Mamedov2001
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs the prebuilt Vencord + FloatingChats from this folder into Discord (Stable):
#   1. copies dist\ to %LOCALAPPDATA%\FloatingChats\dist (Discord loads Vencord from there - keep it);
#   2. downloads the official Vencord installer (github.com/Vencord/Installer);
#   3. runs it in "custom build" mode, pointing Discord at that folder.
# Run it again to update. Use uninstall.cmd to restore the original Discord.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)

param(
    # Copy files and print the installer command, but don't download or change Discord.
    [switch]$DryRun,
    # Install into this folder instead of %LOCALAPPDATA%\FloatingChats (used for testing).
    [string]$Target = (Join-Path $env:LOCALAPPDATA "FloatingChats")
)

$ErrorActionPreference = "Stop"
$installerUrl = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"

function Fail([string]$message) {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
    exit 1
}

$source = Join-Path $PSScriptRoot "dist"
foreach ($file in "patcher.js", "preload.js", "renderer.js", "renderer.css") {
    if (-not (Test-Path (Join-Path $source $file))) { Fail "dist\$file is missing. Extract the whole archive and run install.cmd from it." }
}

# Discord must be fully closed, otherwise its files are locked. Don't kill it: that can sign you out.
if (-not $DryRun -and (Get-Process Discord -ErrorAction SilentlyContinue)) {
    Fail "Discord is running. Quit it completely (right-click the Discord icon in the tray -> Quit Discord) and run install.cmd again."
}

Write-Host "Copying FloatingChats to $Target ..."
$dist = Join-Path $Target "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item (Join-Path $source "*") $dist -Recurse -Force

$installer = Join-Path $Target "VencordInstallerCli.exe"
# The installer reads these: patch Discord to load <VENCORD_USER_DATA_DIR>\dist instead of official Vencord.
$env:VENCORD_USER_DATA_DIR = $Target
$env:VENCORD_DEV_INSTALL = "1"

if ($DryRun) {
    Write-Host "Dry run: would download $installerUrl"
    Write-Host "Dry run: would run `"$installer`" -install -branch stable  (VENCORD_USER_DATA_DIR=$Target)"
    exit 0
}

Write-Host "Downloading the official Vencord installer ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    Invoke-WebRequest $installerUrl -OutFile $installer -UseBasicParsing
} catch {
    Fail "Could not download the Vencord installer: $($_.Exception.Message)"
}

Write-Host "Installing into Discord ..."
& $installer -install -branch stable
if ($LASTEXITCODE -ne 0) { Fail "The Vencord installer failed (exit code $LASTEXITCODE). See the messages above." }

Write-Host ""
Write-Host "Done! Start Discord. FloatingChats is enabled; its settings are in Settings -> Vencord -> Plugins -> FloatingChats." -ForegroundColor Green
Write-Host "Keep the folder $Target - Discord loads Vencord from it."
