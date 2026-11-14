import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { ClassificationsReader } from '../src/ratings/own-classifications/reader';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import type { ClassificationCommands } from '../src/ratings/own-classifications/editor';
import type { ClassificationIntent } from '../src/ratings/own-classifications/intent';
import type { OwnClassificationsRead } from '../src/ratings/own-classifications/types';
import { m } from '../src/paraglide/messages.js';
import {
  accountId,
  associationId,
  classificationRow,
  classificationsPage,
  subjectId,
  targetId,
} from './own-classification-assessments-fixture';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/classification-assessments' });
let deferredFrames: FrameRequestCallback[] | null = null;
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLSelectElement: window.HTMLSelectElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    deferredFrames ? deferredFrames.push(callback) : (callback(0), 0),
  cancelAnimationFrame: () => {},
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  for (const [key, value] of previous)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
  window.happyDOM.abort();
});

const frontier = { cursor: 'raw', selected: { subjectId, associationId } };
function ready(): Extract<OwnClassificationsRead, { state: 'ready' }> {
  return {
    state: 'ready',
    page: classificationsPage(),
    frontier,
    subject: accountId,
    locale: 'en',
    source: 'content.classification-ballot-own-page.v1',
    credential: 'ab'.repeat(32),
    observation: 'cd'.repeat(32),
  };
}
function button(host: HTMLElement, label: string) {
  const value = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!value) throw new Error(`Missing button: ${label}`);
  return value;
}

function workspace(
  page = classificationsPage(),
  commands: Partial<ClassificationCommands> = {},
  props: Partial<ComponentProps<typeof OwnClassificationsWorkspace>> = {},
) {
  const address = props.frontier ?? { cursor: 'raw', selected: null };
  return (
    <OwnClassificationsWorkspace
      state="ready"
      page={page}
      frontier={address}
      locale="en"
      isCurrent={() => true}
      onRetry={async () => {}}
      onNext={() => {}}
      commands={{
        read: { ...ready(), page, frontier: address },
        csrfToken: () => 'csrf',
        send: async () => ({ kind: 'acknowledged' }),
        review: async () => ({ kind: 'unavailable' }),
        ...commands,
      }}
      {...props}
    />
  );
}

