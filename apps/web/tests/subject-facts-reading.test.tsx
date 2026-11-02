import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import type { LinkProps } from '../src/features/pages/shared';
import recordedSubject from '../src/kernel/recorded/subject.json';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

type Statement = SubjectRead['subject']['statements'][string][number];
type Snak = Statement['qualifiers'][number];
const snak = (id: string, data_type: Snak['property']['data_type'], content: unknown): Snak => ({
  property: { id, data_type },
  value: { type: 'value', content },
});
const statement = (index: number, part: Snak, qualifiers: Snak[] = []): Statement => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  rank: 'normal',
  ...part,
  qualifiers,
  references: [],
  rezics: { release: recordedSubject.subject.release, revision: 1 },
});

// Supplied-data variants of a recorded native DTO, never evidence of native acceptance.
function suppliedFacts() {
  const body = structuredClone(recordedSubject) as unknown as SubjectRead;
  body.summary = null;
  body.subject.descriptions = {};
  body.subject.sourceRecords = [];
  const longLabel = 'OriginalMeasurementQualifierWithoutAnyBreakOpportunity'.repeat(8);
  const longValue = '測定条件المعلوماتOriginalUnbrokenReading'.repeat(15);
  const external = `https://evidence.example.test/${'original-measurement-'.repeat(18)}?scan=1#fact`;
  const labelledUnit = 'urn:catalogue:unit:folio';
  const missingUnit = 'urn:catalogue:unit:withheld-identity';
  const relatedId = '00000000-0000-4000-8000-000000000201';
  const secretId = '00000000-0000-4000-8000-000000000202';
  body.subject.statements = {
    'schema:width': [
      statement(
        1,
        snak('schema:width', 'quantity', {
          amount: '+9007199254740993.12345678901234567890',
          unit: 'http://www.wikidata.org/entity/Q11573',
          lowerBound: '+9007199254740993.12345678901234567889',
          upperBound: '+9007199254740993.12345678901234567891',
        }),
      ),
      statement(2, snak('schema:width', 'quantity', { amount: '-0.00000000000000000001', unit: labelledUnit })),
      statement(3, snak('schema:width', 'quantity', { amount: '+3.00', unit: '1' })),
      statement(4, snak('schema:width', 'quantity', { amount: '+4.0000', unit: '1' })),
    ],
    'schema:weight': [statement(5, snak('schema:weight', 'quantity', { amount: '-2.5000', unit: missingUnit }))],
    'schema:numberOfPages': [
      statement(
        6,
        snak('schema:numberOfPages', 'quantity', {
          amount: '+0.000',
          unit: '1',
          lowerBound: '-0.001',
          upperBound: '+0.001',
        }),
      ),
    ],
    'schema:measurementTechnique': [
      statement(7, snak('schema:measurementTechnique', 'string', 'Original measurement'), [
        snak('schema:measurementTechnique', 'string', longValue),
        snak('schema:about', 'wikibase-item', relatedId),
        snak('schema:url', 'url', external),
        snak('schema:weight', 'quantity', { amount: '-5.00100', unit: missingUnit, lowerBound: '-5.00200' }),
        snak('schema:numberOfPages', 'quantity', { amount: '+12.00', unit: '1', upperBound: '+12.50' }),
        snak('schema:alternateName', 'monolingualtext', { language: 'ja', text: '原本の測定条件' }),
        { property: { id: 'schema:unknown', data_type: 'string' }, value: { type: 'somevalue' } },
        { property: { id: 'schema:none', data_type: 'string' }, value: { type: 'novalue' } },
        snak('schema:missingLabel', 'string', 'Supplied value without a property label'),
      ]),
    ],
    'schema:alternateHeadline': [
      statement(
        8,
        snak('schema:alternateHeadline', 'monolingualtext', {
          language: 'ar',
          text: 'النص الأصلي الكامل',
        }),
      ),
    ],
    'schema:award': [
      statement(9, { property: { id: 'schema:award', data_type: 'string' }, value: { type: 'somevalue' } }),
      statement(10, { property: { id: 'schema:award', data_type: 'string' }, value: { type: 'novalue' } }),
    ],
    'schema:spoiler': [
      statement(11, snak('schema:spoiler', 'quantity', { amount: '+777.001', unit: missingUnit }), [
        snak('rezics:spoilerLevel', 'quantity', { amount: '+1', unit: '1' }),
        snak('schema:about', 'wikibase-item', secretId),
        snak('schema:url', 'url', 'https://secret.example.test/original'),
      ]),
    ],
    'schema:note': [statement(12, snak('schema:note', 'string', 'Additional native fact'))],
  };
  body.related = {
    'schema:width': { labels: { en: 'Width', fr: 'Largeur' } },
    'schema:weight': { labels: { en: 'Weight', fr: 'Poids' } },
    'schema:numberOfPages': { labels: { en: 'Count', fr: 'Nombre' } },
    'schema:measurementTechnique': { labels: { en: longLabel } },
    'schema:about': { labels: { ja: '関連する原本' } },
    'schema:url': { labels: { en: 'Original evidence' } },
    'schema:alternateName': { labels: { ar: 'الاسم الأصلي' } },
    'schema:alternateHeadline': { labels: { en: 'Original wording' } },
    'schema:award': { labels: { en: 'Award' } },
    'schema:spoiler': { labels: { en: 'Concealed measurement' } },
    'schema:note': { labels: { en: 'Additional information' } },
    [labelledUnit]: { labels: { en: 'folios', fr: 'feuillets' } },
    [missingUnit]: { labels: {} },
    [relatedId]: { labels: { ja: '原本の資料' } },
    [secretId]: { labels: { en: 'Concealed original' } },
    'urn:catalogue:undisclosed-subject': { labels: { en: 'Undisclosed identity' } },
  };
  return { body, longLabel, longValue, external, labelledUnit, missingUnit, relatedId, secretId };
}

