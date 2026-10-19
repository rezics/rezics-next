import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { localizedPath } from '../../../i18n/locale.ts';
import { resourceHref, spaceHref } from '../../address/path.ts';
import {
  governance,
  inbox,
  inboxWindow,
  invitationNotice,
  invitations,
  memoryInbox,
  memoryInvitations,
  NOW,
  reviews,
  newWorks,
  banNotices,
  roleTaken,
  streamId,
} from './fixtures.ts';
import { sanctionSentence } from './sanction.ts';
import { RealmInvitations } from './invitations.tsx';
import { NotificationsUnavailable, NotificationsView } from './notifications-view.tsx';
import { AppShell } from '../app-shell.tsx';
import { messages as shellMessages } from '../messages.ts';
import { NotificationsLink } from '../notifications-link.tsx';
import { setUnread } from '../unread.ts';

// The notifications page, newest first, over an in-memory stream: sentences
// built from Main's facts, groups shown once, unread marked, mark all read,
// and further matching pages on request.

type Args = Parameters<typeof NotificationsView>[0] & { calls?: string[] };

const meta = {
  title: 'Shell/Notifications',
  component: NotificationsView,
  render: ({ calls: _calls, ...args }: Args) => <NotificationsView {...args} />,
  parameters: { route: { pathname: '/en/notifications' } },
  globals: { viewport: { value: 'desktop1440' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

function args(options: { next?: string; refuse?: boolean } = {}): Args {
  const { main, calls } = memoryInbox(inbox, { refuse: options.refuse });
  const latest = options.next ? inbox.slice(4) : inbox;
  return {
    initial: inboxWindow(latest, options.next ?? null),
    now: NOW,
    avatarQuery: '',
    main,
    calls,
  };
}

export const Latest: Story = {
  args: args(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    const rows = canvas.getAllByRole('listitem');
    // Three replies in one thread read as the newest, with a count.
    const thread = within(rows[0]!);
    await expect(thread.getByRole('link', { name: 'Daniel Chen replied on “雨夜书店”' })).toHaveTextContent('雨夜书店');
    await expect(thread.getByText('Replied')).toBeVisible();
    await expect(thread.getByText('Daniel Chen')).toBeVisible();
    await expect(thread.getByText('and 2 more like this')).toBeVisible();
    await expect(rows[0]).toHaveTextContent('Also: chapter four is up!');
    await expect(
      canvas.getByRole('link', {
        name: 'Your submission “Middlemarch: A Study of Provincial Life” was accepted',
      }),
    ).toHaveAttribute('href', localizedPath(resourceHref('/w/', streamId(703)), 'en'));
    await expect(canvas.getByText('Moderators reached a decision on a report')).toBeVisible();
    // A role change says where and which role, and opens the Realm by its Zone's address.
    await expect(
      canvas.getByRole('link', {
        name: 'You now have the Community moderators role in Fiction · 小说',
      }),
    ).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'community'), 'en'));
    await expect(rows[0]).toHaveTextContent('in Fiction · 小说');
    await expect(canvas.getByText('Aria Wang 王雅')).toBeVisible();
    await expect(canvas.getByText('Followed you')).toBeVisible();
    await expect(canvas.getByText('This notification is no longer available.')).toBeVisible();
    await expect(canvas.getAllByText('Unread')).toHaveLength(3);

    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(canvas.queryAllByText('Unread')).toHaveLength(0));
    await expect(canvas.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
    await expect(args.calls).toEqual(['read-through:1:108', 'count']);
  },
};

export const MoreOnRequest: Story = {
  args: args({ next: 'older:1:105' }),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Followed you')).toBeNull();
    const newest = canvas.getAllByRole('listitem')[0]!;
    await expect(newest).toHaveTextContent('Also: chapter four is up!');
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await expect(await canvas.findByText('Followed you')).toBeVisible();
    await expect(canvas.getByText('Aria Wang 王雅')).toBeVisible();
    await expect(canvas.getAllByRole('listitem')[0]).toBe(newest);
    await expect(canvas.getAllByRole('listitem').at(-1)).toHaveTextContent('This notification is no longer available.');
    await expect(args.calls).toEqual(['page:older:1:105:50']);
    await expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull();
  },
};

