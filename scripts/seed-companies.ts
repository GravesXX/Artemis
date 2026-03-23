import { ArtemisDB } from '../plugin/src/db/database';
import os from 'os';
import path from 'path';

const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const db = new ArtemisDB(vaultPath);

const companies: [name: string, careersUrl: string][] = [
  // Big tech
  ['Google',       'https://careers.google.com/'],
  ['Meta',         'https://www.metacareers.com/'],
  ['Apple',        'https://jobs.apple.com/'],
  ['Amazon',       'https://www.amazon.jobs/'],
  ['Microsoft',    'https://careers.microsoft.com/'],

  // High-growth
  ['Stripe',       'https://stripe.com/jobs'],
  ['Databricks',   'https://www.databricks.com/company/careers'],
  ['Figma',        'https://www.figma.com/careers/'],
  ['Vercel',       'https://vercel.com/careers'],
  ['Cloudflare',   'https://www.cloudflare.com/careers/'],

  // Strong engineering culture
  ['Netflix',      'https://jobs.netflix.com/'],
  ['Airbnb',       'https://careers.airbnb.com/'],
  ['Uber',         'https://www.uber.com/us/en/careers/'],
  ['Spotify',      'https://www.lifeatspotify.com/jobs'],
  ['Block',        'https://block.xyz/careers'],

  // AI-focused
  ['OpenAI',       'https://openai.com/careers/'],
  ['Anthropic',    'https://www.anthropic.com/careers'],
  ['Cohere',       'https://cohere.com/careers'],
];

console.log(`Seeding ${companies.length} companies into ArtemisDB...`);
console.log(`Vault path: ${vaultPath}\n`);

// Check for existing companies to avoid duplicates
const existing = db.getAllCompanies();
const existingNames = new Set(existing.map(c => c.name.toLowerCase()));

let added = 0;
let skipped = 0;

for (const [name, careersUrl] of companies) {
  if (existingNames.has(name.toLowerCase())) {
    console.log(`  SKIP  ${name} (already exists)`);
    skipped++;
    continue;
  }

  const company = db.createCompany(name, careersUrl);
  console.log(`  ADD   ${company.name} — ${company.careers_url}`);
  added++;
}

console.log(`\nDone. Added: ${added}, Skipped: ${skipped}`);

// Verify by listing all companies
console.log('\n--- All companies in DB ---');
const all = db.getAllCompanies();
for (const c of all) {
  console.log(`  [${c.is_active ? 'active' : 'inactive'}] ${c.name} — ${c.careers_url}`);
}
console.log(`\nTotal: ${all.length} companies`);

db.close();
