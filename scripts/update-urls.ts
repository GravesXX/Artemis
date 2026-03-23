import { ArtemisDB } from '../plugin/src/db/database';
import path from 'path';
import os from 'os';

const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const db = new ArtemisDB(vaultPath);

const urlUpdates: Record<string, string> = {
  'Amazon':       'https://www.amazon.jobs/en/search?base_query=software+engineer&loc_query=Canada',
  'AMD':          'https://careers.amd.com/careers-home/jobs',
  'Anthropic':    'https://job-boards.greenhouse.io/anthropic',
  'Apple':        'https://jobs.apple.com/en-us/search?searchString=software+engineer',
  'Google':       'https://www.google.com/about/careers/applications/jobs/results',
  'IBM':          'https://www.ibm.com/careers/search',
  'Meta':         'https://www.metacareers.com/jobs',
  'Microsoft':    'https://careers.microsoft.com/us/en/search-results',
  'Stripe':       'https://stripe.com/jobs/search',
  'Uber':         'https://www.uber.com/us/en/careers/list/',
  'Vercel':       'https://job-boards.greenhouse.io/vercel',
  'Wealthsimple': 'https://jobs.lever.co/wealthsimple',
};

const companies = db.getAllCompanies();

for (const company of companies) {
  const newUrl = urlUpdates[company.name];
  if (newUrl && newUrl !== company.careers_url) {
    db.updateCompany(company.id, { careers_url: newUrl });
    console.log(`  UPDATE  ${company.name}`);
    console.log(`    old: ${company.careers_url}`);
    console.log(`    new: ${newUrl}`);
  } else {
    console.log(`  OK      ${company.name} — no change needed`);
  }
}

console.log('\n--- Updated Pool ---');
for (const c of db.getAllCompanies()) {
  console.log(`  ${c.name} — ${c.careers_url}`);
}

db.close();
