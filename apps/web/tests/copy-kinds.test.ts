import { describe, expect, test } from 'bun:test';
import { libraryChoices, libraryCopyKindLabel, libraryCopyStatusLabel } from '../src/library/profiles';
import type { Release } from '../src/subject/definitions';
import { writeFailure } from '../src/library/copies-read';

const release = {
  types: { 'schema:Book': { library: { profileId: 'book-profile' } } },
  libraryProfiles: {
    'book-profile': {
      copies: {
        kinds: [
          {
            id: 'print',
            labels: { en: 'Print' },
            statuses: [
              { id: 'shelf', labels: { en: 'On shelf' } },
              { id: 'loan', labels: { en: 'On loan' } },
            ],
          },
          { id: 'digital', labels: { en: 'Digital' }, statuses: [{ id: 'available', labels: { en: 'Available' } }] },
        ],
      },
    },
    'legacy-fixed-v1': {
      copies: {
        kinds: [{ id: 'legacy', labels: { en: 'Legacy' }, statuses: [{ id: 'owned', labels: { en: 'Owned' } }] }],
      },
    },
  },
} as unknown as Release;

describe('profile copy declarations', () => {
  test('keeps kind and status choices in declared order and scopes statuses to each kind', () => {
    expect(libraryChoices(release, 'schema:Book')?.copyKinds).toEqual([
      { id: 'print', statuses: ['shelf', 'loan'] },
      { id: 'digital', statuses: ['available'] },
    ]);
    expect(libraryCopyStatusLabel(release, 'schema:Book', 'digital', 'loan', 'en')).toBeUndefined();
  });

  test('names current and legacy kinds, while unknown IDs remain unnamed for neutral fallback', () => {
    expect(libraryCopyKindLabel(release, 'schema:Book', 'print', 'en')?.text).toBe('Print');
    expect(libraryCopyStatusLabel(release, 'schema:Book', 'legacy', 'owned', 'en')?.text).toBe('Owned');
    expect(libraryCopyStatusLabel(release, 'schema:Book', 'print', 'unknown', 'en')).toBeUndefined();
  });

  test('keeps unsupported profile writes distinct from invalid input', () => {
    expect(writeFailure(422, { value: { code: 'unsupported_library_profile' } })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(writeFailure(422, { value: { code: 'invalid' } })).toEqual({ ok: false, reason: 'invalid' });
  });

  test('a missing profile has no copy choices', () => {
    expect(libraryChoices(release, 'schema:Unknown')?.copyKinds).toBeUndefined();
  });
});

// Exercise the page's actual forms and rows, then post their successful controls through its server action.
import { mock } from 'bun:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import { loadCopiesPage, removeCopy, saveCopy } from '../src/library/copies-read';
import { csrfTokenFromRequest } from '../src/session/csrf';

mock.module('../src/library/copies-actions', () => ({
  createCopy() {},
  updateCopy() {},
  deleteCopy() {},
  readCopySubject() {},
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({}) }));
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
}));
mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => createElement('a', null, children),
  notFound: () => new Error('not found'),
}));
const views = await import('../src/library/copies-page');
const profiles = await import('../src/library/copies-profiles');
const actions = await import('../src/library/copies-form-action');
const fakeModule = await import('../src/kernel/fake/copies-kinds');
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const key = '10203040-5060-4070-8090-102030405060';
const request = () =>
  new Request('https://site.test/en/library/copies', { headers: { authorization: 'Bearer owner' } });
const fields = { location: null, source: null, acquiredOn: null, disposedOn: null, note: null };
const copy = (kind: string | null = 'print', status = 'shelf') => ({
  id: 'copy-1',
  kind,
  status,
  revision: 1,
  ...fields,
  subject: { id: subjectId, type: 'schema:Book', types: ['schema:Book'], label: 'A book', cover: null },
  idempotencyKey: key,
});
const markup = (component: Parameters<typeof createElement>[0], props: object) =>
  renderToStaticMarkup(createElement(component, props));
const resolved = () => profiles.resolveCopyProfile(release, 'schema:Book', 'en');
const form = (extra: object = {}) =>
  markup(views.CopyForm, {
    subjectId,
    addKey: key,
    profile: resolved(),
    sendKind: true,
    inline: true,
    onClose() {},
    onCreated() {},
    onSaved() {},
    onRemoved() {},
    onKey() {},
    ...extra,
  });
const options = (html: string, name: string) =>
  [
    ...(html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? '').matchAll(
      /<option[^>]*value="([^"]*)"/g,
    ),
  ].map((match) => match[1]);
const page = (items = [copy()], profile = resolved()) => ({
  signedIn: true,
  subjectId,
  copies: items.map((item) => ({
    ...item,
    profile,
    kindLabel: profile.kinds.find((kind) => kind.id === item.kind)?.label ?? 'Other',
    statusLabel:
      profile.kinds.find((kind) => kind.id === item.kind)?.statuses.find((status) => status.id === item.status)
        ?.label ?? 'Other',
  })),
  next: null,
  addKey: key,
  profile,
  sendKind: true,
});

