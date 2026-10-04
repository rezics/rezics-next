import { afterEach, expect, spyOn, test } from 'bun:test';
import { browserMainApi } from '../features/api/browser.ts';
import { readReadingPositionPage } from '../features/wiki/position-picker.ts';

afterEach(() => {
  spies.forEach((restore) => restore());
  spies.length = 0;
});
const spies: (() => void)[] = [];

for (const anonymous of [false, true]) {
  test(`G1061: JSON chooser carries ${anonymous ? 'public' : 'selected Agent'} authority without a page action`, async () => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const mock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), init });
          // Main rejects authenticated reads with no Agent; the no-Agent branch
          // must retain the server reader's anonymous authority instead.
          if (init?.credentials !== 'omit' && !calls.at(-1)!.url.searchParams.get('actingSubject'))
            return Promise.resolve(
              Response.json({ error: 'actingSubject required' }, { status: 400 }),
            );
          return Promise.resolve(Response.json({ items: [], nextCursor: null, complete: true }));
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    spies.push(() => mock.mockRestore());
    const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
    const page = await readReadingPositionPage(
      browserMainApi('https://web.example', { anonymous }),
      {
        work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
        position: 'all',
        actingSubject: anonymous ? undefined : actor,
        q: '遠方',
        language: 'zh-Hant',
      },
    );
    expect(page.complete).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe(
      '/api/main/v1/reading-positions/00000000-0000-4000-8000-000000000001',
    );
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.credentials).toBe(anonymous ? 'omit' : 'same-origin');
    expect(calls[0]!.url.searchParams.get('actingSubject')).toBe(anonymous ? null : actor);
    expect(calls[0]!.url.searchParams.get('q')).toBe('遠方');
    expect(calls[0]!.url.searchParams.get('position')).toBe('all');
    expect(calls[0]!.url.searchParams.get('language')).toBe('zh-Hant');
  });
}