function sparseSavedArgs(): Args {
  const saved = [137, 274, 5000, 10000].map((sequence, index) =>
    governance(sequence, 'proposal-revised', 'manual', { saved: true, proposal: 950 + index }));
  const stream = [saved[0]!, saved[1]!, governance(1000, 'proposal-revised', 'manual'),
    governance(2000, 'proposal-revised', 'author', { saved: true }), saved[2]!, saved[3]!];
  const { main, calls } = memoryInbox(stream);
  return { initial: inboxWindow(saved.slice(2), 'older:1:5000', '10000'), now: NOW, avatarQuery: '', main, calls,
    selection: { view: 'saved', reason: 'manual' } as const };
}

/** Sparse Saved matches carry their reason and cursor across unrelated notifications. */
export const SparseSavedPagination: Story = {
  args: sparseSavedArgs(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.getAllByRole('link', { name: 'A correction was revised' }).map(link => link.getAttribute('href')))
      .toEqual([953, 952].map(proposal => `/en/proposals/${streamId(proposal)}?revision=2`));
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.getAllByRole('listitem')).toHaveLength(4));
    const links = canvas.getAllByRole('link', { name: 'A correction was revised' });
    await expect(new Set(links.map(link => link.getAttribute('href'))).size).toBe(4);
    await expect(links.map(link => link.getAttribute('href')))
      .toEqual([953, 952, 951, 950].map(proposal => `/en/proposals/${streamId(proposal)}?revision=2`));
    await expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull();
    await expect(args.calls).toEqual(['page:older:1:5000:50:saved:manual']);
  },
};

/**
 * The shell's count is every unread notification, not the filtered matches: with six unread and two Saved
 * matches shown, the navigation says "6 unread" and the list states no total of its own.
 */
export const FilteredBesideShellCount: Story = {
  args: sparseSavedArgs(),
  // The generation is the view's own: a count of another generation is dropped when the view mounts.
  beforeEach() { setUnread({ count: 6, overflow: false, generation: '1' }); },
  render: ({ calls: _calls, ...args }: Args) => (
    <AppShell locale="en" messages={shellMessages} theme="light" navCollapsed={false} signedIn
      notifications={<NotificationsLink />} account={null}>
      <NotificationsView {...args} />
    </AppShell>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole('navigation', { name: 'Main navigation' });
    await expect(within(nav).getByRole('link', { name: 'Notifications, 6 unread' })).toBeVisible();
    await expect(within(nav).getByText('6 unread')).toBeVisible();
    const page = within(canvas.getByRole('main'));
    await expect(page.getAllByRole('listitem')).toHaveLength(2);
    await expect(page.queryByText(/\b6\b/)).toBeNull();
  },
};

