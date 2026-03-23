import { chromium } from '../plugin/node_modules/playwright';

// Debug the 4 companies that return 0 jobs
// Goal: understand what their pages look like to the scraper

const failing = [
  {
    name: 'Apple',
    url: 'https://jobs.apple.com/en-us/search?searchString=software+engineer&location=canada-CNDA',
  },
  {
    name: 'Google',
    url: 'https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada',
  },
  {
    name: 'Microsoft',
    url: 'https://careers.microsoft.com/us/en/search-results?keywords=software%20engineer&country=Canada',
  },
  {
    name: 'IBM',
    url: 'https://www.ibm.com/careers/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada',
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const { name, url } of failing) {
    console.log(`\n=== ${name} ===`);
    console.log(`URL: ${url}`);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(5000); // extra wait for SPA rendering

      // Check page title
      const title = await page.title();
      console.log(`Page title: ${title}`);

      // Count all links
      const allLinks = await page.$$eval('a[href]', (as: HTMLAnchorElement[]) => as.length);
      console.log(`Total links on page: ${allLinks}`);

      // Find job-like links
      const jobLinks = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) => {
        return anchors
          .map(a => ({ href: a.href, text: (a.textContent ?? '').trim().slice(0, 80) }))
          .filter(l => l.text.length > 10)
          .filter(l => {
            const h = l.href.toLowerCase();
            const t = l.text.toLowerCase();
            return h.includes('/job') || h.includes('/detail') || h.includes('/position') ||
                   t.includes('engineer') || t.includes('developer') || t.includes('software');
          })
          .slice(0, 10);
      });

      console.log(`Job-like links found: ${jobLinks.length}`);
      for (const l of jobLinks) {
        console.log(`  "${l.text}" -> ${l.href}`);
      }

      // Check for XHR/API calls the page made (via performance entries)
      const apiCalls = await page.evaluate(() => {
        return performance.getEntriesByType('resource')
          .filter((e: any) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
          .map((e: any) => e.name)
          .filter((url: string) => url.includes('api') || url.includes('search') || url.includes('job'))
          .slice(0, 10);
      });

      if (apiCalls.length > 0) {
        console.log(`API calls detected:`);
        for (const call of apiCalls) {
          console.log(`  ${call}`);
        }
      }

      // Check page text content length
      const bodyLength = await page.$eval('body', (b: Element) => (b.textContent ?? '').length);
      console.log(`Body text length: ${bodyLength} chars`);

    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    await context.close();
  }

  await browser.close();
  console.log('\nDone.');
})();
