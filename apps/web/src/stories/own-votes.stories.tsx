import { createContext, useContext, useMemo, useRef, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { OwnVoteEntry, OwnVotesPage } from '../ratings/own-votes/types';
import type { OwnVotesReturnOutcome } from '../ratings/own-votes/return';
import { locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { OwnVotesWorkspace } from '../ratings/own-votes/page';
import type { OwnVoteIntent } from '../ratings/own-votes/intent';
import type { OwnVoteReadback } from '../ratings/own-votes/readback';

type Mode =
  | 'ready'
  | 'empty'
  | 'sparse'
  | 'retired'
  | 'merged'
  | 'uncertain'
  | 'denied'
  | 'long'
  | 'read-only'
  | 'advice-replaced'
  | 'dependency'
  | 'return-refreshing'
  | 'return-failed'
  | 'return-found'
  | 'return-missing';
type Fixture = { mode: Mode; locale: (typeof locales)[number] };
const FixtureContext = createContext<Fixture>({ mode: 'ready', locale: 'en' });
const Root = createRootRoute({ component: Outlet });
const Ratings = createRoute({ getParentRoute: () => Root, path: '/library/ratings', component: StoryScreen });
const Subject = createRoute({
  getParentRoute: () => Root,
  path: '/subjects/$id/$slug',
  component: () => <p>Subject reader</p>,
});
const tree = Root.addChildren([Ratings, Subject]);

const subjectId = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const targetA = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const targetB = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
const questionA = 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
const questionB = 'e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5';

function entry(
  targetId: string,
  questionId: string,
  actions: OwnVoteEntry['actions'] = {
    state: 'editable',
    put: `/v1/subjects/${targetId}/ratings/${questionId}/vote`,
    clear: `/v1/subjects/${targetId}/ratings/${questionId}/vote`,
    readback: `/v1/subjects/${targetId}/ratings/${questionId}/vote`,
  },
): OwnVoteEntry {
  return {
    targetId,
    questionId,
    subject: {
      id: subjectId,
      type: 'work',
      types: ['work'],
      label: { value: 'Kokoro', language: 'en' },
      creativeWork: true,
      cover: null,
    },
    subjectHref: `/v1/subjects/${targetId}`,
    question: {
      id: questionId,
      revision: 1,
      label: 'How much does this work stay with you?',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 2 },
    },
    own: { units: 0, revision: 4, at: '2026-10-01T10:00:00.000Z' },
    actions,
  };
}

function fixture(mode: Mode): OwnVotesPage {
  const editableA = entry(targetA, questionA);
  if (mode === 'empty') return { viewer: { accountId: subjectId }, votes: [], next: null };
  if (mode === 'sparse') return { viewer: { accountId: subjectId }, votes: [], next: 'sealed-continuation' };
  if (mode === 'retired')
    return {
      viewer: { accountId: subjectId },
      votes: [
        entry(targetA, questionA, {
          state: 'retired',
          reason: 'question_retired',
          clear: editableA.actions.state === 'editable' ? editableA.actions.clear : '',
          readback: editableA.actions.state === 'editable' ? editableA.actions.readback : '',
        }),
      ],
      next: null,
    };
  if (mode === 'read-only' || mode === 'long') {
    const vote = entry(targetA, questionA, { state: 'unavailable', reason: 'read_only' });
    if (mode === 'long')
      vote.question.label =
        'Welche Bedeutung hat dieses Werk für dich, wenn du seine lange Geschichte, die einzelnen Veröffentlichungen und die Unterschiede zwischen den Fassungen berücksichtigst?';
    return { viewer: { accountId: subjectId }, votes: [vote], next: null };
  }
  if (mode === 'merged')
    return {
      viewer: { accountId: subjectId },
      votes: [entry(targetA, questionA, { state: 'unavailable', reason: 'merged_source' })],
      next: null,
    };

  return { viewer: { accountId: subjectId }, votes: [editableA, entry(targetB, questionB)], next: null };
}

function StoryScreen() {
  const { mode, locale } = useContext(FixtureContext);
  const [page, setPage] = useState(() => fixture(mode));
  const [failed, setFailed] = useState(mode === 'dependency' || mode === 'return-failed');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const execute = async ({ data }: { data: OwnVoteIntent }) => {
    if (mode === 'uncertain') return { kind: 'uncertain' as const };
    return data.method === 'DELETE'
      ? { kind: 'acknowledged' as const, readback: { kind: 'cleared' as const } }
      : {
          kind: 'acknowledged' as const,
          readback: {
            kind: 'current' as const,
            units: data.body?.units ?? 0,
            revision: 5,
            at: '2026-11-01T10:00:00.000Z',
          },
        };
  };
  const review = async ({ data }: { data: { intent: OwnVoteIntent; after: 'REVIEW' } }): Promise<OwnVoteReadback> =>
    mode === 'uncertain'
      ? { kind: 'unavailable' }
      : { kind: 'current', units: data.intent.body?.units ?? 0, revision: 5, at: '2026-11-01T10:00:00.000Z' };
  return (
    <>
      {mode === 'advice-replaced' ? (
        <button
          className="min-h-11 border p-3"
          onClick={() =>
            setPage({
              ...page,
              votes: page.votes.map((vote) => ({ ...vote, actions: { state: 'unavailable', reason: 'read_only' } })),
            })
          }
        >
          Receive current read-only advice
        </button>
      ) : null}
      <OwnVotesWorkspace
        state={
          mode === 'denied'
            ? 'denied'
            : failed
              ? 'unavailable'
              : mode === 'return-refreshing'
                ? 'preparing'
                : 'ready'
        }
        page={mode === 'denied' || failed || mode === 'return-refreshing' ? null : page}
        cursor={null}
        locale={locale}
        isCurrent={() => true}
        returnPending={mode === 'return-refreshing'}
        returnOutcome={
          mode === 'return-found'
            ? { kind: 'found', pair: { targetId: targetA, questionId: questionA } }
            : mode === 'return-missing'
              ? { kind: 'missing', pair: { targetId: targetA, questionId: questionA } }
              : null
        }
        onRefresh={async () => {
          setFailed(false);
          setPage(fixture('sparse'));
        }}
        onUpdatePage={(update) => setPage(update)}
        headingRef={headingRef}
        execute={execute}
        review={review}
      />
    </>
  );
}

function Story({ mode, locale = 'en' }: { mode: Mode; locale?: (typeof locales)[number] }) {
  setLocale(locale, { reload: false });
  const fixtureValue = useMemo(() => ({ mode, locale }), [mode, locale]);
  const router = useMemo(
    () => createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/library/ratings'] }) }),
    [],
  );
  return (
    <FixtureContext.Provider value={fixtureValue}>
      <RouterProvider router={router} />
    </FixtureContext.Provider>
  );
}

const meta = { title: 'Pages/Library/My ratings', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type StoryType = StoryObj<typeof meta>;

export const Ready: StoryType = { render: () => <Story mode="ready" /> };
export const Empty: StoryType = { render: () => <Story mode="empty" /> };
export const SparseContinuation: StoryType = { render: () => <Story mode="sparse" /> };
export const RetiredQuestion: StoryType = { render: () => <Story mode="retired" /> };
export const MergedSource: StoryType = { render: () => <Story mode="merged" /> };
export const Denied: StoryType = { render: () => <Story mode="denied" /> };
export const LongLocalizedQuestion: StoryType = {
  render: () => <Story mode="long" locale="de" />,
  play: async ({ canvasElement }) => {
    await inspectFirst(canvasElement);
  },
};
export const UncertainCommand: StoryType = {
  render: () => <Story mode="uncertain" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findAllByRole('button', { name: m.library_my_ratings_inspect() }).then((buttons) => buttons[0]!),
    );
    await userEvent.click(await canvas.findByRole('button', { name: m.library_my_ratings_edit() }));
    await userEvent.clear(await canvas.findByRole('spinbutton'));
    await userEvent.type(await canvas.findByRole('spinbutton'), '2');
    await userEvent.click(await canvas.findByRole('button', { name: m.library_my_ratings_save() }));
    await expect(await canvas.findByText(m.library_my_ratings_uncertain_text())).toBeVisible();
    await expect(await canvas.findByRole('button', { name: m.library_my_ratings_retry_original() })).toBeEnabled();
  },
};

