import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import type { MainClient } from '../../feed/types.ts';
import { setUnread, setUnreadGeneration, useUnread } from '../unread.ts';
import { governance, inboxWindow, invitationNotice, NOW, streamId } from './fixtures.ts';
import { NotificationsView } from './notifications-view.tsx';
import type { NotificationWindow, StreamItem } from './window.ts';

type Answer = { data: unknown; error: null } | { data: null; error: { status: number; value: null } };
type Query = { before: string; limit: number; view?: string; reason?: string };
const answer = (data: unknown): Answer => ({ data, error: null });
const count = (generation: string, value: number) => answer({
  profile: 'notification-unread-count-v1', generation, count: value, overflow: false });
const watermark = (generation: string, readThrough: string) => answer({
  profile: 'notification-read-watermark-v1', generation, readThrough });

function deferred() {
  let resolve!: (value: Answer) => void;
  const promise = new Promise<Answer>(done => { resolve = done; });
  return { promise, async release(value: Answer) {
    resolve(value);
    // Let both the transport completion and React render before checking for stale writes.
    await new Promise<void>(done => requestAnimationFrame(() => done()));
  } };
}

function windowOf(items: StreamItem[], generation = '1', head = items.at(-1)?.sequence ?? '0',
  next: string | null = null): NotificationWindow {
  return { ...inboxWindow(items, next, head), generation, readThrough: '0' };
}
const page = (window: NotificationWindow, reset = false) => answer({
  ...window, profile: 'notification-stream-page-v1', reset });
const notice = (sequence: number) => governance(sequence, 'proposal-revised', 'manual', { proposal: 1000 + sequence });

function scripted(options: {
  page: (query: Query) => Answer | Promise<Answer>;
  mark?: (body: { generation: string; readThrough: string }) => Answer | Promise<Answer>;
  count?: () => Answer | Promise<Answer>; read?: () => Answer | Promise<Answer>;
  triage?: () => Answer | Promise<Answer>; invitation?: () => Answer | Promise<Answer>;
}) {
  const calls: string[] = [];
  let generation = '1';
  const notifications = Object.assign(({ item }: { item: string }) => ({
    read: { put: async () => { calls.push(`read:${item}`); return options.read?.() ?? answer({ readAt: NOW }); } },
    triage: { put: async () => { calls.push('triage'); return options.triage?.() ?? answer({ saved: true, done: false, revision: '1' }); } },
  }), {
    get: async ({ query }: { query: Query }) => {
      calls.push(`page:${query.before}:${query.view ?? 'inbox'}:${query.reason ?? 'all'}`);
      const response = await options.page(query);
      if (response.data) generation = (response.data as NotificationWindow).generation;
      return response;
    },
    'unread-count': { get: async () => { calls.push('count'); return options.count?.() ?? count(generation, generation === '2' ? 5 : 0); } },
  });
  const main = { v1: { me: { notifications, 'notification-read-watermarks': { inbox: {
    put: async (body: { generation: string; readThrough: string }) => {
      calls.push(`mark:${body.generation}:${body.readThrough}`);
      return options.mark?.(body) ?? watermark(body.generation, body.readThrough);
    },
  } } }, realms: () => ({ invitations: () => ({ response: { post: async () => {
    calls.push('invitation'); return options.invitation?.() ?? answer({});
  } } }) }) } } as unknown as MainClient;
  return { main, calls };
}

