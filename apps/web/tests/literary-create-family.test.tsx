import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, useState, type ComponentProps, type ReactNode } from 'react';
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

function factRow(scope: ParentNode) {
  return [...scope.querySelectorAll<HTMLElement>('section[id^="literary-fact-"][aria-label]')];
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
  const source =
    [...form.querySelectorAll('button, input, select, textarea')].find((node) =>
      Object.keys(node).some((entry) => entry.startsWith('__reactProps$')),
    ) ?? form;
  const key = Object.keys(source).find((entry) => entry.startsWith('__reactProps$'))!;
  return Reflect.get(form, key).onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
}

test('Literary keyboard Add reaches the exact repeated row and cancels retired focus intent', async () => {
  await mounted(async ({ host, render, change, input }) => {
    const { InitialFacts } = await import('../src/features/catalogue/literary-profile-view');
    const { catalogueEditor } = await import('../src/features/catalogue/editor-lifetime');
    const { literaryRelease } = await import('../src/kernel/fake/catalogue-literary-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const Lifetime = catalogueEditor(function LiteraryFactLifetime({ children }: { children: ReactNode }) {
      return children;
    });
    type Row = ComponentProps<typeof InitialFacts>['rows'][number];
    let rows: Row[] = [],
      mode = '',
      disabled = false;
    function Draft() {
      const [, update] = useState(0);
      return h(
        Lifetime,
        {},
        h(
          'form',
          {},
          h('input', { 'aria-label': 'Terms', defaultValue: 'Private title' }),
          h(InitialFacts, {
            type: 'schema:Book',
            read: { ok: true, release: literaryRelease, current: null },
            locale: 'en',
            disabled,
            rows,
            change: (next) => {
              rows = mode === 'replace' ? structuredClone(next) : next;
              if (mode === 'move') host.querySelector<HTMLInputElement>('[aria-label="Terms"]')!.focus();
              if (mode === 'retire') disabled = true;
              update((value) => value + 1);
            },
          }),
        ),
      );
    }
    await render(h(Draft));
    const panel = initialPanel(host, m.literary_bibliography());
    const add = async (detail = 0) => {
      await change(propertyControl(panel), 'schema:inLanguage');
      const trigger = [...panel.querySelectorAll<HTMLButtonElement>('button')]
        .filter((candidate) => candidate.textContent?.trim() === m.correction_add())
        .at(-1)!;
      expect(trigger.disabled).toBe(false);
      trigger.focus();
      await act(async () =>
        trigger.dispatchEvent(new host.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true, detail })),
      );
      return trigger;
    };
    const target = (row: Row) => host.querySelector(`#literary-fact-${row.id}-fact-state`);
    await add();
    const first = rows[0]!,
      firstControl = target(first);
    expect(host.ownerDocument.activeElement).toBe(firstControl);
    await input(host.querySelector<HTMLInputElement>(`#literary-fact-${first.id}-fact-value`)!, 'ja');
    await add();
    expect(host.ownerDocument.activeElement).toBe(target(rows[1]!));
    expect(target(first)).toBe(firstControl);
    expect(rows[0]!.statement.value).toEqual({ type: 'value', content: 'ja' });
    for (mode of ['pointer', 'move', 'replace', 'retire']) {
      await add(mode === 'pointer' ? 1 : 0);
      expect(host.ownerDocument.activeElement).not.toBe(target(rows.at(-1)!));
      if (mode === 'move') expect(host.ownerDocument.activeElement).toBe(host.querySelector('[aria-label="Terms"]'));
    }
    disabled = false;
    await render(h(Draft));
    expect(host.ownerDocument.activeElement).not.toBe(target(rows.at(-1)!));
    expect(host.querySelector<HTMLInputElement>('[aria-label="Terms"]')!.value).toBe('Private title');
  });
});

