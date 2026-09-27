import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Providers } from '../shell/providers.tsx';
import { messages } from './messages.ts';
import { SearchExplorer } from './search-explorer.tsx';

// Without a phrase no query runs, so these stories show the page frame and filters.
const meta = {
  title: 'Search/Page', component: SearchExplorer,
  args: { initialPhrase: '', locale: 'en', messages: messages.en },
  decorators: [Story => <Providers><Story /></Providers>],
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof SearchExplorer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoPhrase: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Search works' })).toBeVisible();
    await expect(canvas.getByRole('radio', { name: 'Any language' })).toBeChecked();
    await userEvent.click(canvas.getByRole('radio', { name: 'Japanese' }));
    await expect(canvas.getByRole('radio', { name: 'Japanese' })).toBeChecked();
  },
};

export const RealmPerspective: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'View results from a perspective' }), 'realm');
    await expect(canvas.getByRole('textbox', { name: 'Realm ID' })).toBeVisible();
    await expect(canvas.getByText('Enter a full Realm ID to search this perspective.')).toBeVisible();
  },
};

export const PhoneFilters: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Filter results'));
    await expect(canvas.getByRole('radio', { name: 'Any language' })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: 'Japanese' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const ChineseDark: Story = {
  args: { locale: 'zh-CN', messages: messages['zh-CN'] },
  globals: { locale: 'zh-CN', theme: 'dark' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: '搜索作品' })).toBeVisible();
  },
};
