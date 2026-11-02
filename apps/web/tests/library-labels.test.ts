import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const source = async (path: string) => readFile(join(app, path), 'utf8');

test('labels page implements the private, bounded catalogue and no-script management contract', async () => {
  const [route, read, actions, page] = await Promise.all([
    source('src/routes/library/labels.tsx'),
    source('src/library/labels-read.ts'),
    source('src/library/labels-actions.ts'),
    source('src/library/labels-page.tsx'),
  ]);
  expect(route).toContain("createFileRoute('/library/labels')");
  expect(route).toContain('noindex, nofollow');
  expect(read).toContain('limit: 100');
  expect(read).toContain('libraryLabels');
  expect(page).toContain('page.next');
  expect(actions.toLowerCase()).toContain('idempotency-key');
  expect(page).toContain('library_label_restore_stale');
  expect(page).toContain('library_label_restore_expired');
  expect(page).toContain('library_label_restore_occupied');
  expect(page).toContain('UndoToast');
  expect(page).toContain('library_label_revision');
});

test('labels page and library navigation are gated by their operations and support a signed-out reader', async () => {
  const [page, entries, collections] = await Promise.all([
    source('src/library/labels-page.tsx'),
    source('src/library/entries-page.tsx'),
    source('src/library/mine-collections-page.tsx'),
  ]);
  expect(page).toContain('page.signedIn');
  expect(page).toContain('m.library_sign_in()');
  expect(page).toContain('Exposure');
  expect(entries).toContain('/library/labels');
  expect(collections).toContain('/library/labels');
});

// These outcome tests exercise the documented HTTP contract through the real kernel client.
// The catalogue fake is contract evidence only; kernel authorization is owned by commerce.
import { mock } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEnv } from '../src/session/client';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadLabelsPage, submitLabel, handleLabelForm } = await import('../src/library/labels-read');
const { LabelsPageView } = await import('../src/library/labels-page');
const { createLibraryLabelsFake } = await import('../src/kernel/fake/library-labels');
const csrfToken = 'AAAAAAAAAAAAAAAAAAAAAA';
const sessionCookie = `__Host-rezics_session=${'a'.repeat(43)}`;
const origin = 'https://site.example.test';
const env = {
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://kernel.example.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: origin,
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({ status: 'active', subject: 'owner', accessToken: 'owner-token', csrfToken }),
      signedIn: async () => ({ signedIn: true, subject: 'owner', csrfToken }),
    }),
  },
} as unknown as Partial<SessionEnv>;
const request = (method = 'GET', cookie = sessionCookie) =>
  new Request(`${origin}/en/library/labels`, {
    method,
    headers: { cookie, origin, 'x-csrf-token': csrfToken },
  });
function setup(size = 3) {
  const fake = createLibraryLabelsFake({
    labels: Array.from({ length: size }, (_, index) => ({
      id: `label-${index}`,
      name: `${size - index} winter reads`,
      revision: 9,
    })),
    next: 'opaque+next/cursor',
    deleteRevision: 73,
  });
  const client = createKernelClient('https://kernel.example.test', { fetch: fake.fetch });
  return { fake, client };
}
const markup = (page: Awaited<ReturnType<typeof loadLabelsPage>>) =>
  renderToStaticMarkup(createElement(LabelsPageView, { page }));
