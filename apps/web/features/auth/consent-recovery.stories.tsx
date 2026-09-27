import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ConsentRecovery } from './consent-recovery.tsx';
import { messages } from './messages.ts';

const meta = { title: 'Auth/Consent recovery', component: ConsentRecovery,
  args: { next: '/en/studio', messages: messages.en },
} satisfies Meta<typeof ConsentRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Declined: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Sign-in was not completed' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Try signing in again' }))
      .toHaveAttribute('href', '/auth/start?next=%2Fen%2Fstudio');
  },
};

export const ChinesePhone: Story = {
  args: { messages: messages['zh-Hans'], next: '/zh-Hans/studio' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: '重新登录' }))
      .toHaveAttribute('href', '/auth/start?next=%2Fzh-Hans%2Fstudio');
  },
};
