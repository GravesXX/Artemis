import { chromium } from '../plugin/node_modules/playwright';

// Intercept XHR/fetch calls to find the actual job data APIs

const targets = [
  {
    name: 'Apple',
    url: 'https://jobs.apple.com/en-us/search?searchString=software+engineer&location=canada-CNDA',
    apiPattern: /api|search|job/i,
  },
  {
    name: 'Google',
    url: 'https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada',
    apiPattern: /batchexecute|jobs|search/i,
  },
  {
    name: 'IBM',
    url: 'https://www.ibm.com/careers/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada',
    apiPattern: /api|search|job/i,
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const target of targets) {
    console.log(`\n=== ${target.name} ===`);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const apiCalls: Array<{ url: string; method: string; responseSize: number; contentType: string }> = [];

    // Intercept all network requests
    page.on('response', async (response) => {
      const url = response.url();
      if (target.apiPattern.test(url) && !url.includes('analytics') && !url.includes('google-analytics') && !url.includes('googlesyndication') && !url.includes('googletagmanager')) {
        try {
          const body = await response.body().catch(() => Buffer.from(''));
          const contentType = response.headers()['content-type'] ?? '';
          apiCalls.push({
            url: url.slice(0, 200),
            method: response.request().method(),
            responseSize: body.length,
            contentType: contentType.slice(0, 50),
          });
        } catch {}
      }
    });

    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(5000);

      console.log(`API calls intercepted: ${apiCalls.length}`);
      for (const call of apiCalls) {
        console.log(`  [${call.method}] ${call.url}`);
        console.log(`    Content-Type: ${call.contentType} | Size: ${call.responseSize} bytes`);
      }

      // For calls that returned JSON, try to peek at the structure
      for (const call of apiCalls.filter(c => c.contentType.includes('json') && c.responseSize > 100)) {
        try {
          const resp = await page.evaluate(async (url) => {
            const r = await fetch(url);
            const text = await r.text();
            return text.slice(0, 500);
          }, call.url);
          console.log(`  Preview: ${resp.slice(0, 300)}`);
        } catch {}
      }
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    await context.close();
  }

  await browser.close();
})();
