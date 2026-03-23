import crypto from 'crypto';
import { execSync } from 'child_process';

// AES-256-GCM requires a 32-byte key
// Stored blob format: base64(iv[12] + authTag[16] + ciphertext[...])

let cachedKey: Buffer | null = null;

export function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  // 1. Check environment variable
  const envKey = process.env.ARTEMIS_ENCRYPTION_KEY;
  if (envKey) {
    cachedKey = crypto.createHash('sha256').update(envKey).digest();
    return cachedKey;
  }

  // 2. Fallback: derive from macOS machine UUID
  try {
    const output = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf-8' });
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) {
      cachedKey = crypto.createHash('sha256').update(match[1]).digest();
      return cachedKey;
    }
  } catch {}

  // 3. Final fallback: derive from hostname + username
  const fallback = `${process.env.USER ?? 'artemis'}@${require('os').hostname()}`;
  cachedKey = crypto.createHash('sha256').update(fallback).digest();
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(blob: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(blob, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Reset cached key (for testing)
export function resetKeyCache(): void {
  cachedKey = null;
}
