import type { Meta, StoryObj } from '@storybook/react-vite';
import { leaveRecoveryStory, RealmLeaveExample } from './example';

const meta = {
  title: 'Patterns/Community/Realm Leave Recovery',
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
