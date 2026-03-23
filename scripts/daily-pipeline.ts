import { ArtemisDB } from '../plugin/src/db/database';
import { CareerPageScraper } from '../plugin/src/hunting/scraper';
import { JobDiffer } from '../plugin/src/hunting/differ';
import { ConfidenceScorer } from '../plugin/src/hunting/scorer';
import { JobFilter, getDefaultFilter } from '../plugin/src/hunting/filter';
import { DailyReporter, type ReportableJob } from '../plugin/src/hunting/reporter';
import { EmailMonitor } from '../plugin/src/email/monitor';
import { EmailClassifier } from '../plugin/src/email/classifier';
import { decrypt } from '../plugin/src/application/crypto';
import { DiscordPoster } from '../plugin/src/hunting/discord-poster';
import path from 'path';
import os from 'os';
import fs from 'fs';

const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const db = new ArtemisDB(vaultPath);

// Load Discord config from openclaw.json
const OWNER_DISCORD_ID = '680158864716595205';
let discordPoster: DiscordPoster | null = null;

try {
  const openclawConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf-8'));
  const artemisAccount = openclawConfig.channels?.discord?.accounts?.artemis;
  if (artemisAccount?.token) {
    // Find the #daily-job-report channel (requireMention: false)
    const guildId = Object.keys(artemisAccount.guilds ?? {})[0];
    const guild = artemisAccount.guilds?.[guildId];
    const channels = guild?.channels ?? {};
    const reportChannelId = Object.entries(channels).find(
      ([_, cfg]) => (cfg as { requireMention: boolean }).requireMention === false
    )?.[0];

    if (reportChannelId) {
      discordPoster = new DiscordPoster(artemisAccount.token, reportChannelId);
    }
  }
} catch {
  console.log('[Warning] Could not load Discord config from openclaw.json');
}

