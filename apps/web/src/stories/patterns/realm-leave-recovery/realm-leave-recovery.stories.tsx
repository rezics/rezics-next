import type { Meta, StoryObj } from '@storybook/react-vite';
import { leaveRecoveryStory, RealmLeaveExample } from './example';
import { expect, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';

const meta = {
  title: 'Community/Realm Leave Recovery Workflow',
  id: 'patterns-community-realm-leave-recovery',
  component: RealmLeaveExample,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RealmLeaveExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OwnerRequired: Story = leaveRecoveryStory('owner-required');
export const GenericRefusal: Story = leaveRecoveryStory('generic-refusal');
export const AccessDenied: Story = leaveRecoveryStory('access-denied');
export const UncertainRetry: Story = leaveRecoveryStory('uncertain-retry');
export const AcceptedPending: Story = leaveRecoveryStory('accepted-pending');

const hierarchy = leaveRecoveryStory('access-denied');
export const RecoverySectionHierarchy: Story = {
  ...hierarchy,
  play: async (context) => {
    await hierarchy.play!(context);
    const canvas = within(context.canvasElement);
    const membership = canvas.getByRole('region', { name: m.realm_membership_label() });
    await expect(within(membership).getByRole('heading', { level: 2, name: m.realm_membership_label() })).toBeVisible();
    const recovery = canvas.getByRole('region', { name: m.realm_leave_recovery_label() });
    await expect(
      within(recovery).getByRole('heading', { level: 2, name: m.realm_leave_recovery_label() }),
    ).toBeVisible();
    await expect(within(recovery).getByText(m.realm_leave_owner_required())).toBeVisible();
    await expect(within(recovery).getByText(m.realm_leave_access_note())).toBeVisible();
    await expect(recovery.querySelector('details, a')).toBeNull();
  },
};
