import { describe, it, expect } from 'vitest';
import { JobDiffer, type ScrapedJob } from '../differ.js';
import type { JobPosting } from '../../db/database.js';

function makeExisting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: 'existing-1',
    company_id: 'company-1',
    title: 'Software Engineer',
    url: 'https://example.com/jobs/1',
    level: 'senior',
    salary_range: null,
    location: 'Remote',
    requirements_summary: 'Build things',
    raw_text: 'We are looking for a software engineer.',
    content_hash: JobDiffer.hashContent('We are looking for a software engineer.'),
    confidence_score: 80,
    score_breakdown: null,
    status: 'new',
    first_seen_at: '2026-03-15T00:00:00.000Z',
    last_seen_at: '2026-03-16T00:00:00.000Z',
    last_changed_at: null,
    ...overrides,
  };
}

function makeScraped(overrides: Partial<ScrapedJob> = {}): ScrapedJob {
  return {
    url: 'https://example.com/jobs/1',
    title: 'Software Engineer',
    rawText: 'We are looking for a software engineer.',
    salary: null,
    location: 'Remote',
    level: 'senior',
    ...overrides,
  };
}

describe('JobDiffer', () => {
  const differ = new JobDiffer();

  describe('hashContent', () => {
    it('produces consistent SHA-256 hashes', () => {
      const h1 = JobDiffer.hashContent('hello world');
      const h2 = JobDiffer.hashContent('hello world');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    it('produces different hashes for different content', () => {
      const h1 = JobDiffer.hashContent('hello');
      const h2 = JobDiffer.hashContent('world');
      expect(h1).not.toBe(h2);
    });

    it('normalizes whitespace before hashing', () => {
      const h1 = JobDiffer.hashContent('hello   world');
      const h2 = JobDiffer.hashContent('hello world');
      expect(h1).toBe(h2);
    });
  });

  describe('diff', () => {
    it('detects new jobs (URL not in existing)', () => {
      const scraped = [makeScraped({ url: 'https://example.com/jobs/new' })];
      const result = differ.diff(scraped, []);

      expect(result.newJobs).toHaveLength(1);
      expect(result.changedJobs).toHaveLength(0);
      expect(result.removedJobs).toHaveLength(0);
      expect(result.unchangedJobs).toHaveLength(0);
    });

    it('detects unchanged jobs (same URL, same hash)', () => {
      const existing = [makeExisting()];
      const scraped = [makeScraped()];
      const result = differ.diff(scraped, existing);

      expect(result.newJobs).toHaveLength(0);
      expect(result.unchangedJobs).toHaveLength(1);
    });

    it('detects changed jobs (same URL, different hash)', () => {
      const existing = [makeExisting()];
      const scraped = [makeScraped({ rawText: 'Updated job description with new requirements.' })];
      const result = differ.diff(scraped, existing);

      expect(result.changedJobs).toHaveLength(1);
      expect(result.changedJobs[0].scraped.rawText).toContain('Updated');
      expect(result.changedJobs[0].existing.id).toBe('existing-1');
    });

    it('detects removed jobs (in existing but not scraped)', () => {
      const existing = [makeExisting()];
      const result = differ.diff([], existing);

      expect(result.removedJobs).toHaveLength(1);
      expect(result.removedJobs[0].id).toBe('existing-1');
    });

    it('does not flag already-closed jobs as removed', () => {
      const existing = [makeExisting({ status: 'closed' })];
      const result = differ.diff([], existing);

      expect(result.removedJobs).toHaveLength(0);
    });

    it('handles both empty (no results)', () => {
      const result = differ.diff([], []);
      expect(result.newJobs).toHaveLength(0);
      expect(result.changedJobs).toHaveLength(0);
      expect(result.removedJobs).toHaveLength(0);
      expect(result.unchangedJobs).toHaveLength(0);
    });

    it('handles mix of all categories', () => {
      const existing = [
        makeExisting({ id: 'e1', url: 'https://example.com/jobs/1' }),
        makeExisting({ id: 'e2', url: 'https://example.com/jobs/2', raw_text: 'Old description', content_hash: JobDiffer.hashContent('Old description') }),
        makeExisting({ id: 'e3', url: 'https://example.com/jobs/3' }),
      ];
      const scraped = [
        makeScraped({ url: 'https://example.com/jobs/1' }),                       // unchanged
        makeScraped({ url: 'https://example.com/jobs/2', rawText: 'New desc' }),  // changed
        makeScraped({ url: 'https://example.com/jobs/4', title: 'New Role' }),    // new
        // jobs/3 is absent → removed
      ];

      const result = differ.diff(scraped, existing);
      expect(result.unchangedJobs).toHaveLength(1);
      expect(result.changedJobs).toHaveLength(1);
      expect(result.newJobs).toHaveLength(1);
      expect(result.removedJobs).toHaveLength(1);
    });
  });
});
