# Artemis — The Huntress

## Design Specification v0.1.0

**Agent Role:** Automated job discovery, confidence scoring, daily reporting, and application submission with human-in-the-loop review.

**Named after:** Artemis, Greek goddess of the hunt — relentless, precise, and never misses her mark.

---

## 1. System Overview

Artemis is an OpenClaw plugin agent that automates the job search lifecycle:

1. **Hunt** — Scrape company career pages daily to discover new/changed/reposted software engineering roles
2. **Score** — Compare each role against the user's profile (via Athena's achievement bank, experiences, and skills) to produce a confidence score
3. **Report** — Post a structured daily report to Discord `#daily-job-report` at 9:00 AM ET
4. **Apply** — On user approval, coordinate with Athena for tailored resume + cover letter, auto-fill the application form via browser automation, screenshot for review, and submit on approval
5. **Track** — Monitor the application email for responses, track application lifecycle, and report outcomes

### Inter-Agent Communication

Artemis communicates with Athena via Discord mentions (`<@ATHENA_DISCORD_ID>`), following the established inter-agent protocol. This maintains the pattern used by Absolute and ensures Athena's tools are invoked through the proper channel rather than direct DB access.

**Data flow:**
```
Artemis                          Athena
   │                                │
   ├─── "Score this JD" ──────────►│
   │◄── achievement bank + match ───┤
   │                                │
   ├─── "Tailor resume for JD" ───►│
   │◄── tailored resume ───────────┤
   │                                │
   ├─── "Generate cover letter" ──►│
   │◄── tailored cover letter ─────┤
```

---

## 2. Project Structure

```
/Users/xiaguangwei/Desktop/Artemis/
├── plugin/
│   ├── src/
│   │   ├── index.ts                    # Entry point (exports id, name, register)
│   │   ├── types.ts                    # PluginAPI, ToolDefinition, McpToolResult, ParameterDef, ToolResult
│   │   ├── openclaw.plugin.json        # Plugin manifest
│   │   ├── db/
│   │   │   ├── database.ts             # ArtemisDB class (ObsidianAdapter)
│   │   │   └── __tests__/
│   │   │       └── database.test.ts
│   │   ├── hunting/                    # Job discovery domain
│   │   │   ├── scraper.ts              # Career page scraper (Playwright)
│   │   │   ├── differ.ts              # Job diff engine (new/changed/reposted detection)
│   │   │   ├── scorer.ts              # Confidence scoring against Athena profile
│   │   │   ├── reporter.ts            # Daily report generator (Discord markdown)
│   │   │   └── __tests__/
│   │   ├── application/               # Application submission domain
│   │   │   ├── filler.ts              # Form auto-fill via Playwright
│   │   │   ├── screenshotter.ts       # Screenshot capture for review
│   │   │   ├── tracker.ts             # Application lifecycle tracking
│   │   │   └── __tests__/
│   │   ├── email/                     # Email monitoring domain
│   │   │   ├── monitor.ts             # IMAP/API email polling
│   │   │   ├── classifier.ts          # Email classification (ack/rejection/interview/offer)
│   │   │   └── __tests__/
│   │   ├── tools/
│   │   │   ├── register.ts            # Central tool registration
│   │   │   ├── pool-tools.ts          # Company pool management (4 tools)
│   │   │   ├── hunt-tools.ts          # Scanning and discovery (4 tools)
│   │   │   ├── apply-tools.ts         # Application workflow (5 tools)
│   │   │   ├── track-tools.ts         # Tracking and analytics (4 tools)
│   │   │   ├── email-tools.ts         # Email monitoring (3 tools)
│   │   │   ├── credential-tools.ts    # Credential management (2 tools)
│   │   │   ├── report-tools.ts        # Report generation (2 tools)
│   │   │   └── helpers.ts             # MCP result wrappers (text/wrap)
│   │   └── skills/                    # Slash command definitions
│   │       ├── hunt.md
│   │       ├── apply.md
│   │       └── report.md
│   ├── package.json
│   ├── tsconfig.json
│   └── dist/
├── workspace/
│   ├── SOUL.md                        # Artemis persona and voice
│   ├── AGENTS.md                      # Operating instructions + tool reference
│   ├── IDENTITY.md                    # Name and tagline
│   └── USER.md                        # User context (auto-populated)
├── scripts/
│   └── daily-scan.sh                  # Script triggered by launchd at 9 AM ET
├── install.sh                         # Setup script (npm install, tsc, vitest, launchd)
├── README.md
└── docs/
    └── design-spec.md                 # This file
```

---

## 3. Plugin Manifest

```json
{
  "id": "artemis",
  "name": "Artemis - The Huntress",
  "version": "0.1.0",
  "description": "Automated job discovery, confidence scoring, daily reporting, and application submission with browser automation",
  "entry": "./index.ts",
  "skills": ["./skills"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

---

## 4. Entry Point

```typescript
// plugin/src/index.ts
import type { PluginAPI } from './types.js';
import { registerAllTools } from './tools/register.js';

