import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, within } from 'storybook/test';
import {
  acting,
  audit,
  book,
  decisions,
  header,
  logApi,
  logNames,
  now,
  occurrences,
  realm,
} from './fixtures.ts';
import { LogView } from './log-view.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmFrame } from './realm-frame.tsx';

const position = { dataEpoch: 'fixture', sequence: '42' };
const auditPage = {
  items: audit,
  nextCursor: 'next',
  sourcePosition: position,
  count: { value: audit.length, kind: 'exact-page' as const, total: null },
};

const meta = {
  title: 'Manage/Log',
  component: LogView,
  parameters: { route: { pathname: `/en/manage/r/${realm}/log` } },
  args: {
    realm,
    actingSubject: acting.iri,
    view: { view: 'audit', kind: null },
    first: { kind: 'audit', page: auditPage },
    names: logNames,
    now,
    locale: 'en',
    messages,
    api: logApi,
  },
  render: (args: ComponentProps<typeof LogView>) => (
    <RealmFrame
      realm={realm}
      header={header}
      agent={acting}
      locale={args.locale}
      messages={args.messages}
    >
      <LogView {...args} />
    </RealmFrame>
  ),
} satisfies Meta<typeof LogView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChapterWithoutLabel: Story = {
  args: {
    names: { ...logNames, chapters: {} },
    api: { ...logApi, names: async () => ({ ...logNames, chapters: {} }) },
  },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('link', { name: 'A chapter of 雨夜书店 · 连载小说' }),
    ).toBeVisible();
  },
};

/**
 * Who changed what, and why: management reasons and decision rationales are
 * shown as written, and a decision names what it was about, a chapter within
 * its Book.
 */
export const AuditLog: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Log' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(canvas.getByRole('link', { name: 'Everything' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const entries = canvas.getAllByRole('listitem').filter((item) => item.closest('ol'));
    await expect(entries).toHaveLength(audit.length);
    await expect(entries[1]).toHaveTextContent(
      'Gave Daniel Chen 陈丹尼 Community moderators until Oct 28, 2026',
    );
    await expect(entries[2]).toHaveTextContent('Kept content and closed the report');
    await expect(within(entries[2]!).getByRole('link', { name: '西游记' })).toBeVisible();
    await expect(entries[3]).toHaveTextContent('Removed content');
    await expect(entries[3]).toHaveTextContent(
      '“Breaks rule 1, “Mark spoilers”. The chapter gives away the ending and was not marked.”',
    );
    await expect(
      within(entries[3]!).getByRole('link', { name: /^第一章 雨夜\s*· 雨夜书店 · 连载小说$/ }),
    ).toHaveAttribute(
      'href',
      localizedPath(
        `${resourceHref('/w/', book.slice(-36))}/read/${occurrences.one.slice(-36)}`,
        'en',
      ),
    );
    await expect(entries[4]).toHaveTextContent('Changed membership');
    await expect(entries[4]).toHaveTextContent('An Wu 吴安');
    await expect(entries[4]).toHaveTextContent('“Repeated off-topic posts after two warnings”');
    await expect(canvas.getByRole('link', { name: 'Realm management' })).toHaveAttribute(
      'href',
      `/en/manage/r/${realm}/log?kind=realm_management`,
    );
    await expect(canvas.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  },
};

export const PublicDecisions: Story = {
  args: {
    view: { view: 'public', kind: null },
    first: {
      kind: 'public',
      page: {
        profile: 'realm-decisions-v1',
        items: decisions,
        nextCursor: null,
        sourcePosition: position,
        count: { value: decisions.length, kind: 'exact-page', total: null },
      },
    },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Anyone can see these decisions on the Realm’s page.'),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: '西游记' })).toHaveAttribute(
      'href',
      localizedPath(resourceHref('/w/', decisions[2]!.work!.slice(-36)), 'en'),
    );
    // An adopted chapter is named in its Book and opens in the reader there.
    await expect(
      canvas.getByRole('link', { name: /^第二章 未寄出的信\s*· 雨夜书店 · 连载小说$/ }),
    ).toHaveAttribute(
      'href',
      localizedPath(
        `${resourceHref('/w/', book.slice(-36))}/read/${occurrences.two.slice(-36)}`,
        'en',
      ),
    );
    await expect(canvas.getAllByText('Rejected')).toHaveLength(1);
  },
};

export const Empty: Story = {
  args: { first: { kind: 'audit', page: { ...auditPage, items: [], nextCursor: null } } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('heading', { name: 'Nothing recorded yet' }),
    ).toBeVisible();
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
