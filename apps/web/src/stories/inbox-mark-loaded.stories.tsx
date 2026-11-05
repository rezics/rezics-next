import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { readyInboxPage, type InboxPage, type InboxPageQuery, type ResolvedInboxPage } from '../inbox/inbox-read';
import { currentInboxViewer } from '../inbox/inbox-viewer';
import { inboxViewerQueryKey } from '../inbox/inbox-query';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Account/Inbox',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual Inbox, session and query composition with story-local controlled page IO and held native marker responses. Illustrative reconciliation regression; native and browser verification remain unexecuted.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const newest = '01a17a3b-0884-721b-91ef-d7ffd7bb5801';
const older = '01a17a3b-0884-721b-91ef-d7ffd7bb5802';
const oldest = '01a17a3b-0884-721b-91ef-d7ffd7bb5803';
const arrival = '01a17a3b-0884-721b-91ef-d7ffd7bb5804';
const continuation = 'opaque.loaded/second+page==';
const unloaded = 'opaque.unloaded/third+page==';
const href = '/threads/01a17a3b-0884-721b-91ef-d7ffd7bb58f1#post-01a17a3b-0884-721b-91ef-d7ffd7bb58f2';

function notice(id: string, unread = true): ResolvedInboxPage['items'][number] {
  return {
    id,
    unread,
    kind: 'reply',
    createdAt: '2026-10-29T09:45:00.000Z',
    actorId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f0',
    actorName: 'Momo',
    threadId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f1',
    postId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f2',
    decisionId: null,
    reportId: null,
    href,
    text: `Loaded reply ${id}`,
    unavailable: false,
  };
}

function createJourney() {
  return {
    reads: [] as (string | undefined)[],
    writes: [] as { pathname: string; body: unknown; key: string | null }[],
    incidentalWrites: [] as string[],
    epoch: 0,
    confirmed: false,
    newerArrival: false,
    denied: false,
    // Exercise precedence even when a current native read disagrees with the marker.
    authoritativeUnread: false,
    release: (_status: 204 | 503) => {},
    settled: Promise.resolve(),
    refresh: async () => {},
    retire: () => {},
    resume: () => {},
    loadPage: async function (query: InboxPageQuery): Promise<InboxPage> {
      this.reads.push(query.cursor);
      if (this.denied) return { signedIn: true, state: 'unavailable', failure: { status: 403, code: 'forbidden' } };
      if (query.cursor !== undefined && query.cursor !== continuation)
        throw new Error('Inbox paged without a deliberate action');
      const items =
        query.cursor === undefined
          ? [
              ...(this.newerArrival ? [notice(arrival)] : []),
              notice(newest, !this.confirmed || this.authoritativeUnread),
            ]
          : [notice(older, !this.confirmed), notice(oldest, !this.confirmed)];
      return readyInboxPage(items, query.cursor === undefined ? continuation : unloaded, 'alice', query.selection);
    },
  };
}

let activeJourney: ReturnType<typeof createJourney> | undefined;

function ControlledInbox() {
  const client = useQueryClient();
  const [journey] = useState(createJourney);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previousFetch = globalThis.fetch;
    let releaseHeld = (_status: 204 | 503) => {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'http://kernel.local' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method))
        return previousFetch(input, init);
      if (!/^\/v1\/accounts\/[^/]+\/notifications:markSeen$/.test(url.pathname)) {
        journey.incidentalWrites.push(url.pathname);
        return previousFetch(input, init);
      }
      journey.writes.push({
        pathname: url.pathname,
        body: await request.json(),
        key: request.headers.get('idempotency-key'),
      });
      const epoch = journey.epoch;
      const response = new Promise<Response>((resolve) => {
        releaseHeld = (status) => {
          if (status === 204 && journey.epoch === epoch) journey.confirmed = true;
          resolve(
            status === 204
              ? new Response(null, { status })
              : Response.json({ code: 'deadline_exceeded', retryable: true }, { status }),
          );
        };
        journey.release = releaseHeld;
      });
      journey.settled = response.then(() => {});
      return response;
    }) as typeof fetch;
    globalThis.fetch = fetcher;
    journey.refresh = async () => {
      const viewer = currentInboxViewer(client);
      if (!viewer) throw new Error('No current Inbox viewer');
      await client.refetchQueries({ queryKey: inboxViewerQueryKey(viewer), type: 'active' });
    };
    const sessionKey: readonly unknown[] = sessionQuery.queryKey;
    journey.retire = () => client.setQueryData(sessionKey, { state: 'unknown', subject: null, csrfToken: null });
    journey.resume = () => {
      journey.epoch++;
      journey.confirmed = false;
      journey.newerArrival = false;
      journey.authoritativeUnread = false;
      client.setQueryData(sessionQuery.queryKey, {
        state: 'signed-in',
        subject: 'story-viewer',
        csrfToken: 'story-csrf-token',
      });
    };
    activeJourney = journey;
    setReady(true);
    return () => {
      if (globalThis.fetch === fetcher) globalThis.fetch = previousFetch;
      releaseHeld(503);
      if (activeJourney === journey) activeJourney = undefined;
    };
  }, [client, journey]);
  const [loadPage] = useState(() => journey.loadPage.bind(journey));
  return ready ? (
    <AppShell>
      <InboxPageView loadPage={loadPage} />
    </AppShell>
  ) : null;
}

function rowState(list: HTMLElement) {
  return [...list.querySelectorAll<HTMLElement>('[data-notice-id]')].map((row) => [
    row.dataset.noticeId,
    row.dataset.unread,
  ]);
}

