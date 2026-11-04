import { expect, test } from 'bun:test';
import { act } from 'react';
import { creationFixture, button, dom, open } from './creation-page-fixture';
import type { AccountSessionResult } from '../src/account-operations';
import type { TransferAttempt } from '../src/operator-transfer';

creationFixture();
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { storeTransferAttempt, restoreTransferAttempt, OPERATOR_MANAGEMENT_PROFILE } =
  await import('../src/operator-transfer');
const { m } = await import('../src/paraglide/messages.js');
const owner: AccountSessionResult = {
  kind: 'ready',
  accountId: 'private-human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const saved: TransferAttempt = {
  accountId: owner.accountId,
  side: 'source',
  phase: 'readback',
  acceptance: 'private-acceptance',
  reference: 'private-reference',
  request: {
    version: 1,
    previous: {
      subjectAccountId: 'private-subject',
      operatorAccountId: 'private-source',
      reservationId: 'private-slot',
    },
    expectedVersion: '12',
    operatorAccountId: 'private-destination',
    sourceOperationKey: 'private-operation',
  },
};
const relation = {
  previous: {
    ...saved.request.previous,
    operatorAccountId: saved.request.operatorAccountId,
    reservationId: 'next-slot',
  },
  expectedVersion: '13',
};
const reply = (review: object, viewer = 'ready') => Response.json({ viewer: { kind: viewer }, review });
async function settle(action: () => void = () => {}) {
  await act(async () => {
    action();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
async function mount(attempt: TransferAttempt | null = saved) {
  if (attempt) storeTransferAttempt(structuredClone(attempt));
  const page = await open(<OperatorTransferPage initial={owner} />, {
    account_id: owner.accountId,
    client_id: owner.clientId,
    scope: owner.scopes,
  });
  await settle(() => page.calls[0]!.resolve(reply({ kind: 'readiness' })));
  const choose = (label: string) => settle(() => button(page.host, label).click());
  const resolve = (index: number, response: Response) => settle(() => page.calls[index]!.resolve(response));
  return { ...page, choose, resolve };
}
function hide() {
  window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
}
function show() {
  const event = new dom.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event as unknown as Event);
}
function privateHidden(host: HTMLElement) {
  expect(host.querySelector('#transfer-confirm')).toBeNull();
  expect(host.querySelector('#transfer-password')).toBeNull();
  expect(host.innerHTML.replaceAll(owner.accountId, '')).not.toContain('private-');
}
const matching = () => reply({ kind: 'source', relation, action: 'allowed' });

test('matching acknowledgement survives synchronous retirement, failed return reads and useful read-only Retry', async () => {
  const page = await mount();
  await page.choose(m.auth_transfer_recovery_review());
  await page.resolve(1, matching());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_observed());
  expect(page.host.querySelector('#transfer-acknowledgment')).not.toBeNull();
  await settle(() => {
    hide();
    privateHidden(page.host);
    expect(page.host.innerHTML).not.toContain(owner.accountId);
  }); // Assert before React's next scheduled turn.
  expect(document.activeElement).toBe(page.host.querySelector('#transfer-return-heading'));
  await page.choose(m.auth_transfer_recovery_review());
  await page.resolve(2, reply({ kind: 'readiness' }));
  await page.resolve(3, new Response(null, { status: 503 }));
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expect(page.host.textContent).not.toContain(m.auth_transfer_recovery_source_unknown());
  await page.choose(m.auth_transfer_recovery_retry());
  await page.resolve(4, matching());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_observed());
  expect(restoreTransferAttempt()).toEqual(saved);
  expect(page.calls.every(({ path }) => path === '/account-management/operators/transfer-review')).toBe(true);
});

