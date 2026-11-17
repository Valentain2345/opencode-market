# Registers this checkout, or a downloaded copy, as a local OpenCode plugin.
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20 or newer is required. Install it from https://nodejs.org and run this again."
    exit 1
}

if ($PSScriptRoot) {
    $local = Join-Path $PSScriptRoot "scripts/install.mjs"
    if (Test-Path $local) {
        node $local @args
        exit $LASTEXITCODE
    }
}

# Piped from irm: download a copy, then install from there.
$target = if ($env:OPENCODE_MARKET_DIR) { $env:OPENCODE_MARKET_DIR } else { Join-Path $env:LOCALAPPDATA "opencode-market" }
$archive = "https://github.com/Valentain2345/opencode-market/archive/refs/heads/main.zip"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-market-" + [guid]::NewGuid())
try {
    Write-Host "Downloading $archive"
    Invoke-WebRequest -UseBasicParsing -Uri $archive -OutFile "$tmp.zip"
    Expand-Archive -Path "$tmp.zip" -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $tmp "opencode-market-main\*") $target -Recurse -Force
} finally {
    Remove-Item $tmp, "$tmp.zip" -Recurse -Force -ErrorAction SilentlyContinue
}

node (Join-Path $target "scripts/install.mjs") @args
exit $LASTEXITCODE
