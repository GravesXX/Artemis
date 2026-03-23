import type { JobPosting } from '../db/database.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ReportableJob {
  index: number;
  job: JobPosting;
  companyName: string;
  category: 'strong_match' | 'moderate_match' | 'updated';
}

export interface ReportInput {
  date: string;
  newJobs: ReportableJob[];
  changedJobs: ReportableJob[];
  poolSize: number;
}

export interface ReportOutput {
  content: string;
  newJobsCount: number;
  changedJobsCount: number;
  jobIds: string[];
}

// ── DailyReporter ───────────────────────────────────────────────────────────

export class DailyReporter {

  generate(input: ReportInput): ReportOutput {
    const { date, newJobs, changedJobs, poolSize } = input;

    // Categorize new jobs by score tier, sorted descending
    const sorted = [...newJobs].sort((a, b) => {
      const sa = a.job.confidence_score ?? 0;
      const sb = b.job.confidence_score ?? 0;
      return sb - sa;
    });

    const strongJobs: ReportableJob[] = [];
    const moderateJobs: ReportableJob[] = [];

    for (const rj of sorted) {
      const tier = this.tierFromScore(rj.job.confidence_score);
      if (tier === 'strong_match') {
        strongJobs.push({ ...rj, category: 'strong_match' });
      } else if (tier === 'moderate_match') {
        moderateJobs.push({ ...rj, category: 'moderate_match' });
      }
    }

    // Assign continuous index numbers
    let idx = 1;
    for (const rj of strongJobs) rj.index = idx++;
    for (const rj of moderateJobs) rj.index = idx++;

    // Build report
    const sections: string[] = [];

    sections.push(this.formatHeader(
      date,
      strongJobs.length + moderateJobs.length,
      changedJobs.length,
      poolSize
    ));

    if (strongJobs.length > 0) {
      sections.push('**Strong Match (80+)**\n');
      for (const rj of strongJobs) {
        sections.push(this.formatJobEntry(rj));
      }
      sections.push('---\n');
    }

    if (moderateJobs.length > 0) {
      sections.push('**Moderate Match (60-79)**\n');
      for (const rj of moderateJobs) {
        sections.push(this.formatJobEntry(rj));
      }
      sections.push('---\n');
    }

    if (changedJobs.length > 0) {
      sections.push('**Updated Listings**');
      for (const rj of changedJobs) {
        sections.push(this.formatUpdatedEntry(rj));
      }
      sections.push('\n---\n');
    }

    if (strongJobs.length === 0 && moderateJobs.length === 0 && changedJobs.length === 0) {
      sections.push('No qualifying jobs found today. The hunt continues tomorrow.\n');
    }

    sections.push(this.formatFooter());

    const content = sections.join('\n');

    const jobIds = [
      ...strongJobs.map(rj => rj.job.id),
      ...moderateJobs.map(rj => rj.job.id),
      ...changedJobs.map(rj => rj.job.id),
    ];

    return {
      content,
      newJobsCount: strongJobs.length + moderateJobs.length,
      changedJobsCount: changedJobs.length,
      jobIds,
    };
  }

  // ── Formatting helpers ──────────────────────────────────────────────────

  private formatHeader(date: string, newCount: number, changedCount: number, poolSize: number): string {
    return [
      `**Daily Job Report — ${date}**`,
      '',
      `**New: ${newCount} | Updated: ${changedCount} | Pool: ${poolSize} companies**`,
      '',
      '---\n',
    ].join('\n');
  }

  private formatJobEntry(rj: ReportableJob): string {
    const { job, companyName, index } = rj;
    const lines: string[] = [];

    lines.push(`**${index}. ${job.title} — ${companyName}**`);

    const infoParts: string[] = [];
    if (job.salary_range) infoParts.push(job.salary_range);
    if (job.location) infoParts.push(job.location);
    infoParts.push(`Score: ${job.confidence_score ?? '—'}`);
    lines.push(infoParts.join(' | '));

    const summary = this.truncateSummary(job.requirements_summary || job.raw_text);
    lines.push(summary);

    lines.push(`[View Details](${job.url})`);
    lines.push('');

    return lines.join('\n');
  }

  private formatUpdatedEntry(rj: ReportableJob): string {
    return `- ${rj.job.title} — ${rj.companyName} (requirements changed)`;
  }

  private formatFooter(): string {
    return 'Reply with a job number to start the application process.';
  }

  private tierFromScore(score: number | null): 'strong_match' | 'moderate_match' | 'weak_match' | 'skip' {
    if (score === null) return 'skip';
    if (score >= 80) return 'strong_match';
    if (score >= 60) return 'moderate_match';
    if (score >= 40) return 'weak_match';
    return 'skip';
  }

  private truncateSummary(text: string, maxLen: number = 150): string {
    if (text.length <= maxLen) return text;
    const truncated = text.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...';
  }
}
