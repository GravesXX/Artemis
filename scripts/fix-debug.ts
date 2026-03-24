import { chromium } from '../plugin/node_modules/playwright';
import fs from 'fs';

const OUT = '/tmp/artemis-debug';

(async () => {
  const browser = await chromium.launch({ headless: true });

  // === FIX 1: Apple — find correct location codes ===
  console.log('=== APPLE: Testing location codes ===');
  const appleCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  const applePage = await appleCtx.newPage();

  // Try without location filter first
  await applePage.goto('https://jobs.apple.com/en-us/search?searchString=software+engineer', { waitUntil: 'networkidle' });
  await applePage.waitForTimeout(5000);
  let appleCount = await applePage.evaluate(() => {
    return document.querySelectorAll('a[href*="/details/"], [class*="table-row"], tr[class*="result"]').length;
  });
  console.log(`  No location filter: ${appleCount} result elements`);

  // Check what the page uses for results
  const appleStructure = await applePage.evaluate(() => {
    // Look for the main results area
    const main = document.querySelector('#main, main, [role="main"], .main');
    if (!main) return 'no main element found';

    // Find any table or list structure
    const tables = document.querySelectorAll('table');
    const lists = document.querySelectorAll('ul, ol');
    const tbody = document.querySelector('tbody');

    let info = `tables: ${tables.length}, lists: ${lists.length}, tbody: ${tbody ? 'yes' : 'no'}`;

    if (tbody) {
      const rows = tbody.querySelectorAll('tr');
      info += `, tbody rows: ${rows.length}`;
      if (rows.length > 0) {
        const firstRow = rows[0];
        info += `, first row HTML: ${firstRow.innerHTML.slice(0, 300)}`;
      }
    }

    // Look for any element with "result" in class
    const resultEls = document.querySelectorAll('[class*="result"], [class*="Result"], [class*="posting"], [class*="Posting"]');
    info += `, result-class elements: ${resultEls.length}`;

    return info;
  });
  console.log(`  Structure: ${appleStructure}`);

  // Screenshot without filter
  await applePage.screenshot({ path: `${OUT}/apple-nofilter.png`, fullPage: false });
  console.log(`  Screenshot: apple-nofilter.png`);
  await appleCtx.close();

  // === FIX 2: Microsoft — find the right URL ===
  console.log('\n=== MICROSOFT: Testing URLs ===');
  const msCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  const msPage = await msCtx.newPage();

  // Try the direct jobs domain
  const msUrls = [
    'https://jobs.careers.microsoft.com/global/en/search?q=software+engineer&lc=Canada',
    'https://careers.microsoft.com/v2/global/en/search?q=software+engineer&lc=Canada',
    'https://careers.microsoft.com/us/en/search-results?keywords=software+engineer&country=Canada',
  ];

  for (const msUrl of msUrls) {
    console.log(`  Trying: ${msUrl.slice(0, 80)}...`);
    try {
      await msPage.goto(msUrl, { waitUntil: 'networkidle', timeout: 15000 });
      await msPage.waitForTimeout(5000);
      const title = await msPage.title();
      const finalUrl = msPage.url();
      const jobElements = await msPage.evaluate(() => {
        const els = document.querySelectorAll('[class*="job"], [class*="Job"], a[href*="/job/"], [data-ph-at-id]');
        return els.length;
      });
      console.log(`    Title: ${title} | Final URL: ${finalUrl.slice(0, 80)} | Job elements: ${jobElements}`);
    } catch (err) {
      console.log(`    Failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  await msCtx.close();

  // === FIX 3: IBM — dismiss popup and extract ===
  console.log('\n=== IBM: Dismiss popup and extract ===');
  const ibmCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  const ibmPage = await ibmCtx.newPage();

  // Set locale cookie to skip the popup
  await ibmCtx.addCookies([
    { name: 'defined_locale', value: 'en', domain: '.ibm.com', path: '/' },
    { name: 'defined_cc', value: 'CA', domain: '.ibm.com', path: '/' },
  ]);

  await ibmPage.goto('https://www.ibm.com/careers/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada', {
    waitUntil: 'networkidle',
  });
  await ibmPage.waitForTimeout(3000);

  // Try to dismiss any popups
  const popupDismissed = await ibmPage.evaluate(() => {
    // Click any close/dismiss/accept buttons
    const buttons = document.querySelectorAll('button, a');
    for (const btn of buttons) {
      const text = (btn.textContent ?? '').toLowerCase();
      if (text.includes('accept') || text.includes('annuler') || text.includes('close') || text.includes('dismiss')) {
        (btn as HTMLElement).click();
        return `clicked: ${text.trim().slice(0, 30)}`;
      }
    }
    return 'no popup button found';
  });
  console.log(`  Popup: ${popupDismissed}`);
  await ibmPage.waitForTimeout(5000);

  // Now check for job content
  const ibmJobs = await ibmPage.evaluate(() => {
    const results: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim();
      if (text.length > 15 && text.length < 150 && /engineer|developer|software/i.test(text) &&
          !/cookie|privacy|navigation/i.test(text)) {
        const parent = node.parentElement;
        const tag = parent?.tagName ?? '?';
        results.push(`[${tag}] ${text}`);
      }
    }
    return results;
  });
  console.log(`  Job text nodes after dismiss: ${ibmJobs.length}`);
  for (const j of ibmJobs.slice(0, 10)) console.log(`    ${j}`);

  await ibmPage.screenshot({ path: `${OUT}/ibm-after-dismiss.png` });
  console.log(`  Screenshot: ibm-after-dismiss.png`);

  // Try IBM's search API from within the page context
  const ibmApiResult = await ibmPage.evaluate(async () => {
    try {
      // The embedded search component makes calls to this API
      const resp = await fetch('/careers/rest/v2/jobs/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada&rows=10');
      if (resp.ok) return { status: resp.status, body: (await resp.text()).slice(0, 1000) };

      // Try alternate endpoints
      const resp2 = await fetch('https://www.ibm.com/careers/rest/v2/jobs/search?field_keyword_18[0]=Software%20Engineering&field_keyword_05[0]=Canada&rows=10');
      if (resp2.ok) return { status: resp2.status, body: (await resp2.text()).slice(0, 1000) };

      // Try the search API v2
      const resp3 = await fetch('https://www-api.ibm.com/search/api/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Software Engineer Canada', lang: 'en', limit: 10, offset: 0, source: 'careers' }),
      });
      return { status: resp3.status, body: (await resp3.text()).slice(0, 1000) };
    } catch (err) {
      return { status: 0, body: String(err) };
    }
  });
  console.log(`  IBM API from page context: status=${ibmApiResult.status}`);
  console.log(`  Body: ${ibmApiResult.body.slice(0, 300)}`);

  await ibmCtx.close();
  await browser.close();
})();
