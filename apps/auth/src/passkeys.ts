import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { authPost, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';
import { securityDevice, type SecurityPasskey } from './security';
import { accountOperationProfile, type AccountOperationStepUpKind } from './account-operation-step-up';
import { SIGN_IN_CLIENT_ID, SIGN_IN_SCOPE, signInResult, type SignInResult } from './sign-in';

export const passkeysSupported = browserSupportsWebAuthn;
export const passkeyAutofillSupported = browserSupportsWebAuthnAutofill;

export type PasskeySignInResult = SignInResult | { ok: false; reason: 'cancelled' };

// Auth keeps a challenge for a few minutes, so options are shared between the autofill ceremony and the prompt only
// while they are younger. Sharing keeps a sign-in at two Auth calls however the person starts it.
const OPTIONS_MAX_AGE_MS = 4 * 60_000;
type SignInOptions = AuthPostResult<PublicKeyCredentialRequestOptionsJSON>;
let held: { fetchedAt: number; result: Promise<SignInOptions> } | null = null;

function signInOptions(): Promise<SignInOptions> {
  if (!held || Date.now() - held.fetchedAt >= OPTIONS_MAX_AGE_MS) {
    const entry = {
      fetchedAt: Date.now(),
      result: authPost<PublicKeyCredentialRequestOptionsJSON>('/signin/passkey/options', {}),
    };
    held = entry;
    void entry.result.then((result) => {
      if (!result.ok && held === entry) held = null;
    });
  }
  return held.result;
}

// A person dismissing the prompt, or a newer ceremony replacing this one, is not a failure.
function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

// Signs in with a discoverable credential. With `autofill`, the browser offers passkeys in the email field and the
// call stays pending until the person picks one. Otherwise it prompts at once.
export async function signInWithPasskey({
  autofill = false,
  operation,
}: { autofill?: boolean; operation?: AccountOperationStepUpKind } = {}): Promise<PasskeySignInResult> {
  const fetched = await signInOptions();
  if (!fetched.ok) return signInResult(fetched);

  let response;
  try {
    response = await startAuthentication({ optionsJSON: fetched.body, useBrowserAutofill: autofill });
  } catch (error) {
    return isCancellation(error) ? { ok: false, reason: 'cancelled' } : { ok: false, reason: 'unavailable' };
  }
  // The challenge is spent once the response is sent.
  held = null;
  const profile = operation
    ? accountOperationProfile(operation)
    : { client_id: SIGN_IN_CLIENT_ID, scope: SIGN_IN_SCOPE };
  return signInResult(await authPost('/signin/passkey', { response, ...profile }));
}

export function passkeySignInFailure(result: Exclude<PasskeySignInResult, { ok: true } | { reason: 'cancelled' }>) {
  if (result.reason === 'credentials') return m.auth_passkey_denied();
  if (result.reason === 'rate-limited') return failureMessage(429, 'rate_limited', result.retryAfter);
  return failureMessage(503, 'unavailable', null);
}

// authPost accepts only 200 and registration answers 201, so this posts the same way and accepts 201.
async function postCreated<Body>(path: string, body: unknown): Promise<AuthPostResult<Body>> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 201) return { ok: true, body: (await response.json()) as Body };
    const errorBody: unknown = await response.json().catch(() => null);
    const code =
      errorBody && typeof errorBody === 'object' && 'error' in errorBody && typeof errorBody.error === 'string'
        ? errorBody.error
        : '';
    const header = response.headers.get('Retry-After');
    return {
      ok: false,
      status: response.status,
      code,
      retryAfter: header && /^\d+$/.test(header) ? header : null,
    };
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}

export type PasskeyAddResult =
  | { ok: true; passkey: SecurityPasskey }
  | { ok: false; reason: 'cancelled' | 'step-up' }
  | { ok: false; reason: 'failure'; message: string };

function defaultPasskeyName(): string | undefined {
  const device = securityDevice(navigator.userAgent);
  return device ? m.auth_security_device(device) : undefined;
}

function isStepUp(result: Extract<AuthPostResult, { ok: false }>): boolean {
  return result.status === 401 && result.code === 'step_up_required';
}

function addFailure(result: Extract<AuthPostResult, { ok: false }>): PasskeyAddResult {
  if (isStepUp(result)) return { ok: false, reason: 'step-up' };
  const message =
    result.status === 429 || result.status === 503
      ? failureMessage(result.status, result.code, result.retryAfter)
      : m.auth_security_passkey_add_failed();
  return { ok: false, reason: 'failure', message };
}

export async function addPasskey(name: string): Promise<PasskeyAddResult> {
  const options = await authPost<PublicKeyCredentialCreationOptionsJSON>('/passkeys/register/options', {});
  if (!options.ok) return addFailure(options);
  let response;
  try {
    response = await startRegistration({ optionsJSON: options.body });
  } catch (error) {
    return isCancellation(error)
      ? { ok: false, reason: 'cancelled' }
      : { ok: false, reason: 'failure', message: m.auth_security_passkey_add_failed() };
  }
  const chosen = name.trim() || defaultPasskeyName();
  const created = await postCreated<{ id?: unknown; name?: unknown; created_at?: unknown }>(
    '/passkeys/register',
    chosen ? { response, name: chosen } : { response },
  );
  if (!created.ok) return addFailure(created);
  const { id, name: savedName, created_at: createdAt } = created.body;
  if (typeof id !== 'string' || typeof savedName !== 'string' || typeof createdAt !== 'string')
    return { ok: false, reason: 'failure', message: failureMessage(503, 'unavailable', null) };
  return { ok: true, passkey: { id, name: savedName, created_at: createdAt, last_used_at: null } };
}

export type PasskeyRemoveResult =
  | { ok: true }
  | { ok: false; reason: 'step-up' }
  | { ok: false; reason: 'failure'; message: string };

export async function removePasskey(id: string): Promise<PasskeyRemoveResult> {
  const result = await authPost('/passkeys/remove', { id });
  if (result.ok) return { ok: true };
  if (isStepUp(result)) return { ok: false, reason: 'step-up' };
  const message =
    result.status === 409
      ? m.auth_security_passkey_last_credential()
      : result.status === 429 || result.status === 503
        ? failureMessage(result.status, result.code, result.retryAfter)
        : m.auth_security_passkey_remove_failed();
  return { ok: false, reason: 'failure', message };
}