function form(html: string, operation: string, id?: string) {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
  const found = forms.find((part) => part.includes(`value="${operation}"`) && (!id || part.includes(`value="${id}"`)));
  expect(found).toBeDefined();
  expect(found).toContain('method="post"');
  expect(found).toContain('action="/en/library/labels"');
  const body = new URLSearchParams();
  for (const input of found!.matchAll(/<input\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(input[0])?.[1];
    const value = /value="([^"]*)"/.exec(input[0])?.[1] ?? '';
    if (name) body.set(name, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"'));
  }
  return body;
}
async function postForm(client: Parameters<typeof loadLabelsPage>[0], body: URLSearchParams) {
  const response = await handleLabelForm(
    client,
    new Request(`${origin}/en/library/labels`, {
      method: 'POST',
      headers: { cookie: sessionCookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
    env,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const next = new Request(new URL(response.headers.get('location')!, origin), {
    headers: { cookie: `${sessionCookie}; ${cookie}` },
  });
  return loadLabelsPage(client, next, env);
}

test("the labels page lists the owner's labels from one catalogue read of up to 100, in the kernel's order, with a link to the next page when next is set", async () => {
  for (const size of [3, 100]) {
    const { fake, client } = setup(size);
    const page = await loadLabelsPage(client, request(), env, 'starting-cursor');
    const reads = fake.calls.filter((call) => call.path === '/v1/libraryLabels');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      method: 'GET',
      query: { cursor: 'starting-cursor', limit: '100' },
      authorization: 'Bearer owner-token',
    });
    expect(page.labels.map((label) => label.name)).toEqual(fake.labels.map((label) => label.name));
    const html = markup(page);
    expect(html).toContain('cursor=opaque%2Bnext%2Fcursor');
    expect(html.indexOf(`${size} winter reads`)).toBeLessThan(html.indexOf('1 winter reads'));
  }
});

test('rename buttons compose only outline styling before and after a revision conflict', async () => {
  const { fake, client } = setup();
  const initial = markup(await loadLabelsPage(client, request(), env));
  fake.labels[0] = { id: 'label-0', name: 'Changed elsewhere', revision: 20 };
  const conflict = markup(await postForm(client, form(initial, 'rename', 'label-0')));
  for (const html of [initial, conflict]) {
    const renames = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).filter((part) =>
      part.includes('value="rename"'),
    );
    expect(renames).toHaveLength(3);
    for (const rename of renames) {
      const classes = /<button\b[^>]*class="([^"]*)"/.exec(rename)?.[1]?.split(/\s+/) ?? [];
      expect(classes).toContain('border-border');
      expect(classes).toContain('bg-background');
      expect(classes).toContain('dark:bg-transparent');
      expect(classes).not.toContain('bg-primary');
      expect(classes).not.toContain('text-primary-foreground');
      expect(classes).not.toContain('hover:bg-primary/80');
    }
  }
});

test("creating, renaming and deleting a label each send one request with an Idempotency-Key, and rename and delete send the label's revision", async () => {
  const { fake, client } = setup();
  const inputs = [
    { operation: 'create', name: 'New label' },
    { operation: 'rename', id: 'label-0', name: 'Renamed', revision: 9 },
    { operation: 'delete', id: 'label-0', revision: 10 },
  ] as const;
  for (const input of inputs) {
    fake.calls.length = 0;
    const idempotencyKey = crypto.randomUUID();
    const result = await submitLabel(client, request('POST'), env, { ...input, idempotencyKey });
    expect(result.ok).toBe(true);
    const writes = fake.calls.filter((call) => call.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(idempotencyKey);
    expect(writes[0]?.authorization).toBe('Bearer owner-token');
    if (input.operation === 'create')
      expect(writes[0]).toMatchObject({
        method: 'POST',
        path: '/v1/libraryLabels',
        body: { name: 'New label' },
        query: {},
      });
    if (input.operation === 'rename')
      expect(writes[0]).toMatchObject({
        method: 'PATCH',
        path: '/v1/libraryLabels/label-0',
        body: { name: 'Renamed', revision: 9 },
        query: {},
      });
    if (input.operation === 'delete')
      expect(writes[0]).toMatchObject({
        method: 'DELETE',
        path: '/v1/libraryLabels/label-0',
        body: null,
        query: { revision: '10' },
      });
  }
});

test('a stale revision on rename or delete reloads the page and shows the current label, changing nothing', async () => {
  for (const operation of ['rename', 'delete']) {
    const { fake, client } = setup();
    const html = markup(await loadLabelsPage(client, request(), env));
    fake.labels[0] = { id: 'label-0', name: 'Changed elsewhere', revision: 20 };
    const body = form(html, operation, 'label-0');
    if (operation === 'rename') body.set('name', 'Obsolete edit');
    const page = await postForm(client, body);
    expect(page.labels[0]).toMatchObject({ name: 'Changed elsewhere', revision: 20 });
    expect(markup(page)).toContain('This label changed elsewhere.');
    expect(fake.labels[0]?.name).toBe('Changed elsewhere');
    expect(fake.calls.filter((call) => call.path === '/v1/libraryLabels' && call.method === 'GET')).toHaveLength(2);
    const retry = form(markup(page), operation, 'label-0');
    expect(retry.get('library_label_revision')).toBe(body.get('library_label_revision'));
    expect(retry.get('idempotencyKey')).toBe(body.get('idempotencyKey'));
    expect((await postForm(client, retry)).feedback?.reason).toBe('conflict');
    expect(fake.labels[0]?.name).toBe('Changed elsewhere');
  }
});

test('no-script catalogue retries recover a lost committed response without a new identity or revision', async () => {
  for (const operation of ['create', 'rename', 'delete'] as const) {
    const { fake } = setup();
    let loseReply = true;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const response = await fake.fetch(input, init);
        if (loseReply && new Request(input, init).method !== 'GET') {
          loseReply = false;
          throw new Error('Committed reply lost');
        }
        return response;
      }) as typeof fetch,
    });
    const body = form(
      markup(await loadLabelsPage(client, request(), env)),
      operation,
      operation === 'create' ? undefined : 'label-0',
    );
    if (operation !== 'delete') body.set('name', 'Recovered name');
    const uncertain = await postForm(client, body);
    expect(uncertain.feedback?.reason).toBe('unavailable');
    const retry = form(markup(uncertain), operation, operation === 'create' ? undefined : 'label-0');
    for (const field of ['idempotencyKey', 'library_label_revision', 'name'])
      expect(retry.get(field)).toBe(body.get(field));
    const recovered = await postForm(client, retry);
    expect(recovered.feedback?.ok).toBe(true);
    expect(fake.calls.filter((call) => call.method !== 'GET').map((call) => call.key)).toEqual([
      body.get('idempotencyKey'),
      body.get('idempotencyKey'),
    ]);
    expect(recovered.labels.filter((label) => label.name === 'Recovered name')).toHaveLength(
      operation === 'delete' ? 0 : 1,
    );
    if (operation === 'delete') expect(recovered.feedback?.undo?.revision).toBe(73);
  }
});

