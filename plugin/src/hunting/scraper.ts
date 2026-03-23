import { chromium, type Browser, type Page } from 'playwright';
import type { ScrapedJob } from './differ.js';
import { detectApiFetchable, fetchGreenhouseJobs, fetchLeverJobs, fetchAshbyJobs } from './api-fetcher.js';
import { getCompanyApiFetcher } from './company-apis.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ScrapeResult {
  companyId: string;
  careersUrl: string;
  jobs: ScrapedJob[];
  errors: string[];
}

type Platform = 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'apple' | 'microsoft' | 'google' | 'generic';

// ── CareerPageScraper ───────────────────────────────────────────────────────

export class CareerPageScraper {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async scrapeCompany(companyId: string, careersUrl: string, timeoutMs: number = 90000): Promise<ScrapeResult> {
    // Wrap entire scrape in a timeout so no single company can block the pipeline
    const timeoutPromise = new Promise<ScrapeResult>((_, reject) =>
      setTimeout(() => reject(new Error(`Scrape timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    );

    return Promise.race([
      this.scrapeCompanyInternal(companyId, careersUrl),
      timeoutPromise,
    ]).catch(err => ({
      companyId,
      careersUrl,
      jobs: [],
      errors: [`${err instanceof Error ? err.message : String(err)}`],
    }));
  }

  private async scrapeCompanyInternal(companyId: string, careersUrl: string): Promise<ScrapeResult> {
    // Fast path 1: company-specific API fetcher (Amazon, Apple, Microsoft, Google)
    const companyFetcher = getCompanyApiFetcher(careersUrl);
    if (companyFetcher) {
      return companyFetcher(companyId, careersUrl);
    }

    // Fast path 2: Greenhouse/Lever JSON API
    const apiType = detectApiFetchable(careersUrl);
    if (apiType === 'greenhouse') {
      return fetchGreenhouseJobs(companyId, careersUrl);
    }
    if (apiType === 'lever') {
      return fetchLeverJobs(companyId, careersUrl);
    }
    if (apiType === 'ashby') {
      return fetchAshbyJobs(companyId, careersUrl);
    }

    // Slow path: browser-based scraping for all other platforms
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    if (!this.browser) {
      await this.init();
    }

    const context = await this.browser!.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    try {
      // Phase 1: Discovery
      await page.goto(careersUrl, { waitUntil: 'domcontentloaded' });
      await this.waitAndSettle(page);

      const platform = this.detectPlatform(careersUrl);
      let jobLinks: string[];

      switch (platform) {
        case 'greenhouse':
          jobLinks = await this.discoverGreenhouse(page, careersUrl);
          break;
        case 'lever':
          jobLinks = await this.discoverLever(page, careersUrl);
          break;
        case 'ashby':
          jobLinks = await this.discoverAshby(page, careersUrl);
          break;
        case 'workday':
          jobLinks = await this.discoverWorkday(page);
          break;
        case 'apple':
          return this.scrapeApple(page, companyId, careersUrl);
        case 'microsoft':
          return this.scrapeMicrosoft(page, companyId, careersUrl);
        case 'google':
          return this.scrapeGoogle(page, companyId, careersUrl);
        default:
          jobLinks = await this.discoverGeneric(page, careersUrl);
      }

      // Deduplicate and cap at 30 links per company to avoid extremely long scrapes
      jobLinks = [...new Set(jobLinks)].slice(0, 30);

      // Phase 2: Extraction
      for (const jobUrl of jobLinks) {
        try {
          await this.delay();
          await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });
          await this.waitAndSettle(page);

          const job = await this.extractJobDetails(page, jobUrl, platform);
          if (job && job.rawText.length > 50) {
            result.jobs.push(job);
          }
        } catch (err) {
          result.errors.push(`Failed to extract ${jobUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      result.errors.push(`Failed to discover jobs at ${careersUrl}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await context.close();
    }

    return result;
  }

  // ── Platform Detection ──────────────────────────────────────────────────

  detectPlatform(url: string): Platform {
    const lower = url.toLowerCase();
    if (lower.includes('boards.greenhouse.io') || lower.includes('job-boards.greenhouse.io') || lower.includes('grnh.se')) return 'greenhouse';
    if (lower.includes('jobs.lever.co')) return 'lever';
    if (lower.includes('myworkdayjobs.com') || lower.includes('.wd5.') || lower.includes('.wd1.')) return 'workday';
    if (lower.includes('jobs.ashbyhq.com')) return 'ashby';
    if (lower.includes('jobs.apple.com')) return 'apple';
    if (lower.includes('careers.microsoft.com')) return 'microsoft';
    if (lower.includes('careers.google.com') || lower.includes('google.com/about/careers')) return 'google';
    return 'generic';
  }

  // ── Discovery Methods ─────────────────────────────────────────────────

  private async discoverGreenhouse(page: Page, baseUrl: string): Promise<string[]> {
    const links = await page.$$eval('div.opening a, a[href*="/jobs/"]', (anchors: HTMLAnchorElement[]) =>
      anchors
        .map(a => a.href)
        .filter(href => /\/jobs\/\d+/.test(href))
    );
    return links.map(href => this.resolveUrl(baseUrl, href));
  }

  private async discoverLever(page: Page, baseUrl: string): Promise<string[]> {
    const links = await page.$$eval('.posting-title a, a.posting-btn-submit, .postings-group a[href]', (anchors: HTMLAnchorElement[]) =>
      anchors
        .map(a => a.href)
        .filter(href => href.includes('jobs.lever.co') && !href.endsWith('/apply'))
    );

    // Fallback: any link on the page that matches lever job pattern
    if (links.length === 0) {
      const fallback = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) =>
        anchors
          .map(a => a.href)
          .filter(href => /jobs\.lever\.co\/[^/]+\/[a-f0-9-]+/.test(href) && !href.endsWith('/apply'))
      );
      return [...new Set(fallback)];
    }

    return [...new Set(links.map(href => this.resolveUrl(baseUrl, href)))];
  }

  private async discoverAshby(page: Page, baseUrl: string): Promise<string[]> {
    const links = await page.$$eval('a[href*="/jobs/"]', (anchors: HTMLAnchorElement[]) =>
      anchors.map(a => a.href).filter(href => href.includes('jobs.ashbyhq.com'))
    );
    return links.map(href => this.resolveUrl(baseUrl, href));
  }

  private async discoverWorkday(page: Page): Promise<string[]> {
    // Workday pages are SPA-heavy; wait extra for hydration
    await page.waitForTimeout(3000);

    const links = await page.$$eval(
      'a[data-automation-id="jobTitle"], a[href*="/job/"], a[href*="/details/"]',
      (anchors: HTMLAnchorElement[]) => anchors.map(a => a.href)
    );

    return [...new Set(links)];
  }

  private async discoverGeneric(page: Page, baseUrl: string): Promise<string[]> {
    const jobPatterns = /\/(jobs?|careers?|positions?|openings?|roles?|vacanc)/i;

    const allLinks = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) =>
      anchors.map(a => ({ href: a.href, text: a.textContent?.trim() || '' }))
    );

    const jobLinks = allLinks
      .filter(link => {
        if (!link.href || link.href === '#' || link.href.startsWith('mailto:')) return false;
        // Match URL patterns that look like job postings
        if (jobPatterns.test(link.href)) return true;
        return false;
      })
      .map(link => this.resolveUrl(baseUrl, link.href))
      // Filter out navigation/category links (usually short paths)
      .filter(url => {
        try {
          const path = new URL(url).pathname;
          // Job detail pages usually have longer paths or IDs
          const segments = path.split('/').filter(Boolean);
          return segments.length >= 2;
        } catch {
          return false;
        }
      });

    return [...new Set(jobLinks)];
  }

  // ── Extraction ────────────────────────────────────────────────────────

  private async extractJobDetails(page: Page, url: string, platform: Platform): Promise<ScrapedJob | null> {
    let partial: Partial<ScrapedJob>;

    switch (platform) {
      case 'greenhouse':
        partial = await this.extractGreenhouse(page);
        break;
      case 'lever':
        partial = await this.extractLever(page);
        break;
      case 'workday':
        partial = await this.extractWorkday(page);
        break;
      default:
        partial = await this.extractGeneric(page);
    }

    const title = partial.title || await this.extractTitle(page);
    const rawText = partial.rawText || await this.extractMainContent(page);

    if (!title || !rawText) return null;

    return {
      url,
      title,
      rawText,
      salary: partial.salary || this.extractSalaryFromText(rawText),
      location: partial.location || this.extractLocationFromPage(rawText),
      level: partial.level || this.detectLevelFromTitle(title),
    };
  }

  private async extractGreenhouse(page: Page): Promise<Partial<ScrapedJob>> {
    const title = await page.$eval('h1.app-title, h1', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    const rawText = await page.$eval('#content, .content', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    const location = await page.$eval('.location', (el: Element) => el.textContent?.trim() || '').catch(() => null);

    return { title: title || undefined, rawText: rawText || undefined, location };
  }

  private async extractLever(page: Page): Promise<Partial<ScrapedJob>> {
    const title = await page.$eval('.posting-headline h2, h1', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    const rawText = await page.$eval('.posting-page, .content', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    const location = await page.$eval('.posting-categories .location, .workplaceTypes', (el: Element) => el.textContent?.trim() || '').catch(() => null);

    return { title: title || undefined, rawText: rawText || undefined, location };
  }

  private async extractWorkday(page: Page): Promise<Partial<ScrapedJob>> {
    await page.waitForTimeout(2000);

    const title = await page.$eval('[data-automation-id="jobPostingHeader"], h1', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    const rawText = await page.$eval('[data-automation-id="jobPostingDescription"], .job-description, main', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    const location = await page.$eval('[data-automation-id="locations"], .css-cygeeu', (el: Element) => el.textContent?.trim() || '').catch(() => null);

    return { title: title || undefined, rawText: rawText || undefined, location };
  }

  private async extractGeneric(page: Page): Promise<Partial<ScrapedJob>> {
    return {};
  }

  // ── Shared Extractors ─────────────────────────────────────────────────

  private async extractTitle(page: Page): Promise<string> {
    // Try structured data first
    const ldJson = await page.$eval('script[type="application/ld+json"]', (el: Element) => el.textContent || '').catch(() => '');
    if (ldJson) {
      try {
        const data = JSON.parse(ldJson);
        if (data.title) return data.title;
        if (data.name) return data.name;
      } catch {}
    }

    // Try h1
    const h1 = await page.$eval('h1', (el: Element) => el.textContent?.trim() || '').catch(() => '');
    if (h1) return h1;

    // Try og:title
    const ogTitle = await page.$eval('meta[property="og:title"]', (el: Element) => el.getAttribute('content') || '').catch(() => '');
    if (ogTitle) return ogTitle;

    // Fallback to document title
    return page.title();
  }

  private async extractMainContent(page: Page): Promise<string> {
    // Try common content selectors
    const selectors = [
      'main', 'article', '#content', '.content',
      '.job-description', '.posting-page', '.job-details',
      '[role="main"]',
    ];

    for (const sel of selectors) {
      const text = await page.$eval(sel, (el: Element) => el.textContent?.trim() || '').catch(() => '');
      if (text && text.length > 100) return text;
    }

    // Fallback: body text
    return page.$eval('body', (el: Element) => el.textContent?.trim() || '').catch(() => '');
  }

  private extractSalaryFromText(text: string): string | null {
    // Match salary patterns
    const patterns = [
      /\$[\d,]+\s*[-–]\s*\$[\d,]+/,
      /\$[\d,]+\s*(?:to|and)\s*\$[\d,]+/i,
      /(?:salary|compensation|pay)[\s:]*\$[\d,]+/i,
      /\$\d{2,3}[kK]\s*[-–]\s*\$\d{2,3}[kK]/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0];
    }
    return null;
  }

  private extractLocationFromPage(text: string): string | null {
    if (/\bremote\b/i.test(text)) return 'Remote';
    if (/\bhybrid\b/i.test(text)) return 'Hybrid';
    return null;
  }

  private detectLevelFromTitle(title: string): string | null {
    const lower = title.toLowerCase();
    if (/\bprincipal\b/.test(lower)) return 'principal';
    if (/\bstaff\b/.test(lower)) return 'staff';
    if (/\blead\b/.test(lower)) return 'lead';
    if (/\bsenior\b|\bsr\.?\b/.test(lower)) return 'senior';
    if (/\bjunior\b|\bjr\.?\b|\bentry[\s-]?level\b/.test(lower)) return 'junior';
    return null;
  }

  // ── Company-specific Playwright scrapers ─────────────────────────────

  private async scrapeApple(page: Page, companyId: string, careersUrl: string): Promise<ScrapeResult> {
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    try {
      // Apple's search page renders results via JavaScript
      // Navigate with search params for software engineer in Canada
      const searchUrl = careersUrl.includes('searchString')
        ? careersUrl
        : `${careersUrl}?searchString=software+engineer`;

      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      // Apple renders job cards with links to /en-us/details/{id}
      const jobs = await page.$$eval('a[href*="/details/"]', (anchors: HTMLAnchorElement[]) => {
        return anchors.map(a => {
          const title = a.querySelector('h3, .title, [class*="title"]')?.textContent?.trim()
            || a.textContent?.trim().split('\n')[0]?.trim() || '';
          const location = a.querySelector('.location, [class*="location"]')?.textContent?.trim() || '';
          return { href: a.href, title, location };
        }).filter(j => j.title && j.href);
      });

      for (const job of jobs.slice(0, 30)) {
        result.jobs.push({
          url: job.href,
          title: job.title,
          rawText: `${job.title}. Location: ${job.location}`,
          salary: null,
          location: job.location || null,
          level: this.detectLevelFromTitle(job.title),
        });
      }
    } catch (err) {
      result.errors.push(`Apple scrape error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  private async scrapeMicrosoft(page: Page, companyId: string, careersUrl: string): Promise<ScrapeResult> {
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    try {
      // Microsoft careers: search with Canada filter
      const searchUrl = `https://careers.microsoft.com/us/en/search-results?keywords=software%20engineer&country=Canada`;
      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);

      // Microsoft renders job cards in a list
      const jobs = await page.$$eval('[data-ph-at-id="jobs-list"] a, .jobs-list-item a, a[href*="/job/"]', (anchors: HTMLAnchorElement[]) => {
        return anchors.map(a => {
          const title = a.querySelector('h2, h3, .job-title, [class*="title"]')?.textContent?.trim()
            || a.textContent?.trim().split('\n')[0]?.trim() || '';
          const location = a.querySelector('.job-location, [class*="location"]')?.textContent?.trim() || '';
          return { href: a.href, title, location };
        }).filter(j => j.title && j.title.length > 5 && j.href.includes('/job/'));
      });

      for (const job of jobs.slice(0, 30)) {
        result.jobs.push({
          url: job.href,
          title: job.title,
          rawText: `${job.title}. Location: ${job.location}`,
          salary: null,
          location: job.location || null,
          level: this.detectLevelFromTitle(job.title),
        });
      }
    } catch (err) {
      result.errors.push(`Microsoft scrape error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  private async scrapeGoogle(page: Page, companyId: string, careersUrl: string): Promise<ScrapeResult> {
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    try {
      // Google careers: search for software engineer in Canada
      const searchUrl = 'https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada';
      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      // Google renders job cards as list items with links
      const jobs = await page.$$eval('a[href*="/jobs/results/"]', (anchors: HTMLAnchorElement[]) => {
        return anchors.map(a => {
          const title = a.querySelector('h3, [class*="title"]')?.textContent?.trim()
            || a.textContent?.trim().split('\n')[0]?.trim() || '';
          const location = a.querySelector('[class*="location"]')?.textContent?.trim() || '';
          return { href: a.href, title, location };
        }).filter(j => j.title && j.title.length > 5);
      });

      // Also try the newer Google Careers UI
      if (jobs.length === 0) {
        const altJobs = await page.$$eval('li[class*="job"] a, [data-job-id] a, .gc-card a', (anchors: HTMLAnchorElement[]) => {
          return anchors.map(a => ({
            href: a.href,
            title: a.textContent?.trim().split('\n')[0]?.trim() || '',
            location: '',
          })).filter(j => j.title && j.title.length > 5);
        });
        jobs.push(...altJobs);
      }

      for (const job of jobs.slice(0, 30)) {
        result.jobs.push({
          url: job.href,
          title: job.title,
          rawText: `${job.title}. Location: ${job.location || 'Canada'}`,
          salary: null,
          location: job.location || 'Canada',
          level: this.detectLevelFromTitle(job.title),
        });
      }
    } catch (err) {
      result.errors.push(`Google scrape error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async waitAndSettle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  private async delay(ms: number = 2000): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  resolveUrl(base: string, href: string): string {
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }

  static htmlToText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/?(p|div|br|h[1-6]|li|tr|section|article|header|footer)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x2F;/g, '/')
      .replace(/&#\d+;/g, '')
      .replace(/&\w+;/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();
  }
}
