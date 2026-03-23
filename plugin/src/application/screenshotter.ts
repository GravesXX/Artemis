import type { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCREENSHOTS_DIR = path.join(os.homedir(), '.artemis', 'screenshots');

export class Screenshotter {
  constructor() {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  async capture(page: Page, applicationId: string): Promise<string> {
    const filePath = this.getPath(applicationId);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  }

  getPath(applicationId: string): string {
    return path.join(SCREENSHOTS_DIR, `${applicationId}.png`);
  }

  exists(applicationId: string): boolean {
    return fs.existsSync(this.getPath(applicationId));
  }

  remove(applicationId: string): void {
    const filePath = this.getPath(applicationId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
