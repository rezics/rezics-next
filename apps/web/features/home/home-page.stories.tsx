import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { HomePage } from './home-page.tsx';
import { messages } from './messages.ts';

const meta = { title: 'Home/Landing', component: HomePage, args: { messages: messages.en } } satisfies Meta<typeof HomePage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Landing: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Find a work. Follow its meaning.' })).toBeVisible();
    const search = canvas.getByRole('search', { name: 'Search published works' });
    await expect(search).toHaveAttribute('action', '/search');
    await expect(canvas.getByRole('link', { name: /Browse works/ })).toHaveAttribute('href', '/discover');
    await expect(canvas.getByRole('link', { name: /Open Studio/ })).toHaveAttribute('href', '/studio');
    // Sections without a live destination say so instead of showing sample data.
    await expect(canvas.getAllByText('Coming soon')).toHaveLength(2);
  },
};

export const Chinese: Story = {
  args: { messages: messages['zh-CN'] },
  globals: { locale: 'zh-CN' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: '寻找作品，追寻其意义。' })).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