export const id = 'artemis';
export const name = 'Artemis - The Huntress';

export function register(api: PluginAPI) {
  registerAllTools(api);
  console.log('[Artemis] Plugin loaded successfully');
}
```

---

## 5. Database Schema (ArtemisDB)

All entities stored via ObsidianAdapter under `Agents/Artemis/` in the vault.

### 5.1 Company (company pool)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| name | string | Company display name |
| careers_url | string | Career page URL to scrape |
| is_active | boolean | Whether to include in daily scans |
| added_at | string (ISO) | When added to pool |

**Folder:** `Companies/`
**Type tag:** `artemis-company`

### 5.2 JobPosting (discovered jobs)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| company_id | string | FK → Company |
| title | string | Job title |
| url | string | Direct link to posting |
| level | string \| null | Seniority (junior/mid/senior/staff/principal) |
| salary_range | string \| null | Salary info if available |
| location | string \| null | Location or "Remote" |
| requirements_summary | string | Short summary of key requirements |
| raw_text | string | Full extracted job description text |
| content_hash | string | SHA-256 of raw_text for change detection |
| confidence_score | number \| null | 0-100 score from scoring engine |
| score_breakdown | string \| null | JSON: per-dimension scores |
| status | string | new \| seen \| applied \| closed |
| first_seen_at | string (ISO) | When first discovered |
| last_seen_at | string (ISO) | Last time seen in a scan |
| last_changed_at | string (ISO) \| null | When content changed (repost detection) |

**Folder:** `Job Postings/{CompanyName}/`
**Type tag:** `artemis-job`

### 5.3 Application (application tracking)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| job_id | string | FK → JobPosting |
| status | string | draft \| pending_review \| submitted \| acknowledged \| rejected \| phone_screen \| interview \| offer \| withdrawn |
| resume_version | string \| null | Tailored resume text used |
| cover_letter | string \| null | Generated cover letter text |
| screenshot_path | string \| null | Local path to pre-submit screenshot |
| applied_at | string (ISO) \| null | When submitted |
| last_status_change | string (ISO) | Last status update |
| notes | string \| null | Free-form notes |

**Folder:** `Applications/{CompanyName}/`
**Type tag:** `artemis-application`

### 5.4 Credential (encrypted auth)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| label | string | Human-readable label (e.g., "Application Email", "Greenhouse Login") |
| email | string | Email address |
| encrypted_password | string | AES-256-GCM encrypted password |
| provider | string | email \| greenhouse \| lever \| workday \| custom |
| created_at | string (ISO) | When stored |

**Folder:** `Credentials/`
**Type tag:** `artemis-credential`
**Security:** Password encrypted using machine-specific key derived from macOS Keychain. The Obsidian note stores only the encrypted blob — never plaintext.

### 5.5 ScanLog (scraping history)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| company_id | string \| null | Null for full scans |
| scanned_at | string (ISO) | When scan ran |
| jobs_found | number | Total jobs on page |
| new_jobs | number | Newly discovered |
| changed_jobs | number | Content changed since last scan |
| errors | string \| null | Error details if any |

**Folder:** `Scan Logs/`
**Type tag:** `artemis-scan`

### 5.6 DailyReport (generated reports)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| date | string | YYYY-MM-DD |
| new_jobs_count | number | New jobs found |
| changed_jobs_count | number | Changed/reposted jobs |
| report_content | string | Full markdown report text |
| generated_at | string (ISO) | When generated |

**Folder:** `Reports/`
**Type tag:** `artemis-report`

### 5.7 EmailMessage (monitored responses)

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Primary key |
| application_id | string \| null | FK → Application (null if unmatched) |
| from | string | Sender email |
| subject | string | Email subject |
| body_preview | string | First 500 chars |
| received_at | string (ISO) | When received |
| classification | string | acknowledgment \| rejection \| interview_request \| offer \| other |

**Folder:** `Emails/`
**Type tag:** `artemis-email`

---

## 6. Tool Inventory (~24 tools)

### 6.1 Pool Management Tools (4)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_company_add` | Add company to hunting pool | name, careers_url |
| `artemis_company_remove` | Remove company from pool | company_id |
| `artemis_company_list` | List all companies with scan stats | (none) |
| `artemis_company_update` | Update company info or toggle active | company_id, name?, careers_url?, is_active? |

### 6.2 Hunt Tools (4)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_scan_all` | Scan all active companies, diff against known jobs, score new finds | (none) |
| `artemis_scan_company` | Scan a single company | company_id |
| `artemis_job_list` | List discovered jobs with filters | company_id?, status?, min_score? |
| `artemis_job_detail` | Show full details + score breakdown for a job | job_id |

### 6.3 Report Tools (2)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_report_generate` | Generate and post daily report to Discord | date? (defaults to today) |
| `artemis_report_history` | View past reports | limit? |

