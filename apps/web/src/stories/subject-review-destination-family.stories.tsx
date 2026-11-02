import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery, useQueryClient, notifyManager } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import memberships from '../kernel/recorded/my-realms.json';
import boards from '../kernel/recorded/realm-boards.json';
import subject from '../kernel/recorded/subject.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { WriteReviewAction, REALM_PAGE_LIMIT } from '../subject/write-review';
import { reviewThreadHref } from '../threads/review-policy';
import { PatternStory } from './page';

const longTitle = `مراجعات الرحلة الطويلة ${'عنوان'.repeat(60)}`;
const longRealm = `مكتبة القراء والمترجمين ${'RealmNameWithoutSpaces'.repeat(25)}`;
const review = boards.items.find((board) => board.purpose === 'reviews')!;
type Mode = 'many' | 'no-realms' | 'zero' | 'denied' | 'failed-page' | 'failed-boards' | 'loading-page' | 'loading-boards' | 'one' | 'growth8' | 'growth20';
let observed: { path: string; query: string }[] = [];
let release: () => void = () => {};

/** Story-local wire illustrations through the existing framework; no production reader or transport seam. */
function fixture(mode: Mode) {
  return () => {
    observed = [];
    let held = mode === 'loading-page' || mode === 'loading-boards';
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    release = () => { held = false; resolve(); };
    const suppliedRealms = mode === 'no-realms' ? [] : mode === 'growth8' || mode === 'growth20'
      ? Array.from({ length: mode === 'growth8' ? 8 : REALM_PAGE_LIMIT }, (_, n) => ({
          ...memberships.items[0]!, realmId: `0192f3a0-6c1e-7b2a-9d4e-${String(n + 1).padStart(12, '0')}`, name: `${longRealm} ${n + 1}`,
        }))
      : [{ ...memberships.items[0]!, name: longRealm }];
    const previous = globalThis.fetch;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin !== 'http://kernel.local') return previous(input, init);
      if (url.pathname === '/v1/me/realms') {
        observed.push({ path: url.pathname, query: url.search });
        if (mode === 'loading-page' && held) await pending;
        return mode === 'failed-page' ? new Response(null, { status: 503 })
          : Response.json({ items: suppliedRealms, next: 'supplied-unfollowed-page' });
      }
      const match = /^\/v1\/realms\/([^/]+)\/boards$/.exec(url.pathname);
      if (!match) return previous(input, init);
      observed.push({ path: url.pathname, query: url.search });
      const wasHeld = mode === 'loading-boards' && held;
      if (wasHeld) await pending;
      if (mode === 'failed-boards' || mode === 'denied') return new Response(null, { status: mode === 'denied' ? 403 : 503 });
      const realmId = decodeURIComponent(match[1]!);
      const items = mode === 'zero' ? boards.items.filter((board) => board.purpose !== 'reviews')
        : mode === 'one' || wasHeld ? [review]
        : mode === 'growth8' || mode === 'growth20' ? [{ ...review, id: realmId, realmId }]
        : [{ ...review, title: longTitle }, { ...review, id: boards.items[0]!.id, title: null }];
      return Response.json({ items, next: null });
    }) as typeof fetch;
    globalThis.fetch = fetcher;
    return () => { release(); if (globalThis.fetch === fetcher) globalThis.fetch = previous; };
  };
}

