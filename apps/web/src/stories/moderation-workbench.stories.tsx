import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';
import { m } from '../paraglide/messages.js';
import { workbenchSearch } from '../moderation/workbench-queue/scope';
import { WorkbenchPreparing, WorkbenchView, type WorkbenchViewProps } from '../moderation/workbench-queue/view';

const search = workbenchSearch({ board: 'community', queue: 'reports' });
const emptyPage = {
  state: 'ready' as const,
  search,
  realms: [],
  realmsNext: null,
  boards: [],
  boardsNext: null,
  cases: [],
  next: null,
};

const meta = {
  title: 'Pages/Moderation/Workbench queue',
  component: WorkbenchView,
  parameters: { layout: 'fullscreen', viewport: { options: queueViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/moderation/workbench">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    page: emptyPage,
    onSearch: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof WorkbenchView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Preparation: Story = {
  render: () => <WorkbenchPreparing />,
};

export const Empty: Story = {};

export const Denied: Story = {
  args: { page: { ...emptyPage, state: 'denied' } },
};

export const Unavailable: Story = {
  args: { page: { ...emptyPage, state: 'unavailable' } },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry() }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const Recovery: Story = {
  args: { page: { ...emptyPage, state: 'stale' } },
  play: async ({ canvasElement, args }: { canvasElement: HTMLElement; args: WorkbenchViewProps }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_restart() }));
    await expect(args.onSearch).toHaveBeenCalled();
  },
};
