import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { RecentHistoryView } from '../search/recent';
import { RecentPanel } from '../search/recent-panel';
import { rememberRecent, type RecentHistory } from '../search/recent-history';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Discovery/Search/Recent',
  id: 'patterns-search-recent',
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <PatternStory path="/search">
        <Story />
      </PatternStory>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function Example({
  failure,
  history = false,
  unavailable = false,
}: {
  failure?: RecentHistory['failure'];
  history?: boolean;
  unavailable?: boolean;
}) {
  const [entries, setEntries] = useState(() =>
    rememberRecent(
      [],
      unavailable ? '' : 'Kokoro',
      unavailable ? { kind: 'Collection', id: '019f0000-0000-7000-8000-734100000002', name: '' } : undefined,
    ),
  );
  const [problem, setProblem] = useState(failure);
  const local: RecentHistory = {
    entries,
    persistence: 'local',
    sync: problem ? 'pending' : 'synced',
    ...(problem ? { failure: problem } : {}),
    remember: (query, scope) => setEntries((e) => rememberRecent(e, query, scope)),
    remove: (id) => setEntries((e) => e.filter((item) => item.id !== id)),
    clear: () => setEntries([]),
    retry: () => setProblem(undefined),
  };
  // Fixtures exercise the actual presenters; production uses the BFF adapter, never a story mode.
  return history ? <RecentHistoryView {...local} history /> : <RecentPanel history={local} />;
}
export const Recent: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.header_search_remove_recent({ name: 'Kokoro' }) }));
    await expect(canvas.getByText(m.header_search_recent_empty())).toBeVisible();
  },
};
export const History: Story = {
  render: () => <Example history />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.search_history_clear() }));
    await expect(canvas.getByText(m.search_history_empty())).toBeVisible();
  },
};
export const Offline: Story = {
  render: () => <Example failure="unavailable" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.search_history_offline())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.search_history_reload() })).toBeVisible();
    await expect(canvas.getByRole('region', { name: m.header_search_trending_searches() })).toBeVisible();
  },
};
export const Conflict: Story = { render: () => <Example history failure="conflict" /> };
export const UnavailableScope: Story = { render: () => <Example history unavailable /> };
