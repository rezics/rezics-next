import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from './page';
import { leaveRecoveryStory } from './patterns/realm-leave-recovery/example';

const meta = {
  title: 'Pages/Community/Realm Leave Recovery',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const OwnerRequired: Story = leaveRecoveryStory('owner-required');
export const GenericRefusal: Story = leaveRecoveryStory('generic-refusal');
export const AccessDenied: Story = leaveRecoveryStory('access-denied');
export const UncertainRetry: Story = leaveRecoveryStory('uncertain-retry');
export const AcceptedPending: Story = leaveRecoveryStory('accepted-pending');
