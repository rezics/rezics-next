// Browser calls to the Account service through this origin's proxy. Each one
// maps to a Better Auth or oauth-provider endpoint of the pinned version, or to
// an Account route under /api/account.
import { parseContentPreferences, type ContentPreferences, type ContentPreferenceChange } from './content-preferences.ts';
import { classifyFailure, refusedMinimumAge, type FailureKind, type Result } from './errors.ts';
import { parseDisplayPreferences, type AccountLocale, type DisplayPreferences } from './account-data.ts';
import { parseGuardianPage, parseRecoveryPolicy, type GuardianPage, type RecoveryEnrollment,
  type RecoveryPolicyView } from './recovery-policy.ts';
import { creationOptions, credentialJson, isCancelled, passkeysSupported,
  requestOptions } from '../auth/webauthn.ts';

/** The exact policy text a person accepted: its policy and the digest of the displayed version. */
export interface PolicyAcceptance { policyId: 'terms' | 'privacy'; versionDigest: string }

/** Where to go next: the provider's continuation of an OAuth request, if any. */
interface Continuation { redirect?: string }
/** A new authenticator app: the `otpauth:` URI for its QR code, and backup codes. */
export interface TotpEnrollment { totpURI: string; backupCodes: string[] }

export interface RecoveryClaim {
  claimId: string;
  targetUserId: string;
  notBefore: string;
  expiresAt: string;
  approved: boolean;
  activated: boolean;
  replayed: boolean;
}

export interface AccountApi {
  readRecoveryPolicy(): Promise<Result<RecoveryPolicyView>>;
  readGuardianInvitations(cursor?: string): Promise<Result<GuardianPage>>;
  enrollRecovery(input: RecoveryEnrollment): Promise<Result<{ generation: string; replayed: boolean }>>;
  changeGuardian(invitationId: string, action: 'accept' | 'decline' | 'withdraw'):
    Promise<Result<{ state: string; replayed: boolean }>>;
  /** `twoFactor` means the password was right and a second step is needed. */
  signIn(input: { email: string; password: string; oauthQuery?: string }):
  Promise<Result<Continuation & { twoFactor?: boolean }>>;
  verifyTwoFactor(input: { code: string; method: 'totp' | 'backup-code'; trustDevice: boolean;
    oauthQuery?: string }): Promise<Result<Continuation>>;
  /** `conditional` offers passkeys in the email field's autofill until `signal` aborts. */
  signInWithPasskey(input: { oauthQuery?: string; conditional?: boolean; signal?: AbortSignal }):
  Promise<Result<Continuation>>;
  /** `verify` means the account needs its email verified before signing in. */
  signUp(input: { name: string; email: string; password: string; locale: AccountLocale; oauthQuery?: string;
    carry?: string; captchaToken?: string; minimumAgeConfirmed: boolean; acceptedPolicies: PolicyAcceptance[] }):
  Promise<Result<Continuation & { verify?: boolean }>>;
  /** Accept the current policies after a material change (the signed-in person's own receipt). */
  acceptPolicies(acceptedPolicies: PolicyAcceptance[]): Promise<Result<void>>;
  /** The confirmed one-click unsubscribe from optional email (RFC 8058); no sign-in. */
  unsubscribe(token: string): Promise<Result<void>>;
  requestPasswordReset(email: string, captchaToken?: string): Promise<Result<void>>;
  resetPassword(token: string, newPassword: string): Promise<Result<void>>;
  requestRecovery(input: {
    claimId: string;
    targetEmail: string;
    recoveryCode: string;
  }): Promise<Result<RecoveryClaim>>;
  readRecovery(claimId: string, recoveryCode: string): Promise<Result<RecoveryClaim>>;
  approveRecovery(claimId: string): Promise<Result<RecoveryClaim>>;
  activateRecovery(
    claimId: string,
    input: { recoveryCode: string; newPassword: string },
  ): Promise<Result<{ claimId: string; recoveryGeneration: string; replayed: boolean }>>;
  sendVerificationEmail(email: string, captchaToken?: string): Promise<Result<void>>;
  signOut(): Promise<Result<void>>;
  consent(accept: boolean, oauthQuery: string): Promise<Result<{ redirect: string }>>;
  /** Confirm it's you before a sensitive change; valid for five minutes. */
  reauthenticate(input: { password: string; totpCode?: string }): Promise<Result<void>>;
  reauthenticateWithPasskey(): Promise<Result<void>>;
  updateName(name: string): Promise<Result<void>>;
  setLocale(locale: AccountLocale): Promise<Result<void>>;
  setContentPreferences(value: ContentPreferenceChange): Promise<Result<ContentPreferences>>;
  setDisplayPreferences(value: DisplayPreferences): Promise<Result<DisplayPreferences>>;
  changeEmail(newEmail: string): Promise<Result<void>>;
  /** Changing the password always signs out every other device. */
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<Result<void>>;
  removePassword(): Promise<Result<void>>;
  addPasskey(): Promise<Result<void>>;
  renamePasskey(id: string, name: string): Promise<Result<void>>;
  removePasskey(id: string): Promise<Result<void>>;
  enableTotp(password?: string): Promise<Result<TotpEnrollment>>;
  confirmTotp(code: string): Promise<Result<void>>;
  renameTotp(name: string): Promise<Result<void>>;
  disableTotp(password?: string): Promise<Result<void>>;
  regenerateBackupCodes(password?: string): Promise<Result<string[]>>;
  revokeSession(sessionId: string): Promise<Result<void>>;
  revokeSessions(sessionIds: string[]): Promise<Result<void>>;
  revokeOtherSessions(): Promise<Result<void>>;
  revokeApp(clientId: string): Promise<Result<void>>;
  deleteAccount(password: string): Promise<Result<void>>;
  /** "Download your data": the archive of what Account keeps, after a recent sign-in. */
  exportData(): Promise<Result<{ file: Blob; name: string }>>;
}

