import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateInviteCode(): string {
  const raw = randomBytes(12).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  return argon2.verify(hash, secret);
}
