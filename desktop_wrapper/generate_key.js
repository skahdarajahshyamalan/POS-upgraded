const { generateLicenseKey } = require('./license_verify');

const args = process.argv.slice(2);

if (args.length < 2) {
    console.log(`
Usage:
  node generate_key.js <MACHINE_ID> <EXPIRY_DATE>

Example:
  node generate_key.js ABCD-1234-EFGH-5678 2027-06-16

Outputs the encrypted license key string.
`);
    process.exit(1);
}

const machineId = args[0].toUpperCase().trim();
const expiryDate = args[1].trim();

// Basic format validation
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
if (!dateRegex.test(expiryDate)) {
    console.error("Error: Expiry Date must be in YYYY-MM-DD format.");
    process.exit(1);
}

try {
    const key = generateLicenseKey(machineId, expiryDate);
    console.log("\n==========================================");
    console.log("          GENERATED LICENSE KEY           ");
    console.log("==========================================");
    console.log(`Machine ID : ${machineId}`);
    console.log(`Expiry Date: ${expiryDate}`);
    console.log("------------------------------------------");
    console.log(key);
    console.log("==========================================\n");
} catch (e) {
    console.error("Failed to generate license key:", e.message);
}
