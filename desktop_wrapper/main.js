const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
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
            contextIsolation: true
        }
    });

    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

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

function startAppServices() {
    startDatabase()
        .then(() => createDatabase())
        .then(() => runMigrationsAndSeeds())
        .then(() => {
            // Run backup in background on startup
            try {
                const { runBackup } = require('./backup');
                runBackup();
            } catch (err) {
                console.error("Startup database backup failed:", err);
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

app.on('ready', () => {
    createSplash();
    
    const licenseCheck = checkLicense();
    if (licenseCheck.success) {
        updateStatus('Starting Services...');
        startAppServices();
    } else {
        console.log("License check failed:", licenseCheck.reason);
        createActivationWindow();
    }
});

app.on('window-all-closed', () => {
    if (phpProcess) {
        phpProcess.kill();
    }
    if (dbProcess) {
        dbProcess.kill();
    }
    app.quit();
});

app.on('quit', () => {
    if (phpProcess) phpProcess.kill();
    if (dbProcess) dbProcess.kill();
});