test('an earlier unknown survives later acknowledgement and dismissal never releases its exact continuation', async () => {
  const unknown = { ...saved, phase: 'execute' as const };
  const page = await mount(unknown);
  await page.choose(m.auth_transfer_recovery_review());
  await page.resolve(1, matching()); // Current equality cannot acknowledge the former send.
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  await settle(hide);
  storeTransferAttempt(saved); // A later native acknowledgement is separate evidence.
  await settle(show);
  await page.resolve(2, reply({ kind: 'readiness' }));
  await page.resolve(3, matching());
  const summary = page.host.querySelector('section[aria-labelledby="transfer-return-heading"]')!;
  expect(summary.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(summary.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  await page.choose(m.auth_transfer_return_dismiss());
  expect(page.host.querySelector('#transfer-return-heading')).toBeNull();
  expect(document.activeElement).toBe(page.host.querySelector('#transfer-notice'));
  expect(restoreTransferAttempt()).toEqual(saved);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('late relation completion cannot cross a return generation or overwrite replacement authority', async () => {
  const page = await mount();
  await page.choose(m.auth_transfer_recovery_review()); // Leave this relation request pending.
  await settle(hide);
  await settle(show);
  await page.resolve(2, reply({ kind: 'readiness' }));
  const replacement = {
    ...saved,
    accountId: 'replacement-human',
    request: { ...saved.request, sourceOperationKey: 'replacement-key' },
  };
  storeTransferAttempt(replacement);
  await page.resolve(3, matching());
  await page.resolve(1, matching());
  privateHidden(page.host);
  expect(restoreTransferAttempt()).toEqual(replacement);
  expect(page.host.textContent).not.toContain(m.auth_transfer_recovery_observed());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('known acknowledgement survives missing, invalid and replacement descriptors without private disclosure', async () => {
  const page = await mount();
  for (const storage of [null, '{invalid', JSON.stringify({ ...saved, accountId: 'replacement-human' })]) {
    await settle(hide);
    if (storage === null) window.sessionStorage.removeItem('rezics.operator-transfer.attempt');
    else window.sessionStorage.setItem('rezics.operator-transfer.attempt', storage);
    const before = page.calls.length;
    await settle(show);
    if (page.calls[before]) await page.resolve(before, reply({ kind: 'readiness' }));
    privateHidden(page.host);
    expect(page.host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
    expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')).toBe(storage);
  }
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('retirement invalidates an imported file before caching and a missing unknown descriptor stays locked', async () => {
  const page = await mount(null);
  const pending = Promise.withResolvers<ArrayBuffer>();
  const field = page.host.querySelector<HTMLInputElement>('#transfer-request-file')!;
  const bytes = new TextEncoder().encode(JSON.stringify(saved.request));
  Object.defineProperty(field, 'files', {
    configurable: true,
    value: [{ size: bytes.length, arrayBuffer: () => pending.promise }],
  });
  await settle(() => field.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event));
  await settle(() => {
    hide();
    privateHidden(page.host);
  });
  await settle(() => pending.resolve(bytes.buffer));
  expect(restoreTransferAttempt()).toBeNull();
  privateHidden(page.host);
  storeTransferAttempt({ ...saved, phase: 'execute' });
  await settle(show);
  await page.resolve(1, reply({ kind: 'readiness' }));
  await page.resolve(2, matching());
  await settle(hide);
  window.sessionStorage.clear();
  await settle(show);
  await page.resolve(3, reply({ kind: 'readiness' }));
  expect(page.host.querySelector('#transfer-subject')).toBeNull();
  expect(page.host.querySelector('#transfer-request-file')).toBeNull();
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
});

test('a released source reply after retirement cannot publish acknowledgement, read private state or replay execution', async () => {
  const page = await mount({ ...saved, phase: 'approve', reference: undefined });
  const original = () =>
    reply({
      kind: 'source',
      relation: { previous: saved.request.previous, expectedVersion: saved.request.expectedVersion },
      action: 'allowed',
    });
  await page.resolve(1, original());
  await settle(() => page.host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  await page.choose(m.auth_transfer_submit());
  await page.resolve(2, original());
  await page.resolve(3, Response.json({ reference: 'source-approval', expiresAt: '2030-01-01T00:00:00Z' }));
  expect(page.calls[4]!.path).toBe('/account-operations/execute');
  const submitted = restoreTransferAttempt();
  expect(submitted).toMatchObject({
    phase: 'execute',
    request: saved.request,
    acceptance: saved.acceptance,
    reference: 'source-approval',
  });
  await settle(() => {
    hide();
    privateHidden(page.host);
  });
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  await page.resolve(4, Response.json({ accountId: saved.request.previous.subjectAccountId }));
  privateHidden(page.host);
  expect(page.calls).toHaveLength(5);
  expect(restoreTransferAttempt()).toEqual(submitted);
  expect(page.host.textContent).not.toContain(m.auth_transfer_recovery_acknowledged());
  await settle(show);
  await page.resolve(5, reply({ kind: 'readiness' }));
  await page.resolve(6, matching());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.calls.filter(({ path }) => path === '/account-operations/execute')).toHaveLength(1);
  expect(page.calls.filter(({ path }) => path === '/account-operations/approve')).toHaveLength(1);
});

test('a valid replacement unknown descriptor cannot downgrade an already known acknowledgement', async () => {
  const page = await mount();
  await settle(hide);
  const replacement = {
    ...saved,
    phase: 'execute' as const,
    request: { ...saved.request, sourceOperationKey: 'replacement-key' },
  };
  storeTransferAttempt(replacement);
  await settle(show);
  await page.resolve(1, reply({ kind: 'readiness' }));
  await page.resolve(2, matching());
  const summary = page.host.querySelector('section[aria-labelledby="transfer-return-heading"]')!;
  expect(summary.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expect(summary.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(restoreTransferAttempt()).toEqual(replacement);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});
