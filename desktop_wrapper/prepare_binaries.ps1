# prepare_binaries.ps1
# Script to download and prepare portable PHP and MariaDB for Windows

$ErrorActionPreference = "Stop"

$WrapperDir = $PSScriptRoot
$BinDir = Join-Path $WrapperDir "bin"
$TmpDir = Join-Path $BinDir "tmp"

# Create directories
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
if (-not (Test-Path $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir | Out-Null }

$PhpZipUrl = "https://windows.php.net/downloads/releases/archives/php-8.1.28-nts-Win32-vs16-x64.zip"
# Fallback URL if archive does not contain it (e.g. download current release)
$PhpZipUrlFallback = "https://windows.php.net/downloads/releases/php-8.1.28-nts-Win32-vs16-x64.zip"

$MariadbZipUrl = "https://archive.mariadb.org/mariadb-10.6.18/winx64-packages/mariadb-10.6.18-winx64.zip"

# Download PHP
$PhpZipPath = Join-Path $TmpDir "php.zip"
$PhpDestDir = Join-Path $BinDir "php"

if (-not (Test-Path $PhpDestDir)) {
    Write-Host "Downloading PHP 8.1..."
    try {
        Invoke-WebRequest -Uri $PhpZipUrl -OutFile $PhpZipPath -UserAgent "Mozilla/5.0"
    } catch {
        Write-Host "Failed to download from archive, trying current release URL..."
        Invoke-WebRequest -Uri $PhpZipUrlFallback -OutFile $PhpZipPath -UserAgent "Mozilla/5.0"
    }
    
    Write-Host "Extracting PHP..."
    Expand-Archive -Path $PhpZipPath -DestinationPath $PhpDestDir
    Write-Host "PHP extracted."
} else {
    Write-Host "PHP already prepared."
}

# Download MariaDB
$MariadbZipPath = Join-Path $TmpDir "mariadb.zip"
$MariadbDestDir = Join-Path $BinDir "mariadb"

if (-not (Test-Path $MariadbDestDir)) {
    Write-Host "Downloading MariaDB 10.6..."
    Invoke-WebRequest -Uri $MariadbZipUrl -OutFile $MariadbZipPath -UserAgent "Mozilla/5.0"
    
    Write-Host "Extracting MariaDB..."
    $TempExtractDir = Join-Path $TmpDir "mariadb_extracted"
    if (Test-Path $TempExtractDir) { Remove-Item -Recurse -Force $TempExtractDir }
    Expand-Archive -Path $MariadbZipPath -DestinationPath $TempExtractDir
    
    # Locate the extracted folder (it usually has a subfolder like mariadb-10.6.18-winx64)
    $SubDir = Get-ChildItem -Path $TempExtractDir -Directory | Select-Object -First 1
    Move-Item -Path $SubDir.FullName -Destination $MariadbDestDir
    Write-Host "MariaDB extracted."
} else {
    Write-Host "MariaDB already prepared."
}

# Create php.ini file
$PhpIniPath = Join-Path $PhpDestDir "php.ini"
if (-not (Test-Path $PhpIniPath)) {
    Write-Host "Creating php.ini..."
    $PhpIniContent = @"
[PHP]
max_execution_time = 300
max_input_time = 60
memory_limit = 512M
error_reporting = E_ALL & ~E_DEPRECATED & ~E_STRICT
display_errors = Off
log_errors = On
post_max_size = 100M
upload_max_filesize = 100M
default_charset = "UTF-8"

extension_dir = "ext"

extension=curl
extension=fileinfo
extension=gd
extension=mbstring
extension=exif
extension=mysqli
extension=openssl
extension=pdo_mysql
extension=pdo_sqlite
extension=sqlite3
extension=xml
extension=zip
extension=bcmath
extension=ctype
extension=tokenizer

[Date]
date.timezone = UTC
"@
    Set-Content -Path $PhpIniPath -Value $PhpIniContent
}

# Clean up tmp folder
if (Test-Path $TmpDir) {
    Remove-Item -Recurse -Force $TmpDir
}

Write-Host "Binaries setup completed successfully!"
