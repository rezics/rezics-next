import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, within } from 'storybook/test';
import { acting, agents, audit, decisions, header, logApi, now, realm, works } from './fixtures.ts';
import { LogView } from './log-view.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmFrame } from './realm-frame.tsx';

const position = { dataEpoch: 'fixture', sequence: '42' };
const auditPage = { items: audit, nextCursor: 'next', sourcePosition: position,
  count: { value: audit.length, kind: 'exact-page' as const, total: null } };

const meta = {
  title: 'Manage/Log',
  component: LogView,
  parameters: { route: { pathname: `/en/manage/r/${realm}/log` } },
  args: { realm, actingSubject: acting.iri, view: { view: 'audit', kind: null }, first: { kind: 'audit', page: auditPage },
    agents, works, now, locale: 'en', messages, api: logApi },
  render: (args: ComponentProps<typeof LogView>) => <RealmFrame realm={realm} header={header} agent={acting}
    locale={args.locale} messages={args.messages}><LogView {...args} /></RealmFrame>,
} satisfies Meta<typeof LogView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Who changed what, and why: management reasons are shown as written. */
export const AuditLog: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Log' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Everything' })).toHaveAttribute('aria-current', 'page');
    const entries = canvas.getAllByRole('listitem').filter(item => item.closest('ol'));
    await expect(entries).toHaveLength(audit.length);
    await expect(entries[3]).toHaveTextContent('Changed membership');
    await expect(entries[3]).toHaveTextContent('An Wu 吴安');
    await expect(entries[3]).toHaveTextContent('“Repeated off-topic posts after two warnings”');
    await expect(canvas.getByRole('link', { name: 'Realm management' })).toHaveAttribute('href',
      `/en/manage/r/${realm}/log?kind=realm_management`);
    await expect(canvas.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  },
};

export const PublicDecisions: Story = {
  args: { view: { view: 'public', kind: null }, first: { kind: 'public', page: { profile: 'realm-decisions-v1',
    items: decisions, nextCursor: null, sourcePosition: position, count: { value: 3, kind: 'exact-page', total: null } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Anyone can see these decisions on the Realm’s page.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: '西游记' })).toHaveAttribute('href', `/en/w/${decisions[1]!.work!.slice(-36)}`);
    await expect(canvas.getAllByText('Rejected')).toHaveLength(1);
  },
};

export const Empty: Story = {
  args: { first: { kind: 'audit', page: { ...auditPage, items: [], nextCursor: null } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Nothing recorded yet' })).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}/log` } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByText('更改了成员')).toHaveLength(1);
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