test('after a delete the page offers Undo, which restores the label by sending the revision from the Library-Label-Revision response header', async () => {
  const { fake, client } = setup();
  const html = markup(await loadLabelsPage(client, request(), env));
  const deleted = await postForm(client, form(html, 'delete', 'label-0'));
  expect(deleted.labels).toHaveLength(2);
  const undo = form(markup(deleted), 'restore', 'label-0');
  expect(undo.get('library_label_revision')).toBe('73');
  const restored = await postForm(client, undo);
  expect(restored.labels.map((label) => label.id)).toEqual(fake.labels.map((label) => label.id));
  expect(fake.calls.filter((call) => call.method === 'POST' && call.path.endsWith(':restore'))).toEqual([
    expect.objectContaining({ body: { revision: 73 }, key: expect.any(String) }),
  ]);
  expect(restored.labels.some((label) => label.id === 'label-0')).toBe(true);
});

test("a restore refused as library_label_restore_stale, library_label_restore_expired or library_label_restore_occupied shows that refusal's own message", async () => {
  const messages = [
    ['library_label_restore_stale', 'This label changed after it was deleted.'],
    ['library_label_restore_expired', 'The undo period has ended.'],
    ['library_label_restore_occupied', 'Another label now uses this name.'],
  ] as const;
  for (const [code, message] of messages) {
    const { fake, client } = setup();
    const deleted = await postForm(
      client,
      form(markup(await loadLabelsPage(client, request(), env)), 'delete', 'label-0'),
    );
    fake.refuse('restore', code);
    const page = await postForm(client, form(markup(deleted), 'restore', 'label-0'));
    expect(markup(page)).toContain(message);
    expect(page.labels.map((label) => label.id)).toEqual(fake.labels.map((label) => label.id));
    expect(page.labels).toHaveLength(2);
    expect(markup(page).includes('value="restore"')).toBe(code === 'library_label_restore_occupied');
  }
});

