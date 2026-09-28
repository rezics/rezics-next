import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { emailLocale } from './account-settings.ts';
import { enqueueAccountEmail } from './email.ts';

const body = t.Object({ userId: t.String({ minLength: 1, maxLength: 128 }),
  day: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  more: t.Boolean(),
  counts: t.Array(t.Object({ topic: t.String({ maxLength: 64 }),
    count: t.Integer({ minimum: 1, maximum: 200 }) }), { minItems: 1, maxItems: 12 }) });
const labels: Record<string, { en: string; zh: string }> = {
  reply: { en: 'Replies', zh: '回复' }, mention: { en: 'Mentions', zh: '提及' },
  'post-vote': { en: 'Votes on your posts', zh: '帖子获赞' },
  'followed-chapter': { en: 'New chapters', zh: '新章节' },
  'review-helpful': { en: 'Helpful review votes', zh: '书评获赞' },
  review: { en: 'Reviews', zh: '书评' },
  'submission-decision': { en: 'Submission decisions', zh: '提交决定' },
  'moderation-outcome': { en: 'Moderation outcomes', zh: '处理结果' },
  'realm-role-change': { en: 'Role changes', zh: '角色变更' },
  'realm-membership-change': { en: 'Membership changes', zh: '成员变更' },
  'realm-invitation': { en: 'Realm invitations', zh: 'Realm 邀请' },
  'claim-correction': { en: 'Claim corrections', zh: '声明更正' },
};

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
    const user = (await pool.query<{ email: string; emailVerified: boolean; locale: string | null }>(
      'SELECT email, "emailVerified", locale FROM "user" WHERE id = $1', [input.userId])).rows[0];
    if (!user?.emailVerified) return new Response(null, { status: 204 });
    const locale = emailLocale(user);
    const message = input.counts.map(item => locale === 'zh-Hans'
      ? `${labels[item.topic]?.zh ?? '通知'}：${item.count}`
      : `${labels[item.topic]?.en ?? 'Notifications'}: ${item.count}`).join('\n')
      + (input.more ? locale === 'zh-Hans' ? '\n还有更多通知，可在 REZICS 中查看。'
        : '\nMore notifications are waiting in REZICS.' : '');
    await enqueueAccountEmail(pool, accountSecret, { userId: input.userId, to: user.email,
      url: accountBaseUrl, purpose: 'digest', locale, message },
    digestId(accountSecret, input.userId, input.day));
    return new Response(null, { status: 204 });
  });
}
