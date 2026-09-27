import { NextResponse } from 'next/server';
import { type AccountClient, revokeRefreshToken } from './account.ts';
import { clearCookies } from './cookies.ts';
import { safeReturnPath } from './paths.ts';

/** Ends this site's session: revokes the refresh token (and its access tokens),
 * clears every web session cookie and returns to `next`. Cookies are cleared even when Account
 * cannot be reached: this browser is signed out either way, and an unrevoked
 * token expires on its own. */
export async function signOut(input: { requestUrl: string;
  refreshToken: string | undefined; client: AccountClient | null;
  next: string | null }): Promise<Response> {
  if (input.refreshToken && input.client) await revokeRefreshToken(input.client, input.refreshToken);
  const response = NextResponse.redirect(new URL(safeReturnPath(input.next, '/'), input.requestUrl), 303);
  clearCookies(response.cookies, input.requestUrl);
  response.headers.set('cache-control', 'no-store');
  return response;
}
