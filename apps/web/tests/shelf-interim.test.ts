import { describe, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readFile } from 'node:fs/promises';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadPersonalLibrary } from '../src/library/entries-read';
import { loadMineCollectionsPage } from '../src/library/mine-collections';

const root = new URL('../src/', import.meta.url);
const source = async (path: string) => readFile(new URL(path, root), 'utf8');

describe('interim library shelf contract', () => {
  test('loads one bounded owner page for the selected state or all tracked entries', async () => {
    const read = await source('library/entries-read.ts');
    const route = await source('routes/library/index.tsx');
    expect(read).toContain('readEntryPage(client, authorization, input.cursor, state)');
    expect(read).not.toContain('shelfSectionOrder.map');
    expect(read).not.toContain('SHELF_SECTION_LIMIT');
    expect(route).toContain('readPersonalLibrary');
    expect(read).toContain('next: page.next');
  });

  test('renders one tracked entries list with state chips, collection shortcuts and toggle groups', async () => {
    const view = await source('library/shelf-view.tsx');
    const page = await source('library/entries-page.tsx');
    const entries = await source('library/entries-read.ts');
    expect(page).toContain('m.library_tracked_entries()');
    expect(view).toContain('libraryEntryStateLabel');
    expect(view).toContain('return writable ? shelfHref(locale, { state: writable }) : undefined');
    expect(page).toContain('ToggleGroup');
    expect(view).not.toContain('DropdownMenu');
    expect(view).not.toContain('Overview');
    expect(view).not.toContain('StatusTab');
    expect(entries).not.toContain('sections: ShelfSection[]');
    expect(view).toContain('status: { label: status');
    expect(view).toContain('<a href={href}');
    expect(view).toContain('<a href={href} className="underline">');
  });

  test('keeps grid tiles quiet and uses the subject cover on Continue and the list', async () => {
    const view = await source('library/shelf-view.tsx');
    const cont = await source('library/continue-read.ts');
    const grid = /function GridView[\s\S]*?function ListView/.exec(view)?.[0] ?? '';
    expect(grid).not.toContain('m.library_updated()');
    expect(cont).toContain('cover: subject.cover');
    expect(view).toContain('cover: entry.subject?.cover ?? null');
  });

  test('reads at most eight owner Collections after hydration and links to all Collections', async () => {
    const shortcuts = await source('library/collection-shortcuts.tsx');
    const mine = await source('library/mine-collections.ts');
    const reads = await source('library/reads.ts');
    expect(shortcuts).toContain('loadMineCollectionsPage');
    expect(shortcuts).toContain('personalRead');
    expect(shortcuts).toContain('.slice(0, 8)');
    expect(shortcuts).toContain('library/collections');
    expect(shortcuts).toContain('enabled: hydrated && personalRead.enabled');
    expect(mine).toContain('readPage(client, accountId, authorization, input.cursor)');
    expect(reads).toContain('export const LIBRARY_PAGE_LIMIT = 100');
  });

  test('entry and Collection reads stay constant as their populations grow', async () => {
    const read = await source('library/entries-read.ts');
    const shortcuts = await source('library/collection-shortcuts.tsx');
    const mine = await source('library/mine-collections.ts');
    expect(read.match(/readEntryPage\(client, authorization, input\.cursor, state\)/g)).toHaveLength(1);
    expect(shortcuts.match(/queryFn: \(\) => readShortcuts\(\)/g)).toHaveLength(1);
    expect(mine.match(/page = await readPage\(client, accountId, authorization, input\.cursor\)/g)).toHaveLength(1);
    expect(shortcuts).not.toMatch(/for\s*\(|\.map\(.*loadMineCollectionsPage/s);
  });

  test('page and shortcut kernel request counts do not grow with entries or Collections', async () => {
    const requests: string[] = [];
    let entryCount = 0;
    let collectionCount = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === '/v1/libraryEntries') {
          expect(url.searchParams.get('limit')).toBe('100');
          return Response.json({
            libraryEntries: Array.from({ length: Math.min(entryCount, 100) }, (_, index) => ({
              subjectId: `subject-${index}`,
              state: 'planned',
              revision: 1,
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
              subject: null,
            })),
            next: null,
          });
        }
        if (url.pathname === '/v1/collections') {
          expect(url.searchParams.get('curatorAccountId')).toBe('reader');
          expect(url.searchParams.get('cursor')).toBeNull();
          return Response.json({
            collections: Array.from({ length: collectionCount }, (_, index) => ({
              id: `collection-${index}`,
              curatorAccountId: 'reader',
              title: `Collection ${index}`,
              description: null,
              visibility: 'private',
              memberCount: 0,
              updatedAt: '2026-10-01T00:00:00.000Z',
            })),
            next: null,
          });
        }
        if (url.pathname === '/v1/libraryContinue') return Response.json({ subjects: [], next: null });
        throw new Error(`unexpected kernel request ${request.method} ${url.pathname}`);
      }) as typeof fetch,
    });
    const sessionId = 'a'.repeat(43);
    const sessions = {
      idFromName: (id: string) => id,
      get: () => ({
        async credential() {
          return { status: 'active' as const, subject: 'reader', accessToken: 'fresh-token' };
        },
      }),
    } as unknown as DurableObjectNamespace<SessionStore>;
    const env = {
      AUTH_ISSUER: 'https://auth.example.test',
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'rezics-web-shelf-cost',
      WEBSITE_CLIENT_KEY: 'unused-by-this-read',
      SITE_ORIGINS: 'https://site.example.test',
      SESSIONS: sessions,
    } as Partial<SessionEnv>;
    const request = () =>
      new Request('https://site.example.test/en/library', {
        headers: { cookie: `__Host-rezics_session=${sessionId}` },
      });

    for (const entrySize of [5, 500]) {
      for (const collections of [0, 3, 30]) {
        entryCount = entrySize;
        collectionCount = collections;
        requests.length = 0;
        const entries = await loadPersonalLibrary(client, request(), env, {});
        const shortcuts = await loadMineCollectionsPage(client, request(), env, {});
        const continuing = client as unknown as {
          libraryContinue: {
            get(input: { query: { limit: number }; headers: { authorization: string } }): Promise<unknown>;
          };
        };
        await continuing.libraryContinue.get({
          query: { limit: 6 },
          headers: { authorization: 'Bearer fresh-token' },
        });
        expect(entries.signedIn).toBe(true);
        expect(shortcuts.collections).toHaveLength(collections);
        expect(requests).toEqual(['GET /v1/libraryEntries', 'GET /v1/collections', 'GET /v1/libraryContinue']);
      }
    }
  });

  test('the one list has a next page, exact state filter heading, and a clear control', async () => {
    const page = await source('library/entries-page.tsx');
    const read = await source('library/entries-read.ts');
    const route = await source('routes/library/index.tsx');
    expect(read).toContain('...(state ? { state } : {})');
    expect(read).toContain('state?: LibraryEntryStateWrite');
    expect(route).toContain('state, cursor');
    expect(page).toContain('page.next');
    expect(page).toContain('shelfHref(locale, { layout: display.layout, size: display.size })');
    expect(page).toContain('m.library_tracked_entries_state');
    expect(page).toContain('m.library_clear_state()');
    expect(page).toContain("kind={page.state ? 'no-match' : 'library'}");
    expect(page).toContain('m.library_filter_empty_title');
    expect(page).toContain('m.library_filter_empty_description');
  });

  test('all shelf menus use the shared responsive menu and grid tiles omit updated time', async () => {
    const view = await source('library/shelf-view.tsx');
    const menu = await readFile(new URL('../../../packages/ui/src/components/menu.tsx', import.meta.url), 'utf8');
    const stories = await readFile(new URL('../src/stories/library-entries.stories.tsx', import.meta.url), 'utf8');
    const grid = /function GridView[\s\S]*?function ListView/.exec(view)?.[0] ?? '';
    expect(view).toContain("from '@rezics/ui/item-menu'");
    expect(view).not.toContain('shadcn/dropdown-menu');
    expect(menu).toContain("window.matchMedia('(max-width: 767px)')");
    expect(menu).toContain("window.matchMedia('(pointer: coarse)')");
    expect(stories).toMatch(/phone|390/);
    expect(stories).toMatch(/menu.*open|open.*menu/i);
    expect(grid).not.toContain('Updated');
    expect(grid).not.toContain('updatedAt');
  });

  test('layout and size controls announce toggle semantics and pressed values', async () => {
    const page = await source('library/entries-page.tsx');
    expect(page).toContain('<ToggleGroup');
    expect(page).toContain('aria-label={m.library_layout()}');
    expect(page).toContain('aria-label={m.library_size()}');
    expect(page).toContain('value={[display.layout]}');
    expect(page).toContain('value={[display.size]}');
  });

  test('provides native localized messages in all launch locales and documents the interim shape', async () => {
    for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      const messages = await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8');
      expect(messages).toContain('library_tracked_entries');
      expect(messages).toContain('library_clear_state');
    }
    const ui = await readFile(new URL('../../../packages/ui/README.md', import.meta.url), 'utf8');
    expect(ui).toContain('one paged list of tracked entries');
    expect(ui).toContain('Collection shortcuts');
  });
});
