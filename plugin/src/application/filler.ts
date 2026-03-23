import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Credential } from '../db/database.js';
import { decrypt } from './crypto.js';
import { generateResumePdf } from './pdf.js';
import { Screenshotter } from './screenshotter.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ApplicationData {
  applicationId: string;
  applyUrl: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedIn?: string;
  website?: string;
  resumeMarkdown: string;
  coverLetterText: string;
  jobDescription: string;
  companyName: string;
  visaSponsorship?: string;
  howDidYouHear?: string;
}

export interface CustomQuestion {
  selector: string;
  questionText: string;
  currentValue: string;
}

export interface FillResult {
  success: boolean;
  platform: ATSPlatform;
  resumePdfPath: string;
  customQuestions: CustomQuestion[];
  filledFields: string[];
  errors: string[];
}

export type ATSPlatform = 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'generic';

// ── ATSHandler Interface ────────────────────────────────────────────────────

interface ATSHandler {
  platform: ATSPlatform;
  detect(url: string): boolean;
  fillForm(page: Page, data: ApplicationData, resumePdfPath: string): Promise<{ filledFields: string[]; errors: string[] }>;
  findCustomQuestions(page: Page): Promise<CustomQuestion[]>;
  getSubmitSelector(): string;
}

// ── FormFiller ──────────────────────────────────────────────────────────────

export class FormFiller {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screenshotter: Screenshotter;
  private handlers: ATSHandler[];
  private activeHandler: ATSHandler | null = null;

  constructor() {
    this.screenshotter = new Screenshotter();
    this.handlers = [
      new GreenhouseHandler(),
      new LeverHandler(),
      new WorkdayHandler(),
      new AshbyHandler(),
      new GenericHandler(),
    ];
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: false });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
  }

  async fill(data: ApplicationData, credential?: Credential): Promise<FillResult> {
    if (!this.page || !this.browser) {
      await this.init();
    }

    const handler = this.detectHandler(data.applyUrl);
    this.activeHandler = handler;

    // Generate resume PDF
    const resumePdfPath = await generateResumePdf(data.resumeMarkdown, data.applicationId, this.browser!);

    // Navigate to application page
    await this.page!.goto(data.applyUrl, { waitUntil: 'domcontentloaded' });
    await this.page!.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await this.page!.waitForTimeout(2000);

    // Handle login if credential provided
    if (credential) {
      await this.handleLogin(handler, credential);
    }

    // Fill the form
    const { filledFields, errors } = await handler.fillForm(this.page!, data, resumePdfPath);

    // Find custom questions
    const customQuestions = await handler.findCustomQuestions(this.page!);

    return {
      success: errors.length === 0,
      platform: handler.platform,
      resumePdfPath,
      customQuestions,
      filledFields,
      errors,
    };
  }

  async fillCustomAnswers(answers: Array<{ selector: string; answer: string }>): Promise<void> {
    if (!this.page) return;
    for (const { selector, answer } of answers) {
      try {
        await this.page.fill(selector, answer);
      } catch {
        // Selector may not exist; skip silently
      }
    }
  }

  async screenshot(applicationId: string): Promise<string> {
    if (!this.page) throw new Error('No active browser session');
    return this.screenshotter.capture(this.page, applicationId);
  }

  async submit(): Promise<void> {
    if (!this.page || !this.activeHandler) throw new Error('No active browser session');
    const selector = this.activeHandler.getSubmitSelector();
    await this.page.click(selector);
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.page = null;
    this.activeHandler = null;
  }

  isActive(): boolean {
    return this.browser !== null && this.page !== null;
  }

  private detectHandler(url: string): ATSHandler {
    for (const handler of this.handlers) {
      if (handler.detect(url)) return handler;
    }
    return this.handlers[this.handlers.length - 1]; // GenericHandler
  }

  private async handleLogin(handler: ATSHandler, credential: Credential): Promise<void> {
    if (!this.page) return;
    const password = decrypt(credential.encrypted_password);

    // Check if there's a login form on the page
    const emailInput = await this.page.$('input[type="email"], input[name="email"], input[id="email"]');
    if (emailInput) {
      await emailInput.fill(credential.email);
      const passwordInput = await this.page.$('input[type="password"]');
      if (passwordInput) {
        await passwordInput.fill(password);
        const submitBtn = await this.page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await this.page.waitForTimeout(2000);
        }
      }
    }
  }
}

