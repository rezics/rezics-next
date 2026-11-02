import type { Meta, StoryObj } from '@storybook/react-vite';
import { RealmClaimStatusExample, RealmClaimStatusRefreshExample } from './realm-claim-status.stories';
import { expect, userEvent, within } from 'storybook/test';
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
export const SessionWithheld: Story = { args: { scenario: 'withheld' } };
export const ReferenceDetails = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const summary = within(canvasElement).getByText(m.realm_status_details_reference());
    await userEvent.click(summary);
    await expect(canvasElement.querySelector('details')).toHaveAttribute('open');
  },
} satisfies Story;
export const Wrapping390: Story = {
  args: { scenario: 'pending' },
  globals: { locale: 'de', viewport: { value: 'phone390', isRotated: false } },
  play: ReferenceDetails.play,
};
export const Wrapping1280: Story = {
  args: { scenario: 'approved' },
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
  play: ReferenceDetails.play,
};
export const RightToLeft: Story = {
  args: { scenario: 'obsolete' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: (args) => (
    <div dir="rtl">
      <RealmClaimStatusExample {...args} />
    </div>
  ),
  play: ReferenceDetails.play,
};
export const RefreshBusy: Story = {
  render: () => <RealmClaimStatusRefreshExample />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('button', { name: m.realm_claim_status_checking() })).toBeDisabled();
    await expect(view.getByRole('link', { name: m.realm_claim_status_back() })).toBeVisible();
    await expect(canvasElement.querySelectorAll('time, details')).toHaveLength(0);
  },
};