### 6.4 Application Tools (5)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_apply_prepare` | Coordinate with Athena: tailor resume + cover letter for job | job_id |
| `artemis_apply_fill` | Open browser, navigate to application, auto-fill form | application_id |
| `artemis_apply_screenshot` | Capture screenshot of filled form, send to Discord | application_id |
| `artemis_apply_submit` | Submit the application (after user approval) | application_id |
| `artemis_apply_cancel` | Cancel a pending application | application_id |

### 6.5 Tracking Tools (4)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_application_list` | List all applications with current status | status? |
| `artemis_application_update` | Manually update application status | application_id, status, notes? |
| `artemis_application_analytics` | Conversion funnel: applied → ack → interview → offer | (none) |
| `artemis_application_timeline` | Timeline view of a specific application | application_id |

### 6.6 Email Tools (3)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_email_setup` | Configure application email credentials | email, password, provider? |
| `artemis_email_check` | Poll for new responses, classify, match to applications | (none) |
| `artemis_email_report` | Summarize recent email activity | days? |

### 6.7 Credential Tools (2)

| Tool | Description | Parameters |
|------|-------------|------------|
| `artemis_credential_set` | Store ATS platform login (encrypted) | label, email, password, provider |
| `artemis_credential_list` | List stored credentials (email only, no passwords) | (none) |

---

## 7. Confidence Scoring Engine

### 7.1 Scoring Dimensions

| Dimension | Weight | Description |
|-----------|--------|-------------|
| **Skills Match** | 40% | Keyword overlap between JD requirements and Athena's achievement bank tags + experience highlights |
| **Level/Seniority Match** | 25% | Alignment between JD seniority signals and user's experience level |
| **Domain Relevance** | 20% | Is this a software engineering role? Filter out non-programming roles (auditing, accounting, etc.) |
| **Experience Years** | 15% | Alignment between JD years requirement and user's actual experience |

### 7.2 Scoring Flow

```
1. Extract keywords from JD (reuse Athena's extractKeywords pattern)
2. Request Athena's achievement bank + experiences via Discord mention
3. Match JD keywords against achievement tags + experience highlights
4. Detect seniority signals in JD (junior/mid/senior/staff/principal/lead)
5. Classify domain (software engineering, data, devops, product, other)
6. Extract years requirement via regex ("5+ years", "3-5 years")
7. Compute weighted score across all dimensions
8. Return: overall score, breakdown, key matches, gaps, recommendation
```

### 7.3 Domain Relevance Filter

Before scoring, Artemis applies a **domain gate**: if the role is clearly not software engineering (e.g., "Financial Auditor", "Marketing Manager"), it is tagged `domain: irrelevant` and excluded from the report. This prevents noise.

**Software engineering signals:** code, build, deploy, API, backend, frontend, full-stack, infrastructure, platform, SRE, DevOps, data engineer, ML engineer, etc.

### 7.4 Score Tiers

| Score | Tier | Report Section |
|-------|------|----------------|
| 80-100 | Strong Match | Featured with full details |
| 60-79 | Moderate Match | Listed with key info |
| 40-59 | Weak Match | Listed briefly (title + company only) |
| 0-39 | Skip | Omitted from report |

---

## 8. Career Page Scraping

### 8.1 Technology

**Playwright** (headless Chromium) — handles JavaScript-rendered career pages that `fetch()` alone can't parse.

### 8.2 Scraping Strategy

Since we scrape company career pages directly (not job boards), each company may have a different page structure. Artemis uses a **two-phase approach:**

**Phase 1: Discovery** — Navigate to the career page, extract all job listing links
- Look for common patterns: `<a>` tags with job titles, listing containers
- Use heuristics: links containing `/jobs/`, `/careers/`, `/positions/`, `/openings/`
- Fall back to Claude-assisted extraction: send page HTML to Claude to identify job links

**Phase 2: Extraction** — For each job link, navigate and extract:
- Job title (from `<h1>`, `<title>`, or og:title)
- Full description text (main content area)
- Salary range (if present)
- Location / remote status
- Level indicators
- Apply link/button URL

### 8.3 Change Detection

Each job posting's `raw_text` is hashed (SHA-256). On subsequent scans:
- **New job:** URL not seen before → status = `new`
- **Changed job:** Same URL, different hash → `last_changed_at` updated, flagged as reposted/updated
- **Removed job:** Previously seen URL no longer on careers page → status = `closed`
- **Unchanged:** Same URL, same hash → `last_seen_at` updated, no report

### 8.4 Rate Limiting & Politeness

- 2-second delay between page navigations
- Respect robots.txt
- Randomized User-Agent rotation
- Max 1 full scan per company per day (configurable)
- Scan logs track every run for auditability

---

## 9. Daily Report

### 9.1 Schedule

**9:00 AM Eastern Time**, every day, via macOS `launchd`.

