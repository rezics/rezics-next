import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { TwoStepVerification } from './two-step.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { totpEnrollment } from '../../.storybook/account-client.ts';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Account centre/2-Step Verification', component: TwoStepVerification,
  args: { totp: null, hasPassword: true },
  decorators: [(Story, { parameters }) => <AccountFrame section="security" stepUp={parameters.stepUp}><Story /></AccountFrame>],
} satisfies Meta<typeof TwoStepVerification>;
export default meta;
type Story = StoryObj<typeof meta>;

const enabled = fn(async () => ({ ok: true as const, data: totpEnrollment }));
const confirmed = fn(async (): Promise<{ ok: true; data: undefined } | { ok: false; kind: 'invalid-code'; status: number }> =>
  confirmed.mock.calls.length === 1 ? { ok: false, kind: 'invalid-code', status: 401 } : { ok: true, data: undefined });
const refreshed = fn();
export const TurnOn: Story = {
  parameters: { account: { refresh: refreshed, api: { enableTotp: enabled, confirmTotp: confirmed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 2, name: '2-Step Verification is off' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Turn on' }));
    let dialog = await screen.findByRole('dialog', { name: 'Turn on 2-Step Verification' });
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'correct horse battery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await expect(enabled).toHaveBeenCalledWith('correct horse battery');
    dialog = await screen.findByRole('dialog', { name: 'Set up your authenticator app' });
    await expect(within(dialog).getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    await expect(within(dialog).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeVisible();
    const code = within(dialog).getByRole('textbox', { name: 'Code from your authenticator app' });
    await userEvent.type(code, '12a3456');
    await expect(code).toHaveValue('123456');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    await expect(await within(dialog).findByText(/That code didn’t work/)).toBeVisible();
    await userEvent.type(code, '654321');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    dialog = await screen.findByRole('dialog', { name: '2-Step Verification is on' });
    await expect(within(dialog).getByRole('list', { name: 'Backup codes' }).children).toHaveLength(10);
    await expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'rezics-backup-codes.txt');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await expect(refreshed).toHaveBeenCalled();
    await expect(await canvas.findByText(/2-Step Verification is on\. You’ll need your authenticator app/)).toBeVisible();
  },
};

export const On: Story = {
  args: { totp: { name: 'Phone authenticator', verified: true } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 2, name: '2-Step Verification is on' })).toBeVisible();
    await expect(canvas.getByText('Phone authenticator')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Get new codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'New backup codes' });
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'correct horse battery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Get new codes' }));
    await expect(await within(dialog).findByText('k3Hx7-Qm2pW')).toBeVisible();
  },
};

const disabled = fn(async (): Promise<{ ok: true; data: undefined } | { ok: false; kind: 'step-up-required'; status: number }> =>
  disabled.mock.calls.length === 1 ? { ok: false, kind: 'step-up-required', status: 403 } : { ok: true, data: undefined });
const reauthenticated = fn(async () => ({ ok: true as const, data: undefined }));
export const TurnOffConfirmsWithCode: Story = {
  args: { totp: { name: 'Phone authenticator', verified: true } },
  parameters: { stepUp: { password: true, passkey: false, totp: true },
    account: { api: { disableTotp: disabled, reauthenticate: reauthenticated } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off 2-Step Verification?' });
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'correct horse battery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    // The password is already known; only the authenticator code is asked.
    const confirm = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await expect(within(confirm).queryByLabelText('Enter your password')).toBeNull();
    const code = within(confirm).getByRole('textbox', { name: 'Code from your authenticator app' });
    // The nested dialog becomes the pointer-blocking layer a moment after it appears.
    await waitFor(() => expect(getComputedStyle(code).pointerEvents).toBe('auto'));
    await userEvent.type(code, '123456');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await expect(reauthenticated).toHaveBeenCalledWith({ password: 'correct horse battery', totpCode: '123456' });
    await waitFor(() => expect(disabled).toHaveBeenCalledTimes(2));
    await expect(await canvas.findByText('2-Step Verification is off.')).toBeVisible();
    // Accessibility checks run after the story: let both dialogs finish closing.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  },
};

export const Dark: Story = { ...On, play: undefined, globals: dark };
export const Phone: Story = { args: { totp: { name: 'Phone authenticator', verified: true } }, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '两步验证' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '开启' })).toBeVisible();
  },
};
