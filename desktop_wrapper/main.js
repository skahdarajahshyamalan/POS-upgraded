const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');

// Ignore certificate errors globally to avoid blank page on SSL validation issues
app.commandLine.appendSwitch('ignore-certificate-errors');

// File logging setup
const logPath = path.join(app.getPath('userData'), 'app.log');
function logToFile(type, message) {
    try {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logPath, `[${timestamp}] [${type}] ${message}\n`, 'utf8');
    } catch (e) {
        // ignore
    }
}
const originalLog = console.log;
const originalError = console.error;
console.log = function(...args) {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    logToFile('INFO', message);
    originalLog.apply(console, args);
};
console.error = function(...args) {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    logToFile('ERROR', message);
    originalError.apply(console, args);
};

const { getMachineId, verifyLicenseKey } = require('./license_verify');
const licensePath = path.join(app.getPath('userData'), 'license.key');


let mainWindow;
let splashWindow;
let phpProcess;
let dbProcess;

const PORT = 8088;
const DB_PORT = 3307; // Custom port to avoid conflict with local MySQL

// Detect if packaged or running in development mode
const basePath = app.isPackaged ? process.resourcesPath : __dirname;

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 500,
        height: 350,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: false
        }
    });

    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

function updateStatus(status) {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.executeJavaScript(`document.getElementById('status').innerText = '${status}';`);
    }
}

function startDatabase() {
    return new Promise((resolve, reject) => {
        const dbDir = path.join(basePath, 'bin', 'mariadb');
        const dbDataDir = path.join(app.getPath('userData'), 'database');
        const mysqldPath = path.join(dbDir, 'bin', 'mysqld.exe');
        const mysqlInstallDbPath = path.join(dbDir, 'bin', 'mysql_install_db.exe');

        // Check if database binaries exist
        if (!fs.existsSync(mysqldPath)) {
            console.log("MariaDB binary not found, assuming external database or dev environment");
            return resolve(); // Skip local DB start if binaries don't exist
        }

        // Initialize MariaDB data directory if not exists
        if (!fs.existsSync(dbDataDir)) {
            updateStatus('Initializing database (First run)...');
            console.log("Initializing database data directory...");
            const initDb = spawn(mysqlInstallDbPath, [`--datadir=${dbDataDir}`]);
            initDb.on('close', (code) => {
                if (code === 0) {
                    console.log("Database initialized successfully.");
                    launchMysqld(mysqldPath, dbDataDir, resolve, reject);
                } else {
                    reject(new Error(`Database initialization failed with exit code ${code}`));
                }
            });
        } else {
            launchMysqld(mysqldPath, dbDataDir, resolve, reject);
        }
    });
}

function launchMysqld(mysqldPath, dbDataDir, resolve, reject) {
    updateStatus('Starting Database Service...');
    console.log("Starting MariaDB server...");
    
    // Spawn MariaDB daemon
    dbProcess = spawn(mysqldPath, [
        `--datadir=${dbDataDir}`,
        `--port=${DB_PORT}`,
        '--bind-address=127.0.0.1',
        '--innodb-flush-method=normal'
    ]);

    dbProcess.stderr.on('data', (data) => {
        const log = data.toString();
        console.log(`MariaDB: ${log}`);
        if (log.includes('ready for connections') || log.includes('Version:')) {
            resolve();
        }
    });

    dbProcess.on('error', (err) => {
        reject(err);
    });

    // Fallback resolve in case stderr does not output typical logs
    setTimeout(() => {
        resolve();
    }, 5000);
}