**LaunchAgent plist:** `~/Library/LaunchAgents/com.openclaw.artemis.daily-scan.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.artemis.daily-scan</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/xiaguangwei/Desktop/Artemis/scripts/daily-scan.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/xiaguangwei/.artemis/logs/daily-scan.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/xiaguangwei/.artemis/logs/daily-scan-error.log</string>
</dict>
</plist>
```

**Why launchd over cron:** macOS natively supports launchd and it handles wake-from-sleep catchup (if the Mac was asleep at 9 AM, it runs the job upon wake). Cron on macOS has known reliability issues.

### 9.2 Daily Scan Script

```bash
#!/usr/bin/env bash
# scripts/daily-scan.sh
set -euo pipefail

# Invoke Artemis through OpenClaw to run scan + report
openclaw run artemis --tool artemis_scan_all
openclaw run artemis --tool artemis_report_generate
```

### 9.3 Report Format (Discord)

```markdown
**Daily Job Report — {date}**

**New: {n} | Updated: {n} | Pool: {n} companies**

---

**Strong Match (80+)**

**1. {title} — {company}**
{salary} | {location} | Score: {score}
{requirements_summary}
[View Details]({url})

**2. ...**

---

**Moderate Match (60-79)**

**3. {title} — {company}**
{salary} | {location} | Score: {score}
{requirements_summary}
[View Details]({url})

---

**Updated Listings**
- {title} — {company} (requirements changed)

---

Reply with a job number to start the application process.
```

### 9.4 Discord Channel

Channel: `#daily-job-report` in the user's Discord server.
Artemis posts the report as its own bot, consistent with how all OpenClaw agents post to Discord.

---

## 10. Application Flow

### 10.1 Step-by-Step

```
User: "Apply to job 1"
        │
        ▼
┌─────────────────────────────┐
│ 1. artemis_apply_prepare    │
│    - Create Application     │
│      (status: draft)        │
│    - Mention Athena:        │
│      "Tailor resume for     │
│       this JD"              │
│    - Mention Athena:        │
│      "Generate cover letter │
│       for this role"        │
│    - Store resume + CL      │
│      in Application record  │
│    - Status → pending_review│
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ 2. artemis_apply_fill       │
│    - Launch Playwright      │
│      (headed mode)          │
│    - Navigate to apply URL  │
│    - Handle auth if needed  │
│      (use stored creds)     │
│    - Fill form fields:      │
│      name, email, phone,    │
│      resume upload,         │
│      cover letter,          │
│      custom questions       │
│    - DO NOT click submit    │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ 3. artemis_apply_screenshot │
│    - Full-page screenshot   │
│    - Send to Discord        │
│      #daily-job-report      │
│    - Ask: "Review this      │
│      application. Reply     │
│      'approve' to submit    │
│      or tell me what to     │
│      change."               │
└──────────┬──────────────────┘
           │
     User reviews
           │
     ┌─────┴──────┐
     │             │
  "approve"    "change X"
     │             │
     ▼             ▼
┌──────────┐  ┌──────────────┐
│ 4. Submit│  │ Adjust form  │
│ Click    │  │ Re-screenshot│
│ button   │  │ Loop back    │
│ Status → │  └──────────────┘
│ submitted│
└──────────┘
     │
     ▼
┌─────────────────────────────┐
│ 5. Post-submission          │
│    - Record applied_at      │
│    - Status → submitted     │
│    - Begin email monitoring │
│      for this application   │
└─────────────────────────────┘
```

### 10.2 Form Field Mapping

Artemis maintains a mapping of common ATS form fields:

| ATS Field | Source |
|-----------|--------|
| First Name / Last Name | USER.md or stored profile |
| Email | Application email (from credentials) |
| Phone | USER.md or stored profile |
| Resume | Upload tailored resume as PDF (markdown → HTML → Playwright PDF) |
| Cover Letter | Upload or paste generated cover letter |
| LinkedIn | USER.md |
| Portfolio/Website | USER.md |
| How did you hear about us? | Default: "Company career page" |
| Visa sponsorship | USER.md preference |
| Custom questions | Claude-assisted: read question, generate answer from user background + company info + JD (visible in screenshot for review) |

### 10.3 ATS Platform Handlers

Different ATS platforms require different automation strategies:

| Platform | Detection | Strategy |
|----------|-----------|----------|
| **Greenhouse** | URL contains `boards.greenhouse.io` or `grnh.se` | Standard form fill, file upload |
| **Lever** | URL contains `jobs.lever.co` | Standard form fill, file upload |
| **Workday** | URL contains `myworkdayjobs.com` | Multi-step wizard, needs login handling |
| **Ashby** | URL contains `jobs.ashbyhq.com` | Standard form fill |
| **Custom** | Fallback | Heuristic field detection + Claude assist |

Each handler is a class implementing a common interface:

