# FloatingChats - floating Discord chat tiles for Vencord
# Copyright (c) 2026 Mamedov2001
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Removes Vencord (with FloatingChats) from Discord using the official Vencord installer,
# then deletes %LOCALAPPDATA%\FloatingChats. Discord itself and your account are not touched.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)

$ErrorActionPreference = "Stop"
$target = Join-Path $env:LOCALAPPDATA "FloatingChats"
$installerUrl = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"

function Fail([string]$message) {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
    exit 1
}

if (Get-Process Discord -ErrorAction SilentlyContinue) {
    Fail "Discord is running. Quit it completely (right-click the Discord icon in the tray -> Quit Discord) and run uninstall.cmd again."
}

$installer = Join-Path $target "VencordInstallerCli.exe"
if (-not (Test-Path $installer)) {
    New-Item -ItemType Directory -Force $target | Out-Null
    Write-Host "Downloading the official Vencord installer ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest $installerUrl -OutFile $installer -UseBasicParsing
    } catch {
        Fail "Could not download the Vencord installer: $($_.Exception.Message)"
    }
}

Write-Host "Removing Vencord from Discord ..."
& $installer -uninstall -branch stable
if ($LASTEXITCODE -ne 0) { Fail "The Vencord installer failed (exit code $LASTEXITCODE). See the messages above." }

Remove-Item $target -Recurse -Force
Write-Host ""
Write-Host "Done. Discord is back to normal." -ForegroundColor Green