test('every form works without JavaScript, and the page is noindex and shows a signed-out reader the sign-in prompt the other library pages show', async () => {
  const { fake, client } = setup();
  let page = await loadLabelsPage(client, request(), env);
  const create = form(markup(page), 'create');
  create.set('name', 'Native form');
  page = await postForm(client, create);
  const created = page.labels.find((label) => label.name === 'Native form')!;
  expect(created).toBeDefined();
  const rename = form(markup(page), 'rename', created.id);
  rename.set('name', 'Native rename');
  page = await postForm(client, rename);
  expect(page.labels.find((label) => label.id === created.id)?.name).toBe('Native rename');
  expect(form(markup(page), 'create').get('idempotencyKey')).not.toBe(create.get('idempotencyKey'));
  fake.calls.length = 0;
  const signedOut = await loadLabelsPage(client, request('GET', ''), env);
  expect(markup(signedOut)).toContain('Sign in');
  expect(markup(signedOut)).not.toContain('<form');
  expect(fake.calls).toHaveLength(0);
  expect(await source('src/routes/library/labels.tsx')).toContain('noindex, nofollow');
  const missingCsrf = new URLSearchParams(create);
  missingCsrf.delete('csrf_token');
  await postForm(client, missingCsrf);
  expect(fake.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
});

test('today’s exposure keeps label reads, navigation and controls closed, and individual operations gate each form', async () => {
  const { fake, client } = setup();
  fake.admitted = ['personal_library'];
  const closed = await loadLabelsPage(client, request(), env);
  expect(closed.labels).toEqual([]);
  expect(markup(closed)).not.toContain('<form');
  expect(fake.calls.some((call) => call.path === '/v1/libraryLabels')).toBe(false);
  fake.admitted = ['library_label.list', 'library_label.rename'];
  const html = markup(await loadLabelsPage(client, request(), env));
  form(html, 'rename', 'label-0');
  expect(html).not.toContain('value="create"');
  expect(html).not.toContain('value="delete"');
  const { operationGroups } = await import('../src/kernel/exposure');
  expect(operationGroups['library_label.list']).toBe('library_label.list');
});

test('a refused name stays beside its field with the draft and kernel reason; missing delete headers never invent an undo revision', async () => {
  const { fake, client } = setup();
  fake.refuse('create', 'invalid_request', 'The label name contains a control character.');
  const input = form(markup(await loadLabelsPage(client, request(), env)), 'create');
  input.set('name', 'Rejected draft');
  const page = await postForm(client, input);
  const html = markup(page);
  expect(html).toContain('The label name contains a control character.');
  expect(html).toContain('value="Rejected draft"');
  expect(html).toContain('aria-describedby="create-error"');
  fake.deleteRevision = null;
  const result = await submitLabel(client, request('POST'), env, {
    operation: 'delete',
    id: 'label-0',
    revision: 9,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('revision');
});

test('native label forms pass the shared CSRF boundary only with one bounded token on their exact route', async () => {
  const { csrfTokenFromRequest } = await import('../src/session/csrf');
  for (const path of ['/library/labels', '/en/library/labels', '/zh-Hans/library/labels']) {
    const native = new Request(`${origin}${path}`, {
      method: 'POST',
      body: new URLSearchParams({ csrf_token: csrfToken }),
    });
    expect(await csrfTokenFromRequest(native)).toBe(csrfToken);
  }
  for (const [path, body] of [
    ['/en/library/labels/other', `csrf_token=${csrfToken}`],
    ['/en/library/labels', `csrf_token=${csrfToken}&csrf_token=${csrfToken}`],
    ['/en/library/labels', `csrf_token=${csrfToken}&name=${'x'.repeat(4096)}`],
  ]) {
    const native = new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(await csrfTokenFromRequest(native)).toBeNull();
  }
});

test('the unprofiled label story loads the same complete subject and localized title through both subject reads', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { unprofiledSubjectId } = await import('../src/kernel/fake/library-unprofiled-subject');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { loadSubjectPage, subjectBody, subjectPageTitle } = await import('../src/features/pages/subject');
  const { libraryProfile } = await import('../src/library/profiles');
  const { default: definitions } = await import('../src/kernel/recorded/definitions-release.json');
  const client = createKernelClient('https://kernel.example.test', { fetch: createStoryRecordedKernelFetch() });
  expect(
    libraryProfile(definitions.release as unknown as import('../src/subject/definitions').Release, 'schema:Person'),
  ).toBeUndefined();

  for (const [locale, title] of [
    ['en', 'Person'],
    ['zh-Hant', '人物'],
    ['zh-Hans', '人物'],
    ['ja', '人物'],
    ['ko', '사람'],
    ['de', 'Person'],
    ['fr', 'Personne'],
    ['es', 'Persona'],
  ] as const) {
    const canonical = await loadSubject(client, unprofiledSubjectId, locale);
    expect(canonical.kind).toBe('subject');
    if (canonical.kind !== 'subject') throw new Error('Unprofiled subject is missing');
    expect(canonical.value.label).toBe(title);
    expect(canonical.value.subject).toMatchObject({
      type: 'schema:Person',
      statements: {},
      descriptions: {},
      aliases: {},
    });
    expect(canonical.value.read.related).toEqual({});
    expect(canonical.value.subject.sourceRecords).toEqual([]);

    const loaded = await loadSubjectPage(client, unprofiledSubjectId, undefined, locale);
    expect(loaded.kind).toBe('page');
    if (loaded.kind !== 'page') throw new Error('Unprofiled page is missing');
    expect(subjectBody(loaded.page)?.subject).toEqual(canonical.value.subject);
    expect(subjectPageTitle(loaded.page, locale)).toBe(title);
  }
});

test('the unprofiled subject stays on its catalogue route rather than inheriting the recorded Mira account', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { unprofiledSubjectId, routes } = await import('../src/kernel/fake/library-unprofiled-subject');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { loadSubjectPage } = await import('../src/features/pages/subject');
  const client = createKernelClient('https://kernel.example.test', { fetch: createStoryRecordedKernelFetch() });
  const canonical = await loadSubject(client, unprofiledSubjectId, 'en');
  expect(canonical.kind).toBe('subject');
  if (canonical.kind !== 'subject') throw new Error('Unprofiled subject is missing');
  expect(canonical.value.href).toBe(`/en/subjects/${unprofiledSubjectId}/person`);
  expect(canonical.value.read.account).toBeNull();
  expect((await client.accounts.get({ query: { agent: unprofiledSubjectId } })).data?.accounts).toEqual([]);
  expect((await client.accounts.get({ query: { handle: 'mira' } })).data?.accounts[0]?.handle).toBe('mira');
  const accountRoute = routes.find((route) => route.path === '/v1/accounts')!;
  expect(
    await accountRoute.story?.({
      request: new Request('https://kernel.example.test/v1/accounts?agent=another-subject'),
      recordings: {},
      match: null,
    }),
  ).toBeUndefined();

  const loaded = await loadSubjectPage(client, unprofiledSubjectId);
  expect(loaded.kind).toBe('page');
  if (loaded.kind !== 'page') throw new Error('Unprofiled page is missing');
  expect(loaded.page.subject).toBe(unprofiledSubjectId);
  expect(loaded.page.account).toBeUndefined();
  expect(JSON.stringify(loaded.page.document)).toContain('"name":"actions"');
  const route = await source('src/routes/subjects/$id_.$slug.tsx');
  expect(route).toContain('subjectLibraryQuery(id, locale');
  expect(route).toContain('actions={(subject) => (');
  expect(route).toContain('<SubjectLibrarySlot');
});

test('the unprofiled story creates a generic label on its actual subject and keeps assignments subject-local', async () => {
  const { createStoryRecordedKernelFetch, setFakeAdmitted } = await import('../src/kernel/fake');
  const { unprofiledSubjectId } = await import('../src/kernel/fake/library-unprofiled-subject');
  const { resetLabelAssignmentStory, setLibraryLabelStorySizes } =
    await import('../src/kernel/fake/library-label-assignments');
  const { setLabelCatalogueStory } = await import('../src/kernel/fake/library-labels');
  const { applySubjectLabelMutation, readSubjectLabelAssignments } = await import('../src/library/subject-labels');
  const { loadSubjectLibrarySlot } = await import('../src/library/subject-slot');
  setLabelCatalogueStory(false);
  resetLabelAssignmentStory();
  setLibraryLabelStorySizes({ subject: 0 });
  setFakeAdmitted([
    'library_label.assignment_list',
    'library_label.list',
    'library_label.create',
    'library_label.assign',
  ]);
  const client = createKernelClient('https://kernel.example.test', { fetch: createStoryRecordedKernelFetch() });
  try {
    const before = await loadSubjectLibrarySlot(client, request(), env, unprofiledSubjectId);
    expect(before.session).toBe('signed-in');
    expect(before.labels).toEqual([]);
    let created = await applySubjectLabelMutation(
      request('POST'),
      env,
      {
        intent: 'create-and-assign',
        subjectId: unprofiledSubjectId,
        name: 'For later',
        createKey: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      },
      client,
    );
    for (let index = 0; index < 2; index++) {
      if (!('step' in created)) throw new Error('Expected a captured label step');
      created = await applySubjectLabelMutation(request('POST'), env, {
        intent: 'label-step', subjectId: unprofiledSubjectId, token: created.step.token,
      }, client);
    }
    expect(created.ok).toBe(true);
    const after = await loadSubjectLibrarySlot(client, request(), env, unprofiledSubjectId);
    expect(after.labels).toEqual([expect.objectContaining({ name: 'For later', id: expect.any(String), revision: 1 })]);
    expect(after.entry).toBeNull();
    expect(after.stateOptions).toEqual([]);
    const full = await client.libraryLabelAssignments.get({
      query: { subjectId: unprofiledSubjectId, view: 'FULL', limit: 32 },
    });
    expect(full.data?.assignments[0]?.subjectId).toBe(unprofiledSubjectId);
    expect(
      await readSubjectLabelAssignments(client, '0192f3a0-6c1e-7b2a-9d4e-000000000805', 'Bearer owner-token'),
    ).toEqual([]);
    setLibraryLabelStorySizes({ subject: 3 });
    const populated = await client.libraryLabelAssignments.get({
      query: { subjectId: unprofiledSubjectId, view: 'FULL', limit: 32 },
    });
    expect(populated.data?.assignments).toHaveLength(3);
    expect(populated.data?.assignments.every((row) => row.subjectId === unprofiledSubjectId)).toBe(true);
  } finally {
    resetLabelAssignmentStory();
    setLibraryLabelStorySizes({ subject: 3 });
    setFakeAdmitted([]);
  }
});
