import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { creationFixture, dom, flush, button } from './creation-page-fixture';
import type { AccountSessionResult } from '../src/account-operations';
import type { TransferAttempt } from '../src/operator-transfer';

creationFixture();
const { createRoot } = await import('react-dom/client');
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { OPERATOR_MANAGEMENT_PROFILE, restoreTransferAttempt, storeTransferAttempt } =
  await import('../src/operator-transfer');
const { OPERATOR_TRANSFER_PAGE_PATH } = await import('../src/operator-transfer-page');
const { m } = await import('../src/paraglide/messages.js');
const session: AccountSessionResult = {
  kind: 'ready',
  accountId: 'acting-human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const sessionBody = { account_id: session.accountId, client_id: session.clientId, scope: session.scopes };
function fill(field: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new dom.Event('input', { bubbles: true }));
}
const request = {
  version: 1 as const,
  previous: { subjectAccountId: 'managed-subject', operatorAccountId: 'current-source', reservationId: 'old-slot' },
  expectedVersion: '12',
  operatorAccountId: 'proposed-destination',
  sourceOperationKey: 'original-source-operation',
};
function saved(side: 'source' | 'destination' = 'source'): TransferAttempt {
  return {
    accountId: session.accountId,
    request,
    side,
    phase: 'approve',
    ...(side === 'source' ? { acceptance: 'original-acceptance' } : {}),
  };
}
let mounted: (() => Promise<void>) | undefined;
afterEach(async () => {
  await mounted?.();
  mounted = undefined;
  window.sessionStorage.clear();
});

async function mount(options: { attempt?: TransferAttempt; finalDenied?: boolean; loseExecute?: boolean } = {}) {
  window.sessionStorage.clear();
  if (options.attempt) expect(storeTransferAttempt(structuredClone(options.attempt))).toBe(true);
  const calls: { path: string; body?: any }[] = [];
  let sourceReads = 0;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/session') return Response.json(sessionBody);
    if (path === OPERATOR_TRANSFER_PAGE_PATH) {
      if (body.kind === 'readiness') return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
      if (body.kind === 'destination')
        return Response.json({
          viewer: { kind: 'ready' },
          review: { kind: 'destination', destinationAccountId: request.operatorAccountId, action: 'allowed' },
        });
      sourceReads++;
      if (options.finalDenied && sourceReads >= 3)
        return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'refused' } });
      return Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          relation: { previous: request.previous, expectedVersion: request.expectedVersion },
          action: 'allowed',
        },
      });
    }
    if (path === '/account-operations/approve')
      return Response.json({
        reference: 'original-native-acceptance',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (path === '/account-operations/execute') {
      if (options.loseExecute) throw new TypeError('simulated lost response');
      return Response.json({ accountId: request.previous.subjectAccountId });
    }
    throw new Error(`Unexpected write or read: ${path}`);
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  mounted = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    root.render(<OperatorTransferPage initial={session} />);
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  });
  return { host, calls };
}
async function submitForm(host: HTMLElement, selector: string) {
  const field = host.querySelector<HTMLElement>(selector)!;
  await flush(() =>
    field
      .closest('form')!
      .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
  );
}

test('destination review labels imported data, holds the acting account, and waits for its own confirmation', async () => {
  const { host, calls } = await mount();
  const field = host.querySelector<HTMLTextAreaElement>('#transfer-request-input')!;
  fill(field, JSON.stringify({ ...request, accountId: 'attacker' }));
  await submitForm(host, '#transfer-request-input');
  expect(calls.some(({ path, body }) => path === OPERATOR_TRANSFER_PAGE_PATH && body?.kind === 'destination')).toBe(
    false,
  );

  fill(field, JSON.stringify(request));
  await submitForm(host, '#transfer-request-input');
  expect(host.textContent).toContain(m.auth_transfer_acting_as({ account: session.accountId }));
  expect(host.textContent).toContain(m.auth_transfer_imported_request_provenance());
  expect(host.textContent).toContain(m.auth_transfer_native_advice_destination());
  expect(calls.some(({ path }) => path === '/account-operations/approve')).toBe(false);
  await flush(() => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  expect(calls.some(({ path }) => path === '/account-operations/approve')).toBe(false);
  await flush(() => button(host, m.auth_transfer_accept()).click());
  expect(host.textContent).toContain(m.auth_transfer_accepted());
  expect(calls.filter(({ path }) => path === '/account-operations/approve')).toHaveLength(1);
  expect(calls.some(({ path }) => path === '/account-operations/execute')).toBe(false);
  expect(
    calls.filter(({ path, body }) => path === OPERATOR_TRANSFER_PAGE_PATH && body?.kind === 'destination'),
  ).toHaveLength(2);
});

test('source requires separate confirmation and keeps an acknowledged transfer separate from a denied current read', async () => {
  const { host, calls } = await mount({ attempt: saved(), finalDenied: true });
  expect(host.querySelector<HTMLInputElement>('#transfer-confirm')?.checked).toBe(false);
  expect(calls.some(({ path }) => path === '/account-operations/approve')).toBe(false);
  await flush(() => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  expect(calls.some(({ path }) => path === '/account-operations/approve')).toBe(false);
  await flush(() => button(host, m.auth_transfer_submit()).click());
  expect(host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expect(host.querySelector('#transfer-acknowledgment')).toBeNull();
  expect(host.querySelector('#transfer-confirm')).toBeNull();
  expect(host.textContent).not.toContain(m.auth_transfer_observed());
  const stored = restoreTransferAttempt();
  expect(stored).toMatchObject({
    request: { sourceOperationKey: request.sourceOperationKey },
    acceptance: 'original-acceptance',
    reference: 'original-native-acceptance',
    phase: 'readback',
  });
  expect(calls.filter(({ path }) => path === '/account-operations/approve')).toHaveLength(1);
  expect(calls.filter(({ path }) => path === '/account-operations/execute')).toHaveLength(1);
});

test('uncertain execution retains its exact descriptor and read retry performs no mutation', async () => {
  const { host, calls } = await mount({ attempt: saved(), loseExecute: true });
  await flush(() => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  await flush(() => button(host, m.auth_transfer_submit()).click());
  expect(host.textContent).toContain(m.auth_transfer_uncertain());
  expect(restoreTransferAttempt()).toMatchObject({
    request: { sourceOperationKey: request.sourceOperationKey, expectedVersion: request.expectedVersion },
    acceptance: 'original-acceptance',
    reference: 'original-native-acceptance',
    phase: 'execute',
  });
  const commandCount = calls.filter(({ path }) => path.startsWith('/account-operations/')).length;
  await flush(() => button(host, m.auth_transfer_recovery_review()).click());
  expect(calls.filter(({ path }) => path.startsWith('/account-operations/')).length).toBe(commandCount);
  expect(host.textContent).toContain(m.auth_transfer_uncertain());
});
