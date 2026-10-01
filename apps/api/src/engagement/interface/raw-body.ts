import { PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';

/** Reads a raw (non-JSON) request body, refusing more than `maxBytes` (used for admin file uploads). */
export function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) return reject(new PayloadTooLargeException(`Max ${Math.round(maxBytes / 1024)} KB`));
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new PayloadTooLargeException(`Max ${Math.round(maxBytes / 1024)} KB`));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const isAllowedImage = (mime: string): boolean => IMAGE_MIMES.has(mime.toLowerCase().split(';')[0]?.trim() ?? '');
export const isAudio = (mime: string): boolean => /^audio\/[a-z0-9.+-]+$/i.test(mime.split(';')[0]?.trim() ?? '');
