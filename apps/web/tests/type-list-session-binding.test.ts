import { expect, test } from 'bun:test';
import type { SessionEnv } from '../src/session/client';
import { newCsrfToken } from '../src/session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../src/session/request';

const origin = 'https://site.test';
const aliceId = 'A'.repeat(43);
const aliceCsrf = newCsrfToken();

type Credential =
  | { status: 'active'; subject: string; accessToken: string; csrfToken: string }
  | { status: 'absent' }
  | { status: 'unavailable'; csrfToken?: string };

function env(records: Record<string, Credential>): Partial<SessionEnv> {
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
  };
}

function request(cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set('cookie', `__Host-rezics_session=${cookie}`);
  return new Request(`${origin}/en/types/book`, { method: 'GET', headers });
}

/** TypeList BFF sequence: prepare every session, attach credentials only for a selected realm. */
async function typeListSession(
  incoming: Request,
  sessions: Partial<SessionEnv>,
  selectedRealm: boolean,
): Promise<{ authorization: string | undefined; reader: string | null }> {
  await prepareSession(incoming, sessions);
  if (!selectedRealm) return { authorization: undefined, reader: null };
  const authorization = viewerCredential(incoming) ?? undefined;
  return { authorization, reader: authorization ? (sessionSubject(incoming) ?? null) : null };
}

test('TypeList BFF prepares every session and attaches credentials only for selected-realm reads', async () => {
  const binding = await Bun.file(new URL('../src/features/pages/type-list-query.ts', import.meta.url)).text();
  const prepare = binding.indexOf('await prepareSession(request');
  const selected = binding.indexOf('if (hasSelectedRealmTarget(data.target))');
  const authorize = binding.indexOf('authorization = viewerCredential(request)');
  expect(prepare).toBeGreaterThan(0);
  expect(selected).toBeGreaterThan(prepare);
  expect(authorize).toBeGreaterThan(selected);
  expect(binding.slice(prepare, selected)).not.toContain('hasSelectedRealmTarget');
  expect(binding.slice(0, prepare)).not.toContain('viewerCredential(request)');
});

test('TypeList completion, revocation and suspension reuse the existing session transport', async () => {
  const records: Record<string, Credential> = {
    [aliceId]: { status: 'active', subject: 'alice', accessToken: 'alice-token', csrfToken: aliceCsrf },
  };
  const sessions = env(records);
  const completed = request(aliceId);
  expect(await typeListSession(completed, sessions, false)).toEqual({ authorization: undefined, reader: null });
  expect(await typeListSession(request(aliceId), sessions, true)).toEqual({
    authorization: 'Bearer alice-token',
    reader: 'alice',
  });

  records[aliceId] = { status: 'absent' };
  const revoked = request(aliceId);
  expect(await typeListSession(revoked, sessions, true)).toEqual({ authorization: undefined, reader: null });
  expect(viewerCredential(completed)).toBe('Bearer alice-token');

  records[aliceId] = { status: 'unavailable', csrfToken: aliceCsrf };
  const suspended = request(aliceId);
  await expect(typeListSession(suspended, sessions, true)).rejects.toMatchObject({
    problem: { status: 502, code: 'session_unavailable' },
  });
  expect(viewerCredential(suspended)).toBeNull();
});
