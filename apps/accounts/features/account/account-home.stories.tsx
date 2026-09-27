import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AccountHome } from './account-home.tsx';
import { AccountFrame, ada } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { SectionSkeleton } from '../shell/skeletons.tsx';
import { ReadStatePanel } from '../shell/state-panel.tsx';

const meta = {
  title: 'Accounts/Account centre/Home', component: AccountHome,
  args: { summary: { user: ada, signInMethods: 1, devices: 2, apps: 3 } },
  decorators: [(Story, { parameters }) => <AccountFrame section="home"
    signedIn={parameters.signedIn !== false}><Story /></AccountFrame>],
} satisfies Meta<typeof AccountHome>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Welcome, Ada Lovelace' })).toBeVisible();
    await expect(canvas.getByText('Email verified')).toBeVisible();
    await expect(canvas.getByText('Signed in on 2 devices')).toBeVisible();
    await expect(canvas.getByText('3 apps can use your account')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Home' })[0]).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Review security' })).toHaveAttribute('href', '/security');
  },
};

export const NeedsAttention: Story = {
  args: { summary: { user: { ...ada, emailVerified: false }, signInMethods: null, devices: null, apps: 0 } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Email not verified')).toBeVisible();
    await expect(canvas.getByText('No apps can use your account')).toBeVisible();
    await expect(canvas.queryByText(/devices?$/)).toBeNull();
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

export const Dark: Story = { ...Overview, globals: dark };
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
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '欢迎，Ada Lovelace' })).toBeVisible();
    await expect(canvas.getByText('已在 2 台设备上登录')).toBeVisible();
  },
};