function transport(refusal = false) {
  const calls: { method: string; body: unknown }[] = [];
  fakeModule.setCopyProfileScenario({ copies: [copy()], refusal });
  const fake = createFakeKernelFetch(fixtures as unknown as Parameters<typeof createFakeKernelFetch>[0]);
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      calls.push({
        method: req.method,
        body: req.method === 'GET' || req.method === 'DELETE' ? null : await req.clone().json(),
      });
      return fake(input, init);
    }) as typeof fetch,
  });
  return { client, calls };
}
function posted(html: string, changes: Record<string, string> = {}) {
  // Successful controls belong to the submitted form, not other update/delete forms on the page.
  html = html.match(/<form[^>]*method="post"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? html;
  const body = new URLSearchParams();
  for (const match of html.matchAll(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"/g)) body.set(match[1]!, match[2]!);
  for (const name of ['kind', 'status']) {
    const value = options(html, name)[0];
    if (value) body.set(name, value);
  }
  for (const [name, value] of Object.entries(changes)) body.set(name, value);
  return new Request('https://site.test/en/library/copies', {
    method: 'POST',
    headers: { authorization: 'Bearer owner', origin: 'https://site.test' },
    body,
  });
}

test('the add-copy page form offers profile kinds and only the chosen kind statuses in order, and creates once with both', async () => {
  const html = form();
  expect(options(html, 'kind')).toEqual(['print', 'digital']);
  expect(options(html, 'status')).toEqual(['shelf', 'loan']);
  expect(options(form({ initialKind: 'digital' }), 'status')).toEqual(['available']);
  expect(html).toContain('On shelf');
  const { client, calls } = transport();
  expect((await actions.postCopyForm(client, posted(html), {})).ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toMatchObject({ subjectId, kind: 'print', status: 'shelf' });
});

test('the one-kind page form hides the kind choice and still posts that kind', async () => {
  const profile = { kinds: resolved().kinds.slice(1) };
  const html = form({ profile });
  expect(options(html, 'kind')).toEqual([]);
  expect(html).toContain('name="kind" value="digital"');
  expect(options(html, 'status')).toEqual(['available']);
  const { client, calls } = transport();
  expect((await actions.postCopyForm(client, posted(html), {})).ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toMatchObject({ kind: 'digital', status: 'available' });
});

test('missing and copy-less profiles offer no add form; existing copies remain listed and deletable', async () => {
  for (const profile of [profiles.resolveCopyProfile(release, 'missing', 'en'), { kinds: [] }]) {
    const html = markup(views.CopiesPage, { page: page([copy()], profile) });
    expect(html).toContain('A book');
    expect(html).toContain('data-slot="list-row"');
    expect(html).not.toContain('Add a copy');
    const editor = form({ copy: { ...copy(), profile }, profile });
    expect(editor).not.toContain('<select');
    expect(editor).toContain('Delete');
    const { client, calls } = transport();
    expect(await removeCopy(client, request(), {}, { id: 'copy-1', revision: 1, idempotencyKey: key })).toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(1);
  }
});

test('editing uses only its own kind statuses, never PATCHes kind, and retired, null and legacy kinds have deletion only', async () => {
  expect(options(form({ copy: copy('digital', 'available') }), 'status')).toEqual(['available']);
  const { client, calls } = transport();
  expect(
    (
      await saveCopy(
        client,
        request(),
        {},
        { id: 'copy-1', revision: 1, idempotencyKey: key, kind: 'digital', status: 'loan', ...fields },
      )
    ).ok,
  ).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).not.toHaveProperty('kind');
  for (const kind of ['retired', null, 'legacy-unspecified']) {
    const html = form({ copy: copy(kind) });
    expect(html).not.toContain('<select');
    expect(html).not.toContain('>Save<');
    expect(html).toContain('This copy’s type is no longer offered for this item.');
    expect(html).toContain('Delete');
    const next = transport();
    expect(await removeCopy(next.client, request(), {}, { id: 'copy-1', revision: 1, idempotencyKey: key })).toEqual({
      ok: true,
    });
  }
});

test('unknown status and kind rows survive the fake read and show neutral Other on the page', async () => {
  const { client } = transport();
  fakeModule.setCopyProfileScenario({
    copies: [copy('print', 'unknown-status'), { ...copy(null, 'unknown-status'), id: 'copy-2' }],
  });
  const data = await loadCopiesPage(client, request(), {}, {});
  expect(data.copies).toHaveLength(2);
  const html = markup(views.CopiesPage, { page: page(data.copies) });
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(2);
  expect(html.match(/Other/g)?.length).toBeGreaterThanOrEqual(2);
});

test('a 422 unsupported profile response is shown by the page without retrying or changing copies', async () => {
  const { client, calls } = transport(true);
  const before = page();
  const result = await actions.postCopyForm(client, posted(form()), {});
  expect(result).toEqual({ ok: false, reason: 'unsupported' });
  expect(calls).toHaveLength(1);
  const html = markup(views.CopiesPage, { page: before, failure: result.ok ? undefined : result.reason });
  expect(html).toContain('This item’s library profile does not support that copy type and status.');
  expect(html).toContain('A book');
  expect(before.copies).toHaveLength(1);
});

test('without JavaScript the page form posts both selects and the server action forwards the pair; form CSRF is scoped', async () => {
  const html = markup(views.CopiesFallback, { page: page(), csrfToken: 'token' });
  expect(html).toContain('method="post"');
  expect(options(html, 'kind')).toEqual(['print', 'digital']);
  expect(options(html, 'status')).toEqual(['shelf', 'loan', 'available']);
  const { client, calls } = transport();
  const req = posted(html, { kind: 'digital', status: 'available' });
  expect((await actions.postCopyForm(client, req, {})).ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toMatchObject({ kind: 'digital', status: 'available' });
  const csrfRequest = new Request('https://site.test/en/library/copies', {
    method: 'POST',
    body: new URLSearchParams({ csrf_token: 'token' }),
  });
  expect(await csrfTokenFromRequest(csrfRequest)).toBe('token');
  expect(await csrfTokenFromRequest(new Request('https://site.test/en/settings', csrfRequest))).toBeNull();
});
