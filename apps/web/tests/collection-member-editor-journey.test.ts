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
  method: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
  idempotencyKey: string | null;
};
type JourneyWindow = Window & {
  calls: Call[];
  failNextNote: boolean;
  changeElsewhere(): void;
  collectionRevision(): number;
  retire(): void;
};

// Deferred browser outcome: only requests and native responses are controlled. This mounts the delivered page,
// Query composition, subject picker/search and default server/API adapters. No server or database is started.
test('Curator can add and edit Collection members without an always-open form wall', async () => {
  const directory = join(root, '.temp/collection-member-editor-journey');
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
    import membersRecording from ${JSON.stringify(join(app, 'src/kernel/recorded/library-collection-members.json'))};
    import definitions from ${JSON.stringify(join(app, 'src/kernel/recorded/definitions-release.json'))};
    const parent = { ...recording.collection, visibility: 'private', memberCount: 0, membershipKind: 'curated' };
    const members = [];
    const subject = membersRecording.members[0].subject;
    window.calls = [];
    window.failNextNote = false;
    const noteReceipts = new Map();
    window.changeElsewhere = () => parent.revision++;
    window.collectionRevision = () => parent.revision;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
      const path = url.pathname;
      const body = request.body ? await request.clone().json() : null;
      window.calls.push({ path, method: request.method, body, authorization: request.headers.get('authorization'),
        idempotencyKey: request.headers.get('idempotency-key') });
      if (path === '/api/search/suggestions') return Response.json({ subjects: [{ id: subject.id,
        type: subject.type, labels: { en: subject.label.value }, summary: null }], types: {} });
      if (path === '/v1/definitions/active') return Response.json({ digest: 'journey-release' });
      if (path.startsWith('/v1/definitions/releases/')) return Response.json({ ...definitions, digest: 'journey-release' });
      if (path === '/v1/platform/exposure') return Response.json({ admitted: ['collections'] });
      if (path === '/openapi.json') return Response.json({ paths: {} });
      if (path === '/v1/collections') return Response.json({ collections: [], next: null });
      if (path === '/v1/viewerActions') return Response.json({ resources: [{ type: 'library.collection', id: parent.id,
        viewerActions: [{ action: 'collection:update', operations: ['collection.update', 'collection_member.create'] }] }] });
      if (path === '/v1/collections/' + parent.id) {
        if (request.method === 'PATCH') {
          if (body.revision !== parent.revision) return Response.json({ code: 'conflict' }, { status: 409 });
          Object.assign(parent, body, { revision: parent.revision + 1 });
        }
        return Response.json({ collection: parent });
      }
      if (path === '/v1/collections/' + parent.id + '/members') {
        if (request.method === 'POST') {
          const member = { ...membersRecording.members[0], id: crypto.randomUUID(), subjectId: body.subjectId, note: body.note ?? null };
          members.push(member); parent.memberCount++; parent.revision++;
          return Response.json({ member }, { status: 201 });
        }
        return Response.json({ members, next: null });
      }
      if (request.method === 'PATCH' && path.startsWith('/v1/collections/' + parent.id + '/members/')) {
        const key = request.headers.get('idempotency-key');
        if (key && noteReceipts.has(key)) return Response.json(noteReceipts.get(key));
        const member = members.find(item => path.endsWith('/' + item.id));
        member.note = body.note; parent.revision++;
        const receipt = { member };
        if (key) noteReceipts.set(key, receipt);
        if (window.failNextNote) {
          window.failNextNote = false;
          return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
        }
        return Response.json(receipt);
      }
      return Response.json({ code: 'not_found' }, { status: 404 });
    };
    setLocale('en', { reload: false });
    const query = personalCollectionPageQuery(parent.id);
    async function read(editor = false) {
      const page = await readCollectionPage({ data: { id: parent.id, credentialMode: 'session', ...(editor ? { editor: true } : {}) } });
      if ('preparing' in page) throw new Error('Expected curated Collection');
      return page;
    }
    function Screen() {
      const [current, setCurrent] = React.useState(true);
      window.retire = () => setCurrent(false);
      const { data } = useSuspenseQuery(query);
      return <CollectionPage page={data} queryKey={query.queryKey} cursor={undefined}
        refreshPage={() => read()} readEditorPage={() => read(true)} isCurrent={() => current} />;
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
  try {
    await page.route('https://site.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<link rel="canonical" href="https://site.test/en/collections/' + id + '"><main id="app"></main>',
      }),
    );
    await page.goto(`https://site.test/en/collections/${id}`);
    await page.addScriptTag({ type: 'module', content: await built.outputs[0]!.text() });
    await page.getByRole('button', { name: m.library_collection_add_items(), exact: true }).click();
    const search = page.getByRole('combobox', { name: m.library_collection_find_subject() });
    await search.fill('Snow');
    await page.getByRole('option', { name: /Snow Country/ }).click();
    const addForm = page.getByRole('form', { name: m.library_collection_add_items() });
    await addForm.locator('summary').click();
    await addForm.getByRole('textbox', { name: m.library_member_note() }).fill('Initial note');
    await addForm.getByRole('button', { name: m.library_collection_add_selected() }).click();
    await addForm.waitFor({ state: 'detached' });
    await page.getByText('Initial note', { exact: true }).waitFor();
    const calls = () => page.evaluate(() => (window as unknown as JourneyWindow).calls);
    const added = (await calls()).filter((call) => call.method === 'POST' && call.path.endsWith('/members'));
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toMatchObject({ note: 'Initial note' });
    expect(added[0]!.authorization).toBe('Bearer owner');
    expect((await calls()).find((call) => call.path === '/api/search/suggestions')).toBeDefined();

    async function editNote(value: string) {
      await page.getByRole('button', { name: m.library_collection_actions(), exact: true }).click();
      await page.getByText(m.library_collection_edit(), { exact: true }).click();
      await page.locator('[data-collection-note-editor]').waitFor();
      expect(await page.locator('[data-collection-details]').getAttribute('open')).toBeNull();
      expect(await page.locator('[data-collection-selection]').count()).toBe(0);
      expect(await page.locator('[data-collection-note-editor]').getAttribute('open')).toBeNull();
      await page.locator('[data-collection-note-editor] summary').click();
      await page.getByRole('textbox', { name: `${m.library_member_note()}: Snow Country`, exact: true }).fill(value);
    }
    await editNote('Keep my unsaved note');
    await page.evaluate(() => (window as unknown as JourneyWindow).changeElsewhere());
    await page.getByRole('button', { name: m.library_collection_save(), exact: true }).click();
    await page.getByRole('alert').filter({ hasText: m.library_collection_conflict() }).waitFor();
    expect(
      await page.getByRole('textbox', { name: `${m.library_member_note()}: Snow Country`, exact: true }).inputValue(),
    ).toBe('Keep my unsaved note');
    expect((await calls()).filter((call) => call.method === 'PATCH' && call.path.includes('/members/'))).toHaveLength(
      0,
    );
    await page.locator('[data-conflict-basis]').waitFor();
    await page.locator('[data-collection-basis="3"]').waitFor();
    await page.getByRole('button', { name: m.collection_save_review_current(), exact: true }).click();
    expect(
      await page.getByRole('textbox', { name: `${m.library_member_note()}: Snow Country`, exact: true }).inputValue(),
    ).toBe('Keep my unsaved note');
    expect(await page.locator('[data-conflict-basis]').count()).toBe(0);
    await editNote('Saved note');
    await page.getByRole('button', { name: m.library_collection_save(), exact: true }).click();
    await page.locator('[data-collection-save]').waitFor({ state: 'detached' });
    await page.getByText('Saved note', { exact: true }).waitFor();
    await editNote('Retry note');
    await page.evaluate(() => ((window as unknown as JourneyWindow).failNextNote = true));
    await page.getByRole('button', { name: m.library_collection_save(), exact: true }).click();
    await page.locator('[data-save-outcome="confirmed"][data-save-step="metadata"]').waitFor();
    await page.locator('[data-save-outcome="unknown"]').waitFor();
    const revisionAtUnknown = await page.evaluate(() => (window as unknown as JourneyWindow).collectionRevision());
    const writesAtUnknown = (await calls()).filter((call) => call.method === 'PATCH');
    expect(writesAtUnknown.map((call) => call.path)).toEqual([
      `/v1/collections/${id}`,
      `/v1/collections/${id}`,
      expect.stringContaining('/members/'),
      `/v1/collections/${id}`,
      expect.stringContaining('/members/'),
    ]);
    await page.getByRole('button', { name: m.collection_save_retry_original(), exact: true }).click();
    await page.locator('[data-collection-save]').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => (window as unknown as JourneyWindow).collectionRevision())).toBe(revisionAtUnknown);
    await page.locator('[data-collection-edit-review]').waitFor();
    expect(await page.locator('[data-collection-save-outcomes] [data-save-outcome="confirmed"]').count()).toBe(2);
    await page.evaluate(() => (window as unknown as JourneyWindow).retire());
    await page.locator('[data-collection-edit-review]').waitFor({ state: 'detached' });
    const writes = (await calls()).filter((call) => call.method === 'PATCH');
    expect(writes.map((call) => call.path)).toEqual([
      `/v1/collections/${id}`,
      `/v1/collections/${id}`,
      expect.stringContaining('/members/'),
    ]);
    expect(writes[0]!.body!.revision).toBe(2);
    expect(writes[1]!.body!.revision).toBe(3);
    expect(writes[2]!.body).toEqual({ note: 'Saved note' });
    expect(writes[4]!.body).toEqual({ note: 'Retry note' });
    expect(writes[5]!.body).toEqual({ note: 'Retry note' });
    expect(writes[4]!.idempotencyKey).toBe(writes[5]!.idempotencyKey);
  } finally {
    await page.close();
    await browser.close();
  }
}, 30_000);
