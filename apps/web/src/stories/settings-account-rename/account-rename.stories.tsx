import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AccountSafetyCard, type AccountSafetyProps } from '../../settings/account-safety';
import { accountRenameNavigation } from '../../settings/adapters/accounts';
import { m } from '../../paraglide/messages.js';

function SignedInAccount(props: Extract<AccountSafetyProps, { state: 'signed-in' }>) {
  return <AccountSafetyCard {...props} />;
}

const meta = {
  title: 'Account/Handle rename',
  id: 'patterns-account-handle-rename',
  component: SignedInAccount,
  parameters: { layout: 'padded' },
  args: {
    state: 'signed-in',
    securityHref: 'https://auth.example.test/security',
    csrfToken: null,
    onReload() {},
    renameAccount: accountRenameNavigation(
      { AUTH_ISSUER: 'https://auth.example.test', AUTH_MANAGEMENT_PAGE_ROUTES: '["/account/rename"]' },
      { accountId: '123e4567-e89b-42d3-a456-426614174000', handle: 'alice', available: true },
    ),
  },
} satisfies Meta<typeof SignedInAccount>;
export default meta;
type Story = StoryObj<typeof meta>;

// Presentation examples only; native rename and Auth confirmation remain owner acceptance debt.
export const CurrentSelf: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: m.settings_account_rename_continue() });
    await expect(link).toHaveAttribute('href', 'https://auth.example.test/account/rename');
    let activated = false;
    link.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        activated = true;
      },
      { once: true },
    );
    link.focus();
    await userEvent.keyboard('{Enter}');
    await expect(activated).toBe(true);
    await expect(link).toHaveFocus();
    await expect(canvas.getByText(m.settings_account_rename_confirmation())).toBeVisible();
  },
};
export const Handleless: Story = {
  args: {
    renameAccount: accountRenameNavigation(
      { AUTH_ISSUER: 'https://auth.example.test', AUTH_MANAGEMENT_PAGE_ROUTES: '["/account/rename"]' },
      { accountId: '123e4567-e89b-42d3-a456-426614174000', handle: null, available: true },
    ),
  },
};
export const CapabilityUnavailable: Story = { args: { renameAccount: null } };
export const IssuerUnavailable: Story = { args: { securityHref: null, renameAccount: null } };