type Body = Record<string, unknown>;

async function call<T = unknown>(path: string, body?: Body, captchaToken?: string): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
        ...(captchaToken ? { 'x-captcha-response': captchaToken } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch {
    return { ok: false, kind: 'unavailable', status: 0 };
  }
  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const minimumAge = refusedMinimumAge(data);
    return { ok: false, kind: classifyFailure(response.status, data), status: response.status,
      ...(minimumAge === undefined ? {} : { minimumAge }) };
  }
  return { ok: true, data: data as T };
}

async function putDisplayPreferences(value: DisplayPreferences): Promise<Result<DisplayPreferences>> {
  let response: Response;
  try {
    response = await fetch('/api/account/display-preferences', { method: 'PUT', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: value.revision, displayMode: value.displayMode,
        showZoneThemes: value.showZoneThemes }) });
  } catch { return { ok: false, kind: 'unavailable', status: 0 }; }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) return { ok: false, kind: classifyFailure(response.status, body), status: response.status };
  const parsed = parseDisplayPreferences(body);
  return parsed ? { ok: true, data: parsed } : { ok: false, kind: 'unavailable', status: response.status };
}
const auth = <T = unknown>(path: string, body?: Body, captchaToken?: string) => call<T>(`/api/auth${path}`, body, captchaToken);
const account = <T = unknown>(path: string, body?: Body) => call<T>(`/api/account${path}`, body);

function continuation(data: unknown): Continuation {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  // Same-origin continuations (consent) and product callbacks are both absolute
  // or root-relative URLs chosen by the provider, never by page input.
  return record.redirect === true && typeof record.url === 'string' ? { redirect: record.url } : {};
}

function done<T>(result: Result<T>): Result<void> {
  return result.ok ? { ok: true, data: undefined } : result;
}
const failed = (kind: FailureKind): Result<never> => ({ ok: false, kind, status: 0 });

/** A wrong password or code where the Account service answers only "forbidden". */
function credentialFailure<T>(result: Result<T>): Result<T> {
  return !result.ok && result.status === 403 && result.kind === 'failed'
    ? { ...result, kind: 'invalid-credentials' } : result;
}

// Account emails link back here; Better Auth accepts relative callback paths.
const callbackPaths = { resetPassword: '/reset-password', verifyEmail: '/verify-email',
  changeEmail: '/verify-email?change=email' };

/** A passkey assertion: options from the service, then the browser's prompt. */
async function assertPasskey(conditional = false, signal?: AbortSignal): Promise<Result<Body>> {
  if (!passkeysSupported()) return failed('cancelled');
  const options = await auth<Body>('/passkey/generate-authenticate-options');
  if (!options.ok) return conditional ? failed('cancelled') : options;
  try {
    const credential = await navigator.credentials.get({ publicKey: requestOptions(options.data), signal,
      ...(conditional ? { mediation: 'conditional' } : {}) }) as PublicKeyCredential | null;
    return credential ? { ok: true, data: credentialJson(credential) } : failed('cancelled');
  } catch (error) {
    // An autofill request the browser refuses was never the person's choice.
    return failed(conditional || isCancelled(error) ? 'cancelled' : 'failed');
  }
}

