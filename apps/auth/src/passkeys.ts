import { observeLogin, loginResultPhase, type LoginPhaseObserver } from './login-return';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { AUTH_POST_TIMEOUT_MS, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';
import { securityDevice, type SecurityPasskey } from './security';
import { performSecurityAction, type SecurityActionResult } from './security-reconciliation';
import { accountOperationProfile, type AccountOperationStepUpKind } from './account-operation-step-up';
import { SIGN_IN_CLIENT_ID, SIGN_IN_SCOPE, signInResult, type SignInResult } from './sign-in';
import { receiveSignInOptions, submitSignIn } from './sign-in-transport';
import {
  managementOperationProfile,
  type ManagementOperationKind,
  parsePasskeyEnrollmentOptions,
  parsePasskeyEnrollmentCreated,
  parsePasskeyEnrollmentError,
  passkeyEnrollmentResponseBytes,
  type PasskeyEnrollmentCreated,
  type PasskeyEnrollmentOptions,
} from '@rezics/auth-contract';
import { readJsonBounded } from './private-auth-json';
import { privateAuthRead } from './private-auth-read';

export const passkeysSupported = browserSupportsWebAuthn;
export const passkeyAutofillSupported = browserSupportsWebAuthnAutofill;

export type PasskeySignInResult = SignInResult | { ok: false; reason: 'cancelled' };

// Auth keeps a challenge for a few minutes, so options are shared between the autofill ceremony and the prompt only
// while they are younger. Sharing keeps a sign-in at two Auth calls however the person starts it.
const OPTIONS_MAX_AGE_MS = 4 * 60_000;
type SignInOptionsResult = Awaited<ReturnType<typeof receiveSignInOptions>>;
let held: { fetchedAt: number; result: Promise<SignInOptionsResult> } | null = null;

function signInOptions(): Promise<SignInOptionsResult> {
  if (!held || Date.now() - held.fetchedAt >= OPTIONS_MAX_AGE_MS) {
    const entry = {
      fetchedAt: Date.now(),
      result: receiveSignInOptions(),
    };
    held = entry;
    void entry.result.then((result) => {
      if (!result.ok && held === entry) held = null;
    });
    return entry.result;
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
  const result = signInResult(await submitSignIn('/signin/passkey', { response, ...profile }, profile));
  observe(loginResultPhase(result));
  return result;
}

export function passkeySignInFailure(result: Exclude<PasskeySignInResult, { ok: true } | { reason: 'cancelled' }>) {
  if (result.reason === 'credentials' || result.reason === 'suspended') return m.auth_passkey_denied();
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

// Preparation issues a fresh challenge. It is never shared, cached or retried.
async function enrollmentOptions(caller?: AbortSignal): Promise<AuthPostResult<PasskeyEnrollmentOptions>> {
  try {
    return await privateAuthRead(async (signal) => {
      const response = await fetch('/passkeys/register/options', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const value = await readJsonBounded(
        response,
        response.status === 200 ? passkeyEnrollmentResponseBytes.options : passkeyEnrollmentResponseBytes.error,
        signal,
      );
      if (response.status === 200) {
        const options = parsePasskeyEnrollmentOptions(value);
        if (!options) throw new Error('Enrollment options unavailable');
        return { ok: true, body: options };
      }
      const error = parsePasskeyEnrollmentError(value);
      return {
        ok: false,
        status: response.status,
        code: error?.error ?? 'unavailable',
        retryAfter: retryAfter(response),
      };
    }, caller);
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}

function retryAfter(response: Response): string | null {
  const header = response.headers.get('Retry-After');
  return header && /^\d+$/.test(header) ? header : null;
}

// Registration accepts 201 and cannot treat a lost acknowledgement as a refusal.
async function postCreated(
  path: string,
  body: unknown,
  caller?: AbortSignal,
  dispatch?: () => void,
): Promise<AuthPostResult<PasskeyEnrollmentCreated> | UnknownRegistration | PreDispatchCancellation> {
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
    return await Promise.race([sendCreated(path, body, controller.signal, dispatch), stopped]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
  }
}

async function sendCreated(
  path: string,
  body: unknown,
  signal: AbortSignal,
  dispatch?: () => void,
): Promise<AuthPostResult<PasskeyEnrollmentCreated> | UnknownRegistration | PreDispatchCancellation> {
  let dispatched = false;
  try {
    signal.throwIfAborted();
    dispatched = true;
    dispatch?.();
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await readJsonBounded(
      response,
      response.status === 201 ? passkeyEnrollmentResponseBytes.created : passkeyEnrollmentResponseBytes.error,
      signal,
    );
    if (response.status === 201) {
      const created = parsePasskeyEnrollmentCreated(value);
      return created ? { ok: true, body: created } : { ok: false, reason: 'unknown' };
    }
    const error = parsePasskeyEnrollmentError(value);
    // Only the native explicit refusal and its pre-dispatch rate limiter prove no effect.
    if (
      !error ||
      !(error.effect_status === 'not_applied' || (response.status === 429 && error.error === 'authentication_denied'))
    )
      return { ok: false, reason: 'unknown' };
    return { ok: false, status: response.status, code: error.error, retryAfter: retryAfter(response) };
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
  const options = await enrollmentOptions(signal);
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
  const created = await postCreated(
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
  const { id, name: savedName, created_at: createdAt } = created.body;
  observe('confirmed');
  return { ok: true, passkey: { id, name: savedName ?? '', created_at: createdAt, last_used_at: null } };
}

export type PasskeyRemoveResult = SecurityActionResult;

export async function removePasskey(id: string, accountId: string): Promise<PasskeyRemoveResult> {
  return performSecurityAction({ kind: 'passkey', id, accountId });
}
