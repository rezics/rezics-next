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
