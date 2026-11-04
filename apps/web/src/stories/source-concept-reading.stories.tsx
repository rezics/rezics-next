import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { SourceConceptView } from '../features/pages/source-concept-view';
import { readSourceConcept, type ConceptRead } from '../features/catalogue/source-concept-explorer';
import { catalogueEntries } from '../features/catalogue/catalogue-entry';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const id = '00000000-0000-4000-8000-00000000c001';
const disclosed = '00000000-0000-4000-8000-00000000c002';
const withheld = '00000000-0000-4000-8000-00000000c003';
const plainSubject = '00000000-0000-4000-8000-00000000c004';
const originalRole = 'source:不明な役割/المصدر/00-A';
const originalRelease = `sha256:${'a'.repeat(64)}`;
const activeRelease = `sha256:${'b'.repeat(64)}`;
type State =
  | 'current'
  | 'spoiler'
  | 'loading'
  | 'not-concept'
  | 'unsupported'
  | 'preparing'
  | 'lagging'
  | 'empty'
  | 'unavailable'
  | 'retained'
  | 'recovery'
  | 'denied';

/** Finite native response fixtures demonstrate caller states; they do not assert producer success. */
function fixture(state: State, locale: string) {
  type Statement = SubjectRead['subject']['statements'][string][number];
  const part = (
    property: string,
    content: string,
    data_type: Statement['property']['data_type'] = 'wikibase-item',
  ): Statement => ({
    id: crypto.randomUUID(),
    rank: 'normal' as const,
    property: { id: property, data_type },
    value: { type: 'value' as const, content },
    qualifiers: [],
    references: [],
    rezics: { release: originalRelease, revision: 1 },
  });
  const source: SubjectRead = {
    subject: {
      id,
      type: state === 'not-concept' ? 'schema:Book' : 'skos:Concept',
      revision: 1,
      release: originalRelease,
      context: disclosed,
      labels: { en: 'Original source concept', ja: '原本の分類概念', ar: 'مفهوم المصدر الأصلي' },
      descriptions: { ja: '原本の定義を保持する。العربية — Définition originale — '.repeat(24) },
      aliases: { en: ['Original role', 'Supplied classification'], ja: ['元の分類', '出典の役割'] },
      statements: {
        'skos:inScheme': [part('skos:inScheme', disclosed), part('skos:inScheme', withheld)],
        'skos:broader': [part('skos:broader', plainSubject), part('skos:broader', withheld)],
        'source:original-code': [
          part('source:original-code', '00-A/原文المصدرCodeSansEspaces'.repeat(14), 'external-id'),
        ],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    related: {
      [disclosed]: { type: 'skos:ConceptScheme', labels: { en: 'Original scheme', ja: '原本の体系' } },
      [plainSubject]: { type: 'schema:Book', labels: { en: 'Supplied broader subject', ja: '上位の主題' } },
    },
    account: null,
    summary: null,
  };
  const assertion = source.subject.statements['skos:inScheme']![0]!;
  assertion.references = [
    {
      hash: '1'.repeat(64),
      parts: [
        { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: 'https://vndb.org/g1' } },
      ],
    },
  ];
  if (state === 'spoiler')
    assertion.qualifiers = [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '1' } },
      },
    ];
  Object.assign(source, {
    viewerActions: { state: 'available', actions: [{ action: 'statement:propose', operations: ['subject.propose'] }] },
  });
  let calls = 0;
  return {
    read: async (input: { cursor?: string | undefined; session?: string | undefined }): Promise<ConceptRead> => {
      calls++;
      if (state === 'loading') return new Promise(() => {});
      if (state === 'denied') return { ok: false, reason: 'denied' };
      const failure = state === 'unavailable' || ((state === 'retained' || state === 'recovery') && calls === 2);
      const client = {
        subjects: () => ({
          get: async () => ({ status: 200, data: source, headers: { 'rezics-session-token': 'original-receipt' } }),
          links: {
            get: async () =>
              failure || state === 'preparing'
                ? {
                    status: 503,
                    data: { code: state === 'preparing' ? 'semantic_not_ready' : 'dependency_unavailable' },
                  }
                : {
                    status: 200,
                    data: {
                      links:
                        state === 'empty'
                          ? []
                          : [
                              {
                                subject: disclosed,
                                property: 'skos:broader',
                                statement: disclosed,
                                related: {},
                                summary: {
                                  id: disclosed,
                                  type: 'skos:Concept',
                                  types: ['skos:Concept'],
                                  creativeWork: false,
                                  cover: null,
                                  label: {
                                    value: input.cursor
                                      ? '次の階層 — الصفحة التالية'
                                      : '元の下位概念 — Concept plus spécifique',
                                    language: 'ja',
                                  },
                                },
                              },
                            ],
                      next: input.cursor || state === 'empty' ? null : 'native-next',
                      freshness: { consistency: 'eventual', target_seconds: 10, caught_up: state !== 'lagging' },
                      ...(state === 'empty' ? { count: { value: 0, exact: true } } : {}),
                    },
                  },
          },
        }),
      } as unknown as KernelClient;
      const { relation: _inverse, ...withoutInverse } = bundledRelease.properties['skos:broader']!;
      const release =
        state === 'unsupported'
          ? {
              ...bundledRelease,
              properties: {
                ...bundledRelease.properties,
                'skos:broader': withoutInverse,
              },
            }
          : bundledRelease;
      return readSourceConcept(client, undefined, { ...release, digest: activeRelease }, id, locale, {
        ...input,
        role: originalRole,
      });
    },
  };
}

