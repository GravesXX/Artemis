import { createHash } from 'crypto';
import type { JobPosting } from '../db/database.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ScrapedJob {
  url: string;
  title: string;
  rawText: string;
  salary: string | null;
  location: string | null;
  level: string | null;
}

export interface DiffResult {
  newJobs: ScrapedJob[];
  changedJobs: Array<{ scraped: ScrapedJob; existing: JobPosting }>;
  removedJobs: JobPosting[];
  unchangedJobs: JobPosting[];
}

// ── JobDiffer ───────────────────────────────────────────────────────────────

export class JobDiffer {

  static hashContent(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex');
  }

  diff(scrapedJobs: ScrapedJob[], existingJobs: JobPosting[]): DiffResult {
    const existingByUrl = new Map<string, JobPosting>();
    for (const job of existingJobs) {
      existingByUrl.set(job.url, job);
    }

    const scrapedUrls = new Set<string>();
    const newJobs: ScrapedJob[] = [];
    const changedJobs: Array<{ scraped: ScrapedJob; existing: JobPosting }> = [];
    const unchangedJobs: JobPosting[] = [];

    for (const scraped of scrapedJobs) {
      scrapedUrls.add(scraped.url);
      const existing = existingByUrl.get(scraped.url);

      if (!existing) {
        newJobs.push(scraped);
      } else {
        const newHash = JobDiffer.hashContent(scraped.rawText);
        if (newHash !== existing.content_hash) {
          changedJobs.push({ scraped, existing });
        } else {
          unchangedJobs.push(existing);
        }
      }
    }

    const removedJobs = existingJobs.filter(
      j => !scrapedUrls.has(j.url) && j.status !== 'closed'
    );

    return { newJobs, changedJobs, removedJobs, unchangedJobs };
  }
}
