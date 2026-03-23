import type { ScrapedJob } from './differ.js';

// ── Filter Configuration ────────────────────────────────────────────────────

export interface JobFilterConfig {
  // Location: job must mention one of these locations (case-insensitive)
  // Also accepts "remote" as a valid location
  locations: string[];

  // Title must contain at least one of these keywords (case-insensitive)
  titleKeywords: string[];

  // Title must NOT contain any of these keywords (case-insensitive)
  titleExclude: string[];

  // Maximum seniority level — roles above this level are filtered out
  // Order: junior < mid < senior < lead < staff < principal
  maxLevel: string;
}

// ── Default filter for Isaac ────────────────────────────────────────────────

export function getDefaultFilter(): JobFilterConfig {
  return {
    // Only match on the location FIELD (not rawText) for these
    locations: [
      'ontario', 'on,', 'on ', ', on',
      'toronto', 'waterloo', 'ottawa', 'kitchener',
      'mississauga', 'hamilton', 'guelph', 'markham',
      'london, on', 'london, ontario',
      'canada',
      'remote - canada', 'remote, canada', 'remote (canada',
      'remote - us/canada', 'remote - us / canada',
      'remote - north america', 'remote, north america',
    ],

    titleKeywords: [
      'engineer', 'developer', 'swe', 'sde',
      'programmer', 'dev',
    ],

    titleExclude: [
      'manager', 'director', 'vp', 'vice president',
      'designer', 'analyst', 'recruiter', 'coordinator',
      'sales', 'marketing', 'accountant', 'counsel',
    ],

    maxLevel: 'senior',
  };
}

// ── Level ordering ──────────────────────────────────────────────────────────

const LEVEL_ORDER = ['junior', 'mid', 'senior', 'lead', 'staff', 'principal'] as const;

// ── JobFilter ───────────────────────────────────────────────────────────────

export class JobFilter {
  constructor(private config: JobFilterConfig) {}

  filter(jobs: ScrapedJob[]): { passed: ScrapedJob[]; filtered: FilteredJob[] } {
    const passed: ScrapedJob[] = [];
    const filtered: FilteredJob[] = [];

    for (const job of jobs) {
      const reason = this.check(job);
      if (reason) {
        filtered.push({ job, reason });
      } else {
        passed.push(job);
      }
    }

    return { passed, filtered };
  }

  /**
   * Returns null if job passes all filters, or a reason string if filtered out.
   */
  private check(job: ScrapedJob): string | null {
    // 1. Title keyword check — must contain at least one keyword
    if (!this.matchesTitleKeywords(job.title)) {
      return `title: no engineer/developer keyword found in "${job.title}"`;
    }

    // 2. Title exclude check — must not contain excluded words
    const excludeMatch = this.matchesTitleExclude(job.title);
    if (excludeMatch) {
      return `title: excluded keyword "${excludeMatch}" in "${job.title}"`;
    }

    // 3. Level check — must not exceed max level
    if (!this.matchesLevel(job)) {
      return `level: "${job.level}" exceeds max level "${this.config.maxLevel}"`;
    }

    // 4. Location check — must mention an accepted location
    if (!this.matchesLocation(job)) {
      return `location: "${job.location ?? 'unknown'}" not in accepted locations`;
    }

    return null;
  }

  private matchesTitleKeywords(title: string): boolean {
    const lower = title.toLowerCase();
    return this.config.titleKeywords.some(kw => lower.includes(kw.toLowerCase()));
  }

  private matchesTitleExclude(title: string): string | null {
    const lower = title.toLowerCase();
    for (const kw of this.config.titleExclude) {
      if (lower.includes(kw.toLowerCase())) return kw;
    }
    return null;
  }

  private matchesLevel(job: ScrapedJob): boolean {
    const level = job.level ?? this.detectLevelFromTitle(job.title);
    if (!level) return true; // no level detected = allow (benefit of the doubt)

    const maxIdx = LEVEL_ORDER.indexOf(this.config.maxLevel as typeof LEVEL_ORDER[number]);
    if (maxIdx < 0) return true;

    const jobIdx = LEVEL_ORDER.indexOf(level as typeof LEVEL_ORDER[number]);
    if (jobIdx < 0) return true; // unknown level = allow

    return jobIdx <= maxIdx;
  }

  private matchesLocation(job: ScrapedJob): boolean {
    const location = job.location?.toLowerCase() ?? '';

    // No location info at all = filter out (we can't verify it's in Ontario)
    if (!location) return false;

    // Reject explicitly US-only remote roles
    if (/remote.*united states|remote.*\bus\b(?!.*canada)/i.test(location)) return false;

    // Check location field against accepted locations
    for (const loc of this.config.locations) {
      if (location.includes(loc.toLowerCase())) return true;
    }

    return false;
  }

  private detectLevelFromTitle(title: string): string | null {
    const lower = title.toLowerCase();
    if (/\bprincipal\b/.test(lower)) return 'principal';
    if (/\bstaff\b/.test(lower)) return 'staff';
    if (/\blead\b/.test(lower)) return 'lead';
    if (/\bsenior\b|\bsr\.?\b/.test(lower)) return 'senior';
    if (/\bmid[\s-]?level\b|\bintermediate\b|\bmedium\b/.test(lower)) return 'mid';
    if (/\bjunior\b|\bjr\.?\b|\bentry[\s-]?level\b|\bnew\s+grad\b|\bintern\b/.test(lower)) return 'junior';
    return null;
  }
}

export interface FilteredJob {
  job: ScrapedJob;
  reason: string;
}
