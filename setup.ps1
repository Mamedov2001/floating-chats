# Links the plugin into the sibling Vencord clone (..\Vencord):
#   Vencord\src\userplugins\floatingChats  -> floating-chats\src        (Vencord builds the plugin from here)
#   floating-chats\node_modules            -> Vencord\node_modules      (packages like @vencord/discord-types)
# Junctions don't need admin rights. Safe to run again.
# (English only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)

$ErrorActionPreference = "Stop"

$plugin = $PSScriptRoot
$vencord = Join-Path (Split-Path $plugin -Parent) "Vencord"

if (-not (Test-Path (Join-Path $vencord "package.json"))) {
    throw "Vencord not found at $vencord. Clone https://github.com/Vendicated/Vencord next to this folder (tsconfig.json expects ../Vencord)."
}
if (-not (Test-Path (Join-Path $vencord "node_modules"))) {
    throw "Vencord dependencies are not installed. Run 'pnpm install --frozen-lockfile' in $vencord first."
}

function Ensure-Junction([string]$path, [string]$target) {
    if (Test-Path $path) {
        $item = Get-Item $path -Force
        if ($item.LinkType -eq "Junction" -and $item.Target -contains $target) {
            Write-Host "ok      $path"
            return
        }
        throw "$path already exists and is not a junction to $target. Remove it and run this script again."
    }
    New-Item -ItemType Junction -Path $path -Target $target | Out-Null
    Write-Host "linked  $path -> $target"
}

New-Item -ItemType Directory -Force (Join-Path $vencord "src\userplugins") | Out-Null
Ensure-Junction (Join-Path $vencord "src\userplugins\floatingChats") (Join-Path $plugin "src")
Ensure-Junction (Join-Path $plugin "node_modules") (Join-Path $vencord "node_modules")

Write-Host ""
Write-Host "Done. Now build Vencord: cd `"$vencord`"; pnpm build"
