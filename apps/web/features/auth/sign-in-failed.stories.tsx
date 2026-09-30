import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { messages } from './messages.ts';
import { SignInFailed } from './sign-in-failed.tsx';

const meta = { title: 'Auth/Sign-in failed', component: SignInFailed,
  args: { reason: 'exchange', providerCode: null, next: '/en/studio', messages: messages.en },
} satisfies Meta<typeof SignInFailed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AccountServiceUnreachable: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Sign-in failed' })).toBeVisible();
    await expect(canvas.getByRole('alert')).toHaveTextContent('could not reach your Account service');
    await expect(canvas.getByRole('link', { name: 'Try signing in again' }))
      .toHaveAttribute('href', '/auth/start?next=%2Fen%2Fstudio');
  },
};

export const ProviderError: Story = {
  args: { reason: 'provider', providerCode: 'server_error' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('reported an error');
    await expect(canvas.getByText('Error code: server_error')).toBeVisible();
  },
};

export const Japanese: Story = {
  args: { reason: 'state', messages: messages.ja, next: '/ja' },
  globals: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'ログインに失敗しました' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'もう一度ログイン' })).toBeVisible();
  },
};

export const GermanPhone: Story = {
  args: { reason: 'code', messages: messages.de, next: '/de' },
  globals: { locale: 'de', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Anmeldecode');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
