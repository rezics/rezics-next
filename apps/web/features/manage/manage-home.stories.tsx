import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { acting, header, iri, now, realm } from './fixtures.ts';
import { ManageHome, type ManagedSummary } from './manage-home.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import type { ManagedRealm } from './types.ts';

const named = (value: string, key: string) => ({ ...header, name: { ...header.name, value }, icon: { ...header.icon, key } });
const managed = (n: number, permissions: string[], open: number, escalated: number, hoursAgo: number | null): ManagedRealm =>
  ({ realm: iri(n), permissions, openCount: { value: open, kind: 'exact' }, escalatedCount: { value: escalated, kind: 'exact' },
    latestActivity: hoursAgo === null ? null : new Date(now - hoursAgo * 3_600_000).toISOString() });

const owner = ['governance.moderate', 'governance.rule.publish', 'publication.adopt', 'realm.members.manage', 'realm.owner',
  'realm.roles.manage', 'realm.settings.manage', 'review.decide'];
/** Daniel's two Realms on the demo stack: Fiction, which he owns, and Classic Literature, where he moderates. */
const realms: ManagedSummary[] = [
  { realm: managed(31, owner, 8, 0, 1), header: named('Fiction · 小说', 'fiction'), address: 'fiction' },
  { realm: managed(1, ['governance.moderate', 'realm.members.manage'], 8, 7, 11), header, address: realm },
  { realm: managed(32, ['review.decide'], 0, 0, null), header: null, address: '00000000-0000-4000-8000-000000000032' },
];

const meta = {
  title: 'Manage/Home',
  component: ManageHome,
  parameters: { route: { pathname: '/en/manage' } },
  args: { agent: acting, realms: { ok: true, data: { items: realms, nextCursor: null } }, moreHref: null, now, locale: 'en',
    messages },
} satisfies Meta<typeof ManageHome>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Realms Main says you hold a role in: your place in each, what waits for you, and what was escalated. */
export const YourRealms: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Manage' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Acting as' })).toHaveTextContent('Daniel Chen 陈丹尼');
    await expect(canvas.queryByRole('search')).toBeNull();
    const cards = within(canvas.getByRole('region', { name: 'Your Realms' })).getAllByRole('listitem');
    await expect(cards[0]).toHaveTextContent('Owner');
    await expect(cards[0]).toHaveTextContent('8 waiting');
    await expect(within(cards[0]!).getByRole('link', { name: 'Open the queue of Fiction · 小说' }))
      .toHaveAttribute('href', '/en/manage/r/fiction');
    await expect(cards[1]).toHaveTextContent('Moderator');
    await expect(cards[1]).toHaveTextContent('7 escalated');
    await expect(cards[1]).toHaveTextContent('Last activity 11 hours ago');
    await expect(cards[2]).toHaveTextContent('Reviewer');
    await expect(cards[2]).toHaveTextContent('Nothing waiting');
  },
};

export const NoRealms: Story = {
  args: { realms: { ok: true, data: { items: [], nextCursor: null } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You don’t manage a Realm yet' })).toBeVisible();
    await expect(canvas.queryByRole('search')).toBeNull();
  },
};

/** More than a page of Realms continues on the next page. */
export const MoreRealms: Story = {
  args: { moreHref: `/manage?after=${encodeURIComponent(iri(32))}` },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Show more Realms' }))
      .toHaveAttribute('href', `/en/manage?after=${encodeURIComponent(iri(32))}`);
  },
};

export const Unavailable: Story = {
  args: { realms: { ok: false, failure: 'unavailable' }, retryHref: '/en/manage' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Couldn’t load this' })).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/manage' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('8 项待处理')[0]).toBeVisible();
    await expect(canvas.getByText('所有者')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '打开Fiction · 小说的待办' })).toHaveAttribute('href', '/zh-Hans/manage/r/fiction');
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
