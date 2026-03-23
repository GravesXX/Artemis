import { describe, it, expect } from 'vitest';
import { CareerPageScraper } from '../scraper.js';

describe('CareerPageScraper', () => {
  const scraper = new CareerPageScraper();

  describe('detectPlatform', () => {
    it('detects Greenhouse URLs', () => {
      expect(scraper.detectPlatform('https://boards.greenhouse.io/stripe/jobs/123')).toBe('greenhouse');
      expect(scraper.detectPlatform('https://grnh.se/abc123')).toBe('greenhouse');
    });

    it('detects Lever URLs', () => {
      expect(scraper.detectPlatform('https://jobs.lever.co/company/123')).toBe('lever');
    });

    it('detects Workday URLs', () => {
      expect(scraper.detectPlatform('https://company.wd5.myworkdayjobs.com/en-US/jobs')).toBe('workday');
      expect(scraper.detectPlatform('https://company.wd1.myworkdayjobs.com/jobs')).toBe('workday');
      expect(scraper.detectPlatform('https://company.myworkdayjobs.com/jobs')).toBe('workday');
    });

    it('detects Ashby URLs', () => {
      expect(scraper.detectPlatform('https://jobs.ashbyhq.com/company')).toBe('ashby');
    });

    it('detects Google URLs', () => {
      expect(scraper.detectPlatform('https://careers.google.com')).toBe('google');
    });

    it('detects Apple URLs', () => {
      expect(scraper.detectPlatform('https://jobs.apple.com/en-us/search')).toBe('apple');
    });

    it('detects Microsoft URLs', () => {
      expect(scraper.detectPlatform('https://careers.microsoft.com/us/en/search-results')).toBe('microsoft');
    });

    it('falls back to generic', () => {
      expect(scraper.detectPlatform('https://example.com/jobs')).toBe('generic');
    });
  });

  describe('resolveUrl', () => {
    it('resolves relative paths', () => {
      const resolved = scraper.resolveUrl('https://example.com/careers', '/jobs/123');
      expect(resolved).toBe('https://example.com/jobs/123');
    });

    it('preserves absolute URLs', () => {
      const resolved = scraper.resolveUrl('https://example.com', 'https://other.com/jobs/1');
      expect(resolved).toBe('https://other.com/jobs/1');
    });

    it('handles protocol-relative URLs', () => {
      const resolved = scraper.resolveUrl('https://example.com', '//cdn.example.com/page');
      expect(resolved).toBe('https://cdn.example.com/page');
    });
  });

  describe('htmlToText', () => {
    it('strips HTML tags', () => {
      expect(CareerPageScraper.htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
    });

    it('removes script and style blocks', () => {
      const html = '<p>Text</p><script>alert("xss")</script><style>.a{color:red}</style><p>More</p>';
      const result = CareerPageScraper.htmlToText(html);
      expect(result).not.toContain('alert');
      expect(result).not.toContain('color');
      expect(result).toContain('Text');
      expect(result).toContain('More');
    });

    it('decodes HTML entities', () => {
      expect(CareerPageScraper.htmlToText('&amp; &lt; &gt; &quot;')).toBe('& < > "');
    });

    it('preserves newlines from block elements', () => {
      const result = CareerPageScraper.htmlToText('<p>Para 1</p><p>Para 2</p>');
      expect(result).toContain('Para 1');
      expect(result).toContain('Para 2');
    });
  });
});
