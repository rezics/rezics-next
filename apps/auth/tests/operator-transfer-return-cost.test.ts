import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { creationFixture, button, dom } from './creation-page-fixture';
creationFixture();
const { createRoot } = await import('react-dom/client');
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { storeTransferAttempt, OPERATOR_MANAGEMENT_PROFILE } = await import('../src/operator-transfer');
const { m } = await import('../src/paraglide/messages.js');

test('retired Retry charges fresh session, readiness and one selected read, with zero native commands', async () => {
  const request = { version: 1 as const, previous: { subjectAccountId: 'subject', operatorAccountId: 'source', reservationId: 'slot' }, expectedVersion: '1', operatorAccountId: 'destination', sourceOperationKey: 'original-key' };
  storeTransferAttempt({ accountId: 'human', side: 'source', phase: 'readback', request, reference: 'reference', acceptance: 'acceptance' });
  const calls: { path: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const path = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/session') return Response.json({ account_id: 'human', client_id: OPERATOR_MANAGEMENT_PROFILE.client_id, scope: ['account:manage'] });
    if (path === '/account-management/operators/transfer-review') return Response.json({ viewer: { kind: 'ready' }, review: body.kind === 'readiness' ? { kind: 'readiness' } : { kind: 'source', relation: { previous: request.previous, expectedVersion: '1' }, action: 'allowed' } });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div')); const root = createRoot(host);
  const settle = (action: () => void) => act(async () => { action(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  try {
    await settle(() => root.render(createElement(OperatorTransferPage)));
    expect(calls.map(({ path }) => path)).toEqual(['/session', '/session', '/account-management/operators/transfer-review']);
    await settle(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
    calls.length = 0;
    await settle(() => { const review = button(host, m.auth_transfer_recovery_review()); review.click(); review.click(); });
    expect(calls.map(({ path }) => path)).toEqual(['/session', '/session', '/account-management/operators/transfer-review', '/session', '/account-management/operators/transfer-review']);
    expect(calls.filter(({ body }) => body?.kind === 'source').map(({ body }) => body)).toEqual([{ kind: 'source', subjectAccountId: 'subject' }]);
    expect(host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
    expect(host.textContent).not.toContain(m.auth_transfer_recovery_source_unknown());
  } finally {
    await settle(() => root.unmount()); host.remove(); globalThis.fetch = original;
  }
});
