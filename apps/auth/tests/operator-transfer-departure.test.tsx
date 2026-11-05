import { expect, test } from 'bun:test';
import { act } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, button, dom, fill, open } from './creation-page-fixture';
import { OperatorTransferPage } from '../src/routes/operators.transfer';
import {
  OPERATOR_MANAGEMENT_PROFILE,
  restoreTransferAttempt,
  storeTransferAttempt,
  type TransferAttempt,
} from '../src/operator-transfer';
creationFixture();
const { m } = await import('../src/paraglide/messages.js');
async function flush(action: () => void) {
  await act(async () => {
    action();
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  });
}
const initial = {
  kind: 'ready',
  accountId: 'human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
} as const;
const session = { account_id: initial.accountId, client_id: initial.clientId, scope: [...initial.scopes] };
const source: TransferAttempt = {
  accountId: 'human',
  side: 'source',
  phase: 'approve',
  request: {
    version: 1,
    previous: { operatorAccountId: 'old', subjectAccountId: 'subject', reservationId: 'reservation' },
    expectedVersion: '12',
    operatorAccountId: 'new',
    sourceOperationKey: 'original-key',
  },
};
async function setup(saved?: TransferAttempt) {
  if (saved) storeTransferAttempt(structuredClone(saved));
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/operators/transfer'] }),
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/operators/transfer' }),
      createRoute({ getParentRoute: () => root, path: '/security' }),
    ]),
  });
  const view = () => (
    <RouterContextProvider router={router}>
      <OperatorTransferPage initial={{ ...initial, scopes: [...initial.scopes] }} />
    </RouterContextProvider>
  );
  const page = await open(view(), session);
  const queuedFetch = globalThis.fetch;
  await flush(() => {});
  await flush(() =>
    page.calls[0]!.resolve(Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } })),
  );
  if (saved?.phase === 'approve') {
    await flush(() =>
      page.calls[1]!.resolve(
        saved.side === 'source'
          ? Response.json({
              viewer: { kind: 'ready' },
              review: {
                kind: 'source',
                relation: { previous: saved.request.previous, expectedVersion: saved.request.expectedVersion },
                action: 'allowed',
              },
            })
          : Response.json({
              viewer: { kind: 'ready' },
              review: { kind: 'destination', destinationAccountId: saved.request.operatorAccountId, action: 'allowed' },
            }),
      ),
    );
  }
  page.calls.splice(0);
  globalThis.fetch = ((input, init) => {
    const path = String(input);
    if (path === '/session') return Promise.resolve(Response.json(session));
    if (path === '/account-management/operators/transfer-review') {
      const body = JSON.parse(String(init?.body));
      if (body.kind === 'readiness')
        return Promise.resolve(Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } }));
    }
    return queuedFetch(input, init);
  }) as typeof fetch;
  const choose = (label: string) => flush(() => button(page.host, label)!.click());
  const navigate = () =>
    flush(() => {
      void router.navigate({ to: '/security' });
    });
  const input = (id: string) => page.host.querySelector<HTMLInputElement>(`#transfer-${id}`)!;
  const edit = (id: string, value: string) =>
    flush(() => {
      const field = input(id);
      if (field instanceof dom.HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
      } else fill(field, value);
    });
  const submit = (id: string) =>
    flush(() =>
      input(id)
        .closest('form')!
        .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
    );
  const importText = (kind: string, text: string) =>
    flush(() => {
      const field = input(`${kind}-file`);
      const bytes = new TextEncoder().encode(text);
      Object.defineProperty(field, 'files', {
        configurable: true,
        value: [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }],
      });
      field.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
    });
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  return { ...page, router, view, choose, navigate, input, edit, submit, importText, unload };
}
test('changed draft and validation survive Stay with usable focus; deliberate Leave discards unsent input', async () => {
  const page = await setup();
  page.input('subject').focus();
  expect(page.unload()).toBe(false);
  await page.edit('subject', 'subject');
  await page.edit('destination', 'new');
  await page.edit('request-input', '  invalid request\n');
  await page.submit('request-input');
  const error = page.host.querySelector('[role="alert"]')!.textContent;
  page.input('request-input').focus();
  await page.navigate();
  await page.choose('Stay');
  expect(page.input('request-input').value).toBe('  invalid request\n');
  expect(page.input('subject').value).toBe('subject');
  expect(page.input('destination').value).toBe('new');
  expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(error);
  expect(document.activeElement).toBe(page.input('request-input'));
  await page.edit('destination', 'replacement');
  expect(page.input('destination').value).toBe('replacement');
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/security');
  expect(page.unload()).toBe(false);
  expect(page.input('request-input')).toBeNull();
});
test('imported request and exact reviewed transfer survive Stay; Leave discards only the unsent review', async () => {
  const page = await setup();
  const text = `\n${JSON.stringify(source.request, null, 2)}\n`;
  await page.importText('request', text);
  await page.navigate();
  await page.choose('Stay');
  expect(page.input('request-input').value).toBe(text);
  await page.submit('request-input');
  await flush(() =>
    page.calls[0]!.resolve(
      Response.json({
        viewer: { kind: 'ready' },
        review: { kind: 'destination', destinationAccountId: source.request.operatorAccountId, action: 'allowed' },
      }),
    ),
  );
  const attempt = restoreTransferAttempt();
  await flush(() => page.input('confirm').click());
  await page.navigate();
  await page.choose('Stay');
  expect(restoreTransferAttempt()).toEqual(attempt);
  expect(page.input('confirm').checked).toBe(false);
  expect(button(page.host, m.auth_transfer_native_review())).not.toBeNull();
  await page.navigate();
  await page.choose('Leave');
  expect(restoreTransferAttempt()).toBeNull();
});
for (const stage of ['relation', 'approval'])
  test(`acceptance and unresolved ${stage} survive Stay; Leave preserves recovery and retires later stages`, async () => {
    const page = await setup(source);
    await page.importText('acceptance', 'opaque-acceptance');
    if (stage === 'approval') {
      await page.choose(m.auth_transfer_review_same_person());
      await flush(() =>
        page.calls[0]!.resolve(
          Response.json({
            viewer: { kind: 'ready' },
            review: {
              kind: 'source',
              relation: { previous: source.request.previous, expectedVersion: '12' },
              action: 'allowed',
            },
          }),
        ),
      );
      await flush(() => page.input('confirm').click());
      await page.submit('confirm');
      await flush(() =>
        page.calls[1]!.resolve(
          Response.json({
            viewer: { kind: 'ready' },
            review: {
              kind: 'source',
              relation: { previous: source.request.previous, expectedVersion: '12' },
              action: 'allowed',
            },
          }),
        ),
      );
    } else {
      await page.choose(m.auth_transfer_review_same_person());
    }
    await page.navigate();
    await page.choose('Stay');
    expect(page.input('acceptance').value).toBe('opaque-acceptance');
    const original = restoreTransferAttempt();
    await page.navigate();
    await page.choose('Stay');
    expect(restoreTransferAttempt()).toEqual(original);
    await page.navigate();
    await page.choose('Leave');
    expect(restoreTransferAttempt()).toEqual(original);
    expect(page.calls.some(({ path }) => path.endsWith('/execute'))).toBe(false);
    if (stage === 'approval') {
      expect(original).toMatchObject({
        request: { sourceOperationKey: source.request.sourceOperationKey },
        acceptance: 'opaque-acceptance',
      });
      expect(page.calls.some(({ path }) => path.endsWith('/account-operations/approve'))).toBe(true);
    } else {
      expect(original).toEqual(source);
      expect(page.calls.some(({ path }) => path.includes('/account-operations/'))).toBe(false);
    }
  });
