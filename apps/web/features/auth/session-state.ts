import type { AccountUser, IssuedTokens } from './account.ts';
import { ACCESS_COOKIE, accessMaxAge, type CookieOptions, type CookieWriter,
  cookieOptions, REFRESH_COOKIE, REFRESH_LIFETIME_SECONDS, SESSION_COOKIE,
  SESSION_KEY_COOKIE } from './cookies.ts';

/** What the site shows about the signed-in person, kept beside the tokens. */
export interface SessionRecord {
  user: AccountUser;
  /** When the session ends unless a refresh happens first (each rotation extends it). */
  expiresAt: string;
}

const agentIri = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isAgentIri(value: unknown): value is string {
  return typeof value === 'string' && agentIri.test(value);
}

export function encodeSessionRecord(record: SessionRecord): string {
  return Buffer.from(JSON.stringify(record)).toString('base64url');
}

export function decodeSessionRecord(value: string | undefined): SessionRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Partial<SessionRecord>;
    const user = parsed.user;
    if (typeof user?.id !== 'string' || !user.id
      || typeof parsed.expiresAt !== 'string' || Number.isNaN(Date.parse(parsed.expiresAt))) return null;
    // A cookie written before the Account's name and email were dropped keeps only the id.
    return { user: { id: user.id }, expiresAt: parsed.expiresAt };
  } catch { return null; }
}

/** The identity shared by the shell and feature readers after proxy refresh. */
export function currentSessionRecord(jar: { get(name: string): { value: string } | undefined }): SessionRecord | null {
  const accessToken = jar.get(ACCESS_COOKIE)?.value;
  const record = decodeSessionRecord(jar.get(SESSION_COOKIE)?.value);
  return accessToken && record?.user.id === tokenSubject(accessToken) ? record : null;
}

/** Unverified claims of a JWT; only for matching identities the server already
 * trusts (Main verifies every token it receives). */
export function tokenSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch { return null; }
}

export interface SessionCookie { name: string; value: string; options: CookieOptions }

/** Cookies for issued tokens and the session record. The session lasts as long
 * as the refresh token; without one it ends with the access token. */
export function sessionCookies(requestUrl: string, tokens: IssuedTokens, user: AccountUser,
  now = Date.now()): SessionCookie[] {
  const lifetime = tokens.refreshToken ? REFRESH_LIFETIME_SECONDS : accessMaxAge(tokens.expiresIn);
  const record = encodeSessionRecord({ user,
    expiresAt: new Date(now + lifetime * 1000).toISOString() });
  return [
    { name: ACCESS_COOKIE, value: tokens.accessToken,
      options: cookieOptions(requestUrl, accessMaxAge(tokens.expiresIn)) },
    { name: SESSION_COOKIE, value: record, options: cookieOptions(requestUrl, lifetime) },
    ...tokens.refreshToken ? [{ name: REFRESH_COOKIE, value: tokens.refreshToken,
      options: cookieOptions(requestUrl, lifetime) }] : [],
  ];
}

export function writeCookies(writer: CookieWriter, cookies: readonly SessionCookie[]): void {
  for (const cookie of cookies) writer.set(cookie.name, cookie.value, cookie.options);
}

export function writeSessionKey(writer: CookieWriter, requestUrl: string, key: string): void {
  writer.set(SESSION_KEY_COOKIE, key, cookieOptions(requestUrl, REFRESH_LIFETIME_SECONDS));
}
