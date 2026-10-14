import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { messages as manageMessages } from '../manage/messages.ts';
import { accessMessages } from '../manage/settings-messages.ts';
import { date } from '../manage/format.ts';
import { decisionPhases, invitationPhases, refusedSelections, withdrawalPhases } from './membership-recorded-paths.ts';
import { RecordedMembershipPage } from './realm-membership-recorded-page.tsx';
import { recordedSample } from './realm-membership-recorded-page.ts';
import { realmHref } from './route.ts';

const record = membershipRecord as AnswerRecord;
const t = accessMessages.en;
const manage = materializeData(manageMessages, { locale: 'en' });
const phone = { viewport: { value: 'phone' } };
const meta = {
  title: 'Realm/Recorded membership transitions',
  component: RecordedMembershipPage,
  args: { record, locale: 'en' },
  parameters: { controls: { disable: true }, route: { pathname: '/en/manage/r/recorded/requests' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedMembershipPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function noOverflow(canvasElement: HTMLElement) {
  const root = canvasElement.ownerDocument.documentElement;
  await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
}

function refused(persona: 'member' | 'moderator' | 'stranger' | 'operator'): Story {
  return {
    args: { persona, selections: refusedSelections(record, persona), surface: 'requests' },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const joined = persona === 'member' || persona === 'moderator';
      const profile = recordedSample(record, persona, `${joined ? 'frame' : 'join'}-acting-agent-profile`).answer as { displayName: string };
      await expect(canvas.findByRole('heading', { level: 2, name: joined ? manage.deniedTitle : manage.missingTitle })).resolves.toBeVisible();
      await expect(canvas.getByText(profile.displayName)).toBeVisible();
      if (joined) {
        const header = recordedSample(record, persona, 'management-refused-realm-header').answer as { name: { value: string } };
        await expect(canvas.getByRole('heading', { level: 1, name: header.name.value })).toBeVisible();
      } else await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(canvas.queryByRole('button', { name: t.approve })).toBeNull();
      await expect(canvas.queryByRole('button', { name: t.decline })).toBeNull();
      await expect(canvas.queryByRole('searchbox', { name: t.search })).toBeNull();
      await noOverflow(canvasElement);
    },
  };
}

export const MemberRefusedFrame: Story = refused('member');
export const MemberRefusedFramePhone: Story = { ...MemberRefusedFrame, globals: phone };
export const ModeratorRefusedFrame: Story = refused('moderator');
export const ModeratorRefusedFramePhone: Story = { ...ModeratorRefusedFrame, globals: phone };
export const StrangerRefusedFrame: Story = refused('stranger');
export const StrangerRefusedFramePhone: Story = { ...StrangerRefusedFrame, globals: phone };
export const OperatorRefusedFrame: Story = refused('operator');
export const OperatorRefusedFramePhone: Story = { ...OperatorRefusedFrame, globals: phone };

async function confirm(canvasElement: HTMLElement, open: string, title: string, label: string, reason?: string) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole('button', { name: open })).toBeEnabled());
  await userEvent.click(canvas.getByRole('button', { name: open }));
  const content = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: title });
  const dialog = within(content);
  if (reason) {
    const input = dialog.getByRole('textbox', { name: t.reason });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, reason);
  }
  await userEvent.click(dialog.getByRole('button', { name: label }));
}

function withdraw(persona: 'stranger' | 'operator'): Story {
  const phases = withdrawalPhases(record, persona);
  return {
    args: { persona, selections: phases[0]!.selections, phases, surface: 'join' },
    parameters: { route: { pathname: realmHref('en', 'recorded') } },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const landing = recordedSample(record, persona, 'join-landing').answer as { name: { value: string } };
      await expect(canvas.findByRole('heading', { level: 1, name: landing.name.value })).resolves.toBeVisible();
      await expect(canvas.findByText(t.pending)).resolves.toBeVisible();
      const body = recordedSample(record, persona, 'withdraw-confirm').body as { reason: string };
      await confirm(canvasElement, t.withdraw, t.withdraw, t.withdraw, body.reason);
      await expect(canvas.findByText(t.withdrawn)).resolves.toBeVisible();
      await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
      await expect(canvas.queryByRole('button', { name: t.withdraw })).toBeNull();
      await expect(canvas.getByRole('button', { name: t.requestJoin })).toBeVisible();
      await expect(canvas.queryByText(t.pending)).toBeNull();
      await userEvent.click(canvas.getByRole('button', { name: t.refreshStatus }));
      await expect(canvas.findByText(t.withdrawn)).resolves.toBeVisible();
      await expect(canvas.queryByRole('button', { name: t.withdraw })).toBeNull();
      await noOverflow(canvasElement);
    },
  };
}

