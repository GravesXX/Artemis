import type { ScrapedJob } from './differ.js';
import type { ScrapeResult } from './scraper.js';

// ── Company-specific API fetchers ───────────────────────────────────────────
// For companies with known JSON APIs, fetch directly without a browser.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// ── Registry ────────────────────────────────────────────────────────────────

// Map of careers URL patterns → custom fetcher functions
const COMPANY_FETCHERS: Array<{
  match: (url: string) => boolean;
  fetch: (companyId: string, careersUrl: string) => Promise<ScrapeResult>;
}> = [
  { match: url => url.includes('amazon.jobs'), fetch: fetchAmazonJobs },
  { match: url => url.includes('uber.com') && url.includes('careers'), fetch: fetchUberJobs },
  { match: url => url.includes('careers.amd.com'), fetch: fetchAmdJobs },
  // Apple, Microsoft, Google need browser sessions — handled by Playwright fallback
  // IBM uses WAF-protected Avature — handled by Playwright fallback
];

export function getCompanyApiFetcher(careersUrl: string): ((companyId: string, careersUrl: string) => Promise<ScrapeResult>) | null {
  for (const { match, fetch } of COMPANY_FETCHERS) {
    if (match(careersUrl)) return fetch;
  }
  return null;
}

// ── Amazon ──────────────────────────────────────────────────────────────────
// API: https://www.amazon.jobs/en/search.json?base_query=...&country=CAN&result_limit=100

interface AmazonJob {
  title: string;
  normalized_location: string;
  job_path: string;
  basic_qualifications: string;
  preferred_qualifications: string;
  description: string;
  location: string;
}

interface AmazonResponse {
  jobs: AmazonJob[];
  hits: number;
}

async function fetchAmazonJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  const allJobs: ScrapedJob[] = [];

  // Fetch multiple pages — Amazon returns max 10 per page by default
  const pageSize = 25;
  const maxPages = 4;

  for (let offset = 0; offset < maxPages * pageSize; offset += pageSize) {
    try {
      const apiUrl = `https://www.amazon.jobs/en/search.json?base_query=software+engineer&country=CAN&result_limit=${pageSize}&offset=${offset}`;
      const response = await fetch(apiUrl, { headers: HEADERS });

      if (!response.ok) {
        errors.push(`Amazon API returned ${response.status}`);
        break;
      }

      const data = await response.json() as AmazonResponse;

      if (data.jobs.length === 0) break;

      for (const job of data.jobs) {
        const rawText = [job.description, job.basic_qualifications, job.preferred_qualifications].filter(Boolean).join('\n\n');
        allJobs.push({
          url: `https://www.amazon.jobs${job.job_path}`,
          title: job.title,
          rawText: htmlToText(rawText),
          salary: null,
          location: job.normalized_location ?? job.location ?? null,
          level: detectLevel(job.title),
        });
      }

      if (data.jobs.length < pageSize) break;
    } catch (err) {
      errors.push(`Amazon API error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return { companyId, careersUrl, jobs: allJobs, errors };
}

// ── Apple ───────────────────────────────────────────────────────────────────
// API: https://jobs.apple.com/api/role/search?searchString=software+engineer&location=canada-CNDA

interface AppleJob {
  positionId: string;
  postingTitle: string;
  transformedPostingTitle: string;
  locations: Array<{ name: string; countryCode: string }>;
  postingDate: string;
  team?: { teamName: string };
}

interface AppleResponse {
  searchResults: AppleJob[];
  totalRecords: number;
}

async function fetchAppleJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  const allJobs: ScrapedJob[] = [];

  try {
    // Apple's API needs specific headers
    const apiUrl = 'https://jobs.apple.com/api/role/search?searchString=software+engineer&location=canada-CNDA&page=1';
    const response = await fetch(apiUrl, {
      headers: {
        ...HEADERS,
        'Accept': 'application/json',
        'Cookie': 'dslang=US-EN; site=USA;',
      },
    });

    if (!response.ok) {
      // Try alternate approach — fetch the page and extract data
      return fetchAppleJobsFallback(companyId, careersUrl);
    }

    const data = await response.json() as AppleResponse;

    for (const job of (data.searchResults ?? [])) {
      const locationStr = job.locations?.map(l => l.name).join(', ') ?? '';
      allJobs.push({
        url: `https://jobs.apple.com/en-us/details/${job.positionId}`,
        title: job.postingTitle,
        rawText: `${job.postingTitle}. Team: ${job.team?.teamName ?? 'Unknown'}. Location: ${locationStr}`,
        salary: null,
        location: locationStr || null,
        level: detectLevel(job.postingTitle),
      });
    }
  } catch (err) {
    errors.push(`Apple API error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { companyId, careersUrl, jobs: allJobs, errors };
}

async function fetchAppleJobsFallback(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  // Fallback: fetch HTML and try to parse embedded JSON
  try {
    const response = await fetch('https://jobs.apple.com/en-us/search?searchString=software+engineer&location=canada-CNDA', {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
    });
    const html = await response.text();

    // Apple embeds job data in a <script> tag or JSON-LD
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
    if (jsonMatch) {
      try {
        const state = JSON.parse(jsonMatch[1]);
        const results = state?.searchResults?.searchResults ?? [];
        const jobs: ScrapedJob[] = results.map((j: any) => ({
          url: `https://jobs.apple.com/en-us/details/${j.positionId}`,
          title: j.postingTitle ?? '',
          rawText: j.postingTitle ?? '',
          salary: null,
          location: j.locations?.map((l: any) => l.name).join(', ') ?? null,
          level: detectLevel(j.postingTitle ?? ''),
        }));
        return { companyId, careersUrl, jobs, errors: [] };
      } catch {}
    }
  } catch {}

  return { companyId, careersUrl, jobs: [], errors: ['Apple: could not extract jobs from page'] };
}