const inspectFirst = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click((await canvas.findAllByRole('button', { name: m.library_my_ratings_inspect() }))[0]!);
  return canvas;
};
export const ReadOnly: StoryType = {
  render: () => <Story mode="read-only" />,
  play: async ({ canvasElement }) => {
    const canvas = await inspectFirst(canvasElement);
    await expect(canvas.getByText(m.library_my_ratings_read_only())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_my_ratings_edit() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.library_my_ratings_clear() })).toBeNull();
  },
};
export const EditingBecomesReadOnly: StoryType = {
  render: () => <Story mode="advice-replaced" />,
  play: async ({ canvasElement }) => {
    const canvas = await inspectFirst(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_my_ratings_edit() }));
    await userEvent.clear(canvas.getByRole('spinbutton'));
    await userEvent.type(canvas.getByRole('spinbutton'), '2');
    await userEvent.click(canvas.getByRole('button', { name: 'Receive current read-only advice' }));
    await expect(canvas.queryByRole('spinbutton')).toBeNull();
    await inspectFirst(canvasElement);
    await expect(canvas.getByText(m.library_my_ratings_read_only())).toBeVisible();
  },
};
export const DependencyRecovery: StoryType = {
  render: () => <Story mode="dependency" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_my_ratings_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_my_ratings_retry_page() }));
    await expect(canvas.getByText(m.library_my_ratings_sparse())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_my_ratings_continue() })).toBeVisible();
  },
};
export const ReturnRefreshing: StoryType = { render: () => <Story mode="return-refreshing" /> };
export const ReturnRefreshFailed: StoryType = { render: () => <Story mode="return-failed" /> };
export const ReturnPairFound: StoryType = {
  render: () => <Story mode="return-found" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_my_ratings_return_found())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_my_ratings_edit() })).toBeNull();
    await userEvent.click((await canvas.findAllByRole('button', { name: m.library_my_ratings_inspect() }))[0]!);
    await expect(canvas.getByRole('button', { name: m.library_my_ratings_edit() })).toBeEnabled();
  },
};
export const ReturnPairMissing: StoryType = {
  render: () => <Story mode="return-missing" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_my_ratings_return_missing())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_my_ratings_edit() })).toBeNull();
    await expect(canvas.getAllByRole('button', { name: m.library_my_ratings_inspect() })).toHaveLength(2);
  },
};
