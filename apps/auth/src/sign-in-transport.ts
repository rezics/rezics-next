import {
  parseSignInError,
  parseSignInOptions,
  parseSignInProof,
  signInProofBytes,
  signInResponseBytes,
  type SignInProfile,
  type SignInOptions,
  type SignInProof,
} from '@rezics/auth-contract';
import type { AuthPostResult } from './api';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';

/** One deadline owns dispatch and bounded acknowledgement. Never retries possibly applied authentication. */
async function receive<T>(
  path: string,
  body: unknown,
  bytes: number,
  parse: (v: unknown) => T | null,
): Promise<AuthPostResult<T>> {
  try {
    return await privateAuthRead<AuthPostResult<T>>(async (signal) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const value = await readJsonBounded(
        response,
        response.status === 200 ? bytes : signInResponseBytes.error,
        signal,
      );
      if (response.status === 200) {
        const admitted = parse(value);
        if (admitted) return { ok: true, body: admitted };
      } else {
        const code = parseSignInError(value, response.status);
        const header = response.headers.get('retry-after');
        if (code)
          return {
            ok: false,
            status: response.status,
            code,
            retryAfter: header && /^\d+$/.test(header) ? header : null,
          };
      }
      return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
    });
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}
export const receiveSignInOptions = (): Promise<AuthPostResult<SignInOptions>> =>
  receive('/signin/passkey/options', {}, signInResponseBytes.options, parseSignInOptions);
export function submitSignIn(
  path: '/signin' | '/signin/passkey',
  body: unknown,
  profile: SignInProfile,
): Promise<AuthPostResult<SignInProof>> {
  const fixed = { client_id: profile.client_id, scope: [...profile.scope] };
  return receive(path, body, signInProofBytes(fixed), (value) =>
    parseSignInProof(value, fixed, path === '/signin' ? 'pwd' : 'pop'),
  );
}