function Visits({ session = 'signed-in' }: { session?: 'signed-in' | 'signed-out' | 'unavailable' }) {
  const client = useQueryClient();
  const current = useQuery(sessionQuery);
  if (session === 'signed-in' && !current.data?.subject) return <p>{m.thread_review_boards_loading()}</p>;
  return (
    <main className="mx-auto min-w-0 max-w-5xl space-y-6 p-4">
      {session === 'signed-in' ? (
        <div className="flex flex-wrap gap-3">
          <button type="button" className="min-h-11 rounded-sm border px-3 focus-visible:outline-2"
            onClick={() => client.setQueryData(sessionQuery.queryKey, (prepared) =>
              prepared ? { ...prepared, subject: 'different-illustrative-reader' } : prepared,
            )}>
            Replace illustrative reader
          </button>
          <button type="button" className="min-h-11 rounded-sm border px-3 focus-visible:outline-2"
            onClick={() => {
              const prepared = client.getQueryData(sessionQuery.queryKey);
              if (!prepared) return;
              notifyManager.batch(() => {
                client.setQueryData(sessionQuery.queryKey, { ...prepared, subject: 'different-illustrative-reader' });
                client.setQueryData(sessionQuery.queryKey, prepared);
              });
            }}>
            Replace illustrative reader and return
          </button>
        </div>
      ) : null}
      {[0, 1].map((index) => (
        <section key={index} data-visit={index} dir={index === 0 ? 'rtl' : 'ltr'} className="min-w-0 space-y-3">
          <h2 className="font-semibold">{index === 0 ? subject.subject.labels.en : longTitle}</h2>
          <WriteReviewAction subjectId={subject.subject.id} subjectTitle={index === 0 ? subject.subject.labels.en : longTitle} locale={getLocale()} session={session} />
        </section>
      ))}
    </main>
  );
}
function Examples({ session = 'signed-in' }: { session?: 'signed-in' | 'signed-out' | 'unavailable' }) {
  return <PatternStory visitor={session === 'signed-in' ? 'Signed In' : 'Signed Out'}><Visits session={session} /></PatternStory>;
}
const meta = {
  title: 'Patterns/Subjects/Review destinations family',
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component:
      'UNRUN: actual WriteReviewAction, canonical Subject/Realm/board fixtures and existing Storybook session/request harness. Constructed long RTL and untitled choices preserve full identity and independent visits. Review at phone390 and desktop1280 with locale/theme globals. One choice retains actual document navigation after deliberate expansion. 1/8/20 supplied Realms use the real smaller membership bound; board pages retain limit=100. O(supplied bounded rows/text), constant presentation overhead, zero added IO and no hidden membership-page traversal. Native/backend/physical growth, keyboard geometry, browser and original acceptance are deferred.',
    } },
  },
  beforeEach: fixture('many'),
  render: () => <Examples />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const pages = () => observed.filter(({ path }) => path === '/v1/me/realms');
const boardReads = () => observed.filter(({ path }) => path.endsWith('/boards'));
async function visits(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await view.findAllByRole('button', { name: m.thread_review_write() });
  await waitFor(() => expect(pages().length).toBeGreaterThanOrEqual(2));
  return [...canvasElement.querySelectorAll<HTMLElement>('section[data-visit]')];
}
async function open(canvasElement: HTMLElement) {
  const entries = await visits(canvasElement);
  await userEvent.click(within(entries[0]!).getByRole('button', { name: m.thread_review_write() }));
  return entries;
}

