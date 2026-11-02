import { expect, test } from 'bun:test';
import { removePersonalLibraryEntry, restorePersonalLibraryEntry } from '../src/library/entries-read';

const subjectId = 'book-one';
const deletionId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const request = new Request('https://rezics.test/action', { headers: { authorization: 'Bearer reader' } });
const entry = {
  subjectId,
  state: 'planned',
  revision: 7,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  subject: { id: subjectId, label: 'A book', type: 'book' },
};

function clientFor(deleteHeaders = true, restoreResult?: unknown) {
  const calls: { method: string; path: string; body?: unknown; headers?: unknown; query?: unknown }[] = [];
  const client = {
    libraryEntries: ({ subjectId: id }: { subjectId: string }) => ({
      delete: async (_body: unknown, options: { query: unknown; headers: unknown }) => {
        calls.push({ method: 'DELETE', path: `/v1/libraryEntries/${id}`, ...options });
        return {
          status: 204,
          data: undefined,
          error: null,
          response: new Response(null, {
            status: 204,
            headers: deleteHeaders
              ? { 'Library-Entry-Deletion-Id': deletionId, 'Library-Entry-Deletion-Revision': '12' }
              : {},
          }),
        };
      },
      $restore: {
        post: async (body: unknown, options: { headers: unknown }) => {
          calls.push({ method: 'POST', path: `/v1/libraryEntries/${id}:restore`, body, ...options });
          return restoreResult ?? { status: 200, data: { libraryEntry: entry }, error: null };
        },
      },
    }),
  };
  return { client: client as never, calls };
}

test('removing from shelf or subject page offers Undo using the DELETE response headers', async () => {
  const { client, calls } = clientFor();
  const removed = await removePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId,
      revision: 7,
      idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    },
  );
  expect(removed).toMatchObject({ ok: true, undo: { deletionId, revision: 12 } });
  expect(calls[0]).toMatchObject({ method: 'DELETE', path: `/v1/libraryEntries/${subjectId}` });
});

test('a successful restore returns its body without a read', async () => {
  const { client, calls } = clientFor();
  const restored = await restorePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId,
      deletionId,
      revision: 12,
    },
  );
  expect(restored).toMatchObject({ ok: true, entry: { subjectId, revision: 7 } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: 'POST',
    path: `/v1/libraryEntries/${subjectId}:restore`,
    body: { deletionId, revision: 12 },
  });
});

test.each([
  ['library_entry_restore_occupied', 'occupied'],
  ['library_entry_restore_stale', 'stale'],
  ['library_entry_restore_expired', 'expired'],
])('%s is returned as its own restore refusal', async (code, reason) => {
  const { client } = clientFor(true, { status: 409, error: { value: { code } } });
  const result = await restorePersonalLibraryEntry(client, request, {}, { subjectId, deletionId, revision: 12 });
  expect(result).toMatchObject({ ok: false, reason });
});

test('a DELETE without deletion headers succeeds without offering Undo', async () => {
  const { client } = clientFor(false);
  const result = await removePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId,
      revision: 7,
      idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    },
  );
  expect(result).toMatchObject({ ok: true });
  expect(result).not.toHaveProperty('undo');
});

test('no-JavaScript undo form can submit the deletion id and revision', async () => {
  const form = new FormData();
  form.set('deletionId', deletionId);
  form.set('revision', '12');
  expect(form.get('deletionId')).toBe(deletionId);
  expect(form.get('revision')).toBe('12');
});

test('an occupied restore reloads and returns the entry currently in the library', async () => {
  const calls: { method: string; path: string; body?: unknown; headers?: unknown }[] = [];
  const currentEntry = { ...entry, revision: 15, state: 'completed' };
  const client = {
    libraryEntries: ({ subjectId: id }: { subjectId: string }) => ({
      $restore: {
        post: async (body: unknown, options: { headers: unknown }) => {
          calls.push({ method: 'POST', path: `/v1/libraryEntries/${id}:restore`, body, ...options });
          return { status: 409, error: { value: { code: 'library_entry_restore_occupied' } } };
        },
      },
      get: async (options: { query: unknown; headers: unknown }) => {
        calls.push({ method: 'GET', path: `/v1/libraryEntries/${id}`, ...options });
        return { status: 200, data: { libraryEntry: currentEntry }, error: null };
      },
    }),
  };
  const result = await restorePersonalLibraryEntry(
    client as never,
    request,
    {},
    { subjectId, deletionId, revision: 12 },
  );
  expect(result).toMatchObject({ ok: false, reason: 'occupied', entry: { revision: 15, state: 'completed' } });
  expect(calls.map(({ method, path }) => [method, path])).toEqual([
    ['POST', `/v1/libraryEntries/${subjectId}:restore`],
    ['GET', `/v1/libraryEntries/${subjectId}`],
  ]);
  expect(calls[0]).toMatchObject({
    body: { deletionId, revision: 12 },
    headers: { authorization: 'Bearer reader' },
  });
});

