import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PageStory, pageReady } from './page';
import { interfaceCursors, interfaceRealmTitle } from '../kernel/fake/realm-home-interface';
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

const earlierId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const earlier: MyRealmsCurrentRow = {
  ...selectedLeave,
  realmId: earlierId,
  name: 'Illustrative earlier Realm',
  current: {
    ...selectedLeave.current,
    description: 'Illustrative membership before the selected Realm.',
    destination: { ...selectedLeave.current.destination, realmId: earlierId },
    actions: {
      ...selectedLeave.current.actions,
      enter: { state: 'prohibited', reason: 'not_authorized' },
      manage: { state: 'prohibited', reason: 'not_authorized' },
      leave: { ...leaveAdvice, path: `/v1/realms/${earlierId}/membership` },
    },
  },
};
const illustrativePage = { signedIn: true, realms: [earlier, selectedLeave], next: null };

// Presentation-only fixture: the real controller owns retirement and original command operands.
function IllustrativeReview({ controller }: { controller: MyRealmsCurrentController }) {
  const [review, setReview] = useState(controller.review);
  const [retired, setRetired] = useState(false);
  return (
    <>
      <p>Illustrative review interactions; no membership command or session change is executed.</p>
      <MyRealmsPageView
        page={retired ? { ...illustrativePage } : illustrativePage}
        currentController={{
          ...controller,
          review: retired ? null : review,
          select: (row) => setReview({ ...controller.review!, row }),
          discard: () => setReview(null),
        }}
      />
      <button type="button" onClick={() => setRetired(true)}>
        Replace illustrative page/session
      </button>
    </>
  );
}

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
    retry: fn(),
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
          'Member entry uses the refreshed kernel recording. Pending and uncertain reviews, including the earlier Realm, use illustrative presentation fixtures; they do not execute membership commands.',
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

const phone = {};

export const MemberEntry: Story = { globals: phone };

export const SelectedLeavePending: Story = {
  args: {
    page: illustrativePage,
    currentController: reviewController('pending'),
  },
  globals: phone,
};

export const UncertainExactRetry: Story = {
  render: (args) => <IllustrativeReview controller={args.currentController!} />,
  args: {
    page: illustrativePage,
    currentController: reviewController('uncertain'),
  },
  globals: phone,
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const leaves = view.getAllByRole('button', { name: m.realm_leave() });
    const leave = leaves[1]!;
    const top = leave.getBoundingClientRect().top;
    await userEvent.click(leave);
    await expect(leave.getBoundingClientRect().top).toBe(top);
    const focus = fn(leave.focus.bind(leave));
    leave.focus = focus;
    const review = view.getByRole('region', { name: m.my_realms_leave_review() });
    await expect(review.previousElementSibling).toContainElement(leave);
    await expect(leave).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(review).toBeVisible();
    await userEvent.tab();
    const retry = within(review).getByRole('button', { name: m.realm_leave_retry_same() });
    await expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.currentController!.retry).toHaveBeenCalledTimes(1);
    await expect(review).toHaveTextContent(m.realm_leave_uncertain());
    await userEvent.keyboard('{Escape}');
    await expect(review).toBeVisible();
    await userEvent.click(within(review).getByRole('button', { name: m.realm_membership_command_discard() }));
    await expect(leave).toHaveFocus();
    await expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await userEvent.click(leaves[0]!);
    await expect(
      view.getByRole('region', { name: m.my_realms_leave_review() }).previousElementSibling,
    ).toContainElement(leaves[0]!);
    await userEvent.click(leave);
    await expect(view.getAllByRole('region', { name: m.my_realms_leave_review() })).toHaveLength(1);
    await userEvent.click(
      within(view.getByRole('region', { name: m.my_realms_leave_review() })).getByRole('button', {
        name: m.realm_membership_command_discard(),
      }),
    );
    await expect(leave).toHaveFocus();
    await userEvent.click(leave);
    const replacement = view.getByRole('button', { name: 'Replace illustrative page/session' });
    await userEvent.click(replacement);
    await expect(view.queryByRole('region', { name: m.my_realms_leave_review() })).toBeNull();
    await expect(replacement).toHaveFocus();
  },
};

