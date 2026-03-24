import { chromium } from '../plugin/node_modules/playwright';
import fs from 'fs';
import path from 'path';

const OUT_DIR = '/tmp/artemis-debug';
fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  {
    name: 'apple',
    url: 'https://jobs.apple.com/en-us/search?searchString=software+engineer&location=canada-CNDA',
  },
  {
    name: 'google',
    url: 'https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada',
  },
  {
    name: 'microsoft',
    url: 'https://jobs.careers.microsoft.com/global/en/search?q=software%20engineer&lc=Canada&l=en_us&pg=1&pgSz=20&o=Relevance&flt=true',
  },
  {
    name: 'ibm',
    url: 'https://www.ibm.com/careers/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada',
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const { name, url } of targets) {
    console.log(`\n========== ${name.toUpperCase()} ==========`);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // Capture all XHR/fetch requests and responses
    const apiCalls: Array<{ url: string; method: string; status: number; body: string }> = [];
    page.on('response', async (response) => {
      const reqUrl = response.url();
      const ct = response.headers()['content-type'] ?? '';
      if ((ct.includes('json') || ct.includes('text/html')) &&
          !reqUrl.includes('analytics') && !reqUrl.includes('googletagmanager') &&
          !reqUrl.includes('googlesyndication') && !reqUrl.includes('.css') &&
          !reqUrl.includes('.svg') && !reqUrl.includes('.png') &&
          response.request().resourceType() !== 'stylesheet') {
        try {
          const body = await response.text().catch(() => '');
          if (body.length > 500 && (body.includes('engineer') || body.includes('Engineer') || body.includes('job') || body.includes('position'))) {
            apiCalls.push({
              url: reqUrl.slice(0, 200),
              method: response.request().method(),
              status: response.status(),
              body: body.slice(0, 2000),
            });
          }
        } catch {}
      }
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(8000);

      // Screenshot
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
      console.log(`Screenshot saved: ${OUT_DIR}/${name}.png`);

      // Save relevant API responses
      if (apiCalls.length > 0) {
        console.log(`\nAPI calls with job data: ${apiCalls.length}`);
        for (let i = 0; i < apiCalls.length; i++) {
          const call = apiCalls[i];
          console.log(`  [${call.method}] ${call.url} (${call.status})`);
          fs.writeFileSync(path.join(OUT_DIR, `${name}-api-${i}.txt`), call.body);
          console.log(`  Body saved: ${name}-api-${i}.txt (${call.body.length} chars)`);
        }
      }

      // Extract ALL visible text that looks like job titles
      const jobTitles = await page.evaluate(() => {
        const titles: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const text = (node.textContent ?? '').trim();
          if (text.length > 15 && text.length < 150 &&
              /engineer|developer|software|swe|sde/i.test(text) &&
              !/cookie|privacy|terms|navigation|menu|footer/i.test(text)) {
            // Get the parent element info
            const parent = node.parentElement;
            const tag = parent?.tagName ?? '?';
            const cls = (parent?.className ?? '').toString().slice(0, 60);
            const href = parent?.closest('a')?.getAttribute('href') ?? '';
            titles.push(`[${tag}.${cls}] ${text}${href ? ` -> ${href}` : ''}`);
          }
        }
        return titles;
      });

      console.log(`\nJob-like text nodes found: ${jobTitles.length}`);
      for (const t of jobTitles.slice(0, 20)) {
        console.log(`  ${t}`);
      }

    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    await context.close();
  }

  await browser.close();
})();