// Capture the real generated transport boundary; a hand-written client double can hide a malformed suffix route.
test('the client sends one DELETE and one POST to the restore suffix with the exact receipt and bearer', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { createRecordedKernelFetch } = await import('../src/kernel/fake');
  const calls: Request[] = [];
  const fake = createRecordedKernelFetch({});
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const captured = new Request(input, init);
      calls.push(captured.clone());
      return fake(captured);
    }) as typeof fetch,
  });
  const removed = await removePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId,
      revision: 7,
      idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    },
  );
  expect(removed.ok && removed.undo).toEqual({ deletionId: 'undo-ok', revision: 12 });
  if (!removed.ok || !removed.undo) throw new Error('Missing removal receipt');
  const restored = await restorePersonalLibraryEntry(client, request, {}, { subjectId, ...removed.undo });
  expect(restored).toMatchObject({ ok: true, entry: { subjectId, state: 'planned', revision: 7 } });
  expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ['DELETE', `/v1/libraryEntries/${subjectId}`],
    ['POST', `/v1/libraryEntries/${subjectId}:restore`],
  ]);
  expect(new URL(calls[0]!.url).searchParams.get('revision')).toBe('7');
  expect(calls[0]!.headers.get('idempotency-key')).toBe('0192f3a0-6c1e-7b2a-9d4e-000000000002');
  expect(await calls[1]!.json()).toEqual({ deletionId: 'undo-ok', revision: 12 });
  expect(calls[1]!.headers.get('idempotency-key')).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer reader')).toBe(true);
});

test('rendered shelf and subject removal feedback carries a real POST Undo form, including without JavaScript', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { mock } = await import('bun:test');
  // Server functions are not executed by a static render. Keep the UI's actual components and exposure queries.
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('../src/library/entries-actions', () => ({
    savePersonalLibraryEntry: () => {},
    deletePersonalLibraryEntry: () => {},
    restorePersonalLibraryEntryAction: () => {},
  }));
  mock.module('../src/library/subject-slot-actions', () => ({
    mutateSubjectLibrarySlot: () => {},
    readSubjectLibraryCollections: () => {},
    restoreSubjectLibrarySlot: () => {},
  }));
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { PersonalLibraryPage } = await import('../src/library/entries-page');
  const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient();
  client.setQueryData(['exposure', 'anonymous'], ['personal_library', 'library_entry.restore']);
  const render = (component: Parameters<typeof createElement>[0], props: object) =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(component, props)));
  const receipt = { subjectId, deletionId, revision: 12 };
  const data = {
    session: 'signed-in',
    csrfToken: 'csrf',
    entryAvailable: true,
    entry: null,
    publicCollections: null,
    publicCollectionsNext: null,
    collectionsLoaded: false,
    collections: null,
  };
  for (const [component, props] of [
    [
      PersonalLibraryPage,
      {
        page: { signedIn: true, state: null, sections: [] },
        locale: 'en',
        display: { layout: 'grid', size: 'm' },
        undo: receipt,
        csrfToken: 'csrf',
      },
    ],
    [
      SubjectLibrarySlot,
      { subject: { id: subjectId, label: 'A book', type: 'book' }, locale: 'en', data: { ...data, undo: receipt } },
    ],
  ] as const) {
    const html = render(component as never, props);
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/library/entry"');
    expect(html).toContain(`name="deletionId" value="${deletionId}"`);
    expect(html).toContain('name="revision" value="12"');
    expect(html).toContain('name="intent" value="restore"');
    expect(html).toContain('name="csrf_token" value="csrf"');
    expect(html).toContain(m.editor_undo());
    expect(html).toContain(m.library_removed());
    expect(html).not.toContain('name="state" value="planned"');
  }
  // A legacy DELETE has no receipt: there must be no invented Undo.
  expect(
    render(PersonalLibraryPage, {
      page: { signedIn: true, state: null, sections: [] },
      locale: 'en',
      display: { layout: 'grid', size: 'm' },
    }),
  ).not.toContain('name="deletionId"');
  expect(
    render(SubjectLibrarySlot, { subject: { id: subjectId, label: 'A book', type: 'book' }, locale: 'en', data }),
  ).not.toContain('name="deletionId"');
  // The operation itself must be exposed, rather than implicitly granted by its group.
  client.setQueryData(['exposure', 'anonymous'], ['personal_library']);
  expect(
    render(PersonalLibraryPage, {
      page: { signedIn: true, state: null, sections: [] },
      locale: 'en',
      display: { layout: 'grid', size: 'm' },
      undo: receipt,
    }),
  ).not.toContain('name="deletionId"');
  client.clear();
});

