import { observeLogin, loginResultPhase, type LoginPhaseObserver } from './login-return';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { AUTH_POST_TIMEOUT_MS, authPost, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';
import { securityDevice, type SecurityPasskey } from './security';
import { performSecurityAction, type SecurityActionResult } from './security-reconciliation';
import { accountOperationProfile, type AccountOperationStepUpKind } from './account-operation-step-up';
import { SIGN_IN_CLIENT_ID, SIGN_IN_SCOPE, signInResult, type SignInResult } from './sign-in';
import { managementOperationProfile, type ManagementOperationKind } from '@rezics/auth-contract';

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
  management,
  isCurrent = () => true,
  onPhase,
}: {
  autofill?: boolean;
  operation?: AccountOperationStepUpKind;
  management?: ManagementOperationKind;
  isCurrent?: () => boolean;
  onPhase?: LoginPhaseObserver;
} = {}): Promise<PasskeySignInResult> {
  if (operation && management) return { ok: false, reason: 'unavailable' };
  const observe = (phase: Parameters<LoginPhaseObserver>[0]) => observeLogin(onPhase, phase);
  observe('options');
  const fetched = await signInOptions();
  if (!isCurrent()) return { ok: false, reason: 'cancelled' };
  if (!fetched.ok) {
    // Options failure is known pre-authentication work.
    return signInResult(fetched);
  }

  let response;
  observe('prompt');
  try {
    response = await startAuthentication({ optionsJSON: fetched.body, useBrowserAutofill: autofill });
  } catch (error) {
    observe(isCancellation(error) ? 'cancelled' : 'prompt');
    return isCancellation(error) ? { ok: false, reason: 'cancelled' } : { ok: false, reason: 'unavailable' };
  }
  if (!isCurrent()) return { ok: false, reason: 'cancelled' };
  // The challenge is spent once the response is sent.
  held = null;
  const profile = management
    ? managementOperationProfile(management)
    : operation
      ? accountOperationProfile(operation)
      : { client_id: SIGN_IN_CLIENT_ID, scope: SIGN_IN_SCOPE };
  observe('dispatched');
  const result = signInResult(await authPost('/signin/passkey', { response, ...profile }));
  observe(loginResultPhase(result));
  return result;
}

export function passkeySignInFailure(result: Exclude<PasskeySignInResult, { ok: true } | { reason: 'cancelled' }>) {
  if (result.reason === 'credentials') return m.auth_passkey_denied();
  if (result.reason === 'rate-limited') return failureMessage(429, 'rate_limited', result.retryAfter);
  return failureMessage(503, 'unavailable', null);
}

type UnknownRegistration = { ok: false; reason: 'unknown' };
type PreDispatchCancellation = { ok: false; reason: 'cancelled' };
export type PasskeyAddPhase =
  | 'options'
  | 'prompt'
  | 'registration-dispatched'
  | 'confirmed'
  | 'unknown'
  | 'cancelled'
  | 'failure';
export type PasskeyAddPhaseCallback = (phase: PasskeyAddPhase) => void;

function observePasskeyAdd(callback: PasskeyAddPhaseCallback | undefined, phase: PasskeyAddPhase): void {
  try {
    callback?.(phase);
  } catch {
    // Page bookkeeping must never change the result of the native ceremony.
  }
}

