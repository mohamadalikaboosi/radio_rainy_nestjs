import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Reversible encryption for secrets that must be usable later (a Telegram session string cannot be hashed,
 * the client needs the original). AES-256-GCM: confidentiality + tamper detection, fresh random IV per write.
 * Envelope: v1:<iv>:<tag>:<ciphertext> (base64).
 */
export class SessionCipher {
  private readonly key: Buffer;
  private readonly aad: Buffer;

  /** `context` binds a ciphertext to its purpose (a session blob cannot be swapped in for a settings blob). */
  constructor(hexKey: string, context = 'telegram-session') {
    this.aad = Buffer.from(`radio_rainy:${context}:v1`);
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) throw new Error('Session encryption key must be 32 bytes (64 hex chars)');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }

  decrypt(envelope: string): string {
    const [version, iv, tag, ct] = envelope.split(':');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported session envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAAD(this.aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }
}