```typescript
interface ATSHandler {
  detect(url: string): boolean;
  login(page: Page, credentials: Credential): Promise<void>;
  fillForm(page: Page, application: ApplicationData): Promise<void>;
  screenshot(page: Page): Promise<string>;  // returns file path
  submit(page: Page): Promise<void>;
}
```

---

## 11. Email Monitoring

### 11.1 Architecture

Artemis monitors the dedicated application email for responses using IMAP (or Gmail API if Gmail).

**Polling frequency:** Every 30 minutes during business hours (8 AM - 8 PM ET), checked as part of daily scan, or on-demand via `artemis_email_check`.

### 11.2 Email Classification

Incoming emails are classified by content analysis:

| Classification | Signals | Action |
|----------------|---------|--------|
| **acknowledgment** | "received your application", "thank you for applying" | Application status → acknowledged |
| **rejection** | "unfortunately", "other candidates", "not moving forward" | Application status → rejected |
| **interview_request** | "schedule", "interview", "next steps", "meet the team" | Application status → interview, notify user immediately |
| **offer** | "offer", "compensation", "start date" | Application status → offer, notify user immediately |
| **other** | Newsletters, unrelated | Log but no status change |

### 11.3 Email Matching

Match emails to applications by:
1. Sender domain matches company domain
2. Subject contains company name or job title
3. Most recent application to that company

---

## 12. Athena Extensions

Artemis requires new capabilities in Athena. These should be added to Athena's plugin as a new version (v0.3.0).

### 12.1 New Entity: SoftSkill

```typescript
interface SoftSkill {
  id: string;
  title: string;              // e.g., "Cross-functional collaboration"
  description: string;        // Evidence-backed description
  evidence: string;           // JSON: specific examples
  source: string;             // cover_letter | interview | reflection | manual
  tags: string;               // JSON: ["leadership", "communication"]
  created_at: string;
}
```

**Folder:** `Soft Skills/`
**Type tag:** `athena-soft-skill`

### 12.2 New Entity: CoverLetter

```typescript
interface CoverLetter {
  id: string;
  job_id: string | null;      // FK → JobDescription (null if template)
  company: string;
  role: string;
  content: string;
  version_label: string | null;
  created_at: string;
}
```

**Folder:** `Cover Letters/`
**Type tag:** `athena-cover-letter`

### 12.3 New Athena Tools (6)

| Tool | Description | Parameters |
|------|-------------|------------|
| `athena_soft_skill_add` | Add soft skill to knowledge base | title, description, evidence_json?, source?, tags_json? |
| `athena_soft_skill_list` | List all soft skills | category? |
| `athena_soft_skill_harvest` | Extract soft skills from cover letters/reflections | source_text, source_type |
| `athena_cover_letter_generate` | Generate tailored cover letter from JD + profile + soft skills | jd_id |
| `athena_cover_letter_ingest` | Ingest existing cover letter for analysis | file_path, version_label?, company?, role? |
| `athena_cover_letter_list` | List all cover letters | company? |

### 12.4 Cover Letter Generation System Prompt

```
COVER_LETTER_SYSTEM_PROMPT:
- Tone: Professional but personable — this is where personality shows
- Structure: 3-4 paragraphs
  1. Hook: Why this role caught your attention (specific to the company/team/product)
  2. What you bring: Connect hard skills (from achievement bank) with soft skills
  3. Why this company: Reference specific company values, mission, or recent work
  4. Closing: Clear call to action, enthusiasm without desperation
- DO NOT repeat the resume — the cover letter complements it
- Use the JD's language naturally (not keyword-stuffed)
- Show understanding of the company's problems and how you solve them
- Reference specific achievements that map to their needs
- Keep under 400 words
- Weave soft skills naturally: "Led a cross-functional team of 6" not "I have leadership skills"
```

### 12.5 Soft Skills Knowledge Base

The soft skills KB is built over time from:
1. **Cover letter ingestion** — Extract soft skill claims from existing cover letters
2. **Interview reflections** — Hermes interview feedback contains soft skill signals
3. **Project harvests** — Athena's harvest includes "reflection" and "challenge" categories that imply soft skills
4. **Manual addition** — User can explicitly add soft skills

**Categories:** leadership, communication, collaboration, problem-solving, adaptability, mentoring, ownership, creativity, conflict-resolution, time-management

---

## 13. Credential Security

### 13.1 Encryption

- Passwords encrypted with AES-256-GCM
- Encryption key derived from macOS Keychain (`security` CLI)
- Key stored in Keychain under service `com.openclaw.artemis`
- The Obsidian note only stores the encrypted blob + IV + auth tag

### 13.2 Flow

```typescript
// Encrypt
const key = await getKeychainKey('com.openclaw.artemis');
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(password), cipher.final()]);
const tag = cipher.getAuthTag();
// Store: base64(iv + tag + encrypted)

// Decrypt
const key = await getKeychainKey('com.openclaw.artemis');
// Parse iv, tag, encrypted from stored blob
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
const password = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString();
```

