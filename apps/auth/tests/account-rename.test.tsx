import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  createRenameAttempt,
  readRenameContinuation,
  saveRenameContinuation,
  runRenameAttempt,
  RENAME_PROFILE,
  type RenameRead,
  type RenameResult,
  type RenameSource,
} from '../src/account-rename';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/account/rename' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
);
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { RenameAccountPage } = await import('../src/routes/account.rename');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');
const target = (accountId = 'account', handle = 'before') => ({
  accountId,
  handle,
  clientId: RENAME_PROFILE.client_id,
  scopes: ['account:update'],
});
const ready = (id = 'account'): RenameRead => ({ kind: 'ready', target: target(id) });
const attempt = (id = 'account') => createRenameAttempt(target(id), 'AFTER')!;
const source = (changes: Partial<RenameSource> = {}): RenameSource => ({
  readCurrent: async () => ready(),
  run: async () => ({ kind: 'denied' }),
  stepUp: async () => false,
  ...changes,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush(action: () => void) {
  await act(async () => {
    action();
  });
}
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  window.sessionStorage.clear();
});
afterAll(async () => {
  for (const [name, value] of previous) {
    if (value) Object.defineProperty(globalThis, name, value);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});
async function mount(initial: RenameSource) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: RenameSource) => flush(() => root.render(<RenameAccountPage source={next} />));
  close = async () => {
    await flush(() => root.unmount());
    host.remove();
  };
  await render(initial);
  return { host, render };
}
const send = (host: HTMLElement) =>
  flush(() => host.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })));
async function submit(host: HTMLElement) {
  await flush(() => host.querySelector<HTMLInputElement>('#rename-confirm')!.click());
  await send(host);
}
for (const phase of ['initial', 'reload', 'renamed', 'conflict', 'step-up', 'handoff'] as const)
  test(`the current source owns ${phase} completion and its stored continuation`, async () => {
    const read = deferred<RenameRead>(),
      run = deferred<RenameResult>(),
      handoff = deferred<boolean>();
    let reads = 0,
      handoffs = 0,
      navigations = 0;
    if (phase !== 'initial' && phase !== 'reload') saveRenameContinuation(attempt());
    const ui = await mount(
      source({
        readCurrent: () =>
          phase === 'initial' || (phase === 'reload' && reads++ > 0)
            ? read.promise
            : Promise.resolve(phase === 'reload' ? { kind: 'unavailable' } : ready()),
        run: () => (phase === 'handoff' ? Promise.resolve({ kind: 'step-up' }) : run.promise),
        stepUp: async (_, owns) => {
          handoffs++;
          await handoff.promise;
          if (owns?.()) navigations++;
          return false;
        },
      }),
    );
    if (phase === 'reload') await flush(() => ui.host.querySelector('button')!.click());
    else if (phase !== 'initial') await submit(ui.host);
    if (phase === 'handoff') await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
    const saved = attempt('replacement');
    saveRenameContinuation(saved);
    await ui.render(source({ readCurrent: async () => ready('replacement') }));
    await flush(() => {
      read.resolve(ready());
      handoff.resolve(false);
      run.resolve(
        phase === 'renamed'
          ? { kind: phase, target: target('account', 'after') }
          : phase === 'conflict'
            ? { kind: phase, current: ready() }
            : { kind: 'step-up' },
      );
    });
    expect(handoffs).toBe(phase === 'handoff' ? 1 : 0);
    expect(navigations).toBe(0);
    expect(readRenameContinuation()).toEqual(saved);
    expect(ui.host.querySelector<HTMLInputElement>('#rename-handle')!.value).toBe('after');
    expect(ui.host.querySelector<HTMLInputElement>('#rename-confirm')!.checked).toBe(false);
    expect(ui.host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
  });
test('an observed matching handle keeps uncertain execution locked until native acknowledgement', async () => {
  const selected = attempt();
  saveRenameContinuation(selected);
  let reads = 0;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1)
      return Response.json({ reference: 'approval', expiresAt: new Date(Date.now() + 60000).toISOString() });
    throw Error('response lost');
  }) as typeof fetch;
  const read = async (): Promise<RenameRead> => ({
    kind: 'ready',
    target: target('account', ++reads < 3 ? 'before' : 'after'),
  });
  const ui = await mount(source({ readCurrent: read, run: (item, owns) => runRenameAttempt(item, read, owns) }));
  await submit(ui.host);
  expect(ui.host.textContent).toContain(m.auth_rename_unknown());
  expect(ui.host.querySelector<HTMLInputElement>('#rename-handle')!.disabled).toBe(true);
  expect(bodies[0]).toEqual({ operationKey: selected.operationKey, operation: selected.operation });
  expect(bodies[1]).toEqual({ ...bodies[0], reference: 'approval' });
  expect(readRenameContinuation()?.operationKey).toBe(selected.operationKey);
  await send(ui.host);
  expect(ui.host.textContent).toContain(m.auth_rename_unknown());
  expect(ui.host.textContent).not.toContain(m.auth_rename_success({ handle: 'after' }));
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).toEqual(bodies[1]);
  expect(readRenameContinuation()?.operationKey).toBe(selected.operationKey);
});
test('departure stops the next browser stage and preserves a newer continuation', async () => {
  const selected = attempt(),
    approval = deferred<Response>();
  let active = true,
    posts = 0;
  globalThis.fetch = (async () => {
    posts++;
    return approval.promise;
  }) as typeof fetch;
  const run = runRenameAttempt(
    selected,
    async () => ready(),
    () => active,
  );
  await Promise.resolve();
  active = false;
  approval.resolve(Response.json({ reference: 'approval', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await run;
  expect(posts).toBe(1);
  expect(selected.submitted).toBe(false);
  selected.submitted = true;
  const saved = attempt('replacement');
  saveRenameContinuation(saved);
  globalThis.fetch = (async (_, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      operationKey: selected.operationKey,
      operation: selected.operation,
      reference: 'approval',
    });
    return Response.json({ accountId: selected.accountId });
  }) as typeof fetch;
  let reads = 0;
  const result = await runRenameAttempt(
    selected,
    async () => ({ kind: 'ready', target: target('account', ++reads === 1 ? 'before' : 'after') }),
    () => active,
  );
  expect(result.kind).toBe('unavailable');
  expect(reads).toBe(0);
  expect(readRenameContinuation()).toEqual(saved);
});
