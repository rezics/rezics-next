import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { creationFixture, button, dom } from './creation-page-fixture';
import type { AccountSessionResult } from '../src/account-operations';
import type { TransferAttempt } from '../src/operator-transfer';

creationFixture();
const { createRoot } = await import('react-dom/client');
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { OPERATOR_MANAGEMENT_PROFILE, storeTransferAttempt } = await import('../src/operator-transfer');
const { OPERATOR_TRANSFER_PAGE_PATH } = await import('../src/operator-transfer-page');
const { m } = await import('../src/paraglide/messages.js');
const session: AccountSessionResult = {
  kind: 'ready',
  accountId: 'human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const request = {
  version: 1 as const,
  previous: { operatorAccountId: 'old', subjectAccountId: 'subject', reservationId: 'slot' },
  expectedVersion: '12',
  operatorAccountId: 'destination',
  sourceOperationKey: 'same-operation',
};
const saved: TransferAttempt = {
  accountId: session.accountId,
  request,
  side: 'source',
  acceptance: 'acceptance',
  reference: 'approval',
  phase: 'execute',
};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  window.sessionStorage.clear();
});

test('one deliberate recovery review is bounded to session binding and one selected native read', async () => {
  window.sessionStorage.clear();
  expect(storeTransferAttempt(saved)).toBe(true);
  const calls: { path: string; body?: any }[] = [];
  const sessionBody = { account_id: session.accountId, client_id: session.clientId, scope: session.scopes };
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/session') return Response.json(sessionBody);
    if (path === OPERATOR_TRANSFER_PAGE_PATH) {
      if (body.kind === 'readiness')
        return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
      return Response.json({
        viewer: { kind: 'ready' },
        review: { kind: 'source', relation: { previous: request.previous, expectedVersion: request.expectedVersion }, action: 'allowed' },
      });
    }
    throw new Error(`Unexpected transfer recovery request: ${path}`);
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    root.render(<OperatorTransferPage initial={session} />);
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
  });
  expect(calls.map(({ path }) => path)).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
  const before = calls.length;
  await act(async () => {
    button(host, m.auth_transfer_recovery_review()).click();
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
  });
  expect(calls.slice(before).map(({ path }) => path)).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
  expect(calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
  expect(calls.filter(({ path }) => path === OPERATOR_TRANSFER_PAGE_PATH)).toHaveLength(2);
});