### 13.3 What Gets Stored Where

| Data | Location | Format |
|------|----------|--------|
| Encryption master key | macOS Keychain | Native keychain entry |
| Encrypted passwords | Obsidian vault (`Agents/Artemis/Credentials/`) | Base64 blob in frontmatter |
| Email addresses | Obsidian vault | Plaintext (not sensitive) |
| Screenshots | `~/.artemis/screenshots/` | PNG files (local only) |
| Scan logs | `~/.artemis/logs/` | Text logs |

---

## 14. Workspace Files

### 14.1 IDENTITY.md

```
name: Artemis
tagline: The Huntress
```

### 14.2 SOUL.md

```markdown
# Artemis - Soul

## Core Identity

You are Artemis, the Huntress — a relentless, precise job discovery agent. You scan the
hunting grounds daily, track every movement in your target companies, and strike only when
the match is right. You never miss a new posting and you never let a good opportunity
slip away.

## Voice

- Efficient and direct — you report facts, not feelings
- Confident in your scoring — "This is a strong match because..." not "This might be good"
- Proactive — surface opportunities before the user asks
- Honest about weak matches — "This role needs 8 years of ML experience you don't have"
- Protective of the user's time — don't flood with noise, surface signal

## Hunting Philosophy

"Every hunt begins with patience. Know the terrain, know the prey, strike with precision."

- Quality over quantity — 3 strong matches beat 30 weak ones
- The best time to apply is when a role first appears — speed matters
- A tailored application beats a generic one every time
- Track everything — patterns in rejections reveal what to improve

## Scoring Philosophy

- Be calibrated, not generous. A 90 means near-perfect alignment.
- Domain relevance is a hard gate — if it's not a programming role, it doesn't matter how
  many keywords match
- Level mismatch is costly — applying to roles 2+ levels above/below wastes everyone's time
- Missing 1-2 nice-to-haves is fine; missing 2+ must-haves is a weak match

## Application Philosophy

- Never submit without human review — this is the user's career, not an automation exercise
- The screenshot is a contract: what the user sees is what gets submitted
- If a form asks for something we don't have, flag it — don't guess

## Boundaries

- You discover and report — the user decides whether to apply
- You coordinate with Athena for career materials — you don't write resumes yourself
- You don't negotiate salary or communicate with recruiters
- You protect credentials with encryption — never log or display passwords
```

### 14.3 AGENTS.md

```markdown
# Artemis - Operating Instructions

## Session Start

1. Read SOUL.md for your persona
2. Read USER.md for user context
3. Check company pool: use `artemis_company_list`
4. Check for pending applications: use `artemis_application_list`

## Discord Agent IDs

| Agent | Discord ID | Mention syntax |
|-------|-----------|----------------|
| Sophon | 1478027324866695169 | `<@1478027324866695169>` |
| Athena | 1480628248634200186 | `<@1480628248634200186>` |
| Hermes | 1481032036692004958 | `<@1481032036692004958>` |
| Absolute | 1481315063880224961 | `<@1481315063880224961>` |
| Artemis (you) | {TO_BE_ASSIGNED} | — |
| Isaac (owner) | 680158864716595205 | `<@680158864716595205>` |

## Core Workflows

### Daily Hunt (automated, 9 AM ET)
1. `artemis_scan_all` — scrape all active companies
2. Score new/changed jobs against Athena profile
3. `artemis_report_generate` — post to #daily-job-report
4. `artemis_email_check` — check for application responses

### Manual Hunt
User says "scan" or "hunt" → run `artemis_scan_all` or `artemis_scan_company`

### Application Flow
1. User picks a job from report (e.g., "apply to job 1")
2. `artemis_apply_prepare` — mention Athena for resume + cover letter:
   - "<@{ATHENA_ID}> Please tailor a resume for this JD: {jd_text}"
   - "<@{ATHENA_ID}> Please generate a cover letter for {company} - {role}"
3. Store Athena's output in Application record
4. `artemis_apply_fill` — launch Playwright, fill form
5. `artemis_apply_screenshot` — capture and send to Discord
6. Wait for user: "approve" or "change X"
7. On approve: `artemis_apply_submit`
8. On change: adjust and re-screenshot

### Tracking
- `artemis_email_check` runs during daily scan
- Interview requests and offers trigger **both** a #daily-job-report post **and** a Discord DM to the user
- User can check status anytime: `artemis_application_list`

## Tool Reference

### Pool Management
- `artemis_company_add` — add company to hunting pool
- `artemis_company_remove` — remove company from pool
- `artemis_company_list` — list all companies with scan stats
- `artemis_company_update` — update company info or toggle active

### Hunting
- `artemis_scan_all` — scan all active companies
- `artemis_scan_company` — scan single company
- `artemis_job_list` — list discovered jobs (filterable)
- `artemis_job_detail` — full job details + score breakdown

### Reports
- `artemis_report_generate` — generate and post daily report
- `artemis_report_history` — view past reports

### Applications
- `artemis_apply_prepare` — coordinate with Athena for materials
- `artemis_apply_fill` — auto-fill application form
- `artemis_apply_screenshot` — capture form for review
- `artemis_apply_submit` — submit after approval
- `artemis_apply_cancel` — cancel pending application

### Tracking
- `artemis_application_list` — list applications by status
- `artemis_application_update` — manually update status
- `artemis_application_analytics` — conversion funnel
- `artemis_application_timeline` — timeline for one application

### Email
- `artemis_email_setup` — configure application email
- `artemis_email_check` — poll for responses
- `artemis_email_report` — summarize recent email activity

### Credentials
- `artemis_credential_set` — store encrypted credentials
- `artemis_credential_list` — list credentials (no passwords)

## Athena Coordination

When you need career data or materials, ALWAYS go through Athena via Discord mention.
Never access Athena's database directly.

**Request patterns:**
- Scoring: "<@{ATHENA_ID}> I need your achievement bank and experiences to score a batch of new JDs"
- Resume: "<@{ATHENA_ID}> Please tailor a resume for this JD: {text}"
- Cover letter: "<@{ATHENA_ID}> Please generate a cover letter for {company} - {role}. JD: {text}"
- ATS check: "<@{ATHENA_ID}> Please run an ATS check on this resume against this JD"

## Error Handling

- **Scrape fails:** Log error in ScanLog, skip company, continue others, note in report
- **Athena unresponsive:** Log, inform user, pause application flow
- **Form fill fails:** Screenshot current state, report to user, suggest manual completion
- **Email check fails:** Log, retry next cycle, don't block other operations
```

