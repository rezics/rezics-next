import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubjectRead } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { QuotationView } from '../features/pages/quotation-view';
import { SubjectExploreSlot } from '../features/pages/subject-slots';
import type { QuotationRead } from '../features/catalogue/quotation';
import recordedSubject from '../kernel/recorded/subject.json';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const context = '00000000-0000-4000-8000-000000000931';
const work = '00000000-0000-4000-8000-000000000932';
const quote = '00000000-0000-4000-8000-000000000933';
const speaker = '00000000-0000-4000-8000-000000000934';
const realm = '00000000-0000-4000-8000-000000000936';

function reading(): Extract<QuotationRead, { ok: true }> {
  const publicRead = structuredClone(recordedSubject) as unknown as SubjectRead;
  publicRead.subject.context = context;
  const selected = {
    id: quote,
    state: 'current' as const,
    observation: `${quote}\u0000${context}\u0000current`,
    contexts: [{ kind: 'speaker' as const, status: 'current' as const, id: speaker, label: 'Okabe Rintaro' }],
    statements: [
      {
        statementId: '00000000-0000-4000-8000-000000000935',
        property: 'schema:text',
        status: 'current' as const,
        text: 'I will return. The source and the speaker remain distinct.',
        language: 'en',
        qualifiers: [],
        references: [],
        sourceStatus: 'unknown' as const,
        spoiler: false,
      },
    ],
  };
  return {
    ok: true,
    public: publicRead,
    admitted: true,
    rows: [selected],
    selected,
    next: null,
    observation: 'recorded work in explicit Context',
    unsupportedCount: 0,
    actions: [{ action: 'statement:propose', operationId: 'subject.propose', state: 'unsupported' }],
  };
}

function Example() {
  const locale = getLocale();
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const initial = useMemo(reading, []);
  return (
    <PatternStory>
      <AppShell>
        <QueryClientProvider client={client}>
          <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
            <div className="grid gap-6 md:grid-cols-2">
              <section aria-label={m.quotation_title({}, { locale: locale as never })} className="space-y-3">
                <h2 className="font-semibold">{m.quotation_title({}, { locale: locale as never })}</h2>
                <SubjectExploreSlot
                  subjectId={work}
                  subjectType="schema:Book"
                  label="The Harbor"
                  locale={locale}
                  context={context}
                />
              </section>
              <section aria-label="Realm quotation entry" className="space-y-3">
                <h2 className="font-semibold">Realm quotation entry</h2>
                <SubjectExploreSlot
                  subjectId={work}
                  subjectType="schema:Book"
                  label="The Harbor"
                  locale={locale}
                  context={context}
                  realm={realm}
                />
              </section>
            </div>
            <section className="mt-8">
              <QuotationView
                id={work}
                locale={locale}
                context={context}
                transport={{ read: async () => reading() }}
                initial={initial}
              />
            </section>
          </main>
        </QueryClientProvider>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Quotation Context visit',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExplicitContextReturn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const target = canvas.getByRole('link', { name: /Okabe Rintaro/ });
    const address = new URL(target.getAttribute('href')!, 'https://site.invalid');
    await expect(address.searchParams.get('context')).toBe(context);
    await expect(address.searchParams.has('via')).toBe(true);
    await expect(canvas.getByText(m.quotation_unavailable())).toBeTruthy();
  },
};

export const PublicEntryAndUnsupportedRealm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const supported = within(canvas.getByRole('region', { name: m.quotation_title() }));
    const quotation = supported.getByRole('link', { name: m.quotation_title() });
    const address = new URL(quotation.getAttribute('href')!, 'https://site.invalid');
    await expect(address.searchParams.get('context')).toBe(context);
    await expect(address.searchParams.has('quote')).toBe(false);
    const realm = within(canvas.getByRole('region', { name: 'Realm quotation entry' }));
    await expect(realm.getByRole('status').textContent).toBe(m.quotation_entry_realm_unsupported());
    const general = realm.getByRole('link', { name: m.quotation_entry_general() });
    const generalAddress = new URL(general.getAttribute('href')!, 'https://site.invalid');
    await expect(generalAddress.searchParams.has('context')).toBe(false);
    await expect(generalAddress.searchParams.has('realm')).toBe(false);
    const graph = supported.getByRole('link', { name: m.graph_explore_title() });
    graph.focus();
    await userEvent.keyboard('{Tab}');
    await expect(quotation).toHaveFocus();
  },
};
