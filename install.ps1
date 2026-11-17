# Registers this checkout as a local OpenCode plugin.
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20 or newer is required. Install it from https://nodejs.org and run this again."
    exit 1
}

node (Join-Path $PSScriptRoot "scripts/install.mjs") @args
exit $LASTEXITCODE
