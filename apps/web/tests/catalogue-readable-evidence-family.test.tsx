import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { ChangeDetail, ChangesState } from '../src/features/catalogue/subject-changes';
import type { ValueRead } from '../src/features/catalogue/value-explanation';

mock.module('cloudflare:workers', () => ({ env: {} }));

// UNRUN under MINIMAL: mounted presentation regressions, not native or visual acceptance.
async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    click: (name: string) => Promise<void>;
  }) => Promise<void>,
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
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let generation = 0;
  try {
    await run({
      host,
      render: async (node) => {
        await act(async () =>
          root.render(h(ConnectedStory, { key: ++generation, storyId: 'catalogue-readable-evidence-family' }, node)),
        );
      },
      click: async (name) => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (node) => node.textContent === name,
        );
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(false);
        await act(async () => button!.click());
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function readingText(region: Element): string {
  const copy = region.cloneNode(true) as Element;
  for (const details of copy.querySelectorAll('details')) details.remove();
  return copy.textContent ?? '';
}

test('Changes shows actual currentness, keeps limited evidence visible and preserves retry and More controls', async () => {
  await mounted(async ({ host, render, click }) => {
    const { SubjectChangesPage } = await import('../src/features/catalogue/subject-changes-page');
    const { catalogueChangesFixture } = await import('../src/kernel/fake/catalogue-changes');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = catalogueChangesFixture();
    const list = await fixture.transport.list();
    if (list.kind !== 'ready') throw new Error('Expected the supplied revision list');
    // Supplied closed presentation data, without changing the native fixture's unavailable-detail outcome.
    const detail: ChangeDetail = {
      id: fixture.id,
      revision: 5,
      summary: {
        kind: 'candidate',
        candidate: '00000000-0000-8000-8000-000000000005',
        property: 'schema:isbn',
        reading: { decision: { head: 8, verdict: 'accept', revision: 6 }, selected: true, rank: 'preferred' },
      },
    };
    const state: ChangesState = { page: list.page, selected: 5, detail: { kind: 'ready', detail } };
    let more = 0;
    let retried = 0;
    const selected: number[] = [];
    const show = (next: ChangesState, locale = 'en') =>
      render(
        h(SubjectChangesPage, {
          state: next,
          locale,
          onMore: () => more++,
          onSelect: (revision) => selected.push(revision),
          onDetailRetry: () => retried++,
        }),
      );
    const calls = fixture.calls.length;
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      const o = { locale: locale as never };
      await show(state, locale);
      const current = host.querySelector(`section[aria-label="${m.changes_current({}, o)}"]`)!;
      expect(current).not.toBeNull();
      expect(current.textContent).toContain(m.context_accepted({}, o));
      expect(current.textContent).toContain(m.context_selected({}, o));
      expect(current.textContent).toContain(m.candidate_rank_preferred({}, o));
      expect(readingText(host)).not.toContain(m.changes_current_notice({}, o));
      expect(readingText(host)).not.toContain(m.changes_limited({}, o));
    }
    await show(state);
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain(
      m.changes_revision({ revision: '5' }),
    );
    await click(m.changes_more());
    expect(more).toBe(1);
    const revision = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes(m.changes_revision({ revision: '4' })),
    )!;
    await act(async () => revision.click());
    expect(selected).toEqual([4]);

    for (const [verdict, decisionText] of [
      ['reject', m.candidate_rejected_state()],
      ['abstain', m.changes_abstained_detail()],
    ] as const) {
      if (detail.summary.kind !== 'candidate') throw new Error('Expected a candidate');
      await show({
        ...state,
        detail: {
          kind: 'ready',
          detail: {
            ...detail,
            summary: {
              ...detail.summary,
              reading: { decision: { head: 9, verdict, revision: 7 }, selected: false, rank: 'deprecated' },
            },
          },
        },
      });
      const current = host.querySelector(`section[aria-label="${m.changes_current()}"]`)!;
      expect(current.textContent).toContain(decisionText);
      expect(current.textContent).toContain(m.value_not_selected());
      expect(current.textContent).toContain(m.changes_rank_deprecated());
      expect(readingText(host)).not.toContain(m.changes_current_notice());
    }
    if (detail.summary.kind !== 'candidate') throw new Error('Expected a candidate');
    await show({
      ...state,
      detail: {
        kind: 'ready',
        detail: {
          ...detail,
          summary: {
            ...detail.summary,
            reading: { decision: null, selected: false, rank: null },
          },
        },
      },
    });
    expect(readingText(host)).toContain(m.candidate_unresolved());
    expect(readingText(host)).not.toContain(m.changes_current_notice());

    await show({ ...state, detail: { kind: 'ready', detail: { ...detail, summary: { kind: 'limited' } } } });
    expect(readingText(host)).toContain(m.changes_limited());
    expect(readingText(host)).toContain(m.changes_current_notice());
    expect(host.querySelector(`section[aria-label="${m.changes_current()}"]`)).toBeNull();
    expect(host.querySelector<HTMLAnchorElement>('nav a')?.getAttribute('href')).toBe(list.page.href);
    expect(readingText(host)).not.toContain(m.context_accepted());

    await show({
      ...state,
      detail: {
        kind: 'ready',
        detail: {
          ...detail,
          summary: {
            kind: 'adoption',
            property: 'schema:isbn',
            context: fixture.read.subject.context,
            mode: 'replace',
            selection: [{ candidate: '00000000-0000-8000-8000-000000000005', rank: 'preferred' }],
          },
        },
      },
    });
    expect(readingText(host)).toContain(m.changes_adopted_detail());
    expect(readingText(host)).toContain(m.context_replace());
    expect(readingText(host)).toContain(m.facts_selected_value({ number: '1' }));
    expect(readingText(host)).toContain(m.changes_current_notice());

    await show({ ...state, detail: { kind: 'denied' } });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.changes_denied());
    expect(readingText(host)).not.toContain(m.changes_current_notice());
    await click(m.changes_retry_detail());
    expect(retried).toBe(1);
    await show({ ...state, detail: undefined, loading: 'detail' });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.changes_detail_loading());
    expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    expect(readingText(host)).not.toContain(m.changes_current_notice());
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].every((node) => node.disabled)).toBe(true);
    expect(fixture.calls).toHaveLength(calls);
  });
});

