import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AccountHome } from './account-home.tsx';
import { AccountFrame, ada } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { SectionSkeleton } from '../shell/skeletons.tsx';
import { ReadStatePanel } from '../shell/state-panel.tsx';

const meta = {
  title: 'Accounts/Account centre/Home', component: AccountHome,
  args: { summary: { user: ada, issues: [], checkupComplete: true, failedSignIns: 0,
    security: { passkeys: 2, twoStep: true }, devices: 2,
    apps: 3, unusedApps: 0 } },
  decorators: [(Story, { parameters }) => <AccountFrame section="home"
    signedIn={parameters.signedIn !== false}><Story /></AccountFrame>],
} satisfies Meta<typeof AccountHome>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Welcome, Ada Lovelace' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Your account is protected' })).toBeVisible();
    await expect(canvas.getByText('2-Step Verification is on')).toBeVisible();
    await expect(canvas.getByText('2 passkeys')).toBeVisible();
    await expect(canvas.getByText('Signed in on 2 devices')).toBeVisible();
    await expect(canvas.getByText('3 apps can use your account')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Home' })[0]).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Manage security' })).toHaveAttribute('href', '/security');
  },
};

export const NeedsAttention: Story = {
  args: { summary: { user: { ...ada, emailVerified: false }, issues: ['verify-email', 'failed-sign-ins', 'add-second-step'],
    checkupComplete: true, failedSignIns: 4, security: { passkeys: 0, twoStep: false }, devices: null, apps: 0,
    unusedApps: 0 } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 2, name: 'Your account needs attention: 3 things to check' }))
      .toBeVisible();
    await expect(canvas.getByText('4 failed sign-in attempts in the last 24 hours')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Verify email' })).toHaveAttribute('href', '/personal-info');
    await expect(canvas.getByRole('link', { name: 'Review activity' })).toHaveAttribute('href', '/security/activity');
    await expect(canvas.getByRole('link', { name: 'Create a passkey' })).toHaveAttribute('href', '/security/passkeys');
    await expect(canvas.getByText('No apps can use your account')).toBeVisible();
    await expect(canvas.queryByText(/devices?$/)).toBeNull();
  },
};

export const Recommendation: Story = {
  args: { summary: { user: ada, issues: ['add-second-step'], checkupComplete: true, failedSignIns: 0,
    security: { passkeys: 0, twoStep: false },
    devices: 1, apps: 1, unusedApps: 0 } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 2, name: 'One way to make your account safer' }))
      .toBeVisible();
  },
};

export const CheckUnavailable: Story = {
  args: { summary: { user: ada, issues: [], checkupComplete: false, failedSignIns: 0,
    security: null, devices: null, apps: null, unusedApps: 0 } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Some checks are unavailable' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Your account is protected' })).toBeNull();
  },
};

export const Loading: Story = {
  render: () => <SectionSkeleton />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('status', { name: 'Loading…' })).toBeVisible();
  },
};

export const SignedOut: Story = {
  parameters: { signedIn: false },
  render: () => <ReadStatePanel status="signed-out" next="/" headingLevel={1} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Sign in to continue' })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/sign-in?next=%2F');
  },
};

export const Unavailable: Story = {
  render: () => <ReadStatePanel status="unavailable" next="/" headingLevel={1} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Your account is unavailable right now' }))
      .toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

export const Dark: Story = { ...NeedsAttention, globals: dark };
export const Phone: Story = {
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Welcome, Ada Lovelace' })).toBeVisible();
    // Phones get section tabs instead of the side navigation.
    const [tabs] = canvas.getAllByRole('navigation', { name: 'Account sections' });
    await expect(tabs).toBeVisible();
    await expect(within(tabs!).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  },
};
export const Chinese: Story = {
  ...NeedsAttention,
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '欢迎，Ada Lovelace' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: '您的账号有 3 项需要处理' })).toBeVisible();
    await expect(canvas.getByText('过去 24 小时内有 4 次登录失败')).toBeVisible();
  },
};
