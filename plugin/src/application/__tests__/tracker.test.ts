import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApplicationTracker } from '../tracker.js';
import { ArtemisDB } from '../../db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_VAULT = path.join(os.tmpdir(), 'artemis-tracker-test-' + Date.now());

let db: ArtemisDB;
let tracker: ApplicationTracker;

beforeEach(() => {
  fs.mkdirSync(TEST_VAULT, { recursive: true });
  db = new ArtemisDB(TEST_VAULT);
  tracker = new ApplicationTracker(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TEST_VAULT, { recursive: true, force: true });
});

describe('ApplicationTracker', () => {
  describe('getConversionFunnel', () => {
    it('returns zero counts with no applications', () => {
      const funnel = tracker.getConversionFunnel();
      expect(funnel.total).toBe(0);
      expect(funnel.submitted).toBe(0);
    });

    it('counts applications by status', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const j1 = db.createJobPosting(company.id, 'Job 1', 'https://co.com/1', 't', 'h1');
      const j2 = db.createJobPosting(company.id, 'Job 2', 'https://co.com/2', 't', 'h2');
      const j3 = db.createJobPosting(company.id, 'Job 3', 'https://co.com/3', 't', 'h3');

      db.createApplication(j1.id);
      const a2 = db.createApplication(j2.id);
      const a3 = db.createApplication(j3.id);

      db.updateApplicationStatus(a2.id, 'submitted');
      db.updateApplicationStatus(a3.id, 'submitted');
      db.updateApplicationStatus(a3.id, 'interview');

      const funnel = tracker.getConversionFunnel();
      expect(funnel.total).toBe(3);
      expect(funnel.draft).toBe(1);
      expect(funnel.submitted).toBe(1);
      expect(funnel.interview).toBe(1);
    });

    it('calculates conversion rates', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const j1 = db.createJobPosting(company.id, 'J1', 'https://co.com/1', 't', 'h1');
      const j2 = db.createJobPosting(company.id, 'J2', 'https://co.com/2', 't', 'h2');

      const a1 = db.createApplication(j1.id);
      const a2 = db.createApplication(j2.id);
      db.updateApplicationStatus(a1.id, 'submitted');
      db.updateApplicationStatus(a2.id, 'submitted');
      db.updateApplicationStatus(a1.id, 'interview');

      const funnel = tracker.getConversionFunnel();
      expect(funnel.rates.submitRate).toBe('100%');
      expect(funnel.rates.interviewRate).toBe('50%');
    });
  });

  describe('formatFunnel', () => {
    it('produces readable output', () => {
      const funnel = tracker.getConversionFunnel();
      const formatted = tracker.formatFunnel(funnel);
      expect(formatted).toContain('Application Analytics');
      expect(formatted).toContain('Conversion Rates');
    });
  });

  describe('getTimeline', () => {
    it('returns null for unknown application', () => {
      expect(tracker.getTimeline('nonexistent')).toBeNull();
    });

    it('builds a timeline with events', () => {
      const company = db.createCompany('Google', 'https://careers.google.com');
      const job = db.createJobPosting(company.id, 'SWE', 'https://google.com/1', 't', 'h1');
      const app = db.createApplication(job.id);
      db.updateApplicationStatus(app.id, 'submitted');

      db.createEmailMessage(app.id, 'recruiter@google.com', 'Thanks for applying', 'We received your application', 'acknowledgment');

      const timeline = tracker.getTimeline(app.id);
      expect(timeline).not.toBeNull();
      expect(timeline!.jobTitle).toBe('SWE');
      expect(timeline!.companyName).toBe('Google');
      expect(timeline!.events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('formatTimeline', () => {
    it('produces readable output', () => {
      const company = db.createCompany('Co', 'https://co.com');
      const job = db.createJobPosting(company.id, 'Job', 'https://co.com/1', 't', 'h1');
      const app = db.createApplication(job.id);

      const timeline = tracker.getTimeline(app.id)!;
      const formatted = tracker.formatTimeline(timeline);
      expect(formatted).toContain('Job — Co');
      expect(formatted).toContain('draft');
    });
  });
});
