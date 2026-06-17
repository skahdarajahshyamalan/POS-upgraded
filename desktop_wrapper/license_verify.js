const crypto = require('crypto');
const { execSync } = require('child_process');

// 32-byte secret key and 16-byte IV for license encryption/decryption
const LICENSE_SECRET = 'ultimate-pos-licensing-key-2026'; // 32 bytes pad
const LICENSE_IV = 'licensing-iv-123'; // 16 bytes pad

/**
 * Generates a unique Machine ID based on CPU ProcessorId and Baseboard Serial Number on Windows.
 * Falls back to a generic/mac address identifier on non-Windows dev environments.
 */
function getMachineId() {
    try {
        let cpuId = '';
        let baseboard = '';
        if (process.platform === 'win32') {
            try {
                cpuId = execSync('wmic cpu get processorid').toString().replace('ProcessorId', '').trim();
            } catch (e) {
                cpuId = 'WIN-CPU-ERR';
            }
            try {
                baseboard = execSync('wmic baseboard get serialnumber').toString().replace('SerialNumber', '').trim();
            } catch (e) {
                baseboard = 'WIN-BOARD-ERR';
            }
        } else {
            cpuId = 'MAC-OS-OR-LINUX-DEV';
            baseboard = 'DEV-BOARD-123';
        }
        const rawId = `${cpuId}-${baseboard}`;
        // Create an 8-character hashed block for easy copying
        const hash = crypto.createHash('sha256').update(rawId).digest('hex').toUpperCase();
        return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
    } catch (e) {
        return 'POS-MEMBER-UNKNOWN';
    }
}

/**
 * Verifies if the provided license key is valid for this machine and has not expired.
 * @param {string} licenseKeyString - Hex encoded encrypted license payload
 * @param {string} machineId - Current local machine ID
 */
function verifyLicenseKey(licenseKeyString, machineId) {
    try {
        const key = Buffer.from(LICENSE_SECRET.padEnd(32).slice(0, 32));
        const iv = Buffer.from(LICENSE_IV.padEnd(16).slice(0, 16));
        
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(licenseKeyString, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        const payload = JSON.parse(decrypted);
        
        if (payload.machineId !== machineId) {
            return { valid: false, reason: 'This license key is not valid for this machine.' };
        }

        const expiryDate = new Date(payload.expiryDate);
        const today = new Date();
        // Reset time parts to check date only
        today.setHours(0,0,0,0);
        expiryDate.setHours(0,0,0,0);

        if (expiryDate < today) {
            return { valid: false, reason: `This license key expired on ${payload.expiryDate}.` };
        }

        return { valid: true, payload };
    } catch (e) {
        return { valid: false, reason: 'Invalid license key format.' };
    }
}

/**
 * Generates an encrypted license key (used by developer tool).
 * @param {string} machineId - Target Machine ID
 * @param {string} expiryDate - Expiry Date in YYYY-MM-DD format
 */
function generateLicenseKey(machineId, expiryDate) {
    const payload = JSON.stringify({ machineId, expiryDate });
    const key = Buffer.from(LICENSE_SECRET.padEnd(32).slice(0, 32));
    const iv = Buffer.from(LICENSE_IV.padEnd(16).slice(0, 16));
    
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(payload, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
}

module.exports = {
    getMachineId,
    verifyLicenseKey,
    generateLicenseKey
};