/** A reset replaces the old generation, including its read watermark. */
export const ContinuationReset: Story = {
  args: (() => {
    const replacement = [governance(1, 'proposal-revised', 'manual', { proposal: 960 })];
    const { main, calls } = memoryInbox(replacement, { generation: '2' });
    return { initial: inboxWindow(inbox.slice(0, 4), 'older:1:104'), now: NOW, avatarQuery: '', main, calls };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Followed you')).toBeVisible();
    await expect(canvas.getByText('Aria Wang 王雅')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await expect(await canvas.findByRole('link', { name: 'A correction was revised' })).toBeVisible();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(1);
    await expect(canvas.queryByText('Followed you')).toBeNull();
    await expect(canvas.queryByText('Aria Wang 王雅')).toBeNull();
    await expect(canvas.getByText('Unread')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(canvas.queryByText('Unread')).toBeNull());
    await expect(args.calls).toEqual(['page:older:1:104:50', 'count', 'read-through:2:1', 'count']);
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
  args: { ...args(), initial: inboxWindow(reviews, null, '112') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Aria Wang 王雅')).toBeVisible();
    await expect(canvas.getByText('Posted a review')).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Aria Wang 王雅 reviewed “雨夜书店”' }),
    ).toHaveAttribute(
      'href',
      `${localizedPath(resourceHref('/w/', streamId(801)), 'en')}#review-${streamId(111)}`,
    );
    await expect(
      canvas.getByText('Quiet, rainy and exactly as sad as it should be.'),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Readers are finding your review of “Middlemarch: A Study of Provincial Life” helpful' }),
    ).toBeVisible();
    await expect(canvas.getByText('Readers are finding your review helpful')).toBeVisible();
    await expect(canvas.getByText('in Classic Literature')).toBeVisible();
  },
};

function invitationArgs(): Args {
  const stream = memoryInbox([invitationNotice]);
  const responses = memoryInvitations();
  return {
    ...args(),
    initial: inboxWindow([invitationNotice], null, '113'),
    actingSubject: 'https://rezics.com/id/00000801-5555-4a6f-8c2d-3e7b5c1a9f40',
    main: { v1: { ...stream.main.v1, realms: responses.main.v1.realms } } as typeof stream.main,
    calls: responses.calls,
  };
}

export const InvitationNotificationPending: Story = { args: invitationArgs() };

/** The notification itself can answer the invitation and then reads it. */
export const InvitationNotification: Story = {
  args: invitationArgs(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('link', { name: 'Daniel Chen invited you to join Fiction · 小说' }),
    ).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'community'), 'en'));
    await expect(canvas.getByText('Unread')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Join' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('You joined Fiction · 小说.');
    await expect(canvas.getByRole('status')).toHaveFocus();
    await expect(canvas.queryByText('Unread')).toBeNull();
    await expect(args.calls).toEqual(['accept:00000901:00000501:false']);
  },
};

export const InvitationNotificationDecline: Story = {
  args: invitationArgs(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Join' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Actions' })).toHaveAttribute('aria-expanded', 'false');
    canvas.getByRole('button', { name: 'Decline' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('status')).toHaveTextContent('You declined the invitation to Fiction · 小说.');
    await expect(canvas.getByRole('status')).toHaveFocus();
    await expect(args.calls).toEqual(['decline:00000901:00000501:false']);
  },
};

/** A ban states the Realm, the reason and the end, and links to the Realm page. It does not name a moderator. */
export const Ban: Story = {
  args: { ...args(), initial: inboxWindow(banNotices, null, '117') },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const timed = sanctionSentence('en', { action: 'ban', realm: 'Fiction · 小说',
      reason: 'Repeated rule violations', until: '2026-11-01T00:00:00.000Z', permanent: false });
    const permanent = sanctionSentence('en', { action: 'ban', realm: 'Fiction · 小说',
      reason: 'Harassment after a warning', until: null, permanent: true });
    const lifted = sanctionSentence('en', { action: 'unban', realm: 'Fiction · 小说',
      reason: 'The report was withdrawn', until: null, permanent: false });
    const realm = localizedPath(spaceHref('fiction', 'community'), 'en');
    await expect(canvas.getByRole('link', { name: timed })).toHaveAttribute('href', realm);
    await expect(canvas.getByRole('link', { name: permanent })).toHaveAttribute('href', realm);
    await expect(canvas.getByRole('link', { name: lifted })).toHaveAttribute('href', realm);
    await expect(canvasElement.textContent).not.toContain('Daniel Chen');
    await expect(canvasElement.textContent).not.toContain('daniel_chen');
  },
};

export const RoleTaken: Story = {
  args: { ...args(), initial: inboxWindow([roleTaken], null, '114') },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('link', {
        name: 'You no longer have the Community moderators role in Fiction · 小说',
      }),
    ).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'community'), 'en'));
  },
};