test.each(['occupied', 'stale', 'expired'] as const)(
  'both rendered surfaces explain %s and occupied shows the current entry',
  async (reason) => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { PersonalLibraryPage } = await import('../src/library/entries-page');
    const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view');
    const { m } = await import('../src/paraglide/messages.js');
    const client = new QueryClient();
    client.setQueryData(['exposure', 'anonymous'], ['personal_library', 'library_entry.restore']);
    const restore = {
      ok: false,
      reason,
      ...(reason === 'occupied' ? { entry: { ...entry, state: 'completed', revision: 15, subject: null } } : {}),
    };
    const render = (component: Parameters<typeof createElement>[0], props: object) =>
      renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(component, props)));
    const shelf = render(PersonalLibraryPage, {
      page: { signedIn: true, state: null, sections: [] },
      locale: 'en',
      display: { layout: 'grid', size: 'm' },
      restore,
    });
    const subject = render(SubjectLibrarySlot, {
      subject: { id: subjectId, label: 'A book', type: 'book' },
      locale: 'en',
      data: {
        session: 'signed-in',
        csrfToken: 'csrf',
        entryAvailable: true,
        entry: null,
        publicCollections: null,
        collections: null,
        collectionsLoaded: false,
        publicCollectionsNext: null,
        restore,
      },
    });
    for (const html of [shelf, subject]) {
      expect(html).toContain(m[`library_restore_${reason}`]());
      expect(html).not.toContain('name="deletionId"');
      if (reason === 'occupied') expect(html).toContain(m.library_state_completed());
      else expect(html).not.toContain('data-restored-entry');
    }
    client.clear();
  },
);

test.each([false, true])('script-free removal with restore admission %s preserves the native receipt', async (restoreAdmitted) => {
  const { createKernelClient } = await import('@rezics/client');
  const { createRecordedKernelFetch, setFakeAdmitted } = await import('../src/kernel/fake');
  const { libraryEntryFormResponse } = await import('../src/library/entry-form');
  setFakeAdmitted(['personal_library', 'library_entry.delete', ...(restoreAdmitted ? ['library_entry.restore'] : [])]);
  const calls: Request[] = [];
  const fake = createRecordedKernelFetch({});
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const captured = new Request(input, init);
      calls.push(captured.clone());
      return fake(captured);
    }) as typeof fetch,
  });
  for (const returnTo of ['/en/library', '/en/subjects/book-one/a-book']) {
    calls.length = 0;
    const send = (body: URLSearchParams) =>
      libraryEntryFormResponse(
        new Request('https://rezics.test/library/entry', {
          method: 'POST',
          headers: { authorization: 'Bearer reader' },
          body,
        }),
        {},
        client,
      );
    const removed = await send(
      new URLSearchParams({
        intent: 'remove',
        subjectId,
        revision: '7',
        locale: 'en',
        returnTo,
        idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
      }),
    );
    expect(removed.status).toBe(200);
    expect(removed.headers.get('cache-control')).toBe('private, no-store');
    const html = await removed.text();
    if (!restoreAdmitted) {
      expect(html).toContain('Removed');
      expect(html).not.toContain('name="intent" value="restore"');
      expect(html).not.toContain('name="deletionId"');
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
      continue;
    }
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/library/entry"');
    expect(html).not.toContain('<script');
    const fields = new URLSearchParams();
    for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g))
      fields.set(match[1]!, match[2]!);
    expect(fields.get('deletionId')).toBe('undo-ok');
    expect(fields.get('revision')).toBe('12');
    const response = await send(fields);
    expect(response.status).toBe(200);
    const restored = await response.text();
    expect(restored).toContain('data-restored-entry');
    expect(restored).toContain('data-entry-revision="7"');
    expect(restored).toContain('A book');
    expect(restored).toContain('Planned');
    expect(restored).toContain(`href="${returnTo}"`);
    expect(restored).not.toContain('name="deletionId"');
    const writes = calls.filter((call) => new URL(call.url).pathname.startsWith('/v1/libraryEntries'));
    expect(writes.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['DELETE', `/v1/libraryEntries/${subjectId}`],
      ['POST', `/v1/libraryEntries/${subjectId}:restore`],
    ]);
    expect(await writes[1]!.json()).toEqual({ deletionId: 'undo-ok', revision: 12 });
    expect(writes.every((call) => call.headers.get('authorization') === 'Bearer reader')).toBe(true);
  }
  setFakeAdmitted([]);
});