---

## 15. Dependencies

### package.json

```json
{
  "name": "artemis-plugin",
  "version": "0.1.0",
  "description": "Artemis job hunting agent plugin",
  "main": "index.js",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc"
  },
  "type": "commonjs",
  "openclaw": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {
    "obsidian-adapter": "file:../../obsidian-adapter",
    "gray-matter": "^4.0.3",
    "uuid": "^13.0.0",
    "playwright": "^1.50.0",
    "marked": "^15.0.0"
  },
  "devDependencies": {
    "@types/node": "^25.3.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

**Note:** `playwright` is the only major new dependency beyond the standard agent stack. It serves triple duty: career page scraping, application form filling, and resume PDF generation (via `page.pdf()`). Email monitoring uses Node's built-in `net`/`tls` for IMAP or a lightweight IMAP library (to be decided during implementation). `marked` converts Athena's markdown resume to HTML for PDF rendering.

---

## 16. install.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"

echo "[Artemis] Installing dependencies..."
cd "$PLUGIN_DIR" && npm install

echo "[Artemis] Installing Playwright browsers..."
npx playwright install chromium

echo "[Artemis] Verifying build..."
npx tsc --noEmit

echo "[Artemis] Running tests..."
npx vitest run

echo "[Artemis] Setting up directories..."
mkdir -p ~/.artemis/screenshots ~/.artemis/logs

echo "[Artemis] Installing daily scan schedule..."
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.openclaw.artemis.daily-scan.plist"
mkdir -p "$PLIST_DIR"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.artemis.daily-scan</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT_DIR/scripts/daily-scan.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/.artemis/logs/daily-scan.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.artemis/logs/daily-scan-error.log</string>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH"
echo "[Artemis] Daily scan scheduled for 9:00 AM ET"

echo ""
echo "[Artemis] Installation complete."
echo ""
echo "To add Artemis to OpenClaw, add to ~/.openclaw/openclaw.json:"
echo "  agents.list: { \"artemis\": { \"name\": \"Artemis\", \"plugin\": \"$PLUGIN_DIR/src/index.ts\" } }"
echo "  workspaces: { \"artemis\": \"$SCRIPT_DIR/workspace\" }"
echo ""
echo "Next steps:"
echo "  1. Create a Discord bot for Artemis and add to your server"
echo "  2. Create #daily-job-report channel in Discord"
echo "  3. Run: artemis_email_setup to configure your application email"
echo "  4. Run: artemis_company_add to start building your company pool"
```

---

## 17. Absolute Integration

Absolute's AGENTS.md and SOUL.md need updating to include Artemis:

### SOUL.md addition

```markdown
## The Chosen

- **Sophon the Sage** — keeper of knowledge, reflections, and personality insights
- **Athena the Strategist** — architect of careers, projects, and professional identity
- **Hermes the Herald** — conductor of mock interviews and performance evaluation
- **Artemis the Huntress** — tracker of opportunities, executor of applications
```

### AGENTS.md additions

**Discord IDs table:** Add Artemis row with new bot ID.

**Task assignment:** Add to the routing rules:
```
- **Artemis** — job discovery, company tracking, application submission, email monitoring
```

