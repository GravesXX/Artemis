import { chromium } from '../plugin/node_modules/playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('Navigating to Google Careers...');
  try {
    await page.goto('https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(5000);
    console.log('Title:', await page.title());

    const h3s = await page.evaluate(() => {
      const results: string[] = [];
      document.querySelectorAll('h3').forEach(el => {
        const text = el.textContent?.trim() ?? '';
        if (text.length > 10 && text.length < 150) results.push(text);
      });
      return results;
    });
    console.log(`H3 elements: ${h3s.length}`);
    for (const h of h3s.slice(0, 10)) console.log(`  - ${h}`);
  } catch (err) {
    console.log('Error:', (err as Error).message.slice(0, 200));
  }

  console.log('\nNavigating to Apple Jobs...');
  const page2 = await context.newPage();
  try {
    await page2.goto('https://jobs.apple.com/en-us/search?searchString=software+engineer+canada', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page2.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page2.waitForTimeout(8000);
    console.log('Title:', await page2.title());

    const links = await page2.evaluate(() => {
      const results: string[] = [];
      document.querySelectorAll('a[href*="/details/"]').forEach(a => {
        const text = a.textContent?.trim().split('\n')[0]?.trim() ?? '';
        if (text.length > 5) results.push(text);
      });
      return results;
    });
    console.log(`Detail links: ${links.length}`);
    for (const l of links.slice(0, 10)) console.log(`  - ${l}`);
  } catch (err) {
    console.log('Error:', (err as Error).message.slice(0, 200));
  }

  await context.close();
  await browser.close();
})();
