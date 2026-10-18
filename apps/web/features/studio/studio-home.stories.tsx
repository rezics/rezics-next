import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { chooseOption } from '../stories/choose-option.ts';
import { agents, curated, inventory, now, review } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { StudioFrame, StudioIdentityMissing } from './studio-frame.tsx';
import { StudioHome, StudioHomePending } from './studio-home.tsx';
import { inventoryAddress } from './types.ts';

type Props = ComponentProps<typeof StudioHome> & { session?: (typeof agents)[number] | null };

const home = '/en/studio/@111111114bZ6BZRUqUqZep';

const meta = {
  title: 'Studio/Home',
  component: StudioHome,
  parameters: { route: { pathname: home } },
  args: { agent: agents[0]!, content: { view: 'all', works: { ok: true, data: inventory } }, moreHref: null, now,
    locale: 'en', messages, session: agents[0]! },
  render: ({ session = null, ...args }: Props) => <StudioFrame agent={args.agent} agents={agents} session={session} path=""
    locale={args.locale} messages={args.messages}><StudioHome {...args} /></StudioFrame>,
} satisfies Meta<Props>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every Work from Main's inventory; a Book counts its chapters, and the chapters themselves stay inside it. */
export const Works: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const identity = canvas.getByRole('region', { name: 'Writing as' });
    await expect(identity).toHaveTextContent('Lin Mei 林梅');
    await expect(identity).toHaveTextContent('LM');
    await expect(canvas.getByRole('link', { name: 'New work' })).toHaveAttribute('href', `${home}/new`);
    const list = canvas.getByRole('region', { name: 'All works' });
    const items = within(list).getAllByRole('listitem');
    await expect(items).toHaveLength(3);
    await expect(items[0]).toHaveTextContent('3 chapters');
    await expect(items[0]).toHaveTextContent('Public');
    await userEvent.click(within(items[0]!).getByText('Details'));
    await expect(within(items[0]!).getByText(/Book · .*Chinese/)).toBeVisible();
    // Studio names each kind as the catalogue does: a DigitalDocument is a Guide.
    await expect(items[1]).toHaveTextContent(/Guide · English/);
    await expect(items[2]).toHaveTextContent(/Recipe · English/);
    await expect(items[0]).toHaveTextContent('1 Realm reviewing');
    await expect(within(items[0]!).getByRole('link', { name: 'Chapters' })).toHaveAttribute('href',
      `${home}/works/00000000-0000-4000-8000-000000000101?tab=chapters`);
    // Other Works go straight back to their own latest text.
    await expect(within(items[1]!).getByRole('link', { name: 'Continue writing' })).toHaveAttribute('href',
      expect.stringMatching(/\/write\/.+\?revision=/));
    await expect(canvas.getByRole('link', { name: 'All works' })).toHaveAttribute('aria-current', 'page');
  },
};

export const InReview: Story = {
  args: { content: { view: 'review', review } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const items = within(canvas.getByRole('region', { name: 'In review' })).getAllByRole('listitem');
    // Still open with the Realm first, then decisions.
    await expect(items.map(item => item.textContent)).toEqual([expect.stringContaining('Changes requested'),
      expect.stringContaining('Waiting for review'), expect.stringContaining('Accepted')]);
    await expect(items[0]).toHaveTextContent('Please add a content note for the opening chapter.');
    await expect(items[0]).toHaveTextContent('Moderators review every submission');
    await expect(items[1]).toHaveTextContent('Trusted members are accepted at once');
    await expect(within(items[0]!).getByRole('link', { name: '雨夜书店' })).toHaveAttribute('href',
      expect.stringContaining('?tab=realms'));
  },
};

