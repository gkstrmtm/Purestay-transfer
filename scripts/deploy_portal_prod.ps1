$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$workspace = Split-Path -Parent $PSScriptRoot
$vercelBin = 'vercel.cmd'
$domains = @(
  'purestaync.com',
  'www.purestaync.com'
)

function Assert-Tool($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$name is required but was not found in PATH."
  }
}

function Run-VercelText([string]$commandText) {
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  try {
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', "$vercelBin $commandText") -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $stdoutText = if (Test-Path $stdoutFile) { Get-Content -Raw $stdoutFile } else { '' }
    $stderrText = if (Test-Path $stderrFile) { Get-Content -Raw $stderrFile } else { '' }
    $text = (($stdoutText + [Environment]::NewLine + $stderrText).Trim())
    if ($text) { Write-Host $text }
    if ($proc.ExitCode -ne 0) {
      throw "Vercel command failed: $commandText"
    }
    return $text
  }
  finally {
    Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

function Get-DeploymentUrl([string]$deployOutput) {
  $urlMatch = [regex]::Match($deployOutput, 'Production:\s+(https://[a-zA-Z0-9.-]+\.vercel\.app)')
  if (-not $urlMatch.Success) {
    throw 'Could not determine deployment URL from Vercel output.'
  }
  return $urlMatch.Groups[1].Value
}

function Test-PortalResponse([string]$url) {
  $response = Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 5
  if ($response.StatusCode -ne 200) {
    throw "Smoke test failed for $url. Status $($response.StatusCode)."
  }

  $contentType = [string]$response.Headers['Content-Type']
  if ($contentType -notmatch 'text/html') {
    throw "Smoke test failed for $url. Unexpected content type: $contentType"
  }

  $content = [string]$response.Content
  if ($content -notmatch '<!doctype html>' -or $content -notmatch '<title>PureStay Portal</title>') {
    throw "Smoke test failed for $url. Portal markup is missing expected HTML shell."
  }

  if ($content -notmatch '(?s)<title>PureStay Portal</title>(?:\s*<link[^>]+>)*\s*<style>') {
    throw "Smoke test failed for $url. The portal CSS block is not wrapped correctly."
  }

  if ($content -match '(?s)<title>PureStay Portal</title>\s*</div>') {
    throw "Smoke test failed for $url. Found stray markup inside the head before styles."
  }
}

Assert-Tool $vercelBin

Push-Location $workspace
try {
  Write-Host 'Deploying production build...'
  $deployOutput = Run-VercelText 'deploy --prod --yes'
  $deploymentUrl = Get-DeploymentUrl $deployOutput

  Write-Host "Attaching custom domains to $deploymentUrl ..."
  foreach ($domain in $domains) {
    Run-VercelText ("alias set {0} {1}" -f $deploymentUrl, $domain) | Out-Null
  }

  Write-Host 'Running portal smoke tests...'
  Test-PortalResponse 'https://purestay-transfer.vercel.app/portal'
  foreach ($domain in $domains) {
    Test-PortalResponse ("https://{0}/portal" -f $domain)
  }

  Write-Host ''
  Write-Host 'Production deployment complete and verified.'
  Write-Host "Deployment: $deploymentUrl"
}
finally {
  Pop-Location
}