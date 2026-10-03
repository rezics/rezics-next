import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';

const originalHeaders = { ...(await import('next/headers')) };
const originalNavigation = { ...(await import('next/navigation')) };

let incoming = new Headers();
const issued: Record<string, unknown>[] = [];
await mock.module('next/headers', () => ({
  headers: async () => incoming,
  cookies: async () => ({
    set: (cookie: Record<string, unknown>) => {
      issued.push(cookie);
    },
  }),
}));
class Redirect extends Error {
  constructor(public location: string) {
    super('redirect');
  }
}
await mock.module('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Redirect(location);
  },
}));
afterAll(async () => {
  await mock.module('next/headers', () => originalHeaders);
  await mock.module('next/navigation', () => originalNavigation);
});
const { authenticate } = await import('../features/auth/form-actions.ts');
const originalFetch = globalThis.fetch;
const originalService = process.env.ACCOUNT_SERVICE_ORIGIN;
const originalPublic = process.env.ACCOUNT_BASE_URL;

beforeEach(() => {
  issued.length = 0;
  incoming = new Headers({
    cookie: 'session=existing',
    'accept-language': 'zh-Hant',
    'cf-ipcountry': 'TW',
    'cf-connecting-ip': '192.0.2.1',
  });
  process.env.ACCOUNT_SERVICE_ORIGIN = 'https://account.internal';
  process.env.ACCOUNT_BASE_URL = 'https://accounts.test';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalService === undefined) delete process.env.ACCOUNT_SERVICE_ORIGIN;
  else process.env.ACCOUNT_SERVICE_ORIGIN = originalService;
  if (originalPublic === undefined) delete process.env.ACCOUNT_BASE_URL;
  else process.env.ACCOUNT_BASE_URL = originalPublic;
});
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
};

test('G1030: the native server action uses Account JSON and propagates session and 2FA cookies', async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://account.internal/api/auth/sign-in/email');
    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBe('https://accounts.test');
    expect(headers.get('cookie')).toBe('session=existing');
    expect(headers.get('cf-ipcountry')).toBe('TW');
    expect(headers.get('x-forwarded-for')).toBe('192.0.2.1');
    expect(headers.get('sec-fetch-mode')).toBe('cors');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'reader@example.test',
      password: 'typed password',
      rememberMe: true,
      oauth_query: 'signed-request',
    });
    const cookies = new Headers();
    cookies.append('set-cookie', 'session=fresh; HttpOnly; Secure; Path=/; SameSite=Lax');
    cookies.append('set-cookie', 'two_factor=challenge; HttpOnly; Path=/; Max-Age=600');
    return Response.json({ twoFactorRedirect: true }, { headers: cookies });
  }) as typeof fetch;
  expect(
    await authenticate(
      { operations: ['password'], oauthQuery: 'signed-request' },
      {},
      form({
        operation: 'password',
        email: 'reader@example.test',
        password: 'typed password',
      }),
    ),
  ).toEqual({ email: 'reader@example.test', step: 'two-factor' });
  expect(issued).toEqual([
    expect.objectContaining({
      name: 'session',
      value: 'fresh',
      httpOnly: true,
      secure: true,
      path: '/',
      sameSite: 'lax',
    }),
    expect.objectContaining({
      name: 'two_factor',
      value: 'challenge',
      httpOnly: true,
      maxAge: 600,
    }),
  ]);
});

test('G1030: a native declined policy clears the session cookie before redirecting', async () => {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    Response.json(
      {},
      {
        headers: {
          'set-cookie': 'session=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        },
      },
    )) as typeof fetch;
  await expect(
    authenticate(
      { operations: ['decline'], signIn: '/sign-in?policy_declined=1&next=%2Fsecurity' },
      {},
      form({ operation: 'decline' }),
    ),
  ).rejects.toMatchObject({ location: '/sign-in?policy_declined=1&next=%2Fsecurity' });
  expect(issued).toEqual([
    expect.objectContaining({ name: 'session', value: '', httpOnly: true, expires: new Date(0) }),
  ]);
});

test('G1030: service failure renders a retry without exposing the submitted password', async () => {
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request): Promise<Response> => {
      throw new Error('service unavailable');
    },
    { preconnect: originalFetch.preconnect },
  );
  const result = await authenticate(
    { operations: ['password'] },
    {},
    form({ operation: 'password', email: 'reader@example.test', password: 'private credential' }),
  );
  expect(result).toEqual({
    email: 'reader@example.test',
    step: 'password',
    failure: 'unavailable',
  });
  expect(JSON.stringify(result)).not.toContain('private credential');
  expect(issued).toEqual([]);
});

test('G1030: native signup sends the challenge and the bound displayed policy versions', async () => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('x-captcha-response')).toBe('provider-token');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      minimumAgeConfirmed: true,
      acceptedPolicies: [{ policyId: 'terms', versionDigest: 'displayed' }],
      locale: 'zh-Hant',
    });
    return Response.json({ token: null });
  }) as typeof fetch;
  expect(
    await authenticate(
      {
        operations: ['sign-up'],
        locale: 'zh-Hant',
        policies: [{ policyId: 'terms', versionDigest: 'displayed' }],
      },
      {},
      form({
        operation: 'sign-up',
        name: 'Reader',
        email: 'reader@example.test',
        password: 'private credential',
        confirm: 'private credential',
        'accept-policies': 'on',
        'cf-turnstile-response': 'provider-token',
      }),
    ),
  ).toEqual({ email: 'reader@example.test', outcome: 'sent' });
});

test('G1030: native unsubscribe preserves the service one-click encoding and confirmation', async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(
      'https://account.internal/api/account/mail/unsubscribe?token=signed-token',
    );
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(String(init?.body)).toBe('List-Unsubscribe=One-Click');
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  expect(
    await authenticate(
      { operations: ['unsubscribe'], token: 'signed-token' },
      {},
      form({ operation: 'unsubscribe' }),
    ),
  ).toEqual({ outcome: 'done' });
});
