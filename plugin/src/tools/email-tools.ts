import type { PluginAPI } from '../types.js';
import type { ArtemisDB } from '../db/database.js';
import { EmailMonitor } from '../email/monitor.js';
import { EmailClassifier } from '../email/classifier.js';
import { encrypt, decrypt } from '../application/crypto.js';
import { text } from './helpers.js';

export function registerEmailTools(api: PluginAPI, db: ArtemisDB): void {
  const monitor = new EmailMonitor();
  const classifier = new EmailClassifier(db);

  api.registerTool({
    name: 'artemis_email_setup',
    description: 'Configure the application email for monitoring responses. For Gmail, use an App Password (myaccount.google.com/apppasswords), not your regular password.',
    parameters: {
      email: { type: 'string', description: 'Email address to monitor', required: true },
      password: { type: 'string', description: 'Email password or app password (will be encrypted at rest)', required: true },
      provider: { type: 'string', description: 'Email provider', enum: ['gmail', 'outlook', 'yahoo', 'icloud', 'custom'] },
      imap_host: { type: 'string', description: 'IMAP host (only for custom provider)' },
      imap_port: { type: 'string', description: 'IMAP port (only for custom provider, default: 993)' },
    },
    execute: async (_id, params) => {
      const email = params.email as string;
      const password = params.password as string;
      let provider = (params.provider as string) ?? 'gmail';

      // For custom provider, encode host:port into the provider string
      if (provider === 'custom' && params.imap_host) {
        const port = params.imap_port ?? '993';
        provider = `custom|${params.imap_host}|${port}`;
      }

      // Encrypt and store credential
      const encryptedPassword = encrypt(password);
      const cred = db.createCredential('Application Email', email, encryptedPassword, provider);

      // Test connectivity
      const config = EmailMonitor.resolveConfig(provider, email, password);
      const testResult = await monitor.testConnection(config);

      const lines = [
        '**Application email configured**',
        `- **Email:** ${email}`,
        `- **Provider:** ${provider.split('|')[0]}`,
        `- **ID:** ${cred.id.slice(0, 8)}`,
        '',
      ];

      if (testResult.success) {
        lines.push('**Connection test: passed.** Email monitoring is ready.');
      } else {
        lines.push(`**Connection test: failed.** Error: ${testResult.error}`);
        lines.push('');
        if (provider.startsWith('gmail')) {
          lines.push('For Gmail, make sure you are using an App Password, not your regular password.');
          lines.push('Generate one at: myaccount.google.com/apppasswords');
        }
      }

      return text({ content: lines.join('\n') });
    },
  });

  api.registerTool({
    name: 'artemis_email_check',
    description: 'Poll the application email for new responses. Classifies emails, matches to applications, and updates statuses automatically.',
    parameters: {},
    execute: async () => {
      // Find the email credential
      const creds = db.getAllCredentials().filter(c => c.label === 'Application Email');
      if (creds.length === 0) {
        return text({ content: '', error: 'No application email configured. Run `artemis_email_setup` first.' });
      }

      const cred = creds[creds.length - 1]; // Most recent
      const password = decrypt(cred.encrypted_password);
      const config = EmailMonitor.resolveConfig(cred.provider, cred.email, password);

      // Fetch unseen emails
      const fetchResult = await monitor.fetchUnseen(config);

      if (fetchResult.errors.length > 0 && fetchResult.emails.length === 0) {
        return text({ content: '', error: `Email check failed: ${fetchResult.errors.join('; ')}` });
      }

      // Deduplicate against already-stored emails
      const existing = db.getRecentEmails(200);
      const existingKeys = new Set(
        existing.map(e => `${e.from}|${e.subject}|${e.received_at.slice(0, 16)}`)
      );

      const newEmails = fetchResult.emails.filter(
        e => !existingKeys.has(`${e.from}|${e.subject}|${e.date.slice(0, 16)}`)
      );

      if (newEmails.length === 0) {
        const lines = ['**Email check complete** — No new emails.'];
        if (fetchResult.errors.length > 0) {
          lines.push('', `Warnings: ${fetchResult.errors.join('; ')}`);
        }
        return text({ content: lines.join('\n') });
      }

      // Classify and process each new email
      const results: string[] = [`**Email check complete** — ${newEmails.length} new email(s)`, ''];
      const urgentNotifications: string[] = [];

      for (const raw of newEmails) {
        const classified = classifier.classify(raw);

        // Store in DB
        db.createEmailMessage(
          classified.matchedApplicationId,
          raw.from,
          raw.subject,
          raw.bodyPreview,
          classified.classification
        );

        // Update application status if applicable
        if (classified.statusUpdate && classified.matchedApplicationId) {
          db.updateApplicationStatus(
            classified.matchedApplicationId,
            classified.statusUpdate,
            `Auto-updated from email: ${raw.subject}`
          );
        }

        // Format result line
        const matchInfo = classified.matchedCompanyName
          ? ` → matched to **${classified.matchedCompanyName}**`
          : ' (unmatched)';
        const statusInfo = classified.statusUpdate
          ? ` [status → ${classified.statusUpdate}]`
          : '';

        results.push(`- **${classified.classification}**: "${raw.subject}" from ${raw.from}${matchInfo}${statusInfo}`);

        // Flag urgent notifications
        if (classified.classification === 'interview_request' || classified.classification === 'offer') {
          urgentNotifications.push(
            `**${classified.classification === 'interview_request' ? 'Interview Request' : 'Offer Received'} — ${classified.matchedCompanyName ?? 'Unknown'}**\n` +
            `Subject: ${raw.subject}\nFrom: ${raw.from}`
          );
        }
      }

      if (urgentNotifications.length > 0) {
        results.push('', '---', '', '**URGENT — DM the user about these:**');
        for (const note of urgentNotifications) {
          results.push('', note);
        }
      }

      if (fetchResult.errors.length > 0) {
        results.push('', `**Warnings:** ${fetchResult.errors.join('; ')}`);
      }

      return text({ content: results.join('\n') });
    },
  });

  api.registerTool({
    name: 'artemis_email_report',
    description: 'Summarize recent email activity across all monitored applications.',
    parameters: {
      days: { type: 'string', description: 'Number of days to include (default: 7)' },
    },
    execute: async (_id, params) => {
      const days = params.days ? parseInt(params.days as string, 10) : 7;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();

      const allEmails = db.getRecentEmails(500);
      const recentEmails = allEmails.filter(e => e.received_at >= cutoff);

      if (recentEmails.length === 0) {
        return text({ content: `No emails received in the last ${days} days.` });
      }

      // Count by classification
      const counts: Record<string, number> = {};
      for (const e of recentEmails) {
        counts[e.classification] = (counts[e.classification] ?? 0) + 1;
      }

      const lines = [
        `**Email Activity — Last ${days} days**`,
        '',
        `**Total:** ${recentEmails.length} emails received`,
        `- Acknowledgments: ${counts['acknowledgment'] ?? 0}`,
        `- Rejections: ${counts['rejection'] ?? 0}`,
        `- Interview Requests: ${counts['interview_request'] ?? 0}`,
        `- Offers: ${counts['offer'] ?? 0}`,
        `- Other: ${counts['other'] ?? 0}`,
      ];

      // Notable events
      const notable = recentEmails.filter(
        e => e.classification === 'interview_request' || e.classification === 'offer'
      );
      if (notable.length > 0) {
        lines.push('', '**Notable:**');
        for (const e of notable) {
          const app = e.application_id ? db.getApplication(e.application_id) : null;
          const job = app ? db.getJobPosting(app.job_id) : null;
          const company = job ? db.getCompany(job.company_id) : null;
          const role = job?.title ?? 'Unknown role';
          const companyName = company?.name ?? 'Unknown company';
          lines.push(`- ${e.classification === 'interview_request' ? 'Interview' : 'Offer'}: **${companyName}** — ${role} (${e.received_at.slice(0, 10)})`);
        }
      }

      // Unmatched emails
      const unmatched = recentEmails.filter(e => e.application_id === null).length;
      if (unmatched > 0) {
        lines.push('', `**Unmatched emails:** ${unmatched} (not linked to any application)`);
      }

      return text({ content: lines.join('\n') });
    },
  });
}