function Badge() {
  const unread = useUnread(true);
  return <output aria-label="Unread badge">{unread?.count ?? 0}</output>;
}
type Args = Parameters<typeof NotificationsView>[0] & { calls: string[]; release?: () => Promise<void> };
const meta = {
  title: 'Shell/Notification traversal', component: NotificationsView,
  render: ({ calls: _calls, release: _release, ...args }: Args) => <>
    <NotificationsView {...args} /><Badge />
  </>,
  parameters: { route: { pathname: '/en/notifications' } },
  globals: { viewport: { value: 'desktop' } },
  beforeEach() {
    setUnreadGeneration('1');
    setUnread({ count: 2, overflow: false, generation: '1' });
    const original = window.fetch;
    const fetch = spyOn(window, 'fetch').mockImplementation((input, init) =>
      String(input).includes('/notifications/unread-count')
        ? Promise.resolve(new Response(null, { status: 503 })) : original(input, init));
    return () => fetch.mockRestore();
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
const base = { now: NOW, avatarQuery: '' };
const resetPage = () => page(windowOf([notice(1)], '2'), true);
const resetVisible = (canvas: ReturnType<typeof within>) => waitFor(() =>
  expect(canvas.getByRole('link', { name: 'A correction was revised' }))
    .toHaveAttribute('href', `/en/proposals/${streamId(1001)}?revision=2`));

export const MarkAllOpeningHead: Story = {
  args: (() => ({ ...base, initial: windowOf([notice(100)], '1', '100', 'older-anchor'),
    ...scripted({ page: () => page(windowOf([notice(50)], '1', '101')),
      count: () => count('1', 1) }) }))(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.getAllByRole('listitem')).toHaveLength(2));
    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(canvas.queryAllByText('Unread')).toHaveLength(0));
    await expect(args.calls).toContain('mark:1:100');
    await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('1');
  },
};

export const LateMarkAfterReset: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)], '1', '100', 'reset'),
      ...scripted({ page: resetPage, mark: () => pending.promise }),
      release: () => pending.release(watermark('1', '100')) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await resetVisible(canvas);
    await args.release!();
    await expect(canvas.getByText('Unread')).toBeVisible();
    await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('5');
    await expect(args.calls.filter(call => call === 'count')).toHaveLength(1);
  },
};

async function readLink(canvas: ReturnType<typeof within>) {
  const link = canvas.getByRole('link', { name: 'A correction was revised' });
  link.addEventListener('click', (event: Event) => event.preventDefault(), { once: true });
  await userEvent.click(link);
}

export const LateCountAfterReset: Story = {
  args: (() => {
    const pending = deferred();
    let counts = 0;
    return { ...base, initial: windowOf([notice(100)], '1', '100', 'reset'),
      ...scripted({ page: resetPage, count: () => ++counts === 1 ? pending.promise : count('2', 5) }),
      release: () => pending.release(count('1', 0)) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await readLink(canvas);
    await waitFor(() => expect(args.calls).toContain('count'));
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await resetVisible(canvas);
    await args.release!();
    await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('5');
  },
};

export const NewerBadgePollWins: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)]),
      ...scripted({ page: () => page(windowOf([])), count: () => pending.promise }),
      release: () => pending.release(count('1', 0)) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await readLink(canvas);
    await waitFor(() => expect(args.calls).toContain('count'));
    const poll = spyOn(window, 'fetch').mockResolvedValueOnce(Response.json({
      profile: 'notification-unread-count-v1', generation: '1', count: 1, overflow: false }));
    try {
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('1'));
      await args.release!();
      await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('1');
    } finally { poll.mockRestore(); }
  },
};

export const LatePageAfterNewerPoll: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)], '1', '100', 'older'),
      ...scripted({ page: () => pending.promise }),
      release: () => pending.release(page(windowOf([notice(50)]))) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    const poll = spyOn(window, 'fetch').mockResolvedValueOnce(Response.json({
      profile: 'notification-unread-count-v1', generation: '1', count: 1, overflow: false }));
    try {
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('1'));
      await args.release!();
      await expect(canvas.getAllByRole('listitem')).toHaveLength(1);
      await expect(canvas.getByRole('button', { name: 'Show more' })).toBeEnabled();
    } finally { poll.mockRestore(); }
  },
};

export const LateMarkAfterNewerPoll: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)]),
      ...scripted({ page: () => page(windowOf([])), mark: () => pending.promise }),
      release: () => pending.release(watermark('1', '100')) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    const poll = spyOn(window, 'fetch').mockResolvedValueOnce(Response.json({
      profile: 'notification-unread-count-v1', generation: '1', count: 1, overflow: false }));
    try {
      window.dispatchEvent(new Event('focus'));
      await waitFor(() => expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('1'));
      await args.release!();
      await expect(canvas.getByText('Unread')).toBeVisible();
      await expect(args.calls).not.toContain('count');
    } finally { poll.mockRestore(); }
  },
};