test('Value keeps a genuinely omitted decision incomplete through both actual Next cursors, then removes the notice', async () => {
  await mounted(async ({ host, render, click }) => {
    const { ValueExplanation, ValueExplanationPage } = await import('../src/features/catalogue/value-explanation-page');
    const { valueExplanationFixture, valueCursor, valueLastCursor } =
      await import('../src/kernel/fake/value-explanation');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = valueExplanationFixture('paged');
    await render(h(ValueExplanation, { locale: 'en', transport: fixture.transport }));
    for (const cursor of [valueCursor, valueLastCursor]) {
      expect(readingText(host)).toContain(m.value_not_returned());
      expect(readingText(host)).toContain(m.value_page_bound());
      expect(readingText(host)).toContain('9780156012195');
      expect(readingText(host)).toContain(m.value_citation_scope());
      expect(readingText(host)).not.toContain(m.candidate_rejected_state());
      expect(readingText(host)).not.toContain('UNSELECTED PRIVATE ALTERNATIVE');
      expect(readingText(host)).not.toContain(m.value_basis());
      await click(m.value_more());
      expect(fixture.calls.at(-1)).toMatchObject({ cursor, session: 'value-session', method: 'GET' });
    }
    expect(readingText(host)).toContain(m.value_accepted());
    expect(readingText(host)).toContain(m.context_replaced());
    expect(readingText(host)).not.toContain(m.value_page_bound());
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.value_more())).toBe(false);
    expect(fixture.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(3);
    const technical = host.querySelector('details')!;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain(m.value_basis());
    expect(technical.textContent).toContain(fixture.selected.id);
    const requests = fixture.calls.length;
    technical.open = true;
    expect(fixture.calls).toHaveLength(requests);
    await click(m.value_restart());
    expect(fixture.calls.at(-1)?.cursor).toBeNull();
    expect(readingText(host)).toContain(m.value_page_bound());

    const omitted = await fixture.transport();
    if (omitted.kind !== 'ready') throw new Error('Expected current reading with omitted review');
    const withoutNext: ValueRead = {
      ...omitted,
      page: { ...omitted.page, competition: { kind: 'not-returned', next: null } },
    };
    const nextRequests: string[] = [];
    let reloads = 0;
    await render(
      h(ValueExplanationPage, {
        result: withoutNext,
        locale: 'en',
        onMore: (cursor) => nextRequests.push(cursor),
        onReload: () => reloads++,
      }),
    );
    expect(readingText(host)).toContain(m.value_page_bound());
    expect(readingText(host)).not.toContain(m.candidate_rejected_state());
    expect([...host.querySelectorAll('button')].map((node) => node.textContent)).toEqual([m.candidate_reload()]);
    await click(m.candidate_reload());
    expect(reloads).toBe(1);
    expect(nextRequests).toEqual([]);
  });
});

