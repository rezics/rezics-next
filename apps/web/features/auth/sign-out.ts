import { NextResponse } from 'next/server';
import { type AccountClient, endAccountSession, revokeRefreshToken } from './account.ts';
import { clearCookies } from './cookies.ts';
import { safeReturnPath } from './paths.ts';

/** Ends the session: revokes the refresh token (and with it the access tokens
 * it issued), ends the Account session behind the sign-in, clears every
 * session cookie and returns to `next`. Cookies are cleared even when Account
 * cannot be reached: this browser is signed out either way, and an unrevoked
 * token expires on its own. */
export async function signOut(input: { requestUrl: string; cookieHeader: string;
  refreshToken: string | undefined; client: AccountClient | null; accountOrigin: string;
  next: string | null }): Promise<Response> {
  if (input.refreshToken && input.client) await revokeRefreshToken(input.client, input.refreshToken);
  const accountCookies = await endAccountSession(input.accountOrigin, input.cookieHeader,
    input.client?.fetch);
  const response = NextResponse.redirect(new URL(safeReturnPath(input.next, '/'), input.requestUrl), 303);
  clearCookies(response.cookies, input.requestUrl);
  // Appended after the last `cookies.set`, which rewrites the Set-Cookie list.
  for (const header of accountCookies) response.headers.append('set-cookie', header);
  response.headers.set('cache-control', 'no-store');
  return response;
}
