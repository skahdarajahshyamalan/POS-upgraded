const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');

// Paths configuration
const basePath = process.resourcesPath ? process.resourcesPath : path.join(__dirname);
const dbDir = path.join(basePath, 'bin', 'mariadb');
const mysqldumpPath = path.join(dbDir, 'bin', 'mysqldump.exe');
let userDataPath;
try {
    const { app } = require('electron');
    userDataPath = app ? app.getPath('userData') : null;
} catch (e) {
    // Fallback if not running inside Electron
}
if (!userDataPath) {
    userDataPath = path.join(process.env.APPDATA || process.env.HOME || process.cwd(), 'ultimate-pos-desktop');
}
const backupDir = path.join(userDataPath, 'backups');

// Ensure backups directory exists
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

function runBackup() {
    console.log("Starting automated database backup...");
    
    if (!fs.existsSync(mysqldumpPath)) {
        console.log("mysqldump.exe not found, skipping automated backup");
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sqlFile = path.join(backupDir, `backup-${timestamp}.sql`);
    const zipFile = sqlFile + '.gz';

    // Spawn mysqldump process
    // We connect to Port 3307 which is our custom port
    const writeStream = fs.createWriteStream(sqlFile);
    const mysqldump = spawn(mysqldumpPath, [
        '-h', '127.0.0.1',
        '-P', '3307',
        '-u', 'root',
        'ultimate_pos_desktop'
    ]);

    mysqldump.stdout.pipe(writeStream);

    mysqldump.on('close', (code) => {
        if (code === 0) {
            console.log(`Database dump saved to: ${sqlFile}`);
            
            // Compress the SQL file to Gzip format
            const gzip = zlib.createGzip();
            const source = fs.createReadStream(sqlFile);
            const destination = fs.createWriteStream(zipFile);

            source.pipe(gzip).pipe(destination).on('finish', () => {
                console.log(`Backup successfully compressed to: ${zipFile}`);
                
                // Delete raw SQL file to save space
                try {
                    fs.unlinkSync(sqlFile);
                } catch (err) {
                    console.error("Failed to delete raw SQL backup file:", err);
                }

                // Check for internet connection and sync to cloud if available
                checkInternetAndSyncCloud(zipFile);
                
                // Keep only last 7 backups locally
                cleanOldBackups();
            });
        } else {
            console.error(`mysqldump failed with exit code ${code}`);
            if (fs.existsSync(sqlFile)) {
                fs.unlinkSync(sqlFile);
            }
        }
    });

    mysqldump.on('error', (err) => {
        console.error("Failed to start mysqldump process:", err);
    });
}

function checkInternetAndSyncCloud(filePath) {
    const cloudBackupUrl = process.env.CLOUD_BACKUP_URL || '';
    if (!cloudBackupUrl) {
        console.log("Cloud backup URL not configured, skipping cloud upload");
        return;
    }

    // Simple DNS ping check
    const client = cloudBackupUrl.startsWith('https') ? https : http;
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error("Failed to read backup file for cloud upload:", err);
            return;
        }

        console.log("Attempting to upload database backup to cloud...");
        const req = client.request(cloudBackupUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': data.length,
                'X-Store-Code': process.env.STORE_CODE || 'STORE-001',
                'X-Backup-File': path.basename(filePath)
            }
        }, (res) => {
            if (res.statusCode === 200 || res.statusCode === 201) {
                console.log("Database backup successfully synchronized to cloud!");
            } else {
                console.log(`Cloud backup upload failed. Server responded with: ${res.statusCode}`);
            }
        });

        req.on('error', (e) => {
            console.log("Cloud server unreachable or offline. Backup saved locally only.");
        });

        req.write(data);
        req.end();
    });
}

function cleanOldBackups() {
    try {
        const files = fs.readdirSync(backupDir)
            .filter(f => f.endsWith('.gz'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time); // newest first

        if (files.length > 7) {
            for (let i = 7; i < files.length; i++) {
                const oldFilePath = path.join(backupDir, files[i].name);
                fs.unlinkSync(oldFilePath);
                console.log(`Deleted old backup: ${files[i].name}`);
            }
        }
    } catch (err) {
        console.error("Failed to clean old local database backups:", err);
    }
}

// Run immediately if executed directly
if (require.main === module) {
    runBackup();
}

module.exports = {
    runBackup
};