export const LateReadAfterReset: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)], '1', '100', 'reset'),
      ...scripted({ page: resetPage, read: () => pending.promise }), release: () => pending.release(answer({ readAt: NOW })) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await readLink(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await resetVisible(canvas);
    await args.release!();
    await expect(args.calls.filter(call => call === 'count')).toHaveLength(1);
    await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('5');
  },
};

export const LateTriageAfterReset: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)], '1', '100', 'reset'),
      ...scripted({ page: resetPage, triage: () => pending.promise }),
      release: () => pending.release(answer({ saved: true, done: false, revision: '1' })) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await resetVisible(canvas);
    await args.release!();
    await expect(canvas.queryByText('Saved.')).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
  },
};

export const LateInvitationAfterReset: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([invitationNotice], '1', '113', 'reset'),
      actingSubject: 'https://rezics.com/id/00000801-5555-4a6f-8c2d-3e7b5c1a9f40',
      ...scripted({ page: resetPage, invitation: () => pending.promise }), release: () => pending.release(answer({})) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Join' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Join' })).toBeNull());
    await args.release!();
    await expect(args.calls.some(call => call.startsWith('read:'))).toBe(false);
    await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('5');
  },
};

export const OlderGenerationPage: Story = {
  args: (() => {
    const pending = deferred();
    return { ...base, initial: windowOf([notice(100)], '1', '100', 'reset'),
      ...scripted({ page: query => query.before === 'reset'
        ? page(windowOf([notice(2)], '2', '2', 'older-new-generation'), true) : pending.promise }),
      release: () => pending.release(page(windowOf([notice(100)]), true)) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.getByRole('link', { name: 'A correction was revised' }))
      .toHaveAttribute('href', `/en/proposals/${streamId(1002)}?revision=2`));
    const replacement = canvas.getByRole('link', { name: 'A correction was revised' }).getAttribute('href');
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await args.release!();
    await expect(canvas.getByRole('link', { name: 'A correction was revised' })).toHaveAttribute('href', replacement);
    await expect(canvas.getByLabelText('Unread badge')).toHaveTextContent('5');
  },
};

export const InvalidCursorRestartsFiltered: Story = {
  args: (() => ({ ...base,
    initial: windowOf([{ ...notice(100), saved: true }], '1', '100', 'expired'),
    selection: { view: 'saved', reason: 'manual' } as const,
    ...scripted({ page: query => query.before === 'expired'
      ? { data: null, error: { status: 400, value: null } }
      : query.before === 'latest' ? page(windowOf([{ ...notice(200), saved: true }], '1', '200', 'fresh'))
        : page(windowOf([{ ...notice(1), saved: true }], '1', '200')) }) }))(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(args.calls).toEqual(['page:expired:saved:manual', 'page:latest:saved:manual']));
    await expect(canvas.getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.getAllByRole('listitem')).toHaveLength(2));
    await expect(args.calls).toEqual(['page:expired:saved:manual', 'page:latest:saved:manual', 'page:fresh:saved:manual']);
    await expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Saved' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Watching' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(canvas.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(args.calls).toContain('mark:1:200'));
  },
};

/** Recovery failing once retries the newest page, never the rejected token. */
export const FailedRestartRetriesNewest: Story = {
  args: (() => {
    let attempts = 0;
    return { ...base, initial: windowOf([{ ...notice(100), saved: true }], '1', '100', 'expired'),
      selection: { view: 'saved', reason: 'manual' } as const,
      ...scripted({ page: query => query.before === 'expired'
        ? { data: null, error: { status: 400, value: null } }
        : ++attempts === 1 ? { data: null, error: { status: 503, value: null } }
          : page(windowOf([{ ...notice(200), saved: true }])) }) };
  })(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Couldn’t load more notifications.');
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull());
    await expect(args.calls).toEqual(['page:expired:saved:manual', 'page:latest:saved:manual', 'page:latest:saved:manual', 'count']);
    await expect(canvas.getByRole('link', { name: 'A correction was revised' }))
      .toHaveAttribute('href', `/en/proposals/${streamId(1200)}?revision=2`);
  },
};
