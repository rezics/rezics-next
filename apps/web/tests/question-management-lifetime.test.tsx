import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { m } from '../src/paraglide/messages.js';
import { browserObservation } from '../src/session/observation';
import { sessionQueryKey } from '../src/session/browser-state';
import type {
  QuestionCaptionInput,
  QuestionManagementCommandResult,
  QuestionManagementFocusTicket,
  QuestionManagementIntent,
  QuestionManagementPageData,
  QuestionManagementRead,
  QuestionManagementVisit,
} from '../src/ratings/question-management/types';

type CaptureRequest = {
  input: unknown;
  resolve: (intent: QuestionManagementIntent) => void;
};
type SendRequest = {
  input: { data: { intent: QuestionManagementIntent } };
  resolve: (result: QuestionManagementCommandResult) => void;
};
const reads: { resolve: (read: QuestionManagementRead) => void }[] = [];
const captures: CaptureRequest[] = [];
const sends: SendRequest[] = [];
const histories: unknown[] = [];
const departures: { dirty: boolean; locked: boolean; onLeave?: () => void }[] = [];
let captureFactory: (input: unknown) => Promise<QuestionManagementIntent> = async () => intent;
let observedPage: QuestionManagementPageData;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/questions' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  for (const [key, value] of previous)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
  window.happyDOM.abort();
  mock.restore();
});

const realmId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
const viewerId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702002';
const questionId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702101';
const csrfToken = 'question-management-csrf';
const credentialEpisode = 'ab'.repeat(32);
const labelHref = `/v1/rating-questions/${questionId}/label`;
observedPage = {
  viewer: { accountId: viewerId },
  realmId,
  directory: {
    ratingQuestions: [],
    next: null,
  },
  actions: { create: null },
  selected: {
    question: {
      id: questionId,
      realmId,
      meaning: 'Assess translation quality independently of preference.',
      canonicalLabel: 'Translation quality',
      label: 'Translation quality',
      labelRevision: 1,
      revision: 1,
      grain: 'release',
      scale: { min: 0, max: 20, displayStep: 1 },
      lifecycle: { state: 'active', revision: 1 },
    },
    readback: `/v1/rating-questions/${questionId}`,
    history: `/v1/rating-questions/${questionId}/labels`,
    actions: {
      caption: { method: 'PUT', href: labelHref, expectedLabelRevision: 1 },
      lifecycle: { method: 'POST', href: `/v1/rating-questions/${questionId}/$retire`, expectedLifecycleRevision: 1 },
    },
  },
};
const intent = Object.freeze({
  action: 'caption',
  viewer: viewerId,
  realmId,
  questionId,
  locale: 'en',
  credentialEpisode,
  csrfEpisode: 'cd'.repeat(32),
  csrfToken,
  sourceObservation: 'ef'.repeat(32),
  key: '019a1b2c-3d4e-7f00-8a00-5ab1ec702201',
  href: labelHref,
  body: { expectedLabelRevision: 1, label: 'Translation clarity' },
  serializedBody: JSON.stringify({ expectedLabelRevision: 1, label: 'Translation clarity' }),
}) as QuestionManagementIntent;

mock.module('../src/ratings/question-management/actions', () => ({
  readQuestionManagementForViewer: () =>
    new Promise<QuestionManagementRead>((resolve) => {
      reads.push({ resolve });
    }),
  readQuestionManagementHistory: async (input: unknown) => {
    histories.push(input);
    return { state: 'unavailable', questionId, cursor: null };
  },
  executeQuestionManagementIntent: (input: SendRequest['input']) =>
    new Promise<QuestionManagementCommandResult>((resolve) => {
      sends.push({ input, resolve });
    }),
}));
mock.module('../src/ratings/question-management/intent', () => ({
  captureQuestionManagementIntent: (input: unknown) => {
    captures.push({ input, resolve: () => {} });
    return captureFactory(input);
  },
  questionManagementIntentMatchesPage: () => true,
  validQuestionManagementBody: (_action: string, value: unknown) => {
    const body = value as QuestionCaptionInput;
    return typeof body.label === 'string' && body.label.trim().length > 0;
  },
}));
mock.module('../src/session/query', () => ({
  useSession: () => ({ state: 'signed-in', subject: viewerId, csrfToken }),
}));
mock.module('../src/ratings/own-votes/departure', () => ({
  OwnVotesDeparture: (props: { dirty: boolean; locked: boolean; onLeave?: () => void }) => {
    departures.push(props);
    return null;
  },
}));

