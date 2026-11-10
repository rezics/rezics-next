import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState, type CSSProperties } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import { PageData, dataComponents } from '../features/pages/data';
import { CompositionRender } from '../features/pages/render';
import { layoutComponents, pageDefinitions, PageRoot } from '../features/pages/layout';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import recordedSubject from '../kernel/recorded/subject.json';

type Statement = SubjectRead['subject']['statements'][string][number];
type Snak = Statement['qualifiers'][number];
const labelledUnit = 'urn:catalogue:unit:folio';
const unavailableUnit = 'urn:catalogue:unit:undisclosed';
const relatedId = '00000000-0000-4000-8000-000000000301';
const secretId = '00000000-0000-4000-8000-000000000302';
const longLabel = 'OriginalMeasurementConditionsWithoutBreakOpportunities'.repeat(7);
const longValue = '原本の測定条件المعلوماتOriginalMeasurement'.repeat(12);
const external = `https://evidence.example.test/${'original-measurement-'.repeat(15)}?scan=1#fact`;
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

/** Illustrative finite factual variants on a recorded native DTO, not new native success evidence. */
function suppliedFacts(): SubjectRead {
  const body = structuredClone(recordedSubject) as unknown as SubjectRead;
  body.summary = null;
  body.subject.descriptions = {};
  body.subject.sourceRecords = [];
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
        [
          snak('schema:measurementTechnique', 'string', longValue),
          snak('schema:about', 'wikibase-item', relatedId),
          snak('schema:url', 'url', external),
          snak('schema:weight', 'quantity', { amount: '-5.00100', unit: unavailableUnit, lowerBound: '-5.00200' }),
          snak('schema:numberOfPages', 'quantity', { amount: '+12.00', unit: '1', upperBound: '+12.50' }),
          snak('schema:alternateName', 'monolingualtext', { language: 'ja', text: '原本の測定条件' }),
          { property: { id: 'schema:unknown', data_type: 'string' }, value: { type: 'somevalue' } },
          { property: { id: 'schema:none', data_type: 'string' }, value: { type: 'novalue' } },
        ],
      ),
      statement(2, snak('schema:width', 'quantity', { amount: '-0.00000000000000000001', unit: labelledUnit })),
      statement(3, snak('schema:width', 'quantity', { amount: '+3.00', unit: '1' })),
      statement(4, snak('schema:width', 'quantity', { amount: '+4.0000', unit: '1' })),
    ],
    'schema:weight': [statement(5, snak('schema:weight', 'quantity', { amount: '-2.5000', unit: unavailableUnit }))],
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
    'schema:alternateHeadline': [
      statement(
        7,
        snak('schema:alternateHeadline', 'monolingualtext', {
          language: 'ar',
          text: 'النص الأصلي الكامل',
        }),
      ),
    ],
    'schema:award': [
      statement(8, { property: { id: 'schema:award', data_type: 'string' }, value: { type: 'somevalue' } }),
      statement(9, { property: { id: 'schema:award', data_type: 'string' }, value: { type: 'novalue' } }),
    ],
    'schema:spoiler': [
      statement(10, snak('schema:spoiler', 'quantity', { amount: '+777.001', unit: unavailableUnit }), [
        snak('rezics:spoilerLevel', 'quantity', { amount: '+1', unit: '1' }),
        snak('schema:about', 'wikibase-item', secretId),
        snak('schema:url', 'url', 'https://secret.example.test/original'),
      ]),
    ],
    'schema:note': [statement(11, snak('schema:note', 'string', 'Additional supplied fact'))],
  };
  body.related = {
    'schema:width': { labels: { en: 'Width', fr: 'Largeur', ja: '幅' } },
    'schema:weight': { labels: { en: 'Weight', fr: 'Poids', ja: '重さ' } },
    'schema:numberOfPages': { labels: { en: 'Count', fr: 'Nombre', ja: '数量' } },
    'schema:measurementTechnique': { labels: { en: longLabel, ja: '原本の測定条件'.repeat(24) } },
    'schema:about': { labels: { ja: '関連する原本' } },
    'schema:url': { labels: { en: 'Original evidence' } },
    'schema:alternateName': { labels: { ar: 'الاسم الأصلي' } },
    'schema:alternateHeadline': { labels: { en: 'Original wording' } },
    'schema:award': { labels: { en: 'Award' } },
    'schema:spoiler': { labels: { en: 'Concealed measurement' } },
    'schema:note': { labels: { en: 'Additional information' } },
    [labelledUnit]: { labels: { en: 'folios', fr: 'feuillets', ja: '原本の葉数' } },
    [unavailableUnit]: { labels: {} },
    [relatedId]: { labels: { ja: '原本の資料' } },
    [secretId]: { labels: { en: 'Concealed original' } },
    'urn:catalogue:withheld-subject': { labels: { en: 'Undisclosed identity' } },
  };
  return body;
}