// ── Microsoft ───────────────────────────────────────────────────────────────
// API: https://gcsservices.careers.microsoft.com/search/api/v1/search

interface MicrosoftJob {
  title: string;
  jobId: string;
  properties: {
    primaryLocation: string;
    locations: string[];
    description: string;
  };
}

interface MicrosoftResponse {
  operationResult: {
    result: {
      jobs: MicrosoftJob[];
      totalJobs: number;
    };
  };
}

async function fetchMicrosoftJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  const allJobs: ScrapedJob[] = [];

  try {
    const apiUrl = 'https://gcsservices.careers.microsoft.com/search/api/v1/search?q=software+engineer&lc=Canada&pg=1&pgSz=50&o=Relevance&flt=true';
    const response = await fetch(apiUrl, {
      headers: {
        ...HEADERS,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      errors.push(`Microsoft API returned ${response.status}`);
      return { companyId, careersUrl, jobs: [], errors };
    }

    const data = await response.json() as MicrosoftResponse;
    const jobs = data.operationResult?.result?.jobs ?? [];

    for (const job of jobs) {
      const location = job.properties?.primaryLocation ?? job.properties?.locations?.join(', ') ?? '';
      allJobs.push({
        url: `https://careers.microsoft.com/us/en/job/${job.jobId}`,
        title: job.title,
        rawText: htmlToText(job.properties?.description ?? job.title),
        salary: null,
        location: location || null,
        level: detectLevel(job.title),
      });
    }
  } catch (err) {
    errors.push(`Microsoft API error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { companyId, careersUrl, jobs: allJobs, errors };
}

// ── Google ──────────────────────────────────────────────────────────────────
// Google careers doesn't have a simple public API.
// We fetch the page and parse the embedded JSON data.

async function fetchGoogleJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  const allJobs: ScrapedJob[] = [];

  try {
    // Google's career search page embeds job data in the HTML
    const searchUrl = 'https://www.google.com/about/careers/applications/jobs/results?q=software%20engineer&location=Canada';
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
    });

    if (!response.ok) {
      errors.push(`Google careers returned ${response.status}`);
      return { companyId, careersUrl, jobs: [], errors };
    }

    const html = await response.text();

    // Google embeds job data in AF_initDataCallback calls
    const dataMatches = html.matchAll(/AF_initDataCallback\(\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\)/g);

    for (const match of dataMatches) {
      try {
        const data = JSON.parse(match[1]);
        // Google's data structure is deeply nested arrays
        // Look for arrays that contain job-like objects
        const extracted = extractGoogleJobs(data);
        allJobs.push(...extracted);
      } catch {}
    }

    if (allJobs.length === 0) {
      // Fallback: try to find job links in the HTML
      const linkPattern = /\/about\/careers\/applications\/jobs\/results\/(\d+)/g;
      const titlePattern = /<h3[^>]*class="[^"]*"[^>]*>(.*?)<\/h3>/g;
      let linkMatch;
      while ((linkMatch = linkPattern.exec(html)) !== null) {
        const jobId = linkMatch[1];
        allJobs.push({
          url: `https://www.google.com/about/careers/applications/jobs/results/${jobId}`,
          title: `Google Job ${jobId}`,
          rawText: 'Software Engineer role at Google',
          salary: null,
          location: 'Canada',
          level: null,
        });
      }
    }
  } catch (err) {
    errors.push(`Google careers error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { companyId, careersUrl, jobs: allJobs, errors };
}

function extractGoogleJobs(data: unknown): ScrapedJob[] {
  const jobs: ScrapedJob[] = [];

  // Recursively search for arrays that look like job listings
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      // Check if this array has job-like elements (title string + URL string)
      if (node.length >= 3 && typeof node[0] === 'string' && typeof node[1] === 'string') {
        const possibleTitle = node[0];
        const possibleUrl = node[1];
        if (possibleUrl.includes('/jobs/results/') || possibleUrl.includes('careers.google.com')) {
          jobs.push({
            url: possibleUrl.startsWith('http') ? possibleUrl : `https://www.google.com${possibleUrl}`,
            title: possibleTitle,
            rawText: possibleTitle,
            salary: null,
            location: 'Canada',
            level: detectLevel(possibleTitle),
          });
          return;
        }
      }
      for (const item of node) {
        walk(item);
      }
    }
  }

  walk(data);
  return jobs;
}

