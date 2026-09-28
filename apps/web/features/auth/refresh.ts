import { type AccountClient, type IssuedTokens, refreshTokens } from './account.ts';
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from './cookies.ts';
import { currentSessionRecord, decodeSessionRecord, type SessionRecord, tokenSubject } from './session-state.ts';

export type SessionRefresh =
  /** Nothing to do: signed out, the access token is still current, or Account
   * is unavailable (the request proceeds and a later one retries). */
  | { kind: 'current' }
  | { kind: 'refreshed'; tokens: IssuedTokens; user: SessionRecord['user'] }
  /** Account refused the refresh token: the session is over. */
  | { kind: 'ended' };

/** Next's request cookie store, as far as refresh reads it. */
export interface CookieReader { get(name: string): { value: string } | undefined }

/** One refresh at most per request, before anything reads the session. */
export async function refreshSession(cookies: CookieReader, client: AccountClient | null):
  Promise<SessionRefresh> {
  const refreshToken = cookies.get(REFRESH_COOKIE)?.value;
  const accessToken = cookies.get(ACCESS_COOKIE)?.value;
  if (accessToken) {
    // The shell and feature readers must name the same person. End a partial
    // or mismatched session before either can read it.
    return currentSessionRecord(cookies) ? { kind: 'current' } : { kind: 'ended' };
  }
  if (!refreshToken || !client) return { kind: 'current' };
  const result = await refreshTokens(client, refreshToken);
  if (result.status === 'unavailable') return { kind: 'current' };
  if (result.status === 'rejected') return { kind: 'ended' };
  const subject = tokenSubject(result.tokens.accessToken);
  const record = decodeSessionRecord(cookies.get(SESSION_COOKIE)?.value);
  // The record is display data; the token names who is signed in.
  const user = record && record.user.id === subject ? record.user
    : subject ? { id: subject, name: '', email: '', image: null } : null;
  return user ? { kind: 'refreshed', tokens: result.tokens, user } : { kind: 'ended' };
}
