import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { consumeAccountLimit } from './rate-limit.ts';

export const sensitiveAuthPaths = new Set([
  '/api/auth/change-password', '/api/auth/set-password', '/api/auth/change-email', '/api/auth/delete-user',
  '/api/auth/link-social', '/api/auth/unlink-account', '/api/auth/passkey/generate-register-options',
  '/api/auth/passkey/verify-registration', '/api/auth/passkey/delete-passkey', '/api/auth/passkey/update-passkey',
  '/api/auth/two-factor/enable', '/api/auth/two-factor/disable',
  '/api/auth/two-factor/generate-backup-codes', '/api/auth/two-factor/get-totp-uri',
]);

export async function requireStepUp(pool: Pool, session: { session: { id: string; createdAt: Date } }) {
  const current = await pool.query(`SELECT 1 FROM "session" s WHERE s.id = $1 AND s."expiresAt" > now()
    AND (s."createdAt" > now() - interval '5 minutes' OR EXISTS (
      SELECT 1 FROM rezics_account_step_up p WHERE p.session_id = s.id
        AND p.verified_at > now() - interval '5 minutes'))`, [session.session.id]);
  if (!current.rowCount) throw new AccountProblem('step_up_required', 403);
}

/** Bounded by method caps (32 passkeys, one password and one TOTP). Never
 * returns public keys, credential IDs, TOTP secrets or stored backup codes. */
export async function readMethods(pool: Pool, userId: string) {
  const passwords = await pool.query(`SELECT 1 FROM account WHERE "userId" = $1
    AND "providerId" = 'credential' AND password IS NOT NULL LIMIT 1`, [userId]);
  const passkeys = await pool.query<{ id: string; name: string | null; createdAt: Date; backedUp: boolean; deviceType: string }>(
    'SELECT id, name, "createdAt", "backedUp", "deviceType" FROM passkey WHERE "userId" = $1 ORDER BY "createdAt", id LIMIT 32', [userId]);
  const totp = await pool.query<{ id: string; name: string; verified: boolean }>(
    'SELECT id, name, verified FROM "twoFactor" WHERE "userId" = $1', [userId]);
  return { password: !!passwords.rowCount,
    passkeys: passkeys.rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
    totp: totp.rows[0] ?? null };
}

export function methodsApi(auth: AccountAuth, pool: Pool) {
  return new Elysia()
    .post('/api/auth/passkey/delete-passkey', { body: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
      async ({ request, body }) => {
        try {
          const session = await accountSession(auth, request);
          await requireStepUp(pool, session);
          try {
            const removed = await pool.query('DELETE FROM passkey WHERE id = $1 AND "userId" = $2 RETURNING id', [body.id, session.user.id]);
            if (!removed.rowCount) throw new AccountProblem('not_found', 404);
          } catch (error) {
            if (error instanceof Error && error.message === 'last_sign_in_method') throw new AccountProblem('last_sign_in_method', 409);
            throw error;
          }
          return accountJson({ status: true });
        } catch (error) { return accountFailure(error); }
      })
    .get('/api/account/methods', async ({ request }) => {
      try { return accountJson(await readMethods(pool, (await accountSession(auth, request)).user.id)); }
      catch (error) { return accountFailure(error); }
    })
    .post('/api/account/reauthenticate', { body: t.Object({
      password: t.String({ minLength: 1, maxLength: 128 }),
      totpCode: t.Optional(t.String({ pattern: '^\\d{6}$' })),
    }) }, async ({ request, body }) => {
      try {
        const session = await accountSession(auth, request);
        if (!await consumeAccountLimit(pool, String(auth.options.secret), `reauth:${session.user.id}`, 5, 300)) {
          throw new AccountProblem('rate_limited', 429);
        }
        try {
          await auth.api.verifyPassword({ headers: request.headers, body: { password: body.password } });
          const twoFactor = await pool.query('SELECT 1 FROM "user" WHERE id = $1 AND "twoFactorEnabled" = true', [session.user.id]);
          if (twoFactor.rowCount) {
            if (!body.totpCode) throw new Error('second factor required');
            await auth.api.verifyTOTP({ headers: request.headers, body: { code: body.totpCode } });
          }
        } catch { throw new AccountProblem('forbidden', 403); }
        await pool.query(`INSERT INTO rezics_account_step_up (session_id) VALUES ($1)
          ON CONFLICT (session_id) DO UPDATE SET verified_at = now()`, [session.session.id]);
        return accountJson({ verifiedUntil: new Date(Date.now() + 300_000).toISOString() });
      } catch (error) { return accountFailure(error); }
    })
    .post('/api/account/methods/totp/name', { body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }) },
      async ({ request, body }) => {
        try {
          const session = await accountSession(auth, request);
          await requireStepUp(pool, session);
          if (!body.name.trim()) throw new AccountProblem('invalid_request', 400);
          const result = await pool.query('UPDATE "twoFactor" SET name = $2 WHERE "userId" = $1 RETURNING id', [session.user.id, body.name.trim()]);
          if (!result.rowCount) throw new AccountProblem('not_found', 404);
          return accountJson({ status: true });
        } catch (error) { return accountFailure(error); }
      })
    .post('/api/account/methods/password/remove', async ({ request }) => {
      try {
        const session = await accountSession(auth, request);
        await requireStepUp(pool, session);
        try { await pool.query('DELETE FROM account WHERE "userId" = $1 AND "providerId" = \'credential\'', [session.user.id]); }
        catch (error) {
          if (error instanceof Error && error.message === 'last_sign_in_method') throw new AccountProblem('last_sign_in_method', 409);
          throw error;
        }
        return accountJson({ status: true });
      } catch (error) { return accountFailure(error); }
    });
}
