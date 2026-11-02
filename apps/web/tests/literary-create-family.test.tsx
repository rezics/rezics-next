import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LiteraryRead } from '../src/features/catalogue/literary-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN. Mounted DOM proves composition and supplied-data behavior, not geometry,
// browser keyboard behavior, native authorization, SSR, or backend growth. Browser plays are separate.
async function mounted(
  run: (ui: {
    host: HTMLElement;
    client: QueryClient;
    render: (node: ReactNode) => Promise<void>;
    click: (name: string, scope?: ParentNode) => Promise<void>;
    change: (select: HTMLSelectElement, value: string) => Promise<void>;
    input: (element: HTMLInputElement, value: string) => Promise<void>;
    until: (predicate: () => boolean) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await run({
      host,
      client,
      render: async (node) => {
        await act(async () => root.render(h(QueryClientProvider, { client }, node)));
      },
      click: async (name, scope = host) => {
        const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(
          (button) => button.textContent?.trim() === name,
        );
        const button = buttons.at(-1)!;
        expect(button).toBeDefined();
        expect(button.disabled).toBe(false);
        await act(async () => button.click());
      },
      change: async (select, value) => {
        await act(async () => {
          select.value = value;
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
      },
      input: async (element, value) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
          element.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      },
      until: async (predicate) => {
        for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
        expect(predicate()).toBe(true);
      },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(scope: ParentNode, name: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === name,
  );
  expect(found).toBeDefined();
  return found!;
}

function labelledInput(scope: ParentNode, name: string) {
  const found = [...scope.querySelectorAll<HTMLInputElement>('input')].find(
    (element) => element.getAttribute('aria-label') === name,
  );
  expect(found).toBeDefined();
  return found!;
}

function initialPanel(scope: ParentNode, name: string) {
  const legend = [...scope.querySelectorAll('legend')].find((element) => element.textContent === name);
  expect(legend).toBeDefined();
  return legend!.parentElement as HTMLFieldSetElement;
}

function propertyControl(panel: HTMLElement) {
  const label = [...panel.querySelectorAll<HTMLLabelElement>('label')].at(-1)!;
  const select = panel.querySelector<HTMLSelectElement>(`select[id="${label.htmlFor}"]`)!;
  expect(select).not.toBeNull();
  expect(label.control).toBe(select);
  expect(panel.ownerDocument.getElementById(label.htmlFor)).toBe(select);
  return select;
}

function queuedSubmit(form: HTMLFormElement) {
  const key = Object.keys(form).find((key) => key.startsWith('__reactProps$'))!;
  return Reflect.get(form, key).onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
}

test('mounted Literary creation keeps the complete initial bibliography family and native command journey', async () => {
  await mounted(async ({ host, client, render, click, change, input, until }) => {
    const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
    const { literaryFixture, literaryWorkId, literaryRelease } =
      await import('../src/kernel/fake/catalogue-literary-profile');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const { pickText } = await import('@rezics/composition');
    const panel = (scope: ParentNode = host) => initialPanel(scope, m.literary_bibliography());
    const row = (scope: ParentNode = host) => scope.querySelector<HTMLElement>('section[id^="literary-fact-"]')!;
    const type = (scope: ParentNode = host) => scope.querySelector<HTMLSelectElement>('select[id="create-type"]')!;
    const props = (fixture: ReturnType<typeof literaryFixture>) => ({
      locale: 'en',
      session: 'signed-in' as const,
      transport: fixture.transport,
      facts: fixture.facts,
      review: fixture.review,
    });
    const show = async (
      fixture: ReturnType<typeof literaryFixture>,
      session: 'signed-in' | 'signed-out' = 'signed-in',
    ) => {
      await render(null);
      await render(h(LiteraryProfile, { ...props(fixture), session }));
      await until(() => !!type());
    };
    const add = async (property: string, scope: HTMLElement = host) => {
      await change(propertyControl(panel(scope)), property);
      await click(m.correction_add(), panel(scope));
    };
    const enter = async (scope: HTMLElement = host) => {
      await change(type(scope), 'schema:Book');
      await input(scope.querySelector<HTMLInputElement>('input[id="create-language-0"]')!, 'ja');
      await input(scope.querySelector<HTMLInputElement>('input[id="create-label-0"]')!, '原語の作品名');
      await add('schema:wordCount', scope);
      await input(labelledInput(row(scope), m.correction_amount()), '+12000');
      const unit = row(scope).querySelector<HTMLSelectElement>(`select[aria-label="${m.correction_unit()}"]`)!;
      await change(unit, '1');
    };
    const cite = 'https://Example.org/Original%2FSource?edition=First&language=ja#' + 'Bibliography'.repeat(25);

    // Independent actual create forms keep only the new property association mount-local.
    const left = literaryFixture();
    const right = literaryFixture();
    await render(
      h(
        'div',
        {},
        h('section', { 'data-create': 'left' }, h(LiteraryProfile, props(left))),
        h('section', { 'data-create': 'right' }, h(LiteraryProfile, props(right))),
      ),
    );
    await until(() => host.querySelectorAll('select[id="create-type"]').length === 2);
    const mounts = [...host.querySelectorAll<HTMLElement>('[data-create]')];
    for (const mount of mounts) await change(type(mount), 'schema:Book');
    const selectors = mounts.map((mount) => propertyControl(panel(mount)));
    expect(selectors[0]!.id).not.toBe(selectors[1]!.id);
    expect(left.calls).toHaveLength(2);
    expect(right.calls).toHaveLength(2);
    await change(selectors[0]!, 'schema:wordCount');
    expect(selectors[1]!.value).toBe('');
    await click(m.correction_add(), panel(mounts[0]!));
    expect(mounts[0]!.querySelectorAll('h3')).toHaveLength(1);
    expect(mounts[1]!.querySelectorAll('h3')).toHaveLength(0);
    expect(left.calls).toHaveLength(2);
    expect(right.calls).toHaveLength(2);

    // Complete long, localized supplied metadata remains in a real h3 and native form ancestry.
    const rich = literaryFixture('uncertain');
    const load = rich.transport.load;
    const label = '完全な書誌情報 — ' + 'BibliographieSansCoupure'.repeat(20);
    const description = 'La description bibliographique complète est conservée. '.repeat(24);
    let metadataFailed: boolean | 'throw' = false;
    rich.transport.load = async () => {
      if (metadataFailed === 'throw') throw new Error('Metadata refresh failed');
      if (metadataFailed) return { ok: false, reason: 'unavailable' };
      const read = await load();
      if (!read.ok) return read;
      return {
        ...read,
        release: {
          ...read.release,
          properties: {
            ...read.release.properties,
            'schema:wordCount': {
              ...read.release.properties['schema:wordCount']!,
              labels: { ja: label },
              descriptions: { fr: description },
            },
          },
        },
      };
    };
    await show(rich);
    await enter();
    const bibliography = panel();
    const fact = row();
    const heading = fact.querySelector('h3')!;
    expect(heading.textContent).toBe(label);
    expect(heading.getAttribute('lang')).toBe('ja');
    expect(heading.getAttribute('data-content-item-slot')).toBe('title');
    expect(fact.getAttribute('aria-label')).toBe(label);
    expect(fact.querySelector('p[lang="fr"]')!.textContent).toBe(description);
    expect(bibliography.firstElementChild!.tagName).toBe('LEGEND');
    expect(bibliography.querySelector(':scope > div')!.className).toContain('before:');
    expect(fact.querySelector(':scope > div')!.className).toContain('before:');
    expect(bibliography.className).not.toContain('border');
    expect(fact.className).not.toContain('border');
    expect(fact.closest('fieldset')).toBe(bibliography);
    expect(fact.closest('form')).toBe(bibliography.closest('form'));
    expect(fact.querySelector('h4')!.textContent).toBe(m.correction_references());
    expect(fact.querySelector('a,summary')).toBeNull();
    for (const node of [heading, fact.querySelector('p')!]) expect(node.className).not.toMatch(/truncate|line-clamp/);
    const selector = propertyControl(bibliography);
    expect(selector.parentElement!.className).toContain('[&_select]:min-h-11');
    expect(selector.parentElement!.className).toContain('[&_select:focus-visible]:outline-2');
    for (const name of [m.correction_add(), m.literary_remove_fact()]) {
      const control = button(bibliography, name);
      expect(control.className).toContain('min-h-11');
      expect(control.className).toContain('whitespace-normal');
      control.focus();
      expect(host.ownerDocument.activeElement).toBe(control);
    }
    await input(labelledInput(fact, m.correction_url()), cite);
    await input(labelledInput(fact, m.correction_url()), '');
    await input(labelledInput(fact, m.correction_url()), cite);
    expect(rich.calls).toHaveLength(2); // All staging, focus and bibliography composition are local.
    await click(m.literary_remove_fact(), fact);
    await click(m.catalogue_create_submit());
    await until(() => host.textContent!.includes(m.catalogue_create_uncertain()));
    expect(button(fact, m.literary_remove_fact()).disabled).toBe(true);
    await act(async () => button(fact, m.literary_remove_fact()).click());
    expect(labelledInput(fact, m.correction_url()).value).toBe(cite);
    const posts = () => rich.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      type: 'schema:Book',
      labels: { ja: '原語の作品名' },
      descriptions: {},
      aliases: {},
      statements: {
        'schema:wordCount': [
          {
            property: { id: 'schema:wordCount' },
            value: { type: 'value', content: { amount: '+12000', unit: '1' } },
            qualifiers: [],
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: cite } }] }],
            rank: 'normal',
          },
        ],
      },
    });
    expect(bibliography.disabled).toBe(true);
    expect(
      (host.querySelector<HTMLInputElement>('input[id="create-label-0"]')!.closest('fieldset') as HTMLFieldSetElement)
        .disabled,
    ).toBe(true);
    const original = structuredClone(posts()[0]!);
    for (const failed of [true, false, 'throw'] as const) {
      metadataFailed = failed;
      await act(async () => {
        await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'literary-profile' });
      });
      expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
      expect(panel().disabled).toBe(true);
      expect(posts()).toHaveLength(1);
    }
    await click(m.catalogue_create_retry());
    await until(() => !!host.querySelector(`a[href*="${literaryWorkId}"]`));
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toEqual(original);
    expect(rich.receipts.size).toBe(1);
    expect(rich.calls.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/v1/definitions/active'],
      ['GET', expect.stringContaining('/v1/definitions/releases/')],
      ['GET', '/v1/definitions/active'],
      ['GET', expect.stringContaining('/v1/definitions/releases/')],
      ['POST', '/v1/subjects'],
      ['GET', '/v1/definitions/active'],
      ['GET', expect.stringContaining('/v1/definitions/releases/')],
      ['POST', '/v1/subjects'],
      ['GET', `/v1/subjects/${literaryWorkId}`],
    ]);
    expect(host.querySelector('form')).toBeNull();

    // Multiplicity, the unchanged 12-row cap, removals and independently retained Type drafts.
    const bounded = literaryFixture();
    await show(bounded);
    await enter();
    const bookId = row().id;
    expect(propertyControl(panel()).querySelector('option[value="schema:wordCount"]')).toBeNull();
    await change(type(), 'schema:BookSeries');
    expect(host.querySelector('h3')).toBeNull();
    expect(propertyControl(panel()).querySelector('option[value="schema:wordCount"]')).toBeNull();
    await add('wdt:P2635');
    await input(labelledInput(row(), m.correction_amount()), '+6');
    const seriesId = row().id;
    await change(type(), 'schema:Book');
    expect(row().id).toBe(bookId);
    expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
    for (let index = 1; index < 12; index++) await add('schema:inLanguage');
    expect(panel().querySelectorAll('section[id^="literary-fact-"]')).toHaveLength(12);
    expect(propertyControl(panel()).querySelector('option[value="schema:inLanguage"]')).not.toBeNull();
    await change(propertyControl(panel()), 'schema:inLanguage');
    expect(button(panel(), m.correction_add()).disabled).toBe(true);
    await click(m.literary_remove_fact(), row());
    await click(m.literary_remove_fact(), row());
    expect(panel().querySelectorAll('section[id^="literary-fact-"]')).toHaveLength(11);
    expect(button(panel(), m.correction_add()).disabled).toBe(false);
    expect(propertyControl(panel()).querySelector('option[value="schema:wordCount"]')).not.toBeNull();
    await change(type(), 'schema:BookSeries');
    expect(row().id).toBe(seriesId);
    expect(labelledInput(row(), m.correction_amount()).value).toBe('+6');
    await change(
      row().querySelector<HTMLSelectElement>(`select[aria-label="${m.correction_unit()}"]`)!,
      'http://www.wikidata.org/entity/Q1238720',
    );
    await click(m.catalogue_create_submit());
    await until(() => !!host.querySelector(`a[href*="${literaryWorkId}"]`));
    const seriesPost = bounded.calls.find((call) => call.method === 'POST')!;
    expect(seriesPost.body).toMatchObject({
      type: 'schema:BookSeries',
      statements: {
        'wdt:P2635': [
          {
            property: { id: 'wdt:P2635' },
            value: { type: 'value', content: { amount: '+6', unit: 'http://www.wikidata.org/entity/Q1238720' } },
          },
        ],
      },
    });
    expect(Object.keys((seriesPost.body as { statements: object }).statements)).toEqual(['wdt:P2635']);

    // Exact error routing still links the native row ID and focuses its first actual scalar control.
    const invalid = literaryFixture('invalid');
    const invalidLoad = invalid.transport.load;
    let recovery: 'initial' | 'throw' | 'refused' | 'current' = 'initial';
    invalid.transport.load = async () => {
      if (recovery === 'throw') throw new Error('Metadata refresh failed');
      if (recovery === 'refused') return { ok: false, reason: 'unavailable' };
      const result = await invalidLoad();
      if (recovery !== 'current' || !result.ok) return result;
      const release = structuredClone(result.release);
      release.types['schema:Book']!.properties = release.types['schema:Book']!.properties.filter(
        (property) => property !== 'schema:wordCount',
      );
      return { ...result, release };
    };
    await show(invalid);
    await enter();
    await click(m.catalogue_create_add_language());
    await input(host.querySelector<HTMLInputElement>('#create-language-1')!, 'en');
    await input(host.querySelector<HTMLInputElement>('#create-label-1')!, 'Private English title');
    const invalidRow = row();
    recovery = 'throw';
    await click(m.catalogue_create_submit());
    await until(() => !!host.querySelector('[role="alert"] a[href^="#literary-fact-"]'));
    const correction = host.querySelector<HTMLAnchorElement>('[role="alert"] a[href^="#literary-fact-"]')!;
    expect(decodeURIComponent(correction.hash.slice(1))).toBe(invalidRow.id);
    expect(correction.textContent).toBe(pickText(literaryRelease.properties['schema:wordCount']!.labels, 'en').text);
    await act(async () => correction.click());
    expect(host.ownerDocument.activeElement).toBe(invalidRow.querySelector('select'));
    expect(labelledInput(invalidRow, m.correction_amount()).value).toBe('+12000');
    const invalidPosts = () => invalid.calls.filter((call) => call.method === 'POST');
    await until(() => host.textContent!.includes(m.catalogue_create_unavailable()));
    expect(
      client.getQueriesData({ queryKey: ['literary-profile'] }).some(([, data]) => (data as LiteraryRead)?.ok),
    ).toBe(true);
    for (const result of ['refused', 'throw', 'current'] as const) {
      expect(button(host, m.catalogue_create_submit()).disabled).toBe(true);
      recovery = result;
      await click(m.catalogue_create_retry());
      await until(
        () => !button(host, result === 'current' ? m.catalogue_create_submit() : m.catalogue_create_retry()).disabled,
      );
      expect(invalidPosts()).toHaveLength(1); // A definitions retry is read-only.
      expect(row()).toBe(invalidRow);
      expect(host.querySelector<HTMLInputElement>('#create-label-0')!.value).toBe('原語の作品名');
      expect(host.querySelector<HTMLInputElement>('#create-label-1')!.value).toBe('Private English title');
      expect(labelledInput(invalidRow, m.correction_amount()).value).toBe('+12000');
    }
    await until(() => !host.textContent!.includes(m.catalogue_create_unavailable()));
    await click(m.catalogue_create_submit());
    expect(invalidPosts()).toHaveLength(1); // The retained fact is rejected against the newly successful release.

    // A failed refresh retains the original row; successful removal of its definition shows stale/remove.
    const staleDefinition = literaryFixture();
    const nativeLoad = staleDefinition.transport.load;
    let metadata: 'ready' | 'failed' | 'removed' = 'ready';
    staleDefinition.transport.load = async (): Promise<LiteraryRead> => {
      const read = await nativeLoad();
      if (metadata === 'failed') return { ok: false, reason: 'unavailable' };
      if (!read.ok || metadata !== 'removed') return read;
      const release = structuredClone(read.release);
      delete release.properties['schema:wordCount'];
      return { ...read, release };
    };
    await show(staleDefinition);
    await enter();
    const retainedId = row().id;
    metadata = 'failed';
    await act(async () => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'literary-profile' });
    });
    expect(row().id).toBe(retainedId);
    expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
    metadata = 'removed';
    await act(async () => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'literary-profile' });
    });
    await until(() => host.textContent!.includes(m.correction_stale()));
    expect(panel().querySelector('h3')).toBeNull();
    expect(button(panel(), m.literary_remove_fact()).className).toContain('min-h-11');
    await click(m.literary_remove_fact(), panel());
    await click(m.candidate_cancel(), panel());
    expect(row().id).toBe(retainedId);
    await click(m.literary_remove_fact(), panel());
    await click(m.literary_remove_fact(), panel());
    expect(panel().textContent).not.toContain(m.correction_stale());
    expect(staleDefinition.calls.every((call) => call.method === 'GET' || call.path === '/v1/subjects')).toBe(true);

    for (const scenario of ['denied', 'stale', 'reader-unavailable'] as const) {
      const fixture = literaryFixture(scenario);
      await show(fixture);
      await enter();
      await input(labelledInput(row(), m.correction_url()), cite);
      await click(m.catalogue_create_submit());
      const message =
        scenario === 'denied'
          ? m.catalogue_create_denied()
          : scenario === 'stale'
            ? m.catalogue_create_conflict()
            : m.catalogue_create_reader_unavailable();
      await until(() => host.textContent!.includes(message));
      expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      if (scenario !== 'reader-unavailable') {
        expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
        expect(labelledInput(row(), m.correction_url()).value).toBe(cite);
        expect(panel().disabled).toBe(scenario === 'stale');
      } else {
        expect(host.querySelector('form')).toBeNull();
        expect(host.querySelector(`a[href*="${literaryWorkId}"]`)).toBeNull();
        const before = fixture.calls.length;
        await click(m.catalogue_create_retry());
        await until(() => !button(host, m.catalogue_create_retry()).disabled);
        expect(fixture.calls.slice(before).map(({ method, path }) => [method, path])).toEqual([
          ['GET', `/v1/subjects/${literaryWorkId}`],
        ]);
      }
    }

    const signedOut = literaryFixture();
    await show(signedOut, 'signed-out');
    expect(host.textContent).toContain(m.catalogue_create_signed_out());
    expect(button(host, m.catalogue_create_submit()).disabled).toBe(true);
    expect(signedOut.calls).toHaveLength(2);
    for (const [scenario, message] of [
      ['empty', m.catalogue_create_empty()],
      ['metadata-unavailable', m.correction_unavailable()],
      ['loading', m.candidate_loading()],
    ] as const) {
      const fixture = literaryFixture(scenario);
      await render(null);
      await render(h(LiteraryProfile, props(fixture)));
      await until(() => host.textContent!.includes(message));
      expect(host.querySelector('form')).toBeNull();
      expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
    }

    // Supplied release growth, not fake backend proof: 64 initial rows are forbidden by the 12-row cap.
    // Unreferenced metadata may grow 1/8/64; rendering does not enumerate that property population or read it.
    for (const size of [1, 8, 64]) {
      const fixture = literaryFixture();
      const load = fixture.transport.load;
      let traversals = 0;
      let unrelatedReads = 0;
      fixture.transport.load = async () => {
        const read = await load();
        if (!read.ok) return read;
        const properties = { ...read.release.properties };
        for (let index = 0; index < size; index++)
          properties[`unused:${index}`] = { ...properties['schema:wordCount']!, labels: { en: `Unrelated ${index}` } };
        return {
          ...read,
          release: {
            ...read.release,
            properties: new Proxy(properties, {
              ownKeys(target) {
                traversals++;
                return Reflect.ownKeys(target);
              },
              get(target, key, receiver) {
                if (String(key).startsWith('unused:')) unrelatedReads++;
                return Reflect.get(target, key, receiver);
              },
            }),
          },
        };
      };
      await show(fixture);
      await change(type(), 'schema:Book');
      await add('schema:wordCount');
      expect(panel().querySelectorAll('h3')).toHaveLength(1);
      expect(traversals).toBe(0);
      expect(unrelatedReads).toBe(0);
      expect(fixture.calls).toHaveLength(2);
    }

    // A retired mount cannot reuse its saved submit handler; late completion cannot publish a new reader's result.
    const retiring = literaryFixture();
    let release!: (value: Awaited<ReturnType<typeof retiring.transport.submit>>) => void;
    let writes = 0;
    retiring.transport.submit = async () => {
      writes++;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const observed = (subject: string) => ({
      state: 'signed-in' as const,
      subject,
      csrfToken: subject,
      handle: 'reader',
    });
    const reader = async (subject: string) =>
      render(
        h(CandidateReaderBoundary, {
          observed: observed(subject),
          address: '/catalogue/literary',
          children: h(LiteraryProfile, props(retiring)),
        }),
      );
    await render(null);
    await reader('00000000-0000-4000-8000-000000000001');
    await until(() => !!type());
    await enter();
    const saved = queuedSubmit(host.querySelector('form')!);
    await click(m.catalogue_create_submit());
    await until(() => writes === 1);
    await reader('00000000-0000-4000-8000-000000000002');
    await until(() => !!type());
    await act(async () => {
      release({
        ok: true,
        id: literaryWorkId,
        reader: { state: 'ready', href: `/en/subjects/${literaryWorkId}/old-reader` },
      });
    });
    await act(async () => {
      await saved({ preventDefault() {} });
    });
    expect(writes).toBe(1);
    expect(host.querySelector(`a[href*="${literaryWorkId}"]`)).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[id="create-label-0"]')!.value).toBe('');
  });
});

