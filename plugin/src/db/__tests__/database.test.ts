import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtemisDB } from '../database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_VAULT = path.join(os.tmpdir(), 'artemis-test-vault-' + Date.now());

let db: ArtemisDB;

beforeEach(() => {
  fs.mkdirSync(TEST_VAULT, { recursive: true });
  db = new ArtemisDB(TEST_VAULT);
});

afterEach(() => {
  db.close();
  fs.rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('ArtemisDB', () => {
  describe('introspection', () => {
    it('lists all tables', () => {
      const tables = db.listTables();
      expect(tables).toContain('companies');
      expect(tables).toContain('job_postings');
      expect(tables).toContain('applications');
      expect(tables).toContain('credentials');
      expect(tables).toContain('scan_logs');
      expect(tables).toContain('daily_reports');
      expect(tables).toContain('email_messages');
      expect(tables).toHaveLength(7);
    });
  });

  describe('companies', () => {
    it('creates a company', () => {
      const company = db.createCompany('Google', 'https://careers.google.com');
      expect(company.name).toBe('Google');
      expect(company.careers_url).toBe('https://careers.google.com');
      expect(company.is_active).toBe(true);
      expect(company.id).toBeTruthy();
      expect(company.added_at).toBeTruthy();
    });

    it('gets a company by id', () => {
      const created = db.createCompany('Stripe', 'https://stripe.com/jobs');
      const found = db.getCompany(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Stripe');
    });

    it('returns undefined for unknown id', () => {
      expect(db.getCompany('nonexistent')).toBeUndefined();
    });

    it('lists all companies sorted by name', () => {
      db.createCompany('Stripe', 'https://stripe.com/jobs');
      db.createCompany('Google', 'https://careers.google.com');
      db.createCompany('Meta', 'https://metacareers.com');

      const all = db.getAllCompanies();
      expect(all).toHaveLength(3);
      expect(all[0].name).toBe('Google');
      expect(all[1].name).toBe('Meta');
      expect(all[2].name).toBe('Stripe');
    });

    it('lists active companies only', () => {
      const c1 = db.createCompany('Active Co', 'https://active.com/jobs');
      const c2 = db.createCompany('Paused Co', 'https://paused.com/jobs');
      db.updateCompany(c2.id, { is_active: false });

      const active = db.getActiveCompanies();
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe('Active Co');
    });

    it('updates company fields', () => {
      const company = db.createCompany('Old Name', 'https://old.com/jobs');
      db.updateCompany(company.id, { name: 'New Name', careers_url: 'https://new.com/careers' });

      const updated = db.getCompany(company.id)!;
      expect(updated.name).toBe('New Name');
      expect(updated.careers_url).toBe('https://new.com/careers');
    });

    it('toggles active status', () => {
      const company = db.createCompany('Toggle Co', 'https://toggle.com');
      expect(company.is_active).toBe(true);

      db.updateCompany(company.id, { is_active: false });
      expect(db.getCompany(company.id)!.is_active).toBe(false);

      db.updateCompany(company.id, { is_active: true });
      expect(db.getCompany(company.id)!.is_active).toBe(true);
    });

    it('removes a company', () => {
      const company = db.createCompany('Remove Me', 'https://remove.com');
      expect(db.getCompany(company.id)).toBeDefined();

      db.removeCompany(company.id);
      expect(db.getCompany(company.id)).toBeUndefined();
      expect(db.getAllCompanies()).toHaveLength(0);
    });
  });

  describe('job postings', () => {
    it('creates a job posting linked to a company', () => {
      const company = db.createCompany('Google', 'https://careers.google.com');
      const job = db.createJobPosting(company.id, 'Senior SWE', 'https://google.com/jobs/123', 'Build cool stuff', 'abc123', {
        level: 'senior',
        salary_range: '$180K-$240K',
        location: 'Remote',
        requirements_summary: 'Go, Kubernetes, 5+ years',
      });

      expect(job.title).toBe('Senior SWE');
      expect(job.company_id).toBe(company.id);
      expect(job.status).toBe('new');
      expect(job.confidence_score).toBeNull();
      expect(job.level).toBe('senior');
      expect(job.salary_range).toBe('$180K-$240K');
      expect(job.content_hash).toBe('abc123');
    });

    it('gets job postings by company', () => {
      const c1 = db.createCompany('Google', 'https://careers.google.com');
      const c2 = db.createCompany('Stripe', 'https://stripe.com/jobs');
      db.createJobPosting(c1.id, 'SWE', 'https://google.com/1', 'text', 'h1');
      db.createJobPosting(c1.id, 'SRE', 'https://google.com/2', 'text', 'h2');
      db.createJobPosting(c2.id, 'Backend', 'https://stripe.com/1', 'text', 'h3');

      expect(db.getJobPostingsByCompany(c1.id)).toHaveLength(2);
      expect(db.getJobPostingsByCompany(c2.id)).toHaveLength(1);
    });

    it('gets job postings by status', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const j1 = db.createJobPosting(company.id, 'Job 1', 'https://co.com/1', 't', 'h1');
      db.createJobPosting(company.id, 'Job 2', 'https://co.com/2', 't', 'h2');

      db.updateJobPostingStatus(j1.id, 'seen');
      expect(db.getJobPostingsByStatus('new')).toHaveLength(1);
      expect(db.getJobPostingsByStatus('seen')).toHaveLength(1);
    });

    it('updates score', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 't', 'h1');

      db.updateJobPostingScore(job.id, 85, '{"skills":90,"level":80}');
      const updated = db.getJobPosting(job.id)!;
      expect(updated.confidence_score).toBe(85);
      expect(updated.score_breakdown).toBe('{"skills":90,"level":80}');
    });

    it('filters by min_score', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const j1 = db.createJobPosting(company.id, 'High', 'https://co.com/1', 't', 'h1');
      const j2 = db.createJobPosting(company.id, 'Low', 'https://co.com/2', 't', 'h2');

      db.updateJobPostingScore(j1.id, 85, '{}');
      db.updateJobPostingScore(j2.id, 40, '{}');

      const high = db.getAllJobPostings({ min_score: 60 });
      expect(high).toHaveLength(1);
      expect(high[0].title).toBe('High');
    });

    it('updates content and detects change', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 'original', 'h1');
      expect(job.last_changed_at).toBeNull();

      db.updateJobPostingContent(job.id, 'updated text', 'h2');
      const updated = db.getJobPosting(job.id)!;
      expect(updated.content_hash).toBe('h2');
      expect(updated.last_changed_at).toBeTruthy();
      expect(updated.raw_text).toBe('updated text');
    });
  });

  describe('applications', () => {
    it('creates an application linked to a job', () => {
      const company = db.createCompany('Google', 'https://careers.google.com');
      const job = db.createJobPosting(company.id, 'SWE', 'https://google.com/1', 'text', 'h1');
      const app = db.createApplication(job.id);

      expect(app.job_id).toBe(job.id);
      expect(app.status).toBe('draft');
      expect(app.applied_at).toBeNull();
      expect(app.resume_version).toBeNull();
      expect(app.cover_letter).toBeNull();
    });

    it('updates application status', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 't', 'h1');
      const app = db.createApplication(job.id);

      db.updateApplicationStatus(app.id, 'submitted');
      const updated = db.getApplication(app.id)!;
      expect(updated.status).toBe('submitted');
      expect(updated.applied_at).toBeTruthy();
    });

    it('filters applications by status', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const j1 = db.createJobPosting(company.id, 'Job 1', 'https://co.com/1', 't', 'h1');
      const j2 = db.createJobPosting(company.id, 'Job 2', 'https://co.com/2', 't', 'h2');

      const a1 = db.createApplication(j1.id);
      db.createApplication(j2.id);

      db.updateApplicationStatus(a1.id, 'submitted');
      expect(db.getAllApplications({ status: 'submitted' })).toHaveLength(1);
      expect(db.getAllApplications({ status: 'draft' })).toHaveLength(1);
    });

    it('stores materials', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 't', 'h1');
      const app = db.createApplication(job.id);

      db.updateApplicationMaterials(app.id, {
        resume_version: '# John Doe\nSenior SWE...',
        cover_letter: 'Dear Hiring Manager...',
        screenshot_path: '/tmp/screenshot.png',
      });

      const updated = db.getApplication(app.id)!;
      expect(updated.resume_version).toContain('John Doe');
      expect(updated.cover_letter).toContain('Dear Hiring Manager');
      expect(updated.screenshot_path).toBe('/tmp/screenshot.png');
    });
  });

  describe('credentials', () => {
    it('creates and retrieves a credential', () => {
      const cred = db.createCredential('Application Email', 'jobs@example.com', 'encrypted_blob_123', 'email');

      expect(cred.label).toBe('Application Email');
      expect(cred.email).toBe('jobs@example.com');
      expect(cred.encrypted_password).toBe('encrypted_blob_123');
      expect(cred.provider).toBe('email');
    });

    it('lists all credentials', () => {
      db.createCredential('Email', 'a@b.com', 'enc1', 'email');
      db.createCredential('Greenhouse', 'a@b.com', 'enc2', 'greenhouse');

      const all = db.getAllCredentials();
      expect(all).toHaveLength(2);
    });
  });

  describe('scan logs', () => {
    it('creates a scan log', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const log = db.createScanLog(company.id, 15, 3, 1);

      expect(log.company_id).toBe(company.id);
      expect(log.jobs_found).toBe(15);
      expect(log.new_jobs).toBe(3);
      expect(log.changed_jobs).toBe(1);
      expect(log.errors).toBeNull();
    });

    it('creates a full-scan log (null company)', () => {
      const log = db.createScanLog(null, 50, 10, 5, 'Timeout on one page');
      expect(log.company_id).toBeNull();
      expect(log.errors).toBe('Timeout on one page');
    });

    it('gets recent scan logs', () => {
      db.createScanLog(null, 10, 1, 0);
      db.createScanLog(null, 20, 2, 1);
      db.createScanLog(null, 30, 3, 2);

      const recent = db.getRecentScanLogs(2);
      expect(recent).toHaveLength(2);
    });

    it('gets scan logs by company', () => {
      const c1 = db.createCompany('Co1', 'https://co1.com');
      const c2 = db.createCompany('Co2', 'https://co2.com');
      db.createScanLog(c1.id, 5, 1, 0);
      db.createScanLog(c1.id, 6, 0, 1);
      db.createScanLog(c2.id, 3, 1, 0);

      expect(db.getScanLogsByCompany(c1.id)).toHaveLength(2);
      expect(db.getScanLogsByCompany(c2.id)).toHaveLength(1);
    });
  });

  describe('daily reports', () => {
    it('creates a daily report', () => {
      const report = db.createDailyReport('2026-03-17', 5, 2, 'New: 5 jobs found across 3 companies');

      expect(report.date).toBe('2026-03-17');
      expect(report.new_jobs_count).toBe(5);
      expect(report.changed_jobs_count).toBe(2);
      expect(report.report_content).toContain('5 jobs found');
    });

    it('gets report by date', () => {
      db.createDailyReport('2026-03-17', 5, 2, 'content');
      const found = db.getDailyReportByDate('2026-03-17');
      expect(found).toBeDefined();
      expect(found!.date).toBe('2026-03-17');
    });

    it('returns undefined for missing date', () => {
      expect(db.getDailyReportByDate('2099-01-01')).toBeUndefined();
    });

    it('gets recent reports', () => {
      db.createDailyReport('2026-03-15', 3, 1, 'day 1');
      db.createDailyReport('2026-03-16', 4, 0, 'day 2');
      db.createDailyReport('2026-03-17', 5, 2, 'day 3');

      const recent = db.getRecentReports(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].date).toBe('2026-03-17');
      expect(recent[1].date).toBe('2026-03-16');
    });
  });

  describe('email messages', () => {
    it('creates an email message linked to an application', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 't', 'h1');
      const app = db.createApplication(job.id);

      const email = db.createEmailMessage(
        app.id,
        'recruiter@co.com',
        'Thank you for applying',
        'We received your application and will review it shortly.',
        'acknowledgment'
      );

      expect(email.application_id).toBe(app.id);
      expect(email.from).toBe('recruiter@co.com');
      expect(email.classification).toBe('acknowledgment');
      expect(email.body_preview).toContain('received your application');
    });

    it('creates an unmatched email', () => {
      const email = db.createEmailMessage(null, 'unknown@co.com', 'Newsletter', 'Latest news...', 'other');
      expect(email.application_id).toBeNull();
    });

    it('gets emails by application', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 't', 'h1');
      const app = db.createApplication(job.id);

      db.createEmailMessage(app.id, 'a@co.com', 'Ack', 'Thanks', 'acknowledgment');
      db.createEmailMessage(app.id, 'b@co.com', 'Interview', 'Schedule', 'interview_request');
      db.createEmailMessage(null, 'c@other.com', 'Spam', 'Buy now', 'other');

      expect(db.getEmailsByApplication(app.id)).toHaveLength(2);
    });

    it('gets recent emails', () => {
      db.createEmailMessage(null, 'a@co.com', 'Sub 1', 'body', 'other');
      db.createEmailMessage(null, 'b@co.com', 'Sub 2', 'body', 'other');
      db.createEmailMessage(null, 'c@co.com', 'Sub 3', 'body', 'other');

      const recent = db.getRecentEmails(2);
      expect(recent).toHaveLength(2);
    });
  });
});
