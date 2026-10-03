param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ServerArgs)
$ErrorActionPreference = 'Stop'
$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (Test-Path -LiteralPath $bundledPython) {
    & $bundledPython (Join-Path $PSScriptRoot 'server.py') @ServerArgs
    exit $LASTEXITCODE
}
$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) {
    & $python.Source (Join-Path $PSScriptRoot 'server.py') @ServerArgs
    exit $LASTEXITCODE
}
$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    & $python.Source (Join-Path $PSScriptRoot 'server.py') @ServerArgs
    exit $LASTEXITCODE
}
Write-Error 'Python 3 is required. Install Python, then run this script again.'
