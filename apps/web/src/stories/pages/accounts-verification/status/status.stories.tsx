import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../../paraglide/messages.js';
import { PageStory } from '../../../page';
import { accountId, selectVerificationStory, viewport } from '../fixtures';

const meta = {
  title: 'Account/Verification status',
  id: 'pages-account-verification-status',
  parameters: { layout: 'fullscreen', viewport },
  beforeEach: () => selectVerificationStory('pending'),
  render: () => <PageStory visitor="Signed In" path={`/accounts/${accountId}/verification`} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.av_pending());
    await userEvent.click(view.getByRole('button', { name: m.av_withdraw() }));
    await userEvent.click(view.getByRole('button', { name: m.av_cancel() }));
    await expect(view.getByRole('button', { name: m.av_withdraw() })).toBeVisible();
  },
};
export const ApprovedAwaitingPublication: Story = {
  beforeEach: () => selectVerificationStory('approved'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.av_publication_pending());
    expect(view.queryByText(m.av_verified({ subject: 'Mira Okabe' }))).toBeNull();
  },
};
export const Verified: Story = {
  beforeEach: () => selectVerificationStory('verified'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.av_verified({ subject: 'Mira Okabe' }))).toBeVisible();
    await expect(view.getByRole('option', { name: m.av_revoke() })).toBeInTheDocument();
  },
};
export const VerifiedRevocationJourney: Story = {
  tags: ['!dev'],
  beforeEach: () => selectVerificationStory('verified'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.av_verified({ subject: 'Mira Okabe' }));
    await userEvent.selectOptions(view.getByLabelText(m.av_decision()), 'revoke');
    await userEvent.type(
      view.getByRole('textbox', { name: m.av_reason() }),
      'The account holder confirmed that representation has ended.',
    );
    await userEvent.click(view.getByRole('button', { name: m.av_revoke() }));
    await userEvent.click(view.getByRole('button', { name: m.av_confirm_button() }));
    await view.findByText(m.av_reversal_accepted());
  },
};
export const Rejected: Story = { beforeEach: () => selectVerificationStory('rejected') };
export const Empty: Story = { beforeEach: () => selectVerificationStory('empty') };
export const Denied: Story = { beforeEach: () => selectVerificationStory('denied') };
export const Preparing: Story = { tags: ['!dev'], beforeEach: () => selectVerificationStory('preparing') };
export const Unavailable: Story = { tags: ['!dev'], beforeEach: () => selectVerificationStory('unavailable') };
export const Loading: Story = { tags: ['!dev'], beforeEach: () => selectVerificationStory('loading') };