function startWebServer() {
    return new Promise((resolve, reject) => {
        updateStatus('Starting PHP Web Server...');
        const phpDir = path.join(basePath, 'bin', 'php');
        const phpPath = path.join(phpDir, 'php.exe');
        const srcDir = path.join(basePath, 'src');
        const artisanPath = path.join(srcDir, 'artisan');

        if (!fs.existsSync(phpPath)) {
            console.log("PHP binary not found, assuming external environment");
            return resolve();
        }

        // Start Laravel PHP Server
        phpProcess = spawn(phpPath, [
            '-d', `extension_dir=${path.join(phpDir, 'ext')}`,
            '-S', `127.0.0.1:${PORT}`,
            '-t', path.join(srcDir, 'public')
        ]);

        phpProcess.on('error', (err) => {
            reject(err);
        });

        // Test connection to verify server is up
        let attempts = 0;
        const checkServer = setInterval(() => {
            attempts++;
            const http = require('http');
            http.get(`http://127.0.0.1:${PORT}`, (res) => {
                clearInterval(checkServer);
                resolve();
            }).on('error', (err) => {
                if (attempts > 10) {
                    clearInterval(checkServer);
                    reject(new Error('PHP Web Server failed to start.'));
                }
            });
        }, 1000);
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload_status.js')
        }
    });

    const appUrl = getEnvValue('APP_URL', `http://127.0.0.1:${PORT}`);
    
    // Log load failures
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[Main Process] Failed to load URL: ${validatedURL}, Error: ${errorDescription} (${errorCode})`);
    });

    mainWindow.loadURL(appUrl);

    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }

    // Send app packaging status once DOM finishes loading
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('app-info', { isPackaged: app.isPackaged });
    });

    // Forward renderer console messages to main process terminal stdout
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Renderer Console] ${message} (at ${path.basename(sourceId)}:${line})`);
    });

    mainWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
        }
        mainWindow.show();
        mainWindow.maximize();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// prepareEnv removed: env file is now prepared at build/sync time to avoid EPERM write errors in Program Files.

function createDatabase() {
    return new Promise((resolve, reject) => {
        updateStatus('Provisioning database...');
        const dbDir = path.join(basePath, 'bin', 'mariadb');
        const mysqlPath = path.join(dbDir, 'bin', 'mysql.exe');

        if (!fs.existsSync(mysqlPath)) {
            console.log("mysql.exe not found, skipping local DB creation");
            return resolve();
        }

        const createDb = spawn(mysqlPath, [
            '-h', '127.0.0.1',
            '-P', DB_PORT.toString(),
            '-u', 'root',
            '-e', 'CREATE DATABASE IF NOT EXISTS ultimate_pos_desktop;'
        ]);

        createDb.on('close', (code) => {
            if (code === 0) {
                console.log("Database ultimate_pos_desktop created or exists.");
                resolve();
            } else {
                reject(new Error(`Failed to create database. Exit code: ${code}`));
            }
        });

        createDb.on('error', (err) => {
            reject(err);
        });
    });
}

function runMigrationsAndSeeds() {
    return new Promise((resolve, reject) => {
        updateStatus('Running database migrations...');
        const phpDir = path.join(basePath, 'bin', 'php');
        const phpPath = path.join(phpDir, 'php.exe');
        const srcDir = path.join(basePath, 'src');
        const artisanPath = path.join(srcDir, 'artisan');

        if (!fs.existsSync(phpPath) || !fs.existsSync(artisanPath)) {
            console.log("PHP or artisan not found, skipping database migrations");
            return resolve();
        }

        const migrate = spawn(phpPath, [
            '-d', `extension_dir=${path.join(phpDir, 'ext')}`,
            artisanPath,
            'migrate',
            '--force'
        ]);

        migrate.on('close', (code) => {
            if (code === 0) {
                console.log("Database migrations ran successfully.");
                
                // Check if database needs seeding
                const seedLockFile = path.join(app.getPath('userData'), 'database_seeded.lock');
                if (!fs.existsSync(seedLockFile)) {
                    updateStatus('Seeding database with demo data (First run)...');
                    console.log("Fresh database detected. Seeding basic system tables and demo data...");
                    
                    const seed = spawn(phpPath, [
                        '-d', `extension_dir=${path.join(phpDir, 'ext')}`,
                        artisanPath,
                        'db:seed',
                        '--force'
                    ]);
                    
                    seed.on('close', (code) => {
                        if (code === 0) {
                            console.log("Database seeding completed successfully.");
                            fs.writeFileSync(seedLockFile, 'seeded');
                            resolve();
                        } else {
                            console.error(`Database seeding failed with exit code: ${code}`);
                            resolve();
                        }
                    });
                    
                    seed.on('error', (err) => {
                        console.error("Database seeding start error:", err);
                        resolve();
                    });
                } else {
                    console.log("Database already seeded.");
                    resolve();
                }
            } else {
                reject(new Error(`Database migrations failed. Exit code: ${code}`));
            }
        });

        migrate.on('error', (err) => {
            reject(err);
        });
    });
}

