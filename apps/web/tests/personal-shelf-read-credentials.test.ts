import { expect, test } from 'bun:test';
import { readSubjectSlotSession } from '../src/library/subject-slot';
import type { SessionEnv } from '../src/session/client';

test('an active personal reader remains signed in when its CSRF mutation token is absent', async () => {
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:list',
    WEBSITE_CLIENT_ID: 'personal-shelf-read-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'owner',
          accessToken: 'authorized-reader',
          csrfToken: null,
        }),
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = new Request('https://site.test/en/library', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });

  expect(await readSubjectSlotSession(request, sessionEnv)).toEqual({
    state: 'signed-in',
    subject: 'owner',
    csrfToken: null,
    authorization: 'Bearer authorized-reader',
  });
});
