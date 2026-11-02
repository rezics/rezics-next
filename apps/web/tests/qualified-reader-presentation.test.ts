import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry } from '@rezics/composition';
import { qualifiedRelationsPage, qualifiedRealm } from '../src/kernel/fake/qualified-relations';
import { traversalPage, traversalRelease } from '../src/kernel/fake/edition-work';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import type { SubjectPageData } from '../src/features/pages/subject';
import { relationDefinitions } from '../src/subject/relations';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { SubjectPage, pageContext, pageRelationProperties } = await import('../src/features/pages/subject');
const { readRelationGroup, relationGroupKey } = await import('../src/features/pages/relation-stream-query');
const { holderItems } = await import('../src/features/pages/overview');

test('qualified reader journey keeps complete statement fields and presentation-specific native continuation', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test' });
  const host = window.document.createElement('main');
  const page = structuredClone(qualifiedRelationsPage({ realm: qualifiedRealm }));
  const plan = planReads(platformRegistry, page.document, pageContext(page));
  const cast = page.reads[plan.nodes.cast!]!.body as { relations: Record<string, any>[]; next: string };
  const original = cast.relations[0]!;
  const first = structuredClone(original);
  const second = structuredClone(original);
  first.statement.id = 'complete-credit';
  second.statement.id = 'another-credit';
  const snak = (id: string, data_type: string, content: unknown) => ({
    property: { id, data_type },
    value: { type: 'value', content },
  });
  const creditedAs = '旅人の声と回想場面の語りを担当したアレクサンドラ・プレイヤー';
  first.statement.qualifiers = [
    snak('schema:position', 'string', '2'),
    ...original.statement.qualifiers.filter((q: any) => ['wdt:P3831', 'wdt:P453'].includes(q.property.id)),
    snak('wdt:P1932', 'monolingualtext', { text: creditedAs, language: 'ja' }),
    snak('wdt:P518', 'wikibase-item', '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99'),
    snak('wdt:P3831', 'wikibase-item', 'withheld-role'),
  ];
  first.related['0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99'] = {
    id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99',
    type: 'wd:Q2620972',
    label: { value: 'The return', language: 'en' },
  };
  second.statement.qualifiers = [snak('schema:position', 'string', '1'), snak('wdt:P1932', 'string', 'Other credit')];
  const hidden = structuredClone(first);
  hidden.statement.id = 'spoiler-credit';
  hidden.label = 'Spoiler performer';
  hidden.statement.qualifiers.push(snak('rezics:spoilerLevel', 'quantity', { amount: '+2', unit: '1' }));
  cast.relations = [
    first,
    second,
    hidden,
    { ...first, target: 'missing-person', summary: null, label: 'Unavailable person' },
  ];
  // Exercise release-backed presentation rather than the fixture's authored English title.
  const castNode = page.document.content.find((node) => node.props.id === 'cast')!;
  delete castNode.props.title;
  function render(current: SubjectPageData, locale = 'en') {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, {
        client: new QueryClient(),
        children: createElement(SubjectPage, {
          page: current,
          locale,
          renderJsonLd: false,
          relations: relationDefinitions(traversalRelease, pageRelationProperties(current), locale),
          reader: { spoilerLevel: 0, suitability: 'blur' },
          messages: {
            unknown: 'Unknown',
            none: 'None',
            unlabelled: 'Unlabelled',
            sources: 'Sources',
            aliases: 'Aliases',
            spoilerShow: 'Show spoiler',
          },
        }),
      }),
    );
  }
  try {
    host.innerHTML = render(page);
    const section = host.querySelector('[data-node="cast"]')!;
    expect(section.querySelector('h2')!.textContent).toBe('Cast');
    const firstRow = section.querySelector('[data-statement="complete-credit"]')!;
    const secondRow = section.querySelector('[data-statement="another-credit"]')!;
    const labelledList = section.querySelector('ul[aria-label]')!;
    const firstItem = firstRow.closest('li')!;
    expect(firstItem.tagName).toBe('LI');
    expect(firstItem.parentElement).toBe(labelledList);
    expect(firstItem.querySelectorAll('article[data-slot="cover-card"]')).toHaveLength(1);
    expect(firstItem.getAttribute('data-slot')).not.toBe('list-row');
    expect(firstItem.querySelector('[data-slot="list-row"]')).toBeNull();
    expect(firstRow.textContent).toContain('Ada Player');
    expect(Array.from(firstRow.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'Order: 2',
      'Role: Voice',
      'Character: The Traveller',
      `Credited as: ${creditedAs} Japanese`,
      'Applies to part: The return',
      'Role: Unlabelled subject',
    ]);
    expect(firstRow.querySelector('[data-property="wdt:P3831"]:last-child a')).toBeNull();
    expect(firstRow.querySelector('[data-property="wdt:P3831"]:last-child')!.textContent).toBe(
      'Role: Unlabelled subject',
    );
    expect(firstRow.querySelector('[lang="ja"]')!.textContent).toBe(`Credited as: ${creditedAs}`);
    // The essential slot is independent of the generic card's clamped secondary metadata at every breakpoint.
    expect(firstRow.querySelector('[data-slot="cover-card-essential-credit"]')).not.toBeNull();
    expect(firstRow.querySelector('[data-slot="cover-card-secondary"]')).toBeNull();
    expect(firstRow.querySelector('a a')).toBeNull();
    expect(secondRow.textContent).toContain('Order: 1');
    expect(secondRow.textContent).not.toContain('Role:');
    expect(secondRow.textContent).not.toContain('Character:');
    expect(secondRow.textContent).not.toContain(creditedAs);
    expect(section.textContent).not.toContain('Spoiler performer');
    expect(section.textContent).not.toContain('Unavailable person');
    expect(section.innerHTML).not.toContain('withheld-role');
    for (const anchor of firstRow.querySelectorAll('a')) {
      expect(anchor.getAttribute('href')).toContain(`realm=${qualifiedRealm}`);
    }
    const more = section.querySelector('[data-slot="continue-group"]')!;
    expect(more.textContent).toBe('More: Cast');
    const url = new URL(more.getAttribute('href')!, window.location.href);
    expect(url.searchParams.get('node')).toBe('cast');
    expect(url.searchParams.get('cursor')).toBe('cast-next');
    expect(url.searchParams.get('realm')).toBe(qualifiedRealm);
    const requests: unknown[] = [];
    const fake = createFakeKernelFetch(fixtures as never);
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(await request.clone().json());
        return fake(request);
      }) as typeof fetch,
    });
    const request = {
      subject: page.subject!,
      locale: 'en',
      view: 'credits' as const,
      node: 'cast',
      cursor: 'cast-next',
      realm: qualifiedRealm,
      context: qualifiedRealm,
      population: 'realm' as const,
      reader: 'current-reader',
    };
    const next = await readRelationGroup(client, request, 'Bearer current-reader');
    expect(next.ok).toBe(true);
    expect(requests).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ subject: page.subject, view: 'credits', realm: qualifiedRealm }),
        continuation: { node: 'cast', cursor: 'cast-next' },
      }),
    ]);
    expect(relationGroupKey(request)).not.toEqual(relationGroupKey({ ...request, reader: 'other-reader' }));
    expect(relationGroupKey(request)).not.toEqual(relationGroupKey({ ...request, context: 'other-context' }));
    // Inverse item shapes can omit the redundant statement ID; the assertion's immutable ID still associates rows.
    const inverse = holderItems(
      {
        links: [first, second].map((row) => ({
          subject: 'work',
          label: 'Work',
          summary: { id: 'work' },
          assertion: row.statement,
          related: row.related,
        })),
      },
      12,
    )!;
    expect(inverse.items.map((item) => item.statement)).toEqual(['complete-credit', 'another-credit']);
    const localized = {
      en: 'Cast',
      'zh-Hant': '演出人員',
      'zh-Hans': '演出人员',
      ja: 'キャスト',
      ko: '출연진',
      de: 'Besetzung',
      fr: 'Distribution',
      es: 'Reparto',
    };
    for (const [locale, label] of Object.entries(localized)) {
      host.innerHTML = render(page, locale);
      const stream = host.querySelector('[data-node="cast"]')!;
      expect(stream.querySelector('h2')!.textContent).toBe(label);
      expect(stream.querySelector('[data-slot="continue-group"]')!.textContent).toBe(
        m.subject_section_more({ label }, { locale: locale as never }),
      );
      expect(stream.textContent).toContain(creditedAs);
    }
    for (const [scenario, node, label] of [
      ['edition', 'edition-work', 'Work'],
      ['work', 'editions', 'Editions'],
    ] as const) {
      const current = traversalPage(scenario, scenario === 'work' ? 'editions' : 'overview', { realm: qualifiedRealm });
      host.innerHTML = render(current);
      const section = host.querySelector(`[data-node="${node}"], section[id="${node}"]`)!;
      expect(section.querySelector('h2')!.textContent).toBe(label);
      if (scenario === 'work')
        expect(section.querySelector('[data-slot="continue-group"]')!.textContent).toBe('More: Editions');
    }
    const refused = qualifiedRelationsPage({
      realm: qualifiedRealm,
      continuation: { node: 'cast', cursor: 'refuse' },
      error: 409,
    });
    host.innerHTML = render(refused);
    expect(host.textContent).toContain('The list changed.');
    const restart = host.querySelector('[data-node="cast"] a')!;
    expect(new URL(restart.getAttribute('href')!, window.location.href).searchParams.get('node')).toBe('cast');
    expect(restart.getAttribute('href')).toContain(`realm=${qualifiedRealm}`);
  } finally {
    await window.happyDOM.close();
  }
});
