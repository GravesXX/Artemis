import type { PluginAPI } from '../types.js';
import type { ArtemisDB } from '../db/database.js';
import { FormFiller } from '../application/filler.js';
import { Screenshotter } from '../application/screenshotter.js';
import { encrypt } from '../application/crypto.js';
import { text } from './helpers.js';

// Module-level state: one application at a time
let activeFiller: FormFiller | null = null;
let activeApplicationId: string | null = null;

export function registerApplyTools(api: PluginAPI, db: ArtemisDB): void {

  api.registerTool({
    name: 'artemis_apply_prepare',
    description: 'Prepare to apply for a job. Creates an Application record and returns instructions to coordinate with Athena for tailored resume and cover letter.',
    parameters: {
      job_id: { type: 'string', description: 'Job posting ID to apply for', required: true },
    },
    execute: async (_id, params) => {
      const jobId = params.job_id as string;
      const job = db.getJobPosting(jobId);
      if (!job) {
        return text({ content: '', error: `Job not found: ${jobId}` });
      }
      if (job.status === 'applied') {
        return text({ content: '', error: `Already applied to this job.` });
      }
      if (job.status === 'closed') {
        return text({ content: '', error: `This job posting is closed.` });
      }

      const company = db.getCompany(job.company_id);
      const companyName = company?.name ?? 'Unknown';
      const app = db.createApplication(job.id);

      const lines = [
        `**Application created** (ID: ${app.id.slice(0, 8)})`,
        `- **Job:** ${job.title}`,
        `- **Company:** ${companyName}`,
        `- **Status:** draft`,
        '',
        '---',
        '',
        '**Next steps — coordinate with Athena:**',
        '',
        `1. Mention <@1480628248634200186> and ask to tailor a resume for this JD:`,
        '',
        '```',
        job.raw_text.slice(0, 3000),
        '```',
        '',
        `2. Then ask <@1480628248634200186> to generate a cover letter for ${companyName} - ${job.title}.`,
        '',
        `3. Once you have the resume and cover letter, store them by calling the DB methods, then call \`artemis_apply_fill\` with this application ID: ${app.id}`,
      ];

      return text({ content: lines.join('\n') });
    },
  });

  api.registerTool({
    name: 'artemis_apply_fill',
    description: 'Launch a headed browser and auto-fill the application form. DO NOT submit — call artemis_apply_screenshot next to capture for review.',
    parameters: {
      application_id: { type: 'string', description: 'Application ID from artemis_apply_prepare', required: true },
      first_name: { type: 'string', description: 'Applicant first name', required: true },
      last_name: { type: 'string', description: 'Applicant last name', required: true },
      email: { type: 'string', description: 'Application email address', required: true },
      phone: { type: 'string', description: 'Phone number', required: true },
      linkedin: { type: 'string', description: 'LinkedIn profile URL' },
      website: { type: 'string', description: 'Portfolio or website URL' },
      resume_markdown: { type: 'string', description: 'Tailored resume in markdown format', required: true },
      cover_letter: { type: 'string', description: 'Generated cover letter text', required: true },
      credential_id: { type: 'string', description: 'Credential ID for ATS login (if needed)' },
      custom_answers_json: { type: 'string', description: 'JSON array of {selector, answer} for custom questions (from a previous fill attempt)' },
    },
    execute: async (_id, params) => {
      const applicationId = params.application_id as string;
      const app = db.getApplication(applicationId);
      if (!app) {
        return text({ content: '', error: `Application not found: ${applicationId}` });
      }

      const job = db.getJobPosting(app.job_id);
      if (!job) {
        return text({ content: '', error: `Job posting not found for application` });
      }

      const company = db.getCompany(job.company_id);

      // Close any existing session
      if (activeFiller) {
        await activeFiller.close();
        activeFiller = null;
        activeApplicationId = null;
      }

      // Store materials
      db.updateApplicationMaterials(applicationId, {
        resume_version: params.resume_markdown as string,
        cover_letter: params.cover_letter as string,
      });

      // Look up credential if provided
      let credential = undefined;
      if (params.credential_id) {
        credential = db.getCredential(params.credential_id as string) ?? undefined;
      }

      // Create and init filler
      const filler = new FormFiller();
      await filler.init();

      try {
        const result = await filler.fill({
          applicationId,
          applyUrl: job.url,
          firstName: params.first_name as string,
          lastName: params.last_name as string,
          email: params.email as string,
          phone: params.phone as string,
          linkedIn: params.linkedin as string | undefined,
          website: params.website as string | undefined,
          resumeMarkdown: params.resume_markdown as string,
          coverLetterText: params.cover_letter as string,
          jobDescription: job.raw_text,
          companyName: company?.name ?? 'Unknown',
        }, credential);

        // Fill custom answers if provided
        if (params.custom_answers_json) {
          try {
            const answers = JSON.parse(params.custom_answers_json as string);
            await filler.fillCustomAnswers(answers);
          } catch {}
        }

        // Store filler reference
        activeFiller = filler;
        activeApplicationId = applicationId;

        const lines = [
          `**Form filled** (${result.platform} platform)`,
          '',
          `**Filled fields:** ${result.filledFields.join(', ') || 'none'}`,
          `**Resume PDF:** ${result.resumePdfPath}`,
        ];

        if (result.errors.length > 0) {
          lines.push('', '**Errors:**');
          for (const err of result.errors) lines.push(`- ${err}`);
        }

        if (result.customQuestions.length > 0) {
          lines.push('', '**Custom questions found (need answers):**');
          for (const q of result.customQuestions) {
            lines.push(`- "${q.questionText}" (selector: ${q.selector})`);
          }
          lines.push('', 'Generate answers for these questions based on the user profile + company info + JD, then call `artemis_apply_screenshot` with the custom_answers_json parameter.');
        } else {
          lines.push('', 'No custom questions. Call `artemis_apply_screenshot` to capture for review.');
        }

        return text({ content: lines.join('\n') });
      } catch (err) {
        await filler.close();
        return text({ content: '', error: `Failed to fill form: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  api.registerTool({
    name: 'artemis_apply_screenshot',
    description: 'Capture a full-page screenshot of the filled application form for user review. Optionally fill custom question answers first.',
    parameters: {
      application_id: { type: 'string', description: 'Application ID', required: true },
      custom_answers_json: { type: 'string', description: 'JSON array of {selector, answer} for custom questions' },
    },
    execute: async (_id, params) => {
      const applicationId = params.application_id as string;

      if (!activeFiller || activeApplicationId !== applicationId) {
        return text({ content: '', error: `No active browser session for application ${applicationId}. Run artemis_apply_fill first.` });
      }

      // Fill custom answers if provided
      if (params.custom_answers_json) {
        try {
          const answers = JSON.parse(params.custom_answers_json as string);
          await activeFiller.fillCustomAnswers(answers);
        } catch {}
      }

      const screenshotPath = await activeFiller.screenshot(applicationId);

      db.updateApplicationMaterials(applicationId, { screenshot_path: screenshotPath });

      return text({
        content: [
          `**Screenshot captured:** ${screenshotPath}`,
          '',
          'Post this screenshot to **#daily-job-report** for user review.',
          '',
          'Ask the user: "Review this application. Reply **approve** to submit, or tell me what to change."',
          '',
          'On approval → call `artemis_apply_submit`',
          'On changes → adjust and re-screenshot',
        ].join('\n'),
      });
    },
  });

  api.registerTool({
    name: 'artemis_apply_submit',
    description: 'Click the submit button on the application form. ONLY call this after the user has reviewed the screenshot and explicitly approved.',
    parameters: {
      application_id: { type: 'string', description: 'Application ID', required: true },
    },
    execute: async (_id, params) => {
      const applicationId = params.application_id as string;

      if (!activeFiller || activeApplicationId !== applicationId) {
        return text({ content: '', error: `No active browser session for application ${applicationId}.` });
      }

      try {
        await activeFiller.submit();

        db.updateApplicationStatus(applicationId, 'submitted');

        const app = db.getApplication(applicationId);
        if (app) {
          db.updateJobPostingStatus(app.job_id, 'applied');
        }

        await activeFiller.close();
        activeFiller = null;
        activeApplicationId = null;

        return text({
          content: [
            '**Application submitted!**',
            '',
            `Application ${applicationId.slice(0, 8)} has been submitted.`,
            'Status updated to: submitted.',
            '',
            'I will monitor your application email for responses.',
          ].join('\n'),
        });
      } catch (err) {
        return text({ content: '', error: `Submit failed: ${err instanceof Error ? err.message : String(err)}. The browser is still open — you can try again or cancel.` });
      }
    },
  });

  api.registerTool({
    name: 'artemis_apply_cancel',
    description: 'Cancel a pending application. Closes the browser and cleans up.',
    parameters: {
      application_id: { type: 'string', description: 'Application ID', required: true },
    },
    execute: async (_id, params) => {
      const applicationId = params.application_id as string;

      if (activeFiller && activeApplicationId === applicationId) {
        await activeFiller.close();
        activeFiller = null;
        activeApplicationId = null;
      }

      const screenshotter = new Screenshotter();
      screenshotter.remove(applicationId);

      db.updateApplicationStatus(applicationId, 'withdrawn');

      return text({ content: `Application ${applicationId.slice(0, 8)} cancelled. Browser closed and screenshot cleaned up.` });
    },
  });

  // ── Credential Tools ────────────────────────────────────────────────────

  api.registerTool({
    name: 'artemis_credential_set',
    description: 'Store encrypted credentials for ATS platform login or application email.',
    parameters: {
      label: { type: 'string', description: 'Label, e.g. "Application Email" or "Greenhouse Login"', required: true },
      email: { type: 'string', description: 'Email address', required: true },
      password: { type: 'string', description: 'Password (will be encrypted at rest)', required: true },
      provider: { type: 'string', description: 'Provider type', required: true, enum: ['email', 'greenhouse', 'lever', 'workday', 'custom'] },
    },
    execute: async (_id, params) => {
      const encryptedPassword = encrypt(params.password as string);
      const cred = db.createCredential(
        params.label as string,
        params.email as string,
        encryptedPassword,
        params.provider as string
      );

      return text({
        content: [
          '**Credential stored** (encrypted)',
          `- **Label:** ${cred.label}`,
          `- **Email:** ${cred.email}`,
          `- **Provider:** ${cred.provider}`,
          `- **ID:** ${cred.id.slice(0, 8)}`,
        ].join('\n'),
      });
    },
  });

  api.registerTool({
    name: 'artemis_credential_list',
    description: 'List stored credentials (email addresses only — passwords are never shown).',
    parameters: {},
    execute: async () => {
      const creds = db.getAllCredentials();
      if (creds.length === 0) {
        return text({ content: 'No credentials stored. Use `artemis_credential_set` to add your application email or ATS login.' });
      }

      const lines = [`**${creds.length} credential(s):**`, ''];
      for (const c of creds) {
        lines.push(`- **${c.label}** (${c.provider}) — ${c.email} [ID: ${c.id.slice(0, 8)}]`);
      }
      return text({ content: lines.join('\n') });
    },
  });
}
