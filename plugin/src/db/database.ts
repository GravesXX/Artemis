import { v4 as uuidv4 } from 'uuid';
import { ObsidianAdapter } from 'obsidian-adapter';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  name: string;
  careers_url: string;
  is_active: boolean;
  added_at: string;
}

export interface JobPosting {
  id: string;
  company_id: string;
  title: string;
  url: string;
  level: string | null;
  salary_range: string | null;
  location: string | null;
  requirements_summary: string;
  raw_text: string;
  content_hash: string;
  confidence_score: number | null;
  score_breakdown: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string | null;
}

export interface Application {
  id: string;
  job_id: string;
  status: string;
  resume_version: string | null;
  cover_letter: string | null;
  screenshot_path: string | null;
  applied_at: string | null;
  last_status_change: string;
  notes: string | null;
}

export interface Credential {
  id: string;
  label: string;
  email: string;
  encrypted_password: string;
  provider: string;
  created_at: string;
}

export interface ScanLog {
  id: string;
  company_id: string | null;
  scanned_at: string;
  jobs_found: number;
  new_jobs: number;
  changed_jobs: number;
  errors: string | null;
}

export interface DailyReport {
  id: string;
  date: string;
  new_jobs_count: number;
  changed_jobs_count: number;
  report_content: string;
  generated_at: string;
}

export interface EmailMessage {
  id: string;
  application_id: string | null;
  from: string;
  subject: string;
  body_preview: string;
  received_at: string;
  classification: string;
}

// ── ArtemisDB Class ─────────────────────────────────────────────────────────

export class ArtemisDB {
  private adapter: ObsidianAdapter;

  constructor(vaultPath: string) {
    this.adapter = new ObsidianAdapter(vaultPath, 'Agents/Artemis');

    this.adapter.ensureFolder('Companies');
    this.adapter.ensureFolder('Job Postings');
    this.adapter.ensureFolder('Applications');
    this.adapter.ensureFolder('Credentials');
    this.adapter.ensureFolder('Scan Logs');
    this.adapter.ensureFolder('Reports');
    this.adapter.ensureFolder('Emails');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  close(): void {
    // No-op for Obsidian adapter
  }

  // ── Introspection ───────────────────────────────────────────────────────

  listTables(): string[] {
    return ['companies', 'job_postings', 'applications', 'credentials', 'scan_logs', 'daily_reports', 'email_messages'];
  }

  // ── Companies ─────────────────────────────────────────────────────────

  createCompany(name: string, careersUrl: string): Company {
    const id = uuidv4();
    const now = new Date().toISOString();
    const filename = `${this.adapter.sanitize(name)} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote('Companies', filename, {
      id,
      type: 'artemis-company',
      name,
      careers_url: careersUrl,
      is_active: true,
      added_at: now,
      tags: ['artemis', 'company'],
    }, `# ${name}\n\n**Careers URL:** ${careersUrl}\n`);

    return this.getCompany(id)!;
  }

  getCompany(id: string): Company | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-company') return undefined;
    return this.companyFromEntry(entry);
  }

