import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { m } from '../src/paraglide/messages.js';
import collection from '../src/kernel/recorded/library-collection.json';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const id = collection.collection.id;
type Call = {
  path: string;
  query: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
  key: string | null;
};
type JourneyWindow = Window & {
  calls: Call[];
  nativeOrder(): { id: string; note: string | null }[];
  appliedMoves: number;
};

// Authored for deferred acceptance. Do not run as part of source-only delivery.
// Only HTTP responses are controlled; this mounts CollectionPage and its ordinary BFF/client composition.
test('A curator moves a chosen occurrence from a later Collection page to its real start or end without loading intervening pages and can resolve an uncertain result using the same intent', async () => {
  const directory = join(root, '.temp/collection-boundary-move');
  await mkdir(directory, { recursive: true });
  const entry = join(directory, 'entry.tsx');
  const boundary = join(directory, 'request-boundary.ts');
  const runtime = join(app, '.storybook/react-start.ts');
  await writeFile(
    boundary,
    `
    export { createIsomorphicFn, createServerOnlyFn } from ${JSON.stringify(runtime)};
    let current;
    export function makeRequest(method = 'GET', supplied = {}) {
      const headers = new Headers(supplied);
      headers.set('origin', 'https://site.test');
      const get = headers.get.bind(headers);
      Object.defineProperty(headers, 'get', { value: name => name.toLowerCase() === 'cookie'
        ? '__Host-rezics_session=${'a'.repeat(43)}' : get(name) });
      const request = new Request('https://site.test/en/collections/${id}', { method });
      Object.defineProperty(request, 'headers', { value: headers });
      return request;
    }
    export function createServerFn({ method = 'GET' } = {}) {
      let validate = value => value;
      const chain = {
        validator(next) { validate = next; return chain; },
        handler(run) { return (input = {}) => {
          current = makeRequest(method, input.headers);
          return Promise.resolve(run({ ...input, data: validate(input.data) }));
        } }
      };
      return chain;
    }
    export const getRequest = () => current ?? makeRequest();
    export const setResponseHeader = () => {};
    export const setResponseStatus = () => {};
    export const env = {
      KERNEL_ORIGIN: 'https://kernel.test', PUBLIC_ORIGIN: 'https://site.test', COLLECTION_FILTERS: 'false',
      AUTH_ISSUER: 'https://auth.test', API_RESOURCE: 'https://kernel.test', WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'collection-journey', WEBSITE_CLIENT_KEY: '{}',
      SESSIONS: { idFromName: id => id, get: () => ({
        signedIn: async () => ({ signedIn: true, subject: ${JSON.stringify(collection.collection.curatorAccountId)}, csrfToken: 'test' }),
        credentialIfFresh: async () => ({ status: 'active', subject: ${JSON.stringify(collection.collection.curatorAccountId)}, accessToken: 'owner', csrfToken: 'test' }),
        credential: async () => ({ status: 'active', subject: ${JSON.stringify(collection.collection.curatorAccountId)}, accessToken: 'owner', csrfToken: 'test' })
      }) }
    };
  `,
  );
  await writeFile(
    entry,
    `
    import React, { Suspense } from ${JSON.stringify(Bun.resolveSync('react', app))};
    import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', app))};
    import { QueryClient, QueryClientProvider, useSuspenseQuery } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-query', app))};
    import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-router', app))};
    import { CollectionPage } from ${JSON.stringify(join(app, 'src/library/collection-page.tsx'))};
    import { personalCollectionPageQuery, readCollectionPage } from ${JSON.stringify(join(app, 'src/library/collection-queries.ts'))};
    import { sessionQuery } from ${JSON.stringify(join(app, 'src/session/query.ts'))};
    import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
    import recording from ${JSON.stringify(join(app, 'src/kernel/recorded/library-collection.json'))};
    import memberRecording from ${JSON.stringify(join(app, 'src/kernel/recorded/library-collection-members.json'))};
    import definitions from ${JSON.stringify(join(app, 'src/kernel/recorded/definitions-release.json'))};
    const parent = { ...recording.collection, visibility: 'private', membershipKind: 'curated', memberCount: 6 };
    const original = { ...memberRecording.members[0], note: 'Original occurrence note' };
    const duplicate = { ...original, id: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e1', note: 'Duplicate occurrence note' };
    let members = [
      { ...memberRecording.members[3], id: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e2' },
      original, duplicate, ...memberRecording.members.slice(1)
    ];
    const receipts = new Map();
    let unknownSent = false, readFails = false, staleNext = false;
    window.calls = [];
    window.appliedMoves = 0;
    window.nativeOrder = () => members.map(({ id, note }) => ({ id, note }));
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
      const path = url.pathname;
      const body = request.body ? await request.clone().json() : null;
      const key = request.headers.get('idempotency-key');
      window.calls.push({ path, query: url.search, method: request.method, body, key, authorization: request.headers.get('authorization') });
      if (path === '/v1/definitions/active') return Response.json({ digest: 'journey-release' });
      if (path.startsWith('/v1/definitions/releases/')) return Response.json({ ...definitions, digest: 'journey-release' });
      if (path === '/v1/platform/exposure') return Response.json({ admitted: ['collections'] });
      if (path === '/openapi.json') return Response.json({ paths: {} });
      if ((path.startsWith('/v1/collections') || path === '/v1/viewerActions') && request.headers.get('authorization') !== 'Bearer owner')
        return Response.json({ code: 'not_found' }, { status: 404 });
      if (path === '/v1/collections') return Response.json({ collections: [], next: null });
      if (path === '/v1/viewerActions') return Response.json({ resources: [{ type: 'library.collection', id: parent.id,
        viewerActions: [{ action: 'collection:update', operations: ['collection.update', 'collection_member.move'] }] }] });
      if (path === '/v1/collections/' + parent.id) {
        if (request.method === 'PATCH') {
          if (body.revision !== parent.revision) return Response.json({ code: 'conflict' }, { status: 409 });
          Object.assign(parent, body, { revision: parent.revision + 1 });
        }
        return Response.json({ collection: parent });
      }
      if (path === '/v1/collections/' + parent.id + '/members') {
        if (readFails) { readFails = false; return Response.json({ code: 'unavailable' }, { status: 503 }); }
        if (staleNext && url.searchParams.has('cursor')) {
          staleNext = false;
          return Response.json({ code: 'stale_cursor' }, { status: 409 });
        }
        const later = url.searchParams.get('cursor') === 'later-page';
        return Response.json({ members: later ? members.slice(1, 4) : members.slice(0, 3), next: 'unloaded-next-page' });
      }
      if (path.startsWith('/v1/collections/' + parent.id + '/members/')) {
        const memberId = path.split('/').at(-1).replace(/:move$/, '');
        const member = members.find(item => item.id === memberId);
        if (!member) return Response.json({ code: 'not_found' }, { status: 404 });
        if (request.method === 'PATCH') {
          member.note = body.note; parent.revision++;
          return Response.json({ member });
        }
        if (request.method === 'POST' && path.endsWith(':move')) {
          if (!key || Object.keys(body).some(field => field !== 'after')) return Response.json({ code: 'invalid_request' }, { status: 400 });
          const fingerprint = JSON.stringify([memberId, body]);
          if (receipts.has(key)) {
            const receipt = receipts.get(key);
            if (receipt.fingerprint !== fingerprint) return Response.json({ code: 'conflict' }, { status: 409 });
            return Response.json(receipt.response);
          }
          members = members.filter(item => item.id !== memberId);
          if (!Object.hasOwn(body, 'after')) members.push(member);
          else if (body.after === null) members.unshift(member);
          else throw new Error('This boundary journey must not issue relative or numeric moves');
          parent.revision++;
          window.appliedMoves++;
          const response = { member };
          receipts.set(key, { fingerprint, response });
          if (!unknownSent) {
            unknownSent = true; readFails = true;
            throw new TypeError('Response lost after native receipt');
          }
          staleNext = true;
          return Response.json(response);
        }
      }
      return Response.json({ code: 'not_found' }, { status: 404 });
    };
    setLocale('en', { reload: false });
    const query = personalCollectionPageQuery(parent.id, 'later-page');
    async function read(editor = false) {
      const page = await readCollectionPage({ data: { id: parent.id, cursor: 'later-page', credentialMode: 'session', ...(editor ? { editor: true } : {}) } });
      if ('preparing' in page) throw new Error('Expected curated Collection');
      return page;
    }
    function Screen() {
      const { data } = useSuspenseQuery(query);
      return <CollectionPage page={data} queryKey={query.queryKey} cursor="later-page"
        refreshPage={() => read()} readEditorPage={() => read(true)} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery(sessionQuery);
    const route = createRootRoute({ component: Screen });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
    await router.load();
    createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}>
      <Suspense fallback={null}><RouterProvider router={router} /></Suspense>
    </QueryClientProvider>);
  `,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'collection-request-environment',
        setup(build) {
          build.onResolve({ filter: /^@tanstack\/react-start(?:\/server)?$|^cloudflare:workers$/ }, () => ({
            path: boundary,
          }));
        },
      },
    ],
  });
  expect(built.success, built.logs.map(String).join('\n')).toBe(true);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const originalId = '01a17a3b-6e78-73b5-9efd-f4cc070cc9e1';
  const otherId = (await import('../src/kernel/recorded/library-collection-members.json')).default.members[0]!.id;
  const chosen = page.locator(`[data-member="${originalId}"]`);
  const calls = () => page.evaluate(() => (window as unknown as JourneyWindow).calls);
  const moves = async () => (await calls()).filter((call) => call.method === 'POST' && call.path.endsWith(':move'));
  const memberReads = async () =>
    (await calls()).filter((call) => call.method === 'GET' && call.path.endsWith('/members'));
  async function edit() {
    await page.getByRole('button', { name: m.library_collection_actions(), exact: true }).click();
    await page.getByText(m.library_collection_edit(), { exact: true }).click();
    await page.locator('[data-collection-save]').waitFor();
  }
  async function rowMenu(memberId: string) {
    await page
      .locator(`[data-member="${memberId}"]`)
      .getByRole('button', { name: new RegExp('^' + m.library_collection_actions() + ':') })
      .click();
    return page.getByRole('menu');
  }
  try {
    await page.route('https://site.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<link rel="canonical" href="https://site.test/en/collections/${id}"><main id="app"></main>`,
      }),
    );
    await page.goto(`https://site.test/en/collections/${id}?cursor=later-page`);
    await page.addScriptTag({ type: 'module', content: await built.outputs[0]!.text() });
    await edit();
    await chosen.locator('[data-collection-note-editor] summary').click();
    await chosen.getByRole('textbox').fill('Unsent note must survive');
    await page.locator('[data-collection-details] summary').click();
    await page.getByRole('textbox', { name: m.library_collection_title(), exact: true }).fill('Unsent title');
    let menu = await rowMenu(originalId);
    for (const label of [m.library_collection_boundary_start(), m.library_collection_boundary_end()]) {
      expect(await menu.getByRole('menuitem', { name: label, exact: true }).getAttribute('aria-disabled')).toBe('true');
    }
    expect(await moves()).toHaveLength(0);
    await page.keyboard.press('Escape');
    expect(await chosen.getByRole('textbox').inputValue()).toBe('Unsent note must survive');
    expect(await page.getByRole('textbox', { name: m.library_collection_title(), exact: true }).inputValue()).toBe(
      'Unsent title',
    );
    await page.getByText(m.library_collection_move_save_first(), { exact: true }).waitFor();
    await page.getByRole('button', { name: m.library_collection_cancel(), exact: true }).click();
    expect((await calls()).filter((call) => call.method === 'PATCH')).toHaveLength(0);
    await edit();
    await chosen.locator('[data-collection-note-editor] summary').click();
    expect(await chosen.getByRole('textbox').inputValue()).toBe('Duplicate occurrence note');
    await chosen.getByRole('textbox').fill('Saved occurrence note');
    await page.getByRole('button', { name: m.library_collection_save(), exact: true }).click();
    await page.locator('[data-collection-save]').waitFor({ state: 'detached' });
    await edit();
    const readsBeforeMove = (await memberReads()).length;
    menu = await rowMenu(originalId);
    await menu.getByRole('menuitem', { name: m.library_collection_boundary_end(), exact: true }).click();
    await page.getByRole('button', { name: m.library_collection_boundary_retry(), exact: true }).waitFor();
    expect(await moves()).toHaveLength(1);
    const firstMove = (await moves())[0]!;
    expect(firstMove.path).toBe(`/v1/collections/${id}/members/${originalId}:move`);
    expect(firstMove.body).toEqual({});
    expect(firstMove.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstMove.authorization).toBe('Bearer owner');
    expect((await memberReads()).length).toBe(readsBeforeMove);
    expect(await page.getByRole('button', { name: m.library_collection_cancel(), exact: true }).isDisabled()).toBe(
      true,
    );
    expect(await chosen.getByRole('checkbox').isDisabled()).toBe(true);
    await chosen.locator('[data-collection-note-editor] summary').click();
    expect(await chosen.getByRole('textbox').isDisabled()).toBe(true);
    expect(await chosen.getByRole('textbox').inputValue()).toBe('Saved occurrence note');
    await page.getByRole('button', { name: m.library_collection_boundary_retry(), exact: true }).click();
    await page.getByText(m.library_collection_boundary_refresh_failed(), { exact: true }).waitFor();
    const retry = (await moves())[1]!;
    expect(retry).toEqual(firstMove);
    expect(await page.getByRole('button', { name: m.library_collection_boundary_retry(), exact: true }).count()).toBe(
      0,
    );
    expect(await page.getByRole('button', { name: m.library_collection_cancel(), exact: true }).isDisabled()).toBe(
      true,
    );
    expect((await memberReads()).length).toBe(readsBeforeMove + 1);
    await page.getByRole('button', { name: m.library_collection_boundary_refresh(), exact: true }).click();
    await page.locator('[data-collection-save]').waitFor({ state: 'detached' });
    expect((await memberReads()).length).toBe(readsBeforeMove + 2);
    expect(await moves()).toHaveLength(2);
    const order = await page.evaluate(() => (window as unknown as JourneyWindow).nativeOrder());
    expect(order.at(-1)).toEqual({ id: originalId, note: 'Saved occurrence note' });
    expect(order.find((member) => member.id === otherId)?.note).toBe('Original occurrence note');
    expect(await page.evaluate(() => (window as unknown as JourneyWindow).appliedMoves)).toBe(1);
    await edit();
    const readsBeforeStart = (await memberReads()).length;
    menu = await rowMenu(otherId);
    await menu.getByRole('menuitem', { name: m.library_collection_boundary_start(), exact: true }).click();
    await page.locator('[data-collection-save]').waitFor({ state: 'detached' });
    const start = (await moves())[2]!;
    expect(start.path).toBe(`/v1/collections/${id}/members/${otherId}:move`);
    expect(start.body).toEqual({ after: null });
    expect(start.key).not.toBe(firstMove.key);
    expect((await memberReads()).length).toBe(readsBeforeStart + 2); // Existing one-time stale-cursor restart.
    const final = await page.evaluate(() => (window as unknown as JourneyWindow).nativeOrder());
    expect(final[0]).toEqual({ id: otherId, note: 'Original occurrence note' });
    expect(final.at(-1)).toEqual({ id: originalId, note: 'Saved occurrence note' });
    expect(await page.evaluate(() => (window as unknown as JourneyWindow).appliedMoves)).toBe(2);
    for (const read of await memberReads()) {
      const params = new URLSearchParams(read.query);
      expect([null, 'later-page']).toContain(params.get('cursor'));
      expect(Number(params.get('limit'))).toBeLessThanOrEqual(100);
    }
    expect((await calls()).filter((call) => call.method === 'PATCH' && call.path.includes('/members/'))).toHaveLength(
      1,
    );
  } finally {
    await page.close();
    await browser.close();
  }
}, 30_000);
