import type { PluginAPI } from '../types.js';
import type { ArtemisDB } from '../db/database.js';
import { DailyReporter, type ReportableJob } from '../hunting/reporter.js';
import { text } from './helpers.js';

export function registerReportTools(api: PluginAPI, db: ArtemisDB): void {
  const reporter = new DailyReporter();

  api.registerTool({
    name: 'artemis_report_generate',
    description: 'Generate the daily job report from current DB state. Gathers new and changed jobs, formats a Discord-friendly report, and stores it.',
    parameters: {
      date: { type: 'string', description: 'Report date in YYYY-MM-DD format (defaults to today)' },
    },
    execute: async (_id, params) => {
      const date = (params.date as string) || new Date().toISOString().slice(0, 10);

      // Idempotency: return existing report if already generated
      const existing = db.getDailyReportByDate(date);
      if (existing) {
        return text({
          content: `Report for ${date} already exists (generated at ${existing.generated_at.slice(11, 16)} UTC).\n\n${existing.report_content}`,
        });
      }

      // Gather new jobs (status = 'new')
      const newJobPostings = db.getJobPostingsByStatus('new');

      // Gather changed jobs (last_changed_at matches today)
      const allJobs = db.getAllJobPostings();
      const changedJobPostings = allJobs.filter(j =>
        j.last_changed_at !== null &&
        j.last_changed_at.startsWith(date) &&
        j.status !== 'new'
      );

      const poolSize = db.getActiveCompanies().length;

      // Build ReportableJob arrays
      const newReportable: ReportableJob[] = newJobPostings.map(job => {
        const company = db.getCompany(job.company_id);
        return {
          index: 0,
          job,
          companyName: company?.name ?? 'Unknown',
          category: 'strong_match' as const,
        };
      });

      const changedReportable: ReportableJob[] = changedJobPostings.map(job => {
        const company = db.getCompany(job.company_id);
        return {
          index: 0,
          job,
          companyName: company?.name ?? 'Unknown',
          category: 'updated' as const,
        };
      });

      // Generate report
      const result = reporter.generate({
        date,
        newJobs: newReportable,
        changedJobs: changedReportable,
        poolSize,
      });

      // Store report
      db.createDailyReport(date, result.newJobsCount, result.changedJobsCount, result.content);

      // Mark all 'new' jobs as 'seen' so they don't reappear tomorrow
      for (const job of newJobPostings) {
        db.updateJobPostingStatus(job.id, 'seen');
      }

      return text({ content: result.content });
    },
  });

  api.registerTool({
    name: 'artemis_report_history',
    description: 'View past daily reports. Shows date, new job count, and updated job count for recent reports.',
    parameters: {
      limit: { type: 'string', description: 'Number of reports to show (default: 7)' },
    },
    execute: async (_id, params) => {
      const limit = params.limit ? parseInt(params.limit as string, 10) : 7;
      const reports = db.getRecentReports(limit);

      if (reports.length === 0) {
        return text({
          content: 'No reports generated yet. Run `artemis_scan_all` followed by `artemis_report_generate` to create the first report.',
        });
      }

      const lines: string[] = [
        `**Report History — ${reports.length} most recent**`,
        '',
      ];

      for (const report of reports) {
        lines.push(
          `**${report.date}** — New: ${report.new_jobs_count}, Updated: ${report.changed_jobs_count} ` +
          `(generated ${report.generated_at.slice(11, 16)} UTC)`
        );
      }

      return text({ content: lines.join('\n') });
    },
  });
}
