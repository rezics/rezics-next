import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { MyRealmsPageView } from '../community/my-realms-page';
import type {
  MyRealmsCurrentController,
  MyRealmsCurrentRow,
  MyRealmsNativePage,
} from '../community/my-realms-current/contract';
import { formatMyRealmsCurrent } from '../community/my-realms-native';
import recording from '../kernel/recorded/my-realms.json';
import { m } from '../paraglide/messages.js';

// The entry state uses the recorder's actual response. Leave operation states exercise only the selected review UI.
const recorded = formatMyRealmsCurrent(recording as unknown as MyRealmsNativePage);
const member = recorded.realms[0];
if (!member) throw new Error('The My Realms response recording must contain its current member.');

const leaveAdvice = {
  state: 'available',
  method: 'DELETE',
  path: `/v1/realms/${member.realmId}/membership`,
  body: null,
  expectedStatus: 202,
} as const;
const selectedLeave: MyRealmsCurrentRow = {
  ...member,
  current: {
    ...member.current,
    actions: { ...member.current.actions, leave: leaveAdvice },
  },
};

function reviewController(phase: 'pending' | 'uncertain'): MyRealmsCurrentController {
  return {
    ready: true,
    review: {
      row: selectedLeave,
      phase,
      standing: 'member',
      ...(phase === 'pending' ? { workflowId: 'recorded-pending-operation' } : {}),
      retryAllowed: phase === 'uncertain',
    },
    select() {},
    cancel() {},
    confirm() {},
    retry() {},
    refresh() {},
    discard() {},
  };
}

const meta = {
  title: 'Community/My Realms Current Entry',
  id: 'pages-community-my-realms-current-entry',
  component: MyRealmsPageView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Member entry uses the refreshed kernel recording. Pending and uncertain review states use a static controller fixture to show the selected UI; they do not execute membership commands.',
      },
    },
  },
  args: { page: { signedIn: true, realms: [member], next: null } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: m.realms_heading() })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: args.page.realms[0]!.name })).toBeVisible();
    await expect(canvas.getByText(args.page.realms[0]!.current.description)).toBeVisible();
    if (args.currentController?.review?.phase === 'pending') {
      const review = canvasElement.querySelector('[data-slot="my-realms-leave-review"]');
      await expect(review).toHaveAttribute('data-phase', 'pending');
      await expect(review).toHaveAttribute('data-workflow-id', 'recorded-pending-operation');
      await expect(review).toHaveTextContent(m.realm_members_current());
    } else if (args.currentController?.review?.phase === 'uncertain') {
      const review = canvasElement.querySelector('[data-slot="my-realms-leave-review"]');
      await expect(review).toHaveAttribute('data-phase', 'uncertain');
      await expect(within(review as HTMLElement).getByText(m.realm_leave_uncertain())).toBeVisible();
      await expect(
        within(review as HTMLElement).getByRole('button', { name: m.realm_leave_retry_same() }),
      ).toBeVisible();
    } else {
      const row = canvasElement.querySelector('[data-slot="my-realms-item"]');
      const enter = args.page.realms[0]!.current.actions.enter;
      if (enter.state === 'available')
        await expect(within(row as HTMLElement).getByRole('link', { name: m.my_realms_open() })).toBeVisible();
      else await expect(within(row as HTMLElement).queryByRole('link', { name: m.my_realms_open() })).toBeNull();
    }
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  },
} satisfies Meta<typeof MyRealmsPageView>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone390' } };
const desktop = { viewport: { value: 'desktop1280' } };

export const MemberEntryPhone: Story = { globals: phone };
export const MemberEntryDesktop: Story = { globals: desktop };

export const SelectedLeavePendingPhone: Story = {
  args: {
    page: { signedIn: true, realms: [selectedLeave], next: null },
    currentController: reviewController('pending'),
  },
  globals: phone,
};
export const SelectedLeavePendingDesktop: Story = {
  args: {
    page: { signedIn: true, realms: [selectedLeave], next: null },
    currentController: reviewController('pending'),
  },
  globals: desktop,
};

export const UncertainExactRetryPhone: Story = {
  args: {
    page: { signedIn: true, realms: [selectedLeave], next: null },
    currentController: reviewController('uncertain'),
  },
  globals: phone,
};
export const UncertainExactRetryDesktop: Story = {
  args: {
    page: { signedIn: true, realms: [selectedLeave], next: null },
    currentController: reviewController('uncertain'),
  },
  globals: desktop,
};
