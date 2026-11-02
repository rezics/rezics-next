import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import { createAppealResolutionIntent } from '../src/moderation/appeal-resolution/intent';

test('An admitted moderator can resolve the intended appeal and recover a lost response; switching appeals or losing admission cannot expose or submit the previous private form.', () => {
  const form = createAppealResolutionIntent('appeal');
  form.synchronize('appeal', 'reviewer-session', true);
  form.edit('  Private review.  ');
  expect(form.needsDecision).toBe(true);
  const command = form.begin('uphold')!;
  expect(command).toMatchObject({ id: 'appeal', outcome: 'uphold', statement: 'Private review.' });
  expect(form.begin('reverse')).toBeNull();
  form.uncertain();
  expect(form.edit('Contrary decision.')).toBe(false);
  expect(form.retry()).toBe(command);
  form.settle({ state: 'resolved', outcome: command.outcome, statement: command.statement });
  expect(form.result).toEqual({ state: 'resolved', outcome: 'uphold', statement: 'Private review.' });
  expect(form.needsDecision).toBe(false);
  form.synchronize('another-appeal', 'reviewer-session', true);
  expect(form.statement).toBe('');
  expect(form.result).toBeNull();
  expect(form.command).toBeNull();
  expect(form.begin('reverse')).toBeNull();

  const pending = createAppealResolutionIntent('appeal');
  pending.synchronize('appeal', 'reviewer-session', true);
  pending.edit('Private reversal.');
  pending.begin('reverse');
  pending.synchronize('appeal', 'reviewer-session', false);
  pending.uncertain();
  pending.settle({ state: 'resolved', outcome: 'reverse', statement: 'Private reversal.' });
  pending.synchronize('appeal', 'reviewer-session', true);
  expect(pending.statement).toBe('');
  expect(pending.result).toBeNull();
  expect(pending.command).toBeNull();
  expect(pending.retry()).toBeNull();
});

test('Session hydration can admit an empty form but cannot adopt an existing private draft', () => {
  const draft = createAppealResolutionIntent('appeal');
  draft.synchronize('appeal', null, true);
  draft.edit('Private fixture draft.');
  draft.synchronize('appeal', 'reviewer-session', true);
  expect(draft.statement).toBe('');
  expect(draft.edit('Restored draft.')).toBe(false);
  expect(draft.begin('uphold')).toBeNull();
  const empty = createAppealResolutionIntent('appeal');
  empty.synchronize('appeal', null, false);
  empty.synchronize('appeal', 'reviewer-session', true);
  expect(empty.needsDecision).toBe(false);
  empty.edit('   ');
  expect(empty.needsDecision).toBe(false);
  expect(empty.edit('New admitted draft.')).toBe(true);
  expect(empty.begin('reverse')?.statement).toBe('New admitted draft.');
});

test('Keyboard resolution focuses only its live admitted result and keeps exact retries local', async () => {
  type Receipt = { state: 'resolved'; outcome: 'uphold'; statement: string };
  type Command = { id: string; outcome: 'uphold' | 'reverse'; statement: string };
  let current = true;
  const session = { state: 'signed-in' as const, subject: 'moderator', csrfToken: 'csrf' };
  const calls: Command[] = [],
    unresolved: boolean[] = [],
    releases: number[] = [],
    pending: ((receipt: Receipt) => void)[] = [];
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('../src/session/query', () => ({ useSession: () => session }));
  mock.module('../src/threads/authoring-departure', () => ({
    AuthoringDepartureBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
    useAuthoringDeparture: () => ({ release: () => releases.push(1) }),
  }));
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/moderation/appeals' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(storybookRequire.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const { AppealResolution } = await import('../src/moderation/appeal-resolution');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const screen = within(host);
  const user = userEvent.setup({ document: window.document });
  const onResolve = (command: Command): Promise<Receipt> => {
    calls.push(command);
    if (calls.length === 1) return Promise.reject(new Error('response lost'));
    return new Promise((resolve) => pending.push(resolve));
  };
  const render = (appealId: string) =>
    act(async () =>
      root.render(
        <AppealResolution
          appealId={appealId}
          mayResolve
          onResolve={onResolve}
          isCurrent={() => current}
          onUnresolvedChange={(value) => unresolved.push(value)}
        />,
      ),
    );
  const keyboard = (label: string) =>
    act(async () => {
      screen.getByRole('button', { name: label }).focus();
      await user.keyboard('{Enter}');
    });
  const fill = (value: string) => act(async () => user.type(screen.getByRole('textbox'), value));
  try {
    const initial = { outcome: 'upheld' as const, statement: 'Already resolved.' };
    await act(async () =>
      root.render(<AppealResolution appealId="initial" mayResolve={false} resolution={initial} />),
    );
    const initialResult = screen.getByRole('status');
    await act(async () => root.render(<AppealResolution appealId="initial" mayResolve={false} resolution={initial} />));
    expect(window.document.activeElement).not.toBe(initialResult);

    await render('retry');
    await fill('Frozen statement.');
    await keyboard(m.moderation_appeal_uphold_action());
    await keyboard(m.moderation_appeal_intent_retry());
    expect(calls[0]).toEqual({ id: 'retry', outcome: 'uphold', statement: 'Frozen statement.' });
    expect(calls[1]).toBe(calls[0]);
    expect(unresolved.slice(0, 4)).toEqual([true, false, true, false]);
    await act(async () => pending[0]!({ state: 'resolved', outcome: 'uphold', statement: 'Frozen statement.' }));
    expect(window.document.activeElement).toBe(screen.getByRole('status'));
    expect(releases).toHaveLength(1);

    await render('moved');
    await fill('Do not steal focus.');
    await keyboard(m.moderation_appeal_uphold_action());
    const elsewhere = window.document.createElement('button');
    window.document.body.append(elsewhere);
    elsewhere.focus();
    await act(async () => pending[1]!({ state: 'resolved', outcome: 'uphold', statement: 'Do not steal focus.' }));
    expect(screen.getByRole('status')).toBeDefined();
    expect(window.document.activeElement).toBe(elsewhere);

    await render('retired');
    await fill('Retired appeal.');
    await keyboard(m.moderation_appeal_uphold_action());
    current = false;
    await render('retired');
    await act(async () => pending[2]!({ state: 'resolved', outcome: 'uphold', statement: 'Retired appeal.' }));
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
    expect(releases).toHaveLength(2);
    elsewhere.remove();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
