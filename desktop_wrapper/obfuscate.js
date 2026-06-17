// obfuscate.js
// Scans Laravel PHP files and encrypts their contents using AES-256-CBC to protect source code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = 'pos-desktop-secret-key-2026-encrypt'; // 32 bytes key
const IV = '1234567890123456'; // 16 bytes IV

const srcDir = path.join(__dirname, 'src', 'app');

if (!fs.existsSync(srcDir)) {
    console.log("src/app folder not found, skipping PHP obfuscation");
    process.exit(0);
}

function encryptPHP(sourceCode) {
    // Strip <?php tag at the beginning if present
    let phpCode = sourceCode.trim();
    if (phpCode.startsWith('<?php')) {
        phpCode = phpCode.slice(5).trim();
    } else if (phpCode.startsWith('<?')) {
        phpCode = phpCode.slice(2).trim();
    }

    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(SECRET_KEY.padEnd(32).slice(0, 32)), Buffer.from(IV));
    let encrypted = cipher.update(phpCode, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    // Return the bootstrap loader
    return `<?php
/* Protected by POS Desktop Encrypter */
eval(openssl_decrypt('${encrypted}', 'aes-256-cbc', '${SECRET_KEY.padEnd(32).slice(0, 32)}', 0, '${IV}'));
`;
}

function processDirectory(directory) {
    const files = fs.readdirSync(directory);
    
    for (const file of files) {
        const fullPath = path.join(directory, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            processDirectory(fullPath);
        } else if (file.endsWith('.php')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            
            // Skip already encrypted files or helper files we don't want to break
            if (content.includes('Protected by POS Desktop Encrypter') || file === 'helpers.php') {
                continue;
            }
            
            console.log(`Encrypting: ${path.relative(srcDir, fullPath)}`);
            const encryptedContent = encryptPHP(content);
            fs.writeFileSync(fullPath, encryptedContent, 'utf8');
        }
    }
}

console.log("Starting PHP source code encryption...");
processDirectory(srcDir);
console.log("PHP source code encryption completed successfully!");
