import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SearchResults } from './search-results.tsx';
import { search as english } from '../../i18n/en.ts';
import { search as chinese } from '../../i18n/zh-CN.ts';

const meta = {
  title: 'Search/Results', component: SearchResults,
  args: { locale: 'en', messages: english },
  decorators: [Story => <div className="page-width" style={{ paddingTop: 32 }}><Story /></div>],
} satisfies Meta<typeof SearchResults>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: { state: 'ready', total: 2, sequence: '42', results: [
    { matchUnit: 'mu-1', work: 'https://rezics.com/id/920813ee-3855-42be-84bb-88da77a5b247',
      revision: 'https://rezics.com/id/4b3ac708-b3c8-4f14-88cb-1c0ce8793337',
      language: 'English', title: 'Notes on a City of Rivers',
      reason: 'Published contribution matching the current perspective.' },
    { matchUnit: 'mu-2', work: 'https://rezics.com/id/07309b3b-c8f6-4211-bdb3-9aa486c1e4d5',
      revision: 'https://rezics.com/id/5aa0bc70-1090-4a75-8734-2eedbe13c88c',
      language: 'Japanese', title: '都市と川の記録' },
  ] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Notes on a City of Rivers' })).toHaveAttribute('href',
      '/works/4b3ac708-b3c8-4f14-88cb-1c0ce8793337');
    await expect(canvas.getByText('Showing 2 results')).toBeInTheDocument();
  },
};

export const Empty: Story = { args: { state: 'ready', total: 0, results: [] } };
export const Loading: Story = { args: { state: 'loading' } };
export const Error: Story = { args: { state: 'error', error: 'Request failed' } };

export const ChineseEmpty: Story = {
  args: { locale: 'zh-CN', messages: chinese, state: 'ready', total: 0, results: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: '搜索结果' })).toHaveTextContent('没有找到匹配的作品。');
    await expect(canvas.getByText('显示 0 条结果')).toBeInTheDocument();
  },
};