test('first-of-20 inspection stays at its opener; disclosure preserves the editor and commands keep original keys', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const page = classificationsPage(Array.from({ length: 20 }, (_, index) => classificationRow(index)));
  const first = page.items[0]!;
  if (first.state !== 'available') throw new Error('Expected available fixture');
  first.subject = { ...first.subject, id: targetId, label: 'Moved recognizable subject' };
  const sent: ClassificationIntent[] = [];
  try {
    await act(async () =>
      root.render(
        workspace(page, {
          send: async (intent) => {
            sent.push(intent);
            return { kind: 'acknowledged' };
          },
        }),
      ),
    );
    const opener = button(host, m.subject_classification_assessment_inspect());
    opener.focus();
    const focus = opener.focus.bind(opener);
    const focusCalls: (FocusOptions | undefined)[] = [];
    opener.focus = (options) => {
      focusCalls.push(options);
      focus(options);
    };
    await act(async () => opener.click());
    const detail = host.querySelector('section')!;
    expect(document.activeElement).toBe(opener);
    expect(focusCalls).toEqual([]);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(opener.getAttribute('aria-controls')).toBe(detail.id);
    expect(detail.parentElement).toBe(host.querySelector('li'));
    expect(detail.previousElementSibling).toBe(opener);
    expect(detail.querySelector('h2')?.textContent).toContain('Moved recognizable subject · Own-page concept');
    const disclosure = detail.querySelector('details')!;
    const summary = disclosure.querySelector('summary')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('a')?.getAttribute('href')?.toLowerCase()).not.toContain('moved');
    const draft = detail.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => draft.click());
    await act(async () => summary.click());
    await act(async () => summary.click());
    expect(detail.querySelector('input[type="checkbox"]')).toBe(draft);
    expect(draft.checked).toBe(false);
    await act(async () => button(host, m.subject_classification_assessment_change()).click());
    expect(JSON.stringify(sent[0])).toContain(
      `/v1/subjects/${subjectId}/classification-associations/${associationId}/assessment`,
    );
    await act(async () => button(host, m.own_classifications_close()).click());
    expect(host.querySelector('section')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(focusCalls).toEqual([{ preventScroll: true }]);
    await act(async () => opener.click());
    await act(async () =>
      host
        .querySelector('summary')!
        .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(host.querySelector('section')).toBeNull();
    expect(document.activeElement).toBe(opener);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('replacement rejects a late close decision and retirement cancels deferred opener focus', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let decide!: (leave: boolean) => void;
  const page = classificationsPage();
  const address = { cursor: 'raw', selected: { subjectId, associationId } };
  try {
    await act(async () =>
      root.render(
        workspace(
          page,
          {
            confirmMovement: {
              current: () =>
                new Promise((resolve) => {
                  decide = resolve;
                }),
            },
          },
          { frontier: address },
        ),
      ),
    );
    await act(async () => button(host, m.own_classifications_close()).click());
    const replacement = classificationsPage();
    await act(async () => root.render(workspace(replacement, {}, { frontier: address })));
    const detail = host.querySelector('section');
    await act(async () => decide(true));
    expect(host.querySelector('section')).toBe(detail);
    deferredFrames = [];
    const opener = button(host, m.subject_classification_assessment_inspect());
    let restored = 0;
    opener.focus = () => {
      restored++;
    };
    await act(async () => button(host, m.own_classifications_close()).click());
    expect(deferredFrames).toHaveLength(1);
    await act(async () =>
      root.render(workspace(replacement, {}, { state: 'denied', isCurrent: () => false, frontier: address })),
    );
    for (const frame of deferredFrames) frame(0);
    expect(restored).toBe(0);
    expect(host.querySelector('section')).toBeNull();
    document.body.focus();
    await act(async () => root.render(workspace(classificationsPage(), {}, { frontier: address, focusHeading: true })));
    expect(document.activeElement).toBe(host.querySelector('h1'));
  } finally {
    deferredFrames = null;
    await act(async () => root.unmount());
    host.remove();
  }
});

test('browser admission refreshes the selected frontier; readback leaves the original unknown withdrawal locked for retry', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const initial = ready();
  let resolve!: (value: OwnClassificationsRead) => void;
  let calls = 0;
  let active = true;
  const sent: ClassificationIntent[] = [];
  const read = async () => {
    calls++;
    return new Promise<OwnClassificationsRead>((done) => {
      resolve = done;
    });
  };
  try {
    await act(async () =>
      root.render(
        <ClassificationsReader
          initial={initial}
          frontier={frontier}
          locale="en"
          subject={accountId}
          state={null}
          isCurrent={() => active}
          read={read}
          commands={{
            csrfToken: () => 'csrf',
            send: async (intent) => {
              sent.push(intent);
              return { kind: 'uncertain' };
            },
            review: async () => ({
              kind: 'current',
              own: {
                associationId,
                hasBallot: false,
                assessment: null,
                falsePositive: false,
                revision: '2',
                pending: true,
              },
            }),
          }}
        />,
      ),
    );
    expect(calls).toBe(1);
    expect(host.textContent).not.toContain('Own-page subject');
    await act(async () => resolve(ready()));
    expect(host.querySelector('section')).not.toBeNull();
    expect(host.textContent).toContain('incomplete lifetime coverage');
    await act(async () => button(host, 'Withdraw ballot').click());
    await act(async () => button(host.querySelector('[role="group"]')!, 'Confirm clear').click());
    expect(sent).toHaveLength(1);
    await act(async () => button(host, 'Read current assessment').click());
    expect(host.textContent).toContain('Current readback does not acknowledge');
    expect(host.textContent).toContain('You have not assessed this association.');
    expect(host.querySelector('select')?.closest('fieldset')?.disabled).toBe(true);
    await act(async () => button(host, 'Retry original request').click());
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    const retry = button(host, 'Retry original request');
    active = false;
    await act(async () => retry.click());
    expect(sent).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('replacement aborts old admission and commands; away and return require a new native observation', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  const root = createRoot(host);
  const requests: { signal: AbortSignal | undefined; done: (value: OwnClassificationsRead) => void }[] = [];
  const initial = ready();
  const render = (episode: string) =>
    root.render(
      <ClassificationsReader
        key={episode}
        initial={initial}
        frontier={frontier}
        locale="en"
        subject={accountId}
        state={null}
        isCurrent={() => true}
        read={(_frontier, signal) => new Promise((done) => requests.push({ signal, done }))}
      />,
    );
  try {
    await act(async () => render('credential-one'));
    await act(async () => render('credential-two'));
    expect(requests[0]!.signal?.aborted).toBe(true);
    await act(async () => requests[0]!.done(ready()));
    expect(host.textContent).not.toContain('Own-page subject');
    await act(async () => requests[1]!.done(ready()));
    expect(host.textContent).toContain('Own-page subject');
    await act(async () => root.render(null));
    await act(async () => render('return'));
    expect(requests).toHaveLength(3);
    expect(host.textContent).not.toContain('Own-page subject');
  } finally {
    await act(async () => root.unmount());
  }
});

test('an acknowledged classification stays locked for reinspection without protecting a settled form as dirty', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ClassificationsReader
          initial={ready()}
          frontier={frontier}
          locale="en"
          subject={accountId}
          state={null}
          isCurrent={() => true}
          read={async () => ready()}
          commands={{
            csrfToken: () => 'csrf',
            send: async () => ({ kind: 'acknowledged' }),
            review: async () => ({
              kind: 'current',
              own: {
                associationId,
                hasBallot: true,
                assessment: 'oppose',
                falsePositive: true,
                revision: '2',
                pending: 'current',
              },
            }),
            departure: (dirty, locked) => {
              const state = `${dirty}:${locked}`;
              return <output data-protection="">{state}</output>;
            },
          }}
        />,
      ),
    );
    expect(host.querySelector('[data-protection]')?.textContent).toBe('false:false');
    const select = host.querySelector('select');
    if (!select) throw new Error('Expected assessment selector');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
      setter?.call(select, 'oppose');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(host.querySelector('[data-protection]')?.textContent).toBe('true:false');
    await act(async () => button(host, m.subject_classification_assessment_change()).click());
    expect(host.textContent).toContain(m.own_classifications_acknowledged());
    expect(host.querySelector('[data-protection]')?.textContent).toBe('false:false');
    expect(select.closest('fieldset')?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('reader replacement aborts a dispatched classification command before its late acknowledgement', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const signals: AbortSignal[] = [];
  const intents: ClassificationIntent[] = [];
  const retirements: (() => void)[] = [];
  let finish!: (value: { kind: 'acknowledged' }) => void;
  const render = (owner: string) =>
    root.render(
      <ClassificationsReader
        key={owner}
        initial={ready()}
        frontier={frontier}
        locale="en"
        subject={accountId}
        state={null}
        isCurrent={() => true}
        read={async () => ready()}
        commands={{
          csrfToken: () => 'csrf',
          send: (intent, signal) => {
            intents.push(intent);
            signals.push(signal);
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
          review: async () => ({ kind: 'unavailable' }),
          departure: (_dirty, _locked, _current, retire) => {
            retirements.push(retire);
            return null;
          },
        }}
      />,
    );
  try {
    await act(async () => render('original'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => button(host, 'Withdraw ballot').click());
    await act(async () => button(host.querySelector('[role="group"]')!, 'Confirm clear').click());
    expect(intents).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    retirements.at(-1)?.();
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => render('replacement'));
    await act(async () => finish({ kind: 'acknowledged' }));
    expect(host.textContent).not.toContain(m.own_classifications_acknowledged());
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