function Example({ state }: { state: State }) {
  const locale = getLocale();
  const transport = useMemo(() => fixture(state, locale), [state, locale]);
  const origin = catalogueEntries.graph({ id: plainSubject, label: 'Classification', locale }).href;
  return (
    <main className="mx-auto min-w-0 max-w-screen-xl px-4 py-6 sm:px-8">
      <SourceConceptView
        key={state}
        id={id}
        locale={locale}
        role={originalRole}
        returnTo={origin}
        pinUnsupported={state === 'current'}
        transport={transport}
      />
    </main>
  );
}

const meta = {
  title: 'Catalogue/Source concept reading',
  component: Example,
  args: { state: 'current' },
  parameters: { layout: 'fullscreen' },
  globals: { viewport: { value: 'phone390' } },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentHierarchy: Story = {};
export const DesktopHierarchy: Story = { globals: { viewport: { value: 'desktop1280' } } };
export const SpoilerAssociation: Story = { args: { state: 'spoiler' } };
export const InitialLoading: Story = { args: { state: 'loading' } };
export const NoAdmittedConcept: Story = { args: { state: 'not-concept' } };
export const UnsupportedInverse: Story = { args: { state: 'unsupported' } };
export const Preparing: Story = { args: { state: 'preparing' } };
export const Lagging: Story = { args: { state: 'lagging' } };
export const ExactEmpty: Story = { args: { state: 'empty' } };
export const UnavailablePage: Story = { args: { state: 'unavailable' } };
export const Denied: Story = { args: { state: 'denied' } };
export const RetainedAfterFailure: Story = {
  args: { state: 'retained' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('元の下位概念 — Concept plus spécifique');
    await userEvent.click(canvas.getByRole('button', { name: m.concept_explore_more() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.concept_explore_hierarchy_unavailable());
    await expect(canvas.getByText('元の下位概念 — Concept plus spécifique')).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="retained-hierarchy"]')).toBeVisible();
  },
};
export const Recovery: Story = {
  args: { state: 'recovery' },
  play: async (context) => {
    await RetainedAfterFailure.play!(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.concept_explore_retry() }));
    await expect(await canvas.findByText('次の階層 — الصفحة التالية')).toBeVisible();
    await expect(canvasElementStatus(context.canvasElement)).toHaveFocus();
    await expect(canvasElementStatus(context.canvasElement)).toHaveTextContent(m.concept_explore_page_ready());
  },
};
function canvasElementStatus(element: HTMLElement) {
  return element.querySelector('[aria-live="polite"]')!;
}
