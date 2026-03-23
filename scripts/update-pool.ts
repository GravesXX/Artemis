import { ArtemisDB } from '../plugin/src/db/database';
import path from 'path';
import os from 'os';

const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const db = new ArtemisDB(vaultPath);

// Companies to KEEP
const keepNames = new Set([
  'amazon', 'anthropic', 'apple', 'google', 'meta',
  'microsoft', 'stripe', 'uber', 'vercel',
]);

// Companies to ADD
const toAdd: [string, string][] = [
  ['Wealthsimple', 'https://www.wealthsimple.com/en-ca/careers'],
  ['IBM', 'https://www.ibm.com/careers'],
  ['AMD', 'https://www.amd.com/en/careers'],
];

const all = db.getAllCompanies();

// Remove companies not in keep list
let removed = 0;
for (const company of all) {
  if (!keepNames.has(company.name.toLowerCase())) {
    db.removeCompany(company.id);
    console.log(`  REMOVE  ${company.name}`);
    removed++;
  } else {
    console.log(`  KEEP    ${company.name}`);
  }
}

// Add new companies
const existing = db.getAllCompanies();
const existingNames = new Set(existing.map(c => c.name.toLowerCase()));

let added = 0;
for (const [name, url] of toAdd) {
  if (existingNames.has(name.toLowerCase())) {
    console.log(`  SKIP    ${name} (already exists)`);
  } else {
    db.createCompany(name, url);
    console.log(`  ADD     ${name} — ${url}`);
    added++;
  }
}

console.log(`\nRemoved: ${removed}, Added: ${added}`);
console.log('\n--- Final Pool ---');
for (const c of db.getAllCompanies()) {
  console.log(`  [${c.is_active ? 'active' : 'paused'}] ${c.name} — ${c.careers_url}`);
}
console.log(`Total: ${db.getAllCompanies().length}`);

db.close();