// ── Uber ────────────────────────────────────────────────────────────────────
// API: POST https://www.uber.com/api/loadSearchJobsResults?localeCode=en
// Body: {"params":{"location":[{"country":"CAN"}],"department":[],"team":[]}}

interface UberJob {
  id: string;
  title: string;
  description: string;
  location: { country: string; city: string; countryName: string };
  allLocations: Array<{ country: string; city: string }>;
  department: string;
  team: string;
}

interface UberResponse {
  status: string;
  data: { results: UberJob[] };
}

async function fetchUberJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  const allJobs: ScrapedJob[] = [];

  try {
    const response = await fetch('https://www.uber.com/api/loadSearchJobsResults?localeCode=en', {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/json',
        'x-csrf-token': 'x',
      },
      body: JSON.stringify({
        params: {
          location: [{ country: 'CAN' }],
          department: [],
          team: [],
        },
      }),
    });

    if (!response.ok) {
      errors.push(`Uber API returned ${response.status}`);
      return { companyId, careersUrl, jobs: [], errors };
    }

    const data = await response.json() as UberResponse;
    const results = data.data?.results ?? [];

    for (const job of results) {
      const locationStr = job.allLocations?.map(l => `${l.city}, ${l.country}`).join('; ')
        ?? `${job.location?.city ?? ''}, ${job.location?.country ?? ''}`;

      allJobs.push({
        url: `https://www.uber.com/us/en/careers/list/${job.id}/`,
        title: job.title,
        rawText: htmlToText(job.description ?? job.title),
        salary: null,
        location: locationStr || null,
        level: detectLevel(job.title),
      });
    }
  } catch (err) {
    errors.push(`Uber API error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { companyId, careersUrl, jobs: allJobs, errors };
}

// ── AMD ─────────────────────────────────────────────────────────────────────
// API: https://careers.amd.com/api/jobs?page=1&limit=50&query=software+engineer&location=Canada

interface AmdJobData {
  slug: string;
  title: string;
  description: string;
  location_name: string;
  city: string;
  state: string;
  country: string;
}

interface AmdResponse {
  jobs: Array<{ data: AmdJobData }>;
}

async function fetchAmdJobs(companyId: string, careersUrl: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  const allJobs: ScrapedJob[] = [];

  try {
    const apiUrl = 'https://careers.amd.com/api/jobs?page=1&limit=50&query=software+engineer&location=Canada';
    const response = await fetch(apiUrl, { headers: HEADERS });

    if (!response.ok) {
      errors.push(`AMD API returned ${response.status}`);
      return { companyId, careersUrl, jobs: [], errors };
    }

    const data = await response.json() as AmdResponse;

    for (const entry of (data.jobs ?? [])) {
      const job = entry.data;
      const locationStr = [job.city, job.state, job.country].filter(Boolean).join(', ');

      allJobs.push({
        url: `https://careers.amd.com/careers-home/jobs/${job.slug}`,
        title: job.title,
        rawText: htmlToText(job.description ?? job.title),
        salary: null,
        location: locationStr || job.location_name || null,
        level: detectLevel(job.title),
      });
    }
  } catch (err) {
    errors.push(`AMD API error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { companyId, careersUrl, jobs: allJobs, errors };
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

function detectLevel(title: string): string | null {
  const lower = title.toLowerCase();
  if (/\bprincipal\b/.test(lower)) return 'principal';
  if (/\bstaff\b/.test(lower)) return 'staff';
  if (/\blead\b/.test(lower)) return 'lead';
  if (/\bsenior\b|\bsr\.?\b/.test(lower)) return 'senior';
  if (/\bintermediate\b|\bmid[\s-]?level\b/.test(lower)) return 'mid';
  if (/\bjunior\b|\bjr\.?\b|\bentry[\s-]?level\b|\bnew\s+grad\b|\bintern\b/.test(lower)) return 'junior';
  // Amazon uses SDE I, SDE II, SDE III
  if (/\bsde\s*i\b|\bsde\s*1\b/i.test(lower)) return 'junior';
  if (/\bsde\s*ii\b|\bsde\s*2\b/i.test(lower)) return 'mid';
  if (/\bsde\s*iii\b|\bsde\s*3\b/i.test(lower)) return 'senior';
  return null;
}
