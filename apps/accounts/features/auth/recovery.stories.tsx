import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RecoveryForm } from './recovery-form.tsx';
import { ResetPasswordForm } from './reset-password-form.tsx';
import { VerifyEmailResult } from './verify-email-result.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';

const meta = {
  title: 'Accounts/Recovery', component: RecoveryForm, args: { email: 'ada@example.test' },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
} satisfies Meta<typeof RecoveryForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RequestLink: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Account recovery' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.test');
    await userEvent.click(canvas.getByRole('button', { name: 'Send reset link' }));
    await expect(await canvas.findByText(/If ada@example\.test matches a REZICS Account/)).toBeVisible();
  },
};

export const EmailNotAvailable: Story = {
  parameters: { account: { api: { requestPasswordReset: async () => ({ ok: false, kind: 'not-enabled', status: 400 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Send reset link' }));
    await expect(await canvas.findByRole('heading', { name: 'Email recovery isn’t available yet' })).toBeVisible();
  },
};

export const ChooseNewPassword: Story = {
  render: () => <ResetPasswordForm token="reset-token" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Password'), 'new pass phrase');
    await userEvent.type(canvas.getByLabelText('Confirm'), 'new pass phrase');
    await userEvent.click(canvas.getByRole('button', { name: 'Save password' }));
    await expect(await canvas.findByRole('heading', { name: 'Your password was changed' })).toBeVisible();
  },
};

export const ExpiredResetLink: Story = {
  render: () => <ResetPasswordForm />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'This reset link doesn’t work' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/forgot-password');
  },
};

export const EmailVerified: Story = {
  render: () => <VerifyEmailResult failed={false} signedIn />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Your email is verified' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Continue to your account' })).toHaveAttribute('href', '/');
  },
};

export const VerifiedThenContinue: Story = {
  render: () => <VerifyEmailResult failed={false} signedIn={false} carry="client_id=reader&sig=abc" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Sign in to continue where you left off/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in to continue' }))
      .toHaveAttribute('href', '/sign-in?client_id=reader&sig=abc');
  },
};

export const EmailChangeConfirmed: Story = {
  render: () => <VerifyEmailResult failed={false} signedIn change="requested" />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'Now check your new inbox' })).toBeVisible();
  },
};

export const EmailChanged: Story = {
  render: () => <VerifyEmailResult failed={false} signedIn={false} change="verified" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Your email address was changed' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  },
};

export const VerificationFailed: Story = {
  render: () => <VerifyEmailResult failed signedIn={false} />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'This verification link doesn’t work' }))
      .toBeVisible();
  },
};

export const Dark: Story = { ...RequestLink, globals: dark };
export const Phone: Story = { ...ChooseNewPassword, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '找回账号' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '发送重置链接' }));
    await expect(await canvas.findByRole('heading', { name: '请查收电子邮件' })).toBeVisible();
  },
};
