import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { settingsAccountExample, type AccountSafetyExample } from '../kernel/fake/settings-account';
import { m } from '../paraglide/messages.js';
import { AccountSafetyCard } from '../settings/account-safety';

const meta = {
  title: 'Patterns/Account/Account safety',
  component: AccountSafetyCard,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof AccountSafetyCard>;
export default meta;
type Story = StoryObj<typeof Example>;

function Example({ scenario = 'ready' }: { scenario?: AccountSafetyExample }) {
  const [current, setCurrent] = useState(scenario);
  return <AccountSafetyCard {...settingsAccountExample(current, () => setCurrent('ready'))} />;
}

export const Default: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const security = canvas.getByRole('link', { name: m.account_security_settings() });
    const deletion = canvas.getByRole('link', { name: m.settings_account_delete_continue() });
    await expect(security).toHaveAttribute('href', 'https://auth.example.test/security');
    await expect(deletion).toHaveAttribute('href', 'https://auth.example.test/account/delete');
    // Keep the story in place while exercising the actual navigation entry.
    let activated = false;
    deletion.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        activated = true;
      },
      { once: true },
    );
    deletion.focus();
    await userEvent.keyboard('{Enter}');
    await expect(activated).toBe(true);
    await expect(deletion).toHaveFocus();
    await expect(canvas.getAllByRole('button')).toHaveLength(1);
  },
};

export const MissingIssuer: Story = {
  render: () => <Example scenario="missing-issuer" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.settings_account_auth_unavailable());
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.getByRole('button', { name: m.account_sign_out() })).toBeEnabled();
  },
};

export const SignedOut: Story = {
  render: () => <Example scenario="signed-out" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      '/auth/sign-in?return_to=%2Fsettings%23account',
    );
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.settings_account_delete_continue() })).toBeNull();
  },
};

export const MissingCsrf: Story = {
  render: () => <Example scenario="missing-csrf" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: m.account_sign_out() })).toBeDisabled();
    await expect(canvas.getByRole('status')).toHaveTextContent(m.settings_account_csrf_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.settings_reload() }));
    await expect(canvas.getByRole('button', { name: m.account_sign_out() })).toBeEnabled();
    await expect(canvas.queryByRole('status')).toBeNull();
  },
};