test('reconciled results leave normally and permission loss revokes a draft without prompting', async () => {
  const page = await setup({ ...source, phase: 'readback', reference: 'approval', acceptance: 'acceptance' });
  await page.choose(m.auth_transfer_recovery_review());
  await flush(() =>
    page.calls[0]!.resolve(
      Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          action: 'allowed',
          relation: {
            previous: { ...source.request.previous, operatorAccountId: 'new', reservationId: 'next' },
            expectedVersion: '13',
          },
        },
      }),
    ),
  );
  expect(page.unload()).toBe(false);
  await page.navigate();
  expect(page.router.history.location.pathname).toBe('/security');
  window.sessionStorage.clear();
  await page.render(page.view());
  await page.edit('subject', 'subject');
  globalThis.fetch = ((input, init) => {
    if (String(input) === '/session') return Promise.resolve(Response.json({ ...session, scope: [] }));
    if (String(input) === '/account-management/operators/transfer-review') {
      const body = JSON.parse(String(init?.body));
      if (body.kind === 'readiness')
        return Promise.resolve(Response.json({ viewer: { kind: 'refused' }, review: { kind: 'readiness' } }));
    }
    throw new Error(`Unexpected permission-loss read: ${input}`);
  }) as typeof fetch;
  await page.navigate();
  expect(page.host.querySelector('dialog')).toBeNull();
  expect(page.unload()).toBe(false);
});

