import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ComponentProps, type ReactNode } from 'react';
import type { SourceFact, SourcesPageData } from '../src/features/catalogue/subject-sources';

mock.module('cloudflare:workers', () => ({ env: {} }));

// UNRUN under MINIMAL. DOM/focus assertions are neither browser geometry nor native acceptance.
async function mounted(
  run: (readers: { hosts: HTMLElement[]; render: (index: number, node: ReactNode) => Promise<void> }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
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
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  }
  const { createRoot } = await import('react-dom/client');
  const { ConnectedStory } = await import('../src/stories/connected-story');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const hosts = [0, 1].map(() => {
    const host = window.document.createElement('main') as HTMLElement;
    window.document.body.append(host);
    return host;
  });
  const roots = hosts.map((host) => createRoot(host));
  try {
    await run({
      hosts,
      render: async (index, node) => {
        await act(async () =>
          roots[index]!.render(h(ConnectedStory, { storyId: `subject-sources-detail-${index}` }, node)),
        );
      },
    });
  } finally {
    await act(async () => {
      for (const root of roots) root.unmount();
    });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const arabic = 'المؤلف ومعلومات الطبعة الأصلية والمراجع المرتبطة بالرحلة الطويلة عبر المكتبات والأرشيفات';
const japanese = '旅人の物語 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
const french = 'Édition originale conservée et vérifiée par les bibliothécaires, les traducteurs et les lecteurs';
const editionUrl = 'https://catalogue.example.test/editions/original';
const archiveUrl = 'https://archive.example.test/catalogue/second-citation-with-a-long-original-record-address';
const target = '00000000-0000-8000-8000-000000000042';

function rich(page: SourcesPageData): SourcesPageData {
  const url = (text: string, content: string) => ({
    label: { text, lang: 'fr' },
    snak: { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content } },
  });
  const first: SourceFact = {
    snak: { property: { id: 'schema:author', data_type: 'wikibase-item' }, value: { type: 'value', content: target } },
    qualifiers: [
      {
        label: { text: 'Édition', lang: 'fr' },
        snak: {
          property: { id: 'schema:name', data_type: 'monolingualtext' },
          value: { type: 'value', content: { language: 'fr', text: french } },
        },
      },
      url('Notice de l’édition', editionUrl),
    ],
    citations: [
      [
        url('Catalogue', editionUrl),
        {
          label: { text: 'Note', lang: 'fr' },
          snak: {
            property: { id: 'schema:name', data_type: 'monolingualtext' },
            value: { type: 'value', content: { language: 'ar', text: arabic } },
          },
        },
      ],
      [url('Archive', archiveUrl)],
      [url('Catalogue', editionUrl)],
    ],
  };
  return {
    ...page,
    realm: '00000000-0000-8000-8000-000000000043',
    related: { ...page.related, [target]: { labels: { ja: japanese } } },
    fields: [
      ...page.fields,
      {
        property: 'schema:author',
        label: { text: arabic, lang: 'ar' },
        facts: [
          first,
          {
            snak: {
              property: { id: 'schema:name', data_type: 'monolingualtext' },
              value: { type: 'value', content: { text: french, language: 'fr' } },
            },
            qualifiers: [],
            citations: [],
          },
          ...(['somevalue', 'novalue'] as const).map((type) => ({
            snak: { property: { id: 'schema:name', data_type: 'monolingualtext' }, value: { type } },
            qualifiers: [],
            citations: [],
          })),
          ...(['document', 'media'] as const).map((display) => ({
            snak: {
              property: { id: display === 'document' ? 'schema:abstract' : 'schema:image', data_type: display },
              value: { type: 'somevalue' },
            },
            display,
            qualifiers: [],
            citations: [],
          })),
        ],
      },
      {
        property: 'schema:alternateName',
        label: { text: '', lang: undefined },
        facts: [
          {
            snak: {
              property: { id: 'schema:alternateName', data_type: 'monolingualtext' },
              value: { type: 'somevalue' },
            },
            qualifiers: [],
            citations: [],
          },
        ],
      },
    ],
    sources: { ...page.sources, records: [...page.sources.records, ...page.sources.records] },
  };
}

function ownHeadings(host: HTMLElement, page: SourcesPageData, selectedName: string, fallback: string) {
  const selected = [...host.querySelectorAll('h2')].find((node) => node.textContent === selectedName)!;
  expect(selected).toBeDefined();
  expect(selected.id).not.toBe('');
  const section = selected.closest('section')!;
  expect(section.getAttribute('aria-labelledby')).toBe(selected.id);
  expect(host.ownerDocument.getElementById(selected.id)).toBe(selected);
  const groups = [...section.querySelectorAll('[data-slot="source-property"]')];
  expect(groups).toHaveLength(page.fields.length);
  const ids = [selected.id];
  for (const [index, group] of groups.entries()) {
    const heading = group.querySelector('h3')!;
    expect(heading.textContent).toBe(page.fields[index]!.label.text || fallback);
    expect(heading.getAttribute('lang')).toBe(page.fields[index]!.label.lang ?? null);
    expect(heading.getAttribute('data-content-item-slot')).toBe('title');
    expect(group.closest('section')?.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(host.ownerDocument.getElementById(heading.id)).toBe(heading);
    expect(group.querySelector('ul')?.parentElement).toBe(group);
    expect(group.querySelectorAll('[data-slot="source-statement"]')).toHaveLength(page.fields[index]!.facts.length);
    ids.push(heading.id);
  }
  return ids;
}

test('independent detailed roots own their selected/property headings, localized facts and ordered evidence through state changes', async () => {
  await mounted(async ({ hosts, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { explainSubjectSources } = await import('../src/features/catalogue/subject-sources');
    const { catalogueSourcesFixture, sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
    const { contextHref } = await import('../src/features/pages/context-navigation');
    const { subjectHref } = await import('../src/subject/subject-href');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = catalogueSourcesFixture();
    const left = hosts[0]!;
    const right = hosts[1]!;
    // 390/1280 are intent only here. Actual geometry is authored in the connected story and remains UNRUN.
    left.style.width = '390px';
    left.dir = 'rtl';
    right.style.width = '1280px';
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      const o = { locale: locale as never };
      const page = rich(explainSubjectSources(fixture.read, locale, sourceDefinitions));
      const before = structuredClone(page);
      const show = (index: number, result: ComponentProps<typeof SubjectSourcesPage>['result']) =>
        render(index, h(SubjectSourcesPage, { result, locale }));
      await show(0, { kind: 'loading' });
      await show(1, { kind: 'ready', page });
      const rightIds = ownHeadings(right, page, m.sources_selected({}, o), m.subject_value_unlabelled({}, o));
      await show(0, { kind: 'ready', page });
      const leftIds = ownHeadings(left, page, m.sources_selected({}, o), m.subject_value_unlabelled({}, o));
      expect(new Set([...leftIds, ...rightIds]).size).toBe(leftIds.length + rightIds.length);
      const rows = [...left.querySelectorAll('[data-slot="source-statement"]')];
      expect(rows.map((row) => row.querySelector('h4')?.textContent).slice(1)).toEqual([
        '9780156012195',
        japanese,
        french,
        m.subject_value_unknown({}, o),
        m.subject_value_none({}, o),
        m.sources_authored({}, o),
        m.sources_media({}, o),
        m.subject_value_unknown({}, o),
      ]);
      const row = rows[2]!;
      expect(row.parentElement?.tagName).toBe('LI');
      expect(row.parentElement?.parentElement?.tagName).toBe('UL');
      expect(row.querySelector('[data-slot="source-statement"]')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="metadata"]')?.textContent).toContain(french);
      expect(row.querySelector('[data-content-item-slot="metadata"] [lang="fr"]')?.textContent).toContain('Édition');
      const citations = [...row.querySelectorAll('ol > li')];
      expect(citations.map((node) => node.querySelector('a')?.getAttribute('href'))).toEqual([
        editionUrl,
        archiveUrl,
        editionUrl,
      ]);
      expect(citations[0]?.querySelector('[lang="ar"]')?.textContent).toBe(arabic);
      expect(row.querySelector('h4 a')?.getAttribute('lang')).toBe(locale === 'ja' ? null : 'ja');
      const destination = contextHref(subjectHref({ id: target, label: japanese }, locale).href, page.realm);
      expect([...row.querySelectorAll('a')].map((node) => node.getAttribute('href'))).toEqual([
        destination,
        editionUrl,
        editionUrl,
        archiveUrl,
        editionUrl,
      ]);
      expect(left.querySelector('a a, a button, [data-slot="list-row-link"]')).toBeNull();
      for (const link of left.querySelectorAll<HTMLAnchorElement>('a')) {
        link.focus();
        expect(left.ownerDocument.activeElement).toBe(link);
      }
      expect(rows[3]?.textContent).toContain(m.sources_no_citations({}, o));
      expect(
        [...left.querySelectorAll('a')]
          .find((node) => node.textContent === m.sources_compare({}, o))
          ?.getAttribute('href'),
      ).toBe(page.fields[0]!.compareHref!);
      expect(left.querySelector('nav a')?.getAttribute('href')).toBe(page.href);
      expect(left.textContent).toContain(m.sources_rights_scope({}, o));
      expect(left.textContent).toContain('Bibliography contributors');
      expect(left.textContent).toContain('REZICS fixtures');
      expect(left.querySelectorAll('a[href="https://creativecommons.org/publicdomain/zero/1.0/"]')).toHaveLength(2);
      expect(left.querySelector('a[href="https://rezics.com"]')?.textContent).toBe('Generated fixture');
      const attribution = left.querySelector('[data-slot="subject-sources"]')!;
      expect(row.compareDocumentPosition(attribution) & 4).not.toBe(0);
      expect([...attribution.querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
        'Reviewed bibliography',
        'Reviewed bibliography',
      ]);
      expect(left.querySelector('img')).toBeNull();
      expect(page).toEqual(before);
      await show(0, { kind: 'denied' });
      expect(left.querySelector('[data-slot="source-statement"]')).toBeNull();
      expect(left.textContent).not.toContain(japanese);
      expect(ownHeadings(right, page, m.sources_selected({}, o), m.subject_value_unlabelled({}, o))).toEqual(rightIds);
      await show(0, { kind: 'ready', page });
      expect(ownHeadings(left, page, m.sources_selected({}, o), m.subject_value_unlabelled({}, o))).toEqual(leftIds);
    }
    expect(fixture.calls).toHaveLength(0);
  });
});

test('all actual nonready branches keep independent retry arguments and busy eligibility', async () => {
  await mounted(async ({ hosts, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { m } = await import('../src/paraglide/messages.js');
    const retries = [0, 0];
    for (const [kind, text] of [
      ['loading', m.sources_loading()],
      ['missing', m.not_found_message()],
      ['denied', m.sources_denied()],
      ['invalid', m.sources_invalid()],
      ['conflict', m.sources_conflict()],
      ['unavailable', m.sources_unavailable()],
    ] as const) {
      for (const index of [0, 1])
        await render(
          index,
          h(SubjectSourcesPage, {
            result: { kind },
            locale: 'en',
            onRetry: () => {
              retries[index]!++;
            },
          }),
        );
      for (const host of hosts) {
        expect(host.querySelector(kind === 'loading' ? '[role="status"]' : '[role="alert"]')?.textContent).toBe(text);
        expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe(String(kind === 'loading'));
        expect(host.querySelector('h4, [data-slot="source-property"]')).toBeNull();
        expect(host.querySelector('button') === null).toBe(kind === 'loading' || kind === 'missing');
      }
      if (kind === 'loading' || kind === 'missing') continue;
      const before = [...retries];
      const button = hosts[0]!.querySelector('button')!;
      button.focus();
      expect(hosts[0]!.ownerDocument.activeElement).toBe(button);
      await act(async () => button.click());
      expect(retries).toEqual([before[0]! + 1, before[1]]);
      await render(
        1,
        h(SubjectSourcesPage, {
          result: { kind },
          locale: 'en',
          busy: true,
          onRetry: () => {
            retries[1]!++;
          },
        }),
      );
      const disabled = hosts[1]!.querySelector('button')!;
      expect(disabled.disabled).toBe(true);
      await act(async () => disabled.click());
      expect(retries[1]).toBe(before[1]!);
    }
    await render(0, h(SubjectSourcesPage, { result: { kind: 'unavailable' }, locale: 'en' }));
    expect(hosts[0]!.querySelector('button')).toBeNull();
  });
});

test('recorded no-citations, empty and partial rights remain distinct and never infer cover rights from catalogue support', async () => {
  await mounted(async ({ hosts, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { explainSubjectSources } = await import('../src/features/catalogue/subject-sources');
    const { catalogueSourcesFixture, sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
    const { m } = await import('../src/paraglide/messages.js');
    for (const scenario of ['no-citations', 'partial-metadata', 'empty'] as const) {
      const fixture = catalogueSourcesFixture(scenario);
      fixture.read.summary = null;
      const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
      await render(0, h(SubjectSourcesPage, { result: { kind: 'ready', page }, locale: 'en' }));
      const host = hosts[0]!;
      expect(host.textContent).toContain(m.sources_cover_unknown());
      expect(host.textContent).not.toContain('CC0-1.0');
      expect(host.textContent).not.toContain('REZICS fixtures');
      if (scenario === 'empty') {
        expect(host.textContent).toContain(m.sources_empty());
        expect(host.querySelector('h4')).toBeNull();
      } else expect(host.textContent).toContain('9780156012195');
      if (scenario === 'partial-metadata') {
        expect(host.textContent).toContain(m.sources_licence_unknown());
        expect(host.textContent).toContain(m.sources_attribution_unknown());
        expect(host.querySelector('[data-slot="subject-sources"] h3')?.textContent).toBe('Reviewed bibliography');
        expect(host.textContent).not.toContain(m.sources_metadata_unavailable());
      } else expect(host.textContent).toContain(m.sources_metadata_unavailable());
      if (scenario === 'no-citations') expect(host.textContent).toContain(m.sources_no_citations());
      expect(fixture.calls).toHaveLength(0);
    }
  });
});

test('supplied fact growth at 1/8/32 keeps exact order with one existing read and zero rendering requests', async () => {
  await mounted(async ({ hosts, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { readSubjectSources } = await import('../src/features/catalogue/subject-sources');
    const { catalogueSourcesFixture, sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
    for (const count of [1, 8, 32]) {
      const fixture = catalogueSourcesFixture();
      const original = fixture.read.subject.statements['schema:isbn']![0]!;
      // The released alternate-name property is multivalued monolingual text; 32 is below the native 512-fact cap.
      const names = Array.from({ length: count }, (_, index) => `Édition originale — ${index + 1}`);
      fixture.read.subject.statements = {
        'schema:alternateName': names.map((text) => ({
          ...original,
          id: crypto.randomUUID(),
          property: { id: 'schema:alternateName', data_type: 'monolingualtext' },
          value: { type: 'value', content: { text, language: 'fr' } },
        })),
      };
      const result = await readSubjectSources(fixture.client, fixture.id, 'en', sourceDefinitions);
      if (result.kind !== 'ready') throw new Error('Expected the canonical selected facts');
      const { page } = result;
      const before = structuredClone(page);
      await render(0, h(SubjectSourcesPage, { result: { kind: 'ready', page }, locale: 'en' }));
      expect([...hosts[0]!.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(names);
      expect(hosts[0]!.querySelectorAll('[data-slot="source-property"]')).toHaveLength(1);
      expect(hosts[0]!.querySelectorAll('[data-slot="source-statement"]')).toHaveLength(count);
      expect(hosts[0]!.querySelectorAll('[data-slot="source-statement"] ol > li')).toHaveLength(count);
      expect(fixture.calls).toEqual([
        { path: `/v1/subjects/${fixture.id}`, authorization: null, session: 'sources-session' },
      ]);
      expect(page).toEqual(before);
    }
  });
});

test('independent deliberate retries reuse each canonical reader client and its current session without extra reads', async () => {
  await mounted(async ({ hosts, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { readSubjectSources } = await import('../src/features/catalogue/subject-sources');
    const { catalogueSourcesFixture, sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
    const fixtures = [catalogueSourcesFixture('unavailable'), catalogueSourcesFixture('denied')];
    const pending: Promise<void>[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const result = await readSubjectSources(fixture.client, fixture.id, 'en', sourceDefinitions);
      await render(
        index,
        h(SubjectSourcesPage, {
          result,
          locale: 'en',
          onRetry: () => {
            fixture.recover();
            pending[index] = readSubjectSources(fixture.client, fixture.id, 'en', sourceDefinitions).then(
              async (next) => {
                await render(index, h(SubjectSourcesPage, { result: next, locale: 'en' }));
              },
            );
          },
        }),
      );
    }
    for (const index of [0, 1]) {
      await act(async () => {
        hosts[index]!.querySelector('button')!.click();
        await pending[index];
      });
      expect(hosts[index]!.querySelector('h4')?.textContent).toContain('1943');
      if (index === 0) {
        expect(hosts[1]!.querySelector('[role="alert"]')).not.toBeNull();
        expect(fixtures[1]!.calls).toHaveLength(1);
      }
      const fixture = fixtures[index]!;
      expect(fixture.calls).toEqual([
        { path: `/v1/subjects/${fixture.id}`, authorization: null, session: 'sources-session' },
        { path: `/v1/subjects/${fixture.id}`, authorization: null, session: 'current-sources-session' },
      ]);
    }
    // This page owns read retries only; command keys, write uncertainty and credential retirement belong to the route/native owners.
  });
});

test('the canonical all-records selection keeps full attribution, independent licence destinations and cover rights in the detail reader', async () => {
  await mounted(async ({ hosts, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { explainSubjectSources } = await import('../src/features/catalogue/subject-sources');
    const { catalogueSourcesFixture, sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
    const { subjectSourcesPage } = await import('../src/kernel/fake/subject-sources');
    const { subjectBody } = await import('../src/features/pages/subject');
    const { m } = await import('../src/paraglide/messages.js');
    const storyGlobal = globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } };
    const previous = storyGlobal.__rezicsStoryContext;
    try {
      storyGlobal.__rezicsStoryContext = { url: '/?sourceRecords=all' };
      const fixture = catalogueSourcesFixture();
      const recorded = subjectSourcesPage({ target: { subject: fixture.id } });
      if (!recorded) throw new Error('Expected the canonical all-source-records selection');
      const read = subjectBody(recorded as unknown as import('../src/features/pages/subject').SubjectPageData);
      if (!read) throw new Error('Expected the canonical subject body');
      const page = explainSubjectSources(read, 'en', sourceDefinitions);
      const before = structuredClone(page);
      await render(0, h(SubjectSourcesPage, { result: { kind: 'ready', page }, locale: 'en' }));
      const host = hosts[0]!;
      const source = host.querySelector('[data-slot="subject-sources"]')!;
      const records = page.sources.records as {
        name: string;
        url: string;
        licence?: { id: string; url?: string };
        attribution?: string;
      }[];
      expect([...source.querySelectorAll('h3')].map((node) => node.textContent)).toEqual(
        records.map((record) => record.name),
      );
      expect(source.querySelectorAll('ul > li')).toHaveLength(7);
      for (const record of records) {
        const heading = [...source.querySelectorAll('h3')].find((node) => node.textContent === record.name)!;
        const frame = heading.parentElement!;
        expect(heading.querySelector('a')?.getAttribute('href')).toBe(record.url);
        if (record.attribution) expect(frame.textContent).toContain(record.attribution);
        if (record.licence?.url) expect(frame.querySelector('p a')?.getAttribute('href')).toBe(record.licence.url);
        if (record.licence && !record.licence.url) expect(frame.textContent).toContain(record.licence.id);
      }
      expect(source.querySelector('a[href="https://creativecommons.org/licenses/by/4.0/"]')).not.toBeNull();
      expect(source.querySelector('a[href="https://rezics.com"]')?.textContent).toBe('Generated fixture');
      expect(source.textContent).toContain('REZICS fixtures');
      expect(source.textContent).toContain('CC0-1.0');
      expect(host.textContent).toContain(m.sources_rights_scope());
      expect(host.textContent).toContain(m.sources_licence_unknown());
      expect(host.textContent).toContain(m.sources_attribution_unknown());
      expect(source.querySelector('a a, a button')).toBeNull();
      expect(page).toEqual(before);
      expect(fixture.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete storyGlobal.__rezicsStoryContext;
      else storyGlobal.__rezicsStoryContext = previous;
    }
  });
});