export const browserAccountApi: AccountApi = {
  async readRecoveryPolicy() {
    const result = await account('/recovery-policy/read', {});
    if (!result.ok) return result;
    const data = parseRecoveryPolicy(result.data);
    return data ? { ok: true, data } : failed('unavailable');
  },
  async readGuardianInvitations(cursor) {
    const result = await account('/recovery-guardians/read', cursor ? { cursor } : {});
    if (!result.ok) return result;
    const data = parseGuardianPage(result.data);
    return data ? { ok: true, data } : failed('unavailable');
  },
  enrollRecovery: input => account('/recovery-policy', { ...input }),
  changeGuardian: (invitationId, action) => account(`/recovery-guardians/${encodeURIComponent(invitationId)}`, { action }),
  async signIn({ email, password, oauthQuery }) {
    const result = await auth<{ twoFactorRedirect?: boolean }>('/sign-in/email', { email, password,
      rememberMe: true, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    if (!result.ok) return result;
    return { ok: true, data: result.data?.twoFactorRedirect ? { twoFactor: true } : continuation(result.data) };
  },
  async verifyTwoFactor({ code, method, trustDevice, oauthQuery }) {
    const result = await auth(method === 'totp' ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code',
      { code, trustDevice, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    return result.ok ? { ok: true, data: continuation(result.data) } : result;
  },
  async signInWithPasskey({ oauthQuery, conditional, signal }) {
    const assertion = await assertPasskey(conditional, signal);
    if (!assertion.ok) return assertion;
    const result = await auth('/passkey/verify-authentication', { response: assertion.data,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    return result.ok ? { ok: true, data: continuation(result.data) } : result;
  },
  async signUp({ name, email, password, locale, oauthQuery, carry, captchaToken, minimumAgeConfirmed, acceptedPolicies }) {
    // The verification link returns to where this sign-up started. Account keeps
    // only a minimum-age declaration at signup; birthdays belong to settings.
    const result = await auth<{ token?: string | null }>('/sign-up/email', { name, email, password, locale,
      minimumAgeConfirmed, acceptedPolicies,
      callbackURL: carry ? `${callbackPaths.verifyEmail}?${carry}` : callbackPaths.verifyEmail,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }, captchaToken);
    if (!result.ok) return result;
    const next = continuation(result.data);
    // Without a session token the account (or an existing one) waits for email
    // verification; the answer is the same either way.
    return { ok: true, data: next.redirect || result.data?.token ? next : { verify: true } };
  },
  async acceptPolicies(acceptedPolicies) {
    return done(await account('/policies/acceptance', { acceptedPolicies }));
  },
  async unsubscribe(token) {
    let response: Response;
    try {
      response = await fetch(`/api/account/mail/unsubscribe?${new URLSearchParams({ token })}`, {
        method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }) });
    } catch { return { ok: false, kind: 'unavailable', status: 0 }; }
    await response.body?.cancel();
    return response.ok ? { ok: true, data: undefined }
      : { ok: false, kind: response.status === 400 ? 'invalid-token' : classifyFailure(response.status, null),
        status: response.status };
  },
  async requestPasswordReset(email, captchaToken) {
    return done(await auth('/request-password-reset', { email, redirectTo: callbackPaths.resetPassword }, captchaToken));
  },
  async resetPassword(token, newPassword) {
    return done(await auth('/reset-password', { token, newPassword }));
  },
  requestRecovery: (input) => account('/recovery-claims', input),
  readRecovery: (claimId, recoveryCode) =>
    account(`/recovery-claims/${encodeURIComponent(claimId)}/read`, { recoveryCode }),
  approveRecovery: (claimId) =>
    account(`/recovery-claims/${encodeURIComponent(claimId)}/approval`, {}),
  activateRecovery: (claimId, input) =>
    account(`/recovery-claims/${encodeURIComponent(claimId)}/activation`, input),
  async sendVerificationEmail(email, captchaToken) {
    return done(await auth('/send-verification-email', { email, callbackURL: callbackPaths.verifyEmail }, captchaToken));
  },
  async signOut() { return done(await auth('/sign-out', {})); },
  async consent(accept, oauthQuery) {
    const result = await auth('/oauth2/consent', { accept, oauth_query: oauthQuery });
    if (!result.ok) return result;
    const next = continuation(result.data);
    return next.redirect ? { ok: true, data: { redirect: next.redirect } }
      : { ok: false, kind: 'failed', status: 200 };
  },
  async reauthenticate({ password, totpCode }) {
    return credentialFailure(done(await account('/reauthenticate', { password,
      ...(totpCode ? { totpCode } : {}) })));
  },
  async reauthenticateWithPasskey() {
    const assertion = await assertPasskey();
    if (!assertion.ok) return assertion;
    return credentialFailure(done(await account('/reauthenticate/passkey', { response: assertion.data })));
  },
  async updateName(name) { return done(await auth('/update-user', { name })); },
  async setLocale(locale) { return done(await auth('/update-user', { locale })); },
  async setContentPreferences(value) {
    const result = await account('/content-preferences', { ...value });
    if (!result.ok) return result;
    const data = parseContentPreferences(result.data);
    return data ? { ok: true, data } : failed('unavailable');
  },
  setDisplayPreferences: putDisplayPreferences,
  async changeEmail(newEmail) {
    return done(await auth('/change-email', { newEmail, callbackURL: callbackPaths.changeEmail }));
  },
  async changePassword({ currentPassword, newPassword }) {
    // A new password ends every session (Account's password fence); only this
    // one is re-issued, so the change never signs the person out here.
    return done(await auth('/change-password', { currentPassword, newPassword, revokeOtherSessions: true }));
  },
  async removePassword() { return done(await account('/methods/password/remove', {})); },
  async addPasskey() {
    if (!passkeysSupported()) return failed('cancelled');
    const options = await auth<Body>('/passkey/generate-register-options');
    if (!options.ok) return options;
    let credential: PublicKeyCredential | null;
    try {
      credential = await navigator.credentials.create({ publicKey: creationOptions(options.data) }) as
        PublicKeyCredential | null;
    } catch (error) {
      // InvalidStateError: this authenticator already holds a passkey for the account.
      return failed(isCancelled(error) ? 'cancelled'
        : error instanceof DOMException && error.name === 'InvalidStateError' ? 'conflict' : 'failed');
    }
    if (!credential) return failed('cancelled');
    return done(await auth('/passkey/verify-registration', { response: credentialJson(credential) }));
  },
  async renamePasskey(id, name) { return done(await auth('/passkey/update-passkey', { id, name })); },
  async removePasskey(id) { return done(await auth('/passkey/delete-passkey', { id })); },
  async enableTotp(password) {
    const result = await auth<{ totpURI?: unknown; backupCodes?: unknown }>('/two-factor/enable',
      password ? { password } : {});
    if (!result.ok) return result;
    const { totpURI, backupCodes } = result.data ?? {};
    return typeof totpURI === 'string' && totpURI.startsWith('otpauth://') && Array.isArray(backupCodes)
      ? { ok: true, data: { totpURI, backupCodes: backupCodes.map(String) } } : failed('failed');
  },
  async confirmTotp(code) { return done(await auth('/two-factor/verify-totp', { code })); },
  async renameTotp(name) { return done(await account('/methods/totp/name', { name })); },
  async disableTotp(password) { return done(await auth('/two-factor/disable', password ? { password } : {})); },
  async regenerateBackupCodes(password) {
    const result = await auth<{ backupCodes?: unknown }>('/two-factor/generate-backup-codes',
      password ? { password } : {});
    if (!result.ok) return result;
    return Array.isArray(result.data?.backupCodes)
      ? { ok: true, data: result.data.backupCodes.map(String) } : failed('failed');
  },
  async revokeSession(sessionId) { return done(await account('/sessions/revoke', { sessionId })); },
  async revokeSessions(sessionIds) { return done(await account('/sessions/revoke', { sessionIds })); },
  async revokeOtherSessions() { return done(await account('/sessions/revoke', { others: true })); },
  async revokeApp(clientId) {
    return done(await account(`/connected-apps/${encodeURIComponent(clientId)}/revoke`, {}));
  },
  async deleteAccount(password) { return done(await auth('/delete-user', password ? { password } : {})); },
  async exportData() {
    let response: Response;
    try {
      response = await fetch('/api/account/data-export', { method: 'POST', credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
    } catch { return failed('unavailable'); }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as unknown;
      return { ok: false, kind: classifyFailure(response.status, body), status: response.status };
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1]
      ?? 'rezics-account.json';
    try { return { ok: true, data: { file: await response.blob(), name } }; }
    catch { return failed('unavailable'); }
  },
};