---

## 18. Implementation Order

### Phase 1: Foundation
1. Project scaffolding (matching existing agent structure)
2. ArtemisDB with Company and JobPosting entities
3. types.ts, helpers.ts, index.ts, plugin manifest
4. Pool management tools (add/remove/list/update companies)
5. Basic tests

### Phase 2: Hunting
6. Playwright scraper for career pages
7. Diff engine (new/changed/reposted detection)
8. Confidence scorer (integrate with Athena via Discord)
9. Hunt tools (scan_all, scan_company, job_list, job_detail)

### Phase 3: Reporting
10. Report generator (Discord markdown format)
11. Report tools (generate, history)
12. launchd scheduling
13. Daily scan script

### Phase 4: Athena Extensions
14. SoftSkill entity + tools in Athena
15. CoverLetter entity + tools in Athena
16. Cover letter generation system prompt
17. Soft skill harvest from existing data

### Phase 5: Application
18. Application entity + tracker
19. Playwright form filler with ATS handlers
20. Screenshot capture + Discord posting
21. Application tools (prepare, fill, screenshot, submit, cancel)

### Phase 6: Email & Tracking
22. Credential storage with encryption
23. Email monitoring (IMAP/API)
24. Email classification
25. Tracking tools + analytics

### Phase 7: Integration
26. Register Artemis in OpenClaw config
27. Update Absolute's SOUL.md and AGENTS.md
28. End-to-end testing
29. README + documentation

---

## 19. Resolved Design Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Resume upload format | **Generate PDF** from Athena's markdown output via Playwright's PDF renderer. ATS systems expect PDF. |
| 2 | Custom application questions | **Claude-assisted**: answer using user background (Athena profile) + company info + job description. Included in screenshot review so user can override. |
| 3 | Scan frequency | **Once per day** per company. No rush — quality over speed. |
| 4 | Multi-email | **Single application email**. No need for aliases. |
| 5 | Interview notifications | **Yes, DM the user directly** via Discord DM in addition to `#daily-job-report` channel post for interview requests and offers. |

---

## 20. PDF Generation

### Strategy

Use Playwright's built-in `page.pdf()` to render Athena's markdown resume as a clean PDF. This avoids adding another dependency since Playwright is already required for scraping and form filling.

### Flow

```
1. Athena returns tailored resume as markdown
2. Artemis converts markdown → minimal HTML (with professional CSS styling)
3. Playwright renders HTML → PDF via page.pdf()
4. PDF saved to ~/.artemis/resumes/{application_id}.pdf
5. PDF uploaded to ATS form during auto-fill
```

### Resume PDF Styling

```typescript
// Embedded CSS for professional resume rendering
const RESUME_CSS = `
  body { font-family: 'Georgia', serif; font-size: 11pt; line-height: 1.4; margin: 0.75in; color: #333; }
  h1 { font-size: 18pt; margin-bottom: 4pt; color: #1a1a1a; }
  h2 { font-size: 13pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; margin-top: 14pt; color: #1a1a1a; }
  h3 { font-size: 11pt; margin-bottom: 2pt; }
  ul { margin: 4pt 0; padding-left: 18pt; }
  li { margin-bottom: 2pt; }
  p { margin: 4pt 0; }
  a { color: #333; text-decoration: none; }
`;
```

**Page size:** US Letter (8.5" x 11"), matching ATS expectations.

---

## 21. Custom Application Question Handling

### Strategy

When Artemis encounters free-text questions on an application form (e.g., "Why do you want to work here?", "Describe a challenging project"), it generates answers using Claude with full context.

### Prompt Construction

```
Context provided to Claude for each custom question:
1. The question text
2. User's background (from Athena: achievement bank + experiences)
3. Company information (scraped from career page / about page)
4. Job description (full text + analysis)
5. System prompt: "Answer this application question concisely and authentically.
   Draw on the candidate's real experience. Match the company's tone.
   Keep under 200 words unless the form allows more."
```

### Review Safety

All auto-generated answers are visible in the pre-submit screenshot. The user reviews everything before Artemis clicks submit. If any answer needs adjustment, the user says "change question 3 to..." and Artemis updates the field.

---

## 22. Notification Routing

### Channel vs DM

| Event | Channel (`#daily-job-report`) | Discord DM |
|-------|------------------------------|------------|
| Daily report | Yes | No |
| New job discovered | In daily report only | No |
| Application submitted | Yes | No |
| Acknowledgment email | Yes | No |
| **Interview request** | Yes | **Yes — immediate** |
| **Offer received** | Yes | **Yes — immediate** |
| Rejection | Yes | No |
| Scrape error | In daily report notes | No |

### DM Format for Urgent Notifications

```markdown
**Interview Request — {company}**

{role} — received {timestamp}

Subject: {email_subject}
Preview: {first 200 chars of email body}

Reply here or check #daily-job-report for details.
```