export const StrangerWithdrawalRefresh: Story = withdraw('stranger');
export const StrangerWithdrawalRefreshPhone: Story = { ...StrangerWithdrawalRefresh, globals: phone };
export const OperatorWithdrawalRefresh: Story = withdraw('operator');
export const OperatorWithdrawalRefreshPhone: Story = { ...OperatorWithdrawalRefresh, globals: phone };

function decide(decision: 'accepted' | 'declined'): Story {
  const phases = decisionPhases(record, decision);
  return {
    args: { persona: 'owner', selections: phases[0]!.selections, phases, surface: 'requests' },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const profile = recordedSample(record, 'owner', 'requester-name-stranger').answer as { displayName: string };
      await expect(canvas.findByText(profile.displayName)).resolves.toBeVisible();
      const before = recordedSample(record, 'owner', `decision-confirm-inbox-${decision}`).answer as { items: { reason: string }[] };
      await expect(canvas.getByText(before.items[0]!.reason)).toBeVisible();
      const body = recordedSample(record, 'owner', `decision-confirm-${decision}`).body as { reason: string };
      const action = decision === 'accepted' ? t.approve : t.decline;
      await waitFor(() => expect(canvas.getByRole('button', { name: action })).toBeEnabled());
      await userEvent.click(canvas.getByRole('button', { name: action }));
      const content = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: action });
      const dialog = within(content);
      const input = dialog.getByRole('textbox', { name: t.reason });
      await waitFor(() => expect(input).toHaveFocus());
      await userEvent.type(input, body.reason);
      // This production refresh keeps the selected request and entered reason,
      // while replacing the inbox and request CAS heads from Main's answer.
      await userEvent.click(dialog.getByRole('button', { name: t.refresh }));
      await waitFor(() => expect(dialog.getByRole('button', { name: t.refresh })).toBeEnabled());
      await expect(dialog.getByText(profile.displayName)).toBeVisible();
      await expect(input).toHaveValue(body.reason);
      await userEvent.click(dialog.getByRole('button', { name: action }));
      await expect(canvas.findByText(decision === 'accepted' ? t.approved : t.decisionDeclined)).resolves.toBeVisible();
      await expect(canvas.findByText(t.empty)).resolves.toBeVisible();
      await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
      await expect(canvas.queryByText(profile.displayName)).toBeNull();
      await expect(canvas.queryByText(before.items[0]!.reason)).toBeNull();
      await expect(canvas.queryByRole('button', { name: t.approve })).toBeNull();
      await expect(canvas.queryByRole('button', { name: t.decline })).toBeNull();
      await userEvent.click(canvas.getByRole('button', { name: t.refresh }));
      await expect(canvas.findByText(t.empty)).resolves.toBeVisible();
      await expect(canvas.queryByText(profile.displayName)).toBeNull();
      await noOverflow(canvasElement);
    },
  };
}

export const OwnerAcceptanceRefresh: Story = decide('accepted');
export const OwnerAcceptanceRefreshPhone: Story = { ...OwnerAcceptanceRefresh, globals: phone };
export const OwnerDeclineRefresh: Story = decide('declined');
export const OwnerDeclineRefreshPhone: Story = { ...OwnerDeclineRefresh, globals: phone };

const invitations = invitationPhases(record);
export const OwnerInvitationPage: Story = {
  args: { persona: 'owner', selections: invitations[0]!.selections, phases: invitations, surface: 'members' },
  parameters: { route: { pathname: '/en/manage/r/recorded/members' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { level: 2, name: manage.membersTitle })).resolves.toBeVisible();
    await expect(canvas.findByText(manage.noOutgoingInvitations)).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: manage.inviteMember }));
    const content = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: manage.inviteTitle });
    const dialog = within(content);
    const body = recordedSample(record, 'owner', 'invitation-confirm').body as { member: string; expiresInSeconds: number };
    await userEvent.type(dialog.getByRole('textbox', { name: manage.whoLabel }), body.member);
    await expect(dialog.getByRole('combobox', { name: manage.inviteExpiresLabel })).toHaveTextContent(manage.duration7d);
    await userEvent.click(dialog.getByRole('button', { name: manage.inviteConfirm }));
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
    const invitation = (recordedSample(record, 'owner', 'invitation-confirm').answer as { invitation: { expiresAt: string } }).invitation;
    await expect(canvas.findByText(`${manage.invitationPending} · ${manage.invitationExpiry({ date: date(invitation.expiresAt, 'en') })}`)).resolves.toBeVisible();
    const profile = recordedSample(record, 'owner', 'members-after-invitation-name-member').answer as { displayName: string };
    await expect(canvas.findByText(profile.displayName)).resolves.toBeVisible();
    await expect(canvas.queryByText(manage.noOutgoingInvitations)).toBeNull();
    await expect(canvas.getByRole('button', { name: manage.cancelInvitation })).toBeVisible();
    await noOverflow(canvasElement);
  },
};
export const OwnerInvitationPagePhone: Story = { ...OwnerInvitationPage, globals: phone };
