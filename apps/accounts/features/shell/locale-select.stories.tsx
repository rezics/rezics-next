import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AuthFrame } from './auth-frame.tsx';

const meta = {
  title: 'Accounts/Shell/Language picker', component: AuthFrame,
  args: { children: <h1>Sign in</h1> },
} satisfies Meta<typeof AuthFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Footer: Story = {
  async play({ canvasElement }) {
    const footer = within(canvasElement).getByRole('contentinfo');
    const picker = within(footer).getByRole('combobox', { name: 'Language' });
    await expect(picker).toHaveTextContent('English');
    await userEvent.click(picker);
    const options = await within(document.body).findAllByRole('option');
    await expect(options.map(option => option.textContent?.trim()))
      .toEqual(['English', '繁體中文', '简体中文', '日本語', '한국어', 'Deutsch', 'Français', 'Español']);
  },
};
