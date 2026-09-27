import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { inbox, inboxWindow, invitations, memoryInbox, memoryInvitations, NOW, reviews } from './fixtures.ts';
import { RealmInvitations } from './invitations.tsx';
import { NotificationsUnavailable, NotificationsView } from './notifications-view.tsx';

// The notifications page, newest first, over an in-memory stream: sentences
// built from Main's facts, groups shown once, unread marked, mark all read,
// and older windows on request.

type Args = Parameters<typeof NotificationsView>[0] & { calls?: string[] };

const meta = {
  title: 'Shell/Notifications',
  component: NotificationsView,
  render: ({ calls: _calls, ...args }: Args) => <NotificationsView {...args} />,
  parameters: { route: { pathname: '/en/notifications' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

function args(options: { from?: string; refuse?: boolean } = {}): Args {
  const { main, calls } = memoryInbox(inbox, { refuse: options.refuse });
  const latest = options.from ? inbox.slice(4) : inbox;
  return { initial: inboxWindow(latest, options.from ?? '0'), now: NOW, avatarQuery: '', main, calls };
}

export const Latest: Story = {
  args: args(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    const rows = canvas.getAllByRole('listitem');
    // Three replies in one thread read as the newest, with a count.
    await expect(rows[0]).toHaveTextContent('Daniel Chen replied on “雨夜书店” and 2 more like this');
    await expect(rows[0]).toHaveTextContent('Also: chapter four is up!');
    await expect(canvas.getByRole('link', { name: 'Your submission “Middlemarch: A Study of Provincial Life” was accepted' }))
      .toHaveAttribute('href', `/en/w/${'00000703-5555-4a6f-8c2d-3e7b5c1a9f40'}`);
    await expect(canvas.getByText('Moderators reached a decision on a report')).toBeVisible();
    // A role change says where and which role, and opens the Realm by its Zone's address.
    await expect(canvas.getByRole('link', { name: 'Daniel Chen changed your role in Fiction · 小说: Community moderators' }))
      .toHaveAttribute('href', '/en/r/fiction');
    await expect(rows[0]).toHaveTextContent('in Fiction · 小说');
    await expect(canvas.getByText('Aria Wang 王雅 followed you')).toBeVisible();
    await expect(canvas.getByText('This notification is no longer available.')).toBeVisible();
    await expect(canvas.getAllByText('Unread')).toHaveLength(3);

    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(canvas.queryAllByText('Unread')).toHaveLength(0));
    await expect(canvas.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
    await expect(args.calls).toEqual(['read-through:108']);
  },
};

export const OlderOnRequest: Story = {
  args: args({ from: '104' }),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Aria Wang 王雅 followed you')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show older' }));
    await expect(await canvas.findByText('Aria Wang 王雅 followed you')).toBeVisible();
    // Each window ends where the last began: sequences 55–104, fifty at most.
    await expect(args.calls).toEqual(['page:1:54:50']);
  },
};

export const MarkAllRefused: Story = {
  args: args({ refuse: true }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Couldn’t mark them as read');
    await expect(canvas.getAllByText('Unread')).toHaveLength(3);
  },
};

/** Reviews of the reader's Work, and their own review helping others. */
export const Reviews: Story = {
  args: { ...args(), initial: inboxWindow(reviews, '0', '112') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Aria Wang 王雅 reviewed “雨夜书店”')).toBeVisible();
    await expect(canvas.getByText('Quiet, rainy and exactly as sad as it should be.')).toBeVisible();
    await expect(canvas.getByText('Readers are finding your review of “Middlemarch: A Study of Provincial Life” helpful'))
      .toBeVisible();
    await expect(canvas.getByText('in Classic Literature')).toBeVisible();
  },
};

const answering = memoryInvitations();
/** An invitation to join a Realm is answered here, above the notifications, with the choice to be listed. */
export const Invitation: Story = {
  args: { ...args(), invitations: <RealmInvitations invitations={invitations}
    actingSubject="https://rezics.com/id/00000801-5555-4a6f-8c2d-3e7b5c1a9f40" main={answering.main} /> },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Invitations' });
    await expect(within(region).getByRole('link', { name: 'Daniel Chen invited you to join Fiction · 小说' }))
      .toHaveAttribute('href', '/en/r/fiction');
    await userEvent.click(within(region).getByRole('checkbox', { name: 'Show me on its public member list' }));
    await userEvent.click(within(region).getByRole('button', { name: 'Join' }));
    await expect(await within(region).findByRole('status')).toHaveTextContent('You joined Fiction · 小说.');
    await expect(answering.calls).toEqual(['accept:00000901:00000501:true']);
  },
};

export const Empty: Story = {
  args: { ...args(), initial: inboxWindow([], '0', '0') },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
  },
};

export const SignedOut: Story = {
  args: args(),
  render: () => <NotificationsUnavailable reason="signed-out" signInHref="/auth/start?next=%2Fen%2Fnotifications" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Sign in to see your notifications' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', '/auth/start?next=%2Fen%2Fnotifications');
  },
};

export const Failed: Story = {
  args: args(),
  render: () => <NotificationsUnavailable reason="failed" signInHref="/auth/start" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Couldn’t load your notifications');
  },
};

export const Chinese: Story = {
  args: args(),
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/notifications' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '通知' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: '你提交的《Middlemarch: A Study of Provincial Life》已被接受' })).toBeVisible();
  },
};

export const Dark: Story = { args: args(), globals: { theme: 'dark' } };

export const Phone: Story = {
  args: args(),
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