test('the new form endpoint validates cookie CSRF and requires each intent admission', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { createRecordedKernelFetch, setFakeAdmitted } = await import('../src/kernel/fake');
  const { libraryEntryFormResponse } = await import('../src/library/entry-form');
  const { csrfTokenFromRequest } = await import('../src/session/csrf');
  const token = 'a'.repeat(22);
  const calls: Request[] = [];
  const fake = createRecordedKernelFetch({});
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const captured = new Request(input, init);
      calls.push(captured.clone());
      return fake(captured);
    }) as typeof fetch,
  });
  const env = {
    SITE_ORIGINS: 'https://rezics.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'api',
    WEBSITE_SCOPES: 'scope',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({ status: 'active', subject: 'reader', accessToken: 'reader', csrfToken: token }),
      }),
    },
  } as unknown as import('../src/session/client').SessionEnv;
  const send = (csrf: string, intent = 'restore') =>
    new Request('https://rezics.test/library/entry', {
      method: 'POST',
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin: 'https://rezics.test' },
      body: new URLSearchParams({
        intent,
        idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
        subjectId,
        deletionId: 'undo-ok',
        revision: '12',
        locale: 'en',
        csrf_token: csrf,
      }),
    });
  expect(await csrfTokenFromRequest(send(token))).toBe(token);
  const duplicate = send(token);
  const body = await duplicate.text();
  expect(
    await csrfTokenFromRequest(
      new Request(duplicate.url, {
        method: 'POST',
        body: `${body}&csrf_token=${token}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    ),
  ).toBeNull();
  expect((await libraryEntryFormResponse(send('bad'), env, client)).status).toBe(403);
  expect(calls).toHaveLength(0);
  setFakeAdmitted(['personal_library']);
  expect((await libraryEntryFormResponse(send(token), env, client)).status).toBe(403);
  expect((await libraryEntryFormResponse(send(token, 'remove'), env, client)).status).toBe(403);
  expect(calls.every((call) => new URL(call.url).pathname === '/v1/platform/exposure')).toBe(true);
  calls.length = 0;
  setFakeAdmitted(['personal_library', 'library_entry.restore']);
  expect((await libraryEntryFormResponse(send(token, 'remove'), env, client)).status).toBe(403);
  const foreign = send(token);
  foreign.headers.set('origin', 'https://other.test');
  expect((await libraryEntryFormResponse(foreign, env, client)).status).toBe(403);
  expect((await libraryEntryFormResponse(send(token), env, client)).status).toBe(200);
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  setFakeAdmitted([]);
});

test.each([
  [['personal_library', 'library_entry.delete'], true],
  [['personal_library', 'library_entry.restore'], false],
  [['personal_library'], false],
] as const)('remove form requires its own operation: %j', async (admitted, visible) => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { EntryRemoveForm } = await import('../src/library/entry-undo');
  const client = new QueryClient();
  client.setQueryData(['exposure', 'anonymous'], admitted);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(EntryRemoveForm, {
    locale: 'en', subjectId, revision: 7, idempotencyKey: deletionId,
  })));
  expect(html.includes('name="intent" value="remove"')).toBe(visible);
  client.clear();
});

test('both page components render the restored entry supplied in the restore response', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { PersonalLibraryPage } = await import('../src/library/entries-page');
  const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view');
  const client = new QueryClient();
  client.setQueryData(['exposure', 'anonymous'], ['personal_library', 'library_entry.restore']);
  const restore = {
    ok: true,
    entry: {
      ...entry,
      subject: { id: subjectId, type: 'book', label: 'Title from restore body', types: ['book'], cover: null },
    },
  };
  const props = [
    [
      PersonalLibraryPage,
      {
        page: { signedIn: true, state: null, sections: [] },
        locale: 'en',
        display: { layout: 'grid', size: 'm' },
        restore,
      },
    ],
    [
      SubjectLibrarySlot,
      {
        subject: { id: subjectId, type: 'book', label: 'A book' },
        locale: 'en',
        data: {
          session: 'signed-in',
          csrfToken: 'csrf',
          entryAvailable: true,
          entry: null,
          publicCollections: null,
          publicCollectionsNext: null,
          collectionsLoaded: false,
          collections: null,
          restore,
        },
      },
    ],
  ] as const;
  for (const [component, data] of props) {
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(component as never, data)),
    );
    expect(html).toContain('data-restored-entry');
    expect(html).toContain('data-entry-revision="7"');
    expect(html).toContain('Title from restore body');
    expect(html).not.toContain('name="deletionId"');
  }
  client.clear();
});
