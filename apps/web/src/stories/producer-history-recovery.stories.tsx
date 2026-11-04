import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ProducerHistoryPage } from '../features/pages/producer-history';
import { producerRecoveryExample, type RecoveryExample } from '../features/pages/producer-history-reading/examples';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function RecoveryStory({ scenario = 'later' }: { scenario?: RecoveryExample }) {
  const locale = getLocale();
  const example = useMemo(() => {
    const value = producerRecoveryExample(scenario, locale);
    const row = value.first.rows[0];
    if (row?.summary?.label)
      row.summary.label.value += ' · International production and restoration archive — 国際制作記録 — '.repeat(3);
    return value;
  }, [scenario, locale]);
  return (
    <PatternStory path={`/subjects/${example.fixture.id}/producer`} visitor="Signed In">
      <AppShell>
        <main className="mx-auto w-full min-w-0 px-4 py-8 sm:px-8">
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: 'producer-example-reader', csrfToken: 'example' }}
            address={`${example.fixture.id}:${locale}`}
          >
            <ProducerHistoryPage
              id={example.fixture.id}
              locale={locale}
              initial={example.first}
              transport={example.transport}
              search={async () => []}
            />
          </CandidateReaderBoundary>
        </main>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Producer history recovery',
  component: RecoveryStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        component:
          'Mounted producer-history and RelationEditor with authored native-shaped responses. The global theme and locale controls apply. Controller execution owns browser and native acceptance.',
      },
    },
  },
} satisfies Meta<typeof RecoveryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentLaterPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = canvas.getByRole('button', { name: m.producer_history_more() });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(m.producer_history_later_page());
    await expect(canvas.getByRole('link', { name: m.producer_history_back() })).toBeVisible();
  },
};
export const FailedReadWithRecovery: Story = {
  args: { scenario: 'failed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = canvas.getByRole('button', { name: m.producer_history_more() });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(m.producer_history_unavailable());
    await expect(canvas.getByRole('button', { name: m.producer_history_retry() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.producer_history_restart() })).toBeVisible();
  },
};
export const CorrectionReaderRetired: Story = {
  args: { scenario: 'retired' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.producer_history_correct() }));
    await userEvent.click(canvas.getByRole('button', { name: m.relation_open() }));
    const next = canvas.getByRole('button', { name: m.producer_history_more() });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(m.producer_history_correction_retired());
    await expect(canvas.queryByRole('region', { name: m.relation_title() })).toBeNull();
    await expect(canvas.getByRole('button', { name: m.producer_history_retired_close() })).toBeVisible();
  },
};
