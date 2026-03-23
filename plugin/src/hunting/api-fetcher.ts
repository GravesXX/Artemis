import type { ScrapedJob } from './differ.js';
import type { ScrapeResult } from './scraper.js';

// ── API-based job fetching for Greenhouse and Lever ─────────────────────────
// These platforms have public JSON APIs that return structured job data
// without needing browser automation. Much faster and more reliable.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// ── Greenhouse API ──────────────────────────────────────────────────────────
// API: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
// Each job: { id, title, location: { name }, absolute_url, content (HTML) }

interface GreenhouseJob {
  id: number;
  title: string;
  location: { name: string };
  absolute_url: string;
  content: string;
  updated_at: string;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export function extractGreenhouseBoardToken(url: string): string | null {
  // Match: boards.greenhouse.io/{token} or job-boards.greenhouse.io/{token}
  const match = url.match(/(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)/i);
  return match ? match[1] : null;
}

export async function fetchGreenhouseJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const token = extractGreenhouseBoardToken(careersUrl);
  if (!token) {
    return { companyId, careersUrl, jobs: [], errors: ['Could not extract Greenhouse board token from URL'] };
  }

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const errors: string[] = [];

  try {
    const response = await fetch(apiUrl, { headers: HEADERS });
    if (!response.ok) {
      return { companyId, careersUrl, jobs: [], errors: [`Greenhouse API returned ${response.status}`] };
    }

    const data = await response.json() as GreenhouseResponse;
    const jobs: ScrapedJob[] = data.jobs.map(job => ({
      url: job.absolute_url,
      title: job.title,
      rawText: htmlToText(job.content),
      salary: extractSalary(job.content),
      location: job.location?.name ?? null,
      level: detectLevel(job.title),
    }));

    return { companyId, careersUrl, jobs, errors };
  } catch (err) {
    return { companyId, careersUrl, jobs: [], errors: [`Greenhouse API error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ── Lever API ───────────────────────────────────────────────────────────────
// API: https://api.lever.co/v0/postings/{company}
// Each posting: { id, text, categories: { location, team, commitment }, hostedUrl, descriptionPlain, lists[] }

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  descriptionPlain: string;
  categories: {
    location: string;
    team: string;
    commitment: string;
  };
  lists: Array<{ text: string; content: string }>;
  additionalPlain?: string;
}

export function extractLeverCompanySlug(url: string): string | null {
  // Match: jobs.lever.co/{slug}
  const match = url.match(/jobs\.lever\.co\/([^/?#]+)/i);
  return match ? match[1] : null;
}

export async function fetchLeverJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const slug = extractLeverCompanySlug(careersUrl);
  if (!slug) {
    return { companyId, careersUrl, jobs: [], errors: ['Could not extract Lever company slug from URL'] };
  }

  const apiUrl = `https://api.lever.co/v0/postings/${slug}`;
  const errors: string[] = [];

  try {
    const response = await fetch(apiUrl, { headers: HEADERS });
    if (!response.ok) {
      return { companyId, careersUrl, jobs: [], errors: [`Lever API returned ${response.status}`] };
    }

    const data = await response.json() as LeverPosting[];
    const jobs: ScrapedJob[] = data.map(posting => {
      // Build full description from descriptionPlain + lists
      let fullText = posting.descriptionPlain ?? '';
      if (posting.lists) {
        for (const list of posting.lists) {
          fullText += `\n\n${list.text}\n${htmlToText(list.content)}`;
        }
      }
      if (posting.additionalPlain) {
        fullText += `\n\n${posting.additionalPlain}`;
      }

      return {
        url: posting.hostedUrl,
        title: posting.text,
        rawText: fullText,
        salary: extractSalary(fullText),
        location: posting.categories?.location ?? null,
        level: detectLevel(posting.text),
      };
    });

    return { companyId, careersUrl, jobs, errors };
  } catch (err) {
    return { companyId, careersUrl, jobs: [], errors: [`Lever API error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ── Ashby API ───────────────────────────────────────────────────────────────
// API: https://api.ashbyhq.com/posting-api/job-board/{org}

interface AshbyJob {
  id: string;
  title: string;
  location: string;
  department: string;
  team: string;
  isRemote: boolean;
  descriptionPlain: string;
  descriptionHtml: string;
  jobUrl: string;
  applyUrl: string;
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

export function extractAshbyOrg(url: string): string | null {
  // Match: api.ashbyhq.com/posting-api/job-board/{org} or jobs.ashbyhq.com/{org}
  let match = url.match(/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i);
  if (match) return match[1];
  match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (match) return match[1];
  return null;
}

export async function fetchAshbyJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const org = extractAshbyOrg(careersUrl);
  if (!org) {
    return { companyId, careersUrl, jobs: [], errors: ['Could not extract Ashby org from URL'] };
  }

  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${org}`;
  const errors: string[] = [];

  try {
    const response = await fetch(apiUrl, { headers: HEADERS });
    if (!response.ok) {
      return { companyId, careersUrl, jobs: [], errors: [`Ashby API returned ${response.status}`] };
    }

    const data = await response.json() as AshbyResponse;
    const jobs: ScrapedJob[] = (data.jobs ?? []).map(job => ({
      url: job.jobUrl ?? `https://jobs.ashbyhq.com/${org}/${job.id}`,
      title: job.title,
      rawText: job.descriptionPlain ?? htmlToText(job.descriptionHtml ?? ''),
      salary: extractSalary(job.descriptionPlain ?? ''),
      location: job.location ?? (job.isRemote ? 'Remote' : null),
      level: detectLevel(job.title),
    }));

    return { companyId, careersUrl, jobs, errors };
  } catch (err) {
    return { companyId, careersUrl, jobs: [], errors: [`Ashby API error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ── Detection ───────────────────────────────────────────────────────────────

export type ApiFetchable = 'greenhouse' | 'lever' | 'ashby' | null;

export function detectApiFetchable(url: string): ApiFetchable {
  if (extractGreenhouseBoardToken(url)) return 'greenhouse';
  if (extractLeverCompanySlug(url)) return 'lever';
  if (extractAshbyOrg(url)) return 'ashby';
  return null;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|ul|ol|section|article|header|footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

function extractSalary(text: string): string | null {
  const patterns = [
    /\$[\d,]+\s*[-–]\s*\$[\d,]+/,
    /\$[\d,]+\s*(?:to|and)\s*\$[\d,]+/i,
    /(?:salary|compensation|pay)[\s:]*\$[\d,]+/i,
    /\$\d{2,3}[kK]\s*[-–]\s*\$\d{2,3}[kK]/,
    /CAD\s*\$?[\d,]+\s*[-–]\s*\$?[\d,]+/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function detectLevel(title: string): string | null {
  const lower = title.toLowerCase();
  if (/\bprincipal\b/.test(lower)) return 'principal';
  if (/\bstaff\b/.test(lower)) return 'staff';
  if (/\blead\b/.test(lower)) return 'lead';
  if (/\bsenior\b|\bsr\.?\b/.test(lower)) return 'senior';
  if (/\bintermediate\b|\bmid[\s-]?level\b/.test(lower)) return 'mid';
  if (/\bjunior\b|\bjr\.?\b|\bentry[\s-]?level\b|\bnew\s+grad\b|\bintern\b/.test(lower)) return 'junior';
  return null;
}
