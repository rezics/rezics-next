import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { readAboutDiscussion } from './about-discussion-api.ts';

/** Prove-phase missing record: GET /v1/zones/{zone}/routes?path=/original[&actingSubject={self}]
 * after Realm closure, HTTP 200 with realm:null and the independent mounted Work intact. */
for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator']) {
  test(`a closed attachment supplies no discussion or roster read for ${persona}`, async () => {
    const requests: string[] = [];
    const main = treaty<MainApp>('https://contract.invalid', { fetcher: (async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.pathname);
      if (!url.pathname.endsWith('/routes')) throw new Error('The closed Realm must not be read');
      return Response.json({ kind: 'detail', realm: null, zone: 'zone', path: '/original', revision: 'route',
        resource: { id: 'https://rezics.com/id/00000000-0000-4000-a000-000000000001' } });
    }) as typeof fetch });
    const signedIn = persona !== 'visitor';
    expect(await readAboutDiscussion(main, { zone: 'zone', path: '/original', signedIn,
      actingSubject: signedIn ? persona : undefined, personal: signedIn, postingOpen: true })).toEqual({ kind: 'none' });
    expect(requests).toEqual(['/v1/zones/zone/routes']);
  });
}
