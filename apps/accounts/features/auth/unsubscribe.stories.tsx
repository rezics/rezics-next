import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Unsubscribe } from './unsubscribe.tsx';
import { dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';

const meta = {
  title: 'Accounts/Unsubscribe', component: Unsubscribe, args: { token: 'payload.signature', valid: true },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
} satisfies Meta<typeof Unsubscribe>;
export default meta;
type Story = StoryObj<typeof meta>;

const unsubscribed = fn(async () => ({ ok: true as const, data: undefined }));
export const ConfirmsTheResult: Story = {
  parameters: { account: { api: { unsubscribe: unsubscribed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // Opening the link changes nothing; the person confirms first.
    await expect(await canvas.findByRole('heading', { name: 'Stop optional email?' })).toBeVisible();
    await expect(unsubscribed).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Unsubscribe' }));
    await expect(unsubscribed).toHaveBeenCalledWith('payload.signature');
    await expect(await canvas.findByRole('heading', { name: 'You’re unsubscribed' })).toBeVisible();
    await expect(canvas.getByText(/Security and account emails still arrive/)).toBeVisible();
  },
};

export const ExpiredLink: Story = {
  args: { valid: false },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'This unsubscribe link doesn’t work' })).toBeVisible();
  },
};

export const LinkExpiresBeforeConfirming: Story = {
  parameters: { account: { api: { unsubscribe: async () => ({ ok: false, kind: 'invalid-token', status: 400 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Unsubscribe' }));
    await expect(await canvas.findByRole('heading', { name: 'This unsubscribe link doesn’t work' })).toBeVisible();
  },
};

export const CouldNotUnsubscribe: Story = {
  parameters: { account: { api: { unsubscribe: async () => ({ ok: false, kind: 'unavailable', status: 503 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Unsubscribe' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('We couldn’t unsubscribe you just now.');
  },
};
export const Dark: Story = { globals: dark };
export const Phone: Story = { globals: phone };
