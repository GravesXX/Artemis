import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EmailClassifier } from '../classifier.js';
import type { RawEmail } from '../monitor.js';
import { ArtemisDB } from '../../db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_VAULT = path.join(os.tmpdir(), 'artemis-classifier-test-' + Date.now());

let db: ArtemisDB;
let classifier: EmailClassifier;

beforeEach(() => {
  fs.mkdirSync(TEST_VAULT, { recursive: true });
  db = new ArtemisDB(TEST_VAULT);
  classifier = new EmailClassifier(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TEST_VAULT, { recursive: true, force: true });
});

function makeEmail(overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    uid: 1,
    from: 'recruiter@google.com',
    subject: 'Your Application',
    date: '2026-03-19T10:00:00.000Z',
    bodyPreview: '',
    messageId: '<test@mail>',
    ...overrides,
  };
}

describe('EmailClassifier', () => {
  describe('classify', () => {
    it('classifies acknowledgment emails', () => {
      const email = makeEmail({
        subject: 'Thank you for applying to Google',
        bodyPreview: 'We have received your application and will review it shortly.',
      });
      const result = classifier.classify(email);
      expect(result.classification).toBe('acknowledgment');
      expect(result.statusUpdate).toBe('acknowledged');
    });

    it('classifies rejection emails', () => {
      const email = makeEmail({
        subject: 'Update on your application',
        bodyPreview: 'Unfortunately, we have decided not to move forward with your application at this time.',
      });
      const result = classifier.classify(email);
      expect(result.classification).toBe('rejection');
      expect(result.statusUpdate).toBe('rejected');
    });

    it('classifies interview request emails', () => {
      const email = makeEmail({
        subject: 'Interview Invitation - Software Engineer',
        bodyPreview: 'We would like to invite you for a technical interview. Please let us know your availability.',
      });
      const result = classifier.classify(email);
      expect(result.classification).toBe('interview_request');
      expect(result.statusUpdate).toBe('interview');
    });

    it('classifies offer emails', () => {
      const email = makeEmail({
        subject: 'Offer Letter - Software Engineer at Google',
        bodyPreview: 'We are pleased to offer you the position. Please find the compensation package attached.',
      });
      const result = classifier.classify(email);
      expect(result.classification).toBe('offer');
      expect(result.statusUpdate).toBe('offer');
    });

    it('classifies unrecognized emails as other', () => {
      const email = makeEmail({
        subject: 'Weekly newsletter',
        bodyPreview: 'Check out our latest blog posts and updates.',
      });
      const result = classifier.classify(email);
      expect(result.classification).toBe('other');
      expect(result.statusUpdate).toBeNull();
    });

    it('classifies interview when multiple interview signals present', () => {
      const email = makeEmail({
        subject: 'Interview Invitation - Next Steps',
        bodyPreview: 'We would like to invite you for a technical interview. Please schedule your phone screen at your earliest convenience.',
      });
      const result = classifier.classify(email);
      expect(result.classification).toBe('interview_request');
    });
  });

  describe('matchToApplication', () => {
    it('matches email to application by sender domain', () => {
      const company = db.createCompany('Google', 'https://careers.google.com');
      const job = db.createJobPosting(company.id, 'SWE', 'https://careers.google.com/jobs/1', 'text', 'h1');
      const app = db.createApplication(job.id);
      db.updateApplicationStatus(app.id, 'submitted');

      const email = makeEmail({ from: 'recruiter@google.com' });
      const match = classifier.matchToApplication(email);

      expect(match).not.toBeNull();
      expect(match!.companyName).toBe('Google');
      expect(match!.applicationId).toBe(app.id);
    });

    it('returns null for unmatched sender', () => {
      const email = makeEmail({ from: 'newsletter@random.com' });
      const match = classifier.matchToApplication(email);
      expect(match).toBeNull();
    });

    it('does not match draft applications', () => {
      const company = db.createCompany('Google', 'https://careers.google.com');
      const job = db.createJobPosting(company.id, 'SWE', 'https://google.com/1', 'text', 'h1');
      db.createApplication(job.id); // stays in draft

      const email = makeEmail({ from: 'recruiter@google.com' });
      const match = classifier.matchToApplication(email);
      expect(match).toBeNull();
    });

    it('matches by subject containing company name', () => {
      const company = db.createCompany('Stripe', 'https://stripe.com/jobs');
      const job = db.createJobPosting(company.id, 'Backend SWE', 'https://stripe.com/jobs/1', 'text', 'h1');
      const app = db.createApplication(job.id);
      db.updateApplicationStatus(app.id, 'submitted');

      const email = makeEmail({
        from: 'noreply@notifications.stripe.com',
        subject: 'Stripe: Your application update',
      });
      const match = classifier.matchToApplication(email);
      expect(match).not.toBeNull();
      expect(match!.companyName).toBe('Stripe');
    });

    it('picks most relevant match when multiple applications exist', () => {
      const c1 = db.createCompany('Google', 'https://careers.google.com');
      const c2 = db.createCompany('Meta', 'https://metacareers.com');

      const j1 = db.createJobPosting(c1.id, 'SWE', 'https://google.com/1', 'text', 'h1');
      const j2 = db.createJobPosting(c2.id, 'SWE', 'https://meta.com/1', 'text', 'h2');

      const a1 = db.createApplication(j1.id);
      const a2 = db.createApplication(j2.id);
      db.updateApplicationStatus(a1.id, 'submitted');
      db.updateApplicationStatus(a2.id, 'submitted');

      const email = makeEmail({ from: 'recruiter@google.com' });
      const match = classifier.matchToApplication(email);
      expect(match!.companyName).toBe('Google');
    });
  });
});
