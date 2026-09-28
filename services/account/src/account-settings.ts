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
export const accountLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const satisfies readonly AccountLocale[];

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

/** The language the person chose. `null` means none is stored; mail then uses
 * the language recorded at sign-up, never the request in front of an operator. */
export function emailLocale(user: { locale?: unknown } | null): AccountLocale | null {
  return isAccountLocale(user?.locale) ? user.locale : null;
}

type LocaleRow = { locale: string | null; signup_locale: string | null };
type LocaleDb = { query(sql: string, params?: unknown[]): Promise<{ rows: LocaleRow[] }> };

function chosenLocale(row: LocaleRow | undefined): AccountLocale | null {
  if (isAccountLocale(row?.locale)) return row.locale;
  if (isAccountLocale(row?.signup_locale)) return row.signup_locale;
  return null;
}

/** The sign-up request's language, remembered until the user row is visible.
 * Verification mail is sent while that insert is still uncommitted on another
 * connection, so the write happens in the user create-after hook. */
const signupRequestLocales = new Map<string, AccountLocale>();

export function rememberSignupRequestLocale(userId: string, request?: Request): AccountLocale {
  const resolved = accountLocale(request);
  signupRequestLocales.set(userId, resolved);
  return resolved;
}

export function takeSignupRequestLocale(userId: string, request?: Request): AccountLocale {
  const remembered = signupRequestLocales.get(userId);
  signupRequestLocales.delete(userId);
  return remembered ?? accountLocale(request);
}

/** Returns the language of this sign-up email: the language the person chose,
 * otherwise the language of the sign-up request. */
export async function languageForSignupEmail(db: LocaleDb, user: { id: string; locale?: unknown }, request?: Request): Promise<AccountLocale> {
  const resolved = rememberSignupRequestLocale(user.id, request);
  await db.query(`UPDATE "user" SET signup_locale = $2 WHERE id = $1 AND signup_locale IS NULL`, [user.id, resolved]);
  return emailLocale(user) ?? resolved;
}

/** The recipient's language. Mail is not sent in a language the account never had. */
export async function recipientLocale(db: LocaleDb, userId: string): Promise<AccountLocale> {
  const { rows } = await db.query(`SELECT locale, signup_locale FROM "user" WHERE id = $1`, [userId]);
  const locale = chosenLocale(rows[0]);
  if (!locale) throw new Error('Account language is not recorded');
  return locale;
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

/** WebAuthn rejects IP addresses as relying-party IDs, and local development
 * serves Account at 127.0.0.1. A loopback issuer therefore uses `localhost`
 * and accepts pages at that name; any other issuer is its own RP ID and origin. */
export function passkeyRelyingParty(baseURL: string): { rpID: string; origin: string | string[] } {
  const url = new URL(baseURL);
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return { rpID: url.hostname, origin: url.origin };
  const local = new URL(url);
  local.hostname = 'localhost';
  return { rpID: 'localhost', origin: [local.origin, url.origin] };
}

// A passkey step-up runs Better Auth's own assertion check, but it proves the
// signed-in person again; it must never open a second session.
const stepUpProof = new AsyncLocalStorage<{ userId: string; verified: boolean }>();

/** After a verified, user-verifying assertion: record when the passkey was
 * used, and end a step-up ceremony before the provider creates a session. */
export async function afterPasskeyAssertion(pool: Pool, credentialId: string, newCounter: number): Promise<void> {
  const proof = stepUpProof.getStore();
  if (!proof) {
    await pool.query('UPDATE passkey SET "rezicsLastUsedAt" = now() WHERE "credentialID" = $1', [credentialId]);
    return;
  }
  // Better Auth 1.7.5 invokes this hook before persisting newCounter. The
  // no-session exit below must perform that write itself. The predicate is
  // rechecked after concurrent row writers; a stale assertion cannot lower or
  // reuse a nonzero counter. Authenticators without counters may stay at zero.
  // https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion
  const used = await pool.query(`UPDATE passkey SET counter = $3, "rezicsLastUsedAt" = now()
    WHERE "credentialID" = $1 AND "userId" = $2
      AND (counter < $3 OR (counter = 0 AND $3 = 0)) RETURNING id`,
  [credentialId, proof.userId, newCounter]);
  proof.verified = used.rowCount === 1;
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
