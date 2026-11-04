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
  type RenameSource,
  type RenameTarget,
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
overwriteGetLocale(() => 'en');
const target: RenameTarget = {
  accountId: '00000000-0000-4000-8000-000000000001',
  handle: null,
  clientId: RENAME_PROFILE.client_id,
  scopes: ['account:update'],
};
const source = (changes: Partial<RenameSource> = {}): RenameSource => ({
  readCurrent: async () => ({ kind: 'ready', target }),
  run: async () => ({ kind: 'denied' }),
  stepUp: async () => false,
  ...changes,
});
async function flush(action: () => void) {
  await act(async () => action());
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
  close = async () => {
    await flush(() => root.unmount());
    host.remove();
  };
  await flush(() => root.render(<RenameAccountPage source={initial} />));
  return host;
}

test('ordinary session gets the exact authentication continuation without profile disclosure', async () => {
  let continued = '';
  const host = await mount(
    source({
      readCurrent: async (): Promise<RenameRead> => ({ kind: 'management-auth-required', accountId: target.accountId }),
      stepUpForReview: async (accountId) => {
        continued = accountId;
        return true;
      },
    }),
  );
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain('Continue with the rename management session');
  expect(host.textContent).not.toContain(target.handle ?? 'private_handle');
  await flush(() => host.querySelector('button')!.click());
  expect(continued).toBe(target.accountId);
  expect(host.querySelector('form')).toBeNull();
});

test('signed-out page offers the existing sign-in path', async () => {
  const host = await mount(source({ readCurrent: async (): Promise<RenameRead> => ({ kind: 'signed-out' }) }));
  expect(host.textContent).toContain('Sign in to rename your own account');
  expect(host.querySelector<HTMLAnchorElement>('a[href="/login"]')).not.toBeNull();
  expect(host.querySelector('form')).toBeNull();
});

test('refusal hides an undisclosed profile', async () => {
  const host = await mount(source({ readCurrent: async (): Promise<RenameRead> => ({ kind: 'refused' }) }));
  expect(host.textContent).toContain('Your current session cannot rename this account');
  expect(host.textContent).not.toContain('private_handle');
  expect(host.querySelector('form')).toBeNull();
});

test('dependency recovery reloads an admitted handleless actor and requires a new confirmation', async () => {
  let reads = 0;
  const host = await mount(
    source({
      readCurrent: async (): Promise<RenameRead> =>
        reads++ === 0
          ? { kind: 'unavailable' }
          : reads === 2
            ? { kind: 'unavailable', target: { ...target, handle: 'private_handle' } }
            : { kind: 'ready', target: { ...target, managementReviewReturned: true } },
    }),
  );
  expect(host.textContent).toContain('We could not read or confirm your current account securely');
  await flush(() => host.querySelector('button')!.click());
  expect(host.textContent).toContain('private_handle');
  await flush(() => host.querySelector('button')!.click());
  expect(host.textContent).toContain(target.accountId);
  expect(host.textContent).toContain('No handle');
  expect(host.textContent).toContain('Returning here did not submit a rename');
  expect(host.querySelector<HTMLInputElement>('#rename-handle')?.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('#rename-confirm')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
});

const { m } = await import('../src/paraglide/messages.js');
const ready = (): RenameRead => ({ kind: 'ready', target: { ...target, handle: 'private_before' } });
async function savedReview(readCurrent = async () => ready()) {
  const selected = createRenameAttempt({ ...target, handle: 'private_before' }, 'private_after')!;
  saveRenameContinuation(selected);
  const host = await mount(
    source({ readCurrent, run: (attempt, owns) => runRenameAttempt(attempt, readCurrent, owns) }),
  );
  await flush(() => host.querySelector<HTMLInputElement>('#rename-confirm')!.click());
  return { host, selected };
}
const send = (host: HTMLElement) =>
  flush(() => host.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })));
function commandReplies(execute: () => Response | Promise<Response>) {
  globalThis.fetch = (async (path) =>
    String(path).endsWith('/approve')
      ? Response.json({ reference: 'private-reference', expiresAt: new Date(Date.now() + 60000).toISOString() })
      : execute()) as typeof fetch;
}

test('a first known refusal is discardable, while refusal after a lost send preserves generic history', async () => {
  let response = 403;
  commandReplies(() => new Response(null, { status: response }));
  const { host, selected } = await savedReview();
  await send(host);
  expect(readRenameContinuation()).toBeNull();
  expect(host.querySelector('[data-rename-history]')).toBeNull();
  await close?.();
  close = undefined;
  response = 503;
  const second = await savedReview();
  await send(second.host);
  const saved = readRenameContinuation();
  response = 403;
  await send(second.host);
  expect(second.host.textContent).toContain(m.auth_rename_unknown());
  expect(second.host.textContent).not.toContain('private_');
  expect(second.host.textContent).not.toContain(target.accountId);
  expect(second.host.querySelector('form')).toBeNull();
  expect(readRenameContinuation()).toEqual(saved);
  expect(saved?.operationKey).not.toBe(selected.operationKey);
});