// ── Platform Handlers ───────────────────────────────────────────────────────

async function safeFill(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (el) {
      await el.fill(value);
      return true;
    }
  } catch {}
  return false;
}

async function safeUpload(page: Page, selector: string, filePath: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (el) {
      await el.setInputFiles(filePath);
      return true;
    }
  } catch {}
  return false;
}

class GreenhouseHandler implements ATSHandler {
  platform: ATSPlatform = 'greenhouse';

  detect(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('boards.greenhouse.io') || lower.includes('grnh.se');
  }

  async fillForm(page: Page, data: ApplicationData, resumePdfPath: string): Promise<{ filledFields: string[]; errors: string[] }> {
    const filled: string[] = [];
    const errors: string[] = [];

    if (await safeFill(page, '#first_name', data.firstName)) filled.push('first_name');
    if (await safeFill(page, '#last_name', data.lastName)) filled.push('last_name');
    if (await safeFill(page, '#email', data.email)) filled.push('email');
    if (await safeFill(page, '#phone', data.phone)) filled.push('phone');
    if (data.linkedIn && await safeFill(page, 'input[autocomplete="url"], #job_application_answers_attributes_0_text_value', data.linkedIn)) filled.push('linkedin');

    if (await safeUpload(page, 'input[type="file"]', resumePdfPath)) {
      filled.push('resume');
    } else {
      errors.push('Could not find file upload for resume');
    }

    // Cover letter textarea
    const clTextarea = await page.$('textarea[id*="cover_letter"], textarea[name*="cover_letter"]');
    if (clTextarea) {
      await clTextarea.fill(data.coverLetterText);
      filled.push('cover_letter');
    }

    return { filledFields: filled, errors };
  }

  async findCustomQuestions(page: Page): Promise<CustomQuestion[]> {
    return page.$$eval('.field:not(#first_name):not(#last_name):not(#email):not(#phone) textarea, .field select', (elements: Element[]) => {
      return elements
        .filter(el => {
          const id = el.getAttribute('id') ?? '';
          return !['first_name', 'last_name', 'email', 'phone'].some(f => id.includes(f));
        })
        .map(el => {
          const label = el.closest('.field')?.querySelector('label')?.textContent?.trim() ?? '';
          return {
            selector: el.tagName === 'TEXTAREA' ? `textarea#${el.id}` : `select#${el.id}`,
            questionText: label,
            currentValue: (el as HTMLTextAreaElement).value ?? '',
          };
        })
        .filter(q => q.questionText && !q.questionText.toLowerCase().includes('cover letter'));
    }).catch(() => []);
  }

  getSubmitSelector(): string {
    return 'input[type="submit"], button[type="submit"]';
  }
}

class LeverHandler implements ATSHandler {
  platform: ATSPlatform = 'lever';

  detect(url: string): boolean {
    return url.toLowerCase().includes('jobs.lever.co');
  }

  async fillForm(page: Page, data: ApplicationData, resumePdfPath: string): Promise<{ filledFields: string[]; errors: string[] }> {
    const filled: string[] = [];
    const errors: string[] = [];

    if (await safeFill(page, 'input[name="name"]', `${data.firstName} ${data.lastName}`)) filled.push('name');
    if (await safeFill(page, 'input[name="email"]', data.email)) filled.push('email');
    if (await safeFill(page, 'input[name="phone"]', data.phone)) filled.push('phone');
    if (data.linkedIn && await safeFill(page, 'input[name="urls[LinkedIn]"]', data.linkedIn)) filled.push('linkedin');
    if (data.website && await safeFill(page, 'input[name="urls[Portfolio]"], input[name="urls[Other]"]', data.website)) filled.push('website');

    if (await safeUpload(page, 'input[name="resume"]', resumePdfPath)) {
      filled.push('resume');
    } else if (await safeUpload(page, 'input[type="file"]', resumePdfPath)) {
      filled.push('resume');
    } else {
      errors.push('Could not find file upload for resume');
    }

    const clTextarea = await page.$('textarea[name="comments"]');
    if (clTextarea) {
      await clTextarea.fill(data.coverLetterText);
      filled.push('cover_letter');
    }

    return { filledFields: filled, errors };
  }

