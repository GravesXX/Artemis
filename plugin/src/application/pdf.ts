import { marked } from 'marked';
import { chromium, type Browser } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

const RESUMES_DIR = path.join(os.homedir(), '.artemis', 'resumes');

const RESUME_CSS = `
  body { font-family: 'Georgia', serif; font-size: 11pt; line-height: 1.4; margin: 0.75in; color: #333; }
  h1 { font-size: 18pt; margin-bottom: 4pt; color: #1a1a1a; }
  h2 { font-size: 13pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; margin-top: 14pt; color: #1a1a1a; }
  h3 { font-size: 11pt; margin-bottom: 2pt; }
  ul { margin: 4pt 0; padding-left: 18pt; }
  li { margin-bottom: 2pt; }
  p { margin: 4pt 0; }
  a { color: #333; text-decoration: none; }
`;

export async function generateResumePdf(
  markdown: string,
  applicationId: string,
  browser?: Browser
): Promise<string> {
  fs.mkdirSync(RESUMES_DIR, { recursive: true });

  const html = await marked.parse(markdown);
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${RESUME_CSS}</style></head>
<body>${html}</body></html>`;

  const outputPath = path.join(RESUMES_DIR, `${applicationId}.pdf`);
  const ownBrowser = !browser;

  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }

  const page = await browser.newPage();
  try {
    await page.setContent(fullHtml, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
  } finally {
    await page.close();
    if (ownBrowser) {
      await browser.close();
    }
  }

  return outputPath;
}
