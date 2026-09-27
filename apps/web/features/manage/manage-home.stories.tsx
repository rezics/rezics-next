import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { acting, header, iri, now, queuePage, realm } from './fixtures.ts';
import { ManageHome, type RealmSummary } from './manage-home.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import type { RealmSearch } from './realm-finder.tsx';

const serials = '00000000-0000-4000-8000-000000000021';
const cooking = '00000000-0000-4000-8000-000000000022';
const named = (value: string, key: string) => ({ ...header, id: iri(Number(key.slice(-2))),
  name: { ...header.name, value }, icon: { ...header.icon, key } });

const realms: RealmSummary[] = [
  { realm, header, queue: { ok: true, data: queuePage } },
  { realm: serials, header: named('中文网络小说 · Chinese Web Fiction', serials),
    queue: { ok: true, data: { ...queuePage, items: [] } } },
  { realm: cooking, header: named('Home Cooking · 家常菜', cooking), queue: { ok: false, failure: 'denied' } },
];

const search: RealmSearch = async query => ({ ok: true, data: { profile: 'realm-directory-v1', nextCursor: null,
  sourcePosition: { dataEpoch: 'fixture', sequence: '1' }, count: { value: 1, kind: 'exact-page', total: null },
  items: query.toLowerCase().includes('class') ? [{ id: iri(1), space: iri(2), name: header.name, icon: header.icon,
    description: null, membership: { count: { kind: 'unknown', value: null } }, links: { realm: `/v1/realms/${realm}` } }] : [] } });

const meta = {
  title: 'Manage/Home',
  component: ManageHome,
  parameters: { route: { pathname: '/en/manage' } },
  args: { agent: acting, realms, now, locale: 'en', messages, search },
} satisfies Meta<typeof ManageHome>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Each Realm at a glance: how much waits, what was escalated, and how long the oldest item has waited. */
export const YourRealms: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Manage' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Acting as' })).toHaveTextContent('Daniel Chen 陈丹尼');
    const cards = within(canvas.getByRole('region', { name: 'Your Realms' })).getAllByRole('listitem');
    await expect(cards[0]).toHaveTextContent('7 waiting');
    await expect(cards[0]).toHaveTextContent('1 escalated');
    await expect(cards[0]).toHaveTextContent(/Oldest waiting since 2 days ago/);
    await expect(within(cards[0]!).getByRole('link', { name: 'Open queue' })).toHaveAttribute('href', `/en/manage/r/${realm}`);
    await expect(cards[1]).toHaveTextContent('Nothing waiting');
    await expect(cards[2]).toHaveTextContent('You no longer manage this Realm.');
    await expect(within(cards[2]!).queryByRole('link', { name: 'Open queue' })).toBeNull();
    await expect(within(cards[2]!).getByRole('button', { name: 'Remove Home Cooking · 家常菜 from this list' })).toBeVisible();
  },
};

export const FirstVisit: Story = {
  args: { realms: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Open a Realm you moderate' })).toBeVisible();
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Realm name' }), 'classic{enter}');
    await expect(await canvas.findByRole('link', { name: /Classic Literature/ })).toHaveAttribute('href', `/en/manage/r/${realm}`);
    await userEvent.clear(canvas.getByRole('searchbox', { name: 'Realm name' }));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Realm name' }), 'knitting{enter}');
    await expect(await canvas.findByText('No Realms match “knitting”.')).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/manage' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('7 项待处理')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: '打开待办' })[0]).toHaveAttribute('href', `/zh-Hans/manage/r/${realm}`);
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
