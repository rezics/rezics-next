import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { NextResponse } from 'vinext/shims/server';
import { EmailField, NameField, PasswordField, CodeField } from '../features/auth/fields.tsx';
import { submitAuthForm } from '../features/auth/form-submit.ts';
import type { AuthFormCall, AuthFormContext } from '../features/auth/form-state.ts';
import { authCookies } from '../features/auth/form-cookies.ts';
import { trustedFormRequest } from '../features/auth/form-request.ts';

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
};
const policies = [
  { policyId: 'terms' as const, versionDigest: 'a'.repeat(64) },
  { policyId: 'privacy' as const, versionDigest: 'b'.repeat(64) },
];
const context: AuthFormContext = {
  next: '/security',
  locale: 'zh-Hant',
  policies,
  localChallenge: true,
};
const success: AuthFormCall = async () => ({ ok: true, data: {} });
const refused: AuthFormCall = async () => ({ ok: false, kind: 'invalid-credentials', status: 401 });

describe('G1030: native authentication submissions before hydration', () => {
  test('native form actions receive the trusted edge country, with the same explicit local override as the proxy', () => {
    const request = new Request('https://accounts.test/sign-up', {
      headers: { 'cf-ipcountry': 'US' },
    });
    Object.defineProperty(request, 'cf', { value: { country: 'TW' }, configurable: true });
    expect(trustedFormRequest(request).headers.get('cf-ipcountry')).toBe('TW');
    expect(trustedFormRequest(request, true).headers.get('cf-ipcountry')).toBe('US');
    Object.defineProperty(request, 'cf', { value: {}, configurable: true });
    expect(trustedFormRequest(request).headers.get('cf-ipcountry')).toBeNull();
  });
  test('email typed in the DOM advances without any browser state or account enumeration', async () => {
    let called = false;
    const call: AuthFormCall = async () => {
      called = true;
      return { ok: true, data: {} };
    };
    expect(
      await submitAuthForm(
        context,
        {},
        form({ operation: 'email', email: ' ada@example.test ' }),
        call,
      ),
    ).toEqual({ email: 'ada@example.test', step: 'password' });
    expect(called).toBe(false);
    expect(
      await submitAuthForm(context, {}, form({ operation: 'email', email: '' }), call),
    ).toMatchObject({ step: 'email', errors: { email: 'emailRequired' } });
    expect(
      await submitAuthForm(context, {}, form({ operation: 'email', email: 'bad' }), call),
    ).toMatchObject({ errors: { email: 'emailInvalid' } });
  });

  test('a password submitted natively uses the API, keeps 2FA and never returns the password', async () => {
    const sent: unknown[] = [];
    const call: AuthFormCall = async (...args) => {
      sent.push(args);
      return { ok: true, data: { twoFactorRedirect: true } };
    };
    const result = await submitAuthForm(
      context,
      {},
      form({
        operation: 'password',
        email: 'ada@example.test',
        password: 'typed before hydration',
      }),
      call,
    );
    expect(sent).toEqual([
      [
        '/api/auth/sign-in/email',
        { email: 'ada@example.test', password: 'typed before hydration', rememberMe: true },
        undefined,
      ],
    ]);
    expect(result).toEqual({ email: 'ada@example.test', step: 'two-factor' });
    expect(JSON.stringify(result)).not.toContain('typed before hydration');
  });

  test('a refused password keeps the email and asks for another password', async () => {
    expect(
      await submitAuthForm(
        context,
        {},
        form({ operation: 'password', email: 'ada@example.test', password: 'bad password' }),
        refused,
      ),
    ).toEqual({
      email: 'ada@example.test',
      step: 'password',
      errors: { password: 'wrongPassword' },
    });
  });

  test('sign-in preserves the signed OAuth continuation and policy acceptance return', async () => {
    const oauthQuery = 'client_id=reader&sig=signed&ba_param=client_id';
    let body: Record<string, unknown> | undefined;
    const call: AuthFormCall = async (_path, sent) => {
      body = sent;
      return { ok: true, data: { redirect: true, url: '/consent?sig=next' } };
    };
    expect(
      await submitAuthForm(
        { ...context, oauthQuery },
        {},
        form({ operation: 'password', email: 'ada@example.test', password: 'a password' }),
        call,
      ),
    ).toEqual({ redirect: '/consent?sig=next' });
    expect(body?.oauth_query).toBe(oauthQuery);
    expect(
      await submitAuthForm(
        { ...context, next: '//evil.test' },
        {},
        form({ operation: 'password', email: 'ada@example.test', password: 'a password' }),
        success,
      ),
    ).toMatchObject({
      redirect: expect.stringContaining('/accept-policies?next=%2F&'),
    });
  });

  test.each(['totp', 'backup-code'])(
    'the %s form forwards the native trust-device choice',
    async (method) => {
      const values = {
        operation: 'two-factor',
        method,
        'trust-device': 'on',
        ...(method === 'totp' ? { code: '123456' } : { 'backup-code': 'saved-code' }),
      };
      let body: Record<string, unknown> | undefined;
      const call: AuthFormCall = async (_path, sent) => {
        body = sent;
        return { ok: true, data: {} };
      };
      await submitAuthForm(context, { email: 'ada@example.test' }, form(values), call);
      expect(body).toEqual({
        code: method === 'totp' ? '123456' : 'saved-code',
        trustDevice: true,
      });
    },
  );

  test('signup preserves native name, email, policy choice and displayed policy versions', async () => {
    let sent: Record<string, unknown> | undefined;
    const call: AuthFormCall = async (_path, body) => {
      sent = body;
      return { ok: true, data: { token: null } };
    };
    const result = await submitAuthForm(
      context,
      {},
      form({
        operation: 'sign-up',
        name: ' Ada ',
        email: 'ada@example.test',
        password: 'a longer password',
        confirm: 'a longer password',
        'accept-policies': 'on',
      }),
      call,
    );
    expect(sent).toMatchObject({
      name: 'Ada',
      email: 'ada@example.test',
      password: 'a longer password',
      minimumAgeConfirmed: true,
      acceptedPolicies: policies,
      locale: 'zh-Hant',
      callbackURL: '/verify-email',
    });
    expect(result).toEqual({ email: 'ada@example.test', outcome: 'sent' });
  });

  test('signup rejects mismatched passwords, missing acceptance and an absent challenge', async () => {
    const values = {
      operation: 'sign-up',
      name: 'Ada',
      email: 'ada@example.test',
      password: 'a longer password',
      confirm: 'wrong',
    };
    expect(await submitAuthForm(context, {}, form(values), success)).toMatchObject({
      errors: { confirm: 'passwordMismatch', accept: 'acceptRequired' },
    });
    expect(
      await submitAuthForm(
        { ...context, localChallenge: false },
        {},
        form({ ...values, confirm: values.password, 'accept-policies': 'on' }),
        success,
      ),
    ).toMatchObject({ failure: 'challenge-unavailable' });
  });

  test('the security challenge is forwarded and refusal does not serialize secrets', async () => {
    let captcha: string | undefined;
    const call: AuthFormCall = async (_path, _body, token) => {
      captcha = token;
      return { ok: false, kind: 'market-unavailable', status: 403 };
    };
    const result = await submitAuthForm(
      { ...context, localChallenge: false },
      {},
      form({
        operation: 'sign-up',
        name: 'Ada',
        email: 'ada@example.test',
        password: 'a secret pass phrase',
        confirm: 'a secret pass phrase',
        'accept-policies': 'on',
        'cf-turnstile-response': 'challenge-secret',
      }),
      call,
    );
    expect(captcha).toBe('challenge-secret');
    expect(result).toMatchObject({
      name: 'Ada',
      email: 'ada@example.test',
      accepted: true,
      failure: 'market-unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('recovery and reset work through their API paths and return rendered outcomes', async () => {
    const requests: string[] = [];
    const call: AuthFormCall = async (path) => {
      requests.push(path);
      return { ok: true, data: {} };
    };
    expect(
      await submitAuthForm(
        context,
        {},
        form({ operation: 'recover', email: 'ada@example.test' }),
        call,
      ),
    ).toEqual({ email: 'ada@example.test', outcome: 'sent' });
    expect(
      await submitAuthForm(
        { ...context, token: 'reset-secret' },
        {},
        form({
          operation: 'reset',
          password: 'a secret pass phrase',
          confirm: 'a secret pass phrase',
        }),
        call,
      ),
    ).toEqual({ outcome: 'done' });
    expect(requests).toEqual(['/api/auth/request-password-reset', '/api/auth/reset-password']);
  });

  test.each(['allow', 'deny'])(
    'a consent %s click sends the actual native submitter choice',
    async (decision) => {
      let sent: Record<string, unknown> | undefined;
      const call: AuthFormCall = async (_path, body) => {
        sent = body;
        return {
          ok: true,
          data: { redirect: true, url: 'https://client.test/callback?state=kept' },
        };
      };
      expect(
        await submitAuthForm(
          { oauthQuery: 'signed-request' },
          {},
          form({ operation: 'consent', decision }),
          call,
        ),
      ).toEqual({ redirect: 'https://client.test/callback?state=kept' });
      expect(sent).toEqual({ accept: decision === 'allow', oauth_query: 'signed-request' });
    },
  );

  test('policy accept, decline and account switching preserve the native click outcome', async () => {
    expect(await submitAuthForm(context, {}, form({ operation: 'accept' }), success)).toEqual({
      redirect: '/security',
    });
    expect(
      await submitAuthForm({ signIn: '//evil.test' }, {}, form({ operation: 'decline' }), success),
    ).toEqual({ redirect: '/sign-in?policy_declined=1' });
    expect(
      await submitAuthForm(
        { oauthQuery: 'signed-request' },
        {},
        form({ operation: 'consent', decision: 'switch' }),
        success,
      ),
    ).toEqual({ redirect: '/sign-in?signed-request' });
  });

  test('choosing another email or backup codes works before hydration without checking credentials', async () => {
    const call: AuthFormCall = async () => {
      throw new Error('a step change must not call Account');
    };
    expect(
      await submitAuthForm(
        context,
        { email: 'ada@example.test' },
        form({ operation: 'email-reset' }),
        call,
      ),
    ).toEqual({ email: 'ada@example.test', step: 'email' });
    expect(
      await submitAuthForm(
        context,
        { email: 'ada@example.test' },
        form({ operation: 'two-factor', 'method-switch': 'backup-code' }),
        call,
      ),
    ).toEqual({ email: 'ada@example.test', step: 'two-factor', backup: true });
  });

  test('a form cannot select an operation outside its server-bound purpose', async () => {
    const call: AuthFormCall = async () => {
      throw new Error('must reject before calling Account');
    };
    expect(
      await submitAuthForm(
        { operations: ['recover'] },
        {},
        form({ operation: 'consent', decision: 'allow' }),
        call,
      ),
    ).toEqual({ failure: 'failed' });
  });

  test('unavailable service and expired 2FA give retryable, non-secret state', async () => {
    const call: AuthFormCall = async () => ({ ok: false, kind: 'unavailable', status: 0 });
    expect(
      await submitAuthForm(
        context,
        {},
        form({ operation: 'password', email: 'ada@example.test', password: 'secret' }),
        call,
      ),
    ).toEqual({ email: 'ada@example.test', step: 'password', failure: 'unavailable' });
    const stale: AuthFormCall = async () => ({ ok: false, kind: 'stale', status: 403 });
    expect(
      await submitAuthForm(
        context,
        { email: 'ada@example.test' },
        form({ operation: 'two-factor', code: '123456' }),
        stale,
      ),
    ).toMatchObject({ step: 'password', failure: 'stale' });
  });

  test('framework cookie parsing keeps multiple session cookies, expiry and security attributes', () => {
    const headers = new Headers();
    headers.append(
      'set-cookie',
      '__Secure-session=abc%2Bdef; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600',
    );
    headers.append(
      'set-cookie',
      'two_factor=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
    const cookies = authCookies(headers);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({
      name: '__Secure-session',
      value: 'abc+def',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
    });
    expect(cookies[1]).toMatchObject({
      name: 'two_factor',
      value: '',
      expires: new Date(0),
      httpOnly: true,
    });
    const outgoing = new NextResponse();
    for (const cookie of cookies) outgoing.cookies.set(cookie);
    expect(outgoing.headers.getSetCookie()).toContain(
      'two_factor=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=lax',
    );
  });
});

test.each([EmailField, NameField, CodeField])(
  'G1030: %p renders a named native field with an initial default',
  (Field) => {
    const html = renderToString(
      createElement(Field, { label: 'Field', value: 'typed', onChange: () => undefined }),
    );
    expect(html).toContain('<input');
    expect(html).toContain('name=');
    expect(html).toContain('value="typed"');
  },
);
test('G1030: password and confirmation remain named native password inputs', () => {
  const html = renderToString(
    createElement(PasswordField, {
      label: 'Confirm',
      name: 'confirm',
      value: '',
      autoComplete: 'new-password',
      visibilityLabel: 'Show password',
      onChange: () => undefined,
    }),
  );
  expect(html).toContain('type="password"');
  expect(html).toContain('name="confirm"');
});
