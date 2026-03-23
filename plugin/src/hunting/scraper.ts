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
        case 'ibm':
          return this.scrapeIbm(page, companyId, careersUrl);
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
      const searchUrl = careersUrl.includes('searchString')
        ? careersUrl
        : `${careersUrl}?searchString=software+engineer`;

      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);

      // Apple's React SPA renders search results into the DOM.
      // Extract job data from the rendered table/list elements.
      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        // Apple renders job results as table rows or list items with links to /details/{id}
        document.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href') ?? '';
          if (!href.includes('/details/') && !href.includes('/search/')) return;
          if (href.includes('/details/')) {
            // Find the closest parent that contains title and location info
            const row = a.closest('tr, li, [class*="result"], [class*="card"], [class*="row"]') ?? a;
            const texts = (row.textContent ?? '').split('\n').map(t => t.trim()).filter(t => t.length > 3);
            if (texts.length > 0) {
              results.push({
                title: texts[0],
                url: href.startsWith('http') ? href : `https://jobs.apple.com${href}`,
                location: texts.find(t => t.includes(',') || t.toLowerCase().includes('remote') || t.toLowerCase().includes('canada')) ?? '',
              });
            }
          }
        });

        // Fallback: look for structured data or __NEXT_DATA__
        if (results.length === 0) {
          const scripts = document.querySelectorAll('script');
          for (const script of scripts) {
            const text = script.textContent ?? '';
            if (text.includes('searchResults') || text.includes('postingTitle')) {
              try {
                // Try to find job objects in embedded JSON
                const matches = text.matchAll(/"postingTitle"\s*:\s*"([^"]+)"/g);
                for (const match of matches) {
                  results.push({ title: match[1], url: '', location: '' });
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
            url: job.url || `https://jobs.apple.com/en-us/search?searchString=${encodeURIComponent(job.title)}`,
            title: job.title,
            rawText: `${job.title}. Location: ${job.location}`,
            salary: null,
            location: job.location || null,
            level: this.detectLevelFromTitle(job.title),
          });
        }
      }
    } catch (err) {
      result.errors.push(`Apple scrape error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }

  private async scrapeMicrosoft(page: Page, companyId: string, careersUrl: string): Promise<ScrapeResult> {
    const result: ScrapeResult = { companyId, careersUrl, jobs: [], errors: [] };

    try {
      // Microsoft's career page uses Phenom People SPA. Use the jobs.careers.microsoft.com domain instead.
      const searchUrl = 'https://jobs.careers.microsoft.com/global/en/search?q=software%20engineer&lc=Canada&l=en_us&pg=1&pgSz=20&o=Relevance&flt=true';
      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(8000);

      // Extract job cards from the rendered page
      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        // Microsoft renders job cards with various possible selectors
        const cards = document.querySelectorAll('[class*="job-card"], [class*="JobCard"], [data-ph-at-id], li[class*="jobs"]');
        for (const card of cards) {
          const linkEl = card.querySelector('a[href*="/job/"]') as HTMLAnchorElement | null;
          const titleEl = card.querySelector('h2, h3, [class*="title"]');
          const locEl = card.querySelector('[class*="location"], [class*="Location"]');

          if (titleEl) {
            results.push({
              title: titleEl.textContent?.trim() ?? '',
              url: linkEl?.href ?? '',
              location: locEl?.textContent?.trim() ?? '',
            });
          }
        }

        // Fallback: any link with /job/ in href
        if (results.length === 0) {
          document.querySelectorAll('a[href*="/job/"]').forEach(a => {
            const text = (a.textContent ?? '').trim();
            if (text.length > 5 && text.length < 200) {
              results.push({
                title: text.split('\n')[0].trim(),
                url: (a as HTMLAnchorElement).href,
                location: '',
              });
            }
          });
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
      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);

      // Google embeds job data in the server-rendered HTML via AF_initDataCallback.
      // The page body is 1.2MB with embedded job data. Extract from the DOM.
      const jobs = await page.evaluate(() => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        // Google renders job listings as clickable elements with role/title info
        // Look for elements that contain job titles (typically h3 or specific class names)
        const allElements = document.querySelectorAll('h3, [class*="card"] h3, li h3');
        for (const el of allElements) {
          const text = el.textContent?.trim() ?? '';
          // Filter for actual job titles (not navigation items)
          if (text.length > 10 && text.length < 150 &&
              (text.toLowerCase().includes('engineer') || text.toLowerCase().includes('developer') ||
               text.toLowerCase().includes('software') || text.toLowerCase().includes('sre'))) {
            // Find the closest link
            const parent = el.closest('a, [role="link"], li') as HTMLElement | null;
            const link = parent?.querySelector('a') as HTMLAnchorElement | null;
            const href = link?.href ?? parent?.getAttribute('data-href') ?? '';

            // Find location text near the title
            const container = el.closest('li, [class*="card"], [class*="result"]') ?? el.parentElement;
            const locationEl = container?.querySelector('[class*="location"], span + span');
            const location = locationEl?.textContent?.trim() ?? '';

            results.push({ title: text, url: href, location });
          }
        }

        // Fallback: extract from the page source via embedded data
        if (results.length === 0) {
          const html = document.documentElement.innerHTML;
          // Google's AF_initDataCallback contains job data as nested arrays
          // The analytics already showed jobs exist — try to extract from text content
          const bodyText = document.body.textContent ?? '';
          const jobPattern = /((?:Senior |Junior |Staff |Lead )?(?:Software|Backend|Frontend|Full.?Stack|Platform|Infrastructure|Systems|Site Reliability|DevOps)[\s\w,/]*(?:Engineer|Developer|SWE|SDE)[\w\s,]*)/g;
          let match;
          const seen = new Set();
          while ((match = jobPattern.exec(bodyText)) !== null) {
            const title = match[1].trim();
            if (title.length > 10 && title.length < 120 && !seen.has(title)) {
              seen.add(title);
              results.push({ title, url: '', location: 'Canada' });
            }
          }
        }

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
      const searchUrl = 'https://www.ibm.com/careers/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada';
      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(8000);

      // IBM's search component makes a POST to www-api.ibm.com/search/api/v2
      // We intercept the response by making the call from the page context (with its cookies)
      const jobs = await page.evaluate(async () => {
        const results: Array<{ title: string; url: string; location: string }> = [];

        try {
          const response = await fetch('https://www-api.ibm.com/search/api/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              lang: 'en',
              query: 'Software Engineer',
              filters: {
                field_keyword_05: ['Canada'],
                field_keyword_18: ['Software Engineering'],
              },
              limit: 30,
              offset: 0,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const hits = (data as any)?.results ?? (data as any)?.hits ?? [];
            for (const hit of hits) {
              results.push({
                title: hit.title ?? hit.name ?? '',
                url: hit.url ?? hit.link ?? '',
                location: hit.location ?? hit.field_keyword_05?.[0] ?? '',
              });
            }
          }
        } catch {}

        // Fallback: extract from the rendered DOM
        if (results.length === 0) {
          const cards = document.querySelectorAll('[class*="job-card"], [class*="search-result"], [class*="bx--card"], a[href*="/job/"]');
          for (const card of cards) {
            const titleEl = card.querySelector('h3, h4, [class*="title"]');
            const linkEl = card.querySelector('a[href*="/job/"]') as HTMLAnchorElement | null;
            const locEl = card.querySelector('[class*="location"]');
            if (titleEl) {
              results.push({
                title: titleEl.textContent?.trim() ?? '',
                url: linkEl?.href ?? '',
                location: locEl?.textContent?.trim() ?? '',
              });
            }
          }
        }

        // Last fallback: scan all links for job-like patterns
        if (results.length === 0) {
          document.querySelectorAll('a[href]').forEach(a => {
            const href = (a as HTMLAnchorElement).href;
            const text = (a.textContent ?? '').trim();
            if ((href.includes('/job/') || href.includes('/position/')) && text.length > 10 && text.length < 150) {
              results.push({ title: text.split('\n')[0].trim(), url: href, location: 'Canada' });
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
