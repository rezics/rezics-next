import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import { messages } from './messages.ts';
import { SearchResults } from './search-results.tsx';

const retry = fn();

const meta = {
  title: 'Search/Results', component: SearchResults,
  args: { locale: 'en', messages: messages.en, onRetry: retry },
  decorators: [Story => <PageContainer><Story /></PageContainer>],
} satisfies Meta<typeof SearchResults>;
export default meta;
type Story = StoryObj<typeof meta>;

const results = [
  { matchUnit: 'mu-1', work: 'https://rezics.com/id/920813ee-3855-42be-84bb-88da77a5b247',
    revision: 'https://rezics.com/id/4b3ac708-b3c8-4f14-88cb-1c0ce8793337',
    language: 'English', title: 'Notes on a City of Rivers',
    reason: 'Published contribution matching the current perspective.' },
  { matchUnit: 'mu-2', work: 'https://rezics.com/id/07309b3b-c8f6-4211-bdb3-9aa486c1e4d5',
    revision: 'https://rezics.com/id/5aa0bc70-1090-4a75-8734-2eedbe13c88c',
    language: 'Japanese', title: '都市と川の記録' },
  { matchUnit: 'mu-3', work: 'https://rezics.com/id/b9f0a1c2-4d5e-4f60-8a71-92b3c4d5e6f7',
    revision: 'https://rezics.com/id/c1d2e3f4-a5b6-4c7d-8e9f-a0b1c2d3e4f5', language: 'Spanish' },
];

export const Populated: Story = {
  args: { state: 'ready', total: 3, sequence: '42', results },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Notes on a City of Rivers' })).toHaveAttribute('href',
      '/works/4b3ac708-b3c8-4f14-88cb-1c0ce8793337');
    await expect(canvas.getByText('Showing 3 results')).toBeInTheDocument();
    await expect(canvas.getByText('Complete at sequence 42')).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Work b9f0a1c2' })).toBeInTheDocument();
  },
};

export const OneResult: Story = {
  args: { state: 'ready', total: 1, sequence: '42', results: results.slice(0, 1) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Showing 1 result')).toBeInTheDocument();
  },
};

export const LongMultilingualTitle: Story = {
  args: { state: 'ready', total: 1, sequence: '42', results: [{ ...results[1]!,
    title: '都市と川の記録 — Research notes and reflections across languages, regions and several centuries of river cities' }] },
};

export const Idle: Story = { args: { state: 'idle' } };

export const Blocked: Story = {
  args: { state: 'blocked' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Enter a full Realm ID to search this perspective.')).toBeVisible();
  },
};

export const Empty: Story = {
  args: { state: 'ready', total: 0, sequence: '42', results: [] },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: 'Search results' }))
      .toHaveTextContent('No works matched this search.');
  },
};

export const Loading: Story = {
  args: { state: 'loading' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: 'Search results' })).toHaveAttribute('aria-busy', 'true');
  },
};

export const Failed: Story = {
  args: { state: 'error', error: 'Main did not answer in time.' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Main did not answer in time.');
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await expect(retry).toHaveBeenCalled();
  },
};

export const ChineseEmpty: Story = {
  args: { locale: 'zh-CN', messages: messages['zh-CN'], state: 'ready', total: 0, sequence: '42', results: [] },
  globals: { locale: 'zh-CN' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: '搜索结果' })).toHaveTextContent('没有找到匹配的作品。');
    await expect(canvas.getByText('显示 0 条结果')).toBeInTheDocument();
  },
};

export const DarkPopulated: Story = {
  args: { state: 'ready', total: 3, sequence: '42', results },
  globals: { theme: 'dark' },
};

export const PhonePopulated: Story = {
  args: { state: 'ready', total: 3, sequence: '42', results },
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