/** Works this Agent imported or curates are kept apart, and Studio never offers to write in someone else's text. */
export const Curated: Story = {
  args: { content: { view: 'curated', works: { ok: true, data: curated } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const list = canvas.getByRole('region', { name: 'Imported & curated' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await expect(within(list).getAllByText('Imported or curated')).toHaveLength(2);
    await expect(within(list).queryByRole('link', { name: 'Continue writing' })).toBeNull();
    await expect(within(list).getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href',
      `${home}/works/00000000-0000-4000-8000-000000000105`);
  },
};

export const DraftsEmpty: Story = {
  args: { content: { view: 'draft', works: { ok: true, data: { ...inventory, page: { ...inventory.page, items: [] },
    } } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/No drafts/)).toBeInTheDocument();
  },
};

/** A new writer: nothing to list yet, and one clear way to start. */
export const Empty: Story = {
  args: { content: { view: 'all', works: { ok: true, data: { ...inventory, page: { ...inventory.page, items: [] },
    } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Your Studio is ready' })).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Start a new work' })).toBeInTheDocument();
  },
};

export const Denied: Story = {
  args: { content: { view: 'all', works: { ok: false, failure: 'denied' } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Your works can’t be listed for this identity.')).toBeInTheDocument();
  },
};

export const Unavailable: Story = {
  args: { content: { view: 'all', works: { ok: false, failure: 'unavailable' } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  },
};

/** Studio acts as a pen name in this tab; the rest of the site keeps the session Agent, and says so. */
export const PenName: Story = {
  args: { agent: agents[1]! },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Studio acts as 月下书生 · Moonlit Scribe here; the rest of REZICS still uses Lin Mei 林梅/))
      .toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Switch identity' }));
    const menu = within(await within(document.body).findByRole('menu'));
    await expect(menu.getByRole('menuitem', { name: /Lin Mei 林梅/ })).toHaveAttribute('href', home);
    await expect(menu.getByRole('menuitem', { name: /Moonlit Scribe/ })).toHaveAttribute('aria-current', 'page');
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: home.replace('/en/', '/zh-Hans/') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '创作室' })).toBeInTheDocument();
    await expect(canvas.getByText('3 章')).toBeInTheDocument();
    await expect(canvas.getByText('已发布 2 章')).toBeInTheDocument();
    await expect(canvas.getByRole('heading', { name: 'Ginger lemon tea' }).closest('li')).toHaveTextContent('菜谱');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** A twenty-item page of 105 works; production search and ordering are owned by Main. */
const largeItems = Array.from({ length: 105 }, (_, index) => ({ ...inventory.page.items[index % 3]!,
  id: `https://rezics.com/id/00000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`,
  title: { value: index === 104 ? '寻回最后一部作品 · The last work beyond five pages'
    : index % 2 ? `雨夜里的第${index + 1}间书店，与一封写给未来的长信 · Letters to Tomorrow`
      : `The Cartographer of Tides: an unfinished atlas of distant shores — Volume ${index + 1}`, language: 'en' },
}));
const query = { q: '', sort: 'recent' as const };
export const LargeInventory: Story = {
  args: { content: { view: 'all', works: { ok: true, data: {
    page: { ...inventory.page, items: largeItems.slice(0, 20), nextCursor: 'page-two' },
  } } }, query, moreHref: inventoryAddress(home, 'all', query, 'page-two') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'All works' });
    await expect(within(region).getAllByRole('listitem')).toHaveLength(20);
    await expect(canvas.getByRole('searchbox', { name: 'Find by title' })).toHaveValue('');
    const sort = canvas.getByRole('combobox', { name: 'Sort works' });
    await expect(sort).toHaveTextContent('Recently edited');
    await expect(canvas.getByRole('link', { name: 'Show more' })).toHaveAttribute('href',
      inventoryAddress(home, 'all', query, 'page-two'));
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(sort);
    await chooseOption(within(document.body), 'Title');
    await expect(sort).toHaveTextContent('Title');
    await expect(new FormData(canvas.getByRole('search') as HTMLFormElement).get('sort')).toBe('title');
  },
};

export const LargeInventoryPhone: Story = { ...LargeInventory, globals: { viewport: { value: 'phone' } } };

