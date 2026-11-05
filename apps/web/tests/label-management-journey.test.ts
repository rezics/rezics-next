import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEnv } from '../src/session/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { LabelsPageView } = await import('../src/library/labels-page');
const { handleLabelForm, loadLabelsPage } = await import('../src/library/labels-read');
const { createLibraryLabelsFake } = await import('../src/kernel/fake/library-labels');

const origin = 'https://site.example.test';
const csrfToken = 'AAAAAAAAAAAAAAAAAAAAAA';
const sessionCookie = `__Host-rezics_session=${'a'.repeat(43)}`;
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

type Page = Awaited<ReturnType<typeof loadLabelsPage>>;
const markup = (page: Page) => renderToStaticMarkup(createElement(LabelsPageView, { page }));
function phoneActions(html: string) {
  const controls = (html.match(/<(button|summary|a)\b[^>]*>[\s\S]*?<\/\1>/g) ?? []).filter(
    (control) => !control.includes('data-library-label-link'),
  );
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const classes = /class="([^"]*)"/.exec(control)?.[1].split(' ') ?? [];
    for (const token of [
      'h-auto',
      'min-h-11',
      'min-w-11',
      'max-w-full',
      'whitespace-normal',
      '[overflow-wrap:anywhere]',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-ring',
    ])
      expect(classes).toContain(token);
  }
}
function selectedForm(html: string, operation: string, id: string) {
  const form = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find(
    (part) => part.includes(`value="${operation}"`) && part.includes(`value="${id}"`),
  );
  expect(form).toBeDefined();
  const body = new URLSearchParams();
  for (const match of form!.matchAll(/<input\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(match[0])?.[1];
    const value = /value="([^"]*)"/.exec(match[0])?.[1] ?? '';
    if (name) body.set(name, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"'));
  }
  return { html: form!, body };
}