function FactsReading({
  view = 'overview',
  enlarged = false,
  dir = 'ltr',
  signedIn = false,
}: {
  view?: 'overview' | 'details';
  enlarged?: boolean;
  dir?: 'ltr' | 'rtl';
  signedIn?: boolean;
}) {
  const locale = getLocale();
  const [body] = useState(suppliedFacts);
  const [client] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, {
      state: signedIn ? 'signed-in' : 'signed-out',
      subject: signedIn ? 'reader' : null,
      csrfToken: null,
    });
    return client;
  });
  useEffect(() => () => client.clear(), [client]);
  const document = {
    root: { props: {} },
    content: [
      ...(view === 'overview' ? [{ type: 'Summary', props: { id: 'about' } }] : []),
      {
        type: 'Statements',
        props: { id: 'facts', properties: Object.keys(body.subject.statements).filter((key) => key !== 'schema:note') },
      },
      ...(view === 'details' ? [{ type: 'MoreStatements', props: { id: 'additional' } }] : []),
    ],
  } satisfies CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: body.subject.id });
  const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body }]));
  return (
    <QueryClientProvider client={client}>
      <main
        data-facts-reading=""
        lang={locale}
        dir={dir}
        className="mx-auto w-full max-w-3xl p-3"
        style={
          enlarged
            ? ({
                '--text-base': '2rem',
                '--text-sm': '1.75rem',
                '--text-lg': '2.25rem',
                '--text-xl': '2.5rem',
                '--text-2xl': '3rem',
              } as CSSProperties)
            : undefined
        }
      >
        <h1 className="mb-6 font-sans text-2xl font-semibold">
          {view === 'overview' ? m.subject_overview() : m.subject_details()}
        </h1>
        <PageData
          locale={locale}
          readingView={view}
          subject={body.subject.id}
          document={document}
          reads={reads}
          reader={{ spoilerLevel: 0, suitability: 'blur' }}
          messages={{
            unknown: m.subject_value_unknown(),
            none: m.subject_value_none(),
            unlabelled: m.subject_value_unlabelled(),
            sources: m.subject_sources(),
            aliases: '',
            search: '',
            spoilerShow: m.subject_spoiler_show(),
            details: m.subject_details(),
          }}
        >
          <CompositionRender
            document={document}
            definitions={pageDefinitions}
            components={{ ...layoutComponents, ...dataComponents }}
            root={PageRoot}
          />
        </PageData>
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Subjects/Factual reading',
  id: 'pages-subjects-factual-reading',
  component: FactsReading,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN under MINIMAL. Real configured About, Statements and MoreStatements sections with supplied native DTO variants. Keyboard, 320px, 200% text, RTL, target geometry and visual acceptance await browser execution; these variants establish no native outcome.',
      },
    },
    viewport: {
      options: { phone320: { name: 'Phone 320', styles: { width: '320px', height: '900px' }, type: 'mobile' } },
    },
  },
} satisfies Meta<typeof FactsReading>;
export default meta;
type Story = StoryObj<typeof meta>;