export const ConfirmedLoadedReconciliation: Story = {
  name: 'Confirmed marker reconciles retained loaded notices',
  render: () => (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <ControlledInbox />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const main = within(await within(canvasElement).findByRole('main'));
    const list = () => main.findByRole('list', { name: m.inbox_heading() });
    await list();
    const journey = activeJourney;
    if (!journey) throw new Error('Controlled Inbox IO was not installed');
    const unread = [
      [newest, 'true'],
      [older, 'true'],
      [oldest, 'true'],
    ];
    await expect(journey.reads).toEqual([undefined]);
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_filter_unread() }));
    await userEvent.click(main.getByRole('button', { name: m.inbox_load_more() }));
    await waitFor(async () => expect(rowState(await list())).toEqual(unread));
    await expect(journey.reads).toEqual([undefined, continuation]);
    await expect(journey.writes).toHaveLength(0);
    await expect(journey.incidentalWrites).toHaveLength(0);

    const mark = main.getByRole('button', { name: m.inbox_triage_mark() });
    mark.click();
    mark.click();
    await waitFor(() => expect(journey.writes).toHaveLength(1));
    const original = journey.writes[0]!;
    await expect(original.pathname).toBe('/v1/accounts/story-viewer/notifications:markSeen');
    await expect(original.body).toEqual({ through: newest });
    await expect(JSON.parse(original.key!)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(rowState(await list())).toEqual(unread);
    await expect(main.queryByText(m.inbox_triage_marked())).toBeNull();
    journey.release(503);
    const failure = (await main.findByText(m.inbox_seen_unavailable())).closest('section')!;
    await expect(failure).toHaveAttribute('data-response-status', '503');
    await expect(rowState(await list())).toEqual(unread);
    // Access checks and current-page refreshes remain read-only during an uncertain outcome.
    await userEvent.click(within(failure).getByRole('button', { name: m.inbox_check_access() }));
    await main.findByText(m.inbox_seen_access_checked());
    await expect(journey.reads).toEqual([undefined, continuation, continuation]);
    await expect(journey.writes).toEqual([original]);
    await expect(rowState(await list())).toEqual(unread);
    const retry = within(failure).getByRole('button', { name: m.inbox_retry() });
    retry.click();
    retry.click();
    await waitFor(() => expect(journey.writes).toEqual([original, original]));
    await expect(rowState(await list())).toEqual(unread);
    journey.release(204);
    await main.findByText(m.inbox_triage_marked());
    await main.findByText(m.inbox_triage_no_unread_loaded());
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(journey.reads).toEqual([undefined, continuation, continuation, continuation]);
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_filter_all() }));
    await expect(rowState(await list())).toEqual([
      [newest, 'false'],
      [older, 'false'],
      [oldest, 'false'],
    ]);
    await expect(
      within(await list())
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([href, href, href]);
    await expect(main.getByRole('button', { name: m.inbox_load_more() })).toBeEnabled();
    await expect(journey.writes).toEqual([original, original]);

    // A new viewer epoch gets fresh data even when subject and CSRF token are reused.
    journey.retire();
    await main.findByText(m.inbox_loading());
    journey.resume();
    await waitFor(async () => expect(rowState(await list())).toEqual([[newest, 'true']]));
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_mark() }));
    await waitFor(() => expect(journey.writes).toHaveLength(3));
    journey.newerArrival = true;
    await journey.refresh();
    await waitFor(async () =>
      expect(rowState(await list())).toEqual([
        [arrival, 'true'],
        [newest, 'true'],
      ]),
    );
    await expect(journey.writes[2]!.body).toEqual({ through: newest });
    journey.authoritativeUnread = true;
    journey.release(204);
    await main.findByText(m.inbox_triage_marked());
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_filter_unread() }));
    // Neither a newer arrival nor a conflicting fresh authoritative row is cleared locally.
    await expect(rowState(await list())).toEqual([
      [arrival, 'true'],
      [newest, 'true'],
    ]);

    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_mark() }));
    await waitFor(() => expect(journey.writes).toHaveLength(4));
    journey.retire();
    await main.findByText(m.inbox_loading());
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    journey.resume();
    await waitFor(async () => expect(rowState(await list())).toEqual([[newest, 'true']]));
    const readsBeforeRetiredCompletion = [...journey.reads];
    journey.release(204);
    await journey.settled;
    // Drain the old async completion before asserting that it cannot invalidate or acknowledge this epoch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(rowState(await list())).toEqual([[newest, 'true']]);
    await expect(journey.reads).toEqual(readsBeforeRetiredCompletion);
    await expect(main.queryByText(m.inbox_triage_marked())).toBeNull();

    await userEvent.click(main.getByRole('button', { name: m.inbox_load_more() }));
    await waitFor(async () => expect(rowState(await list())).toEqual(unread));
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_mark() }));
    await waitFor(() => expect(journey.writes).toHaveLength(5));
    journey.denied = true;
    await journey.refresh();
    await main.findByText(m.inbox_read_denied());
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    journey.release(204);
    await journey.settled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_triage_marked())).toBeNull();
    journey.denied = false;
    journey.confirmed = false;
    await journey.refresh();
    await waitFor(async () =>
      expect(rowState(await list())).toEqual([
        [older, 'true'],
        [oldest, 'true'],
      ]),
    );
    await expect(journey.writes).toHaveLength(5);
    await expect(journey.incidentalWrites).toHaveLength(0);
    await expect(journey.reads).not.toContain(unloaded);
  },
};
