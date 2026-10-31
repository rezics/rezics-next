import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ErasureProgressView } from '../../accounts/erasure-progress/view';
import { AccountErasurePage } from '../../accounts/erasure-progress/page';
import type { ErasureStatus, Page } from '../../accounts/erasure-progress/data';
import { m } from '../../paraglide/messages.js';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';

const meta = {
  title: 'Pages/Account/Erasure progress',
  component: ErasureProgressView,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Illustrative consumer states only. These stories provide no native erasure or participant proof.',
      },
    },
  },
  render: (args) => (
    <PatternStory
      visitor={args.page.status === 'signed-out' ? 'Signed Out' : 'Signed In'}
      path={`/platform/accounts/${value.accountId}/erasure`}
    >
      <AppShell>
        <ErasureProgressView {...args} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement, args, step }) => {
    await step(
      'Erasure progress page stories expose one main without turning illustrative complete or missing participant evidence into native erasure proof',
      async () => {
        const canvas = within(canvasElement);
        const main = within(await canvas.findByRole('main'));
        await expect(canvas.getAllByRole('main')).toHaveLength(1);
        await expect(main.getByRole('heading', { level: 1, name: m.erasure_title() })).toBeVisible();
        if (args.page.status !== 'ready') {
          await expect(main.getByRole('status')).toBeVisible();
          return;
        }
        const { state, pendingParticipants } = args.page.value;
        const heading = {
          pending: m.erasure_pending,
          'retention-outstanding': m.erasure_retention,
          complete: m.erasure_complete,
        }[state]();
        await expect(main.getByRole('heading', { level: 2, name: heading })).toBeVisible();
        if (state === 'complete') {
          await expect(main.getByText(m.erasure_complete_help())).toBeVisible();
        } else {
          await expect(main.queryByRole('heading', { level: 2, name: m.erasure_complete() })).not.toBeInTheDocument();
          if (state === 'pending' && pendingParticipants.length === 0) {
            await expect(main.getByText(m.erasure_no_pending_names())).toBeVisible();
            await expect(main.getByText(m.erasure_pending_help())).toBeVisible();
          }
        }
      },
    );
  },
} satisfies Meta<typeof ErasureProgressView>;
export default meta;
type Story = StoryObj<typeof meta>;
const value: ErasureStatus = {
  accountId: '019a0000-0000-7000-8000-000000000001',
  state: 'pending',
  at: '2026-10-01T10:00:00.000Z',
  completedAt: null,
  pendingParticipants: ['auth', 'shared-history'],
  retentionOutstanding: false,
  lateItems: true,
  effectsFrontier: true,
};
const ready = (value: ErasureStatus): Page => ({
  status: 'ready',
  viewerId: '019a0000-0000-7000-8000-000000000002',
  value,
});
export const Pending: Story = { args: { page: ready(value) } };
export const MissingParticipantProof: Story = {
  args: { page: ready({ ...value, pendingParticipants: [], lateItems: false, effectsFrontier: false }) },
};
export const RetentionOutstanding: Story = {
  args: {
    page: ready({
      ...value,
      state: 'retention-outstanding',
      completedAt: '2026-10-02T10:00:00.000Z',
      pendingParticipants: [],
      retentionOutstanding: true,
      lateItems: false,
      effectsFrontier: false,
    }),
  },
};
export const Complete: Story = {
  args: {
    page: ready({
      ...value,
      state: 'complete',
      completedAt: '2026-10-02T10:00:00.000Z',
      pendingParticipants: [],
      lateItems: false,
      effectsFrontier: false,
    }),
  },
};
export const Missing: Story = { args: { page: { status: 'missing' } } };
export const Denied: Story = { args: { page: { status: 'denied' } } };
export const SignedOut: Story = {
  args: { page: { status: 'signed-out' } },
  render: () => (
    <PatternStory visitor="Signed Out" path={`/platform/accounts/${value.accountId}/erasure`}>
      <AppShell><AccountErasurePage accountId={value.accountId} /></AppShell>
    </PatternStory>
  ),
};
export const Unavailable: Story = { args: { page: { status: 'unavailable' } } };
export const Loading: Story = { args: { page: { status: 'loading' } } };

export const SessionUnavailable: Story = {
  args: { page: { status: 'unavailable' } },
  parameters: {
    docs: { description: { story: 'The existing illustrative session has no valid current account subject. The default page offers a real session read retry without reading erasure data.' } },
  },
  render: () => (
    <PatternStory visitor="Signed In" path={`/platform/accounts/${value.accountId}/erasure`}>
      <AppShell><AccountErasurePage accountId={value.accountId} /></AppShell>
    </PatternStory>
  ),
};
