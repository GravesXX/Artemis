import { ArtemisDB } from '../plugin/src/db/database';
import { CareerPageScraper } from '../plugin/src/hunting/scraper';
import { JobDiffer } from '../plugin/src/hunting/differ';
import { ConfidenceScorer } from '../plugin/src/hunting/scorer';
import { JobFilter, getDefaultFilter } from '../plugin/src/hunting/filter';
import path from 'path';
import os from 'os';

const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const db = new ArtemisDB(vaultPath);

const companies = db.getActiveCompanies();
if (companies.length === 0) {
  console.log('No companies in pool. Run seed-companies.ts first.');
  process.exit(1);
}

console.log(`=== Artemis Full Scan ===`);
console.log(`Companies: ${companies.length}`);
console.log(`Filters: Ontario/Canada/Remote | Engineer/Developer | Junior-Senior max`);
console.log('');

const scraper = new CareerPageScraper();
const differ = new JobDiffer();
const scorer = new ConfidenceScorer();
const jobFilter = new JobFilter(getDefaultFilter());

const profile = {
  skills: ['typescript', 'javascript', 'python', 'react', 'node.js', 'postgresql', 'redis', 'docker', 'kubernetes', 'aws', 'rest', 'graphql', 'git', 'agile', 'system design', 'microservices', 'ci/cd', 'distributed systems'],
  experienceYears: 5,
  level: 'senior',
  domains: ['backend', 'full-stack'],
};

(async () => {
  let totalJobs = 0;
  let totalPassed = 0;
  let totalFiltered = 0;
  let totalErrors = 0;
  const allPassed: Array<{ company: string; title: string; location: string; level: string; score: number; recommendation: string; url: string }> = [];

  try {
    await scraper.init();
    console.log('Browser launched...\n');

    for (const company of companies) {
      process.stdout.write(`Scanning ${company.name}...`);
      try {
        const result = await scraper.scrapeCompany(company.id, company.careers_url);
        const { passed, filtered } = jobFilter.filter(result.jobs);

        totalJobs += result.jobs.length;
        totalPassed += passed.length;
        totalFiltered += filtered.length;
        totalErrors += result.errors.length;

        console.log(` ${result.jobs.length} jobs, ${passed.length} passed, ${filtered.length} filtered`);

        for (const job of passed) {
          const scoreResult = scorer.score(job.rawText, profile);
          allPassed.push({
            company: company.name,
            title: job.title,
            location: job.location ?? 'unknown',
            level: job.level ?? 'unknown',
            score: scoreResult.overall,
            recommendation: scoreResult.recommendation,
            url: job.url,
          });
        }
      } catch (err) {
        totalErrors++;
        console.log(` FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await scraper.close();
  } catch (err) {
    console.error('Fatal error:', err);
    await scraper.close();
  }

  console.log('\n=== Summary ===');
  console.log(`Total jobs found: ${totalJobs}`);
  console.log(`Passed filters:   ${totalPassed}`);
  console.log(`Filtered out:     ${totalFiltered}`);
  console.log(`Errors:           ${totalErrors}`);

  if (allPassed.length > 0) {
    // Sort by score descending
    allPassed.sort((a, b) => b.score - a.score);

    console.log(`\n=== Matching Jobs (${allPassed.length}) ===\n`);
    for (const job of allPassed) {
      console.log(`  [${job.score}] ${job.recommendation.toUpperCase()}`);
      console.log(`  ${job.title} — ${job.company}`);
      console.log(`  Level: ${job.level} | Location: ${job.location}`);
      console.log(`  ${job.url}`);
      console.log('');
    }
  } else {
    console.log('\nNo matching jobs found across all companies.');
  }

  db.close();
})();
