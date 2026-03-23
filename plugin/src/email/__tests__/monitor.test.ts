import { describe, it, expect } from 'vitest';
import { EmailMonitor } from '../monitor.js';

describe('EmailMonitor', () => {
  describe('resolveConfig', () => {
    it('resolves Gmail preset', () => {
      const config = EmailMonitor.resolveConfig('gmail', 'user@gmail.com', 'pass');
      expect(config.host).toBe('imap.gmail.com');
      expect(config.port).toBe(993);
      expect(config.tls).toBe(true);
      expect(config.email).toBe('user@gmail.com');
      expect(config.password).toBe('pass');
    });

    it('resolves Outlook preset', () => {
      const config = EmailMonitor.resolveConfig('outlook', 'user@outlook.com', 'pass');
      expect(config.host).toBe('outlook.office365.com');
    });

    it('resolves Yahoo preset', () => {
      const config = EmailMonitor.resolveConfig('yahoo', 'user@yahoo.com', 'pass');
      expect(config.host).toBe('imap.mail.yahoo.com');
    });

    it('resolves iCloud preset', () => {
      const config = EmailMonitor.resolveConfig('icloud', 'user@icloud.com', 'pass');
      expect(config.host).toBe('imap.mail.me.com');
    });

    it('resolves custom provider with host and port', () => {
      const config = EmailMonitor.resolveConfig('custom|mail.example.com|143', 'user@example.com', 'pass');
      expect(config.host).toBe('mail.example.com');
      expect(config.port).toBe(143);
    });

    it('falls back to domain-based guessing for unknown provider', () => {
      const config = EmailMonitor.resolveConfig('unknown', 'user@mycompany.com', 'pass');
      expect(config.host).toBe('imap.mycompany.com');
      expect(config.port).toBe(993);
    });
  });
});