test('authority loss keeps the unresolved departure choice and focuses the notice after Stay', async () => {
  const saved: TransferAttempt = {
    ...source,
    acceptance: 'private-acceptance',
    reference: 'private-reference',
    phase: 'execute',
  };
  const page = await setup(saved);
  const recovery = button(page.host, m.auth_transfer_recovery_review());
  expect(recovery).not.toBeNull();
  recovery!.focus();
  let refused = false;
  globalThis.fetch = ((input) => {
    if (String(input) === '/session') return Promise.resolve(Response.json(session));
    if (String(input) === '/account-management/operators/transfer-review')
      return Promise.resolve(
        Response.json({
          viewer: { kind: refused ? 'refused' : 'ready' },
          review: { kind: 'readiness' },
        }),
      );
    throw new Error(`Unexpected authority-retirement read: ${input}`);
  }) as typeof fetch;
  refused = true;
  await page.navigate();
  expect(page.host.querySelector('dialog')).not.toBeNull();
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.host.textContent).not.toContain(saved.request.previous.subjectAccountId);
  expect(page.host.textContent).not.toContain(saved.request.previous.operatorAccountId);
  expect(page.host.textContent).not.toContain(saved.request.operatorAccountId);
  expect(page.host.textContent).not.toContain(saved.reference);
  expect(restoreTransferAttempt()).toEqual(saved);
  await page.choose('Stay');
  expect(document.activeElement).toBe(page.host.querySelector('#transfer-notice'));
  expect(page.router.history.location.pathname).toBe('/operators/transfer');
  expect(restoreTransferAttempt()).toEqual(saved);
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/security');
  expect(restoreTransferAttempt()).toEqual(saved);
});

test('late handoff-file completion after authority replacement cannot restore its private request', async () => {
  const page = await setup();
  const bytes = new TextEncoder().encode(JSON.stringify(source.request));
  let resolveRead!: (value: ArrayBuffer) => void;
  const read = new Promise<ArrayBuffer>((resolve) => {
    resolveRead = resolve;
  });
  const field = page.input('request-file');
  Object.defineProperty(field, 'files', {
    configurable: true,
    value: [{ size: bytes.length, arrayBuffer: () => read }],
  });
  field.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
  globalThis.fetch = ((input) => {
    if (String(input) === '/session') return Promise.resolve(Response.json({ ...session, account_id: 'replacement' }));
    throw new Error(`Unexpected replacement-viewer read: ${input}`);
  }) as typeof fetch;
  await flush(() => window.dispatchEvent(new dom.Event('focus') as unknown as Event));
  resolveRead(bytes.buffer);
  await flush(() => {});
  expect(field.value).toBe('');
  expect(page.host.textContent).not.toContain(source.request.previous.subjectAccountId);
  expect(page.host.textContent).not.toContain(source.request.operatorAccountId);
  expect(page.host.textContent).not.toContain(source.request.sourceOperationKey);
  expect(restoreTransferAttempt()).toBeNull();
});
