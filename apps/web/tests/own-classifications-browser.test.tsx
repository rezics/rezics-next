import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ClassificationsReader } from '../src/ratings/own-classifications/reader';
import type { ClassificationIntent } from '../src/ratings/own-classifications/intent';
import type { OwnClassificationsRead } from '../src/ratings/own-classifications/types';
import { m } from '../src/paraglide/messages.js';
import { accountId, associationId, classificationsPage, subjectId } from './own-classification-assessments-fixture';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/classification-assessments' });
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