// UNRUN under MINIMAL. This mounts the configured production readers; geometry is authored in the companion story.
test('Configured Subject Overview and Details preserve exact quantity meaning, nested facts, disclosure and independent destinations', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/reading' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { PageData, dataComponents } = await import('../src/features/pages/data');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { layoutComponents, pageDefinitions, PageRoot } = await import('../src/features/pages/layout');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { valueExplanationHref } = await import('../src/features/catalogue/value-explanation');
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const { body, longLabel, longValue, external, labelledUnit, missingUnit, relatedId, secretId } = suppliedFacts();
  const original = structuredClone(body);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.style.width = '320px';
  host.style.fontSize = '200%';
  window.document.body.append(host);
  const root = createRoot(host);
  const previousLocale = getLocale();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const navigations: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    throw new Error('Factual reading must use only supplied data');
  }) as typeof fetch;
  function Link({ href, children, ...props }: LinkProps) {
    return (
      <a
        {...props}
        href={href}
        data-page-link=""
        onClick={(event) => {
          event.preventDefault();
          navigations.push(href);
        }}
      >
        {children}
      </a>
    );
  }
  const properties = Object.keys(body.subject.statements).filter((property) => property !== 'schema:note');
  const show = async (view: 'overview' | 'details', locale: 'en' | 'fr', signedIn = false) => {
    const document = {
      root: { props: {} },
      content: [
        ...(view === 'overview' ? [{ type: 'Summary', props: { id: 'about' } }] : []),
        { type: 'Statements', props: { id: 'facts', properties } },
        ...(view === 'details' ? [{ type: 'MoreStatements', props: { id: 'additional' } }] : []),
      ],
    } satisfies CompositionDocument;
    const plan = planReads(platformRegistry, document, { subject: body.subject.id });
    expect(Object.values(plan.reads).every((read) => read.kind === 'subject')).toBe(true);
    const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body }]));
    host.dir = locale === 'fr' ? 'rtl' : 'ltr';
    client.setQueryData(sessionQuery.queryKey, {
      state: signedIn ? 'signed-in' : 'signed-out',
      subject: signedIn ? 'reader' : null,
      csrfToken: null,
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PageData
            key={`${view}/${locale}/${signedIn}`}
            locale={locale}
            readingView={view}
            subject={body.subject.id}
            document={document}
            reads={reads}
            link={Link}
            reader={{ spoilerLevel: 0, suitability: 'blur' }}
            messages={{
              unknown: m.subject_value_unknown({}, { locale }),
              none: m.subject_value_none({}, { locale }),
              unlabelled: m.subject_value_unlabelled({}, { locale }),
              sources: 'Sources',
              aliases: '',
              search: '',
              spoilerShow: 'Reveal facts',
            }}
          >
            <CompositionRender
              document={document}
              definitions={pageDefinitions}
              components={{ ...layoutComponents, ...dataComponents }}
              root={PageRoot}
            />
          </PageData>
        </QueryClientProvider>,
      ),
    );
  };
  try {
    setLocale('ja', { reload: false }); // Explicit page locale owns quantity fallback, regardless of runtime locale.
    for (const view of ['overview', 'details'] as const) {
      for (const locale of ['en', 'fr'] as const) {
        await show(view, locale);
        const facts = host.querySelector('dl[data-slot="subject-facts"]')!;
        expect(facts).not.toBeNull();
        expect(!!facts.closest('[data-slot="subject-summary"]')).toBe(view === 'overview');
        const groups = [...facts.children];
        expect(groups.map((group) => group.querySelector(':scope > dt')?.textContent)).toEqual([
          locale === 'fr' ? 'Largeur' : 'Width',
          locale === 'fr' ? 'Poids' : 'Weight',
          locale === 'fr' ? 'Nombre' : 'Count',
          longLabel,
          'Original wording',
          'Award',
          'Concealed measurement',
        ]);
        const values = (index: number) =>
          [...groups[index]!.querySelectorAll(':scope > dd > span:first-child')].map((node) => node.textContent);
        expect(values(0)).toEqual([
          '+9007199254740993.12345678901234567890 (≥ +9007199254740993.12345678901234567889; ≤ +9007199254740993.12345678901234567891) m',
          `-0.00000000000000000001 ${locale === 'fr' ? 'feuillets' : 'folios'}`,
          '+3.00',
          ...(view === 'details' ? ['+4.0000'] : []),
        ]);
        expect(values(1)).toEqual([`-2.5000 ${m.quantity_unit_unavailable({}, { locale })}`]);
        expect(values(2)).toEqual(['+0.000 (≥ -0.001; ≤ +0.001)']);
        expect(values(5)).toEqual([m.subject_value_unknown({}, { locale }), m.subject_value_none({}, { locale })]);
        const nested = groups[3]!.querySelector('dd > dl')!;
        expect([...nested.children].map((row) => row.querySelector('dt')?.textContent)).toEqual([
          longLabel,
          '関連する原本',
          'Original evidence',
          locale === 'fr' ? 'Poids' : 'Weight',
          locale === 'fr' ? 'Nombre' : 'Count',
          'الاسم الأصلي',
          m.subject_value_unlabelled({}, { locale }),
          m.subject_value_unlabelled({}, { locale }),
          m.subject_value_unlabelled({}, { locale }),
        ]);
        expect([...nested.children].map((row) => row.querySelector('dd')?.textContent)).toEqual([
          longValue,
          '原本の資料',
          external,
          `-5.00100 (≥ -5.00200) ${m.quantity_unit_unavailable({}, { locale })}`,
          '+12.00 (≤ +12.50)',
          '原本の測定条件',
          m.subject_value_unknown({}, { locale }),
          m.subject_value_none({}, { locale }),
          'Supplied value without a property label',
        ]);
        expect(nested.querySelector('dt[lang="ja"]')?.textContent).toBe('関連する原本');
        expect(nested.querySelector('dd [lang="ja"]')?.textContent).toBe('原本の資料');
        expect(groups[4]!.querySelector('[lang="ar"]')?.textContent).toBe('النص الأصلي الكامل');
        expect(host.querySelector('a a, a button')).toBeNull();
        const links = [...nested.querySelectorAll<HTMLAnchorElement>('a')];
        expect(links.map((link) => link.getAttribute('href'))).toEqual([
          subjectHref({ id: relatedId, label: '原本の資料' }, locale).href,
          external,
        ]);
        expect(links[0]!.hasAttribute('data-page-link')).toBe(true);
        links[0]!.focus();
        await user.keyboard('{Enter}');
        expect(navigations.at(-1)).toBe(links[0]!.getAttribute('href'));
        await user.tab();
        expect(window.document.activeElement).toBe(links[1]);
        expect(host.textContent?.includes('Additional native fact')).toBe(view === 'details');
        expect(host.querySelectorAll(`a[href*="/edit?"]`)).toHaveLength(0);
        const why = host.querySelector<HTMLAnchorElement>(`a[href*="/value?"]`)!;
        expect(why.getAttribute('href')).toBe(
          valueExplanationHref(
            {
              id: body.subject.id,
              title: body.subject.labels[locale]!,
              property: 'schema:width',
              statement: body.subject.statements['schema:width']![0]!.id,
              context: body.subject.context,
            },
            locale,
          ),
        );
        for (const withheld of [
          missingUnit,
          labelledUnit,
          'http://www.wikidata.org/entity/Q11573',
          'urn:catalogue:undisclosed-subject',
          'Undisclosed identity',
          secretId,
          'Concealed original',
          'https://secret.example.test/original',
          '+777.001',
          'rezics:spoilerLevel',
        ])
          expect(host.innerHTML).not.toContain(withheld);
        const reveal = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent === 'Reveal facts',
        )!;
        reveal.focus();
        await act(async () => user.keyboard('{Enter}'));
        expect(host.textContent).toContain(`+777.001 ${m.quantity_unit_unavailable({}, { locale })}`);
        expect(host.querySelector(`a[href*="${secretId}"]`)?.textContent).toBe('Concealed original');
        expect(host.querySelector('a[href="https://secret.example.test/original"]')).not.toBeNull();
        expect(host.innerHTML).not.toContain(missingUnit);
        await act(async () => user.keyboard('{Enter}'));
        expect(host.textContent).not.toContain('+777.001');
        expect(host.innerHTML).not.toContain(secretId);
      }
    }
    await show('details', 'en', true);
    const correction = host.querySelector<HTMLAnchorElement>('a[href*="/edit?"]')!;
    expect(correction.getAttribute('href')).toBe(
      `${subjectHref({ id: body.subject.id, label: body.subject.labels.en! }, 'en').href}/edit?${new URLSearchParams({ property: 'schema:width', statement: body.subject.statements['schema:width']![0]!.id })}`,
    );
    expect(requests).toEqual([]);
    expect(body).toEqual(original);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    globalThis.fetch = originalFetch;
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
