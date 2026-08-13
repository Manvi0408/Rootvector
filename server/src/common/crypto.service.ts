import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * AES-256-GCM encryption for provider tokens at rest.
 * Key comes from INTEGRATIONS_ENCRYPTION_KEY (32 bytes, hex).
 */
@Injectable()
export class CryptoService {
  private key(): Buffer {
    const hex = process.env.INTEGRATIONS_ENCRYPTION_KEY || '';
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      throw new Error('INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes (64 hex chars).');
    }
    return buf;
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decrypt(payload: string): string {
    const [ivH, tagH, dataH] = payload.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(ivH, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagH, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataH, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}
