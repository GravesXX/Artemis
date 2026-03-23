import { describe, it, expect } from 'vitest';
import { DailyReporter, type ReportInput, type ReportableJob } from '../reporter.js';
import type { JobPosting } from '../../db/database.js';

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: 'job-1',
    company_id: 'company-1',
    title: 'Software Engineer',
    url: 'https://example.com/jobs/1',
    level: 'senior',
    salary_range: '$150K-$200K',
    location: 'Remote',
    requirements_summary: 'TypeScript, Node.js, PostgreSQL, 5+ years experience building backend services',
    raw_text: 'Full job description text here that is quite long and detailed with many requirements',
    content_hash: 'abc123',
    confidence_score: 85,
    score_breakdown: '{}',
    status: 'new',
    first_seen_at: '2026-03-19T09:00:00.000Z',
    last_seen_at: '2026-03-19T09:00:00.000Z',
    last_changed_at: null,
    ...overrides,
  };
}

function makeReportable(overrides: Partial<Omit<ReportableJob, 'job'>> & { job?: Partial<JobPosting> } = {}): ReportableJob {
  const { job: jobOverrides, ...rest } = overrides;
  return {
    index: 0,
    job: makeJob(jobOverrides),
    companyName: 'Acme Corp',
    category: 'strong_match',
    ...rest,
  };
}

describe('DailyReporter', () => {
  const reporter = new DailyReporter();

  describe('header', () => {
    it('includes the date', () => {
      const input: ReportInput = { date: '2026-03-19', newJobs: [], changedJobs: [], poolSize: 5 };
      const result = reporter.generate(input);
      expect(result.content).toContain('**Daily Job Report — 2026-03-19**');
    });

    it('shows correct counts and pool size', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [
          makeReportable({ job: { id: 'j1', confidence_score: 90 } }),
          makeReportable({ job: { id: 'j2', confidence_score: 65 } }),
        ],
        changedJobs: [makeReportable({ category: 'updated' })],
        poolSize: 8,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('New: 2');
      expect(result.content).toContain('Updated: 1');
      expect(result.content).toContain('Pool: 8 companies');
    });
  });

  describe('strong match tier', () => {
    it('includes jobs with score >= 80', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ companyName: 'Google', job: { confidence_score: 92, title: 'Senior SWE' } })],
        changedJobs: [],
        poolSize: 5,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('**Strong Match (80+)**');
      expect(result.content).toContain('Senior SWE — Google');
      expect(result.content).toContain('Score: 92');
    });

    it('sorts by score descending', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [
          makeReportable({ companyName: 'Low Co', job: { id: 'j1', confidence_score: 82, title: 'Low Job' } }),
          makeReportable({ companyName: 'High Co', job: { id: 'j2', confidence_score: 95, title: 'High Job' } }),
        ],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      const highIdx = result.content.indexOf('High Job');
      const lowIdx = result.content.indexOf('Low Job');
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('shows salary and location', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { salary_range: '$200K-$300K', location: 'NYC' } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('$200K-$300K');
      expect(result.content).toContain('NYC');
    });

    it('includes view details link', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { url: 'https://example.com/jobs/42' } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('[View Details](https://example.com/jobs/42)');
    });
  });

  describe('moderate match tier', () => {
    it('includes jobs with score 60-79', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ companyName: 'Mid Co', job: { confidence_score: 68, title: 'Mid Job' } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('**Moderate Match (60-79)**');
      expect(result.content).toContain('Mid Job — Mid Co');
      expect(result.content).not.toContain('Strong Match');
    });

    it('continues index numbering from strong match', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [
          makeReportable({ job: { id: 'j1', confidence_score: 90, title: 'Strong Job' } }),
          makeReportable({ job: { id: 'j2', confidence_score: 65, title: 'Moderate Job' } }),
        ],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('**1. Strong Job');
      expect(result.content).toContain('**2. Moderate Job');
    });
  });

  describe('updated listings', () => {
    it('includes changed jobs', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [],
        changedJobs: [makeReportable({ companyName: 'Stripe', category: 'updated', job: { title: 'Backend SWE' } })],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('**Updated Listings**');
      expect(result.content).toContain('Backend SWE — Stripe (requirements changed)');
    });
  });

  describe('exclusions', () => {
    it('excludes jobs with score below 60', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { confidence_score: 45 } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).not.toContain('Strong Match');
      expect(result.content).not.toContain('Moderate Match');
      expect(result.newJobsCount).toBe(0);
    });

    it('excludes jobs with null score', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { confidence_score: null } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.newJobsCount).toBe(0);
      expect(result.jobIds).toHaveLength(0);
    });

    it('omits empty sections', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { confidence_score: 70 } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).not.toContain('Strong Match');
      expect(result.content).toContain('Moderate Match');
      expect(result.content).not.toContain('Updated Listings');
    });
  });

  describe('footer', () => {
    it('includes the reply prompt', () => {
      const input: ReportInput = { date: '2026-03-19', newJobs: [], changedJobs: [], poolSize: 3 };
      const result = reporter.generate(input);
      expect(result.content).toContain('Reply with a job number to start the application process.');
    });
  });

  describe('empty report', () => {
    it('generates a valid report with no jobs', () => {
      const input: ReportInput = { date: '2026-03-19', newJobs: [], changedJobs: [], poolSize: 3 };
      const result = reporter.generate(input);
      expect(result.content).toContain('Daily Job Report');
      expect(result.content).toContain('No qualifying jobs found today');
      expect(result.newJobsCount).toBe(0);
      expect(result.changedJobsCount).toBe(0);
      expect(result.jobIds).toHaveLength(0);
    });
  });

  describe('metadata', () => {
    it('returns all included job IDs', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [
          makeReportable({ job: { id: 'strong-1', confidence_score: 90 } }),
          makeReportable({ job: { id: 'moderate-1', confidence_score: 65 } }),
          makeReportable({ job: { id: 'weak-1', confidence_score: 40 } }),
        ],
        changedJobs: [makeReportable({ category: 'updated', job: { id: 'changed-1' } })],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.jobIds).toContain('strong-1');
      expect(result.jobIds).toContain('moderate-1');
      expect(result.jobIds).toContain('changed-1');
      expect(result.jobIds).not.toContain('weak-1');
    });

    it('counts only reportable jobs in newJobsCount', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [
          makeReportable({ job: { id: 'j1', confidence_score: 90 } }),
          makeReportable({ job: { id: 'j2', confidence_score: 30 } }),
        ],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.newJobsCount).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles missing salary gracefully', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { salary_range: null, confidence_score: 85 } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).not.toContain('null');
      expect(result.content).toContain('Score: 85');
    });

    it('handles missing location gracefully', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { location: null, confidence_score: 85 } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).not.toContain('null');
    });

    it('truncates long requirements summary', () => {
      const longSummary = 'A '.repeat(200);
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { requirements_summary: longSummary, confidence_score: 85 } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('...');
    });

    it('falls back to raw_text when requirements_summary is empty', () => {
      const input: ReportInput = {
        date: '2026-03-19',
        newJobs: [makeReportable({ job: { requirements_summary: '', raw_text: 'Build cool stuff with TypeScript', confidence_score: 85 } })],
        changedJobs: [],
        poolSize: 3,
      };
      const result = reporter.generate(input);
      expect(result.content).toContain('Build cool stuff with TypeScript');
    });
  });
});
