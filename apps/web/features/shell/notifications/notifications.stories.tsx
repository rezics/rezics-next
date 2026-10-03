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
  roleTaken,
  streamId,
} from './fixtures.ts';
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
  return {
    initial: inboxWindow(latest, options.from ?? '0'),
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
    await expect(rows[0]).toHaveTextContent(
      'Daniel Chen replied on “雨夜书店” and 2 more like this',
    );
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
      canvas.getByText(
        'Readers are finding your review of “Middlemarch: A Study of Provincial Life” helpful',
      ),
    ).toBeVisible();
    await expect(canvas.getByText('in Classic Literature')).toBeVisible();
  },
};

function invitationArgs(): Args {
  const stream = memoryInbox([invitationNotice]);
  const responses = memoryInvitations();
  return {
    ...args(),
    initial: inboxWindow([invitationNotice], '0', '113'),
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
    await expect(canvas.queryByText('Unread')).toBeNull();
    await expect(args.calls).toEqual(['accept:00000901:00000501:false']);
  },
};

export const RoleTaken: Story = {
  args: { ...args(), initial: inboxWindow([roleTaken], '0', '114') },
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
  args: { ...args(), initial: inboxWindow([], '0', '0') },
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
  render: () => <NotificationsUnavailable reason="failed" signInHref="/auth/start" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(
      'Couldn’t load your notifications',
    );
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

function mixedArgs(): Args {
  const items = [
    ...inbox.slice(0, 2),
    governance(210, 'proposal-revised', 'reviewer', { proposal: 910, revision: 4 }),
    governance(211, 'changes-requested', 'author', { saved: true, proposal: 911 }),
    governance(212, 'review-requested', 'steward', { proposal: 912, revision: 1 }),
  ];
  const { main, calls } = memoryInbox(items);
  return { initial: inboxWindow(items, '0', '212'), now: NOW, avatarQuery: '', main, calls };
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
    await userEvent.click(canvas.getAllByRole('button', { name: 'Save' })[0]!);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Saved.');
    await userEvent.click(canvas.getAllByRole('button', { name: 'Mark done' })[0]!);
    await waitFor(() =>
      expect(canvas.queryByRole('link', { name: 'A correction needs your review' })).toBeNull(),
    );
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
    initial: inboxWindow(saved, '0', '221'),
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
    await expect(canvas.getAllByRole('button', { name: 'Unsave' })).toHaveLength(2);
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Unsave' })[0]!);
    await waitFor(() => expect(canvas.getAllByRole('button', { name: 'Unsave' })).toHaveLength(1));
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
    initial: inboxWindow(done, '0', '230'),
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
    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));
    await expect(await canvas.findByRole('heading', { name: 'Nothing done' })).toBeVisible();
  },
};

export const EmptySaved: Story = {
  args: {
    ...args(),
    initial: inboxWindow([], '0', '0'),
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
  return { initial: inboxWindow(items, '0', '240'), now: NOW, avatarQuery: '', main, calls };
}

/** A refused triage leaves the item where it was and says so. */
export const TriageError: Story = {
  args: triageErrorArgs(),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
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
    initial: inboxWindow(newWorks, '0', '123'),
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
export const NewWorksPhone: Story = { ...NewWorks, globals: { viewport: { value: 'mobile' } } };
export const NewWorksDark: Story = { ...NewWorks, globals: { theme: 'dark' } };