  getAllCompanies(): Company[] {
    return this.adapter.findByType('artemis-company')
      .map(e => this.companyFromEntry(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getActiveCompanies(): Company[] {
    return this.adapter.findByType('artemis-company')
      .filter(e => e.frontmatter.is_active === true)
      .map(e => this.companyFromEntry(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  updateCompany(id: string, updates: { name?: string; careers_url?: string; is_active?: boolean }): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;

    const fm: Record<string, unknown> = {};
    if (updates.name !== undefined) fm.name = updates.name;
    if (updates.careers_url !== undefined) fm.careers_url = updates.careers_url;
    if (updates.is_active !== undefined) fm.is_active = updates.is_active;

    this.adapter.updateFrontmatter(entry.relativePath, fm);
  }

  removeCompany(id: string): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;
    this.adapter.deleteNote(entry.relativePath);
  }

  // ── Job Postings ──────────────────────────────────────────────────────

  createJobPosting(
    companyId: string,
    title: string,
    url: string,
    rawText: string,
    contentHash: string,
    opts?: {
      level?: string;
      salary_range?: string;
      location?: string;
      requirements_summary?: string;
    }
  ): JobPosting {
    const id = uuidv4();
    const now = new Date().toISOString();

    const company = this.getCompany(companyId);
    const companyName = company ? this.adapter.sanitize(company.name) : companyId.slice(0, 8);
    const folder = `Job Postings/${companyName}`;
    this.adapter.ensureFolder(folder);

    const filename = `${this.adapter.sanitize(title)} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote(folder, filename, {
      id,
      type: 'artemis-job',
      company_id: companyId,
      title,
      url,
      level: opts?.level ?? null,
      salary_range: opts?.salary_range ?? null,
      location: opts?.location ?? null,
      requirements_summary: opts?.requirements_summary ?? '',
      content_hash: contentHash,
      confidence_score: null,
      score_breakdown: null,
      status: 'new',
      first_seen_at: now,
      last_seen_at: now,
      last_changed_at: null,
      tags: ['artemis', 'job'],
    }, `# ${title}\n\n**Company:** ${companyName}\n**URL:** ${url}\n\n## Raw Text\n\n${rawText}\n`);

    return this.getJobPosting(id)!;
  }

  getJobPosting(id: string): JobPosting | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-job') return undefined;
    return this.jobPostingFromEntry(entry);
  }

  getJobPostingByUrl(url: string): JobPosting | undefined {
    const entry = this.adapter.findByType('artemis-job')
      .find(e => e.frontmatter.url === url);
    if (!entry) return undefined;
    return this.jobPostingFromEntry(entry);
  }

  getJobPostingsByCompany(companyId: string): JobPosting[] {
    return this.adapter.findByType('artemis-job')
      .filter(e => e.frontmatter.company_id === companyId)
      .map(e => this.jobPostingFromEntry(e))
      .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at));
  }

  getJobPostingsByStatus(status: string): JobPosting[] {
    return this.adapter.findByType('artemis-job')
      .filter(e => e.frontmatter.status === status)
      .map(e => this.jobPostingFromEntry(e))
      .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at));
  }

  getAllJobPostings(filters?: { company_id?: string; status?: string; min_score?: number }): JobPosting[] {
    let entries = this.adapter.findByType('artemis-job');

    if (filters?.company_id) {
      entries = entries.filter(e => e.frontmatter.company_id === filters.company_id);
    }
    if (filters?.status) {
      entries = entries.filter(e => e.frontmatter.status === filters.status);
    }
    if (filters?.min_score !== undefined) {
      entries = entries.filter(e => {
        const score = e.frontmatter.confidence_score as number | null;
        return score !== null && score >= filters.min_score!;
      });
    }

    return entries
      .map(e => this.jobPostingFromEntry(e))
      .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at));
  }

  updateJobPostingStatus(id: string, status: string): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;
    this.adapter.updateFrontmatter(entry.relativePath, { status });
  }

  updateJobPostingScore(id: string, score: number, breakdown: string): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;
    this.adapter.updateFrontmatter(entry.relativePath, {
      confidence_score: score,
      score_breakdown: breakdown,
    });
  }

  updateJobPostingLastSeen(id: string): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;
    this.adapter.updateFrontmatter(entry.relativePath, {
      last_seen_at: new Date().toISOString(),
    });
  }

  updateJobPostingContent(id: string, rawText: string, contentHash: string): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;

    const now = new Date().toISOString();
    this.adapter.updateFrontmatter(entry.relativePath, {
      content_hash: contentHash,
      last_changed_at: now,
      last_seen_at: now,
    });

    // Replace the raw text in the body
    const note = this.adapter.readNote(entry.relativePath);
    if (note) {
      const newBody = note.body.replace(
        /## Raw Text\n\n[\s\S]*$/,
        `## Raw Text\n\n${rawText}\n`
      );
      this.adapter.replaceBody(entry.relativePath, newBody);
    }
  }

  // ── Applications ──────────────────────────────────────────────────────

  createApplication(jobId: string): Application {
    const id = uuidv4();
    const now = new Date().toISOString();

    const job = this.getJobPosting(jobId);
    let companyName = 'Unknown';
    if (job) {
      const company = this.getCompany(job.company_id);
      companyName = company ? this.adapter.sanitize(company.name) : job.company_id.slice(0, 8);
    }

    const folder = `Applications/${companyName}`;
    this.adapter.ensureFolder(folder);

    const jobTitle = job ? this.adapter.sanitize(job.title) : jobId.slice(0, 8);
    const filename = `${jobTitle} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote(folder, filename, {
      id,
      type: 'artemis-application',
      job_id: jobId,
      status: 'draft',
      screenshot_path: null,
      applied_at: null,
      last_status_change: now,
      tags: ['artemis', 'application'],
    }, `# Application: ${job?.title ?? jobId}\n\n**Company:** ${companyName}\n**Status:** draft\n`);

    return this.getApplication(id)!;
  }

  getApplication(id: string): Application | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-application') return undefined;
    return this.applicationFromEntry(entry);
  }

  getAllApplications(filters?: { status?: string }): Application[] {
    let entries = this.adapter.findByType('artemis-application');

    if (filters?.status) {
      entries = entries.filter(e => e.frontmatter.status === filters.status);
    }

    return entries
      .map(e => this.applicationFromEntry(e))
      .sort((a, b) => b.last_status_change.localeCompare(a.last_status_change));
  }

  updateApplicationStatus(id: string, status: string, notes?: string): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;

    const updates: Record<string, unknown> = {
      status,
      last_status_change: new Date().toISOString(),
    };
    if (status === 'submitted') {
      updates.applied_at = new Date().toISOString();
    }

    this.adapter.updateFrontmatter(entry.relativePath, updates);

    if (notes) {
      this.adapter.appendToBody(entry.relativePath, `\n## Note — ${new Date().toISOString()}\n${notes}\n`);
    }
  }

  updateApplicationMaterials(id: string, updates: {
    resume_version?: string;
    cover_letter?: string;
    screenshot_path?: string;
  }): void {
    const entry = this.adapter.findById(id);
    if (!entry) return;

    if (updates.screenshot_path !== undefined) {
      this.adapter.updateFrontmatter(entry.relativePath, {
        screenshot_path: updates.screenshot_path,
      });
    }

    if (updates.resume_version) {
      const note = this.adapter.readNote(entry.relativePath);
      if (note && !note.body.includes('## Resume')) {
        this.adapter.appendToBody(entry.relativePath, `\n## Resume\n\n${updates.resume_version}\n`);
      }
    }

    if (updates.cover_letter) {
      const note = this.adapter.readNote(entry.relativePath);
      if (note && !note.body.includes('## Cover Letter')) {
        this.adapter.appendToBody(entry.relativePath, `\n## Cover Letter\n\n${updates.cover_letter}\n`);
      }
    }
  }

  // ── Credentials ───────────────────────────────────────────────────────

  createCredential(label: string, email: string, encryptedPassword: string, provider: string): Credential {
    const id = uuidv4();
    const now = new Date().toISOString();
    const filename = `${this.adapter.sanitize(label)} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote('Credentials', filename, {
      id,
      type: 'artemis-credential',
      label,
      email,
      encrypted_password: encryptedPassword,
      provider,
      created_at: now,
      tags: ['artemis', 'credential'],
    }, `# Credential: ${label}\n\n**Email:** ${email}\n**Provider:** ${provider}\n`);

    return this.getCredential(id)!;
  }

  getCredential(id: string): Credential | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-credential') return undefined;
    return this.credentialFromEntry(entry);
  }

  getAllCredentials(): Credential[] {
    return this.adapter.findByType('artemis-credential')
      .map(e => this.credentialFromEntry(e))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // ── Scan Logs ─────────────────────────────────────────────────────────

  createScanLog(
    companyId: string | null,
    jobsFound: number,
    newJobs: number,
    changedJobs: number,
    errors?: string
  ): ScanLog {
    const id = uuidv4();
    const now = new Date().toISOString();
    const dateStr = now.slice(0, 10);
    const filename = `Scan ${dateStr} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote('Scan Logs', filename, {
      id,
      type: 'artemis-scan',
      company_id: companyId,
      scanned_at: now,
      jobs_found: jobsFound,
      new_jobs: newJobs,
      changed_jobs: changedJobs,
      errors: errors ?? null,
      tags: ['artemis', 'scan'],
    }, `# Scan Log — ${dateStr}\n\n**Jobs found:** ${jobsFound}\n**New:** ${newJobs}\n**Changed:** ${changedJobs}\n${errors ? `**Errors:** ${errors}\n` : ''}`);

    return this.getScanLog(id)!;
  }

  getScanLog(id: string): ScanLog | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-scan') return undefined;
    return this.scanLogFromEntry(entry);
  }

  getScanLogsByCompany(companyId: string): ScanLog[] {
    return this.adapter.findByType('artemis-scan')
      .filter(e => e.frontmatter.company_id === companyId)
      .map(e => this.scanLogFromEntry(e))
      .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
  }

  getRecentScanLogs(limit: number = 10): ScanLog[] {
    return this.adapter.findByType('artemis-scan')
      .map(e => this.scanLogFromEntry(e))
      .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))
      .slice(0, limit);
  }

  // ── Daily Reports ─────────────────────────────────────────────────────

  createDailyReport(
    date: string,
    newJobsCount: number,
    changedJobsCount: number,
    reportContent: string
  ): DailyReport {
    const id = uuidv4();
    const now = new Date().toISOString();
    const filename = `Report ${date} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote('Reports', filename, {
      id,
      type: 'artemis-report',
      date,
      new_jobs_count: newJobsCount,
      changed_jobs_count: changedJobsCount,
      generated_at: now,
      tags: ['artemis', 'report'],
    }, `# Daily Report — ${date}\n\n${reportContent}\n`);

    return this.getDailyReport(id)!;
  }

  getDailyReport(id: string): DailyReport | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-report') return undefined;
    return this.dailyReportFromEntry(entry);
  }

  getDailyReportByDate(date: string): DailyReport | undefined {
    const entry = this.adapter.findByType('artemis-report')
      .find(e => e.frontmatter.date === date);
    if (!entry) return undefined;
    return this.dailyReportFromEntry(entry);
  }

  getRecentReports(limit: number = 10): DailyReport[] {
    return this.adapter.findByType('artemis-report')
      .map(e => this.dailyReportFromEntry(e))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }

  // ── Email Messages ────────────────────────────────────────────────────

  createEmailMessage(
    applicationId: string | null,
    from: string,
    subject: string,
    bodyPreview: string,
    classification: string
  ): EmailMessage {
    const id = uuidv4();
    const now = new Date().toISOString();
    const dateStr = now.slice(0, 10);
    const filename = `Email ${dateStr} - ${this.adapter.shortId(id)}.md`;

    this.adapter.createNote('Emails', filename, {
      id,
      type: 'artemis-email',
      application_id: applicationId,
      from,
      subject,
      received_at: now,
      classification,
      tags: ['artemis', 'email'],
    }, `# Email — ${subject}\n\n**From:** ${from}\n**Classification:** ${classification}\n\n## Preview\n\n${bodyPreview}\n`);

    return this.getEmailMessage(id)!;
  }

  getEmailMessage(id: string): EmailMessage | undefined {
    const entry = this.adapter.findById(id);
    if (!entry || entry.frontmatter.type !== 'artemis-email') return undefined;
    return this.emailMessageFromEntry(entry);
  }

  getEmailsByApplication(applicationId: string): EmailMessage[] {
    return this.adapter.findByType('artemis-email')
      .filter(e => e.frontmatter.application_id === applicationId)
      .map(e => this.emailMessageFromEntry(e))
      .sort((a, b) => b.received_at.localeCompare(a.received_at));
  }

  getRecentEmails(limit: number = 20): EmailMessage[] {
    return this.adapter.findByType('artemis-email')
      .map(e => this.emailMessageFromEntry(e))
      .sort((a, b) => b.received_at.localeCompare(a.received_at))
      .slice(0, limit);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private companyFromEntry(entry: { frontmatter: Record<string, unknown> }): Company {
    const fm = entry.frontmatter;
    return {
      id: fm.id as string,
      name: fm.name as string,
      careers_url: fm.careers_url as string,
      is_active: fm.is_active as boolean,
      added_at: fm.added_at as string,
    };
  }

  private jobPostingFromEntry(entry: { relativePath: string; frontmatter: Record<string, unknown> }): JobPosting {
    const fm = entry.frontmatter;
    const note = this.adapter.readNote(entry.relativePath);

    let rawText = '';
    if (note) {
      const rawMatch = note.body.match(/## Raw Text\n\n([\s\S]*?)$/);
      rawText = rawMatch?.[1]?.trim() ?? '';
    }

    return {
      id: fm.id as string,
      company_id: fm.company_id as string,
      title: fm.title as string,
      url: fm.url as string,
      level: (fm.level as string) ?? null,
      salary_range: (fm.salary_range as string) ?? null,
      location: (fm.location as string) ?? null,
      requirements_summary: (fm.requirements_summary as string) ?? '',
      raw_text: rawText,
      content_hash: fm.content_hash as string,
      confidence_score: (fm.confidence_score as number) ?? null,
      score_breakdown: (fm.score_breakdown as string) ?? null,
      status: fm.status as string,
      first_seen_at: fm.first_seen_at as string,
      last_seen_at: fm.last_seen_at as string,
      last_changed_at: (fm.last_changed_at as string) ?? null,
    };
  }

  private applicationFromEntry(entry: { relativePath: string; frontmatter: Record<string, unknown> }): Application {
    const fm = entry.frontmatter;
    const note = this.adapter.readNote(entry.relativePath);

    let resumeVersion: string | null = null;
    let coverLetter: string | null = null;
    if (note) {
      const resumeMatch = note.body.match(/## Resume\n\n([\s\S]*?)(?=\n## |$)/);
      resumeVersion = resumeMatch?.[1]?.trim() ?? null;
      const clMatch = note.body.match(/## Cover Letter\n\n([\s\S]*?)(?=\n## |$)/);
      coverLetter = clMatch?.[1]?.trim() ?? null;
    }

    return {
      id: fm.id as string,
      job_id: fm.job_id as string,
      status: fm.status as string,
      resume_version: resumeVersion,
      cover_letter: coverLetter,
      screenshot_path: (fm.screenshot_path as string) ?? null,
      applied_at: (fm.applied_at as string) ?? null,
      last_status_change: fm.last_status_change as string,
      notes: null,
    };
  }

  private credentialFromEntry(entry: { frontmatter: Record<string, unknown> }): Credential {
    const fm = entry.frontmatter;
    return {
      id: fm.id as string,
      label: fm.label as string,
      email: fm.email as string,
      encrypted_password: fm.encrypted_password as string,
      provider: fm.provider as string,
      created_at: fm.created_at as string,
    };
  }

  private scanLogFromEntry(entry: { frontmatter: Record<string, unknown> }): ScanLog {
    const fm = entry.frontmatter;
    return {
      id: fm.id as string,
      company_id: (fm.company_id as string) ?? null,
      scanned_at: fm.scanned_at as string,
      jobs_found: fm.jobs_found as number,
      new_jobs: fm.new_jobs as number,
      changed_jobs: fm.changed_jobs as number,
      errors: (fm.errors as string) ?? null,
    };
  }

  private dailyReportFromEntry(entry: { relativePath: string; frontmatter: Record<string, unknown> }): DailyReport {
    const fm = entry.frontmatter;
    const note = this.adapter.readNote(entry.relativePath);

    let reportContent = '';
    if (note) {
      const lines = note.body.split('\n');
      const contentLines: string[] = [];
      let pastHeading = false;
      for (const line of lines) {
        if (!pastHeading && line.startsWith('# ')) {
          pastHeading = true;
          continue;
        }
        if (pastHeading) {
          contentLines.push(line);
        }
      }
      reportContent = contentLines.join('\n').trim();
    }

    return {
      id: fm.id as string,
      date: fm.date as string,
      new_jobs_count: fm.new_jobs_count as number,
      changed_jobs_count: fm.changed_jobs_count as number,
      report_content: reportContent,
      generated_at: fm.generated_at as string,
    };
  }

  private emailMessageFromEntry(entry: { relativePath: string; frontmatter: Record<string, unknown> }): EmailMessage {
    const fm = entry.frontmatter;
    const note = this.adapter.readNote(entry.relativePath);

    let bodyPreview = '';
    if (note) {
      const previewMatch = note.body.match(/## Preview\n\n([\s\S]*?)$/);
      bodyPreview = previewMatch?.[1]?.trim() ?? '';
    }

    return {
      id: fm.id as string,
      application_id: (fm.application_id as string) ?? null,
      from: fm.from as string,
      subject: fm.subject as string,
      body_preview: bodyPreview,
      received_at: fm.received_at as string,
      classification: fm.classification as string,
    };
  }
}
