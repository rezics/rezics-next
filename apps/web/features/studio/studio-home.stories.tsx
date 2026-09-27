import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { agents, inventory, now, review } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { StudioFrame, StudioIdentityMissing } from './studio-frame.tsx';
import { StudioHome } from './studio-home.tsx';

type Props = ComponentProps<typeof StudioHome> & { session?: (typeof agents)[number] | null };

const home = '/en/studio/@agent-00000000-0000-4000-8000-000000000001';

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
    await expect(canvas.getByRole('region', { name: 'Writing as' })).toHaveTextContent('Lin Mei 林梅');
    await expect(canvas.getByRole('link', { name: 'New work' })).toHaveAttribute('href', `${home}/new`);
    const list = canvas.getByRole('region', { name: 'All works' });
    const items = within(list).getAllByRole('listitem');
    await expect(items).toHaveLength(3);
    await expect(within(list).queryByText('第一章 雨夜')).toBeNull();
    await expect(items[0]).toHaveTextContent(/3 chapters·2 published/);
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

export const DraftsEmpty: Story = {
  args: { content: { view: 'draft', works: { ok: true, data: { ...inventory, page: { ...inventory.page, items: [] },
    books: {}, chapters: [] } } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/No drafts/)).toBeInTheDocument();
  },
};

/** A new writer: nothing to list yet, and one clear way to start. */
export const Empty: Story = {
  args: { content: { view: 'all', works: { ok: true, data: { ...inventory, page: { ...inventory.page, items: [] },
    books: {}, chapters: [] } } } },
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
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** An address for an identity this person does not act for: reported, never switched. */
export const NotYourIdentity: Story = {
  render: args => <StudioIdentityMissing agents={agents} locale={args.locale} messages={args.messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You can’t write as this identity' })).toBeInTheDocument();
    await expect(canvas.getAllByRole('link', { name: /Lin Mei|Moonlit|Agent/ })).toHaveLength(3);
  },
};
