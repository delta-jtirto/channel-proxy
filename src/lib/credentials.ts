import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function getEncryptionKey(): Buffer {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY environment variable is not set');
  }
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt a credentials object using AES-256-GCM.
 * Returns a string in format: iv:authTag:ciphertext (all hex-encoded).
 */
export function encryptCredentials(data: Record<string, unknown>): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Credentials blob for a Delta-OWNED voice/video account row. The column is
 * NOT NULL, but Delta-owned numbers use the shared env Twilio account, so we
 * store an empty (encrypted) object — resolveTwilioCreds then falls back to
 * TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. A host-BYO row would instead store
 * encryptCredentials({ account_sid, auth_token }).
 */
export function deltaOwnedCredentialsBlob(): string {
  return encryptCredentials({});
}

/**
 * Decrypt a credentials string produced by encryptCredentials().
 */
export function decryptCredentials(encoded: string): Record<string, unknown> {
  const key = getEncryptionKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credentials format');
  }

  const [ivHex, tagHex, encHex] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}
