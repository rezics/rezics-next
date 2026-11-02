import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadMineFollowingPage } from '../src/library/mine-following';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from '../src/library/personal-directory-address';

const siteOrigin = 'https://site.example.test';
const sessionId = 'a'.repeat(43);

function sessionEnv() {
  return {
    SITE_ORIGINS: siteOrigin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'directory-address-test',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credential: async () => ({ status: 'active', subject: 'viewer', accessToken: 'viewer-token' }) }),
    },
  } as never;
}

test('personal directory addresses keep opaque cursors bounded and malformed values distinct from page one', () => {
  expect(personalDirectoryAddress(undefined, PERSONAL_DIRECTORY_CURSOR_LIMITS.collections)).toEqual({
    cursor: null,
    valid: true,
  });
  expect(personalDirectoryAddress('opaque+/page==', PERSONAL_DIRECTORY_CURSOR_LIMITS.following)).toEqual({
    cursor: 'opaque+/page==',
    valid: true,
  });
  expect(personalDirectoryAddress('x'.repeat(4097), PERSONAL_DIRECTORY_CURSOR_LIMITS.collections)).toEqual({
    cursor: null,
    valid: false,
  });
  expect(personalDirectoryAddress('', PERSONAL_DIRECTORY_CURSOR_LIMITS.following).valid).toBe(false);
});

test('oversized Following addresses make no native read and stay an explicit invalid state', async () => {
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async () => {
      reads++;
      return Response.json({ follows: [], next: null });
    },
  });
  const cursor = 'x'.repeat(PERSONAL_DIRECTORY_CURSOR_LIMITS.following + 1);
  const page = await loadMineFollowingPage(
    client,
    new Request(`${siteOrigin}/en/library/following`, { headers: { cookie: `__Host-rezics_session=${sessionId}` } }),
    sessionEnv(),
    { cursor },
  );
  expect(page).toEqual({ signedIn: true, follows: [], next: null, addressInvalid: true });
  expect(reads).toBe(0);
});

test('Following route retains the oversized URL position for explicit address recovery', async () => {
  mock.module('../src/library/mine-following-actions', () => ({ readMineFollowingForViewer: () => undefined }));
  mock.module('../src/library/mine-following-page', () => ({ CurrentViewerMineFollowingPage: () => null }));
  const { Route } = await import('../src/routes/library/following');
  const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;
  const cursor = 'x'.repeat(PERSONAL_DIRECTORY_CURSOR_LIMITS.following + 1);
  expect(validateSearch({ cursor }).cursor).toBe(cursor);
});
