import type { Meta, StoryObj } from '@storybook/react-vite';
import { RealmClaimStatusExample } from './realm-claim-status.stories';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Patterns/Community/Realm Claim Status',
  component: RealmClaimStatusExample,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RealmClaimStatusExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = { args: { scenario: 'pending' } };
export const Approved: Story = { args: { scenario: 'approved' } };
export const Unrelated: Story = { args: { scenario: 'unrelated' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Reload: Story = {
  args: { scenario: 'reload', receiptRecovery: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('link', { name: m.realm_claim_status_open() })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_claim_request() })).toBeNull();
  },
};
export const ObsoleteEpisode: Story = { args: { scenario: 'obsolete' } };