for (const authority of ['refused', 'signed-out', 'management-auth-required', 'replacement', 'unavailable'] as const)
  test(`unknown history survives current ${authority} advice without private disclosure or a retry command`, async () => {
    let current = ready(),
      reads = 0,
      writes = 0;
    commandReplies(() => {
      writes++;
      return new Response(null, { status: 503 });
    });
    const { host, selected } = await savedReview(async () => {
      reads++;
      return current;
    });
    await send(host);
    current =
      authority === 'replacement'
        ? { kind: 'ready', target: { ...target, accountId: 'replacement', handle: 'other' } }
        : authority === 'management-auth-required'
          ? { kind: authority, accountId: target.accountId }
          : authority === 'refused' || authority === 'unavailable'
            ? { kind: authority, target: { ...target, handle: 'private_before' } }
            : { kind: authority };
    const priorReads = reads;
    await flush(() => host.querySelector<HTMLButtonElement>('button[type=button]:last-child')!.click());
    expect(reads).toBe(priorReads + 1);
    expect(writes).toBe(1);
    expect(host.querySelector('[data-rename-history]')?.textContent).toContain(m.auth_rename_unknown());
    expect(host.textContent).not.toContain('private_');
    expect(host.textContent).not.toContain(target.accountId);
    expect(host.querySelector('form')).toBeNull();
    expect(host.contains(document.activeElement)).toBe(true);
    expect(readRenameContinuation()?.operationKey).toBe(selected.operationKey);
  });

test('an acknowledged command with unavailable readback is distinct and only explicit current review follows', async () => {
  let acknowledged = false,
    writes = 0;
  commandReplies(() => {
    acknowledged = true;
    writes++;
    return Response.json({ accountId: target.accountId });
  });
  const { host } = await savedReview(async () => (acknowledged ? { kind: 'unavailable' } : ready()));
  await send(host);
  expect(host.textContent).toContain(m.auth_rename_acknowledged());
  expect(host.textContent).not.toContain(m.auth_rename_unknown());
  expect(readRenameContinuation()).toBeNull();
  await flush(() => host.querySelector('button')!.click());
  expect(writes).toBe(1);
});

test('cached return hides private DOM, aborts reads and requires released current advice before restoring controls', async () => {
  let reads = 0,
    release!: (read: RenameRead) => void,
    signal: AbortSignal | undefined;
  const selected = createRenameAttempt({ ...target, handle: 'private_before' }, 'private_after')!;
  selected.submitted = true;
  saveRenameContinuation(selected);
  const host = await mount(
    source({
      readCurrent: async (caller) => {
        signal = caller;
        if (++reads === 1) return ready();
        return new Promise<RenameRead>((resolve) => {
          release = resolve;
        });
      },
    }),
  );
  expect(host.textContent).toContain('private_after');
  await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
  expect(signal?.aborted).toBe(true);
  expect(host.textContent).not.toContain('private_');
  const restored = new dom.Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(restored));
  expect(reads).toBe(2);
  expect(host.querySelector('form')).toBeNull();
  await flush(() => {
    release({ kind: 'ready', target: { ...target, accountId: 'replacement' } });
  });
  expect(host.textContent).toContain(m.auth_rename_unknown());
  expect(host.querySelector('form')).toBeNull();
  expect(readRenameContinuation()?.operationKey).toBe(selected.operationKey);
});

test('same-turn read Retry is single-flight and retirement ignores released pending advice', async () => {
  let reads = 0,
    release!: (read: RenameRead) => void;
  const host = await mount(
    source({
      readCurrent: async () =>
        ++reads === 1
          ? { kind: 'unavailable' }
          : new Promise<RenameRead>((resolve) => {
              release = resolve;
            }),
    }),
  );
  const retry = host.querySelector('button')!;
  await flush(() => {
    retry.click();
    retry.click();
  });
  expect(reads).toBe(2);
  expect(host.textContent).toContain(m.auth_inventory_loading());
  await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
  await flush(() => release(ready()));
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).not.toContain('private_before');
});

test('a later conflicting handle preserves unknown work; a replacement draft cannot replace its history', async () => {
  let current = ready();
  commandReplies(() => new Response(null, { status: 503 }));
  const { host, selected } = await savedReview(async () => current);
  await send(host);
  current = { kind: 'ready', target: { ...target, handle: 'concurrent' } };
  await send(host);
  expect(host.textContent).toContain(m.auth_rename_unknown());
  expect(readRenameContinuation()?.operationKey).toBe(selected.operationKey);
  const newer = createRenameAttempt({ ...target, handle: 'concurrent' }, 'newer')!;
  saveRenameContinuation(newer);
  await flush(() => host.querySelector<HTMLButtonElement>('button[type=button]:last-child')!.click());
  expect(host.querySelector('form')).toBeNull();
  expect(readRenameContinuation()).toEqual(newer);
  expect(host.textContent).toContain(m.auth_rename_unknown());
});
