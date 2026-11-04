import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { m } from '../src/paraglide/messages.js';
import { QuestionManagementContent } from '../src/ratings/question-management/page';
import type { QuestionManagementHistoryRead, QuestionManagementPageData } from '../src/ratings/question-management/types';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/questions' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => callback(0),
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  for (const [key, value] of previous)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
  window.happyDOM.abort();
});

const realmId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
const viewerId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702002';
const retiredId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702102';
const page: QuestionManagementPageData = {
  viewer: { accountId: viewerId },
  realmId,
  directory: { ratingQuestions: [], next: null },
  actions: { create: { method: 'POST', href: `/v1/realms/${realmId}/rating-questions` } },
  selected: {
    question: {
      id: retiredId,
      realmId,
      meaning: 'Judge translation accuracy independently of enjoyment of the original work.',
      canonicalLabel: 'Translation accuracy',
      label: 'Translation clarity',
      labelRevision: 2,
      revision: 1,
      grain: 'release',
      scale: { min: 0, max: 20, displayStep: 2 },
      lifecycle: { state: 'retired', revision: 2 },
    },
    readback: `/v1/rating-questions/${retiredId}`,
    history: `/v1/rating-questions/${retiredId}/labels`,
    actions: {
      caption: { method: 'PUT', href: `/v1/rating-questions/${retiredId}/label`, expectedLabelRevision: 2 },
      lifecycle: {
        method: 'POST',
        href: `/v1/rating-questions/${retiredId}/$restore`,
        expectedLifecycleRevision: 2,
      },
    },
  },
};
const history: QuestionManagementHistoryRead = {
  state: 'ready',
  questionId: retiredId,
  cursor: null,
  page: {
    labels: [
      {
        questionId: retiredId,
        labelRevision: 1,
        label: 'Translation accuracy',
        at: null,
        author: { id: viewerId, kind: 'actor', state: 'deleted' },
      },
    ],
    next: null,
  },
};

function button(host: HTMLElement, label: string) {
  const value = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!value) throw new Error(`Missing button: ${label}`);
  return value;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

async function render(options: {
  source?: QuestionManagementPageData;
  sourceHistory?: QuestionManagementHistoryRead;
  callbacks?: {
    create?: (body: unknown) => void;
    caption?: (body: unknown) => void;
    lifecycle?: (action: string, body: unknown) => void;
  };
}) {
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QuestionManagementContent
        page={options.source ?? page}
        address={{ selectedQuestionId: retiredId, cursor: null }}
        onSelect={() => undefined}
        onNext={() => undefined}
        onCreate={(body) => options.callbacks?.create?.(body)}
        onCaption={(body) => options.callbacks?.caption?.(body)}
        onLifecycle={(action, body) => options.callbacks?.lifecycle?.(action, body)}
        history={options.sourceHistory ?? history}
      />,
    ),
  );
  return { host, root };
}

test('creation needs a deliberate review and confirmation, and focus returns to its trigger on cancel', async () => {
  const created: unknown[] = [];
  const { host, root } = await render({ callbacks: { create: (body) => created.push(body) } });
  try {
    await act(async () => button(host, m.realm_question_create()).click());
    expect(host.querySelector('#realm-question-create-heading')).not.toBeNull();
    expect(window.document.activeElement?.id).toBe('realm-question-create-heading');
    const meaning = host.querySelector('textarea')!;
    const label = host.querySelector('input:not([type="number"])')!;
    await act(async () => {
      setValue(meaning, 'Judge the adaptation independently of its source.');
      setValue(label, 'Adaptation fidelity');
    });
    await act(async () => button(host, m.realm_question_review_definition()).click());
    expect(created).toHaveLength(0);
    expect(host.textContent).toContain('Adaptation fidelity');
    await act(async () => button(host, m.realm_question_confirm_create()).click());
    expect(created).toEqual([
      {
        meaning: 'Judge the adaptation independently of its source.',
        label: 'Adaptation fidelity',
        grain: 'release',
        scale: { min: 0, max: 20, displayStep: 1 },
      },
    ]);
    await act(async () => button(host, m.container_lifecycle_cancel()).click());
    expect(window.document.activeElement?.textContent).toBe(m.realm_question_create());
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('caption saves only the caption revision, restore has separate confirmation, and history preserves native author fields', async () => {
  const captions: unknown[] = [];
  const lifecycle: unknown[] = [];
  const { host, root } = await render({ callbacks: { caption: (body) => captions.push(body), lifecycle: (...value) => lifecycle.push(value) } });
  try {
    expect(host.textContent).toContain(viewerId);
    expect(host.textContent).toContain(m.realm_question_author_deleted());
    expect(host.textContent).toContain(m.realm_question_time_unrecorded());
    await act(async () => button(host, m.realm_question_caption_edit()).click());
    expect(window.document.activeElement?.id).toBe('realm-question-caption-heading');
    const input = host.querySelector('input:not([type="number"])')!;
    await act(async () => setValue(input, 'Translation precision'));
    await act(async () => button(host, m.realm_question_review_definition()).click());
    expect(captions).toHaveLength(0);
    await act(async () => button(host, m.realm_question_caption_save()).click());
    expect(captions).toEqual([{ expectedLabelRevision: 2, label: 'Translation precision' }]);

    await act(async () => button(host, m.realm_question_restore()).click());
    expect(lifecycle).toHaveLength(0);
    await act(async () => button(host, m.container_lifecycle_confirm()).click());
    expect(lifecycle).toEqual([['restore', { expectedLifecycleRevision: 2 }]]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('stale history offers cursor restart and unavailable authority hides all commands', async () => {
  const stale = await render({ sourceHistory: { state: 'stale-cursor', questionId: retiredId, cursor: 'stale' } });
  try {
    expect(stale.host.textContent).toContain(m.realm_question_history_stale());
    expect(stale.host.querySelector('button')?.textContent).not.toBe(m.realm_question_history_restart());
    expect([...stale.host.querySelectorAll('button')].some((node) => node.textContent === m.realm_question_history_restart())).toBe(true);
  } finally {
    await act(async () => stale.root.unmount());
    stale.host.remove();
  }

  const unavailable = await render({
    source: {
      ...page,
      actions: { create: null },
      selected: page.selected ? { ...page.selected, actions: { caption: null, lifecycle: null } } : null,
    },
  });
  try {
    expect([...unavailable.host.querySelectorAll('button')].map((node) => node.textContent)).not.toContain(
      m.realm_question_create(),
    );
    expect([...unavailable.host.querySelectorAll('button')].map((node) => node.textContent)).not.toContain(
      m.realm_question_caption_edit(),
    );
  } finally {
    await act(async () => unavailable.root.unmount());
    unavailable.host.remove();
  }
});
