import { expect, test } from 'bun:test';
import type { SessionEnv } from '../src/session/client';
import { isAllowedSiteOrigin, newCsrfToken } from '../src/session/csrf';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../src/session/request';
import { authRequest } from '../src/session/routes';
import { readSessionIdentity } from '../src/session/state';

const origin = 'https://site.test';
const aliceId = 'A'.repeat(43);
const bobId = 'B'.repeat(43);
const aliceCsrf = newCsrfToken();
const bobCsrf = newCsrfToken();

type Credential =
  | { status: 'active'; subject: string; accessToken: string; csrfToken: string }
  | { status: 'absent' }
  | { status: 'unavailable'; csrfToken?: string };

function env(records: Record<string, Credential>, extras: Partial<SessionEnv> = {}): Partial<SessionEnv> {
  return {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: origin,
    SESSIONS: {
      idFromName: (id: string) => id,
      get: (id: string) => {
        const record = () => records[id] ?? { status: 'absent' as const };
        return {
          credential: async () => record(),
          credentialIfFresh: async () => record(),
          signedIn: async () => {
            const current = record();
            return current.status === 'active'
              ? { signedIn: true, subject: current.subject, csrfToken: current.csrfToken }
              : { signedIn: false, csrfToken: null };
          },
        };
      },
    } as unknown as SessionEnv['SESSIONS'],
    ...extras,
  };
}

function request(
  cookie?: string,
  init: { method?: string; origin?: string | null; csrf?: string | null; authorization?: string } = {},
): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set('cookie', `__Host-rezics_session=${cookie}`);
  if (init.origin !== null && (init.origin !== undefined || init.method === 'POST'))
    headers.set('origin', init.origin ?? origin);
  if (init.csrf !== null && init.csrf !== undefined) headers.set('x-csrf-token', init.csrf);
  if (init.authorization) headers.set('authorization', init.authorization);
  return new Request(`${origin}/media/item`, { method: init.method ?? 'GET', headers });
}

const aliceActive = {
  status: 'active' as const,
  subject: 'alice',
  accessToken: 'alice-token',
  csrfToken: aliceCsrf,
};
const bobActive = { status: 'active' as const, subject: 'bob', accessToken: 'bob-token', csrfToken: bobCsrf };
const forbidden = { problem: { status: 403, code: 'forbidden' } };
const unavailable = { problem: { status: 502, code: 'dependency_unavailable' } };

test('signed-out and invalid cookies admit no caller credential', async () => {
  const sessions = env({ [aliceId]: aliceActive });
  const anonymous = request();
  expect(await prepareSession(anonymous, sessions)).toBe(false);
  expect(viewerCredential(anonymous)).toBeNull();
  expect(sessionSubject(anonymous)).toBeUndefined();
  expect(await readSessionIdentity(anonymous, sessions)).toEqual({ state: 'signed-out', csrfToken: null });

  const invalid = request('short');
  expect(await prepareSession(invalid, sessions)).toBe(true);
  expect(viewerCredential(invalid)).toBeNull();
  expect(await readSessionIdentity(invalid, sessions)).toEqual({ state: 'signed-out', csrfToken: null });

  const unconfigured = request(aliceId);
  expect(await prepareSession(unconfigured, {})).toBe(false);
  expect(await readSessionIdentity(unconfigured, {})).toEqual({ state: 'unavailable', csrfToken: null });
  await expect(prepareSession(request(aliceId, { method: 'POST', csrf: aliceCsrf }), {})).rejects.toMatchObject(
    forbidden,
  );
});

test('admitted signed-in preparation keeps the current caller and does not resolve tokens for identity', async () => {
  const records = { [aliceId]: aliceActive };
  const sessions = env(records);
  const incoming = request(aliceId);
  expect(incoming.headers.get('authorization')).toBeNull();
  expect(await prepareSession(incoming, sessions)).toBe(false);
  expect(incoming.headers.get('authorization')).toBeNull();
  expect(viewerCredential(incoming)).toBe('Bearer alice-token');
  expect(sessionSubject(incoming)).toBe('alice');
  expect(requestCsrfToken(incoming)).toBe(aliceCsrf);

  const identityEnv: Partial<SessionEnv> = {
    ...sessions,
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          throw new Error('identity must not resolve tokens');
        },
        signedIn: async () => ({ signedIn: true, subject: 'alice', csrfToken: aliceCsrf }),
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
  expect(await readSessionIdentity(request(aliceId), identityEnv)).toEqual({
    state: 'signed-in',
    subject: 'alice',
    csrfToken: aliceCsrf,
  });
});