/** An owner-filtered result beyond page five, reopened with its address conditions intact. */
export const LocatedWork: Story = {
  args: { content: { view: 'all', works: { ok: true, data: {
    page: { ...inventory.page, items: [largeItems[104]!] },
  } } }, query: { q: '寻回最后一部作品', sort: 'title' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const form = canvas.getByRole('search', { name: 'Find by title' });
    await expect(form).toHaveAttribute('method', 'get');
    await expect(canvas.getByRole('searchbox', { name: 'Find by title' })).toHaveValue('寻回最后一部作品');
    await expect(canvas.getByRole('combobox', { name: 'Sort works' })).toHaveTextContent('Title');
    await expect(new FormData(form as HTMLFormElement).get('sort')).toBe('title');
    await expect(canvas.getByRole('link', { name: 'Drafts' })).toHaveAttribute('href',
      inventoryAddress(home, 'draft', { q: '寻回最后一部作品', sort: 'title' }));
    await expect(canvas.getByRole('heading', { name: largeItems[104]!.title.value })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Clear search' })).toHaveAttribute('href',
      inventoryAddress(home, 'all', { q: '', sort: 'title' }));
  },
};

export const NoMatches: Story = {
  args: { query: { q: 'Missing title', sort: 'recent' },
    content: { view: 'all', works: { ok: true, data: { ...inventory, page: { ...inventory.page, items: [] } } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No matching works on this page.')).toBeVisible();
    await expect(canvas.queryByText('Your Studio is ready')).toBeNull();
    await expect(canvas.getByRole('searchbox')).toHaveValue('Missing title');
  },
};

export const SearchContinuation: Story = {
  ...NoMatches,
  args: { ...NoMatches.args, firstHref: inventoryAddress(home, 'all', { q: 'Missing title', sort: 'recent' }),
    moreHref: inventoryAddress(home, 'all', { q: 'Missing title', sort: 'recent' }, 'next-candidates'),
    content: { view: 'all', works: { ok: true, data: {
      ...inventory, page: { ...inventory.page, items: [], nextCursor: 'next-candidates' },
    } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('More works may match. Continue with Show more.')).toBeVisible();
    await expect(canvas.queryByText('No matching works on this page.')).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Show more' })).toHaveAttribute('href',
      expect.stringContaining('cursor=next-candidates'));
    await expect(canvas.getByRole('link', { name: 'Back to first page' })).toBeVisible();
  },
};

export const IncompleteCounts: Story = {
  args: { content: { view: 'all', works: { ok: true, data: { ...inventory,
    page: { ...inventory.page, items: [
      { ...inventory.page.items[0]!, chapterCount: { value: 0, complete: false } },
      { ...inventory.page.items[0]!, id: 'other-book', chapterCount: { value: 24, complete: false } },
    ] },
  } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Chapter count unavailable')).toBeVisible();
    await expect(canvas.getByText('At least 24 chapters')).toBeVisible();
    await expect(canvas.queryByText('0 chapters')).toBeNull();
  },
};

export const LifecycleStates: Story = {
  args: { content: { view: 'all', works: { ok: true, data: { ...inventory,
    page: { ...inventory.page, items: [
      { ...inventory.page.items[0]!, texts: inventory.page.items[0]!.texts.map(text => ({ ...text, draftHead: 'new-draft' })),
        submissions: inventory.page.items[0]!.submissions.map(item => ({ ...item, state: 'changes-requested' })) },
      inventory.page.items[1]!, { ...inventory.page.items[0]!, id: 'empty-book', state: 'empty', texts: [],
        disclosure: 'restricted', submissions: [], chapterCount: { value: 0, complete: true } },
    ] },
  } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Unpublished changes')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Changes requested' })).toHaveAttribute('href',
      expect.stringContaining('tab=realms'));
    await expect(canvas.getAllByText('Private')).toHaveLength(2);
    await expect(canvas.getByText('Not started')).toBeVisible();
    await expect(canvas.getByText('0 chapters')).toBeVisible();
  },
};

export const LifecycleStatesPhone: Story = { ...LifecycleStates, globals: { viewport: { value: 'phone' } } };
export const Loading: Story = { render: args => <StudioHomePending label={args.messages.loadingTab} /> };

/** An address for an identity this person does not act for: reported, never switched. */
export const NotYourIdentity: Story = {
  render: args => <StudioIdentityMissing agents={agents} locale={args.locale} messages={args.messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You can’t write as this identity' })).toBeInTheDocument();
    await expect(canvas.getAllByRole('link', { name: /Lin Mei|Moonlit|Agent/ })).toHaveLength(3);
  },
};
