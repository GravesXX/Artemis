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

type Platform = 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'apple' | 'microsoft' | 'google' | 'ibm' | 'generic';

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
      const platform = this.detectPlatform(careersUrl);

      // Company-specific scrapers need a fresh page (no prior navigation)
      if (['apple', 'microsoft', 'google', 'ibm'].includes(platform)) {
        const freshPage = await context.newPage();
        freshPage.setDefaultTimeout(30000);
        try {
          switch (platform) {
            case 'apple':
              return await this.scrapeApple(freshPage, companyId, careersUrl);
            case 'microsoft':
              return await this.scrapeMicrosoft(freshPage, companyId, careersUrl);
            case 'google':
              return await this.scrapeGoogle(freshPage, companyId, careersUrl);
            case 'ibm':
              return await this.scrapeIbm(freshPage, companyId, careersUrl);
          }
        } finally {
          await freshPage.close();
        }
      }

      // Standard platforms: navigate first, then discover links
      await page.goto(careersUrl, { waitUntil: 'domcontentloaded' });
      await this.waitAndSettle(page);

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
    if (lower.includes('careers.microsoft.com') || lower.includes('jobs.careers.microsoft.com')) return 'microsoft';
    if (lower.includes('careers.google.com') || lower.includes('google.com/about/careers')) return 'google';
    if (lower.includes('ibm.com/careers')) return 'ibm' as Platform;
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
      // Search for "software engineer canada" — the location URL param doesn't work
      await page.goto('https://jobs.apple.com/en-us/search?searchString=software+engineer+canada', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(8000);  // Apple's React app needs extra time to render results

      // Apple renders job cards as links with title text + location in sibling elements
      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string; team: string }> = [];

        // Each result is a link (a tag) to /en-us/details/{id}/{slug}
        document.querySelectorAll('a[href*="/details/"]').forEach(a => {
          const href = (a as HTMLAnchorElement).href;
          // The link's parent/container has the title and metadata
          const container = a.closest('li, tr, [class*="result"], [class*="row"]') ?? a.parentElement ?? a;
          const textParts = (container.textContent ?? '').split('\n').map(t => t.trim()).filter(t => t.length > 2);

          // Typically: [title, team, location, date]
          const title = textParts[0] ?? '';
          const team = textParts[1] ?? '';
          const location = textParts.find(t =>
            /canada|ontario|toronto|remote|waterloo|ottawa|vancouver/i.test(t)
          ) ?? textParts[2] ?? '';

          if (title.length > 5) {
            results.push({ title, url: href, location, team });
          }
        });

        return results;
      });

      for (const job of jobs.slice(0, 30)) {
        result.jobs.push({
          url: job.url,
          title: job.title,
          rawText: `${job.title}. Team: ${job.team}. Location: ${job.location}`,
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
      // Microsoft's site is slow — use domcontentloaded instead of networkidle, increase timeout
      const searchUrl = 'https://jobs.careers.microsoft.com/global/en/search?q=software+engineer&lc=Canada&l=en_us&pg=1&pgSz=20&o=Relevance&flt=true';
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Wait for the SPA to render job cards
      await page.waitForSelector('[class*="ms-List-cell"], [class*="job"], a[href*="/job/"]', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);

      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        // Try multiple selector strategies
        // Strategy 1: Phenom job cards
        document.querySelectorAll('[class*="ms-List-cell"], [class*="job-card"], [class*="JobCard"]').forEach(card => {
          const titleEl = card.querySelector('h2, h3, [class*="title"], [class*="Title"]');
          const linkEl = card.querySelector('a[href*="/job/"]') as HTMLAnchorElement | null;
          const locEl = card.querySelector('[class*="location"], [class*="Location"]');
          if (titleEl) {
            results.push({
              title: titleEl.textContent?.trim() ?? '',
              url: linkEl?.href ?? '',
              location: locEl?.textContent?.trim() ?? '',
            });
          }
        });

        // Strategy 2: any link with /job/ that has meaningful text
        if (results.length === 0) {
          document.querySelectorAll('a[href*="/job/"]').forEach(a => {
            const text = (a.textContent ?? '').trim();
            if (text.length > 10 && text.length < 200) {
              results.push({
                title: text.split('\n')[0].trim(),
                url: (a as HTMLAnchorElement).href,
                location: '',
              });
            }
          });
        }

        // Strategy 3: look for embedded JSON data
        if (results.length === 0) {
          const scripts = document.querySelectorAll('script');
          for (const script of scripts) {
            const text = script.textContent ?? '';
            if (text.includes('"jobs"') && text.includes('"title"')) {
              try {
                const match = text.match(/"jobs"\s*:\s*(\[[\s\S]*?\])/);
                if (match) {
                  const jobs = JSON.parse(match[1]);
                  for (const j of jobs) {
                    results.push({
                      title: j.title ?? '',
                      url: j.url ?? j.applyUrl ?? '',
                      location: j.location ?? j.primaryLocation ?? '',
                    });
                  }
                }
              } catch {}
            }
          }
        }

        return results;
      });

      for (const job of jobs.slice(0, 30)) {
        if (job.title) {
          result.jobs.push({
            url: job.url || `https://jobs.careers.microsoft.com/global/en/search?q=${encodeURIComponent(job.title)}`,
            title: job.title,
            rawText: `${job.title}. Location: ${job.location}`,
            salary: null,
            location: job.location || null,
            level: this.detectLevelFromTitle(job.title),
          });
        }
      }
    } catch (err) {
      result.errors.push(`Microsoft scrape error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  private async scrapeGoogle(page: Page, companyId: string, careersUrl: string): Promise<ScrapeResult> {
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    try {
      const searchUrl = 'https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada';
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(5000);

      // Google renders job cards with h3.QJPWVe for titles (confirmed via debug)
      // Each job is in a list item with title, location, and link
      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        // Primary strategy: h3 elements with the known class
        document.querySelectorAll('h3').forEach(h3 => {
          const text = h3.textContent?.trim() ?? '';
          if (text.length < 10 || text.length > 150) return;
          // Skip navigation headers
          if (/^(about|careers|locations|teams|students|blog|how we hire)/i.test(text)) return;

          // Find the parent list item or card
          const card = h3.closest('li, [role="listitem"], [class*="card"]') ?? h3.parentElement;
          if (!card) return;

          // Find the link — Google wraps each job card in a clickable element
          const link = card.querySelector('a') as HTMLAnchorElement | null;
          const href = link?.href ?? '';

          // Find location — typically a span after the title
          const spans = card.querySelectorAll('span');
          let location = '';
          for (const span of spans) {
            const spanText = span.textContent?.trim() ?? '';
            if (spanText.includes(',') && spanText.length < 80 && spanText !== text) {
              location = spanText;
              break;
            }
          }

          results.push({ title: text, url: href, location });
        });

        return results;
      });

      for (const job of jobs.slice(0, 30)) {
        if (job.title) {
          result.jobs.push({
            url: job.url || `https://www.google.com/about/careers/applications/jobs/results?q=${encodeURIComponent(job.title)}&location=Canada`,
            title: job.title,
            rawText: `${job.title}. Location: ${job.location || 'Canada'}`,
            salary: null,
            location: job.location || 'Canada',
            level: this.detectLevelFromTitle(job.title),
          });
        }
      }
    } catch (err) {
      result.errors.push(`Google scrape error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  private async scrapeIbm(page: Page, companyId: string, careersUrl: string): Promise<ScrapeResult> {
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    try {
      // Set cookies to skip the locale popup
      const context = page.context();
      await context.addCookies([
        { name: 'defined_locale', value: 'en', domain: '.ibm.com', path: '/' },
        { name: 'defined_cc', value: 'CA', domain: '.ibm.com', path: '/' },
      ]);

      const searchUrl = 'https://www.ibm.com/careers/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada';
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      // Dismiss any remaining popups (cookie consent, locale)
      await page.evaluate(() => {
        document.querySelectorAll('button, a').forEach(el => {
          const text = (el.textContent ?? '').toLowerCase().trim();
          if (text === 'accept' || text === 'accept all' || text === 'close' || text === 'annuler' || text === 'dismiss') {
            (el as HTMLElement).click();
          }
        });
      });
      await page.waitForTimeout(5000);

      // Wait for the embedded search component to load results
      await page.waitForSelector('[class*="search-result"], [class*="result-item"], a[href*="/job/"]', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        // IBM renders search results in its embedded search component
        // Look for any links or cards with job-like content
        document.querySelectorAll('a[href]').forEach(a => {
          const href = (a as HTMLAnchorElement).href;
          const text = (a.textContent ?? '').trim();
          // IBM job URLs contain /job/ or have specific patterns
          if (text.length > 10 && text.length < 150 &&
              (href.includes('/job/') || href.includes('/position/') || href.includes('/careers/') && href !== window.location.href) &&
              /engineer|developer|software|devops|sre|architect/i.test(text)) {
            const container = a.closest('li, [class*="result"], [class*="card"]') ?? a.parentElement;
            const locEl = container?.querySelector('[class*="location"]');
            results.push({
              title: text.split('\n')[0].trim(),
              url: href,
              location: locEl?.textContent?.trim() ?? '',
            });
          }
        });

        // Fallback: find any text that looks like a job title in the results area
        if (results.length === 0) {
          const mainContent = document.querySelector('main, [role="main"], #content, .content') ?? document.body;
          mainContent.querySelectorAll('h3, h4, [class*="title"]').forEach(el => {
            const text = el.textContent?.trim() ?? '';
            if (text.length > 10 && text.length < 150 && /engineer|developer|software/i.test(text)) {
              const link = el.closest('a') as HTMLAnchorElement | null ?? el.querySelector('a') as HTMLAnchorElement | null;
              results.push({
                title: text,
                url: link?.href ?? '',
                location: 'Canada',
              });
            }
          });
        }

        return results;
      });

      for (const job of jobs.slice(0, 30)) {
        if (job.title) {
          result.jobs.push({
            url: job.url || `https://www.ibm.com/careers/search?q=${encodeURIComponent(job.title)}`,
            title: job.title,
            rawText: `${job.title}. Location: ${job.location || 'Canada'}`,
            salary: null,
            location: job.location || null,
            level: this.detectLevelFromTitle(job.title),
          });
        }
      }
    } catch (err) {
      result.errors.push(`IBM scrape error: ${err instanceof Error ? err.message : String(err)}`);
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