test('expired and unavailable sessions stay refused and do not become anonymous success', async () => {
  const records: Record<string, Credential> = { [aliceId]: { status: 'absent' } };
  const sessions = env(records);
  const expired = request(aliceId);
  expect(await prepareSession(expired, sessions)).toBe(true);
  expect(viewerCredential(expired)).toBeNull();
  expect(sessionSubject(expired)).toBeUndefined();
  expect(await readSessionIdentity(expired, sessions)).toEqual({ state: 'signed-out', csrfToken: null });

  records[aliceId] = { status: 'unavailable', csrfToken: aliceCsrf };
  const failed = request(aliceId);
  await expect(prepareSession(failed, sessions)).rejects.toMatchObject(unavailable);
  expect(viewerCredential(failed)).toBeNull();
  await expect(prepareSession(request(aliceId, { method: 'POST', csrf: aliceCsrf }), sessions)).rejects.toMatchObject(
    unavailable,
  );
  await expect(prepareSession(request(aliceId, { method: 'POST', csrf: bobCsrf }), sessions)).rejects.toMatchObject(
    forbidden,
  );
});

test('stale caller state cannot authorize a replacement request', async () => {
  const records: Record<string, Credential> = { [aliceId]: aliceActive, [bobId]: bobActive };
  const sessions = env(records);
  const alice = request(aliceId);
  const bob = request(bobId);
  expect(await prepareSession(alice, sessions)).toBe(false);
  expect(await prepareSession(bob, sessions)).toBe(false);
  expect(viewerCredential(alice)).toBe('Bearer alice-token');
  expect(sessionSubject(bob)).toBe('bob');
  expect(viewerCredential(bob)).toBe('Bearer bob-token');

  records[aliceId] = { status: 'absent' };
  const replaced = request(aliceId);
  expect(await prepareSession(replaced, sessions)).toBe(true);
  expect(viewerCredential(replaced)).toBeNull();
  expect(sessionSubject(replaced)).toBeUndefined();
  expect(viewerCredential(alice)).toBe('Bearer alice-token');

  const explicit = request(aliceId, { authorization: 'Bearer explicit' });
  records[aliceId] = aliceActive;
  expect(await prepareSession(explicit, sessions)).toBe(false);
  expect(viewerCredential(explicit)).toBe('Bearer explicit');
  expect(sessionSubject(explicit)).toBeUndefined();

  const explicitWrite = request(bobId, {
    method: 'POST',
    csrf: bobCsrf,
    authorization: 'Bearer explicit-write',
  });
  expect(await prepareSession(explicitWrite, sessions)).toBe(false);
  expect(viewerCredential(explicitWrite)).toBe('Bearer explicit-write');
  expect(sessionSubject(explicitWrite)).toBeUndefined();
});

test('unsafe session requests need the site Origin and matching CSRF token', async () => {
  const sessions = env({ [aliceId]: aliceActive });
  const cookie = { method: 'POST' as const, csrf: aliceCsrf };
  for (const headers of [
    { ...cookie, origin: null },
    { ...cookie, origin: 'https://evil.example' },
  ])
    await expect(prepareSession(request(aliceId, headers), sessions)).rejects.toMatchObject(forbidden);
  await expect(prepareSession(request(aliceId, { method: 'POST', csrf: null }), sessions)).rejects.toMatchObject(
    forbidden,
  );
  await expect(prepareSession(request(aliceId, { method: 'POST', csrf: bobCsrf }), sessions)).rejects.toMatchObject(
    forbidden,
  );
  const admitted = request(aliceId, { method: 'POST', csrf: aliceCsrf });
  expect(await prepareSession(admitted, sessions)).toBe(false);
  expect(viewerCredential(admitted)).toBe('Bearer alice-token');
  expect(isAllowedSiteOrigin(admitted, origin, origin)).toBe(true);
  expect(isAllowedSiteOrigin(admitted, 'https://evil.example', origin)).toBe(false);
  expect(isAllowedSiteOrigin(admitted, null, origin)).toBe(false);
});

test('auth and session responses do not broaden caller credentials', async () => {
  const sessions = env({ [aliceId]: aliceActive });
  const missing = await authRequest(new Request(`${origin}/auth/sign-in`), {});
  expect(missing.status).toBe(503);
  expect(missing.headers.get('cache-control')).toBe('private, no-store');
  expect(missing.headers.getSetCookie().join('\n')).not.toContain('alice-token');

  const method = await authRequest(new Request(`${origin}/auth/sign-out`, { method: 'GET' }), sessions);
  expect(method.status).toBe(405);
  expect(method.headers.get('allow')).toBe('POST');

  const callback = await authRequest(new Request(`${origin}/auth/callback`), sessions);
  expect(callback.status).toBe(400);
  expect(callback.headers.get('cache-control')).toBe('private, no-store');
  expect(callback.headers.getSetCookie().join('\n').toLowerCase()).toContain('max-age=0');

  const ended = await authRequest(new Request(`${origin}/auth/sign-out`, { method: 'POST' }), sessions);
  expect(ended.status).toBe(303);
  expect(ended.headers.get('location')).toBe('/');
  expect(ended.headers.get('cache-control')).toBe('private, no-store');
  expect(ended.headers.getSetCookie().join('\n')).toMatch(/__Host-rezics_session=;/);
  expect(ended.headers.getSetCookie().join('\n')).not.toContain('alice-token');
  expect(ended.headers.get('authorization')).toBeNull();
});
