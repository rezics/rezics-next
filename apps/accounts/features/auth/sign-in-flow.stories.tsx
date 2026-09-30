import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { SignInFlow } from './sign-in-flow.tsx';
import { pendingAutofill } from '../../.storybook/account-client.ts';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';
import { AuthSkeleton } from '../shell/skeletons.tsx';
import { turnstileFixture } from './turnstile.fixture.ts';

const meta = {
  title: 'Accounts/Sign in', component: SignInFlow, args: { next: '/' },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
  beforeEach: () => turnstileFixture(),
} satisfies Meta<typeof SignInFlow>;
export default meta;
type Story = StoryObj<typeof meta>;

async function toPassword(canvasElement: HTMLElement, email = 'ada@example.test') {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Email' }), email);
  await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
  return canvas;
}

export const Email: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(canvas.getByText('Use your REZICS Account')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('Enter an email')).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Email' }), 'not-an-email');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('Enter a valid email address')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/sign-up');
  },
};

const continued = fn();
export const Password: Story = {
  parameters: { account: { navigate: continued } },
  args: { next: '/security' },
  async play({ canvasElement }) {
    const canvas = await toPassword(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: /ada@example\.test/ })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Forgot password?' }))
      .toHaveAttribute('href', '/forgot-password?email=ada%40example.test');
    await userEvent.type(canvas.getByLabelText('Enter your password'), 'correct horse');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(continued).toHaveBeenCalledWith('/security');
  },
};

export const WrongPassword: Story = {
  parameters: { account: { api: { signIn: async () => ({ ok: false, kind: 'invalid-credentials', status: 401 }) } } },
  async play({ canvasElement }) {
    const canvas = await toPassword(canvasElement);
    await userEvent.type(canvas.getByLabelText('Enter your password'), 'wrong');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(await canvas.findByText('Wrong email or password. Try again or reset your password.')).toBeVisible();
    await expect(canvas.getByLabelText('Enter your password')).toHaveValue('');
  },
};

const resumed = fn();
export const ForAnApp: Story = {
  args: { oauthQuery: 'client_id=reader&sig=abc&ba_param=client_id', carry: 'client_id=reader&sig=abc&ba_param=client_id' },
  parameters: { account: { navigate: resumed,
    api: { signIn: async () => ({ ok: true, data: { redirect: '/consent?client_id=reader&sig=next' } }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('An app is asking you to sign in with your REZICS Account')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Create account' }))
      .toHaveAttribute('href', '/sign-up?client_id=reader&sig=abc&ba_param=client_id');
    await toPassword(canvasElement);
    await userEvent.type(canvas.getByLabelText('Enter your password'), 'correct horse');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(resumed).toHaveBeenCalledWith('/consent?client_id=reader&sig=next');
  },
};

export const ForRezics: Story = {
  args: { appName: 'REZICS', oauthQuery: 'client_id=rezics&sig=abc&ba_param=client_id',
    carry: 'client_id=rezics&sig=abc&ba_param=client_id' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('to continue to REZICS')).toBeVisible();
  },
};

const verified = fn(async (): Promise<{ ok: true; data: object } | { ok: false; kind: 'invalid-code'; status: number }> =>
  verified.mock.calls.length === 1 ? { ok: false, kind: 'invalid-code', status: 401 } : { ok: true, data: {} });
const afterCode = fn();
export const TwoStepVerification: Story = {
  args: { next: '/security' },
  parameters: { account: { navigate: afterCode, api: { signIn: async () => ({ ok: true, data: { twoFactor: true } }),
    verifyTwoFactor: verified } } },
  async play({ canvasElement }) {
    const canvas = await toPassword(canvasElement);
    await userEvent.type(canvas.getByLabelText('Enter your password'), 'correct horse battery');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(await canvas.findByRole('heading', { level: 1, name: '2-Step Verification' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('Enter the 6-digit code')).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Enter code' }), '123456');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Don’t ask again on this device' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(await canvas.findByText('Wrong code. Try again.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Use a backup code' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Backup code' }), 'k3Hx7-Qm2pW');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(verified).toHaveBeenLastCalledWith({ code: 'k3Hx7-Qm2pW', method: 'backup-code', trustDevice: true,
      oauthQuery: undefined });
    await waitFor(() => expect(afterCode).toHaveBeenCalledWith('/security'));
  },
};

const withPasskey = fn(async ({ conditional, signal }: { conditional?: boolean; signal?: AbortSignal }) => conditional
  ? pendingAutofill(signal) : { ok: true as const, data: { redirect: '/consent?client_id=reader&sig=next' } });
const afterPasskey = fn();
export const Passkey: Story = {
  args: { appName: 'Reader', oauthQuery: 'client_id=reader&sig=abc&ba_param=client_id' },
  parameters: { account: { navigate: afterPasskey, api: { signInWithPasskey: withPasskey } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('to continue to Reader')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Email' })).toHaveAttribute('autocomplete', 'username webauthn');
    await userEvent.click(canvas.getByRole('button', { name: 'Sign in with a passkey' }));
    await expect(withPasskey).toHaveBeenCalledWith({ oauthQuery: 'client_id=reader&sig=abc&ba_param=client_id' });
    await waitFor(() => expect(afterPasskey).toHaveBeenCalledWith('/consent?client_id=reader&sig=next'));
  },
};

export const PasskeyDidNotWork: Story = {
  parameters: { account: { api: { signInWithPasskey: async ({ conditional, signal }: { conditional?: boolean;
    signal?: AbortSignal }) => conditional ? pendingAutofill(signal) : { ok: false, kind: 'invalid-credentials', status: 401 } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Sign in with a passkey' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('That passkey didn’t sign you in. Try another way.');
  },
};

export const EmailNotVerified: Story = {
  parameters: { account: { api: { signIn: async () => ({ ok: false, kind: 'email-not-verified', status: 403 }) } } },
  async play({ canvasElement }) {
    const canvas = await toPassword(canvasElement);
    await userEvent.type(canvas.getByLabelText('Enter your password'), 'correct horse');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Send a new link' }));
    await expect(await canvas.findByText('If ada@example.test still needs verifying, a new link is on its way.')).toBeVisible();
  },
};

export const Unavailable: Story = {
  parameters: { account: { api: { signIn: async () => ({ ok: false, kind: 'unavailable', status: 503 }) } } },
  async play({ canvasElement }) {
    const canvas = await toPassword(canvasElement);
    await userEvent.type(canvas.getByLabelText('Enter your password'), 'correct horse');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Sign-in is unavailable right now.');
  },
};

export const ConfirmItsYou: Story = {
  args: { reauthEmail: 'ada@example.test', next: '/security' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Verify it’s you' })).toBeVisible();
    await expect(canvas.getByLabelText('Enter your password')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'ada@example.test' })).toBeDisabled();
  },
};

export const AfterDeletion: Story = {
  args: { notice: 'deleted' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('Your REZICS Account was deleted.')).toBeVisible();
  },
};

export const Loading: Story = {
  render: () => <AuthSkeleton />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('status', { name: 'Loading…' })).toBeVisible();
  },
};

export const Dark: Story = { ...TwoStepVerification, globals: dark };
export const Phone: Story = { ...Password, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '登录' })).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: '电子邮箱' }), 'ada@example.test');
    await userEvent.click(canvas.getByRole('button', { name: '下一步' }));
    await expect(canvas.getByRole('heading', { level: 1, name: '欢迎' })).toBeVisible();
    await expect(canvas.getByLabelText('输入您的密码')).toBeVisible();
  },
};