export const RoutedMemberEntry: Story = {
  name: 'Actual route · member entry',
  render: () => (
    <PageStory visitor="Signed In" credentialMode="session" path={`/realms?cursor=${interfaceCursors.member}`} />
  ),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(within(canvasElement).getByRole('main'));
    await expect(await view.findByRole('heading', { level: 2, name: interfaceRealmTitle })).toBeVisible();
    await expect(view.getByRole('link', { name: m.my_realms_open() })).toBeVisible();
    await expect(view.getByRole('link', { name: m.my_realms_manage() })).toBeVisible();
    await expect(view.queryByRole('region', { name: m.my_realms_leave_review() })).toBeNull();
  },
};

export const RoutedWithheldDestination: Story = {
  name: 'Actual route · membership with withheld destination',
  render: () => (
    <PageStory visitor="Signed In" credentialMode="session" path={`/realms?cursor=${interfaceCursors.withheld}`} />
  ),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(within(canvasElement).getByRole('main'));
    await expect(await view.findByRole('heading', { level: 2, name: interfaceRealmTitle })).toBeVisible();
    await expect(view.queryByRole('link', { name: m.my_realms_open() })).toBeNull();
    await expect(view.queryByRole('link', { name: m.my_realms_manage() })).toBeNull();
    await expect(view.getByText(m.my_realms_action_prohibited({ action: m.my_realms_open() }))).toBeVisible();
  },
};

export const RoutedDeliberateLeave: Story = {
  name: 'Actual route · deliberate leave review and cancel',
  render: () => (
    <PageStory visitor="Signed In" credentialMode="session" path={`/realms?cursor=${interfaceCursors.member}`} />
  ),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const main = within(canvasElement).getByRole('main');
    const view = within(main);
    const leave = await view.findByRole('button', { name: m.realm_leave() });
    await expect(leave).toHaveAttribute('aria-expanded', 'false');
    const focus = fn(leave.focus.bind(leave));
    leave.focus = focus;
    leave.focus();
    const top = leave.getBoundingClientRect().top;
    await userEvent.keyboard('{Enter}');
    const review = await view.findByRole('region', { name: m.my_realms_leave_review() });
    await expect(leave).toHaveFocus();
    await expect(leave.getBoundingClientRect().top).toBe(top);
    await expect(review.closest('[data-slot="my-realms-item"]')).toBeNull();
    await expect(review.parentElement?.tagName).toBe('LI');
    await expect(review.previousElementSibling).toContainElement(leave);
    await expect(leave).toHaveAttribute('aria-controls', review.id);
    await expect(view.getByRole('link', { name: m.my_realms_open() })).toBeVisible();
    await expect(within(review).getByText(m.my_realms_leave_confirm({ realm: interfaceRealmTitle }))).toBeVisible();
    await userEvent.tab();
    await expect(within(review).getByRole('button', { name: m.my_realms_leave_confirm_button() })).toHaveFocus();
    await userEvent.tab();
    await expect(within(review).getByRole('button', { name: m.action_cancel() })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(view.queryByRole('region', { name: m.my_realms_leave_review() })).toBeNull();
    await expect(leave).toHaveFocus();
    await expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await userEvent.click(leave);
    await expect(leave).toHaveFocus();
    await userEvent.click(
      within(view.getByRole('region', { name: m.my_realms_leave_review() })).getByRole('button', {
        name: m.action_cancel(),
      }),
    );
    await expect(leave).toHaveFocus();
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  },
};

export const RoutedSparseContinuation: Story = {
  name: 'Actual route · sparse inventory keeps continuation',
  render: () => (
    <PageStory visitor="Signed In" credentialMode="session" path={`/realms?cursor=${interfaceCursors.sparse}`} />
  ),
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const view = within(within(canvasElement).getByRole('main'));
    await expect(await view.findByText(m.realm_list_details_sparse_page_empty())).toBeVisible();
    await expect(view.queryByText(m.realms_empty())).toBeNull();
    const next = view.getByRole('link', { name: m.realms_more() });
    await expect(new URL(next.getAttribute('href')!, location.origin).searchParams.get('cursor')).toBe(
      interfaceCursors.next,
    );
    await userEvent.click(next);
    await expect(await view.findByRole('heading', { level: 2, name: interfaceRealmTitle })).toBeVisible();
    await expect(view.getByRole('link', { name: m.prq_previous() })).toBeVisible();
  },
};
