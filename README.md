# Artemis

An automated job hunting agent built on [OpenClaw](https://openclaw.ai).

Artemis scans company career pages daily to discover new software engineering roles, scores each one against your profile for fit, and posts a structured daily report to Discord at 9:00 AM. When you pick a role, Artemis coordinates with Athena for a tailored resume and cover letter, auto-fills the application form via browser automation, screenshots it for your review, and submits only after you approve. It then monitors your application email for responses — acknowledgments, rejections, interview requests, offers — and tracks the full lifecycle so you can see conversion funnels and identify patterns.

## Architecture

```
OpenClaw (Gateway)
  ├── Discord / Telegram / WhatsApp / Web Chat
  └── Artemis Plugin (TypeScript)
        ├── Pool ─────────── company pool management, career page URLs
        ├── Hunter ──────── Playwright scraping, diff engine, scoring
        ├── Reporter ────── daily report generation, Discord posting
        ├── Applicant ───── form filling, screenshots, submission
        ├── Tracker ─────── application lifecycle, analytics
        ├── EmailMonitor ── IMAP polling, classification, matching
        └── Obsidian Vault (Agents/Artemis/)
              ├── Companies/         company pool
              ├── Job Postings/      discovered roles with scores
              ├── Applications/      tracked applications
              ├── Credentials/       encrypted ATS logins
              ├── Scan Logs/         scraping history
              ├── Reports/           daily reports
              └── Emails/            monitored responses
```

Artemis runs as an OpenClaw plugin. OpenClaw handles messaging infrastructure and LLM orchestration. Artemis provides 24 tools that Claude calls during conversations, plus workspace files that define the huntress persona.

## How It Works

### 1. Build Your Company Pool

Add the companies you want to track. Artemis takes their career page URLs and adds them to your hunting pool.

```
You: Add Google to my hunting pool
     careers page: https://careers.google.com/jobs/results/?q=software+engineer

Artemis: Google added to pool. Career page registered.
         Pool now has 12 active companies.
```

### 2. Daily Hunt (Automated at 9 AM)

Every morning, Artemis scrapes all active company career pages using Playwright, diffs against known postings (SHA-256 hash comparison), scores new and changed roles against your profile via Athena, and posts a structured report to `#daily-job-report`:

```
Daily Job Report — 2026-03-20

New: 4 | Updated: 1 | Pool: 12 companies

---

Strong Match (80+)

1. Senior Backend Engineer — Stripe
   $180-220k | Remote US | Score: 92
   Distributed systems, Go/Python, API design, 5+ years
   View Details

2. Platform Engineer — Datadog
   $170-210k | NYC/Remote | Score: 85
   Kubernetes, observability, infrastructure, 4+ years
   View Details

---

Moderate Match (60-79)

3. Full-Stack Engineer — Notion
   $160-200k | SF | Score: 71
   React, TypeScript, collaborative tools, 3+ years
   View Details

---

Updated Listings
- Staff Engineer — Cloudflare (requirements changed)

---

Reply with a job number to start the application process.
```

### 3. Apply with Human-in-the-Loop

When you pick a job, Artemis coordinates the full application flow:

1. **Prepare** — Mentions Athena in Discord to tailor your resume and generate a cover letter for the specific role
2. **Fill** — Launches a browser via Playwright, navigates to the application form, and auto-fills all fields (name, email, resume upload, cover letter, custom questions)
3. **Screenshot** — Captures the filled form and sends it to Discord for your review
4. **Submit** — Only after you reply "approve" does Artemis click submit
5. **Track** — Records submission timestamp, begins monitoring email for responses

Artemis never submits without your explicit approval. The screenshot is a contract: what you see is what gets submitted.

### 4. Track Application Lifecycle

Artemis monitors your application email via IMAP, classifies incoming messages (acknowledgment, rejection, interview request, offer), matches them to applications, and updates statuses automatically. Interview requests and offers trigger immediate Discord notifications.

View your pipeline anytime:

```
You: Show me my application funnel

Artemis: Application Analytics
         Applied:        14
         Acknowledged:    9
         Phone Screen:    4
         Interview:       3
         Offer:           1
         Rejected:        6
         Withdrawn:       1
```

## Confidence Scoring

Each discovered role is scored 0-100 across four weighted dimensions:

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| **Skills Match** | 40% | Overlap between JD requirements and your achievement bank tags + experience highlights (via Athena) |
| **Level/Seniority Match** | 25% | Alignment between JD seniority signals and your experience level |
| **Domain Relevance** | 20% | Is this actually a software engineering role? Non-programming roles are filtered out |
| **Experience Years** | 15% | Alignment between JD years requirement and your actual experience |

Score tiers determine report placement:

| Score | Tier | Report Treatment |
|-------|------|-----------------|
| 80-100 | Strong Match | Featured with full details |
| 60-79 | Moderate Match | Listed with key info |
| 40-59 | Weak Match | Listed briefly (title + company) |
| 0-39 | Skip | Omitted from report |

Scoring is calibrated, not generous. A 90 means near-perfect alignment. Domain relevance acts as a hard gate — if it is not a programming role, the score does not matter.

## Application Flow

```
User: "Apply to job 1"
        |
        v
+-----------------------------+
| 1. artemis_apply_prepare    |
|    - Create Application     |
|      (status: draft)        |
|    - Mention Athena:        |
|      "Tailor resume for     |
|       this JD"              |
|    - Mention Athena:        |
|      "Generate cover letter |
|       for this role"        |
|    - Store resume + CL      |
|    - Status -> pending      |
+-------------+---------------+
              |
              v
+-----------------------------+
| 2. artemis_apply_fill       |
|    - Launch Playwright      |
|      (headed mode)          |
|    - Navigate to apply URL  |
|    - Handle ATS auth        |
|    - Fill form fields       |
|    - DO NOT click submit    |
+-------------+---------------+
              |
              v
+-----------------------------+
| 3. artemis_apply_screenshot |
|    - Full-page screenshot   |
|    - Send to Discord        |
|    - Ask user to review     |
+-------------+---------------+
              |
        User reviews
              |
        +-----+------+
        |            |
     "approve"   "change X"
        |            |
        v            v
  +-----------+  +--------------+
  | 4. Submit |  | Adjust form  |
  | Click     |  | Re-screenshot|
  | button    |  | Loop back    |
  | Status -> |  +--------------+
  | submitted |
  +-----------+
        |
        v
+-----------------------------+
| 5. Post-submission          |
|    - Record applied_at      |
|    - Status -> submitted    |
|    - Begin email monitoring |
+-----------------------------+
```

Artemis handles multiple ATS platforms automatically:

| Platform | Detection | Strategy |
|----------|-----------|----------|
| **Greenhouse** | `boards.greenhouse.io` or `grnh.se` | Standard form fill, file upload |
| **Lever** | `jobs.lever.co` | Standard form fill, file upload |
| **Workday** | `myworkdayjobs.com` | Multi-step wizard, login handling |
| **Ashby** | `jobs.ashbyhq.com` | Standard form fill |
| **Custom** | Fallback | Heuristic field detection + Claude assist |

## Inter-Agent Communication

Artemis communicates with Athena via Discord mentions (`<@ATHENA_DISCORD_ID>`), following the established inter-agent protocol. Artemis never accesses Athena's database directly.

```
Artemis                          Athena
   |                                |
   +--- "Score this JD" ----------->|
   |<-- achievement bank + match ---|
   |                                |
   +--- "Tailor resume for JD" --->|
   |<-- tailored resume ------------|
   |                                |
   +--- "Generate cover letter" -->|
   |<-- tailored cover letter ------|
```

**Request patterns:**
- Scoring: "I need your achievement bank and experiences to score a batch of new JDs"
- Resume: "Please tailor a resume for this JD: {text}"
- Cover letter: "Please generate a cover letter for {company} - {role}. JD: {text}"
- ATS check: "Please run an ATS check on this resume against this JD"

## Plugin Tools Reference

Artemis registers 24 tools with OpenClaw:

### Pool Management (4)

| Tool | Purpose |
|------|---------|
| `artemis_company_add` | Add a company to the hunting pool |
| `artemis_company_remove` | Remove a company from the pool |
| `artemis_company_list` | List all companies with scan stats |
| `artemis_company_update` | Update company info or toggle active status |

### Hunt (4)

| Tool | Purpose |
|------|---------|
| `artemis_scan_all` | Scan all active companies, diff against known jobs, score new finds |
| `artemis_scan_company` | Scan a single company |
| `artemis_job_list` | List discovered jobs with filters (company, status, min score) |
| `artemis_job_detail` | Show full details + score breakdown for a job |

### Reports (2)

| Tool | Purpose |
|------|---------|
| `artemis_report_generate` | Generate and post daily report to Discord |
| `artemis_report_history` | View past reports |

### Applications (5)

| Tool | Purpose |
|------|---------|
| `artemis_apply_prepare` | Coordinate with Athena for tailored resume + cover letter |
| `artemis_apply_fill` | Launch browser, navigate to application, auto-fill form |
| `artemis_apply_screenshot` | Capture filled form screenshot, send to Discord for review |
| `artemis_apply_submit` | Submit the application (after user approval only) |
| `artemis_apply_cancel` | Cancel a pending application |

### Tracking (4)

| Tool | Purpose |
|------|---------|
| `artemis_application_list` | List all applications with current status |
| `artemis_application_update` | Manually update application status |
| `artemis_application_analytics` | Conversion funnel: applied -> ack -> interview -> offer |
| `artemis_application_timeline` | Timeline view of a specific application |

### Email (3)

| Tool | Purpose |
|------|---------|
| `artemis_email_setup` | Configure application email credentials |
| `artemis_email_check` | Poll for new responses, classify, match to applications |
| `artemis_email_report` | Summarize recent email activity |

### Credentials (2)

| Tool | Purpose |
|------|---------|
| `artemis_credential_set` | Store ATS platform login (AES-256-GCM encrypted) |
| `artemis_credential_list` | List stored credentials (email only, no passwords shown) |

## Data Model

Seven entity types stored via ObsidianAdapter in `Agents/Artemis/` within the Obsidian vault:

**Company** — Companies in the hunting pool. Fields: name, careers_url, is_active, added_at. Folder: `Companies/`.

**JobPosting** — Discovered job listings with scoring. Fields: company_id, title, url, level, salary_range, location, requirements_summary, raw_text, content_hash (SHA-256 for change detection), confidence_score (0-100), score_breakdown (JSON), status (new/seen/applied/closed), first_seen_at, last_seen_at, last_changed_at. Folder: `Job Postings/{CompanyName}/`.

**Application** — Tracked applications through the full lifecycle. Fields: job_id, status (draft/pending_review/submitted/acknowledged/rejected/phone_screen/interview/offer/withdrawn), resume_version, cover_letter, screenshot_path, applied_at, last_status_change, notes. Folder: `Applications/{CompanyName}/`.

**Credential** — Encrypted ATS and email credentials. Fields: label, email, encrypted_password (AES-256-GCM), provider (email/greenhouse/lever/workday/custom), created_at. Passwords encrypted using a machine-specific key derived from macOS Keychain. Folder: `Credentials/`.

**ScanLog** — Scraping audit trail. Fields: company_id, scanned_at, jobs_found, new_jobs, changed_jobs, errors. Folder: `Scan Logs/`.

**DailyReport** — Generated daily reports. Fields: date, new_jobs_count, changed_jobs_count, report_content (full markdown), generated_at. Folder: `Reports/`.

**EmailMessage** — Monitored email responses. Fields: application_id, from, subject, body_preview, received_at, classification (acknowledgment/rejection/interview_request/offer/other). Folder: `Emails/`.

## Requirements

- [OpenClaw](https://openclaw.ai) installed and configured
- Node.js >= 22
- Anthropic account (API key or Pro/Max subscription via OAuth)
- macOS (for launchd scheduling and Keychain credential storage)
- Obsidian vault at `~/Documents/Obsidian Vault/`

## Installation

```bash
git clone https://github.com/GravesXX/Artemis.git ~/Desktop/Artemis
cd ~/Desktop/Artemis
bash install.sh
```

The installer:
1. Runs `npm install` for all dependencies
2. Installs Playwright's Chromium browser for scraping and form automation
3. Verifies the TypeScript build
4. Runs all tests
5. Creates local directories (`~/.artemis/screenshots`, `~/.artemis/logs`, `~/.artemis/resumes`)
6. Installs a macOS LaunchAgent for the daily 9 AM scan

Then add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "agents": {
    "list": {
      "artemis": {
        "name": "Artemis",
        "plugin": "~/Desktop/Artemis/plugin/src/index.ts"
      }
    }
  },
  "workspaces": {
    "artemis": "~/Desktop/Artemis/workspace"
  }
}
```

### Post-Install Setup

1. **Discord bot** — Create a Discord bot for Artemis and add it to your server
2. **Discord channel** — Create a `#daily-job-report` channel
3. **Application email** — Run `artemis_email_setup` to configure your dedicated application email (IMAP credentials)
4. **Company pool** — Run `artemis_company_add` to start building your company pool

## Project Structure

```
Artemis/
├── install.sh                        # Setup: npm, Playwright, tests, launchd
├── scripts/
│   ├── daily-scan.sh                 # Triggered by launchd at 9 AM
│   └── seed-companies.ts            # Seed script for initial company pool
├── workspace/
│   ├── SOUL.md                       # Huntress persona and voice
│   ├── AGENTS.md                     # Operating instructions + tool reference
│   ├── IDENTITY.md                   # Name and tagline
│   └── USER.md                       # User context (populated over time)
├── plugin/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  # Entry point
│       ├── types.ts                  # OpenClaw API types
│       ├── openclaw.plugin.json      # Plugin manifest
│       ├── db/
│       │   ├── database.ts           # ArtemisDB class (ObsidianAdapter)
│       │   └── __tests__/
│       ├── hunting/                  # Job discovery domain
│       │   ├── scraper.ts            # Career page scraper (Playwright)
│       │   ├── differ.ts             # Job diff engine (new/changed/reposted)
│       │   ├── scorer.ts             # Confidence scoring engine
│       │   ├── reporter.ts           # Daily report generator
│       │   └── __tests__/
│       ├── application/              # Application submission domain
│       │   ├── filler.ts             # Form auto-fill via Playwright
│       │   ├── screenshotter.ts      # Screenshot capture for review
│       │   ├── tracker.ts            # Application lifecycle tracking
│       │   └── __tests__/
│       ├── email/                    # Email monitoring domain
│       │   ├── monitor.ts            # IMAP polling
│       │   ├── classifier.ts         # Email classification
│       │   └── __tests__/
│       ├── tools/
│       │   ├── register.ts           # Central wiring (24 tools)
│       │   ├── pool-tools.ts         # 4 pool management tools
│       │   ├── hunt-tools.ts         # 4 hunting tools
│       │   ├── report-tools.ts       # 2 report tools
│       │   ├── apply-tools.ts        # 5 application tools
│       │   ├── track-tools.ts        # 4 tracking tools
│       │   ├── email-tools.ts        # 3 email tools
│       │   ├── credential-tools.ts   # 2 credential tools
│       │   └── helpers.ts            # MCP result wrappers
│       └── skills/
│           ├── hunt.md               # /hunt command
│           ├── apply.md              # /apply command
│           └── report.md            # /report command
└── docs/
    └── design-spec.md                # Full design specification
```

## Development

```bash
cd plugin
npm install
npm test              # run all tests
npm run test:watch    # watch mode
npm run build         # compile TypeScript
```

## Credential Security

Passwords are never stored in plaintext. Artemis uses AES-256-GCM encryption with a master key stored in macOS Keychain under `com.openclaw.artemis`. The Obsidian vault notes contain only the encrypted blob (base64-encoded IV + auth tag + ciphertext). Credentials are never logged or displayed — `artemis_credential_list` shows email addresses only.

| Data | Storage Location | Format |
|------|-----------------|--------|
| Encryption master key | macOS Keychain | Native keychain entry |
| Encrypted passwords | Obsidian vault (`Credentials/`) | Base64 blob in frontmatter |
| Email addresses | Obsidian vault | Plaintext |
| Form screenshots | `~/.artemis/screenshots/` | PNG (local only) |
| Scan/error logs | `~/.artemis/logs/` | Text logs |

## Data Privacy

All data is stored locally in your Obsidian vault and `~/.artemis/`. Nothing leaves your machine except API calls to Claude for generating responses, scoring jobs, and answering custom application questions. Your job search history, application data, credentials, and analytics stay on your local filesystem.

## Design Documents

- [Design Specification](docs/design-spec.md) — Architecture, data model, tool inventory, scoring engine, application flow, email monitoring
