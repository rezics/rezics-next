import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { discoveryApi } from './api.ts';
import { readBrowse } from './browse-read.ts';
import { realmSearchFixture, independentOriginal } from './realm-search-fixtures.ts';
import { cataloguePersonas } from '../zones/catalogue-browse-fixtures.ts';

for (const persona of cataloguePersonas) {
  test(`${persona}: closed Realm searches and bound continuations are ordinary unavailable; global originals retain credit`, async () => {
    for (const kind of ['closed', 'closed-continuation', 'global'] as const) {
      const fixture = realmSearchFixture(kind);
      const calls: { request: Request; credentials: RequestCredentials | undefined }[] = [];
      const main = browserMainApi('https://story.invalid', { anonymous: persona === 'visitor',
        fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          calls.push({ request, credentials: init?.credentials });
          expect(await request.clone().json()).toEqual(fixture.query);
          return new Response(JSON.stringify(fixture.answer), { status: fixture.status,
            headers: { 'content-type': 'application/json' } });
        }) as typeof fetch });
      const read = await readBrowse(() => discoveryApi(main, 'en').resources(fixture.query));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.credentials).toBe(persona === 'visitor' ? 'omit' : 'same-origin');
      if (kind === 'global') {
        expect(read).toMatchObject({ ok: true, data: { items: [independentOriginal],
          count: { kind: 'exact', value: 1 }, complete: true, nextCursor: null } });
        expect(fixture.query.context).toBe('global');
      } else {
        expect(read).toEqual({ ok: false, moved: false, status: 404, problem: fixture.answer });
        expect(JSON.stringify(fixture.answer)).not.toContain(independentOriginal.id);
        if (kind === 'closed-continuation') expect(fixture.query.cursor).toBe('opaque-preclosure-continuation');
      }
    }
  });
}