test('Literary current refusal withdraws all old markup, fences pending work and recovers the same sealed draft', async () => {
  await mounted(async ({ host, client, render, click, input, until }) => {
    const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
    const { literaryFixture, literaryWorkId, literaryCandidateId } =
      await import('../src/kernel/fake/catalogue-literary-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = literaryFixture('ready', 'en', 'schema:Book', true);
    const initial = await fixture.transport.load();
    if (!initial.ok || !initial.current) throw new Error('Expected current reading');
    let reading: LiteraryRead = initial;
    let unavailable = false;
    let settleWrite!: (value: { ok: true; candidate: string; revision: number }) => void;
    let settleRead!: (value: Awaited<ReturnType<typeof fixture.facts.read>>) => void;
    const commands: Parameters<typeof fixture.facts.propose>[0][] = [];
    const props = {
      id: literaryWorkId,
      locale: 'en',
      session: 'signed-in' as const,
      transport: {
        ...fixture.transport,
        load: async () => {
          if (unavailable) throw new Error('Current read unavailable');
          return reading;
        },
      },
      facts: {
        read: () =>
          new Promise<Awaited<ReturnType<typeof fixture.facts.read>>>((resolve) => {
            settleRead = resolve;
          }),
        propose: async (command: Parameters<typeof fixture.facts.propose>[0]) => {
          commands.push(structuredClone(command));
          return commands.length === 1
            ? new Promise<{ ok: true; candidate: string; revision: number }>((resolve) => {
                settleWrite = resolve;
              })
            : fixture.facts.propose(command);
        },
      },
      review: fixture.review,
    };
    const reload = async () => {
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['literary-profile'] });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const withheld = () => {
      for (const secret of [
        literaryWorkId,
        'An original literary work',
        '原語の作品名',
        '別名',
        'https://example.org/bibliography',
      ])
        expect(host.innerHTML).not.toContain(secret);
      expect(host.querySelector('form, input, a[href*="/subjects/"]')).toBeNull();
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    };
    const fresh = (name: string) => {
      const next = structuredClone(initial);
      next.current!.public.subject.labels = { en: name };
      next.current!.public.subject.aliases = {};
      next.current!.public.subject.descriptions = {};
      return next;
    };
    await render(h(LiteraryProfile, props));
    await until(() => !!host.querySelector('form'));
    const field = host.querySelector<HTMLElement>('section[aria-label="word count"]')!;
    await click(m.facts_edit_field(), field);
    await input(labelledInput(field, m.correction_amount()), '+13000');
    const savedSubmit = queuedSubmit(host.querySelector('form')!);
    await click(m.facts_submit());
    await until(() => commands.length === 1);
    reading = { ok: false, reason: 'denied' };
    await reload();
    withheld();
    await act(async () => {
      settleWrite({ ok: true, candidate: literaryCandidateId, revision: 2 });
      await savedSubmit({ preventDefault() {} });
    });
    withheld();
    expect(commands).toHaveLength(1);
    reading = fresh('Recovered literary identity');
    await reload();
    await until(() => host.textContent!.includes('Recovered literary identity'));
    expect(labelledInput(host, m.correction_amount()).value).toBe('+13000');
    expect(host.textContent).toContain(m.facts_uncertain());
    expect(host.innerHTML).not.toContain(literaryCandidateId);
    await act(async () => {
      await savedSubmit({ preventDefault() {} });
    });
    expect(commands).toHaveLength(1);
    await click(m.facts_submit());
    await until(() => commands.length === 2);
    expect(commands[1]).toEqual(commands[0]);
    await until(() => host.textContent!.includes(m.correction_proposed()));
    // An older inner reload must not replace the fresh outer reader, even after recovery.
    await click(m.correction_reload());
    await until(() => !!settleRead);
    unavailable = true;
    await reload();
    withheld();
    unavailable = false;
    reading = fresh('Latest admitted identity');
    await reload();
    await until(() => host.textContent!.includes('Latest admitted identity'));
    await act(async () => {
      settleRead(initial.current!);
    });
    expect(host.textContent).toContain('Latest admitted identity');
    expect(host.textContent).not.toContain('An original literary work');
    const mismatched = fresh('Unrelated identity');
    mismatched.current!.public.subject.id = literaryCandidateId;
    reading = mismatched;
    await reload();
    withheld();
    expect(host.innerHTML).not.toContain('Unrelated identity');
    reading = fresh('Final recovered identity');
    await reload();
    await until(() => host.textContent!.includes('Final recovered identity'));
    await click(m.correction_reload());
    await act(async () => {
      settleRead({ ok: false, reason: 'denied' });
    });
    await until(() => !host.querySelector('a[href*="/subjects/"]'));
    withheld();
    await reload();
    await until(() => host.textContent!.includes('Final recovered identity'));
    await render(h(LiteraryProfile, { ...props, session: 'signed-out' }));
    expect(host.querySelector('form')).toBeNull();
    await act(async () => {
      await savedSubmit({ preventDefault() {} });
    });
    expect(commands).toHaveLength(2);
  });
});
