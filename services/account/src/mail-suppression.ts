import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia } from 'elysia';
import type { Pool, PoolClient } from 'pg';

export const UNSUBSCRIBE_SECONDS = 180 * 86_400;
export type SuppressionReason = 'unsubscribe' | 'hard_bounce' | 'complaint';
export const normalizeMailAddress = (address: string) => address.trim().toLowerCase();
const sign = (secret: string, domain: string, value: string) =>
  createHmac('sha256', createHmac('sha256', secret).update(domain).digest())
    .update(value)
    .digest('base64url');
function matches(received: string, expected: string): boolean {
  const a = Buffer.from(received),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The address binds the mailbox at issuance, so an old link cannot suppress a
 * replacement address. No account lookup or session is needed by a receiver. */
export function unsubscribeToken(
  secret: string,
  userId: string,
  address: string,
  issuedAt = Math.floor(Date.now() / 1_000),
): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, address: normalizeMailAddress(address), purpose: 'digest', issuedAt }),
  ).toString('base64url');
  return `${payload}.${sign(secret, 'account-mail-unsubscribe-v1', payload)}`;
}
export function readUnsubscribeToken(
  secret: string,
  token: string,
  now = Math.floor(Date.now() / 1_000),
): { userId: string; address: string; purpose: 'digest'; issuedAt: number } | null {
  if (token.length > 2_048) return null;
  const parts = token.split('.');
  if (
    parts.length !== 2 ||
    !matches(parts[1]!, sign(secret, 'account-mail-unsubscribe-v1', parts[0]!))
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    if (
      typeof data.userId !== 'string' ||
      !data.userId ||
      typeof data.address !== 'string' ||
      data.address.length > 320 ||
      !data.address.includes('@') ||
      data.purpose !== 'digest' ||
      !Number.isSafeInteger(data.issuedAt) ||
      data.issuedAt > now ||
      now - data.issuedAt >= UNSUBSCRIBE_SECONDS
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
export function unsubscribeHeaders(
  baseURL: string,
  secret: string,
  userId: string,
  address: string,
) {
  const url = new URL('/api/account/mail/unsubscribe', baseURL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Optional mail requires an HTTPS unsubscribe URL');
  }
  url.searchParams.set('token', unsubscribeToken(secret, userId, address));
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** One primary-key probe, no retained-mail scan. Security purposes never call it. */
export async function optionalMailSuppressed(
  db: Pool | PoolClient,
  address: string,
): Promise<boolean> {
  return !!(
    await db.query(
      `SELECT 1 FROM rezics_mail_suppression WHERE address = $1 AND purpose = 'digest'`,
      [normalizeMailAddress(address)],
    )
  ).rows.length;
}
export async function suppressOptionalMail(
  db: Pool | PoolClient,
  address: string,
  reason: SuppressionReason,
  source: string,
) {
  await db.query(
    `INSERT INTO rezics_mail_suppression (address, purpose, reason, source)
    SELECT $1, 'digest', $2, $3 FROM
      (SELECT pg_advisory_xact_lock(hashtextextended('mail-digest:' || $1, 0))) locked
    ON CONFLICT (address, purpose) DO NOTHING`,
    [normalizeMailAddress(address), reason, source],
  );
}

/** Delivery and suppression serialize by mailbox. Once suppression commits,
 * another sender cannot start optional delivery; already-running SMTP finishes.
 * One connection and one keyed lock held for the bounded SMTP timeout. */
export async function deliverOptionalMail(
  pool: Pool,
  address: string,
  deliver: () => Promise<void>,
): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('mail-digest:' || $1, 0))`, [
      normalizeMailAddress(address),
    ]);
    const suppressed = await optionalMailSuppressed(db, address);
    if (!suppressed) await deliver();
    await db.query('COMMIT');
    return !suppressed;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

/** Provider adapters sign the exact UTF-8 request body and timestamp, never a
 * reserialized object. Five-minute freshness plus durable IDs bounds replay. */
export function mailEventSignature(secret: string, timestamp: string, body: string): string {
  return sign(secret, 'account-mail-events-v1', `${timestamp}\n${body}`);
}
/** Bound memory even when the sender omits or forges Content-Length. */
async function boundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('content-length') ?? 0) > maximum) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maximum) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export function mailSuppressionApi(pool: Pool, accountSecret: string, eventsSecret = '') {
  const app = new Elysia()
    .get('/api/account/mail/unsubscribe', async ({ request }) => {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      if (!readUnsubscribeToken(accountSecret, token))
        return Response.json({ error: 'invalid_unsubscribe' }, { status: 400 });
      // No effect on GET: scanners and link previews must not unsubscribe.
      return Response.json(
        { confirmationRequired: true, purpose: 'digest' },
        { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } },
      );
    })
    .post('/api/account/mail/unsubscribe', { parse: 'none' }, async ({ request }) => {
      const value = readUnsubscribeToken(
        accountSecret,
        new URL(request.url).searchParams.get('token') ?? '',
      );
      if (!value) return Response.json({ error: 'invalid_unsubscribe' }, { status: 400 });
      const bytes = await boundedBody(request, 1_024);
      if (!bytes) return new Response(null, { status: 413 });
      const type = request.headers.get('content-type')?.split(';')[0]?.trim();
      let oneClick: unknown;
      if (type === 'application/x-www-form-urlencoded') {
        const body = new TextDecoder().decode(bytes);
        oneClick = new URLSearchParams(body).get('List-Unsubscribe');
      } else if (type === 'multipart/form-data') {
        try {
          oneClick = (
            await new Response(bytes, {
              headers: { 'content-type': request.headers.get('content-type')! },
            }).formData()
          ).get('List-Unsubscribe');
        } catch {
          /* malformed form is invalid */
        }
      }
      if (oneClick !== 'One-Click')
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      await suppressOptionalMail(pool, value.address, 'unsubscribe', 'signed-link');
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    });
  if (!eventsSecret) return app;
  return app.post('/api/internal/mail-events', { parse: 'none' }, async ({ request }) => {
    const bytes = await boundedBody(request, 4_096);
    if (!bytes) return new Response(null, { status: 413 });
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const timestamp = request.headers.get('x-rezics-mail-timestamp') ?? '';
    const signature = request.headers.get('x-rezics-mail-signature') ?? '';
    if (
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1_000) - Number(timestamp)) > 300 ||
      !matches(signature, mailEventSignature(eventsSecret, timestamp, raw))
    ) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (
      !body ||
      typeof body.address !== 'string' ||
      body.address.length > 320 ||
      !body.address.includes('@') ||
      !['hard_bounce', 'complaint'].includes(body.type) ||
      ![body.source, body.eventId].every(
        (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value),
      )
    ) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const receipt = await db.query(
        `INSERT INTO rezics_mail_event (source, event_id) VALUES ($1, $2)
        ON CONFLICT DO NOTHING RETURNING event_id`,
        [body.source, body.eventId],
      );
      if (receipt.rowCount) await suppressOptionalMail(db, body.address, body.type, body.source);
      await db.query('COMMIT');
      return new Response(null, { status: 204 });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  });
}

/** Aggregate-only operator report; it neither decrypts payloads nor resends.
 * Cost: O(uncertain rows + suppressed addresses), two queries and one result per
 * suppression reason. The partial index excludes all successful mail history. */
export async function accountMailReport(pool: Pool) {
  const [uncertain, suppressed] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rezics_account_email WHERE state = 'uncertain'`,
    ),
    pool.query<{ reason: SuppressionReason; count: string }>(`SELECT reason, count(*)::text AS count
      FROM rezics_mail_suppression GROUP BY reason ORDER BY reason`),
  ]);
  return { uncertain: uncertain.rows[0]!.count, suppressed: suppressed.rows };
}