export const IndependentDestinations: Story = {
  play: async ({ canvasElement }) => {
    const entries = await visits(canvasElement);
    await expect(boardReads()).toHaveLength(0);
    const first = within(entries[0]!); const second = within(entries[1]!);
    const toggle = first.getByRole('button', { name: m.thread_review_write() });
    toggle.focus(); await userEvent.keyboard('{Enter}');
    const list = await first.findByRole('list', { name: m.thread_review_choose_board() });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(second.queryByRole('list')).toBeNull();
    const links = within(list).getAllByRole('link');
    await expect(links).toHaveLength(2);
    await expect(links[0]).toHaveTextContent(longTitle + longRealm);
    await expect(links[1]).toHaveTextContent(m.threads_untitled() + longRealm);
    await expect(links[0]).toHaveAttribute('href', reviewThreadHref(getLocale(), review.id, subject.subject.id, subject.subject.labels.en));
    toggle.focus(); await userEvent.tab(); await expect(links[0]).toHaveFocus();
    await userEvent.tab(); await expect(links[1]).toHaveFocus();
    for (const link of links) {
      await expect(link.querySelector('a, button')).toBeNull();
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
      link.focus(); await expect(getComputedStyle(link).outlineStyle).not.toBe('none');
    }
    await userEvent.click(toggle); await expect(first.queryByRole('list')).toBeNull();
    await userEvent.click(toggle); await first.findByRole('list');
    await userEvent.click(second.getByRole('button', { name: m.thread_review_write() }));
    const secondList = await second.findByRole('list');
    await expect(within(secondList).getAllByRole('link')[0]).toHaveAttribute('href', reviewThreadHref(getLocale(), review.id, subject.subject.id, longTitle));
    await expect(pages()).toHaveLength(2); await expect(boardReads()).toHaveLength(2);
    await expect(boardReads().every(({ query }) => query === '?limit=100')).toBe(true);
    const main = within(canvasElement).getByRole('main');
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  },
};
export const SignedOut: Story = {
  render: () => <Examples session="signed-out" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findAllByRole('link', { name: m.thread_review_sign_in() })).toHaveLength(2);
    await expect(view.queryByRole('button', { name: m.thread_review_write() })).toBeNull();
    await expect(observed).toHaveLength(0);
  },
};
export const UnavailableSession: Story = {
  render: () => <Examples session="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryAllByRole('link')).toHaveLength(0);
    await expect(view.queryAllByRole('button')).toHaveLength(0);
    await expect(observed).toHaveLength(0);
  },
};
export const InitialLoad: Story = {
  beforeEach: fixture('loading-page'),
  play: async ({ canvasElement }) => {
    const entries = await open(canvasElement);
    await expect(within(entries[0]!).getByText(m.thread_review_boards_loading())).toBeVisible();
    await expect(boardReads()).toHaveLength(0);
    release(); await within(entries[0]!).findByRole('list');
  },
};
export const NoRealms: Story = {
  beforeEach: fixture('no-realms'),
  play: async ({ canvasElement }) => { const entries = await open(canvasElement); await within(entries[0]!).findByText(m.thread_review_no_realms()); await expect(boardReads()).toHaveLength(0); },
};
export const NoEligibleBoards: Story = {
  beforeEach: fixture('zero'),
  play: ({ canvasElement }) => noEligibleBoards(canvasElement),
};
async function noEligibleBoards(canvasElement: HTMLElement) {
  const entries = await open(canvasElement);
  await within(entries[0]!).findByText(m.thread_review_no_board());
}
export const DeniedBoards: Story = {
  beforeEach: fixture('denied'),
  play: ({ canvasElement }) => noEligibleBoards(canvasElement),
};
async function failed(canvasElement: HTMLElement) {
  const entries = await open(canvasElement); const view = within(entries[0]!);
  await expect(await view.findByRole('alert')).toHaveTextContent(m.thread_review_unavailable());
  await expect(view.getAllByRole('button')).toHaveLength(1);
  await expect(view.queryByRole('list')).toBeNull();
}
export const FailedMembership: Story = { beforeEach: fixture('failed-page'), play: ({ canvasElement }) => failed(canvasElement) };
export const FailedBoards: Story = { beforeEach: fixture('failed-boards'), play: ({ canvasElement }) => failed(canvasElement) };
export const MismatchedReader: Story = {
  play: async ({ canvasElement }) => {
    await visits(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Replace illustrative reader' }));
    await failed(canvasElement);
    await expect(boardReads()).toHaveLength(0);
  },
};
export const SingleDestination: Story = {
  beforeEach: fixture('one'),
  // Deliberate activation follows the existing claimed document navigation. Mounted coverage observes assign.
  play: async ({ canvasElement }) => {
    const entries = await visits(canvasElement);
    for (const entry of entries) await expect(within(entry).getByRole('button', { name: m.thread_review_write() })).toHaveAttribute('aria-expanded', 'false');
    await expect(boardReads()).toHaveLength(0);
  },
};
export const InFlightSameReaderAba: Story = {
  beforeEach: fixture('loading-boards'),
  play: async ({ canvasElement }) => {
    const entries = await open(canvasElement);
    await waitFor(() => expect(boardReads()).toHaveLength(1));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Replace illustrative reader and return' }));
    await waitFor(() => expect(pages()).toHaveLength(4));
    release();
    await expect(within(entries[0]!).queryByRole('list')).toBeNull();
    await expect(within(entries[0]!).getByRole('button', { name: m.thread_review_write() })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(entries[0]!).getByRole('button', { name: m.thread_review_write() }));
    await within(entries[0]!).findByRole('list');
  },
};
async function suppliedGrowth(canvasElement: HTMLElement, count: number) {
  const entries = await open(canvasElement); const list = await within(entries[0]!).findByRole('list');
  await expect(within(list).getAllByRole('listitem')).toHaveLength(count);
  await expect(pages()).toHaveLength(2); await expect(boardReads()).toHaveLength(count);
  await expect(boardReads().every(({ query }) => query === '?limit=100')).toBe(true);
}
export const EightSuppliedRealms: Story = { beforeEach: fixture('growth8'), play: ({ canvasElement }) => suppliedGrowth(canvasElement, 8) };
export const TwentySuppliedRealms: Story = { beforeEach: fixture('growth20'), play: ({ canvasElement }) => suppliedGrowth(canvasElement, REALM_PAGE_LIMIT) };
