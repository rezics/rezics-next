import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';
import { WorkbenchHistory } from '../moderation/workbench-history';
import { workbenchSearch } from '../moderation/workbench-queue/scope';
import type { HistoryEntry, HistoryRead } from '../moderation/workbench-history/read';
import { m } from '../paraglide/messages.js';

const entry: HistoryEntry = {
  id: 'decision-1',
  targetKind: 'post',
  targetId: 'original-post-1',
  action: 'takedown',
  decidedAt: '2026-11-04T00:00:00.000Z',
  statement: 'The retained moderator reason explains this decision. '.repeat(18),
  history: { reasonState: 'retained', decider: 'withheld', receipt: 'permitted', target: 'unavailable' },
};
const page: HistoryRead = { state: 'ready', entries: [entry], next: 'native-opaque-history-cursor' };
const meta = {
  title: 'Pages/Moderation/Board decision history',
  component: WorkbenchHistory,
  parameters: { layout: 'fullscreen', viewport: { options: queueViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/moderation/workbench">
        <AppShell>
          <main className="mx-auto min-w-0 max-w-4xl p-4">
            <Story />
          </main>
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    page,
    search: workbenchSearch({ board: 'board-1', history: true, cursor: 'original-queue-cursor' }),
    onSearch: fn(),
    onReturn: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof WorkbenchHistory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const inspect = view.getByRole('button', { name: m.moderation_history_open_receipt() });
    inspect.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ historyDecision: entry.id, cursor: 'original-queue-cursor' }),
    );
  },
};
export const Narrow: Story = { globals: { viewport: { value: 'phone390' } } };
export const Withheld: Story = {
  args: {
    page: {
      ...page,
      entries: [
        {
          ...entry,
          statement: '',
          history: { reasonState: 'retired', decider: 'retired', receipt: 'unavailable', target: 'unavailable' },
        },
      ],
    },
  },
};
export const Sparse: Story = { args: { page: { ...page, entries: [] } } };
export const Empty: Story = { args: { page: { ...page, entries: [], next: null } } };
export const Denied: Story = { args: { page: { state: 'denied', entries: [], next: null } } };
