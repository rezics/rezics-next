import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { browseResources } from './browse-fixtures.ts';
import { browseResourceHref, DiscoverResourceCard } from './resource-card.tsx';
import type { ResourceCard } from './api.ts';
import { canonicalHref } from '../address/path.ts';

const preview = (names = ['Jane Austen', 'Lin Mei', 'K. Mori']): NonNullable<ResourceCard['work']> => ({
  primaryCredits: names.map((displayName, index) => ({ id: browseResources[index + 1]!.id,
    role: 'author', participantKind: 'agent', agent: browseResources[index + 1]!.id,
    displayName, handle: ['jane-austen', 'lin-mei', 'k-mori'][index]!, provider: null, key: null, ordinal: null })),
  creditCount: { value: 3, kind: 'at-least' },
  rating: { context: browseResources[9]!.id, count: 20, sum: 85, mean: 4.25, scale: { min: 1, max: 5 } },
});

const meta = {
  title: 'Discover/Shared resource cards', component: DiscoverResourceCard,
  args: { item: { ...browseResources[0]!, types: ['https://schema.org/Book'],
    name: { ...browseResources[0]!.name, value: 'A library on a rainy night', language: 'en' }, work: preview() }, locale: 'en' },
  decorators: [Story => <div className="w-full max-w-64 p-4"><Story /></div>],
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const title = canvas.getByRole('heading', { level: 3, name: args.item.name.value });
    await expect(title).toBeVisible();
    const link = args.item.kind === 'work' ? canvas.getByRole('link', { name: args.item.name.value }) : title.closest('a');
    await expect(link).toHaveAttribute('href', `/en${browseResourceHref(args.item)}`);
    if (args.item.kind === 'work') await expect(title).toHaveClass('font-work-title');
  },
} satisfies Meta<typeof DiscoverResourceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkLatin: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Jane Austen' })).toHaveAttribute('href',
      canonicalHref({ prefix: '/@', key: 'jane-austen', slugSource: '' }, 'en'));
    await expect(canvas.queryByText(/author credits/)).toBeNull();
    await expect(canvas.queryByText(/more$/)).toBeNull();
    await expect(canvas.getByText('4.25')).toBeVisible();
  },
};
export const CommunityLatin: Story = { args: { item: browseResources[1]! } };
export const SiteLatin: Story = { args: { item: browseResources[2]! } };
export const PersonLatin: Story = { args: { item: browseResources[3]! } };
export const ListLatin: Story = { args: { item: browseResources[4]! } };
export const TopicLatin: Story = { args: { item: browseResources[5]! } };
export const WorkInCommunity: Story = {
  args: { scope: { kind: 'realm', realm: '00000000-0000-4000-8000-000000000009' } },
  async play({ canvasElement, args }) {
    await expect(within(canvasElement).getByRole('link', { name: args.item.name.value })).toHaveAttribute('href',
      `/en${browseResourceHref(args.item)}?scope=realm&realm=00000000-0000-4000-8000-000000000009`);
  },
};

const chinese = (index: number, value: string) => ({
  item: { ...browseResources[index]!, name: { ...browseResources[index]!.name, value, language: 'zh-Hans' },
    ...(index === 0 ? { types: ['https://schema.org/Book'], work: preview(['简·奥斯汀', '林美玲', '森圭']) } : {}) }, locale: 'zh-Hans' as const,
});
const cjk = { globals: { locale: 'zh-Hans' },
  async play({ canvasElement, args }: Parameters<NonNullable<typeof meta.play>>[0]) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: args.item.name.value })).toBeVisible();
    const heading = canvas.getByRole('heading', { name: args.item.name.value });
    const link = args.item.kind === 'work' ? canvas.getByRole('link', { name: args.item.name.value }) : heading.closest('a');
    await expect(link).toHaveAttribute('href', `/zh-Hans${browseResourceHref(args.item)}`);
    if (args.item.kind === 'work') {
      await expect(canvas.getByRole('link', { name: '林美玲' })).toHaveAttribute('href',
        canonicalHref({ prefix: '/@', key: 'lin-mei', slugSource: '' }, 'zh-Hans'));
      await expect(canvas.queryByText(/条作者署名|另有/)).toBeNull();
      await expect(canvas.getByText('4.25')).toBeVisible();
    }
  },
};
export const WorkCjk: Story = { ...cjk, args: chinese(0, '雨夜の図書館 · 雨夜图书馆') };
export const CommunityCjk: Story = { ...cjk, args: chinese(1, '古典文学阅读与翻译社群') };
export const SiteCjk: Story = { ...cjk, args: chinese(2, '开放的读书与写作空间') };
export const PersonCjk: Story = { ...cjk, args: chinese(3, '林美玲') };
export const ListCjk: Story = { ...cjk, args: chinese(4, '值得重读的小说与随笔') };
export const TopicCjk: Story = { ...cjk, args: chinese(5, '科幻与宇宙探索') };