let activationWindow;

function createActivationWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
    }

    activationWindow = new BrowserWindow({
        width: 550,
        height: 600,
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    activationWindow.loadFile(path.join(__dirname, 'activation.html'));
    activationWindow.center();
}

function checkLicense() {
    if (!fs.existsSync(licensePath)) {
        return { success: false, reason: 'License key not found.' };
    }
    const licenseKey = fs.readFileSync(licensePath, 'utf8').trim();
    const machineId = getMachineId();
    const result = verifyLicenseKey(licenseKey, machineId);
    if (!result.valid) {
        return { success: false, reason: result.reason };
    }
    return { success: true, payload: result.payload };
}

function getEnvValue(key, defaultValue = '') {
    try {
        const envPath = path.join(__dirname, '.env.desktop');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
                if (match && match[1].trim() === key) {
                    let val = match[2].trim();
                    // Remove quotes if present
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.substring(1, val.length - 1);
                    }
                    return val;
                }
            }
        }
    } catch (e) {
        console.error("Error reading .env.desktop:", e);
    }
    return defaultValue;
}

const DB_PORT_ENV = parseInt(getEnvValue('DB_PORT', '3307'), 10);
const DB_HOST_ENV = getEnvValue('DB_HOST', '127.0.0.1');

function startAppServices() {
    const APP_URL_ENV = getEnvValue('APP_URL', `http://127.0.0.1:${PORT}`);
    const isRemoteUrl = APP_URL_ENV.startsWith('http') && !APP_URL_ENV.includes('127.0.0.1') && !APP_URL_ENV.includes('localhost');

    if (isRemoteUrl) {
        console.log(`Using remote URL: ${APP_URL_ENV}. Bypassing local database and local web server startup.`);
        createMainWindow();
        return;
    }

    let promise = Promise.resolve();
    
    // Only run local DB services if database is configured to use local MariaDB (port 3307)
    if (DB_PORT_ENV === 3307) {
        promise = promise
            .then(() => startDatabase())
            .then(() => createDatabase())
            .then(() => runMigrationsAndSeeds());
    } else {
        console.log(`Using external database connection: ${DB_HOST_ENV}:${DB_PORT_ENV}. Skipping local database startup and migrations.`);
    }

    promise
        .then(() => {
            // Run backup in background on startup if local
            if (DB_PORT_ENV === 3307) {
                try {
                    const { runBackup } = require('./backup');
                    runBackup();
                } catch (err) {
                    console.error("Startup database backup failed:", err);
                }
            }
            return startWebServer();
        })
        .then(() => {
            createMainWindow();
        })
        .catch(err => {
            console.error(err);
            updateStatus(`Error: ${err.message}`);
        });
}

// IPC Handlers for licensing
ipcMain.on('get-machine-id', (event) => {
    event.returnValue = getMachineId();
});

ipcMain.on('submit-license', (event, licenseKey) => {
    const machineId = getMachineId();
    const result = verifyLicenseKey(licenseKey, machineId);
    
    if (result.valid) {
        try {
            fs.writeFileSync(licensePath, licenseKey, 'utf8');
            event.reply('license-result', { success: true });
            
            setTimeout(() => {
                if (activationWindow && !activationWindow.isDestroyed()) {
                    activationWindow.close();
                }
                createSplash();
                updateStatus('Starting Services...');
                startAppServices();
            }, 2000);
        } catch (e) {
            event.reply('license-result', { success: false, reason: 'Failed to save license: ' + e.message });
        }
    } else {
        event.reply('license-result', { success: false, reason: result.reason });
    }
});

