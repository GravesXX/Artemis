import type { ArtemisDB } from '../db/database.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ConversionFunnel {
  total: number;
  draft: number;
  submitted: number;
  acknowledged: number;
  phone_screen: number;
  interview: number;
  offer: number;
  rejected: number;
  withdrawn: number;
  rates: {
    submitRate: string;
    ackRate: string;
    interviewRate: string;
    offerRate: string;
  };
}

export interface TimelineEvent {
  timestamp: string;
  type: 'status_change' | 'email_received';
  description: string;
}

export interface ApplicationTimeline {
  applicationId: string;
  jobTitle: string;
  companyName: string;
  currentStatus: string;
  events: TimelineEvent[];
}

// ── ApplicationTracker ──────────────────────────────────────────────────────

export class ApplicationTracker {
  constructor(private db: ArtemisDB) {}

  getConversionFunnel(): ConversionFunnel {
    const apps = this.db.getAllApplications();
    const counts: Record<string, number> = {};

    for (const app of apps) {
      counts[app.status] = (counts[app.status] ?? 0) + 1;
    }

    const total = apps.length;
    const submitted = apps.filter(a => a.applied_at !== null).length;

    const rate = (num: number, denom: number) =>
      denom > 0 ? `${Math.round((num / denom) * 100)}%` : '—';

    return {
      total,
      draft: counts['draft'] ?? 0,
      submitted: counts['submitted'] ?? 0,
      acknowledged: counts['acknowledged'] ?? 0,
      phone_screen: counts['phone_screen'] ?? 0,
      interview: counts['interview'] ?? 0,
      offer: counts['offer'] ?? 0,
      rejected: counts['rejected'] ?? 0,
      withdrawn: counts['withdrawn'] ?? 0,
      rates: {
        submitRate: rate(submitted, total),
        ackRate: rate((counts['acknowledged'] ?? 0) + (counts['interview'] ?? 0) + (counts['offer'] ?? 0), submitted),
        interviewRate: rate((counts['interview'] ?? 0) + (counts['offer'] ?? 0), submitted),
        offerRate: rate(counts['offer'] ?? 0, submitted),
      },
    };
  }

  getTimeline(applicationId: string): ApplicationTimeline | null {
    const app = this.db.getApplication(applicationId);
    if (!app) return null;

    const job = this.db.getJobPosting(app.job_id);
    const company = job ? this.db.getCompany(job.company_id) : null;

    const events: TimelineEvent[] = [];

    // Application creation
    events.push({
      timestamp: app.last_status_change,
      type: 'status_change',
      description: `Application created (status: ${app.status})`,
    });

    // Submitted event
    if (app.applied_at) {
      events.push({
        timestamp: app.applied_at,
        type: 'status_change',
        description: 'Application submitted',
      });
    }

    // Emails
    const emails = this.db.getEmailsByApplication(applicationId);
    for (const email of emails) {
      events.push({
        timestamp: email.received_at,
        type: 'email_received',
        description: `${email.classification}: "${email.subject}" from ${email.from}`,
      });
    }

    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      applicationId,
      jobTitle: job?.title ?? 'Unknown',
      companyName: company?.name ?? 'Unknown',
      currentStatus: app.status,
      events,
    };
  }

  formatFunnel(funnel: ConversionFunnel): string {
    const lines = [
      '**Application Analytics**',
      '',
      `Total: ${funnel.total}`,
      '',
      '**Pipeline:**',
      `  Draft:        ${funnel.draft}`,
      `  Submitted:    ${funnel.submitted}`,
      `  Acknowledged: ${funnel.acknowledged}`,
      `  Phone Screen: ${funnel.phone_screen}`,
      `  Interview:    ${funnel.interview}`,
      `  Offer:        ${funnel.offer}`,
      `  Rejected:     ${funnel.rejected}`,
      `  Withdrawn:    ${funnel.withdrawn}`,
      '',
      '**Conversion Rates:**',
      `  Submit Rate:    ${funnel.rates.submitRate}`,
      `  Response Rate:  ${funnel.rates.ackRate}`,
      `  Interview Rate: ${funnel.rates.interviewRate}`,
      `  Offer Rate:     ${funnel.rates.offerRate}`,
    ];
    return lines.join('\n');
  }

  formatTimeline(timeline: ApplicationTimeline): string {
    const lines = [
      `**${timeline.jobTitle} — ${timeline.companyName}**`,
      `Status: ${timeline.currentStatus}`,
      '',
    ];

    for (const event of timeline.events) {
      const date = event.timestamp.slice(0, 10);
      const icon = event.type === 'email_received' ? '>' : '-';
      lines.push(`${icon} ${date} — ${event.description}`);
    }

    return lines.join('\n');
  }
}
