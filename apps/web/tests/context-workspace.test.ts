import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { createContextApi, failure } from '../src/features/contexts/api';
import { contextFixture, fixtureId } from '../src/features/contexts/fixtures';
import { unavailableContextDirectory } from '../src/features/contexts/directory-api';
import {
  admits,
  contextQueryKey,
  detailHref,
  directoryHref,
  directoryInput,
  lifecycleOperation,
  parseCommand,
} from '../src/features/contexts/model';
import { ContextCreateView, ContextDetailView, ContextDirectoryView } from '../src/features/contexts/view';
import { isSignedInPath } from '../src/session/guard';

const key = () => crypto.randomUUID();
const active = directoryInput({});
const auth = 'Bearer context-fixture';
const noChange = async () => ({ kind: 'denied' as const });
const reload = async () => {};

describe('An editor finds current readable Contexts creates one and follows native current permission delete restore and conflict states through the existing shell', () => {
  test('bounded readable discovery, native creation, current settings, delete and direct deleted restore preserve identity and session', async () => {
    const fixture = contextFixture();
    const directory = await fixture.api.list(active);
    expect(directory.page.kind === 'ready' && directory.page.value.contexts[0]!.id).toBe(fixtureId);
    expect(directory.page.kind === 'ready' && directory.page.value.next).toBe('opaque+/page==');
    const searched = await fixture.api.list(directoryInput({ query: 'unmatched', cursor: 'server-cursor' }));
    expect(searched.page).toEqual({ kind: 'ready', value: { contexts: [], next: null } });
    expect(fixture.calls[0]).toMatchObject({ method: 'GET', path: '/v1/contexts' });
    expect(new URLSearchParams(fixture.calls[0]!.query).get('limit')).toBe('20');
    expect(fixture.calls.find((call) => call.path === '/v1/viewerActions')?.body).toEqual({
      resources: [{ type: 'semantic.context', id: PAGE_GLOBAL_CONTEXT }],
    });
    const command = parseCommand({ operation: 'create', key: key(), labels: { ja: '読者の編集' } });
    const created = await fixture.api.submit(command);
    expect(created).toMatchObject({
      kind: 'confirmed',
      id: fixtureId,
      current: {
        kind: 'ready',
        value: { context: { id: fixtureId, kind: 'community', settings: { id: 'editorial' } } },
      },
    });
    const create = fixture.calls.findIndex((call) => call.path === '/v1/contexts' && call.method === 'POST');
    expect(fixture.calls[create]!.body).toEqual({ labels: { ja: '読者の編集' } });
    expect(fixture.calls[create]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
    expect(
      fixture.calls
        .slice(create + 1)
        .every((call) => call.headers.get('rezics-session-token') === 'current-context-session'),
    ).toBe(true);
    const deleted = await fixture.api.submit(parseCommand({ operation: 'delete', id: fixtureId, key: key() }));
    expect(deleted).toMatchObject({
      kind: 'confirmed',
      current: {
        kind: 'ready',
        value: { context: null, lifecycle: { id: fixtureId, state: 'deleted', purgeAfter: '2026-10-31T10:00:00Z' } },
      },
    });
    const directlyOpened = await fixture.api.detail(fixtureId);
    expect(directlyOpened.kind === 'ready' && lifecycleOperation(directlyOpened.value)).toBe('restore');
    const restored = await fixture.api.submit(parseCommand({ operation: 'restore', id: fixtureId, key: key() }));
    expect(restored).toMatchObject({
      kind: 'confirmed',
      current: { kind: 'ready', value: { context: { id: fixtureId }, lifecycle: { state: 'active' } } },
    });
    const mutations = fixture.calls.filter((call) => call.path !== '/v1/viewerActions' && call.method !== 'GET');
    expect(mutations.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/contexts'],
      ['DELETE', `/v1/contexts/${fixtureId}`],
      ['POST', `/v1/contexts/${fixtureId}:restore`],
    ]);
    expect(mutations[2]!.body).toEqual({});
    expect(fixture.calls.every((call) => call.headers.get('authorization') === auth)).toBe(true);
    expect(mutations.every((call) => !call.headers.has('if-match'))).toBe(true); // Context lifecycle has no revision/CAS header.
  });

  test('unknown outcomes replay one sealed payload/key, and a confirmed write cannot manufacture a successful reread', async () => {
    const fixture = contextFixture('unknown');
    const labels = { en: 'Original name' };
    const command = parseCommand({ operation: 'create', labels, key: key(), session: 'original-session' });
    labels.en = 'Changed draft';
    expect(Object.isFrozen(command)).toBe(true);
    expect(command.operation === 'create' && Object.isFrozen(command.labels)).toBe(true);
    expect(await fixture.api.submit(command)).toMatchObject({ kind: 'unknown' });
    expect(await fixture.api.submit(command)).toMatchObject({ kind: 'confirmed', current: { kind: 'ready' } });
    const writes = fixture.calls.filter((call) => call.path === '/v1/contexts' && call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    expect(writes[0]!.body).toEqual({ labels: { en: 'Original name' } });
    expect([...writes[0]!.headers]).toEqual([...writes[1]!.headers]);
    const unreadable = contextFixture('reread-unavailable');
    expect(
      await unreadable.api.submit(parseCommand({ operation: 'create', labels: { en: 'Private name' }, key: key() })),
    ).toMatchObject({ kind: 'confirmed', current: { kind: 'unavailable' } });
    const noMetadata = createContextApi(fixture.client, auth);
    const deleted = await noMetadata.submit(parseCommand({ operation: 'delete', id: fixtureId, key: key() }));
    expect(deleted).toMatchObject({ kind: 'confirmed', current: { kind: 'missing' } });
    expect(JSON.stringify(deleted)).not.toContain('Original name');
  });

  test('current action denial, revocation, native conflicts, expiry and holds never inherit creator authority or cached labels', async () => {
    const fixture = contextFixture('active');
    const prior = await fixture.api.detail(fixtureId);
    expect(prior.kind === 'ready' && admits(prior.value.actions, 'delete')).toBe(true);
    fixture.revoke();
    expect(await fixture.api.submit(parseCommand({ operation: 'delete', id: fixtureId, key: key() }))).toMatchObject({
      kind: 'denied',
    });
    const current = await fixture.api.detail(fixtureId);
    expect(current).toMatchObject({ kind: 'missing' });
    expect(JSON.stringify(current)).not.toContain('Readers');
    for (const scenario of ['conflict', 'expired', 'hold'] as const) {
      const denied = contextFixture(scenario);
      const command = parseCommand({
        operation: scenario === 'conflict' ? 'delete' : 'restore',
        id: fixtureId,
        key: key(),
      });
      expect(await denied.api.submit(command)).toMatchObject({ kind: 'conflict' });
      expect((await denied.api.detail(fixtureId)).kind).toBe('ready');
    }
    const viewer = contextFixture('read-only');
    const readonly = await viewer.api.detail(fixtureId);
    expect(readonly.kind === 'ready' && admits(readonly.value.actions, 'delete')).toBe(false);
    const globalFixture = contextFixture('global');
    expect(await globalFixture.api.detail(PAGE_GLOBAL_CONTEXT)).toMatchObject({ kind: 'ready' });
    const global = globalFixture.initialDetail();
    expect(global.kind === 'ready' && lifecycleOperation(global.value)).toBeNull();
    expect(
      admits({ kind: 'ready', value: [{ action: 'context:delete', operations: ['context.restore'] }] }, 'delete'),
    ).toBe(false);
    for (const body of [
      { operation: 'create', key: key(), labels: { en: 'Name' }, settings: 'invented' },
      { operation: 'create', key: key(), labels: { en: 'Name' }, defaults: {} },
      { operation: 'create', key: key(), labels: { en: '' } },
      { operation: 'delete', key: key(), id: fixtureId, owner: true },
    ])
      expect(() => parseCommand(body)).toThrow();
  });

  test('undelivered reads and resource resolver stay unavailable, with no fake rows or permission fallback', async () => {
    expect(await unavailableContextDirectory.list(active, {})).toEqual({ kind: 'unavailable' });
    expect(await unavailableContextDirectory.lifecycle(fixtureId, {})).toEqual({ kind: 'unavailable' });
    const fixture = contextFixture('active');
    const api = createContextApi(fixture.client, auth);
    expect((await api.list(active)).page).toEqual({ kind: 'unavailable', session: 'current-context-session' });
    expect(await api.detail(fixtureId)).toMatchObject({
      kind: 'ready',
      value: { lifecycle: null, lifecycleUnavailable: true },
    });
    const unavailable = contextFixture('permission-unavailable').initialDetail();
    expect(unavailable.kind === 'ready' && admits(unavailable.value.actions, 'delete')).toBe(false);
    const missingResolver = createKernelClient('https://context.invalid', {
      fetch: (async () =>
        new Response(
          JSON.stringify({ resources: [{ type: 'semantic.context', id: PAGE_GLOBAL_CONTEXT, error: 'not_found' }] }),
          { headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    expect(await createContextApi(missingResolver, auth).creation()).toEqual({ kind: 'unavailable' });
    expect(failure(503, { code: 'overloaded' }, true)).toEqual({ kind: 'unknown' });
    expect(failure(404, {}, true)).toEqual({ kind: 'unknown' });
    expect(failure(422, { code: 'idempotency_conflict' }, true)).toEqual({ kind: 'conflict' });
    expect(failure(400, { code: 'invalid_cursor' })).toEqual({ kind: 'stale' });
  });

  test('production default uses generated directory and lifecycle methods with isolated query and deleted filter', async () => {
    const calls: { method: string; path: string; query: string }[] = [];
    const entry = {
      id: fixtureId,
      kind: 'community' as const,
      labels: { ja: '読者の編集' },
      state: 'active' as const,
      deletedAt: null,
      purgeAfter: null,
    };
    const dto = {
      id: fixtureId,
      kind: 'community' as const,
      labels: { ja: '読者の編集' },
      settings: null,
      defaults: {},
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const client = createKernelClient('https://context-generated.invalid', {
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        calls.push({ method: request.method, path: url.pathname, query: url.search });
        if (url.pathname === '/v1/contexts' && request.method === 'GET') {
          const deleted = url.searchParams.get('deleted') === 'true';
          const query = url.searchParams.get('query') ?? '';
          const match = !query || Object.values(entry.labels).some((label) => label.includes(query));
          return json({
            contexts: deleted || !match ? [] : [entry],
            next: null,
          });
        }
        if (url.pathname === `/v1/contexts/${fixtureId}/lifecycle`) return json({ context: entry });
        if (url.pathname === `/v1/contexts/${fixtureId}`) return json({ context: dto });
        if (url.pathname === '/v1/viewerActions')
          return json({ resources: [{ type: 'semantic.context', id: fixtureId, viewerActions: [] }] });
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const api = createContextApi(client, auth);
    const listed = await api.list(directoryInput({ query: '読者' }));
    expect(listed.page).toEqual({ kind: 'ready', value: { contexts: [entry], next: null } });
    const listQuery = new URLSearchParams(calls[0]!.query);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/contexts' });
    expect(listQuery.get('limit')).toBe('20');
    expect(listQuery.get('deleted')).toBe('false');
    expect(listQuery.get('query')).toBe('読者');
    expect((await api.list(directoryInput({ query: '読者', deleted: true }))).page).toEqual({
      kind: 'ready',
      value: { contexts: [], next: null },
    });
    expect(await api.detail(fixtureId)).toMatchObject({
      kind: 'ready',
      value: { context: dto, lifecycle: entry, lifecycleUnavailable: false },
    });
    expect(calls.some((call) => call.path === `/v1/contexts/${fixtureId}/lifecycle`)).toBe(true);
  });

  test('product components show real empty/search/permission states, read-only settings and server lifecycle dates in all locales', async () => {
    const en = await Bun.file(new URL('../messages/en.json', import.meta.url)).json();
    const keys = Object.keys(en)
      .filter((key) => key.startsWith('ctxw_'))
      .sort();
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      expect(
        Object.keys(messages)
          .filter((key) => key.startsWith('ctxw_'))
          .sort(),
      ).toEqual(keys);
      const fixture = contextFixture('read-only');
      const html = renderToStaticMarkup(
        createElement(ContextDetailView, {
          id: fixtureId,
          locale,
          data: fixture.initialDetail(),
          submit: noChange,
          reload,
        }),
      );
      expect(html).toContain('editorial');
      expect(html).toContain('released-settings-digest');
      expect(html).toContain('disabled');
      const denied = renderToStaticMarkup(
        createElement(ContextDetailView, {
          id: fixtureId,
          locale,
          data: { kind: 'missing' },
          submit: noChange,
          reload,
        }),
      );
      expect(denied).not.toContain('Readers');
      expect(isSignedInPath(`/${locale}/my/contexts`)).toBe(true);
      expect(isSignedInPath(`/${locale}/my/contexts/new`)).toBe(true);
      expect(detailHref(locale, fixtureId)).toBe(`/${locale}/my/contexts/${fixtureId}`);
    }
    const fixture = contextFixture('create-denied');
    const create = renderToStaticMarkup(
      createElement(ContextCreateView, { locale: 'en', actions: fixture.initialCreation(), submit: noChange, reload }),
    );
    expect(create).toContain('disabled');
    expect(create).not.toContain('textarea');
    const empty = contextFixture('empty');
    const html = renderToStaticMarkup(
      createElement(ContextDirectoryView, {
        locale: 'en',
        input: active,
        data: empty.initialDirectory(active),
        reload,
      }),
    );
    expect(html).toContain(en.ctxw_empty);
    expect(html).not.toContain('Readers');
    const deleted = contextFixture('deleted');
    const tombstone = renderToStaticMarkup(
      createElement(ContextDetailView, {
        locale: 'en',
        id: fixtureId,
        data: deleted.initialDetail(),
        submit: noChange,
        reload,
      }),
    );
    expect(tombstone).toContain('dateTime="2026-10-31T10:00:00Z"');
    expect(tombstone).toContain(en.ctxw_restore);
    const noDeadline = deleted.initialDetail();
    if (noDeadline.kind !== 'ready' || !noDeadline.value.lifecycle) throw new Error('Missing lifecycle fixture');
    noDeadline.value.lifecycle.purgeAfter = null;
    expect(lifecycleOperation(noDeadline.value)).toBeNull();
    const withheld = renderToStaticMarkup(
      createElement(ContextDetailView, {
        locale: 'en',
        id: fixtureId,
        data: noDeadline,
        submit: noChange,
        reload,
      }),
    );
    expect(withheld).toContain(en.ctxw_restore);
    expect(withheld).not.toContain(en.ctxw_delete);
    expect(withheld).toContain('disabled');
    const global = renderToStaticMarkup(
      createElement(ContextDetailView, {
        locale: 'en',
        id: PAGE_GLOBAL_CONTEXT,
        data: contextFixture('global').initialDetail(),
        submit: noChange,
        reload,
      }),
    );
    expect(global).not.toContain(en.ctxw_delete);
    const href = new URL(
      directoryHref('en', { query: 'a & b', deleted: true, cursor: 'opaque+/page==' }),
      'https://context.invalid',
    );
    expect(Object.fromEntries(href.searchParams)).toEqual({
      query: 'a & b',
      deleted: 'true',
      cursor: 'opaque+/page==',
    });
    expect(contextQueryKey('actor-a', 'en', 'directory', active)).not.toEqual(
      contextQueryKey('actor-b', 'en', 'directory', active),
    );
    expect(contextQueryKey('actor-a', 'en', 'directory', active)).not.toEqual(
      contextQueryKey('actor-a', 'en', 'directory', { ...active, deleted: true }),
    );
  });
});

test('Context summaries expose supplied multilingual headings and exact navigation without adding a second item frame', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://context.invalid/en' });
  const { m } = await import('../src/paraglide/messages.js');
  const o = { locale: 'en' as const };
  try {
    const input = directoryInput({ deleted: true, query: '旅', cursor: 'previous+/==' });
    const supplied = contextFixture('deleted').initialDirectory(input);
    if (supplied.page.kind !== 'ready') throw new Error('Expected a supplied Context page');
    const entry = contextFixture('deleted').initialDirectory(directoryInput({ deleted: true })).page;
    if (entry.kind !== 'ready' || !entry.value.contexts[0]) throw new Error('Expected a deleted Context');
    const title = '旅の読者たちと物語を読み続けるための、とても長い多言語の編集コミュニティ';
    supplied.page.value = {
      contexts: [{ ...entry.value.contexts[0], labels: { ja: title } }],
      next: 'next+/==',
    };
    const before = structuredClone(supplied);
    const render = (data: typeof supplied | null, query = input) => {
      window.document.body.innerHTML = renderToStaticMarkup(
        createElement(ContextDirectoryView, { locale: 'en', input: query, data, reload }),
      );
    };
    render(supplied);
    const document = window.document;
    const list = document.querySelector(`ul[aria-label="${m.ctxw_title({}, o)}"]`)!;
    expect(list.children).toHaveLength(1);
    const item = list.firstElementChild!;
    expect(item.tagName).toBe('LI');
    expect(item.querySelector('li')).toBeNull();
    const heading = item.querySelector('h2')!;
    expect(heading.textContent).toBe(title);
    expect(heading.lang).toBe('ja');
    const link = item.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(detailHref('en', fixtureId));
    expect(link.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(item.textContent).toContain(m.ctxw_community({}, o));
    expect(item.textContent).toContain(m.ctxw_deleted({}, o));
    const destinations = [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    expect(destinations).toContain(directoryHref('en', { ...input, cursor: 'next+/==' }));
    expect(destinations).toContain(directoryHref('en', { ...input, cursor: undefined }));
    expect(item.querySelector('a a, a button, a details')).toBeNull();
    expect(supplied).toEqual(before);

    for (const kind of ['denied', 'unavailable', 'stale'] as const) {
      render({ ...supplied, page: { kind } });
      expect(document.querySelector('ul')).toBeNull();
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain(title);
    }
    render(null);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.ctxw_loading({}, o));
    expect(document.querySelector('ul')).toBeNull();
    const empty = { ...supplied, page: { kind: 'ready' as const, value: { contexts: [], next: null } } };
    render(empty, directoryInput({}));
    expect(document.body.textContent).toContain(m.ctxw_empty({}, o));
    expect(document.querySelector('ul')).toBeNull();
    render(empty, directoryInput({ query: '旅' }));
    expect(document.body.textContent).toContain(m.ctxw_no_matches({}, o));
    expect(document.querySelector('ul')).toBeNull();
    for (const cursor of [undefined, 'previous+/==']) {
      for (const next of [null, 'next+/==']) {
        for (const query of [undefined, '旅 & Readers']) {
          for (const deleted of [false, true]) {
            const selection = directoryInput({ query, cursor, deleted });
            render({ ...empty, page: { kind: 'ready', value: { contexts: [], next } } }, selection);
            const title = next
              ? m.ctxw_empty_page({}, o)
              : cursor
                ? m.ctxw_empty_final_page({}, o)
                : query
                  ? m.ctxw_no_matches({}, o)
                  : m.ctxw_empty({}, o);
            expect(document.querySelector('[data-slot="empty-title"]')?.textContent).toBe(title);
            expect(document.querySelector('[data-slot="empty-description"]')?.textContent).toBe(
              next
                ? m.ctxw_empty_page_help({}, o)
                : cursor
                  ? m.ctxw_empty_final_page_help({}, o)
                  : m.ctxw_empty_help({}, o),
            );
            const links = [...document.querySelectorAll('a')];
            for (const [label, destination] of [
              [m.ctxw_next({}, o), next ? directoryHref('en', { ...selection, cursor: next }) : null],
              [m.ctxw_restart({}, o), cursor ? directoryHref('en', { ...selection, cursor: undefined }) : null],
            ]) {
              expect(links.find((link) => link.textContent === label)?.getAttribute('href') ?? null).toBe(destination);
            }
            expect(links.some((link) => link.getAttribute('href') === `${directoryHref('en')}/new`)).toBe(
              admits(empty.creation, 'create'),
            );
            expect(document.querySelector('ul')).toBeNull();
          }
        }
      }
    }
  } finally {
    await window.happyDOM.abort();
  }
});