ipcMain.on('exit-app', () => {
    console.log('[Main Process] Received exit-app IPC message. Quitting app...');
    try {
        if (phpProcess) phpProcess.kill();
    } catch (e) {
        console.error("Error killing phpProcess on exit:", e);
    }
    try {
        if (dbProcess) dbProcess.kill();
    } catch (e) {
        console.error("Error killing dbProcess on exit:", e);
    }
    app.exit(0);
});

app.on('ready', () => {
    createSplash();
    updateStatus('Starting Services...');
    startAppServices();
});

app.on('window-all-closed', () => {
    console.log('[Main Process] All windows closed. Cleaning up child processes...');
    try {
        if (phpProcess) phpProcess.kill();
    } catch (e) {
        console.error("Error killing phpProcess on window-all-closed:", e);
    }
    try {
        if (dbProcess) dbProcess.kill();
    } catch (e) {
        console.error("Error killing dbProcess on window-all-closed:", e);
    }
    app.exit(0);
});

app.on('quit', () => {
    console.log('[Main Process] Application quit event triggered. Performing final cleanup...');
    try {
        if (phpProcess) phpProcess.kill();
    } catch (e) {
        console.error("Error killing phpProcess on quit:", e);
    }
    try {
        if (dbProcess) dbProcess.kill();
    } catch (e) {
        console.error("Error killing dbProcess on quit:", e);
    }
});

// File Watcher for Development Mode
if (!app.isPackaged) {
    const fs = require('fs');
    const path = require('path');
    
    const parentDir = path.resolve(path.join(__dirname, '..'));
    const srcDir = path.join(__dirname, 'src');
    
    console.log(`Starting development file watcher on: ${parentDir}`);
    
    const ignoreList = [
        '.git',
        'node_modules',
        'desktop_wrapper',
        '.composer',
        '.config',
        'storage/logs',
        'storage/framework/cache/data',
        'storage/framework/sessions',
        'storage/framework/views'
    ];
    
    function shouldIgnore(relativePath) {
        const normalized = relativePath.replace(/\\/g, '/');
        return ignoreList.some(ignore => {
            return normalized === ignore || normalized.startsWith(ignore + '/');
        });
    }
    
    fs.watch(parentDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        
        if (shouldIgnore(filename)) {
            return;
        }
        
        const sourcePath = path.join(parentDir, filename);
        const destPath = path.join(srcDir, filename);
        
        // Wait a small delay to make sure file write is complete
        setTimeout(() => {
            try {
                if (fs.existsSync(sourcePath)) {
                    const stats = fs.statSync(sourcePath);
                    if (stats.isFile()) {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('sync-status', { status: 'syncing', file: filename });
                        }
                        // Ensure parent directory exists in destination
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) {
                            fs.mkdirSync(destDir, { recursive: true });
                        }
                        fs.copyFileSync(sourcePath, destPath);
                        console.log(`[Auto-Sync] Copied file: ${filename}`);
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('sync-status', { status: 'success', file: filename });
                        }
                    }
                } else {
                    // File deleted in source, delete in destination if exists
                    if (fs.existsSync(destPath)) {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('sync-status', { status: 'syncing', file: filename });
                        }
                        fs.rmSync(destPath, { force: true });
                        console.log(`[Auto-Sync] Deleted file: ${filename}`);
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('sync-status', { status: 'success', file: filename });
                        }
                    }
                }
            } catch (err) {
                console.error(`[Auto-Sync] Error syncing ${filename}:`, err.message);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('sync-status', { status: 'error', file: filename });
                }
            }
        }, 150);
    });
}