  async findCustomQuestions(page: Page): Promise<CustomQuestion[]> {
    return page.$$eval('.application-question textarea, .application-question select', (elements: Element[]) => {
      return elements.map(el => {
        const label = el.closest('.application-question')?.querySelector('label')?.textContent?.trim() ?? '';
        const id = el.getAttribute('id') ?? el.getAttribute('name') ?? '';
        return {
          selector: `[name="${el.getAttribute('name')}"]`,
          questionText: label,
          currentValue: (el as HTMLTextAreaElement).value ?? '',
        };
      }).filter(q => q.questionText);
    }).catch(() => []);
  }

  getSubmitSelector(): string {
    return 'button.postings-btn-submit, button[type="submit"]';
  }
}

class WorkdayHandler implements ATSHandler {
  platform: ATSPlatform = 'workday';

  detect(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('myworkdayjobs.com') || lower.includes('.wd5.') || lower.includes('.wd1.');
  }

  async fillForm(page: Page, data: ApplicationData, resumePdfPath: string): Promise<{ filledFields: string[]; errors: string[] }> {
    const filled: string[] = [];
    const errors: string[] = [];

    // Workday uses data-automation-id attributes
    await page.waitForTimeout(3000); // Wait for Angular/React hydration

    if (await safeFill(page, '[data-automation-id="name"] input, input[data-automation-id="legalNameSection_firstName"]', data.firstName)) filled.push('first_name');
    if (await safeFill(page, 'input[data-automation-id="legalNameSection_lastName"]', data.lastName)) filled.push('last_name');
    if (await safeFill(page, 'input[data-automation-id="email"]', data.email)) filled.push('email');
    if (await safeFill(page, 'input[data-automation-id="phone-number"]', data.phone)) filled.push('phone');

    if (await safeUpload(page, 'input[type="file"][data-automation-id="file-upload-input-ref"]', resumePdfPath)) {
      filled.push('resume');
    } else if (await safeUpload(page, 'input[type="file"]', resumePdfPath)) {
      filled.push('resume');
    } else {
      errors.push('Could not find file upload for resume');
    }

    return { filledFields: filled, errors };
  }

  async findCustomQuestions(page: Page): Promise<CustomQuestion[]> {
    return page.$$eval('[data-automation-id*="question"] textarea, [data-automation-id*="question"] input[type="text"]', (elements: Element[]) => {
      return elements.map(el => {
        const label = el.closest('[data-automation-id]')?.querySelector('label')?.textContent?.trim() ?? '';
        const automationId = el.getAttribute('data-automation-id') ?? '';
        return {
          selector: `[data-automation-id="${automationId}"]`,
          questionText: label,
          currentValue: (el as HTMLInputElement).value ?? '',
        };
      }).filter(q => q.questionText);
    }).catch(() => []);
  }

  getSubmitSelector(): string {
    return '[data-automation-id="bottom-navigation-next-button"], button[data-automation-id="submit"]';
  }
}

class AshbyHandler implements ATSHandler {
  platform: ATSPlatform = 'ashby';

  detect(url: string): boolean {
    return url.toLowerCase().includes('jobs.ashbyhq.com');
  }