// Registration accepts 201 and cannot treat a lost acknowledgement as a refusal.
async function postCreated<Body>(
  path: string,
  body: unknown,
  caller?: AbortSignal,
  dispatch?: () => void,
): Promise<AuthPostResult<Body> | UnknownRegistration | PreDispatchCancellation> {
  if (caller?.aborted) return { ok: false, reason: 'cancelled' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const stopped = new Promise<UnknownRegistration>((resolve) => {
    cancel = () => {
      resolve({ ok: false, reason: 'unknown' });
      controller.abort();
    };
    timer = setTimeout(cancel, AUTH_POST_TIMEOUT_MS);
    caller?.addEventListener('abort', cancel, { once: true });
    if (caller?.aborted) cancel();
  });
  try {
    // The race also ends a transport that ignores abort, through body completion.
    return await Promise.race([sendCreated<Body>(path, body, controller.signal, dispatch), stopped]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
  }
}

async function sendCreated<Body>(
  path: string,
  body: unknown,
  signal: AbortSignal,
  dispatch?: () => void,
): Promise<AuthPostResult<Body> | UnknownRegistration | PreDispatchCancellation> {
  let dispatched = false;
  try {
    signal.throwIfAborted();
    dispatch?.();
    dispatched = true;
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 201) return { ok: true, body: (await response.json()) as Body };
    const errorBody: unknown = await response.json();
    const code =
      errorBody && typeof errorBody === 'object' && 'error' in errorBody && typeof errorBody.error === 'string'
        ? errorBody.error
        : '';
    const notApplied =
      errorBody &&
      typeof errorBody === 'object' &&
      'effect_status' in errorBody &&
      errorBody.effect_status === 'not_applied';
    if (!code || (!notApplied && ![400, 401, 403, 404, 409, 413, 415, 429].includes(response.status)))
      return { ok: false, reason: 'unknown' };
    const header = response.headers.get('Retry-After');
    return {
      ok: false,
      status: response.status,
      code,
      retryAfter: header && /^\d+$/.test(header) ? header : null,
    };
  } catch {
    return dispatched ? { ok: false, reason: 'unknown' } : { ok: false, reason: 'cancelled' };
  }
}

export type PasskeyAddResult =
  | { ok: true; passkey: SecurityPasskey }
  | UnknownRegistration
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

export async function addPasskey(
  name: string,
  signal?: AbortSignal,
  onPhase?: PasskeyAddPhaseCallback,
): Promise<PasskeyAddResult> {
  const observe = (phase: PasskeyAddPhase) => observePasskeyAdd(onPhase, phase);
  if (signal?.aborted) {
    observe('cancelled');
    return { ok: false, reason: 'cancelled' };
  }
  observe('options');
  const options = await authPost<PublicKeyCredentialCreationOptionsJSON>('/passkeys/register/options', {});
  if (signal?.aborted) {
    observe('cancelled');
    return { ok: false, reason: 'cancelled' };
  }
  if (!options.ok) {
    observe('failure');
    return addFailure(options);
  }
  let response;
  const cancel = () => WebAuthnAbortService.cancelCeremony();
  signal?.addEventListener('abort', cancel, { once: true });
  observe('prompt');
  try {
    response = await startRegistration({ optionsJSON: options.body });
  } catch (error) {
    if (isCancellation(error)) {
      observe('cancelled');
      return { ok: false, reason: 'cancelled' };
    }
    observe('failure');
    return { ok: false, reason: 'failure', message: m.auth_security_passkey_add_failed() };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  if (signal?.aborted) {
    observe('cancelled');
    return { ok: false, reason: 'cancelled' };
  }
  const chosen = name.trim() || defaultPasskeyName();
  const created = await postCreated<{ id?: unknown; name?: unknown; created_at?: unknown }>(
    '/passkeys/register',
    chosen ? { response, name: chosen } : { response },
    signal,
    () => observe('registration-dispatched'),
  );
  if ('reason' in created) {
    observe(created.reason === 'unknown' ? 'unknown' : 'cancelled');
    return created;
  }
  if (!created.ok) {
    observe('failure');
    return addFailure(created);
  }
  if (!created.body || typeof created.body !== 'object') {
    observe('unknown');
    return { ok: false, reason: 'unknown' };
  }
  const { id, name: savedName, created_at: createdAt } = created.body;
  if (typeof id !== 'string' || typeof savedName !== 'string' || typeof createdAt !== 'string') {
    observe('unknown');
    return { ok: false, reason: 'unknown' };
  }
  observe('confirmed');
  return { ok: true, passkey: { id, name: savedName, created_at: createdAt, last_used_at: null } };
}

export type PasskeyRemoveResult = SecurityActionResult;

export async function removePasskey(id: string, accountId: string): Promise<PasskeyRemoveResult> {
  return performSecurityAction({ kind: 'passkey', id, accountId });
}
