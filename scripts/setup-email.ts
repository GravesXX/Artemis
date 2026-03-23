import { ArtemisDB } from '../plugin/src/db/database';
import { encrypt } from '../plugin/src/application/crypto';
import { EmailMonitor } from '../plugin/src/email/monitor';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: npx tsx scripts/setup-email.ts <email> <app-password> [provider]');
  console.log('');
  console.log('Examples:');
  console.log('  npx tsx scripts/setup-email.ts user@gmail.com abcdefghijklmnop gmail');
  console.log('  npx tsx scripts/setup-email.ts user@outlook.com mypassword outlook');
  console.log('');
  console.log('Providers: gmail (default), outlook, yahoo, icloud, custom');
  process.exit(1);
}

const email = args[0];
const password = args[1];
const provider = args[2] ?? 'gmail';

const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const db = new ArtemisDB(vaultPath);

console.log(`Setting up application email...`);
console.log(`  Email:    ${email}`);
console.log(`  Provider: ${provider}`);
console.log('');

// Encrypt and store
const encryptedPassword = encrypt(password);
const cred = db.createCredential('Application Email', email, encryptedPassword, provider);
console.log(`Credential stored (ID: ${cred.id.slice(0, 8)})`);
console.log('Password encrypted with AES-256-GCM');
console.log('');

// Test IMAP connection
console.log('Testing IMAP connection...');
const monitor = new EmailMonitor();
const config = EmailMonitor.resolveConfig(provider, email, password);

monitor.testConnection(config).then(result => {
  if (result.success) {
    console.log('Connection test: PASSED');
    console.log('');
    console.log('Email monitoring is ready. Artemis will check for responses during daily scans.');
  } else {
    console.log(`Connection test: FAILED — ${result.error}`);
    console.log('');
    if (provider === 'gmail') {
      console.log('For Gmail, make sure you are using an App Password:');
      console.log('  1. Enable 2-Step Verification at myaccount.google.com/security');
      console.log('  2. Generate App Password at myaccount.google.com/apppasswords');
    }
  }
  db.close();
});
