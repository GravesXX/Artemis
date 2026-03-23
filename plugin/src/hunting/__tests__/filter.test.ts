import { describe, it, expect } from 'vitest';
import { JobFilter, getDefaultFilter, type JobFilterConfig } from '../filter.js';
import type { ScrapedJob } from '../differ.js';

function makeJob(overrides: Partial<ScrapedJob> = {}): ScrapedJob {
  return {
    url: 'https://example.com/jobs/1',
    title: 'Software Engineer',
    rawText: 'We are looking for a software engineer in Toronto, Ontario, Canada.',
    salary: null,
    location: 'Toronto, ON',
    level: null,
    ...overrides,
  };
}

const defaultFilter = getDefaultFilter();

describe('JobFilter', () => {
  const filter = new JobFilter(defaultFilter);

  describe('title keywords', () => {
    it('passes jobs with "engineer" in title', () => {
      const { passed } = filter.filter([makeJob({ title: 'Software Engineer' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes jobs with "developer" in title', () => {
      const { passed } = filter.filter([makeJob({ title: 'Full Stack Developer' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes jobs with "SWE" in title', () => {
      const { passed } = filter.filter([makeJob({ title: 'Senior SWE - Platform' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes jobs with "SDE" in title', () => {
      const { passed } = filter.filter([makeJob({ title: 'SDE II' })]);
      expect(passed).toHaveLength(1);
    });

    it('filters out non-engineering titles', () => {
      const { filtered } = filter.filter([makeJob({ title: 'Product Manager' })]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].reason).toContain('no engineer/developer keyword');
    });

    it('filters out titles with excluded keywords', () => {
      const { filtered } = filter.filter([makeJob({ title: 'Engineering Manager' })]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].reason).toContain('excluded keyword');
    });

    it('filters out designer roles', () => {
      const { filtered } = filter.filter([makeJob({ title: 'UX Designer' })]);
      expect(filtered).toHaveLength(1);
    });
  });

  describe('location', () => {
    it('passes Ontario jobs', () => {
      const { passed } = filter.filter([makeJob({ location: 'Toronto, Ontario', rawText: 'Based in Ontario' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes remote-canada jobs', () => {
      const { passed } = filter.filter([makeJob({ location: 'Remote - Canada' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes remote US/Canada jobs', () => {
      const { passed } = filter.filter([makeJob({ location: 'Remote - US/Canada' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes jobs in Toronto', () => {
      const { passed } = filter.filter([makeJob({ location: 'Toronto, ON' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes jobs in Canada', () => {
      const { passed } = filter.filter([makeJob({ location: 'Canada' })]);
      expect(passed).toHaveLength(1);
    });

    it('filters out US-only remote jobs', () => {
      const { filtered } = filter.filter([makeJob({ location: 'Remote - United States' })]);
      expect(filtered).toHaveLength(1);
    });

    it('filters out US-only locations', () => {
      const { filtered } = filter.filter([makeJob({ location: 'San Francisco, CA' })]);
      expect(filtered).toHaveLength(1);
    });

    it('filters out jobs with no location info', () => {
      const { filtered } = filter.filter([makeJob({ location: null })]);
      expect(filtered).toHaveLength(1);
    });

    it('filters out generic remote (no country specified)', () => {
      const { filtered } = filter.filter([makeJob({ location: 'Remote' })]);
      expect(filtered).toHaveLength(1);
    });
  });

  describe('level', () => {
    it('passes junior roles', () => {
      const { passed } = filter.filter([makeJob({ title: 'Junior Software Engineer', level: 'junior' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes mid-level roles', () => {
      const { passed } = filter.filter([makeJob({ title: 'Software Engineer', level: 'mid' })]);
      expect(passed).toHaveLength(1);
    });

    it('passes senior roles', () => {
      const { passed } = filter.filter([makeJob({ title: 'Senior Software Engineer', level: 'senior' })]);
      expect(passed).toHaveLength(1);
    });

    it('filters out staff roles', () => {
      const { filtered } = filter.filter([makeJob({ title: 'Staff Software Engineer', level: 'staff' })]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].reason).toContain('exceeds max level');
    });

    it('filters out principal roles', () => {
      const { filtered } = filter.filter([makeJob({ title: 'Principal Engineer', level: 'principal' })]);
      expect(filtered).toHaveLength(1);
    });

    it('filters out lead roles', () => {
      const { filtered } = filter.filter([makeJob({ title: 'Lead Engineer', level: 'lead' })]);
      expect(filtered).toHaveLength(1);
    });

    it('passes roles with no level detected', () => {
      const { passed } = filter.filter([makeJob({ title: 'Software Engineer II', level: null })]);
      expect(passed).toHaveLength(1);
    });

    it('detects level from title when level field is null', () => {
      const { filtered } = filter.filter([makeJob({ title: 'Staff Software Engineer', level: null })]);
      expect(filtered).toHaveLength(1);
    });
  });

  describe('combined filters', () => {
    it('all filters must pass', () => {
      // Good title, good location, good level
      const { passed } = filter.filter([
        makeJob({ title: 'Senior Software Engineer', location: 'Toronto, ON', level: 'senior' }),
      ]);
      expect(passed).toHaveLength(1);
    });

    it('filters multiple jobs and separates passed/filtered', () => {
      const jobs = [
        makeJob({ title: 'Software Engineer', location: 'Toronto, ON', level: 'mid' }),                    // pass
        makeJob({ title: 'Staff Engineer', location: 'Toronto', level: 'staff' }),                          // fail: level
        makeJob({ title: 'Product Manager', location: 'Toronto', level: null }),                            // fail: title
        makeJob({ title: 'Software Developer', location: 'NYC' }),                                          // fail: location
        makeJob({ title: 'Junior Developer', location: 'Remote - Canada' }),                                // pass
      ];

      const { passed, filtered } = filter.filter(jobs);
      expect(passed).toHaveLength(2);
      expect(filtered).toHaveLength(3);
    });
  });

  describe('getDefaultFilter', () => {
    it('returns a valid config', () => {
      const config = getDefaultFilter();
      expect(config.locations).toContain('ontario');
      expect(config.locations).toContain('remote - canada');
      expect(config.titleKeywords).toContain('engineer');
      expect(config.titleKeywords).toContain('developer');
      expect(config.maxLevel).toBe('senior');
    });
  });
});
