import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ModerationAppealsView } from '../moderation/appeals-tab';
import { ModerationReportsView } from '../moderation/reports-page';
import type { ReportActionInput } from '../moderation/actions';
import { m } from '../paraglide/messages.js';
import { moderationQueueFixture, resolvedQueueFixture } from './patterns/moderation-queue.stories';

const meta = {
  title: 'Pages/Community/Moderation reports',
  component: ModerationReportsView,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: {
    ...moderationQueueFixture,
    next: 'cursor-next',
    onNext: fn(),
    onAction: fn(async (_input: ReportActionInput): Promise<void> => {
      throw new TypeError('Failed to fetch');
    }),
  },
} satisfies Meta<typeof ModerationReportsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OpenReports: Story = {
  name: 'Open reports',
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('navigation', { name: m.moderation_tabs_label() })).toBeVisible();
    await expect(view.getAllByRole('textbox', { name: m.moderation_reason_label() })).toHaveLength(2);
    await userEvent.type(view.getAllByRole('textbox')[0]!, 'Private address disclosure.');
    await userEvent.click(view.getAllByRole('button', { name: m.moderation_take_down() })[0]!);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_action_failed());
    await expect(view.getAllByRole('textbox')[0]!).toHaveValue('Private address disclosure.');
    await userEvent.click(view.getByRole('button', { name: m.threads_next_page() }));
    await expect(args.onNext).toHaveBeenCalledWith('cursor-next');
  },
};

export const ResolvedReports: Story = {
  name: 'Resolved reports',
  args: { ...resolvedQueueFixture, next: null },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_actioned())).toBeVisible();
    await expect(view.getByText(m.moderation_dismissed())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByRole('button')).toBeNull();
  },
};

const appeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000101',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  appellantId: 'private-author',
  statement: 'The post shares the event details participants need. Please restore it.',
  createdAt: '2026-10-29T14:20:00.000Z',
  decision: {
    statement: 'The post includes a private phone number.',
    target: { kind: 'post' as const, id: moderationQueueFixture.reports[0]!.target.id },
  },
  canResolve: true,
};

export const Appeals: Story = {
  render: () => <ModerationAppealsView appeals={[appeal]} targets={moderationQueueFixture.targets} next={null} />,
};
