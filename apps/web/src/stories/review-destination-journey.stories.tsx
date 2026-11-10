import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import memberships from '../kernel/recorded/my-realms.json';
import boards from '../kernel/recorded/realm-boards.json';
import subject from '../kernel/recorded/subject.json';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { WriteReviewAction } from '../subject/write-review';
import { PatternStory } from './page';

const longBoard = `مراجعات الرحلة ${'عنوان'.repeat(55)}`;
const longRealm = `مكتبة القراء ${'RealmNameWithoutSpaces'.repeat(18)}`;
const realm = { ...memberships.items[0]!, name: longRealm };
const review = boards.items.find((board) => board.purpose === 'reviews')!;
const returnTo = `/en/subjects/${subject.subject.id}/work/reviews`;
const context = {
  subject: {
    id: subject.subject.id,
    label: { value: subject.subject.labels.en, language: 'en' },
    source: { partition: 2, epoch: 1, position: '18' },
  },
  realm: {
    id: realm.realmId,
    title: longRealm,
    spaceId: '0192f3a0-6c1e-7b2a-9d4e-000000000098',
    headRevisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000097',
  },
};
const item = {
  id: review.id,
  title: longBoard,
  purpose: 'reviews',
  actions: { createReview: 'allowed' },
  native: {
    kind: 'review',
    boardId: review.id,
    subjectIds: [subject.subject.id],
    subjectSource: context.subject.source,
    realmHeadRevisionId: context.realm.headRevisionId,
    boardSecurityRevision: '1',
  },
};

type Mode = 'choices' | 'empty' | 'denied' | 'failed' | 'loading';
let observed: { path: string; query: string }[] = [];
let release: () => void = () => {};

function fixture(mode: Mode) {
  return () => {
    observed = [];
    let held = mode === 'loading';
    let resolve!: () => void;
    const pending = new Promise<void>((done) => (resolve = done));
    release = () => {
      held = false;
      resolve();
    };
    const previous = globalThis.fetch;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin !== 'http://kernel.local') return previous(input, init);
      observed.push({ path: url.pathname, query: url.search });
      if (url.pathname === '/v1/me/realms')
        return mode === 'empty'
          ? Response.json({ items: [], next: null })
          : Response.json({ items: [realm], next: null });
      const destination = /^\/v1\/realms\/([^/]+)\/review-destinations$/.exec(url.pathname);
      if (!destination) return previous(input, init);
      if (held) await pending;
      if (mode === 'failed') return new Response(null, { status: 503 });
      if (mode === 'denied')
        return Response.json({ state: 'denied', viewer: { state: 'denied' }, context: null, items: [], next: null });
      if (mode === 'empty')
        return Response.json({
          state: 'no-destinations',
          viewer: { state: 'current' },
          context,
          items: [],
          next: null,
        });
      return Response.json({ state: 'choices', viewer: { state: 'current' }, context, items: [item], next: null });
    }) as typeof fetch;
    globalThis.fetch = fetcher;
    return () => {
      release();
      if (globalThis.fetch === fetcher) globalThis.fetch = previous;
    };
  };
}

function Visits({ session = 'signed-in' }: { session?: 'signed-in' | 'signed-out' | 'unavailable' }) {
  const current = useQuery(sessionQuery);
  if (session === 'signed-in' && !current.data?.subject) return <p>{m.thread_review_unavailable()}</p>;
  return (
    <main className="mx-auto min-w-0 max-w-5xl space-y-6 p-4">
      {[0, 1].map((index) => (
        <section key={index} data-visit={index} dir={index === 0 ? 'rtl' : 'ltr'} className="min-w-0 space-y-3">
          <h2 className="font-semibold">{index === 0 ? subject.subject.labels.en : longBoard}</h2>
          <WriteReviewAction
            subjectId={subject.subject.id}
            subjectTitle={index === 0 ? subject.subject.labels.en : longBoard}
            locale={getLocale()}
            session={session}
            returnTo={returnTo}
          />
        </section>
      ))}
    </main>
  );
}

