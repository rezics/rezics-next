'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { accountsConfig, httpOrigin } from '../config/env.ts';
import { classifyFailure } from '../api/errors.ts';
import { submitAuthForm } from './form-submit.ts';
import type { AuthFormContext, AuthFormState } from './form-state.ts';
import { authCookies } from './form-cookies.ts';

/** React emits native POST forms for this server reference, including before
 * hydration: https://react.dev/reference/react-dom/components/form */
export async function authenticate(
  context: AuthFormContext,
  previous: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const incoming = await headers();
  const config = accountsConfig();
  const result = await submitAuthForm(context, previous, form, async (path, body, captchaToken) => {
    const unsubscribe = path.startsWith('/api/account/mail/unsubscribe?');
    const outgoing = new Headers({
      accept: 'application/json',
      'content-type': unsubscribe ? 'application/x-www-form-urlencoded' : 'application/json',
      origin: httpOrigin('ACCOUNT_BASE_URL', config.ACCOUNT_BASE_URL),
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    });
    for (const name of ['cookie', 'accept-language', 'user-agent', 'cf-ipcountry']) {
      const value = incoming.get(name);
      if (value) outgoing.set(name, value);
    }
    const address = incoming.get('cf-connecting-ip');
    if (address) outgoing.set('x-forwarded-for', address);
    if (captchaToken) outgoing.set('x-captcha-response', captchaToken);
    let response: Response;
    try {
      response = await fetch(
        new URL(path, httpOrigin('ACCOUNT_SERVICE_ORIGIN', config.ACCOUNT_SERVICE_ORIGIN)),
        {
          method: 'POST',
          headers: outgoing,
          body: unsubscribe
            ? new URLSearchParams({ 'List-Unsubscribe': 'One-Click' })
            : JSON.stringify(body),
          redirect: 'manual',
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        },
      );
    } catch {
      return { ok: false, kind: 'unavailable', status: 0 };
    }
    // Preserve every issued/expired session and 2FA cookie with its attributes.
    const jar = await cookies();
    for (const cookie of authCookies(response.headers)) jar.set(cookie);
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return response.ok
      ? { ok: true, data: data ?? {} }
      : {
          ok: false,
          kind:
            unsubscribe && response.status === 400
              ? 'invalid-token'
              : classifyFailure(response.status, data),
          status: response.status,
        };
  });
  if ('redirect' in result) redirect(result.redirect);
  return result;
}
