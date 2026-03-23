import type { PluginAPI } from '../types.js';
import type { ArtemisDB } from '../db/database.js';
import { ApplicationTracker } from '../application/tracker.js';
import { text } from './helpers.js';

export function registerTrackTools(api: PluginAPI, db: ArtemisDB): void {
  const tracker = new ApplicationTracker(db);

  api.registerTool({
    name: 'artemis_application_list',
    description: 'List all applications with their current status. Optionally filter by status.',
    parameters: {
      status: {
        type: 'string',
        description: 'Filter by application status',
        enum: ['draft', 'pending_review', 'submitted', 'acknowledged', 'rejected', 'phone_screen', 'interview', 'offer', 'withdrawn'],
      },
    },
    execute: async (_id, params) => {
      const filters = params.status ? { status: params.status as string } : undefined;
      const apps = db.getAllApplications(filters);

      if (apps.length === 0) {
        const msg = params.status
          ? `No applications with status "${params.status}".`
          : 'No applications yet. Use `artemis_apply_prepare` to start.';
        return text({ content: msg });
      }

      const lines = [`**${apps.length} application(s):**`, ''];
      for (const app of apps) {
        const job = db.getJobPosting(app.job_id);
        const company = job ? db.getCompany(job.company_id) : null;
        const title = job?.title ?? 'Unknown';
        const companyName = company?.name ?? 'Unknown';
        const applied = app.applied_at ? ` | Applied: ${app.applied_at.slice(0, 10)}` : '';

        lines.push(`- **${title} — ${companyName}** [${app.status}]${applied}`);
        lines.push(`  ID: ${app.id.slice(0, 8)} | Last update: ${app.last_status_change.slice(0, 10)}`);
      }

      return text({ content: lines.join('\n') });
    },
  });

  api.registerTool({
    name: 'artemis_application_update',
    description: 'Manually update the status of an application. Use for offline updates (e.g., received a phone call about an interview).',
    parameters: {
      application_id: { type: 'string', description: 'Application ID', required: true },
      status: {
        type: 'string',
        description: 'New status',
        required: true,
        enum: ['acknowledged', 'phone_screen', 'interview', 'offer', 'rejected', 'withdrawn'],
      },
      notes: { type: 'string', description: 'Notes about the status change' },
    },
    execute: async (_id, params) => {
      const applicationId = params.application_id as string;
      const app = db.getApplication(applicationId);
      if (!app) {
        return text({ content: '', error: `Application not found: ${applicationId}` });
      }

      const oldStatus = app.status;
      db.updateApplicationStatus(applicationId, params.status as string, params.notes as string | undefined);

      const job = db.getJobPosting(app.job_id);
      const title = job?.title ?? 'Unknown';

      return text({
        content: `**${title}**: ${oldStatus} → ${params.status}${params.notes ? `\nNote: ${params.notes}` : ''}`,
      });
    },
  });

  api.registerTool({
    name: 'artemis_application_analytics',
    description: 'Show application conversion funnel with rates: applied → acknowledged → interview → offer.',
    parameters: {},
    execute: async () => {
      const funnel = tracker.getConversionFunnel();
      if (funnel.total === 0) {
        return text({ content: 'No applications to analyze yet.' });
      }
      return text({ content: tracker.formatFunnel(funnel) });
    },
  });

  api.registerTool({
    name: 'artemis_application_timeline',
    description: 'Show the full timeline for a specific application: status changes, emails received, notes.',
    parameters: {
      application_id: { type: 'string', description: 'Application ID', required: true },
    },
    execute: async (_id, params) => {
      const applicationId = params.application_id as string;
      const timeline = tracker.getTimeline(applicationId);
      if (!timeline) {
        return text({ content: '', error: `Application not found: ${applicationId}` });
      }
      return text({ content: tracker.formatTimeline(timeline) });
    },
  });
}
