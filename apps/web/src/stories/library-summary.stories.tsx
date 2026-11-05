import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PersonalLibraryPage } from '../library/entries-page';
import type { PersonalLibraryView } from '../library/entries-read';
import type { ShelfSummaryState } from '../library/shelf-summary-observation';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Library/Summary',
  parameters: { layout: 'fullscreen', admitted: ['personal_library', 'reading_progress', 'collections'] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const empty: PersonalLibraryView = { signedIn: true, entries: [], next: null };
const zero: ShelfSummaryState = {
  state: 'loaded',
  summary: {
    tabs: {
      all: { shown: 0, total: 0 },
      in_progress: { shown: 0, total: 0 },
      planned: { shown: 0, total: 0 },
      completed: { shown: 0, total: 0 },
      paused: { shown: 0, total: 0 },
      dropped: { shown: 0, total: 0 },
      collections: { shown: 0, total: 0 },
    },
  },
};
function render(summary: ShelfSummaryState, page = empty) {
  return (
    <PatternStory visitor="Signed In" path="/library">
      <div className="mx-auto max-w-7xl p-4 sm:p-8">
        <PersonalLibraryPage
          page={page}
          locale={getLocale()}
          display={{ layout: 'grid', size: 'm' }}
          continueState={{ state: 'loaded', entries: [], next: null }}
          acceptedNavigation={{
            pins: { state: 'loaded', pins: [], revision: 1, next: null },
            collections: [],
            collectionsState: 'loaded',
          }}
          summary={{ page: summary, retry: () => {} }}
        />
      </div>
    </PatternStory>
  );
}
export const ReadyZeroFirstUse: Story = {
  render: () => render(zero),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_empty_title())).toBeVisible();
    await expect(canvas.getByRole('navigation', { name: m.library_summary_heading() })).toBeVisible();
  },
};
export const Preparing: Story = { render: () => render({ state: 'preparing' }) };
export const AcknowledgedChange: Story = { render: () => render({ state: 'stale' }) };
export const SummaryFailedRowsRetained: Story = {
  render: () =>
    render(
      { state: 'unavailable' },
      {
        signedIn: true,
        next: null,
        entries: [
          {
            subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
            state: 'planned',
            revision: 1,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            subject: {
              id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
              type: 'Book',
              types: ['Book'],
              label: 'Retained Entry',
              cover: null,
            },
            changeKey: 'summary-state',
            removeKey: 'summary-remove',
          },
        ],
      },
    ),
};
export const ProgressDeniedCountsRetained: Story = { render: () => render(zero, { ...empty, readState: 'denied' }) };
export const FilteredZero: Story = {
  render: () =>
    render(
      {
        state: 'loaded',
        summary: {
          tabs: {
            ...zero.summary.tabs,
            all: { shown: 0, total: 12 },
            planned: { shown: 0, total: 12 },
          },
        },
      },
      { ...empty, type: 'schema:Book', typeLabel: 'Book' },
    ),
};
