import { failureMessage } from './api';
import { signIn, signInTarget, type SignInResult } from './sign-in';

export type StepUpOutcome = { ok: true; target: string } | { ok: false; message: string };

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
  const result = await signIn(email, password);
  if (!result.ok) return { ok: false, message: stepUpFailure(result) };
  return { ok: true, target: signInTarget(query, origin) };
}
