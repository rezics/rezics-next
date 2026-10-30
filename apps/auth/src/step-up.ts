import { failureMessage } from './api';
import { loadAccountSession } from './account-operations';
import { accountOperationSessionMatches, selectAccountOperationStepUp } from './account-operation-step-up';
import { passkeySignInFailure, signInWithPasskey } from './passkeys';
import { signIn, signInForAccountOperation, signInTarget, type SignInResult } from './sign-in';
import { m } from './paraglide/messages.js';

// A null message is a dismissed passkey prompt, which stays silent.
export type StepUpOutcome = { ok: true; target: string } | { ok: false; message: string | null };

// 401, 429 and 503 stay on the page. signIn already collapsed the Auth result to these three outcomes.
export function stepUpFailure(result: Exclude<SignInResult, { ok: true }>): string {
  if (result.reason === 'credentials') return failureMessage(401, 'authentication_denied', null);
  if (result.reason === 'rate-limited') return failureMessage(429, 'rate_limited', result.retryAfter);
  return failureMessage(503, 'unavailable', null);
}

export async function confirmStepUp(
  email: string,
  password: string,
  query: string,
  origin: string,
): Promise<StepUpOutcome> {
  const selection = selectAccountOperationStepUp(query);
  if (selection.kind === 'invalid') return { ok: false, message: m.auth_account_operation_failure() };
  const result =
    selection.kind === 'operation'
      ? await signInForAccountOperation(email, password, selection.pending.kind)
      : await signIn(email, password);
  if (!result.ok) return { ok: false, message: stepUpFailure(result) };
  if (selection.kind === 'operation') {
    const session = await loadAccountSession();
    if (session.kind !== 'ready' || !accountOperationSessionMatches(session, selection.pending))
      return { ok: false, message: m.auth_account_operation_failure() };
    return { ok: true, target: new URL(selection.pending.returnTo, origin).href };
  }
  return { ok: true, target: signInTarget(query, origin) };
}

export async function confirmStepUpWithPasskey(query: string, origin: string): Promise<StepUpOutcome> {
  const selection = selectAccountOperationStepUp(query);
  if (selection.kind === 'invalid') return { ok: false, message: m.auth_account_operation_failure() };
  const result = await signInWithPasskey(
    selection.kind === 'operation' ? { operation: selection.pending.kind } : undefined,
  );
  if (result.ok) {
    if (selection.kind === 'operation') {
      const session = await loadAccountSession();
      if (session.kind !== 'ready' || !accountOperationSessionMatches(session, selection.pending))
        return { ok: false, message: m.auth_account_operation_failure() };
      return { ok: true, target: new URL(selection.pending.returnTo, origin).href };
    }
    return { ok: true, target: signInTarget(query, origin) };
  }
  if (result.reason === 'cancelled') return { ok: false, message: null };
  return { ok: false, message: passkeySignInFailure(result) };
}
