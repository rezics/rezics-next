import { createHash, randomBytes } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { markEmailChangeStep, recipientLocale } from './account-settings.ts';
import { enqueueAccountEmail } from './email.ts';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { requireStepUp } from './methods.ts';
import { consumeAccountLimit } from './rate-limit.ts';
import { observeAuthentication } from './security-activity.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => `ec_${randomBytes(32).toString('base64url')}`;
type Intent = { user_id: string; token_hash: string; stage: 'confirm' | 'verify'; old_email: string;
  new_email: string; security_generation: string; recovery_generation: string; callback_path: string };

function callbackPath(value: string, origin: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || /[\u0000-\u0020\u007f\\]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) throw new AccountProblem('invalid_request', 400);
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname.startsWith('//')) throw new AccountProblem('invalid_request', 400);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function transaction<T>(pool: Pool, write: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const result = await write(db);
    await db.query('COMMIT');
    return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

// Recovery takes the policy before touching credentials/security. Every stage
// holds that ordering through its generation check, intent consumption and
// effect. The security row exists even for accounts without a recovery policy.
async function lockAccount(db: PoolClient, userId: string) {
  const recovery = await db.query<{ generation: string }>(`SELECT generation FROM
    rezics_account_recovery_policy WHERE id = $1 FOR SHARE`, [userId]);
  const security = await db.query<{ generation: string; available: boolean }>(`SELECT generation,
    deletion_started_at IS NULL AND NOT password_reset_required AND
      (suspended_at IS NULL OR suspended_until <= now()) AS available
    FROM rezics_account_security WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (!security.rows[0]?.available) throw new AccountProblem('stale_request', 403);
  return { security: security.rows[0].generation, recovery: recovery.rows[0]?.generation ?? '0' };
}

function link(auth: AccountAuth, token: string, callback: string, stage: 'confirm' | 'verify') {
  const url = new URL('/api/auth/verify-email', String(auth.options.baseURL));
  url.searchParams.set('token', token);
  url.searchParams.set('callbackURL', callback);
  return markEmailChangeStep(url.toString(), stage === 'confirm' ? 'requested' : 'verified');
}

/** Constant indexed account/intent lookups; at most one pending intent per
 * person and one queue insertion per transition. The queue and transition
 * commit together so a failed enqueue never consumes the mailbox proof. */
export function emailChangeApi(auth: AccountAuth, pool: Pool) {
  const secret = String(auth.options.secret);
  const origin = new URL(String(auth.options.baseURL)).origin;
  return new Elysia()
    .post('/api/auth/change-email', { body: t.Object({ newEmail: t.String({ format: 'email', maxLength: 320 }),
      callbackURL: t.Optional(t.String({ maxLength: 2048 })) }) }, async ({ request, body }) => {
      try {
        const session = await accountSession(auth, request);
        await requireStepUp(pool, session);
        const callback = callbackPath(body.callbackURL ?? '/', origin);
        const newEmail = body.newEmail.toLowerCase();
        if (!await consumeAccountLimit(pool, secret, `change-email:${session.user.id}`, 5, 300)) {
          throw new AccountProblem('rate_limited', 429);
        }
        await transaction(pool, async db => {
          const generation = await lockAccount(db, session.user.id);
          // Recheck under the fence: reset/recovery may have revoked the
          // session while this request waited to acquire the account locks.
          await requireStepUp(db, session);
          const user = (await db.query<{ email: string; locale: unknown }>(
            'SELECT email, locale FROM "user" WHERE id = $1', [session.user.id])).rows[0];
          if (!user || user.email === newEmail) throw new AccountProblem('invalid_request', 400);
          // Preserve the provider's enumeration-safe answer for occupied mailboxes.
          if ((await db.query('SELECT 1 FROM "user" WHERE email = $1', [newEmail])).rowCount) return;
          const token = newToken();
          await db.query(`INSERT INTO rezics_account_email_change (user_id, token_hash, stage, old_email,
            new_email, security_generation, recovery_generation, callback_path, session_id, expires_at)
            VALUES ($1, $2, 'confirm', $3, $4, $5, $6, $7, $8, now() + interval '30 minutes')
            ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, stage = EXCLUDED.stage,
              old_email = EXCLUDED.old_email, new_email = EXCLUDED.new_email,
              security_generation = EXCLUDED.security_generation, recovery_generation = EXCLUDED.recovery_generation,
              callback_path = EXCLUDED.callback_path, session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at`,
          [session.user.id, digest(token), user.email, newEmail, generation.security, generation.recovery, callback, session.session.id]);
          await enqueueAccountEmail(db, secret, { userId: session.user.id, to: user.email,
            url: link(auth, token, callback, 'confirm'), purpose: 'change-email', locale: await recipientLocale(db, session.user.id) });
        });
        return accountJson({ status: true });
      } catch (error) { return accountFailure(error); }
    })
    .get('/api/auth/verify-email', async ({ request }) => {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      if (!token.startsWith('ec_')) {
        return observeAuthentication(auth, pool, request, () => auth.handler(request));
      }
      try {
        if (!/^ec_[A-Za-z0-9_-]{43}$/.test(token)) throw new AccountProblem('invalid_request', 400);
        const hash = digest(token);
        const found = await pool.query<{ user_id: string }>(
          'SELECT user_id FROM rezics_account_email_change WHERE token_hash = $1', [hash]);
        if (!found.rows[0]) throw new AccountProblem('stale_request', 403);
        const userId = found.rows[0].user_id;
        const callback = await transaction(pool, async db => {
          const generation = await lockAccount(db, userId);
          const intent = (await db.query<Intent>(`SELECT * FROM rezics_account_email_change
            WHERE user_id = $1 AND token_hash = $2 AND expires_at > clock_timestamp() FOR UPDATE`,
          [userId, hash])).rows[0];
          const user = (await db.query<{ email: string; locale: unknown }>(
            'SELECT email, locale FROM "user" WHERE id = $1', [userId])).rows[0];
          if (!intent || !user || user.email !== intent.old_email
            || generation.security !== intent.security_generation || generation.recovery !== intent.recovery_generation) {
            throw new AccountProblem('stale_request', 403);
          }
          if (intent.stage === 'confirm') {
            const token = newToken();
            await db.query(`UPDATE rezics_account_email_change SET stage = 'verify', token_hash = $2
              WHERE user_id = $1`, [userId, digest(token)]);
            await enqueueAccountEmail(db, secret, { userId, to: intent.new_email,
              url: link(auth, token, intent.callback_path, 'verify'), purpose: 'verify', locale: await recipientLocale(db, userId) });
          } else {
            const changed = await db.query(`UPDATE "user" SET email = $2, "emailVerified" = true, "updatedAt" = now()
              WHERE id = $1 AND email = $3 RETURNING id`, [userId, intent.new_email, intent.old_email]);
            if (!changed.rowCount) throw new AccountProblem('stale_request', 403);
            await db.query('DELETE FROM rezics_account_email_change WHERE user_id = $1', [userId]);
          }
          // Mailbox verification changes the address only. It never creates a
          // session or lets the URL override the callback stored at initiation.
          return new URL(link(auth, token, intent.callback_path, intent.stage)).searchParams.get('callbackURL')!;
        });
        return new Response(null, { status: 302, headers: { location: callback, 'cache-control': 'no-store' } });
      } catch (error) { return accountFailure(error); }
    });
}
