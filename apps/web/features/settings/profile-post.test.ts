import { afterEach, expect, test } from 'bun:test';
import { uiLocales } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { profilePosts } from './profile-post.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const locale of uiLocales) test(`profile POST uses the form action for ${locale} and retains its body and credentials`, async () => {
  const body = new FormData();
  body.set('displayName', 'Ada Lovelace');
  const response = new Response(null, { status: 204 });
  const seen: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input, init) => { seen.push({ input, init }); return response; }) as typeof fetch;
  expect(await profilePosts[locale](body)).toBe(response);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.input).toBe(localizedPath('/settings/profile', locale));
  expect(seen[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  expect(seen[0]?.init?.body).toBe(body);
});

test('profile transport rejection reaches the form recovery handler', async () => {
  globalThis.fetch = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
  await expect(profilePosts.en(new FormData())).rejects.toThrow('offline');
});