  async fillForm(page: Page, data: ApplicationData, resumePdfPath: string): Promise<{ filledFields: string[]; errors: string[] }> {
    const filled: string[] = [];
    const errors: string[] = [];

    // Ashby uses standard-ish form fields
    if (await safeFill(page, 'input[name="name"], input[name="_systemfield_name"]', `${data.firstName} ${data.lastName}`)) filled.push('name');
    if (await safeFill(page, 'input[name="email"], input[name="_systemfield_email"]', data.email)) filled.push('email');
    if (await safeFill(page, 'input[name="phone"], input[name="_systemfield_phone"]', data.phone)) filled.push('phone');
    if (data.linkedIn && await safeFill(page, 'input[name="linkedin"], input[name="_systemfield_linkedin"]', data.linkedIn)) filled.push('linkedin');

    if (await safeUpload(page, 'input[type="file"]', resumePdfPath)) {
      filled.push('resume');
    } else {
      errors.push('Could not find file upload for resume');
    }

    return { filledFields: filled, errors };
  }

  async findCustomQuestions(page: Page): Promise<CustomQuestion[]> {
    return page.$$eval('textarea:not([name*="cover"]), select', (elements: Element[]) => {
      return elements.map(el => {
        const label = el.closest('.ashby-application-form-field-wrapper, .form-field')?.querySelector('label')?.textContent?.trim() ?? '';
        const name = el.getAttribute('name') ?? '';
        return {
          selector: `[name="${name}"]`,
          questionText: label,
          currentValue: (el as HTMLTextAreaElement).value ?? '',
        };
      }).filter(q => q.questionText);
    }).catch(() => []);
  }

  getSubmitSelector(): string {
    return 'button[type="submit"]';
  }
}

class GenericHandler implements ATSHandler {
  platform: ATSPlatform = 'generic';

  detect(): boolean {
    return true;
  }

  async fillForm(page: Page, data: ApplicationData, resumePdfPath: string): Promise<{ filledFields: string[]; errors: string[] }> {
    const filled: string[] = [];
    const errors: string[] = [];

    // Try common selectors by label text and input attributes
    const nameSelectors = 'input[name*="name" i]:not([name*="last"]):not([name*="company"]), input[autocomplete="given-name"]';
    const lastNameSelectors = 'input[name*="last" i], input[autocomplete="family-name"]';
    const emailSelectors = 'input[type="email"], input[name*="email" i], input[autocomplete="email"]';
    const phoneSelectors = 'input[type="tel"], input[name*="phone" i], input[autocomplete="tel"]';

    if (await safeFill(page, nameSelectors, data.firstName)) filled.push('first_name');
    if (await safeFill(page, lastNameSelectors, data.lastName)) filled.push('last_name');
    if (await safeFill(page, emailSelectors, data.email)) filled.push('email');
    if (await safeFill(page, phoneSelectors, data.phone)) filled.push('phone');

    if (await safeUpload(page, 'input[type="file"]', resumePdfPath)) {
      filled.push('resume');
    } else {
      errors.push('Could not find file upload for resume');
    }

    // Try to find cover letter field
    const clField = await page.$('textarea[name*="cover" i], textarea[name*="letter" i], textarea[name*="comment" i]');
    if (clField) {
      await clField.fill(data.coverLetterText);
      filled.push('cover_letter');
    }

    return { filledFields: filled, errors };
  }

  async findCustomQuestions(page: Page): Promise<CustomQuestion[]> {
    return page.$$eval('form textarea, form select', (elements: Element[]) => {
      const standardNames = ['name', 'email', 'phone', 'cover', 'letter', 'comment', 'resume'];
      return elements
        .filter(el => {
          const name = (el.getAttribute('name') ?? '').toLowerCase();
          return !standardNames.some(s => name.includes(s));
        })
        .map(el => {
          const label = el.closest('div, fieldset, .field')?.querySelector('label')?.textContent?.trim() ?? '';
          const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '';
          return {
            selector: name ? `[name="${name}"]` : `#${el.id}`,
            questionText: label,
            currentValue: (el as HTMLTextAreaElement).value ?? '',
          };
        })
        .filter(q => q.questionText);
    }).catch(() => []);
  }

  getSubmitSelector(): string {
    return 'button[type="submit"], input[type="submit"]';
  }
}