const profile = {
  skills: [
    'typescript', 'javascript', 'python', 'react', 'node.js',
    'sql', 'postgresql', 'git', 'docker', 'aws', 'rest', 'api',
    'agile', 'system design', 'microservices',
  ],
  experienceYears: 5,
  level: 'senior',
  domains: ['backend', 'full-stack'],
};

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[Artemis] Daily pipeline — ${today}`);

  // ── Step 1: Scan all active companies ─────────────────────────────────
  console.log('\n[Step 1] Scanning companies...');

  const companies = db.getActiveCompanies();
  if (companies.length === 0) {
    console.log('No active companies. Exiting.');
    db.close();
    return;
  }

  const scraper = new CareerPageScraper();
  const differ = new JobDiffer();
  const scorer = new ConfidenceScorer();
  const jobFilter = new JobFilter(getDefaultFilter());

  let totalNew = 0;
  let totalChanged = 0;

  try {
    await scraper.init();

    for (const company of companies) {
      process.stdout.write(`  ${company.name}...`);
      try {
        const scrapeResult = await scraper.scrapeCompany(company.id, company.careers_url);
        const { passed } = jobFilter.filter(scrapeResult.jobs);
        const existingJobs = db.getJobPostingsByCompany(company.id);
        const diffResult = differ.diff(passed, existingJobs);

        for (const scraped of diffResult.newJobs) {
          const hash = JobDiffer.hashContent(scraped.rawText);
          const job = db.createJobPosting(company.id, scraped.title, scraped.url, scraped.rawText, hash, {
            level: scraped.level ?? undefined,
            salary_range: scraped.salary ?? undefined,
            location: scraped.location ?? undefined,
            requirements_summary: scraped.rawText.slice(0, 300),
          });
          const scoreResult = scorer.score(scraped.rawText, profile);
          db.updateJobPostingScore(job.id, scoreResult.overall, JSON.stringify(scoreResult.breakdown));
        }

        for (const { scraped, existing } of diffResult.changedJobs) {
          const hash = JobDiffer.hashContent(scraped.rawText);
          db.updateJobPostingContent(existing.id, scraped.rawText, hash);
          const scoreResult = scorer.score(scraped.rawText, profile);
          db.updateJobPostingScore(existing.id, scoreResult.overall, JSON.stringify(scoreResult.breakdown));
        }

        for (const job of diffResult.removedJobs) {
          db.updateJobPostingStatus(job.id, 'closed');
        }

        for (const job of diffResult.unchangedJobs) {
          db.updateJobPostingLastSeen(job.id);
        }

        totalNew += diffResult.newJobs.length;
        totalChanged += diffResult.changedJobs.length;

        db.createScanLog(
          company.id,
          scrapeResult.jobs.length,
          diffResult.newJobs.length,
          diffResult.changedJobs.length,
          scrapeResult.errors.length > 0 ? scrapeResult.errors.join('; ') : undefined
        );

        console.log(` ${passed.length} passed, +${diffResult.newJobs.length} new`);
      } catch (err) {
        console.log(` FAILED: ${err instanceof Error ? err.message : String(err)}`);
        db.createScanLog(company.id, 0, 0, 0, err instanceof Error ? err.message : String(err));
      }
    }

    await scraper.close();
  } catch (err) {
    console.error('Scraper error:', err);
    await scraper.close();
  }

  console.log(`\n  Scan done: ${totalNew} new, ${totalChanged} changed`);

  // ── Step 2: Generate daily report ─────────────────────────────────────
  console.log('\n[Step 2] Generating report...');

  const existingReport = db.getDailyReportByDate(today);
  if (existingReport) {
    console.log(`  Report for ${today} already exists, skipping.`);
  } else {
    const reporter = new DailyReporter();
    const newJobPostings = db.getJobPostingsByStatus('new');
    const allJobs = db.getAllJobPostings();
    const changedJobPostings = allJobs.filter(j =>
      j.last_changed_at !== null &&
      j.last_changed_at.startsWith(today) &&
      j.status !== 'new'
    );

    const newReportable: ReportableJob[] = newJobPostings.map(job => {
      const company = db.getCompany(job.company_id);
      return { index: 0, job, companyName: company?.name ?? 'Unknown', category: 'strong_match' as const };
    });

    const changedReportable: ReportableJob[] = changedJobPostings.map(job => {
      const company = db.getCompany(job.company_id);
      return { index: 0, job, companyName: company?.name ?? 'Unknown', category: 'updated' as const };
    });

    const report = reporter.generate({
      date: today,
      newJobs: newReportable,
      changedJobs: changedReportable,
      poolSize: companies.length,
    });

    db.createDailyReport(today, report.newJobsCount, report.changedJobsCount, report.content);

    for (const job of newJobPostings) {
      db.updateJobPostingStatus(job.id, 'seen');
    }

    console.log(`  Report generated: ${report.newJobsCount} new, ${report.changedJobsCount} changed`);

    // Post to Discord
    if (discordPoster) {
      const postResult = await discordPoster.post(report.content);
      if (postResult.success) {
        console.log('  Posted to #daily-job-report');
      } else {
        console.log(`  Discord post failed: ${postResult.error}`);
      }
    } else {
      console.log('  Discord not configured, report printed to log:');
      console.log(report.content);
    }
  }

  // ── Step 3: Check email ───────────────────────────────────────────────
  console.log('\n[Step 3] Checking email...');

  const creds = db.getAllCredentials().filter(c => c.label === 'Application Email');
  if (creds.length === 0) {
    console.log('  No application email configured, skipping.');
  } else {
    const cred = creds[creds.length - 1];
    try {
      const password = decrypt(cred.encrypted_password);
      const monitor = new EmailMonitor();
      const classifier = new EmailClassifier(db);
      const config = EmailMonitor.resolveConfig(cred.provider, cred.email, password);
      const fetchResult = await monitor.fetchUnseen(config);

      const existing = db.getRecentEmails(200);
      const existingKeys = new Set(existing.map(e => `${e.from}|${e.subject}|${e.received_at.slice(0, 16)}`));
      const newEmails = fetchResult.emails.filter(e => !existingKeys.has(`${e.from}|${e.subject}|${e.date.slice(0, 16)}`));

      if (newEmails.length === 0) {
        console.log('  No new emails.');
      } else {
        console.log(`  ${newEmails.length} new email(s):`);
        for (const raw of newEmails) {
          const classified = classifier.classify(raw);
          db.createEmailMessage(classified.matchedApplicationId, raw.from, raw.subject, raw.bodyPreview, classified.classification);
          if (classified.statusUpdate && classified.matchedApplicationId) {
            db.updateApplicationStatus(classified.matchedApplicationId, classified.statusUpdate, `Auto-updated from email: ${raw.subject}`);
          }
          console.log(`    [${classified.classification}] ${raw.subject} — from ${raw.from}`);

          // Urgent DM for interview requests and offers
          if (discordPoster && (classified.classification === 'interview_request' || classified.classification === 'offer')) {
            const urgentMsg = `**${classified.classification === 'interview_request' ? 'Interview Request' : 'Offer Received'}${classified.matchedCompanyName ? ` — ${classified.matchedCompanyName}` : ''}**\n\nSubject: ${raw.subject}\nFrom: ${raw.from}`;
            await discordPoster.dm(OWNER_DISCORD_ID, urgentMsg);
            console.log(`    ^ URGENT — DM sent to owner`);
          }
        }
      }
    } catch (err) {
      console.log(`  Email check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n[Artemis] Pipeline complete.');
  db.close();
})();
