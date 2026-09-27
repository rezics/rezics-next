// Browser calls to the Account service through this origin's proxy. Each one
// maps to a Better Auth or oauth-provider endpoint of the pinned version.
import { classifyFailure, type Result } from './errors.ts';

/** Where to go next: the provider's continuation of an OAuth request, if any. */
export interface Continuation { redirect?: string }

export interface AccountApi {
  signIn(input: { email: string; password: string; oauthQuery?: string }): Promise<Result<Continuation>>;
  /** `verify` means the account needs its email verified before signing in. */
  signUp(input: { name: string; email: string; password: string; oauthQuery?: string }):
  Promise<Result<Continuation & { verify?: boolean }>>;
  requestPasswordReset(email: string): Promise<Result<void>>;
  resetPassword(token: string, newPassword: string): Promise<Result<void>>;
  sendVerificationEmail(email: string): Promise<Result<void>>;
  signOut(): Promise<Result<void>>;
  consent(accept: boolean, oauthQuery: string): Promise<Result<{ redirect: string }>>;
  updateName(name: string): Promise<Result<void>>;
  changeEmail(newEmail: string): Promise<Result<void>>;
  changePassword(input: { currentPassword: string; newPassword: string; signOutOthers: boolean }):
  Promise<Result<void>>;
  revokeSession(token: string): Promise<Result<void>>;
  revokeOtherSessions(): Promise<Result<void>>;
  removeAppAccess(consentId: string): Promise<Result<void>>;
  deleteAccount(password: string): Promise<Result<void>>;
}

async function post<T = unknown>(path: string, body: Record<string, unknown>): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, { method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body) });
  } catch {
    return { ok: false, kind: 'unavailable', status: 0 };
  }
  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) return { ok: false, kind: classifyFailure(response.status, data), status: response.status };
  return { ok: true, data: data as T };
}

function continuation(data: unknown): Continuation {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  // Same-origin continuations (consent) and product callbacks are both absolute
  // or root-relative URLs chosen by the provider, never by page input.
  return record.redirect === true && typeof record.url === 'string' ? { redirect: record.url } : {};
}

function done<T>(result: Result<T>): Result<void> {
  return result.ok ? { ok: true, data: undefined } : result;
}

// Account emails link back here; Better Auth accepts relative callback paths.
export const callbackPaths = { resetPassword: '/reset-password', verifyEmail: '/verify-email' };

export const browserAccountApi: AccountApi = {
  async signIn({ email, password, oauthQuery }) {
    const result = await post('/sign-in/email', { email, password, rememberMe: true,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    return result.ok ? { ok: true, data: continuation(result.data) } : result;
  },
  async signUp({ name, email, password, oauthQuery }) {
    const result = await post<{ token?: string | null }>('/sign-up/email', { name, email, password,
      callbackURL: callbackPaths.verifyEmail, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    if (!result.ok) return result;
    const next = continuation(result.data);
    // Without a session token the account (or an existing one) waits for email
    // verification; the answer is the same either way.
    return { ok: true, data: next.redirect || result.data?.token ? next : { verify: true } };
  },
  async requestPasswordReset(email) {
    return done(await post('/request-password-reset', { email, redirectTo: callbackPaths.resetPassword }));
  },
  async resetPassword(token, newPassword) {
    return done(await post('/reset-password', { token, newPassword }));
  },
  async sendVerificationEmail(email) {
    return done(await post('/send-verification-email', { email, callbackURL: callbackPaths.verifyEmail }));
  },
  async signOut() { return done(await post('/sign-out', {})); },
  async consent(accept, oauthQuery) {
    const result = await post('/oauth2/consent', { accept, oauth_query: oauthQuery });
    if (!result.ok) return result;
    const next = continuation(result.data);
    return next.redirect ? { ok: true, data: { redirect: next.redirect } }
      : { ok: false, kind: 'failed', status: 200 };
  },
  async updateName(name) { return done(await post('/update-user', { name })); },
  async changeEmail(newEmail) {
    return done(await post('/change-email', { newEmail, callbackURL: callbackPaths.verifyEmail }));
  },
  async changePassword({ currentPassword, newPassword, signOutOthers }) {
    return done(await post('/change-password', { currentPassword, newPassword,
      revokeOtherSessions: signOutOthers }));
  },
  async revokeSession(token) { return done(await post('/revoke-session', { token })); },
  async revokeOtherSessions() { return done(await post('/revoke-other-sessions', {})); },
  async removeAppAccess(consentId) { return done(await post('/oauth2/delete-consent', { id: consentId })); },
  async deleteAccount(password) { return done(await post('/delete-user', { password })); },
};
