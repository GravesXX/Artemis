import { ImapFlow } from 'imapflow';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ImapConfig {
  host: string;
  port: number;
  email: string;
  password: string;
  tls: boolean;
}

export interface RawEmail {
  uid: number;
  from: string;
  subject: string;
  date: string;
  bodyPreview: string;
  messageId: string;
}

export interface FetchResult {
  emails: RawEmail[];
  errors: string[];
}

// ── Provider presets ────────────────────────────────────────────────────────

const PROVIDER_PRESETS: Record<string, { host: string; port: number; tls: boolean }> = {
  gmail:   { host: 'imap.gmail.com',        port: 993, tls: true },
  outlook: { host: 'outlook.office365.com',  port: 993, tls: true },
  yahoo:   { host: 'imap.mail.yahoo.com',   port: 993, tls: true },
  icloud:  { host: 'imap.mail.me.com',      port: 993, tls: true },
};

// ── EmailMonitor ────────────────────────────────────────────────────────────

export class EmailMonitor {

  static resolveConfig(provider: string, email: string, password: string): ImapConfig {
    // Handle custom provider format: "custom|host|port"
    if (provider.startsWith('custom|')) {
      const parts = provider.split('|');
      return {
        host: parts[1] ?? 'localhost',
        port: parseInt(parts[2] ?? '993', 10),
        email,
        password,
        tls: true,
      };
    }

    const preset = PROVIDER_PRESETS[provider];
    if (preset) {
      return { ...preset, email, password };
    }

    // Fallback: try to guess from email domain
    const domain = email.split('@')[1] ?? '';
    return {
      host: `imap.${domain}`,
      port: 993,
      email,
      password,
      tls: true,
    };
  }

  async fetchUnseen(config: ImapConfig): Promise<FetchResult> {
    const emails: RawEmail[] = [];
    const errors: string[] = [];

    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: {
        user: config.email,
        pass: config.password,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Search for unseen messages
        const uids: number[] = [];
        for await (const msg of client.fetch({ seen: false }, { uid: true })) {
          uids.push(msg.uid);
        }

        // Take most recent 50
        const recentUids = uids.slice(-50);

        for (const uid of recentUids) {
          try {
            const msg = await client.fetchOne(uid.toString(), {
              envelope: true,
              source: { maxLength: 5000 },
            });

            if (!msg || !msg.envelope) continue;

            const env = msg.envelope;
            const from = env.from?.[0]?.address ?? '';
            const subject = env.subject ?? '';
            const date = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
            const messageId = env.messageId ?? `${uid}-${Date.now()}`;

            let bodyPreview = '';
            if (msg.source) {
              bodyPreview = this.extractPreview(msg.source.toString('utf-8'));
            }

            emails.push({ uid, from, subject, date, bodyPreview, messageId });
          } catch (err) {
            errors.push(`Failed to fetch UID ${uid}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      errors.push(`IMAP connection error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { emails, errors };
  }

  async testConnection(config: ImapConfig): Promise<{ success: boolean; error?: string }> {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: { user: config.email, pass: config.password },
      logger: false,
    });

    try {
      await client.connect();
      await client.logout();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractPreview(source: string): string {
    // Strip MIME headers — look for the first blank line
    const headerEnd = source.indexOf('\r\n\r\n');
    let body = headerEnd >= 0 ? source.slice(headerEnd + 4) : source;

    // Strip HTML tags if present
    body = body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return body.slice(0, 500);
  }
}
