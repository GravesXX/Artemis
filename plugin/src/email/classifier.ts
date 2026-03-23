import type { ArtemisDB } from '../db/database.js';
import type { RawEmail } from './monitor.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type EmailClassification = 'acknowledgment' | 'rejection' | 'interview_request' | 'offer' | 'other';

export interface ClassifiedEmail {
  raw: RawEmail;
  classification: EmailClassification;
  matchedApplicationId: string | null;
  matchedCompanyName: string | null;
  statusUpdate: string | null;
}

// ── Classification patterns ─────────────────────────────────────────────────

const PATTERNS: Array<{ classification: EmailClassification; patterns: RegExp[]; statusUpdate: string }> = [
  {
    classification: 'offer',
    patterns: [
      /offer.*position/i, /offer letter/i, /compensation.*package/i,
      /pleased to offer/i, /start date.*offer/i, /formal offer/i,
    ],
    statusUpdate: 'offer',
  },
  {
    classification: 'interview_request',
    patterns: [
      /schedule.*interview/i, /interview.*schedule/i, /next steps/i,
      /meet the team/i, /phone screen/i, /technical.*interview/i,
      /would like to invite/i, /coding.*challenge/i, /take-home/i,
      /on-?site/i, /virtual.*interview/i,
    ],
    statusUpdate: 'interview',
  },
  {
    classification: 'rejection',
    patterns: [
      /unfortunately/i, /other candidates/i, /not moving forward/i,
      /decided not to/i, /position.*filled/i, /will not be/i,
      /regret to inform/i, /not.*selected/i, /pursue other/i,
    ],
    statusUpdate: 'rejected',
  },
  {
    classification: 'acknowledgment',
    patterns: [
      /received your application/i, /thank you for applying/i,
      /application.*received/i, /we have received/i,
      /confirming.*receipt/i, /under review/i,
    ],
    statusUpdate: 'acknowledged',
  },
];

// ── EmailClassifier ─────────────────────────────────────────────────────────

export class EmailClassifier {
  constructor(private db: ArtemisDB) {}

  classify(email: RawEmail): ClassifiedEmail {
    const text = `${email.subject} ${email.bodyPreview}`;

    let bestClassification: EmailClassification = 'other';
    let bestScore = 0;
    let statusUpdate: string | null = null;

    for (const { classification, patterns, statusUpdate: su } of PATTERNS) {
      let score = 0;
      for (const pattern of patterns) {
        if (pattern.test(text)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestClassification = classification;
        statusUpdate = su;
      }
    }

    if (bestScore === 0) {
      statusUpdate = null;
    }

    const match = this.matchToApplication(email);

    return {
      raw: email,
      classification: bestClassification,
      matchedApplicationId: match?.applicationId ?? null,
      matchedCompanyName: match?.companyName ?? null,
      statusUpdate: bestScore > 0 ? statusUpdate : null,
    };
  }

  matchToApplication(email: RawEmail): { applicationId: string; companyName: string } | null {
    const senderDomain = this.extractDomain(email.from);
    if (!senderDomain) return null;

    const apps = this.db.getAllApplications()
      .filter(a => a.status !== 'draft' && a.status !== 'withdrawn');

    let bestMatch: { applicationId: string; companyName: string; score: number } | null = null;

    for (const app of apps) {
      const job = this.db.getJobPosting(app.job_id);
      if (!job) continue;

      const company = this.db.getCompany(job.company_id);
      if (!company) continue;

      let score = 0;

      // Check domain match
      const companyDomain = this.extractDomain(company.careers_url);
      if (companyDomain && this.domainMatch(senderDomain, companyDomain)) {
        score += 2;
      }

      // Check if subject contains company name or job title
      const text = `${email.subject} ${email.bodyPreview}`.toLowerCase();
      if (text.includes(company.name.toLowerCase())) score += 1;
      if (text.includes(job.title.toLowerCase())) score += 1;

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { applicationId: app.id, companyName: company.name, score };
      }
    }

    return bestMatch ? { applicationId: bestMatch.applicationId, companyName: bestMatch.companyName } : null;
  }

  private extractDomain(urlOrEmail: string): string | null {
    // Handle email addresses
    if (urlOrEmail.includes('@')) {
      return urlOrEmail.split('@')[1]?.toLowerCase() ?? null;
    }

    // Handle URLs
    try {
      const hostname = new URL(urlOrEmail).hostname.toLowerCase();
      return hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  private domainMatch(senderDomain: string, companyDomain: string): boolean {
    // Normalize: strip common prefixes
    const normalize = (d: string) => {
      d = d.replace(/^(www|mail|smtp|imap|boards|jobs|careers)\./i, '');
      // Also handle subdomains like greenhouse.io → compare root
      return d;
    };

    const s = normalize(senderDomain);
    const c = normalize(companyDomain);

    // Exact match after normalization
    if (s === c) return true;

    // Root domain match: google.com matches careers.google.com
    if (s.endsWith('.' + c) || c.endsWith('.' + s)) return true;

    // Check last two segments (e.g., "google.com" from "recruiter.google.com")
    const sRoot = s.split('.').slice(-2).join('.');
    const cRoot = c.split('.').slice(-2).join('.');
    return sRoot === cRoot;
  }
}