const answering = memoryInvitations();
/** An invitation to join a Realm is answered here, above the notifications, with the choice to be listed. */
export const Invitation: Story = {
  args: {
    ...args(),
    invitations: (
      <RealmInvitations
        invitations={invitations}
        actingSubject="https://rezics.com/id/00000801-5555-4a6f-8c2d-3e7b5c1a9f40"
        main={answering.main}
      />
    ),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Invitations' });
    await expect(
      within(region).getByRole('link', { name: 'Daniel Chen invited you to join Fiction · 小说' }),
    ).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'community'), 'en'));
    await userEvent.click(
      within(region).getByRole('checkbox', { name: 'Show me on its public member list' }),
    );
    await userEvent.click(within(region).getByRole('button', { name: 'Join' }));
    await expect(await within(region).findByRole('status')).toHaveTextContent(
      'You joined Fiction · 小说.',
    );
    await expect(answering.calls).toEqual(['accept:00000901:00000501:true']);
  },
};

export const Empty: Story = {
  args: { ...args(), initial: inboxWindow([], null, '0') },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('heading', { name: 'Nothing here yet' }),
    ).toBeVisible();
  },
};

export const SignedOut: Story = {
  args: args(),
  render: () => (
    <NotificationsUnavailable
      reason="signed-out"
      signInHref="/auth/start?next=%2Fen%2Fnotifications"
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'Sign in to see your notifications' }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/auth/start?next=%2Fen%2Fnotifications',
    );
  },
};

export const Failed: Story = {
  args: args(),
  render: () => <NotificationsUnavailable reason="failed" failure="unavailable" reference="ab12cd34" signInHref="/auth/start" />,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Couldn’t load your notifications');
    await expect(alert).toHaveTextContent('Something went wrong on our side.');
    await expect(alert).toHaveTextContent('Reference: ab12cd34');
    await expect(alert).not.toHaveTextContent('connection');
  },
};

export const Offline: Story = {
  args: args(),
  render: () => <NotificationsUnavailable reason="failed" failure="offline" signInHref="/auth/start" />,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Check your connection, then try again.');
    await expect(alert).not.toHaveTextContent('Reference');
  },
};

