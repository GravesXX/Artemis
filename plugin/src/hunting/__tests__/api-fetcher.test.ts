import { describe, it, expect } from 'vitest';
import {
  extractGreenhouseBoardToken,
  extractLeverCompanySlug,
  detectApiFetchable,
} from '../api-fetcher.js';

describe('API Fetcher', () => {
  describe('extractGreenhouseBoardToken', () => {
    it('extracts token from boards.greenhouse.io URL', () => {
      expect(extractGreenhouseBoardToken('https://boards.greenhouse.io/stripe')).toBe('stripe');
    });

    it('extracts token from job-boards.greenhouse.io URL', () => {
      expect(extractGreenhouseBoardToken('https://job-boards.greenhouse.io/anthropic')).toBe('anthropic');
    });

    it('extracts token with path segments', () => {
      expect(extractGreenhouseBoardToken('https://job-boards.greenhouse.io/vercel/jobs/123')).toBe('vercel');
    });

    it('returns null for non-Greenhouse URL', () => {
      expect(extractGreenhouseBoardToken('https://careers.google.com')).toBeNull();
    });
  });

  describe('extractLeverCompanySlug', () => {
    it('extracts slug from Lever URL', () => {
      expect(extractLeverCompanySlug('https://jobs.lever.co/wealthsimple')).toBe('wealthsimple');
    });

    it('extracts slug with job path', () => {
      expect(extractLeverCompanySlug('https://jobs.lever.co/wealthsimple/abc-123')).toBe('wealthsimple');
    });

    it('returns null for non-Lever URL', () => {
      expect(extractLeverCompanySlug('https://careers.google.com')).toBeNull();
    });
  });

  describe('detectApiFetchable', () => {
    it('detects Greenhouse URLs', () => {
      expect(detectApiFetchable('https://job-boards.greenhouse.io/anthropic')).toBe('greenhouse');
      expect(detectApiFetchable('https://boards.greenhouse.io/stripe')).toBe('greenhouse');
    });

    it('detects Lever URLs', () => {
      expect(detectApiFetchable('https://jobs.lever.co/wealthsimple')).toBe('lever');
    });

    it('returns null for non-API URLs', () => {
      expect(detectApiFetchable('https://careers.google.com')).toBeNull();
      expect(detectApiFetchable('https://www.metacareers.com/jobs')).toBeNull();
    });
  });
});