test('Literary native corrections name only current scalar and citation controls across sibling removal', async () => {
  await mounted(async ({ host, client, render, click, change, input, until }) => {
    const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
    const { literaryFixture, literaryRelease } = await import('../src/kernel/fake/catalogue-literary-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = literaryFixture();
    const release = structuredClone(literaryRelease);
    const escaped = 'example:/language~name';
    release.properties[escaped] = { ...release.properties['schema:inLanguage']!, labels: { en: 'Escaped language' } };
    release.types['schema:Book']!.properties.push(escaped);
    fixture.transport.load = async () => ({ ok: true, release, current: null });
    const prefix = '/statements/schema:inLanguage';
    const supported = [
      `${prefix}/1/value/content`,
      `${prefix}/1/references/0/parts/0/value/content`,
      '/statements/schema:wordCount/0/value/content/amount',
      '/statements/schema:wordCount/0/value/content/unit',
      '/statements/schema:datePublished/0/value/content/time',
      '/statements/schema:datePublished/0/value/content/precision',
      '/statements/example:~1language~0name/0/value/content',
      `${prefix}/0/value/type`,
    ];
    const unsupported = [
      ...['', '/', '/-1', '/01', '/+0', '/1.0', '/1e0', '/ 0', '/2', '/9007199254740993'].map(
        (index) => `${prefix}${index}/value/content`,
      ),
      `${prefix}/0/value/content/unknown`,
      `${prefix}/0/value~1content`,
      `${prefix}/0/qualifiers/0/value/content`,
      `${prefix}/1/references/1/parts/0/value/content`,
      `${prefix}/1/references/0/parts/01/value/content`,
      '/statements/bad~2escape/0/value/content',
      '/statements/unknown/0/value/content',
      '/unknown',
      '/statements/schema:wordCount/0/value/content/lowerBound',
      '/statements/schema:datePublished/0/value/content/calendarmodel',
    ];
    const errors = [...supported, ...unsupported].map((pointer) => ({ pointer, code: 'invalid_format' as const }));
    let original: unknown;
    fixture.transport.submit = async (command) => {
      original = structuredClone(command);
      return { ok: false, reason: 'invalid', errors };
    };
    await render(h(LiteraryProfile, { locale: 'en', session: 'signed-in', ...fixture }));
    await until(() => !!host.querySelector('#create-type'));
    await change(host.querySelector<HTMLSelectElement>('#create-type')!, 'schema:Book');
    await input(host.querySelector<HTMLInputElement>('#create-label-0')!, 'Private title');
    const panel = initialPanel(host, m.literary_bibliography());
    const add = async (property: string) => {
      await change(propertyControl(panel), property);
      await click(m.correction_add(), panel);
      return factRow(panel).at(-1)!;
    };
    const first = await add('schema:inLanguage');
    await input(labelledInput(first, m.correction_value()), 'en');
    const second = await add('schema:inLanguage');
    await input(labelledInput(second, m.correction_value()), 'ja');
    await input(labelledInput(second, m.correction_url()), 'https://example.org/source');
    const quantity = await add('schema:wordCount');
    await input(labelledInput(quantity, m.correction_amount()), '+12');
    await change(quantity.querySelector<HTMLSelectElement>('select[id$="-unit"]')!, '1');
    const time = await add('schema:datePublished');
    await change(time.querySelector<HTMLSelectElement>('select[id$="-precision"]')!, '9');
    await input(labelledInput(time, m.correction_year()), '2024');
    const escapedRow = await add(escaped);
    await input(labelledInput(escapedRow, m.correction_value()), 'fr');
    const targets = [
      `${second.id}-fact-value`,
      `${second.id}-part-1-value`,
      `${quantity.id}-fact-amount`,
      `${quantity.id}-fact-unit`,
      `${time.id}-fact-year`,
      `${time.id}-fact-precision`,
      `${escapedRow.id}-fact-value`,
      `${first.id}-fact-state`,
    ];
    await click(m.catalogue_create_submit());
    if (host.querySelector('[data-literary-create-review]')) await click(m.catalogue_create_submit());
    await until(() => !!host.querySelector('[role="alert"] code'));
    const links = () => [...host.querySelectorAll<HTMLAnchorElement>('[role="alert"] a[href^="#"]')];
    expect(links().map((link) => decodeURIComponent(link.hash.slice(1)))).toEqual(targets);
    for (const [index, link] of links().entries()) {
      await act(async () => link.click());
      expect(host.ownerDocument.activeElement?.id).toBe(targets[index]!);
    }
    expect([...host.querySelectorAll('[role="alert"] dd code')].map((node) => node.textContent)).toEqual(
      errors.flatMap(({ pointer, code }) => [pointer, code]),
    );
    expect(original).toMatchObject({
      item: {
        labels: { en: 'Private title' },
        statements: {
          'schema:inLanguage': [
            { value: { type: 'value', content: 'en' }, references: [] },
            {
              value: { type: 'value', content: 'ja' },
              references: [
                {
                  parts: [
                    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    await click(m.literary_remove_fact(), first);
    await click(m.literary_remove_fact(), first);
    expect(links().map((link) => decodeURIComponent(link.hash.slice(1)))).toEqual(targets.slice(0, -1));
    await act(async () => links()[0]!.click());
    expect(host.ownerDocument.activeElement?.id).toBe(targets[0]!);
    delete release.properties['schema:datePublished'];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['literary-profile'] });
    });
    expect(second.querySelector<HTMLInputElement>('input')!.value).toBe('ja');
  });
});

function queuedInput(input: HTMLInputElement) {
  const key = Object.keys(input).find((key) => key.startsWith('__reactProps$'))!;
  const change = Reflect.get(input, key).onChange;
  return (value: string) => change({ target: { value } });
}

test('mounted Literary creation keeps the complete initial bibliography family and native command journey', async () => {
  await mounted(async ({ host, client, render, click, change, input, until }) => {
    const { LiteraryProfile } = await import('../src/features/catalogue/literary-profile-view');
    const { literaryFixture, literaryWorkId, literaryRelease } =
      await import('../src/kernel/fake/catalogue-literary-profile');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const panel = (scope: ParentNode = host) => initialPanel(scope, m.literary_bibliography());
    const row = (scope: ParentNode = host) => factRow(scope)[0]!;
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
    const confirm = async (scope: HTMLElement = host) => {
      await click(m.catalogue_create_submit(), scope);
      if (scope.querySelector('[data-literary-create-review]')) await click(m.catalogue_create_submit(), scope);
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
    expect(factRow(mounts[0]!)).toHaveLength(1);
    expect(factRow(mounts[1]!)).toHaveLength(0);
    expect(left.calls).toHaveLength(2);
    expect(right.calls).toHaveLength(2);

    // A nested scalar emission edits only its current part against the latest sibling drafts.
    await show(literaryFixture());
    await enter();
    const amount = () => labelledInput(row(), m.correction_amount());
    const citation = () => labelledInput(row(), m.correction_url());
    const savedAmount = queuedInput(amount()),
      savedCitation = queuedInput(citation());
    await add('schema:inLanguage');
    const sibling = factRow(panel())[1]!;
    await input(labelledInput(sibling, m.correction_value()), 'ja');
    await act(async () => {
      savedAmount('+15000');
      savedCitation(cite);
    });
    expect(amount().value).toBe('+15000');
    expect(citation().value).toBe(cite);
    await input(citation(), '');
    await act(async () => savedCitation('https://stale.test'));
    expect(citation().value).toBe('');
    expect(labelledInput(sibling, m.correction_value()).value).toBe('ja');
    await act(async () => savedAmount('+99999'));
    expect(amount().value).toBe('+15000');
    const removedAmount = queuedInput(amount()),
      removedCitation = queuedInput(citation());
    await click(m.literary_remove_fact(), row());
    await click(m.literary_remove_fact(), row());
    await add('schema:wordCount');
    const replacement = () => panel().querySelectorAll<HTMLElement>('section')[1]!;
    await act(async () => {
      removedAmount('+99999');
      removedCitation('https://stale.test');
    });
    expect(labelledInput(replacement(), m.correction_amount()).value).toBe('');
    expect(labelledInput(sibling, m.correction_value()).value).toBe('ja');
    const oldType = queuedInput(labelledInput(replacement(), m.correction_amount()));
    await change(type(), 'schema:BookSeries');
    await change(type(), 'schema:Book');
    await act(async () => oldType('+99999'));
    expect(labelledInput(replacement(), m.correction_amount()).value).toBe('');
    await input(labelledInput(replacement(), m.correction_amount()), '+16000');
    expect(labelledInput(replacement(), m.correction_amount()).value).toBe('+16000');

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
    const lockedAmount = queuedInput(labelledInput(fact, m.correction_amount()));
    const lockedCitation = queuedInput(labelledInput(fact, m.correction_url()));
    await click(m.literary_remove_fact(), fact);
    await confirm();
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
        lockedAmount('+99999');
        lockedCitation('https://stale.test');
      });
      expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
      expect(labelledInput(row(), m.correction_url()).value).toBe(cite);
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
    await confirm();
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

    // A property-level native diagnostic has no editable address; metadata recovery retains every draft.
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
    await confirm();
    await until(() => !!host.querySelector('[role="alert"] code'));
    expect(host.querySelector('[role="alert"] a[href^="#literary-fact-"]')).toBeNull();
    expect(host.querySelector('[role="alert"] code')!.textContent).toBe('/statements/schema:wordCount');
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
    const retiredAmount = queuedInput(labelledInput(row(), m.correction_amount()));
    const retiredCitation = queuedInput(labelledInput(row(), m.correction_url()));
    metadata = 'failed';
    await act(async () => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'literary-profile' });
    });
    await act(async () => {
      retiredAmount('+99999');
      retiredCitation('https://stale.test');
    });
    expect(row().id).toBe(retainedId);
    expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
    metadata = 'removed';
    await act(async () => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'literary-profile' });
    });
    await until(() => host.textContent!.includes(m.correction_stale()));
    await act(async () => {
      retiredAmount('+99999');
      retiredCitation('https://stale.test');
    });
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
      await confirm();
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
      expect(factRow(panel())).toHaveLength(1);
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
    await click(m.catalogue_create_submit());
    await until(() => !!host.querySelector('[data-literary-create-review]'));
    const saved = queuedSubmit(host.querySelector('form')!);
    const pendingAmount = queuedInput(labelledInput(row(), m.correction_amount()));
    const pendingCitation = queuedInput(labelledInput(row(), m.correction_url()));
    await act(async () => {
      void saved({ preventDefault() {} });
      pendingAmount('+99999');
      pendingCitation('https://stale.test');
    });
    await until(() => writes === 1);
    await act(async () => {
      pendingAmount('+99999');
      pendingCitation('https://stale.test');
    });
    expect(labelledInput(row(), m.correction_amount()).value).toBe('+12000');
    await reader('00000000-0000-4000-8000-000000000002');
    await until(() => !!type());
    await act(async () => {
      pendingAmount('+99999');
      pendingCitation('https://stale.test');
    });
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