async function readableGeometry(canvasElement: HTMLElement) {
  const root = canvasElement.querySelector<HTMLElement>('[data-facts-reading]')!;
  const facts = root.querySelector<HTMLElement>('dl[data-slot="subject-facts"]')!;
  const bounds = root.getBoundingClientRect();
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  for (const element of facts.querySelectorAll<HTMLElement>('dl, dt, dd, a, button')) {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    await expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
    await expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    await expect(getComputedStyle(element).textOverflow).not.toBe('ellipsis');
    if (element.matches('a, button')) {
      await expect(box.width).toBeGreaterThanOrEqual(44);
      await expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
}

async function readingJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  const locale = getLocale();
  const facts = canvasElement.querySelector<HTMLElement>('dl[data-slot="subject-facts"]')!;
  const nested = facts.querySelector('dd > dl')!;
  const canvas = within(canvasElement);
  await expect(facts).toHaveTextContent(
    '+9007199254740993.12345678901234567890 (≥ +9007199254740993.12345678901234567889; ≤ +9007199254740993.12345678901234567891) m',
  );
  await expect(facts).toHaveTextContent(`-2.5000 ${m.quantity_unit_unavailable()}`);
  await expect(facts).toHaveTextContent('+0.000 (≥ -0.001; ≤ +0.001)');
  await expect(nested).toHaveTextContent(longValue);
  await expect(nested).toHaveTextContent('+12.00 (≤ +12.50)');
  if (locale !== 'ja') await expect(nested.querySelector('[lang="ja"]')).toHaveTextContent('関連する原本');
  await expect(facts.querySelector('[lang="ar"]')).toHaveTextContent('الاسم الأصلي');
  const rows = [...facts.children];
  const unknowns = rows[4]!.querySelectorAll(':scope > dd > span');
  await expect([...unknowns].map((element) => element.textContent)).toEqual([
    m.subject_value_unknown(),
    m.subject_value_none(),
  ]);
  for (const identity of [
    labelledUnit,
    unavailableUnit,
    'http://www.wikidata.org/entity/Q11573',
    secretId,
    'Concealed original',
    'https://secret.example.test/original',
    'urn:catalogue:withheld-subject',
    'Undisclosed identity',
  ])
    await expect(canvasElement.innerHTML).not.toContain(identity);
  const item = within(nested as HTMLElement).getByRole('link', { name: '原本の資料' });
  const evidence = within(nested as HTMLElement).getByRole('link', { name: external });
  await expect(item).toHaveAttribute('href', subjectHref({ id: relatedId, label: '原本の資料' }, locale).href);
  await expect(evidence).toHaveAttribute('href', external);
  await expect(canvasElement.querySelector('a a, a button')).toBeNull();
  // The linked qualifier and its citation retain separate keyboard destinations.
  const destinations: string[] = [];
  const stopNavigation = (event: Event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor) {
      event.preventDefault();
      destinations.push(anchor.getAttribute('href')!);
    }
  };
  canvasElement.addEventListener('click', stopNavigation);
  try {
    await userEvent.keyboard('{Tab}');
    item.focus();
    await expect(item).toHaveFocus();
    await waitFor(() => expect(getComputedStyle(item).outlineStyle).not.toBe('none'));
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await expect(evidence).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(destinations).toEqual([item.getAttribute('href'), external]);
    await readableGeometry(canvasElement);
    const reveal = canvas.getByRole('button', { name: m.subject_spoiler_show() });
    reveal.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('link', { name: 'Concealed original' })).toHaveAttribute(
      'href',
      subjectHref({ id: secretId, label: 'Concealed original' }, locale).href,
    );
    await expect(facts).toHaveTextContent(`+777.001 ${m.quantity_unit_unavailable()}`);
    await expect(canvas.getByRole('link', { name: 'https://secret.example.test/original' })).toHaveAttribute(
      'href',
      'https://secret.example.test/original',
    );
    await readableGeometry(canvasElement);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.queryByRole('link', { name: 'Concealed original' })).toBeNull());
    await expect(canvasElement.innerHTML).not.toContain(unavailableUnit);
  } finally {
    canvasElement.removeEventListener('click', stopNavigation);
  }
}

export const Overview: Story = { args: { view: 'overview' }, play: readingJourney };
export const Details: Story = { args: { view: 'details', signedIn: true }, play: readingJourney };
export const NarrowOverview: Story = { ...Overview, globals: { viewport: { value: 'phone320', isRotated: false } } };
export const NarrowDetails: Story = { ...Details, globals: { viewport: { value: 'phone320', isRotated: false } } };
export const EnlargedOverview: Story = { ...NarrowOverview, args: { view: 'overview', enlarged: true } };
export const EnlargedRtlDetails: Story = {
  ...NarrowDetails,
  args: { view: 'details', enlarged: true, dir: 'rtl', signedIn: true },
  globals: { ...NarrowDetails.globals, locale: 'fr' },
};