export const Chinese: Story = {
  args: args(),
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/notifications' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '通知' })).toBeVisible();
    await expect(
      canvas.getByRole('link', {
        name: '你提交的《Middlemarch: A Study of Provincial Life》已被接受',
      }),
    ).toBeVisible();
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

/** The original audit's first viewport, with unread state intact and triage disclosed on request. */
export const Ready: Story = {
  args: args(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole('listitem');
    await expect(rows).toHaveLength(6);
    const first = within(rows[0]!);
    await expect(first.getByRole('link', { name: 'Daniel Chen replied on “雨夜书店”' })).toHaveTextContent('雨夜书店');
    await expect(first.getByText('Replied')).toBeVisible();
    await expect(first.getByText('Daniel Chen')).toBeVisible();
    await expect(rows[0]!.querySelector('time')).toHaveAttribute('datetime', inbox.at(-1)!.createdAt);
    await expect(canvas.getByRole('link', { name: 'Your submission “Middlemarch: A Study of Provincial Life” was accepted' }))
      .toHaveTextContent('Middlemarch: A Study of Provincial Life');
    await expect(canvas.getByText('Submission accepted')).toBeVisible();
    await expect(canvas.getByText('Moderators reached a decision on a report')).toBeVisible();
    await expect(canvas.getAllByText('Unread')).toHaveLength(3);
    await expect(canvas.getAllByRole('button', { name: 'Actions' })).toHaveLength(6);
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Mark done' })).toBeNull();
    await expect(args.calls).toEqual([]);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const ReadyPhone: Story = { args: args(), globals: { viewport: { value: 'phone' } }, play: Ready.play };
export const ReadyDark: Story = { args: args(), globals: { theme: 'dark' }, play: Ready.play };
export const ReadyPhoneDark: Story = {
  args: args(), globals: { theme: 'dark', viewport: { value: 'phone' } }, play: Ready.play,
};
export const ChinesePhone: Story = { ...Chinese, args: args(), globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

/** Opening and triage are distinct keyboard targets; removing a row continues in the list. */
export const KeyboardTriage: Story = {
  args: args(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const first = canvas.getAllByRole('listitem')[0]!;
    const row = within(first);
    row.getByRole('link', { name: 'Daniel Chen replied on “雨夜书店”' }).focus();
    await userEvent.tab();
    const actions = row.getByRole('button', { name: 'Actions' });
    await expect(actions).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(actions).toHaveAttribute('aria-expanded', 'true');
    await userEvent.tab();
    await expect(row.getByRole('button', { name: 'Save' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(await row.findByRole('status')).toHaveTextContent('Saved.');
    await expect(row.getByRole('button', { name: 'Unsave' })).toHaveAttribute('aria-pressed', 'true');
    await expect(row.getByText('Unread')).toBeVisible();
    await userEvent.tab();
    await expect(row.getByRole('button', { name: 'Mark done' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(first).not.toBeInTheDocument());
    await expect(canvas.getAllByRole('button', { name: 'Actions' })[0]).toHaveFocus();
    await expect(args.calls).toEqual([
      'triage:00000108:true:undefined:',
      'triage:00000108:undefined:true:1',
    ]);
  },
};

export const OpenWithoutTriage: Story = {
  args: args(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const row = within(canvas.getAllByRole('listitem')[0]!);
    const link = row.getByRole('link', { name: 'Daniel Chen replied on “雨夜书店”' });
    link.addEventListener('click', event => event.preventDefault(), { once: true });
    await userEvent.click(link);
    await waitFor(() => expect(row.queryByText('Unread')).toBeNull());
    await expect(row.getByRole('button', { name: 'Actions' })).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(args.calls).toEqual(['read:00000108', 'count']));
  },
};

function mixedArgs(): Args {
  const items = [
    ...inbox.slice(0, 2),
    governance(210, 'proposal-revised', 'reviewer', { proposal: 910, revision: 4 }),
    governance(211, 'changes-requested', 'author', { saved: true, proposal: 911 }),
    governance(212, 'review-requested', 'steward', { proposal: 912, revision: 1 }),
  ];
  const { main, calls } = memoryInbox(items);
  return { initial: inboxWindow(items, null, '212'), now: NOW, avatarQuery: '', main, calls };
}

/** Inbox, Saved and Done, with corrections of more than one reason beside ordinary notices. */
export const Mixed: Story = {
  args: mixedArgs(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(canvas.getByRole('link', { name: 'Review requested' })).toHaveAttribute(
      'href',
      '/en/notifications?reason=steward',
    );
    await expect(canvas.getByRole('link', { name: 'Saved' })).toHaveAttribute(
      'href',
      '/en/notifications?view=saved',
    );
    await expect(
      canvas.getByRole('link', { name: 'A correction needs your review' }),
    ).toHaveAttribute('href', `/en/proposals/${streamId(912)}?revision=1`);
    await expect(canvas.getByText('Changes were requested on your correction')).toBeVisible();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Actions' })[0]!);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Save' })[0]!);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Saved.');
    await userEvent.click(canvas.getAllByRole('button', { name: 'Mark done' })[0]!);
    await waitFor(() =>
      expect(canvas.queryByRole('link', { name: 'A correction needs your review' })).toBeNull(),
    );
    await expect(canvas.getAllByRole('button', { name: 'Actions' })[0]).toHaveFocus();
    await expect(args.calls?.some((call) => call.startsWith('triage:'))).toBe(true);
  },
};

export const MixedDark: Story = { args: mixedArgs(), globals: { theme: 'dark' }, play: Mixed.play };

export const MixedPhone: Story = {
  args: mixedArgs(),
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

function savedArgs(): Args {
  const saved = [
    governance(220, 'changes-requested', 'author', { saved: true, proposal: 920 }),
    governance(221, 'proposal-decided', 'author', { saved: true, proposal: 921 }),
  ];
  const { main, calls } = memoryInbox(saved);
  return {
    initial: inboxWindow(saved, null, '221'),
    now: NOW,
    avatarQuery: '',
    main,
    calls,
    selection: { view: 'saved', reason: null },
  };
}

/** The Saved view holds only what was saved, and unsaving takes it off this view. */
export const SavedOnly: Story = {
  args: savedArgs(),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Saved' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const trigger of canvas.getAllByRole('button', { name: 'Actions' })) await userEvent.click(trigger);
    await expect(canvas.getAllByRole('button', { name: 'Unsave' })).toHaveLength(2);
    for (const button of canvas.getAllByRole('button', { name: 'Unsave' })) await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Unsave' })[0]!);
    await waitFor(() => expect(canvas.getAllByRole('button', { name: 'Unsave' })).toHaveLength(1));
    await expect(canvas.getByRole('button', { name: 'Actions' })).toHaveFocus();
  },
};

export const SavedOnlyDark: Story = {
  args: savedArgs(),
  globals: { theme: 'dark' },
  play: SavedOnly.play,
};

function doneArgs(): Args {
  const done = [governance(230, 'proposal-withdrawn', 'manual', { done: true, proposal: 930 })];
  const { main, calls } = memoryInbox(done);
  return {
    initial: inboxWindow(done, null, '230'),
    now: NOW,
    avatarQuery: '',
    main,
    calls,
    selection: { view: 'done', reason: null },
  };
}

/** Marking done leaves the inbox; undoing leaves Done. */
export const DoneUndo: Story = {
  args: doneArgs(),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Done' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await expect(canvas.getByRole('button', { name: 'Undo' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));
    await expect(await canvas.findByRole('heading', { name: 'Nothing done' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Notifications' })).toHaveFocus();
  },
};

export const EmptySaved: Story = {
  args: {
    ...args(),
    initial: inboxWindow([], null, '0'),
    selection: { view: 'saved', reason: null },
  },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('heading', { name: 'Nothing saved' }),
    ).toBeVisible();
  },
};

export const EmptyDark: Story = { ...Empty, globals: { theme: 'dark' } };

function triageErrorArgs(): Args {
  const items = [governance(240, 'review-requested', 'steward')];
  const { main, calls } = memoryInbox(items, { refuseTriage: true });
  return { initial: inboxWindow(items, null, '240'), now: NOW, avatarQuery: '', main, calls };
}

/** A refused triage leaves the item where it was and says so. */
export const TriageError: Story = {
  args: triageErrorArgs(),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Actions' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Couldn’t update this notification',
    );
    await expect(
      canvas.getByRole('link', { name: 'A correction needs your review' }),
    ).toBeVisible();
  },
};

export const TriageErrorDark: Story = {
  args: triageErrorArgs(),
  globals: { theme: 'dark' },
  play: TriageError.play,
};

export const FailedDark: Story = { ...Failed, globals: { theme: 'dark' } };

/** Followed topics and named saved views lead to the Work's current canonical address. */
export const NewWorks: Story = {
  args: {
    initial: inboxWindow(newWorks, null, '123'),
    now: NOW,
    avatarQuery: '',
    main: memoryInbox(newWorks).main,
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'New in Fantasy: 雨夜书店' })).toHaveAttribute(
      'href',
      localizedPath(resourceHref('/w/', 'rainy-bookshop'), 'en'),
    );
    await expect(
      canvas.getByRole('link', { name: 'New in English novels without spoilers: Middlemarch' }),
    ).toHaveAttribute('href', localizedPath(resourceHref('/w/', 'middlemarch'), 'en'));
    await expect(canvas.getByText('This notification is no longer available.')).toBeVisible();
  },
};
export const NewWorksPhone: Story = { ...NewWorks, globals: { viewport: { value: 'phone' } } };
export const NewWorksDark: Story = { ...NewWorks, globals: { theme: 'dark' } };
