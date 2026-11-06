import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuestionWindow, questionManagementWindows } from '../src/ratings/question-management/window-navigation';
import { sessionQueryKey } from '../src/session/browser-state';
import { m } from '../src/paraglide/messages.js';
import { actionsMock, sessionMock, stubs, type QuestionStubs } from './question-management-stubs';
import type { BrowserObservationSnapshot } from '../src/session/observation';
import type {
  QuestionManagementHistoryRead,
  QuestionManagementRead,
  QuestionManagementVisit,
} from '../src/ratings/question-management/types';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: clearTimeout,
  scrollTo: () => {},
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  mock.restore();
  window.happyDOM.abort();
  for (const [key, value] of previousGlobals)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
});
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const realmId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
const viewer = '019a1b2c-3d4e-7f00-8a00-5ab1ec702002';
const questionId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702101';
const csrfToken = 'original-csrf';
const csrfEpisode = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csrfToken)))]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
const visit: QuestionManagementVisit = {
  realmId,
  viewer,
  selectedQuestionId: questionId,
  cursor: null,
  locale: 'en',
  credentialEpisode: 'ab'.repeat(32),
  csrfEpisode,
  state: 'preparing',
};
const directoryCursors = [null, 'd1 +%&=opaque', 'd2 /?opaque'];
const historyCursors = [null, 'h1 +%&=opaque', 'h2 /?opaque'];
type ReadRequest = {
  visit: QuestionManagementVisit;
  address: { realmId: string; selectedQuestionId: string | null; cursor: string | null };
  resolve: (value: QuestionManagementRead) => void;
};
type HistoryRequest = {
  questionId: string;
  cursor: string | null;
  resolve: (value: QuestionManagementHistoryRead) => void;
};
const reads: ReadRequest[] = [];
const histories: HistoryRequest[] = [];
const sends: unknown[] = [];
const sessionModule = await import('../src/session/query');
mock.module('../src/session/query', () => sessionMock(sessionModule));
mock.module('cloudflare:workers', () => ({ env: {} }));
const actualActions = await import('../src/ratings/question-management/actions');
mock.module('../src/ratings/question-management/actions', () => actionsMock(actualActions));
beforeEach(() => {
  stubs.session = { state: 'signed-in', subject: viewer, csrfToken };
  stubs.prepare = async (input: { data: Partial<QuestionManagementVisit> }) => ({ ...visit, ...input.data });
  stubs.read = ({ data }: { data: Pick<ReadRequest, 'visit' | 'address'> }) =>
    new Promise<QuestionManagementRead>((resolve) => reads.push({ ...data, resolve }));
  stubs.history = ({ data }: { data: { questionId: string; cursor: string | null } }) =>
    new Promise<QuestionManagementHistoryRead>((resolve) => histories.push({ ...data, resolve }));
  stubs.execute = async (input: unknown) => {
    sends.push(input);
    return { kind: 'uncertain' };
  };
});
afterEach(() => {
  for (const key of Object.keys(stubs) as (keyof QuestionStubs)[]) delete stubs[key];
});
mock.module('../src/shell/head-context', () => ({ pageHeadContext: () => ({}) }));
mock.module('../src/shell/head', () => ({ pageHead: () => ({}) }));
const { Route } = await import('../src/routes/realms/$id_.questions');
function button(host: ParentNode, text: string) {
  const node = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!node) throw new Error(`Missing button: ${text}`);
  return node as HTMLButtonElement;
}
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++) await tick();
  expect(predicate()).toBe(true);
}
async function mount(cursor: string | null = null) {
  reads.length = 0;
  histories.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: viewer, csrfToken });
  const rootRoute = createRootRoute({ component: Outlet });
  const route = Route.update({ getParentRoute: () => rootRoute, path: '/realms/$id/questions' } as never);
  const history = createMemoryHistory({
    initialEntries: [
      `/realms/${realmId}/questions?selectedQuestionId=${questionId}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    ],
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history, context: { queryClient: client } });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await until(() => reads.length > 0);
  const directory = () => host.querySelector('[aria-labelledby="realm-question-directory-heading"]')!;
  const captions = () => host.querySelector('[aria-labelledby="realm-question-history-heading"]')!;
  const admit = async (failed = false) => {
    const request = reads.at(-1)!;
    const question = {
      id: request.address.selectedQuestionId!,
      realmId,
      meaning: 'Meaning',
      canonicalLabel: 'Caption',
      label: 'Caption',
      labelRevision: 1,
      revision: 1,
      grain: 'release' as const,
      scale: { min: 0, max: 20, displayStep: 1 },
      lifecycle: { state: 'active' as const, revision: 1 },
    };
    const index = directoryCursors.indexOf(request.address.cursor);
    const count = histories.length;
    await act(async () =>
      request.resolve(
        failed
          ? { ...request.visit, ...request.address, state: 'unavailable' }
          : {
              ...request.visit,
              ...request.address,
              state: 'ready',
              viewer,
              credentialEpisode: visit.credentialEpisode!,
              csrfEpisode,
              page: {
                realmId,
                viewer: { accountId: viewer },
                directory: { ratingQuestions: [], next: directoryCursors[index + 1] ?? null },
                actions: { create: { method: 'POST', href: `/v1/realms/${realmId}/rating-questions` } },
                selected: {
                  question,
                  readback: `/v1/rating-questions/${question.id}`,
                  history: `/v1/rating-questions/${question.id}/labels`,
                  actions: {
                    caption: {
                      method: 'PUT',
                      href: `/v1/rating-questions/${question.id}/label`,
                      expectedLabelRevision: 1,
                    },
                    lifecycle: null,
                  },
                },
              },
            },
      ),
    );
    if (!failed) await until(() => histories.length > count);
  };
  const admitHistory = async (failed = false) => {
    const request = histories.at(-1)!;
    const index = historyCursors.indexOf(request.cursor);
    await act(async () =>
      request.resolve(
        failed
          ? { state: 'unavailable', questionId: request.questionId, cursor: request.cursor }
          : {
              state: 'ready',
              questionId: request.questionId,
              cursor: request.cursor,
              page: { labels: [], next: historyCursors[index + 1] ?? null },
            },
      ),
    );
  };
  const click = async (region: ParentNode, text: string, twice = false) => {
    await act(async () => {
      const trigger = button(region, text);
      trigger.click();
      if (twice) trigger.click();
    });
    await tick();
  };
  const close = async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  };
  return { host, router, client, directory, captions, admit, admitHistory, click, close };
}

test('bounded acceptance, exact failed targets, branching, direct/equal/ABA source retirement', () => {
  const path = new QuestionWindow(null);
  path.accept(null);
  for (let i = 1; i <= 12; i++) {
    path.stage(String(i));
    path.accept(String(i));
  }
  expect(path.predecessors).toEqual(['4', '5', '6', '7', '8', '9', '10', '11']);
  path.stage('10');
  expect(path.accept('wrong')).toBe(false);
  expect(path.current).toBe('12');
  expect(path.requested).toBe('10');
  path.accept('10');
  expect(path.previous).toBe('9');
  path.stage('branch');
  path.accept('branch');
  expect(path.predecessors).toEqual(['4', '5', '6', '7', '8', '9', '10']);
  path.stage(null);
  path.accept(null);
  expect(path.predecessors).toEqual([]);
  const client = new QueryClient();
  const observation = {} as BrowserObservationSnapshot;
  const a = questionManagementWindows(client, visit, observation, 'en');
  a.directory.accept(null);
  a.moving({ selectedQuestionId: questionId, cursor: 'second' });
  const second = { ...visit, cursor: 'second' };
  const b = questionManagementWindows(client, second, observation, 'en');
  expect(b).toBe(a);
  b.directory.accept('second');
  b.history.accept(null);
  b.history.stage('h1');
  b.history.accept('h1');
  const replacement = questionManagementWindows(client, { ...second }, observation, 'en');
  expect(a.active).toBe(false);
  expect(replacement.directory.previous).toBeUndefined();
  expect(replacement.history.requested).toBeNull();
  expect(questionManagementWindows(client, second, observation, 'en')).not.toBe(b);
  replacement.moving({ selectedQuestionId: 'another-question', cursor: null });
  expect(replacement.active).toBe(false);
  expect(questionManagementWindows(new QueryClient(), second, observation, 'en').directory.previous).toBeUndefined();
});

test('actual Router three-window directory/history return, failed-target Retry, duplicates and independent positions', async () => {
  const ui = await mount();
  try {
    await ui.admit();
    await ui.admitHistory();
    expect(ui.directory().textContent).toContain(m.realm_question_window_sparse());
    await ui.click(ui.captions(), m.realm_question_history_more(), true);
    expect(histories).toHaveLength(2);
    await ui.admitHistory();
    await ui.click(ui.captions(), m.realm_question_history_more());
    await ui.admitHistory();
    expect(ui.captions().textContent).toContain(m.realm_question_window_terminal());
    expect(window.document.activeElement?.id).toBe('realm-question-history-heading');
    await ui.click(ui.captions(), m.realm_question_window_previous());
    expect(histories.at(-1)?.cursor).toBe(historyCursors[1]);
    await ui.admitHistory();
    await ui.click(ui.directory(), m.home_questions_next(), true);
    expect(reads).toHaveLength(2);
    await ui.admit();
    expect(histories.at(-1)?.cursor).toBe(historyCursors[1]);
    await ui.admitHistory();
    await ui.click(ui.directory(), m.home_questions_next());
    await ui.admit(true);
    await ui.click(ui.host, m.home_questions_retry());
    expect(reads.at(-1)?.address.cursor).toBe(directoryCursors[2]);
    await ui.admit();
    await ui.admitHistory();
    expect(ui.directory().textContent).toContain(m.realm_question_window_terminal());
    expect(window.document.activeElement?.id).toBe('realm-question-directory-heading');
    await ui.click(ui.directory(), m.realm_question_window_previous());
    expect(reads.at(-1)?.address.cursor).toBe(directoryCursors[1]);
    await ui.admit();
    await ui.admitHistory();
    await ui.click(ui.captions(), m.realm_question_history_more());
    await ui.admitHistory(true);
    expect(ui.directory().textContent).toContain(m.realm_question_window_previous());
    await ui.click(ui.captions(), m.home_questions_retry());
    expect(histories.at(-1)?.cursor).toBe(historyCursors[2]);
    await ui.admitHistory();
    await ui.click(ui.captions(), m.realm_question_window_first());
    expect(histories.at(-1)?.cursor).toBeNull();
    await ui.admitHistory();
    await ui.click(ui.directory(), m.realm_question_window_first());
    expect(reads.at(-1)?.address.cursor).toBeNull();
    await ui.admit();
    await ui.admitHistory();
    const count = reads.length;
    await act(async () => ui.router.history.back());
    await until(() => reads.length > count);
    expect(reads.at(-1)?.address.cursor).toBe(directoryCursors[1]);
    await ui.admit();
    await ui.admitHistory();
    await act(async () => ui.router.history.forward());
    await until(() => reads.length > count + 1);
    await ui.admit();
    await ui.admitHistory();
    expect(reads.at(-1)?.address.cursor).toBeNull();
  } finally {
    await ui.close();
  }
});

test('direct later visit has First but no invented Previous; Stay preserves drafts and history movement waits for Leave', async () => {
  const ui = await mount(directoryCursors[1]);
  try {
    await ui.admit();
    await ui.admitHistory();
    expect(ui.directory().textContent).not.toContain(m.realm_question_window_previous());
    expect(ui.directory().textContent).toContain(m.realm_question_window_first());
    await ui.click(ui.host, m.realm_question_caption_edit());
    const input = ui.host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, ' raw draft ');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await ui.click(ui.directory(), m.home_questions_next(), true);
    expect(reads).toHaveLength(1);
    await ui.click(window.document, m.library_my_ratings_stay());
    expect(input.value).toBe(' raw draft ');
    expect(button(ui.captions(), m.realm_question_history_more()).disabled).toBe(false);
    await ui.click(ui.captions(), m.realm_question_history_more(), true);
    expect(histories).toHaveLength(1);
    await ui.click(window.document, m.library_my_ratings_stay());
    expect(input.value).toBe(' raw draft ');
    expect(histories).toHaveLength(1);
    await ui.click(ui.captions(), m.realm_question_history_more());
    expect(histories).toHaveLength(1);
    await ui.click(window.document, m.library_my_ratings_leave());
    expect(histories.at(-1)?.cursor).toBe(historyCursors[1]);
    await ui.admitHistory();
    expect(ui.host.querySelector('input')).toBeNull();
    expect(reads).toHaveLength(1);
    // An equal source replacement while Leave is pending cannot commit the old target.
    await ui.click(ui.host, m.realm_question_create());
    const draft = ui.host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'unfinished');
      draft.dispatchEvent(new window.Event('input', { bubbles: true }));
      draft.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await ui.click(ui.captions(), m.realm_question_history_more());
    await act(async () => {
      void ui.router.invalidate();
    });
    await until(() => reads.length > 1);
    await ui.admit();
    expect(histories.at(-1)?.cursor).toBeNull();
    await ui.admitHistory();
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    // New selected identity retires both paths, including the selection-bound directory cursor.
    await act(async () => {
      void ui.router.navigate({ to: `/realms/${realmId}/questions`, search: { selectedQuestionId: viewer } } as never);
    });
    await until(() => reads.length > 2);
    await ui.admit();
    await ui.admitHistory();
    expect(reads.at(-1)?.address.cursor).toBeNull();
    expect(histories.at(-1)?.questionId).toBe(viewer);
    expect(ui.directory().textContent).not.toContain(m.realm_question_window_previous());
    // Uncertain commands lock both pagers and retry the original operands and credentials.
    await ui.click(ui.host, m.realm_question_caption_edit());
    await ui.click(ui.host, m.realm_question_review_definition());
    await ui.click(ui.host, m.realm_question_caption_save());
    await until(() => sends.length === 1);
    await ui.click(ui.captions(), m.realm_question_history_more());
    expect(window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      m.library_my_ratings_departure_locked(),
    );
    await ui.click(window.document, m.library_my_ratings_stay());
    await ui.click(ui.host, m.realm_question_retry_original());
    await until(() => sends.length === 2);
    expect(sends[1]).toEqual(sends[0]);
  } finally {
    await ui.close();
  }
});