const { QuestionManagementPage } = await import('../src/ratings/question-management/page');
const csrfEpisode = await (async () => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csrfToken)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
})();
const initial: QuestionManagementVisit = {
  realmId,
  selectedQuestionId: questionId,
  cursor: null,
  locale: 'en',
  viewer: viewerId,
  credentialEpisode,
  csrfEpisode,
  state: 'preparing',
};
const readyRead = (): QuestionManagementRead => ({
  realmId,
  selectedQuestionId: questionId,
  cursor: null,
  locale: 'en',
  viewer: viewerId,
  credentialEpisode,
  csrfEpisode,
  state: 'ready',
  page: structuredClone(observedPage),
});

function button(host: HTMLElement, label: string) {
  const value = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!value) throw new Error(`Missing button: ${label}`);
  return value;
}

function setValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

async function waitForWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount({ focusTicket: initialTicket = null }: { focusTicket?: QuestionManagementFocusTicket | null } = {}) {
  reads.length = 0;
  captures.length = 0;
  sends.length = 0;
  histories.length = 0;
  departures.length = 0;
  observedPage = structuredClone(observedPage);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: viewerId, csrfToken });
  const observationStore = browserObservation(client);
  const stopObservation = observationStore.subscribe(() => {});
  const observation = observationStore.getSnapshot();
  let addressEpisode = 0;
  let addressToken = {};
  let focusEpoch = 0;
  let focusTicket = initialTicket;
  let nextTicketId = initialTicket?.id ?? 0;
  const focusRequests: { questionId: string | null; expectedEpoch: number; afterRead: number }[] = [];
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  const externalFocus = window.document.createElement('button');
  externalFocus.textContent = 'Outside the question page';
  window.document.body.append(externalFocus);
  const root = createRoot(host);
  const render = (key: string, source = initial) => {
    const currentObservation = observationStore.getSnapshot();
    const currentAddressToken = addressToken;
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(QuestionManagementPage, {
          key,
          initial: source,
          address: { selectedQuestionId: questionId, cursor: null },
          locale: 'en',
          navigate: () => {},
          onSelectQuestion: () => {},
          sessionObservation: currentObservation,
          isSessionObservationCurrent: () => observationStore.getSnapshot() === currentObservation,
          addressKey: `question-address-${addressEpisode}`,
          isAddressCurrent: () => addressToken === currentAddressToken,
          focusTicket,
          isFocusTicketCurrent: (ticket) => focusTicket === ticket && focusEpoch === ticket.focusEpoch,
          consumeFocusTicket: (ticket) => {
            if (focusTicket !== ticket || focusEpoch !== ticket.focusEpoch) return false;
            focusTicket = null;
            return true;
          },
          captureFocusEpoch: () => focusEpoch,
          acknowledgeFocus: (question, expectedEpoch, afterRead) => {
            if (focusEpoch === expectedEpoch) {
              focusRequests.push({ questionId: question, expectedEpoch, afterRead });
              if (question)
                focusTicket = {
                  id: ++nextTicketId,
                  questionId: question,
                  focusEpoch: expectedEpoch,
                  afterRead,
                };
            }
          },
        }),
      ),
    );
  };
  return {
    client,
    observationStore,
    stopObservation,
    observation,
    focusRequests,
    host,
    root,
    render,
    movedFocus: () => {
      focusEpoch++;
      externalFocus.focus();
    },
    leaveAndReturnAddress: () => {
      addressEpisode++;
      addressToken = {};
      addressEpisode++;
      addressToken = {};
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      stopObservation();
      client.clear();
      host.remove();
      externalFocus.remove();
    },
  };
}

async function enterCaption(host: HTMLElement) {
  await act(async () => button(host, m.realm_question_caption_edit()).click());
  const input = host.querySelector('input:not([type="number"])');
  if (!(input instanceof window.HTMLInputElement)) throw new Error('Expected caption input');
  await act(async () => setValue(input, 'Translation clarity'));
  await act(async () => button(host, m.realm_question_review_definition()).click());
  await act(async () => button(host, m.realm_question_caption_save()).click());
}