test('Value preserves denied, unavailable and absent evidence without applying the omitted-decision notice', async () => {
  await mounted(async ({ host, render }) => {
    const { ValueExplanationPage } = await import('../src/features/catalogue/value-explanation-page');
    const { valueExplanationFixture } = await import('../src/kernel/fake/value-explanation');
    const { m } = await import('../src/paraglide/messages.js');
    for (const [scenario, message] of [
      ['selected', m.value_accepted()],
      ['review-denied', m.value_metadata_denied()],
      ['review-error', m.value_metadata_unavailable()],
      ['unresolved', m.context_unresolved()],
      ['not-selected', m.value_not_selected()],
      ['concealed', m.value_missing()],
    ] as const) {
      const fixture = valueExplanationFixture(scenario);
      const result = await fixture.transport();
      await render(h(ValueExplanationPage, { result, locale: 'en' }));
      expect(readingText(host)).toContain(message);
      expect(readingText(host)).not.toContain(m.value_page_bound());
      expect(readingText(host)).not.toContain(m.value_basis());
      expect(host.textContent).not.toContain('UNSELECTED PRIVATE ALTERNATIVE');
      if (scenario === 'review-denied' || scenario === 'review-error') {
        expect(readingText(host)).toContain('9780156012195');
        expect(readingText(host)).toContain(m.value_change_unavailable());
        expect(readingText(host)).toContain(m.value_citation_scope());
      }
    }
  });
});

