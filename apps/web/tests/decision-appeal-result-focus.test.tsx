import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import type { DecisionAppealIntent } from '../src/moderation/command-intent';
import type { AppealSubmission } from '../src/moderation/appeal';
import { openDecision, pendingDecision, decisionNow } from '../src/stories/patterns/moderation-decision/fixtures';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('keyboard retry preserves exact intent and credentials, focuses current pending readback, and fences replacement callbacks', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/moderation/decisions/one' });
  const globals: Record<string, unknown> = { window, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLTextAreaElement HTMLFormElement Element Node MutationObserver ResizeObserver Document DocumentFragment'.split(
    ' ',
  ))
    globals[key] = Reflect.get(window, key);
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { DecisionPageView } = await import('../src/moderation/decision-page');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const commands: DecisionAppealIntent[] = [];
  let finish!: (result: AppealSubmission) => void;
  const send = async (command: DecisionAppealIntent): Promise<AppealSubmission> => {
    commands.push(command);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const refresh = async () => openDecision;
  const paint = (page = openDecision) =>
    act(async () =>
      root.render(createElement(DecisionPageView, { page, now: decisionNow, onAppeal: send, onRefresh: refresh })),
    );
  const button = (name: string) => within(host).getByRole('button', { name }) as HTMLButtonElement;
  const press = (name: string) =>
    act(async () => {
      button(name).focus();
      await user.keyboard('{Enter}');
    });
  const pending: AppealSubmission = {
    state: 'acknowledged',
    readback: {
      state: 'available',
      decision: pendingDecision.decision,
      nativeSourceFingerprint: openDecision.nativeSourceFingerprint,
    },
  };
  try {
    await paint();
    await act(async () => user.type(within(host).getByRole('textbox'), 'Keep this exact statement.'));
    await press(m.decision_appeal_submit());
    await act(async () => finish({ state: 'failed' }));
    expect(host.textContent).toContain(m.decision_appeal_uncertain());
    await act(async () => user.click(button(m.decision_refresh())));
    expect(host.textContent).toContain(m.decision_appeal_uncertain());
    await press(m.decision_retry_same());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(commands[1]?.statement).toBe('Keep this exact statement.');
    expect(commands[1]?.credentials).toBe(commands[0]?.credentials);
    await act(async () => finish(pending));
    expect(host.textContent).toContain(m.decision_appeal_acknowledged());
    expect(window.document.activeElement?.textContent).toContain(m.decision_appeal_pending());
    expect(host.querySelector('textarea')).toBeNull();

    // A different native observation starts an empty visit; the old pending callback cannot populate it.
    await paint({ ...openDecision, nativeSourceFingerprint: 'fresh-source' });
    await act(async () => user.type(within(host).getByRole('textbox'), 'Private obsolete draft'));
    await press(m.decision_appeal_submit());
    await paint({ ...openDecision, nativeSourceFingerprint: 'replacement-source' });
    await act(async () => finish(pending));
    expect(host.textContent).not.toContain('Private obsolete draft');
    expect(host.textContent).not.toContain(m.decision_appeal_acknowledged());
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(window.document.activeElement?.textContent).not.toContain(m.decision_appeal_pending());
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