function Examples({ session = 'signed-in' }: { session?: 'signed-in' | 'signed-out' | 'unavailable' }) {
  return (
    <PatternStory visitor={session === 'signed-in' ? 'Signed In' : 'Signed Out'}>
      <Visits session={session} />
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Review destination journey',
  id: 'patterns-subjects-review-destination-journey',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One explicit My Realms page, one selected Realm destination page and one exact Board inspection feed the existing review composer. The stories use the established request harness with bounded mock responses. Check the long RTL labels, keyboard controls and touch-sized buttons at phone390 and desktop1280.',
      },
    },
  },
  beforeEach: fixture('choices'),
  render: () => <Examples />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const destinationCalls = () => observed.filter(({ path }) => path.endsWith('/review-destinations'));
async function open(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  const entries = [...canvasElement.querySelectorAll<HTMLElement>('section[data-visit]')];
  const write = view.getAllByRole('button', { name: m.thread_review_write() });
  write[0]!.focus();
  await userEvent.keyboard('{Enter}');
  await view.findByRole('heading', { name: m.thread_review_choose_realm() });
  await waitFor(() => expect(observed.filter(({ path }) => path === '/v1/me/realms')).toHaveLength(1));
  return { entries, view: within(entries[0]!) };
}

export const SelectCurrentDestination: Story = {
  parameters: { viewport: { defaultViewport: 'phone390' } },
  play: async ({ canvasElement }) => {
    const { entries, view } = await open(canvasElement);
    await expect(destinationCalls()).toHaveLength(0);
    const realmChoice = view.getByRole('button', { name: longRealm });
    realmChoice.focus();
    await userEvent.keyboard('{Enter}');
    const boardChoices = await view.findByRole('list', { name: m.thread_review_choose_board() });
    await expect(within(boardChoices).getByText(longBoard)).toBeVisible();
    await expect(within(entries[1]!).queryByRole('list')).toBeNull();
    await expect(destinationCalls()).toHaveLength(1);
    const boardButton = view.getByRole('button', { name: m.thread_review_select_board() });
    boardButton.focus();
    await expect(boardButton).toHaveFocus();
    await expect(boardButton.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(boardButton.scrollWidth).toBeLessThanOrEqual(boardButton.clientWidth);
    await expect(destinationCalls()[0]?.query).toContain('subjectId=');
    await expect(canvasElement.querySelector('a[href*="/threads/"]')).toBeNull();
  },
};

export const NoEligibleDestination: Story = {
  beforeEach: fixture('empty'),
  play: async ({ canvasElement }) => {
    const { view } = await open(canvasElement);
    await userEvent.click(view.getByRole('button', { name: longRealm }));
    await view.findByText(m.thread_review_no_board());
    await expect(destinationCalls()).toHaveLength(1);
  },
};

export const DeniedDestination: Story = {
  beforeEach: fixture('denied'),
  play: async ({ canvasElement }) => {
    const { view } = await open(canvasElement);
    await userEvent.click(view.getByRole('button', { name: longRealm }));
    await view.findByRole('alert');
    await expect(view.queryByRole('list', { name: m.thread_review_choose_board() })).toBeNull();
  },
};

export const FailedDestinationRetry: Story = {
  beforeEach: fixture('failed'),
  play: async ({ canvasElement }) => {
    const { view } = await open(canvasElement);
    await userEvent.click(view.getByRole('button', { name: longRealm }));
    await view.findByRole('alert');
    await expect(view.getByRole('button', { name: m.subject_view_retry() })).toBeVisible();
  },
};

export const Preparing: Story = {
  beforeEach: fixture('loading'),
  play: async ({ canvasElement }) => {
    const { view } = await open(canvasElement);
    await userEvent.click(view.getByRole('button', { name: longRealm }));
    await view.findByRole('status');
    release();
    await view.findByRole('list', { name: m.thread_review_choose_board() });
  },
};

export const DesktopLongLabels: Story = {
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const { view } = await open(canvasElement);
    await userEvent.click(view.getByRole('button', { name: longRealm }));
    const choices = await view.findByRole('list', { name: m.thread_review_choose_board() });
    const boardButton = within(choices).getByRole('button', { name: m.thread_review_select_board() });
    await expect(boardButton).toBeVisible();
    await expect(boardButton.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  },
};