// The default page's real progressive forms feed the existing session/CSRF/client adapter.
// This is a transport fixture, not evidence of native label authorization or storage.
test('Default private label management keeps filter rename delete undo and continuation usable on phones', async () => {
  const fake = createLibraryLabelsFake({
    labels: [
      { id: 'first', name: 'Winter reads', revision: 9 },
      { id: 'second', name: 'Books to revisit', revision: 3 },
    ],
    next: 'opaque+next/cursor',
  });
  const client = createKernelClient('https://kernel.example.test', { fetch: fake.fetch });
  const request = () => new Request(`${origin}/en/library/labels`, { headers: { cookie: sessionCookie } });
  async function post(body: URLSearchParams) {
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
    return loadLabelsPage(
      client,
      new Request(new URL(response.headers.get('location')!, origin), {
        headers: { cookie: `${sessionCookie}; ${response.headers.get('set-cookie')!.split(';')[0]}` },
      }),
      env,
    );
  }
  let page = await loadLabelsPage(client, request(), env);
  const initial = markup(page);
  expect(initial).toContain('href="/en/library?label=first"');
  expect(initial).toContain('cursor=opaque%2Bnext%2Fcursor');
  expect(initial.match(/<details\b/g)).toHaveLength(4);
  expect(initial).not.toMatch(/<details\b[^>]*\sopen(?:=|>)/);
  phoneActions(initial);
  const filtered = markup({ ...page, query: 'Winter' });
  phoneActions(filtered);
  const filter = (filtered.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find((form) =>
    form.includes('method="get"'),
  )!;
  expect(filter).toContain('action="/en/library/labels"');
  expect(filter).toContain('name="q"');
  expect(filter).toContain('value="Winter"');
  expect(filtered).toMatch(/<a\b[^>]*href="\/en\/library\/labels"[^>]*>Clear filter<\/a>/);
  expect(filtered).toContain('q=Winter&amp;cursor=opaque%2Bnext%2Fcursor');
  const rename = selectedForm(initial, 'rename', 'first');
  expect(rename.html).toContain('method="post"');
  expect(rename.html).toContain('action="/en/library/labels"');
  expect(rename.body.get('operation')).toBe('rename');
  expect(rename.body.get('id')).toBe('first');
  expect(rename.body.get('idempotencyKey')).toBeTruthy();
  expect(rename.html).toContain('required=""');
  expect(rename.html).toContain('maxLength="1000"');
  expect(rename.body.get('library_label_revision')).toBe('9');
  expect(rename.body.get('csrf_token')).toBe(csrfToken);
  rename.body.set('name', 'Reading again');
  page = await post(rename.body);
  expect(page.labels.find((label) => label.id === 'first')).toMatchObject({ name: 'Reading again', revision: 10 });
  expect(markup(page)).not.toMatch(/<details\b[^>]*\sopen(?:=|>)/);
  expect(fake.calls.filter((call) => call.method === 'PATCH')).toEqual([
    expect.objectContaining({
      path: '/v1/libraryLabels/first',
      body: { name: 'Reading again', revision: 9 },
      key: rename.body.get('idempotencyKey'),
      authorization: 'Bearer owner-token',
    }),
  ]);

  // A concurrent rename changes the readback and its form keys, but never replaces the submitted draft.
  const stale = selectedForm(markup(page), 'rename', 'first');
  fake.labels[0] = { id: 'first', name: 'Changed elsewhere', revision: 20 };
  stale.body.set('name', 'My unfinished name');
  page = await post(stale.body);
  const refused = markup(page);
  phoneActions(refused);
  expect(page.labels[0]).toMatchObject({ name: 'Changed elsewhere', revision: 20 });
  expect(refused).toContain('This label changed elsewhere.');
  expect(refused.match(/<details\b[^>]*\bopen=""/g)).toHaveLength(1);
  const retained = selectedForm(refused, 'rename', 'first');
  expect(retained.body.get('name')).toBe('My unfinished name');
  expect(retained.html).toContain('aria-invalid="true"');
  expect(retained.html).toContain('aria-describedby="rename-error-first"');
  expect(retained.body.get('library_label_revision')).toBe('10');
  expect(fake.labels[0]?.name).toBe('Changed elsewhere');
  expect(fake.calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
  expect(fake.calls.filter((call) => call.method === 'PATCH')[1]).toMatchObject({
    body: { name: 'My unfinished name', revision: 10 },
    key: stale.body.get('idempotencyKey'),
  });

  // Delete remains a separate, exact target/revision confirmation; merely opening it sends no write.
  const deletion = selectedForm(refused, 'delete', 'second');
  expect(refused).toContain('Delete “Books to revisit”?');
  expect(deletion.body.get('library_label_revision')).toBe('3');
  expect(deletion.body.get('csrf_token')).toBe(csrfToken);
  expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  page = await post(deletion.body);
  expect(page.labels.map((label) => label.id)).toEqual(['first']);
  expect(page.feedback?.undo).toMatchObject({ id: 'second', name: 'Books to revisit', revision: 73 });
  expect(fake.calls.filter((call) => call.method === 'DELETE')).toEqual([
    expect.objectContaining({
      path: '/v1/libraryLabels/second',
      query: { revision: '3' },
      key: deletion.body.get('idempotencyKey'),
    }),
  ]);
  const reads = fake.calls.filter((call) => call.path === '/v1/libraryLabels' && call.method === 'GET');
  expect(reads).toHaveLength(4);
  expect(reads.every((call) => call.query.limit === '100')).toBe(true);

  const deleted = markup(page);
  phoneActions(deleted);
  const restore = selectedForm(deleted, 'restore', 'second');
  expect(restore.body.get('library_label_revision')).toBe('73');
  expect(restore.body.get('idempotencyKey')).toBe(page.feedback?.undoKey);
  expect(restore.body.get('csrf_token')).toBe(csrfToken);
  page = await post(restore.body);
  expect(page.labels.find((label) => label.id === 'second')).toMatchObject({ name: 'Books to revisit', revision: 74 });
  expect(page.feedback?.undo).toBeUndefined();
  expect(fake.calls.filter((call) => call.path === '/v1/libraryLabels/second:restore')).toEqual([
    expect.objectContaining({
      method: 'POST',
      body: { revision: 73 },
      key: restore.body.get('idempotencyKey'),
      authorization: 'Bearer owner-token',
    }),
  ]);

  const continuation = /href="([^"]*cursor=[^"]*)"/.exec(filtered)![1].replaceAll('&amp;', '&');
  const next = new URL(continuation, origin);
  page = await loadLabelsPage(
    client,
    new Request(next, { headers: { cookie: sessionCookie } }),
    env,
    next.searchParams.get('cursor')!,
    next.searchParams.get('q')!,
  );
  expect(fake.calls.filter((call) => call.path === '/v1/libraryLabels').at(-1)).toMatchObject({
    method: 'GET',
    query: { q: 'Winter', cursor: 'opaque+next/cursor', limit: '100' },
  });
  expect(page.labels).toEqual([]);
  expect(page.next).toBeNull();
  expect(markup(page)).not.toContain('cursor=');
});
