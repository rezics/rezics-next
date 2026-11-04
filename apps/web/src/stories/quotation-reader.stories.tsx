import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent } from 'storybook/test';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubjectRead } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { QuotationView } from '../features/pages/quotation-view';
import type { QuotationRead, QuotationRow } from '../features/catalogue/quotation';
import recordedSubject from '../kernel/recorded/subject.json';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type State = 'sourced' | 'withheld' | 'unsupported' | 'later' | 'recovery' | 'stale' | 'spoiler' | 'languages';
const quoteId = '00000000-0000-4000-8000-000000000921';
const textStatementId = '00000000-0000-4000-8000-000000000922';
const speakerId = '00000000-0000-4000-8000-000000000923';
const creditedId = '00000000-0000-4000-8000-000000000924';
const workId = '00000000-0000-4000-8000-000000000925';
const laterQuoteId = '00000000-0000-4000-8000-000000000926';
const sourceHash = 'sha256:recorded-quotation-reference';
const sourceUrl = 'https://archive.example.test/records/steins-gate/quotation-42';

function quotationFixture(state: State): Extract<QuotationRead, { ok: true }> {
  const publicSubject = structuredClone(recordedSubject) as unknown as SubjectRead;
  const row: QuotationRow = {
    id: quoteId,
    state: 'current' as const,
    observation: 'recorded quotation observation',
    contexts: [
      {
        kind: 'speaker' as const,
        status: 'current' as const,
        property: 'schema:spokenByCharacter',
        statementId: textStatementId,
        id: speakerId,
        label: 'Okabe Rintaro',
        spoiler: state === 'spoiler',
      },
      {
        kind: 'credited' as const,
        status: 'current' as const,
        property: 'schema:creator',
        statementId: textStatementId,
        id: creditedId,
        label: 'MAGES.',
      },
      {
        kind: 'work' as const,
        status: 'current' as const,
        property: 'schema:isPartOf',
        statementId: textStatementId,
        id: workId,
        label: 'Steins;Gate',
      },
      { kind: 'voice' as const, status: 'unknown' as const },
    ],
    statements: [
      {
        statementId: textStatementId,
        property: 'schema:text',
        status: 'current' as const,
        text: 'I will return. The source and the speaker remain distinct.',
        language: 'en',
        qualifiers: [
          {
            property: 'schema:creator',
            label: 'Credited person',
            status: 'current' as const,
            id: creditedId,
            value: 'MAGES.',
          },
        ],
        references: [
          {
            statementId: textStatementId,
            hash: sourceHash,
            status:
              state === 'sourced' || state === 'spoiler' || state === 'languages'
                ? ('current' as const)
                : ('withheld' as const),
            parts:
              state === 'sourced' || state === 'spoiler' || state === 'languages'
                ? [
                    {
                      property: 'schema:url',
                      label: 'Source URL',
                      status: 'current' as const,
                      value: sourceUrl,
                      href: sourceUrl,
                    },
                    {
                      property: 'schema:publisher',
                      label: 'Edition',
                      status: 'current' as const,
                      value: 'Archive scan 42',
                    },
                  ]
                : [{ property: 'schema:url', label: 'Source URL', status: 'withheld' as const }],
          },
        ],
        sourceStatus:
          state === 'sourced' || state === 'spoiler' || state === 'languages'
            ? ('current' as const)
            : ('withheld' as const),
        spoiler: state === 'spoiler',
      },
    ],
  };
  if (state === 'languages')
    row.statements.push({
      statementId: '00000000-0000-4000-8000-000000000927',
      property: 'schema:text',
      language: 'ja',
      status: 'unavailable',
      qualifiers: [],
      references: [],
      sourceStatus: 'unknown',
      spoiler: false,
    });
  return {
    ok: true,
    public: publicSubject,
    admitted: state !== 'unsupported',
    rows: state === 'unsupported' ? [] : [row],
    selected: state === 'unsupported' ? null : row,
    next: null,
    observation: 'recorded work observation',
    unsupportedCount: 0,
  };
}

function Example({ state = 'sourced' }: { state?: State }) {
  const locale = getLocale();
  const initial = useMemo<QuotationRead>(
    () =>
      state === 'recovery'
        ? { ok: false, reason: 'unavailable' }
        : state === 'stale'
          ? { ok: false, reason: 'stale' }
          : { ...quotationFixture(state), next: state === 'later' ? 'fixture-page-two' : null },
    [state],
  );
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const returnTo = `/${locale}/subjects/work/steins-gate/relations`;
  return (
    <PatternStory>
      <AppShell>
        <QueryClientProvider client={client}>
          <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
            <QuotationView
              id={workId}
              locale={locale}
              returnTo={returnTo}
              transport={{
                read: async (input) => {
                  const result = quotationFixture('sourced');
                  if (state === 'later' && input.cursor && result.selected) {
                    result.selected.id = laterQuoteId;
                    result.selected.observation = 'later native quotation observation';
                  }
                  return result;
                },
              }}
              initial={initial}
            />
          </main>
        </QueryClientProvider>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Quotation reader',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SourcedQuotation: Story = {
  args: { state: 'sourced' },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText('I will return. The source and the speaker remain distinct.')).toBeTruthy();
    await expect(canvas.getByText('Okabe Rintaro')).toBeTruthy();
    await expect(canvas.getByText('MAGES.')).toBeTruthy();
    await expect(canvas.getByRole('link', { name: sourceUrl }).getAttribute('href')).toBe(sourceUrl);
    await expect(canvas.getByText(m.quotation_return())).toBeTruthy();
  },
};

export const SourceWithheld: Story = {
  args: { state: 'withheld' },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText('I will return. The source and the speaker remain distinct.')).toBeTruthy();
    await expect(canvas.getByText(m.quotation_concealed_context())).toBeTruthy();
    await expect(canvas.queryByRole('link', { name: sourceUrl })).toBeNull();
  },
};

export const DefinitionUnavailable: Story = {
  args: { state: 'unsupported' },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.quotation_unsupported())).toBeTruthy();
    await expect(canvas.getByRole('link', { name: m.quotation_facts() })).toBeTruthy();
  },
};

export const LaterPageSelection: Story = {
  args: { state: 'later' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.quotation_more() }));
    await userEvent.click(canvas.getByRole('button', { name: m.quotation_open({ number: 1 }) }));
    await expect(canvasElement.querySelector('[data-quotation-id]')?.getAttribute('data-quotation-id')).toBe(
      laterQuoteId,
    );
  },
};
export const ExplicitFailureRecovery: Story = {
  args: { state: 'recovery' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: m.quotation_return() })).toBeTruthy();
    await userEvent.click(canvas.getByRole('button', { name: m.quotation_retry() }));
    await expect(await canvas.findByText('I will return. The source and the speaker remain distinct.')).toBeTruthy();
  },
};
export const StaleReturn: Story = {
  args: { state: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.quotation_stale())).toBeTruthy();
    await userEvent.click(canvas.getByRole('button', { name: m.quotation_restart() }));
    await expect(await canvas.findByText('I will return. The source and the speaker remain distinct.')).toBeTruthy();
  },
};

export const IndependentSpoilers: Story = {
  args: { state: 'spoiler' },
};
export const LanguageBodyUnavailable: Story = {
  args: { state: 'languages' },
};