test('equal browser session replacement retires asynchronous intent preparation before dispatch', async () => {
  captureFactory = () => new Promise<QuestionManagementIntent>(() => {});
  const view = mount();
  const preparation = deferred<QuestionManagementIntent>();
  captureFactory = () => preparation.promise;
  try {
    await act(async () => view.render('same-address'));
    await waitForWork();
    expect(reads).toHaveLength(1);
    await act(async () => reads[0]!.resolve(readyRead()));
    await waitForWork();
    await enterCaption(view.host);
    expect(captures).toHaveLength(1);

    await act(async () => {
      view.client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: viewerId, csrfToken });
    });
    expect(view.observationStore.getSnapshot()).not.toBe(view.observation);
    await act(async () => view.render('same-address'));
    await act(async () => preparation.resolve(intent));
    expect(sends).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

test('equal session replacement permanently retires the pending original page read', async () => {
  const view = mount();
  try {
    await act(async () => view.render('session-one'));
    await waitForWork();
    expect(reads).toHaveLength(1);
    await act(async () => {
      view.client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: viewerId, csrfToken });
    });
    await act(async () => view.render('session-two'));
    await waitForWork();
    expect(reads).toHaveLength(2);
    await act(async () => reads[0]!.resolve(readyRead()));
    await waitForWork();
    expect(view.host.textContent).not.toContain(observedPage.selected!.question.meaning);
    expect(histories).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

test('an A-B-A address excursion retires captured intent preparation', async () => {
  const preparation = deferred<QuestionManagementIntent>();
  captureFactory = () => preparation.promise;
  const view = mount();
  try {
    await act(async () => view.render('address-one'));
    await waitForWork();
    await act(async () => reads[0]!.resolve(readyRead()));
    await waitForWork();
    await enterCaption(view.host);
    expect(captures).toHaveLength(1);
    view.leaveAndReturnAddress();
    await act(async () => preparation.resolve(intent));
    expect(sends).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

test('equal source replacement retires captured intent preparation', async () => {
  const preparation = deferred<QuestionManagementIntent>();
  captureFactory = () => preparation.promise;
  const view = mount();
  try {
    await act(async () => view.render('source-one'));
    await waitForWork();
    await act(async () => reads[0]!.resolve(readyRead()));
    await waitForWork();
    await enterCaption(view.host);
    expect(captures).toHaveLength(1);
    await act(async () => view.render('source-two', { ...initial }));
    await act(async () => preparation.resolve(intent));
    expect(sends).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

test('the selected question heading receives focus only for a current selection ticket', async () => {
  const view = mount({
    focusTicket: { id: 1, questionId, focusEpoch: 0, afterRead: 1 },
  });
  try {
    await act(async () => view.render('explicit-selection'));
    await waitForWork();
    await act(async () => reads[0]!.resolve(readyRead()));
    await waitForWork();
    expect(window.document.activeElement).toBe(view.host.querySelector('#realm-question-selected-heading'));
  } finally {
    await view.cleanup();
  }
});

test('unknown question command retries its frozen intent and a late acknowledgement cannot refocus after movement', async () => {
  captureFactory = async () => intent;
  const view = mount();
  try {
    await act(async () => view.render('question-command'));
    await waitForWork();
    await act(async () => reads[0]!.resolve(readyRead()));
    await waitForWork();
    expect(window.document.activeElement?.id).not.toBe('realm-question-selected-heading');
    await enterCaption(view.host);
    await waitForWork();
    expect(sends).toHaveLength(1);
    expect(departures.at(-1)?.locked).toBe(true);
    await act(async () => sends[0]!.resolve({ kind: 'uncertain' }));
    await waitForWork();
    expect(departures.at(-1)?.locked).toBe(true);
    await act(async () => button(view.host, m.realm_question_retry_original()).click());
    await waitForWork();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.input.data.intent).toBe(sends[0]!.input.data.intent);

    view.movedFocus();
    await act(async () => sends[1]!.resolve({ kind: 'acknowledged', questionId: null }));
    await waitForWork();
    expect(view.focusRequests).toHaveLength(0);
    expect(window.document.activeElement?.textContent).toBe('Outside the question page');
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]!.resolve(readyRead()));
    await waitForWork();
    expect(departures.at(-1)?.dirty).toBe(false);
    expect(departures.at(-1)?.locked).toBe(false);
  } finally {
    await view.cleanup();
  }
});
