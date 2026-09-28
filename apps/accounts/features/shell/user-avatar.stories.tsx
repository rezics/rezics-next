import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { UserAvatar } from './user-avatar.tsx';

const meta = { title: 'Accounts/User avatar', component: UserAvatar,
  args: { user: { name: 'Daniel Chen 陈丹尼', email: 'daniel@example.test', image: null }, size: 'lg' },
} satisfies Meta<typeof UserAvatar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedName: Story = {
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('DC')).toBeVisible();
  },
};

export const ChineseName: Story = { args: { user: { name: '陈丹尼', email: 'daniel@example.test', image: null } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('陈')).toBeVisible();
  },
};
