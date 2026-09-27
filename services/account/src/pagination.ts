import { createHmac, timingSafeEqual } from 'node:crypto';
import { t } from 'elysia';
import { AccountProblem } from './http.ts';

export const pageQuery = { limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String({ maxLength: 4096 })) };
const signature = (secret: string, scope: string, value: string) =>
  createHmac('sha256', secret).update(`${scope}\0${value}`).digest();
export function encodeCursor(secret: string, scope: string, key: string, id: string): string {
  const body = Buffer.from(JSON.stringify({ key, id })).toString('base64url');
  return `${body}.${signature(secret, scope, body).toString('base64url')}`;
}
export function decodeCursor(secret: string, scope: string, cursor?: string): { key: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [body, mac, extra] = cursor.split('.');
    const received = Buffer.from(mac!, 'base64url');
    const expected = signature(secret, scope, body!);
    if (extra || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('signature');
    const value = JSON.parse(Buffer.from(body!, 'base64url').toString()) as { key: unknown; id: unknown };
    if (typeof value.key !== 'string' || typeof value.id !== 'string') throw new Error('shape');
    return { key: value.key, id: value.id };
  } catch { throw new AccountProblem('invalid_request', 400); }
}
