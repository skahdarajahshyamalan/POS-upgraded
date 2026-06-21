# setup_node.ps1
# Downloads and prepares a portable Node.js version, then runs npm install inside desktop_wrapper

$ErrorActionPreference = "Stop"

$WrapperDir = $PSScriptRoot
$BinDir = Join-Path $WrapperDir "bin"
$NodeDestDir = Join-Path $BinDir "node"

$NodeZipUrl = "https://nodejs.org/dist/v18.16.0/node-v18.16.0-win-x64.zip"
$NodeZipPath = Join-Path $BinDir "node.zip"

# Create bin folder if it doesn't exist
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}

if (-not (Test-Path $NodeDestDir)) {
    Write-Host "Downloading portable Node.js v18.16.0..."
    Invoke-WebRequest -Uri $NodeZipUrl -OutFile $NodeZipPath -UserAgent "Mozilla/5.0"
    
    Write-Host "Extracting Node.js..."
    $TempExtractDir = Join-Path $BinDir "node_temp"
    if (Test-Path $TempExtractDir) { Remove-Item -Recurse -Force $TempExtractDir }
    Expand-Archive -Path $NodeZipPath -DestinationPath $TempExtractDir
    
    $SubDir = Get-ChildItem -Path $TempExtractDir -Directory | Select-Object -First 1
    Move-Item -Path $SubDir.FullName -Destination $NodeDestDir
    
    # Clean up zip and temp folder
    Remove-Item -Force $NodeZipPath
    Remove-Item -Recurse -Force $TempExtractDir
    
    Write-Host "Portable Node.js set up successfully."
} else {
    Write-Host "Portable Node.js already prepared."
}

# Locate Node and NPM paths
$NodeExe = Join-Path $NodeDestDir "node.exe"
$NpmCli = Join-Path $NodeDestDir "node_modules\npm\bin\npm-cli.js"

# Add Node.js directory to session PATH so post-install scripts can find 'node'
$env:PATH = "$NodeDestDir;" + $env:PATH

Write-Host "Running npm install in desktop_wrapper..."
# Run npm install using the portable node binary
& $NodeExe $NpmCli install

Write-Host "NPM packages installed successfully!"
