import { AsyncLocalStorage } from 'node:async_hooks';
import { Elysia, t } from 'elysia';
import { APIError } from 'better-auth/api';
import type { Pool } from 'pg';
import { accountLocale, type AccountLocale } from './email.ts';
import { accountFailure, accountJson, AccountProblem, accountSession, type AccountAuth } from './http.ts';
import { consumeAccountLimit } from './rate-limit.ts';
import { accountResponses } from './views.ts';

/** Interface languages an account can choose. The Accounts site shows its pages
 * in it and every Account email to the person uses it. */
export const accountLocales = ['en', 'zh-CN'] as const satisfies readonly AccountLocale[];

function isAccountLocale(value: unknown): value is AccountLocale {
  return accountLocales.includes(value as AccountLocale);
}

/** `user.locale`, settable at sign-up and through update-user. Better Auth's
 * migration planner adds the nullable column; null means "not chosen yet". */
export const localeField = {
  type: 'string', required: false, input: true, returned: true,
  validator: { input: { '~standard': { version: 1, vendor: 'rezics',
    validate: (value: unknown) => isAccountLocale(value) ? { value }
      : { issues: [{ message: `locale must be one of ${accountLocales.join(', ')}` }] } } } },
} as const;

/** The account's chosen language, else the requesting browser's. */
export function emailLocale(user: { locale?: unknown }, request?: Request): AccountLocale {
  return isAccountLocale(user.locale) ? user.locale : accountLocale(request);
}

/** Better Auth sends both links of an email change back to the same callback.
 * Mark each step so the landing page can say what happened: `requested` after
 * the current address confirms, `verified` once the new address is verified. */
export function markEmailChangeStep(link: string, step: 'requested' | 'verified'): string {
  const url = new URL(link);
  const callback = url.searchParams.get('callbackURL');
  if (!callback?.startsWith('/') || callback.startsWith('//')) return link;
  const target = new URL(callback, url.origin);
  if (!target.searchParams.has('change')) return link;
  target.searchParams.set('change', step);
  url.searchParams.set('callbackURL', `${target.pathname}${target.search}`);
  return url.toString();
}

// A passkey step-up runs Better Auth's own assertion check, but it proves the
// signed-in person again; it must never open a second session.
const stepUpProof = new AsyncLocalStorage<{ userId: string; verified: boolean }>();

/** After a verified, user-verifying assertion: record when the passkey was
 * used, and end a step-up ceremony before the provider creates a session. */
export async function afterPasskeyAssertion(pool: Pool, credentialId: string): Promise<void> {
  const used = await pool.query<{ userId: string }>(`UPDATE passkey SET "rezicsLastUsedAt" = now()
    WHERE "credentialID" = $1 RETURNING "userId"`, [credentialId]);
  const proof = stepUpProof.getStore();
  if (!proof) return;
  proof.verified = used.rows[0]?.userId === proof.userId;
  throw new APIError('FORBIDDEN', { code: 'STEP_UP_ONLY', message: 'Verification complete' });
}

const base64url = (maxLength: number) => t.String({ minLength: 1, maxLength, pattern: '^[A-Za-z0-9_-]+$' });
/** A WebAuthn assertion as `PublicKeyCredential.toJSON()` encodes it. */
const assertionJson = t.Object({ id: base64url(1024), rawId: base64url(1024), type: t.Literal('public-key'),
  response: t.Object({ clientDataJSON: base64url(4096), authenticatorData: base64url(4096),
    signature: base64url(1024), userHandle: t.Optional(base64url(256)) }),
  clientExtensionResults: t.Record(t.String(), t.Unknown()),
  authenticatorAttachment: t.Optional(t.Union([t.Literal('platform'), t.Literal('cross-platform')])) });

export function accountSettingsApi(auth: AccountAuth, pool: Pool) {
  const secret = String(auth.options.secret);
  return new Elysia()
    // The same five-per-five-minutes budget as password step-up. The challenge
    // comes from /api/auth/passkey/generate-authenticate-options, which lists
    // only this account's passkeys for a signed-in request.
    .post('/api/account/reauthenticate/passkey', {
      body: t.Object({ response: assertionJson }, { additionalProperties: false }),
      response: accountResponses(t.Object({ verifiedUntil: t.String() })),
    }, async ({ request, body }) => {
      try {
        const session = await accountSession(auth, request);
        if (!await consumeAccountLimit(pool, secret, `reauth:${session.user.id}`, 5, 300)) {
          throw new AccountProblem('rate_limited', 429);
        }
        const proof = { userId: session.user.id, verified: false };
        await stepUpProof.run(proof, () => auth.api.verifyPasskeyAuthentication({
          headers: request.headers, body: { response: body.response } })).catch(() => undefined);
        if (!proof.verified) throw new AccountProblem('forbidden', 403);
        await pool.query(`INSERT INTO rezics_account_step_up (session_id) VALUES ($1)
          ON CONFLICT (session_id) DO UPDATE SET verified_at = now()`, [session.session.id]);
        return accountJson({ verifiedUntil: new Date(Date.now() + 300_000).toISOString() });
      } catch (error) { return accountFailure(error); }
    });
}
