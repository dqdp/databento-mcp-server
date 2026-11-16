$ErrorActionPreference = 'Stop'
$previousKey = $env:DATABENTO_API_KEY
$pointer = [IntPtr]::Zero
try {
    $configPath = Join-Path $env:USERPROFILE '.databento-mcp\.env'
    if (-not $env:DATABENTO_API_KEY -and -not (Test-Path -LiteralPath $configPath)) {
        $secret = Read-Host 'Databento API key (hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $env:DATABENTO_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    & "$PSScriptRoot\runtime\node.exe" "$PSScriptRoot\install-openai.cjs"
    if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Existing plugins were preserved.' }
    Write-Host 'Restart ChatGPT. Open Plugins, select your personal catalog, and install Databento MCP.'
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $env:DATABENTO_API_KEY = $previousKey
}