test('Sources uses the item family while retaining rich values, all qualifiers, citation order, rights and independent links', async () => {
  await mounted(async ({ host, render }) => {
    const { SubjectSourcesPage } = await import('../src/features/catalogue/subject-sources-page');
    const { explainSubjectSources } = await import('../src/features/catalogue/subject-sources');
    const { catalogueSourcesFixture, sourceDefinitions, citationUrl } =
      await import('../src/kernel/fake/catalogue-sources');
    const { contextHref } = await import('../src/features/pages/context-navigation');
    const { subjectHref } = await import('../src/subject/subject-href');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = catalogueSourcesFixture();
    const page = explainSubjectSources(fixture.read, 'en', sourceDefinitions);
    const target = '00000000-0000-8000-8000-000000000042';
    const title = '旅人の物語 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
    const qualifierUrl = 'https://catalogue.example.test/editions/original';
    const archiveUrl = 'https://archive.example.test/catalogue/second-citation';
    page.realm = '00000000-0000-8000-8000-000000000043';
    page.related[target] = { labels: { ja: title } };
    page.fields.push({
      property: 'schema:author',
      label: { text: 'المؤلف ومعلومات الطبعة الأصلية', lang: 'ar' },
      facts: [
        {
          snak: {
            property: { id: 'schema:author', data_type: 'wikibase-item' },
            value: { type: 'value', content: target },
          },
          qualifiers: [
            {
              label: { text: 'Édition', lang: 'fr' },
              snak: {
                property: { id: 'schema:name', data_type: 'monolingualtext' },
                value: { type: 'value', content: { text: 'Édition originale', language: 'fr' } },
              },
            },
            {
              label: { text: 'Edition record', lang: 'en' },
              snak: {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: qualifierUrl },
              },
            },
          ],
          citations: [
            [
              {
                label: { text: 'Catalogue', lang: 'en' },
                snak: {
                  property: { id: 'schema:url', data_type: 'url' },
                  value: { type: 'value', content: citationUrl },
                },
              },
              {
                label: { text: 'Note', lang: 'en' },
                snak: {
                  property: { id: 'schema:name', data_type: 'monolingualtext' },
                  value: { type: 'value', content: { text: 'Collection conservée', language: 'fr' } },
                },
              },
            ],
            [
              {
                label: { text: 'Archive', lang: 'en' },
                snak: {
                  property: { id: 'schema:url', data_type: 'url' },
                  value: { type: 'value', content: archiveUrl },
                },
              },
            ],
          ],
        },
        {
          snak: {
            property: { id: 'schema:name', data_type: 'monolingualtext' },
            value: { type: 'value', content: { text: 'Deuxième valeur complète sans résumé inventé', language: 'fr' } },
          },
          qualifiers: [],
          citations: [],
        },
        {
          snak: { property: { id: 'schema:name', data_type: 'string' }, value: { type: 'somevalue' } },
          qualifiers: [],
          citations: [],
        },
        {
          snak: { property: { id: 'schema:name', data_type: 'string' }, value: { type: 'novalue' } },
          qualifiers: [],
          citations: [],
        },
        {
          snak: { property: { id: 'schema:abstract', data_type: 'document' }, value: { type: 'somevalue' } },
          display: 'document',
          qualifiers: [],
          citations: [],
        },
        {
          snak: { property: { id: 'schema:image', data_type: 'media' }, value: { type: 'somevalue' } },
          display: 'media',
          qualifiers: [],
          citations: [],
        },
      ],
    });
    const before = structuredClone(page);
    await render(h(SubjectSourcesPage, { result: { kind: 'ready', page }, locale: 'en' }));
    const headings = [...host.querySelectorAll('h4')];
    expect(headings[0]?.textContent).toContain('1943');
    expect(headings[1]?.textContent).toBe('9780156012195');
    expect(headings.slice(2).map((node) => node.textContent)).toEqual([
      title,
      'Deuxième valeur complète sans résumé inventé',
      m.subject_value_unknown(),
      m.subject_value_none(),
      m.sources_authored(),
      m.sources_media(),
    ]);
    const propertySection = headings[2]!.closest('section')!;
    const propertyHeading = [...propertySection.querySelectorAll('h3')].find(
      (node) => node.textContent === 'المؤلف ومعلومات الطبعة الأصلية',
    )!;
    expect(propertySection.getAttribute('aria-labelledby')).toBe(propertyHeading.id);
    expect(propertyHeading.getAttribute('lang')).toBe('ar');
    const rich = headings[2]!.closest('[data-slot="source-statement"]')!;
    expect(rich.parentElement?.tagName).toBe('LI');
    expect(rich.parentElement?.parentElement?.tagName).toBe('UL');
    expect(rich.querySelector('[data-content-item-slot="metadata"]')?.textContent).toContain('Édition originale');
    expect(rich.querySelector('[lang="fr"]')?.textContent).toContain('Édition');
    const primary = rich.querySelector<HTMLAnchorElement>('h4 a')!;
    expect(primary.getAttribute('lang')).toBe('ja');
    const href = contextHref(subjectHref({ id: target, label: title }, 'en').href, page.realm);
    const links = [...rich.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((node) => node.getAttribute('href'))).toEqual([href, qualifierUrl, citationUrl, archiveUrl]);
    expect(rich.querySelector('a a, a button, [data-slot="list-row-link"]')).toBeNull();
    const citations = [...rich.querySelectorAll('ol > li')];
    expect(citations).toHaveLength(2);
    expect(citations[0]?.textContent).toContain('Collection conservée');
    expect(citations[1]?.textContent).toContain(archiveUrl);
    for (const link of links) {
      link.focus();
      expect(host.ownerDocument.activeElement).toBe(link);
    }
    const compare = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (node) => node.textContent === m.sources_compare(),
    )!;
    expect(compare.getAttribute('href')).toBe(page.fields[0]!.compareHref!);
    for (const message of [
      m.sources_no_citations(),
      m.sources_rights_scope(),
      'Reviewed bibliography',
      'Bibliography contributors',
      'REZICS fixtures',
      'Generated fixture',
      'CC0-1.0',
    ]) {
      expect(readingText(host)).toContain(message);
    }
    expect(host.querySelector('a[href="https://creativecommons.org/publicdomain/zero/1.0/"]')).not.toBeNull();
    expect(page).toEqual(before);
    expect(fixture.calls).toHaveLength(0);

    for (const scenario of ['partial-metadata', 'no-citations'] as const) {
      const missing = catalogueSourcesFixture(scenario);
      missing.read.summary = null;
      await render(
        h(SubjectSourcesPage, {
          result: { kind: 'ready', page: explainSubjectSources(missing.read, 'en', sourceDefinitions) },
          locale: 'en',
        }),
      );
      expect(readingText(host)).toContain('9780156012195');
      expect(readingText(host)).toContain(m.sources_cover_unknown());
      if (scenario === 'partial-metadata') {
        expect(readingText(host)).toContain(m.sources_licence_unknown());
        expect(readingText(host)).toContain(m.sources_attribution_unknown());
      } else {
        expect(readingText(host)).toContain(m.sources_no_citations());
        expect(readingText(host)).toContain(m.sources_metadata_unavailable());
      }
    }
  });
});
