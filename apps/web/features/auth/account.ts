// Account's OAuth endpoints as the web server uses them. Every function takes
// its endpoint configuration and `fetch`, so tests drive them without a stack.
import { serverRead, serverDeadline } from '../api/server-read.ts';
import { SERVER_READ_LIMITS, waitForServerRead } from '../api/server-fetch.ts';

export interface AccountClient {
  accountOrigin: string;
  clientId: string;
  /** OAuth resource identifier for Main; tokens are audience-bound to it. */
  resource: string;
  fetch?: typeof fetch;
  deadlineAt?: number;
}

export interface IssuedTokens {
  accessToken: string;
  /** Absent only when Account did not grant `offline_access`. */
  refreshToken: string | null;
  expiresIn: number;
}

/** `rejected`: Account refused the grant, so the session is over. `unavailable`:
 * Account could not answer; keep the session and try again on a later request. */
export type TokenResult =
  | { status: 'issued'; tokens: IssuedTokens }
  | { status: 'rejected' }
  | { status: 'unavailable' };

async function tokenRequest(
  client: AccountClient,
  body: Record<string, string>,
): Promise<TokenResult> {
  let response: Response;
  try {
    response = await serverRead(
      new URL('/api/auth/oauth2/token', client.accountOrigin),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.clientId,
          resource: client.resource,
          ...body,
        }),
        cache: 'no-store',
      },
      {
        fetch: client.fetch,
        deadlineAt: client.deadlineAt,
        timeoutMs: SERVER_READ_LIMITS.metadata,
      },
    );
  } catch {
    return { status: 'unavailable' };
  }
  // RFC 6749 §5.2: a refused grant is a 400 (401 for client authentication).
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel();
    return { status: 'rejected' };
  }
  const issued = response.ok
    ? ((await response.json().catch(() => null)) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      } | null)
    : null;
  if (!response.ok) await response.body?.cancel();
  if (!issued || typeof issued.access_token !== 'string' || !issued.access_token) {
    return { status: 'unavailable' };
  }
  return {
    status: 'issued',
    tokens: {
      accessToken: issued.access_token,
      refreshToken:
        typeof issued.refresh_token === 'string' && issued.refresh_token
          ? issued.refresh_token
          : null,
      expiresIn: typeof issued.expires_in === 'number' ? issued.expires_in : 300,
    },
  };
}

export function exchangeCode(
  client: AccountClient,
  input: {
    code: string;
    redirectUri: string;
    verifier: string;
  },
): Promise<TokenResult> {
  return tokenRequest(client, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
}

// Account rotates refresh tokens and treats a second use of a rotated one as
// theft: it drops every refresh token of this client for the user. Concurrent
// requests carrying the same refresh cookie (parallel BFF calls after expiry)
// therefore share one exchange, and a request that arrives just after it
// finished, still carrying the old cookie, reuses its result. This holds
// within one server isolate; across isolates Account's refresh-token reuse
// interval has to cover the race.
const REUSE_WINDOW_MS = 30_000;
const MAX_TRACKED = 1_000;
const refreshes = new Map<string, { result: Promise<TokenResult>; settledAt?: number }>();

async function waitForRefresh(
  result: Promise<TokenResult>,
  deadlineAt?: number,
): Promise<TokenResult> {
  try {
    return await waitForServerRead(result, deadlineAt ?? (await serverDeadline()));
  } catch {
    return { status: 'unavailable' };
  }
}

export function refreshTokens(
  client: AccountClient,
  refreshToken: string,
  now: () => number = Date.now,
): Promise<TokenResult> {
  const time = now();
  for (const [key, entry] of refreshes) {
    if (entry.settledAt !== undefined && time - entry.settledAt > REUSE_WINDOW_MS)
      refreshes.delete(key);
  }
  const cacheKey = JSON.stringify([
    client.accountOrigin,
    client.clientId,
    client.resource,
    refreshToken,
  ]);
  const current = refreshes.get(cacheKey);
  if (current) return waitForRefresh(current.result, client.deadlineAt);
  if (refreshes.size >= MAX_TRACKED) {
    // Evicting a pending rotation would let a second call reuse its token.
    const settled = [...refreshes].find(([, tracked]) => tracked.settledAt !== undefined);
    if (!settled) return Promise.resolve({ status: 'unavailable' });
    refreshes.delete(settled[0]);
  }
  const entry: { result: Promise<TokenResult>; settledAt?: number } = {
    result: tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken }).then(
      (result) => {
        // A transient failure is retried by the next request instead of replayed.
        if (result.status === 'unavailable') refreshes.delete(cacheKey);
        else entry.settledAt = now();
        return result;
      },
    ),
  };
  refreshes.set(cacheKey, entry);
  return waitForRefresh(entry.result, client.deadlineAt);
}

/** RFC 7009 revocation of the refresh token; revoking it ends its access tokens too. */
export async function revokeRefreshToken(
  client: AccountClient,
  refreshToken: string,
): Promise<boolean> {
  try {
    const response = await serverRead(
      new URL('/api/auth/oauth2/revoke', client.accountOrigin),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }),
        cache: 'no-store',
      },
      {
        fetch: client.fetch,
        deadlineAt: client.deadlineAt,
        timeoutMs: SERVER_READ_LIMITS.metadata,
      },
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** The signed-in Account, by id only. The Account's name, email and image are
 * private: the site never asks for the `profile` or `email` scopes, never reads
 * them from userinfo and never stores them in the session. */
export interface AccountUser {
  id: string;
}

/** Confirms the issued token's Account, without an Accounts session cookie. */
export async function readOAuthUser(
  client: AccountClient,
  accessToken: string,
): Promise<AccountUser | null> {
  try {
    const response = await serverRead(
      new URL('/api/auth/oauth2/userinfo', client.accountOrigin),
      {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      },
      {
        fetch: client.fetch,
        deadlineAt: client.deadlineAt,
        timeoutMs: SERVER_READ_LIMITS.metadata,
      },
    );
    const user = (await response.json().catch(() => null)) as { sub?: unknown } | null;
    if (!response.ok || typeof user?.sub !== 'string' || !user.sub) return null;
    return { id: user.sub };
  } catch {
    return null;
  }
}
