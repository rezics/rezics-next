import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { agents, home } from './fixtures.ts';
import { messages } from './messages.ts';
import { StudioFrame, StudioIdentityMissing } from './studio-frame.tsx';
import { StudioHome } from './studio-home.tsx';

type Props = ComponentProps<typeof StudioHome> & { session?: (typeof agents)[number] | null };

const meta = {
  title: 'Studio/Home',
  component: StudioHome,
  parameters: { route: { pathname: '/en/studio/@agent-00000000-0000-4000-8000-000000000001' } },
  args: { agent: agents[0]!, home, moreHref: null, locale: 'en', messages: messages.en, session: agents[0]! },
  render: ({ session = null, ...args }: Props) => <StudioFrame agent={args.agent} agents={agents} session={session} path=""
    locale={args.locale} messages={args.messages}><StudioHome {...args} /></StudioFrame>,
} satisfies Meta<Props>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Works: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Writing as' })).toHaveTextContent('Lin Mei 林梅');
    await expect(canvas.getByRole('link', { name: 'New work' })).toHaveAttribute('href',
      '/en/studio/@agent-00000000-0000-4000-8000-000000000001/new');
    const drafts = canvas.getByRole('region', { name: /Drafts/ });
    await expect(within(drafts).getAllByRole('listitem')).toHaveLength(2);
    await expect(within(drafts).getAllByRole('link', { name: 'Continue writing' })[0]).toHaveAttribute('href',
      expect.stringMatching(/\/works\/.+\/write\/.+\?revision=/));
    await expect(within(canvas.getByRole('region', { name: /Published/ })).getAllByRole('listitem')).toHaveLength(2);
    const review = canvas.getByRole('region', { name: /In review/ });
    // Still open with the Realm first, newest first.
    await expect(within(review).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('Changes requested'), expect.stringContaining('Waiting for review'),
      expect.stringContaining('Accepted')]);
    await expect(review).toHaveTextContent('Please add a content note for the opening chapter.');
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
    await expect(menu.getByRole('menuitem', { name: /Lin Mei 林梅/ })).toHaveAttribute('href',
      '/en/studio/@agent-00000000-0000-4000-8000-000000000001');
    await expect(menu.getByRole('menuitem', { name: /Moonlit Scribe/ })).toHaveAttribute('aria-current', 'page');
  },
};

export const Empty: Story = {
  args: { home: { texts: { ok: true, data: { items: [], nextCursor: null } }, submissions: { ok: true, data: [] }, realms: {} } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Your Studio is ready' })).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Start a new work' })).toBeInTheDocument();
  },
};

/** Main does not yet let this identity list its own texts; Studio says so instead of showing an empty shelf. */
export const WorksNotListed: Story = {
  args: { home: { texts: { ok: false, failure: 'denied' }, submissions: { ok: false, failure: 'missing' }, realms: {} } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Your works can’t be listed for this identity yet.')).toBeInTheDocument();
    await expect(canvas.getByText('Realm submissions can’t be listed for this identity yet.')).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'New work' })).toBeInTheDocument();
  },
};

export const Unavailable: Story = {
  args: { home: { texts: { ok: false, failure: 'unavailable' }, submissions: { ok: false, failure: 'unavailable' }, realms: {} } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/studio/@agent-00000000-0000-4000-8000-000000000001' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '创作室' })).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: '新作品' })).toHaveAttribute('href',
      '/zh-Hans/studio/@agent-00000000-0000-4000-8000-000000000001/new');
    await expect(canvas.getAllByText('草稿').length).toBeGreaterThan(0);
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** An address for someone else's identity: reported, with this person's own identities to choose from. */
export const NotYourIdentity: Story = {
  render: args => <StudioIdentityMissing agents={agents} locale={args.locale} messages={args.messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You can’t write as this identity' })).toBeInTheDocument();
    await expect(within(canvas.getByRole('navigation')).getAllByRole('link')).toHaveLength(3);
  },
};
