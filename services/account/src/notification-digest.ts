import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountLocales, emailLocale } from './account-settings.ts';
import { enqueueAccountEmail, type AccountLocale } from './email.ts';
import { formatDigest } from './email-copy/index.ts';

const body = t.Object({ userId: t.String({ minLength: 1, maxLength: 128 }),
  day: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  more: t.Boolean(),
  counts: t.Array(t.Object({ topic: t.String({ maxLength: 64 }),
    count: t.Integer({ minimum: 1, maximum: 200 }) }), { minItems: 1, maxItems: 12 }) });
function authorized(value: string | null, secret: string): boolean {
  if (!secret || !value?.startsWith('Bearer ')) return false;
  const received = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function digestId(secret: string, userId: string, day: string): string {
  const bytes = createHmac('sha256', secret).update(`notification-digest-v1\0${userId}\0${day}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Main submits only topic counts. Account owns the current verified address,
 * idempotent queue identity and SMTP delivery. No subject text crosses owners. */
export function notificationDigestApi(pool: Pool, accountSecret: string, mainSecret: string,
  accountBaseUrl: string) {
  return new Elysia().post('/api/internal/notification-digest', { body }, async ({ request, body: input }) => {
    if (!authorized(request.headers.get('authorization'), mainSecret)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (input.day >= today || input.counts.some(item => !/^[a-z][a-z0-9_.-]{0,63}$/.test(item.topic))
      || new Set(input.counts.map(item => item.topic)).size !== input.counts.length) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const user = (await pool.query<{ email: string; emailVerified: boolean; locale: string | null; signup_locale: string | null }>(
      'SELECT email, "emailVerified", locale, signup_locale FROM "user" WHERE id = $1', [input.userId])).rows[0];
    if (!user?.emailVerified) return new Response(null, { status: 204 });
    const signup = accountLocales.includes(user.signup_locale as AccountLocale) ? user.signup_locale as AccountLocale : null;
    const locale = emailLocale(user) ?? signup;
    if (!locale) {
      console.error('Account digest skipped: language is not recorded');
      return new Response(null, { status: 204 });
    }
    const message = formatDigest(locale, input.counts, input.more);
    await enqueueAccountEmail(pool, accountSecret, { userId: input.userId, to: user.email,
      url: accountBaseUrl, purpose: 'digest', locale, message },
    digestId(accountSecret, input.userId, input.day));
    return new Response(null, { status: 204 });
  });
}
