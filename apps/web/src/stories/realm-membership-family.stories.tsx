import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { RealmParticipationView } from '../community/realm-participation';
import { RealmLeaveRecovery } from '../community/realm-leave-recovery.tsx';
import { FollowControl } from '../library/follow-control';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const firstChange = fn();
const secondChange = fn();
const firstCheck = fn();
const secondCheck = fn();
const retryLeave = fn();
const followWrite = fn(async (input: { following: boolean }) => ({ ok: true as const, following: input.following }));
const longMemberLabel = 'Reading together · translated fiction and community discussions · '.repeat(6).trim();

function MembershipFamily() {
  return (
    <div className="grid min-w-0 gap-6 sm:grid-cols-2">
      <div data-testid="first-instance" className="min-w-0 space-y-4">
        <RealmParticipationView
          state="member"
          visibility="public"
          admittedAction="leave"
          ready={false}
          onChange={firstChange}
          onRetry={firstCheck}
        />
        <RealmLeaveRecovery
          realmId="supplied-first-realm"
          recovery={{ kind: 'refused', ownerReason: 'unavailable' }}
          check="unavailable"
          busy={false}
          ready
          onCheck={firstCheck}
          onRetry={retryLeave}
        />
        <section aria-label={m.space_follow_label()} className="p-4">
          <FollowControl
            targetId="supplied-independent-space"
            initial={{ state: 'ready', following: true }}
            ready
            canFollow
            canRemove
            write={followWrite}
          />
        </section>
      </div>
      <div data-testid="second-instance" className="min-w-0 space-y-4">
        <RealmParticipationView
          state="member"
          visibility="protected"
          admittedAction="leave"
          ready={false}
          memberLabel={longMemberLabel}
          onChange={secondChange}
          onRetry={secondCheck}
        />
        <RealmLeaveRecovery
          realmId="supplied-second-realm"
          recovery={{ kind: 'uncertain', ownerReason: 'unavailable' }}
          check="unchanged"
          busy={false}
          ready
          onCheck={secondCheck}
          onRetry={retryLeave}
        />
      </div>
      <div data-testid="allowed-join">
        <RealmParticipationView
          state="none"
          visibility="public"
          admittedAction="join"
          onChange={firstChange}
          onRetry={firstCheck}
        />
      </div>
      <div data-testid="allowed-leave">
        <RealmParticipationView
          state="member"
          visibility="public"
          admittedAction="leave"
          onChange={secondChange}
          onRetry={secondCheck}
        />
      </div>
      <div data-testid="denied">
        <RealmParticipationView
          state="member"
          visibility="public"
          admittedAction={null}
          problem={{ outcome: 'refused', detail: 'WITHHELD_NATIVE_DETAIL' }}
          onChange={firstChange}
          onRetry={firstCheck}
        />
      </div>
      <div data-testid="loading">
        <RealmParticipationView state="loading" visibility="public" onChange={firstChange} onRetry={firstCheck} />
      </div>
      <div data-testid="banned">
        <RealmParticipationView state="banned" visibility="public" onChange={firstChange} onRetry={firstCheck} />
      </div>
      <div data-testid="protected">
        <RealmParticipationView state="none" visibility="protected" onChange={firstChange} onRetry={firstCheck} />
      </div>
      <div data-testid="failed-refresh">
        <RealmParticipationView
          state="pending"
          visibility="public"
          refresh="unavailable"
          onChange={firstChange}
          onRetry={firstCheck}
        />
      </div>
      <div data-testid="checking">
        <RealmParticipationView
          state="pending"
          visibility="public"
          refresh="checking"
          busy
          onChange={firstChange}
          onRetry={firstCheck}
        />
      </div>
      <div data-testid="busy">
        <RealmParticipationView state="member" visibility="public" busy onChange={firstChange} onRetry={firstCheck} />
      </div>
      <div data-testid="unavailable">
        <RealmParticipationView state="unavailable" visibility="public" onChange={firstChange} onRetry={firstCheck} />
      </div>
      <div data-testid="owner-required">
        <RealmLeaveRecovery
          realmId="supplied-owner-realm"
          recovery={{ kind: 'refused', ownerReason: 'last-owner' }}
          check="checking"
          busy
          ready
          onCheck={firstCheck}
          onRetry={retryLeave}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Community/Realm Membership Family',
  id: 'patterns-community-realm-membership-family',
  component: MembershipFamily,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'UNRUN presentation observations of supplied states and independent callbacks. No native membership, ownership or settlement proof. Review the same stories at 390/1280, enlarged text, light/dark and locale globals; the RTL story preserves the same actions and complete long label.',
      },
    },
  },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed Out">
        <Story />
      </PatternStory>
    ),
  ],
  beforeEach: () => {
    for (const action of [firstChange, secondChange, firstCheck, secondCheck, retryLeave, followWrite])
      action.mockClear();
  },
} satisfies Meta<typeof MembershipFamily>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteHierarchy: Story = {
  name: 'Complete Realm membership and leave recovery hierarchy',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = within(canvas.getByTestId('first-instance'));
    const second = within(canvas.getByTestId('second-instance'));
    const sections = canvasElement.querySelectorAll('section[aria-labelledby]');
    const ids = [...sections].map((section) => section.getAttribute('aria-labelledby'));
    await expect(new Set(ids).size).toBe(ids.length);
    for (const section of sections) {
      await expect(within(section as HTMLElement).getByRole('heading', { level: 2 })).toBeVisible();
      await expect(section.querySelector('details, [hidden], button button, a button')).toBeNull();
      for (const control of section.querySelectorAll('button')) {
        const bounds = control.getBoundingClientRect();
        await expect(bounds.height).toBeGreaterThanOrEqual(44);
        await expect(bounds.width).toBeGreaterThanOrEqual(44);
        if (!control.disabled) {
          control.focus();
          await expect(control).toHaveFocus();
        }
      }
    }
    await expect(canvasElement.innerHTML).not.toContain('WITHHELD_NATIVE_DETAIL');
    await expect(first.queryByRole('link')).toBeNull();
    await expect(second.queryByRole('link')).toBeNull();
    await expect(first.getByText(m.realm_leave_owner_policy())).toBeVisible();
    await expect(first.queryByText(m.realm_leave_owner_required())).toBeNull();
    await expect(second.getByText(m.realm_leave_uncertain())).toBeVisible();
    await expect(second.queryByRole('button', { name: m.realm_leave_review_access() })).toBeNull();
    await expect(second.getByText(longMemberLabel, { exact: true })).toBeVisible();
    await expect(within(canvas.getByTestId('protected')).queryByRole('button', { name: m.realm_join() })).toBeNull();
    await expect(within(canvas.getByTestId('protected')).getByText(m.realm_protected_admission())).toBeVisible();
    await expect(within(canvas.getByTestId('denied')).getByRole('alert')).toHaveTextContent(m.realm_change_failed());
    await expect(within(canvas.getByTestId('denied')).queryByRole('button', { name: m.realm_leave() })).toBeNull();
    await expect(within(canvas.getByTestId('loading')).getByRole('status')).toHaveTextContent(
      m.realm_membership_loading(),
    );
    await expect(within(canvas.getByTestId('banned')).getByRole('status')).toHaveTextContent(m.realm_banned());
    await expect(within(canvas.getByTestId('unavailable')).getByRole('status')).toHaveTextContent(
      m.realm_membership_unavailable(),
    );
    const failed = within(canvas.getByTestId('failed-refresh'));
    await expect(failed.getByRole('status')).toHaveTextContent(m.realm_membership_pending_unavailable());
    await expect(failed.queryByRole('button', { name: m.realm_leave() })).toBeNull();
    await expect(within(canvas.getByTestId('checking')).queryByRole('button')).toBeNull();
    await expect(within(canvas.getByTestId('busy')).getByRole('button', { name: m.realm_leave() })).toBeDisabled();
    const owner = within(canvas.getByTestId('owner-required'));
    await expect(owner.getByText(m.realm_leave_owner_required())).toBeVisible();
    await expect(owner.getByRole('button', { name: m.realm_membership_retry() })).toBeDisabled();

    await expect(first.getByRole('button', { name: m.realm_leave() })).toBeDisabled();
    await expect(second.getByRole('button', { name: m.realm_leave() })).toBeDisabled();
    within(canvas.getByTestId('allowed-join')).getByRole('button', { name: m.realm_join() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(firstChange).toHaveBeenCalledWith('join');
    await expect(secondChange).not.toHaveBeenCalled();
    within(canvas.getByTestId('allowed-leave')).getByRole('button', { name: m.realm_leave() }).focus();
    await userEvent.keyboard(' ');
    await expect(secondChange).toHaveBeenCalledWith('leave');
    second.getByRole('button', { name: m.realm_membership_retry() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(secondCheck).toHaveBeenCalledTimes(1);
    await expect(retryLeave).not.toHaveBeenCalled();
    second.getByRole('button', { name: m.realm_leave_retry_same() }).focus();
    await userEvent.keyboard(' ');
    await expect(retryLeave).toHaveBeenCalledTimes(1);
    failed.getByRole('button', { name: m.realm_membership_retry() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(firstCheck).toHaveBeenCalledTimes(1);
    await expect(firstChange).toHaveBeenCalledTimes(1);
    first.getByRole('button', { name: m.realm_leave_review_access() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(first.getByText(m.realm_leave_access_note())).toBeVisible();
    await expect(second.queryByText(m.realm_leave_access_note())).toBeNull();
    await expect(first.queryByRole('link')).toBeNull();
    await userEvent.click(first.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(first.getByRole('button', { name: m.library_follow() })).toBeVisible();
    await expect(followWrite).toHaveBeenCalledTimes(1);
    await expect(firstChange).toHaveBeenCalledTimes(1);
    await expect(secondChange).toHaveBeenCalledTimes(1);
  },
};

export const LongTextAndRtl: Story = {
  render: () => (
    <div
      data-testid="long-text-surface"
      dir="rtl"
      className="[&_button]:text-xl [&_p]:text-xl [&_[data-slot=badge]]:text-xl"
    >
      <MembershipFamily />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const surface = canvas.getByTestId('long-text-surface');
    for (const width of [390, 1280]) {
      surface.style.width = `${width}px`;
      for (const direction of ['ltr', 'rtl']) {
        surface.dir = direction;
        await expect(canvas.getByText(longMemberLabel, { exact: true })).toBeVisible();
        for (const section of surface.querySelectorAll<HTMLElement>('section[aria-labelledby]')) {
          for (const text of section.querySelectorAll<HTMLElement>('p, [data-slot="badge"], button'))
            await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
          for (const control of section.querySelectorAll('button')) {
            const bounds = control.getBoundingClientRect();
            await expect(bounds.height).toBeGreaterThanOrEqual(44);
            await expect(bounds.width).toBeGreaterThanOrEqual(44);
          }
        }
      }
    }
    surface.style.removeProperty('width');
    surface.dir = 'rtl';
  },
};
