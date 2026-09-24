import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SiteHeader } from './site-header.tsx';
import { shell as english } from '../../i18n/en.ts';
import { shell as chinese } from '../../i18n/zh-CN.ts';

const meta = { title: 'Shell/Site header', component: SiteHeader,
  args: { authenticated: false, locale: 'en', messages: english },
} satisfies Meta<typeof SiteHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole('form', { name: 'Interface language' }))
      .getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-CN', messages: chinese },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    await expect(within(canvas.getByRole('form', { name: '界面语言' }))
      .getByRole('button', { name: '简体中文' })).toHaveAttribute('aria-pressed', 'true');
  },
};
