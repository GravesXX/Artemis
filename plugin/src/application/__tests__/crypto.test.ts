import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, resetKeyCache } from '../crypto.js';

describe('Crypto', () => {
  beforeEach(() => {
    resetKeyCache();
  });

  it('round-trips encrypt/decrypt', () => {
    const plaintext = 'my-secret-password-123!';
    const blob = encrypt(plaintext);
    const decrypted = decrypt(blob);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for same plaintext (random IV)', () => {
    const blob1 = encrypt('same-password');
    const blob2 = encrypt('same-password');
    expect(blob1).not.toBe(blob2);
  });

  it('produces base64 output', () => {
    const blob = encrypt('test');
    expect(() => Buffer.from(blob, 'base64')).not.toThrow();
    const decoded = Buffer.from(blob, 'base64');
    // iv(12) + tag(16) + ciphertext(>=1) = at least 29 bytes
    expect(decoded.length).toBeGreaterThanOrEqual(29);
  });

  it('fails to decrypt tampered ciphertext', () => {
    const blob = encrypt('test');
    const data = Buffer.from(blob, 'base64');
    // Tamper with the ciphertext
    data[data.length - 1] ^= 0xff;
    const tampered = data.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('handles empty string', () => {
    const blob = encrypt('');
    expect(decrypt(blob)).toBe('');
  });

  it('handles unicode', () => {
    const text = 'P@ssw0rd! 你好 🔑';
    const blob = encrypt(text);
    expect(decrypt(blob)).toBe(text);
  });
});
