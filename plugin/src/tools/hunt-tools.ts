import type { PluginAPI } from '../types.js';
import type { ArtemisDB } from '../db/database.js';
import { CareerPageScraper } from '../hunting/scraper.js';
import { JobDiffer } from '../hunting/differ.js';
import { ConfidenceScorer, type UserProfile } from '../hunting/scorer.js';
import { JobFilter, getDefaultFilter } from '../hunting/filter.js';
import { text } from './helpers.js';

// Default profile used when Athena integration is not yet active.
// Will be replaced by Athena profile data in a later phase.
function getDefaultProfile(): UserProfile {
  return {
    skills: [
      'typescript', 'javascript', 'python', 'react', 'node.js',
      'sql', 'postgresql', 'git', 'docker', 'aws', 'rest', 'api',
      'agile', 'system design', 'microservices',
    ],
    experienceYears: 5,
    level: 'senior',
    domains: ['backend', 'full-stack'],
  };
}

export function registerHuntTools(api: PluginAPI, db: ArtemisDB): void {
  const scorer = new ConfidenceScorer();
  const differ = new JobDiffer();
  const jobFilter = new JobFilter(getDefaultFilter());

  api.registerTool({
    name: 'artemis_scan_company',
    description: 'Scan a single company career page for job postings. Discovers new, changed, and removed jobs.',
    parameters: {
      company_id: { type: 'string', description: 'Company ID to scan', required: true },
    },
    execute: async (_id, params) => {
      const companyId = params.company_id as string;
      const company = db.getCompany(companyId);
      if (!company) {
        return text({ content: '', error: `Company not found: ${companyId}` });
      }
      if (!company.is_active) {
        return text({ content: '', error: `Company "${company.name}" is paused. Activate it first with artemis_company_update.` });
      }

      const scraper = new CareerPageScraper();
      try {
        await scraper.init();
        const scrapeResult = await scraper.scrapeCompany(company.id, company.careers_url);

        // Apply filters before processing
        const { passed: filteredJobs, filtered: droppedJobs } = jobFilter.filter(scrapeResult.jobs);

        const existingJobs = db.getJobPostingsByCompany(company.id);
        const diffResult = differ.diff(filteredJobs, existingJobs);
        const profile = getDefaultProfile();

        // Process new jobs
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

        // Process changed jobs
        for (const { scraped, existing } of diffResult.changedJobs) {
          const hash = JobDiffer.hashContent(scraped.rawText);
          db.updateJobPostingContent(existing.id, scraped.rawText, hash);
          const scoreResult = scorer.score(scraped.rawText, profile);
          db.updateJobPostingScore(existing.id, scoreResult.overall, JSON.stringify(scoreResult.breakdown));
        }

        // Process removed jobs
        for (const job of diffResult.removedJobs) {
          db.updateJobPostingStatus(job.id, 'closed');
        }

        // Update unchanged jobs
        for (const job of diffResult.unchangedJobs) {
          db.updateJobPostingLastSeen(job.id);
        }

        // Log the scan
        db.createScanLog(
          company.id,
          scrapeResult.jobs.length,
          diffResult.newJobs.length,
          diffResult.changedJobs.length,
          scrapeResult.errors.length > 0 ? scrapeResult.errors.join('; ') : undefined
        );

        // Build response
        const lines: string[] = [
          `**Scan complete: ${company.name}**`,
          '',
          `- Jobs on page: ${scrapeResult.jobs.length}`,
          `- Passed filters: ${filteredJobs.length}`,
          `- Filtered out: ${droppedJobs.length}`,
          `- New: ${diffResult.newJobs.length}`,
          `- Updated: ${diffResult.changedJobs.length}`,
          `- Removed: ${diffResult.removedJobs.length}`,
          `- Unchanged: ${diffResult.unchangedJobs.length}`,
        ];

        if (droppedJobs.length > 0 && droppedJobs.length <= 5) {
          lines.push('', '**Filtered out:**');
          for (const { job, reason } of droppedJobs) {
            lines.push(`- ~~${job.title}~~ — ${reason}`);
          }
        } else if (droppedJobs.length > 5) {
          lines.push('', `**Filtered out ${droppedJobs.length} jobs** (location/title/level mismatch)`);
        }

        if (scrapeResult.errors.length > 0) {
          lines.push('', `**Errors:** ${scrapeResult.errors.length}`);
          for (const err of scrapeResult.errors.slice(0, 3)) {
            lines.push(`- ${err}`);
          }
        }

        if (diffResult.newJobs.length > 0) {
          lines.push('', '**New jobs found:**');
          for (const scraped of diffResult.newJobs) {
            const job = db.getJobPostingByUrl(scraped.url);
            const score = job?.confidence_score ?? '—';
            lines.push(`- ${scraped.title} (score: ${score}) ${scraped.location ?? ''}`);
          }
        }

        return text({ content: lines.join('\n') });
      } finally {
        await scraper.close();
      }
    },
  });

  api.registerTool({
    name: 'artemis_scan_all',
    description: 'Scan all active companies for new job postings. Run this for the daily hunt.',
    parameters: {},
    execute: async () => {
      const companies = db.getActiveCompanies();
      if (companies.length === 0) {
        return text({ content: 'No active companies in the hunting pool. Add companies with `artemis_company_add`.' });
      }

      const scraper = new CareerPageScraper();
      let totalNew = 0;
      let totalChanged = 0;
      let totalRemoved = 0;
      let totalErrors = 0;
      let totalFiltered = 0;
      const companyResults: string[] = [];

      try {
        await scraper.init();
        const profile = getDefaultProfile();

        for (const company of companies) {
          try {
            const scrapeResult = await scraper.scrapeCompany(company.id, company.careers_url);

            // Apply filters
            const { passed: filteredJobs, filtered: droppedJobs } = jobFilter.filter(scrapeResult.jobs);
            totalFiltered += droppedJobs.length;

            const existingJobs = db.getJobPostingsByCompany(company.id);
            const diffResult = differ.diff(filteredJobs, existingJobs);

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
            totalRemoved += diffResult.removedJobs.length;
            totalErrors += scrapeResult.errors.length;

            db.createScanLog(
              company.id,
              scrapeResult.jobs.length,
              diffResult.newJobs.length,
              diffResult.changedJobs.length,
              scrapeResult.errors.length > 0 ? scrapeResult.errors.join('; ') : undefined
            );

            const filterNote = droppedJobs.length > 0 ? `, ${droppedJobs.length} filtered` : '';
            const status = diffResult.newJobs.length > 0 ? `+${diffResult.newJobs.length} new${filterNote}` :
                           diffResult.changedJobs.length > 0 ? `${diffResult.changedJobs.length} updated${filterNote}` :
                           `no changes${filterNote}`;
            companyResults.push(`- **${company.name}**: ${scrapeResult.jobs.length} jobs (${status})`);
          } catch (err) {
            totalErrors++;
            companyResults.push(`- **${company.name}**: scan failed — ${err instanceof Error ? err.message : String(err)}`);
            db.createScanLog(company.id, 0, 0, 0, err instanceof Error ? err.message : String(err));
          }
        }

        db.createScanLog(null, 0, totalNew, totalChanged, totalErrors > 0 ? `${totalErrors} errors across companies` : undefined);
      } finally {
        await scraper.close();
      }

      const lines = [
        `**Full scan complete — ${companies.length} companies**`,
        '',
        `- New jobs: ${totalNew}`,
        `- Updated: ${totalChanged}`,
        `- Removed: ${totalRemoved}`,
        `- Filtered out: ${totalFiltered} (location/title/level mismatch)`,
        totalErrors > 0 ? `- Errors: ${totalErrors}` : '',
        '',
        '**Per company:**',
        ...companyResults,
      ].filter(Boolean);

      return text({ content: lines.join('\n') });
    },
  });

  api.registerTool({
    name: 'artemis_job_list',
    description: 'List discovered job postings. Filter by company, status, or minimum confidence score.',
    parameters: {
      company_id: { type: 'string', description: 'Filter by company ID' },
      status: { type: 'string', description: 'Filter by status', enum: ['new', 'seen', 'applied', 'closed'] },
      min_score: { type: 'string', description: 'Minimum confidence score (0-100)' },
    },
    execute: async (_id, params) => {
      const filters: { company_id?: string; status?: string; min_score?: number } = {};
      if (params.company_id) filters.company_id = params.company_id as string;
      if (params.status) filters.status = params.status as string;
      if (params.min_score) filters.min_score = parseInt(params.min_score as string, 10);

      const jobs = db.getAllJobPostings(filters);

      if (jobs.length === 0) {
        return text({ content: 'No jobs found matching the filters. Run a scan first with `artemis_scan_all`.' });
      }

      // Group by company
      const byCompany = new Map<string, typeof jobs>();
      for (const job of jobs) {
        const company = db.getCompany(job.company_id);
        const key = company?.name ?? job.company_id.slice(0, 8);
        if (!byCompany.has(key)) byCompany.set(key, []);
        byCompany.get(key)!.push(job);
      }

      const lines: string[] = [`**${jobs.length} job(s) found:**`, ''];

      let idx = 1;
      for (const [companyName, companyJobs] of byCompany) {
        lines.push(`### ${companyName}`);
        for (const job of companyJobs) {
          const score = job.confidence_score !== null ? `Score: ${job.confidence_score}` : 'Unscored';
          const level = job.level ? ` | ${job.level}` : '';
          const salary = job.salary_range ? ` | ${job.salary_range}` : '';
          const location = job.location ? ` | ${job.location}` : '';
          lines.push(`${idx}. **${job.title}** [${job.status}]`);
          lines.push(`   ${score}${level}${salary}${location}`);
          lines.push(`   ID: ${job.id.slice(0, 8)} | ${job.url}`);
          idx++;
        }
        lines.push('');
      }

      return text({ content: lines.join('\n') });
    },
  });

  api.registerTool({
    name: 'artemis_job_detail',
    description: 'Show full details and score breakdown for a specific job posting.',
    parameters: {
      job_id: { type: 'string', description: 'Job posting ID', required: true },
    },
    execute: async (_id, params) => {
      const jobId = params.job_id as string;
      const job = db.getJobPosting(jobId);
      if (!job) {
        return text({ content: '', error: `Job not found: ${jobId}` });
      }

      const company = db.getCompany(job.company_id);
      const companyName = company?.name ?? 'Unknown';

      const lines: string[] = [
        `## ${job.title}`,
        '',
        `**Company:** ${companyName}`,
        `**URL:** ${job.url}`,
        `**Status:** ${job.status}`,
        `**Level:** ${job.level ?? 'Not specified'}`,
        `**Salary:** ${job.salary_range ?? 'Not specified'}`,
        `**Location:** ${job.location ?? 'Not specified'}`,
        '',
      ];

      if (job.confidence_score !== null) {
        lines.push(`**Confidence Score: ${job.confidence_score}/100**`);

        if (job.score_breakdown) {
          try {
            const breakdown = JSON.parse(job.score_breakdown);
            lines.push('');
            lines.push('**Score Breakdown:**');
            lines.push(`- Skills Match: ${breakdown.skillsMatch ?? '—'}/100 (40% weight)`);
            lines.push(`- Level Match: ${breakdown.levelMatch ?? '—'}/100 (25% weight)`);
            lines.push(`- Domain Relevance: ${breakdown.domainRelevance ?? '—'}/100 (20% weight)`);
            lines.push(`- Experience Years: ${breakdown.experienceYears ?? '—'}/100 (15% weight)`);
          } catch {}
        }
        lines.push('');
      }

      lines.push(`**First seen:** ${job.first_seen_at.slice(0, 10)}`);
      lines.push(`**Last seen:** ${job.last_seen_at.slice(0, 10)}`);
      if (job.last_changed_at) {
        lines.push(`**Last changed:** ${job.last_changed_at.slice(0, 10)}`);
      }

      lines.push('', '---', '', '**Requirements Summary:**', job.requirements_summary || job.raw_text.slice(0, 2000));

      return text({ content: lines.join('\n') });
    },
  });
}
