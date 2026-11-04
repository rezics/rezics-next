import { expect, test } from 'bun:test';
import { act } from 'react';
import { creationFixture, button, fill, open } from './creation-page-fixture';
import type { AccountSessionResult } from '../src/account-operations';
import type { OperatorRelation, TransferAttempt } from '../src/operator-transfer';

creationFixture();
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { OPERATOR_MANAGEMENT_PROFILE, restoreTransferAttempt, storeTransferAttempt } =
  await import('../src/operator-transfer');
const { OPERATOR_TRANSFER_PAGE_PATH } = await import('../src/operator-transfer-page');
const { m } = await import('../src/paraglide/messages.js');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const session: AccountSessionResult = {
  kind: 'ready',
  accountId: 'human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const sessionBody = { account_id: session.accountId, client_id: session.clientId, scope: session.scopes };
const request = {
  version: 1 as const,
  previous: { subjectAccountId: 'private-subject', operatorAccountId: 'private-source', reservationId: 'old-slot' },
  expectedVersion: '12',
  operatorAccountId: 'private-destination',
  sourceOperationKey: 'private-operation-key',
};
const unknown: TransferAttempt = {
  accountId: session.accountId,
  request,
  side: 'source',
  acceptance: 'private-acceptance',
  reference: 'private-approval',
  phase: 'execute',
};
const acknowledged: TransferAttempt = { ...unknown, phase: 'readback' };
const destinationAccepted: TransferAttempt = {
  accountId: session.accountId,
  request,
  side: 'destination',
  reference: 'private-destination-acceptance',
  phase: 'accepted',
};
const oldRelation: OperatorRelation = { previous: request.previous, expectedVersion: request.expectedVersion };
const transferredRelation: OperatorRelation = {
  previous: { ...request.previous, operatorAccountId: request.operatorAccountId, reservationId: 'new-slot' },
  expectedVersion: '13',
};
async function settle(action: () => void = () => {}) {
  await act(async () => {
    action();
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
  });
}
function response(review: object, viewer: string = 'ready') {
  return Response.json({
    viewer: {
      kind: viewer,
      ...(viewer === 'authentication-required' ? { continuation: 'operator-transfer' } : {}),
    },
    review,
  });
}
async function mount(attempt: TransferAttempt, viewer: string = 'ready', owner: AccountSessionResult = session) {
  window.sessionStorage.clear();
  expect(storeTransferAttempt(structuredClone(attempt))).toBe(true);
  const page = await open(<OperatorTransferPage initial={owner} />, {
    ...sessionBody,
    account_id: owner.kind === 'ready' ? owner.accountId : session.accountId,
  });
  await settle();
  if (page.calls[0]) await settle(() => page.calls[0]!.resolve(response({ kind: 'readiness' }, viewer)));
  return page;
}
function privateValues() {
  return [
    request.previous.subjectAccountId,
    request.previous.operatorAccountId,
    request.operatorAccountId,
    request.sourceOperationKey,
    unknown.acceptance!,
    unknown.reference!,
  ];
}
function expectPrivateTransferHidden(host: HTMLElement) {
  for (const value of privateValues()) expect(host.textContent).not.toContain(value);
  expect(host.querySelector('#transfer-confirm')).toBeNull();
}

test('readiness refusal keeps generic uncertainty, the exact descriptor and no replacement-viewer data', async () => {
  const page = await mount(unknown, 'refused');
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_authority());
  expect(page.host.querySelector('a[href="/security"]')).not.toBeNull();
  expectPrivateTransferHidden(page.host);
  expect(restoreTransferAttempt()).toEqual(unknown);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('signed-out restoration keeps the generic unresolved state and exact descriptor', async () => {
  const page = await mount(unknown, 'signed-out');
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_authority());
  expectPrivateTransferHidden(page.host);
  expect(restoreTransferAttempt()).toEqual(unknown);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('a replacement account cannot inherit the saved transfer identity or release its descriptor', async () => {
  const replacement: AccountSessionResult = { ...session, accountId: 'replacement-viewer' };
  const page = await mount(unknown, 'ready', replacement);
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_authority());
  expectPrivateTransferHidden(page.host);
  expect(restoreTransferAttempt()).toEqual(unknown);
  expect(page.calls).toHaveLength(0);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('current relation recovery stays unknown and an explicit exact retry preserves its original command identity', async () => {
  const page = await mount(unknown);
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expectPrivateTransferHidden(page.host);
  await settle(() => button(page.host, m.auth_transfer_recovery_review()).click());
  expect(page.calls[1]?.path).toBe(OPERATOR_TRANSFER_PAGE_PATH);
  await settle(() => page.calls[1]!.resolve(response({ kind: 'source', relation: oldRelation, action: 'allowed' })));
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_observed());
  expect(page.host.textContent).not.toContain(m.auth_transfer_observed());
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);

  await settle(() => page.host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  await settle(() => button(page.host, m.auth_transfer_recovery_retry_exact()).click());
  const execute = page.calls.find(({ path }) => path === '/account-operations/execute');
  expect(execute?.body).toMatchObject({ operationKey: request.sourceOperationKey, reference: unknown.reference });
  await settle(() => execute!.resolve(Response.json({ accountId: request.previous.subjectAccountId })));
  const readback = page.calls.filter(({ path }) => path === OPERATOR_TRANSFER_PAGE_PATH).at(-1)!;
  expect(readback.body).toEqual({ kind: 'source', subjectAccountId: request.previous.subjectAccountId });
  await settle(() => readback.resolve(response({ kind: 'source', relation: transferredRelation, action: 'allowed' })));
  expect(restoreTransferAttempt()).toMatchObject({
    request: { sourceOperationKey: request.sourceOperationKey },
    reference: unknown.reference,
    acceptance: unknown.acceptance,
    phase: 'readback',
  });
  expect(page.calls.filter(({ path }) => path === '/account-operations/approve')).toHaveLength(0);
  expect(page.calls.filter(({ path }) => path === '/account-operations/execute')).toHaveLength(1);
});

test('acknowledged source recovery keeps the acknowledgement when current readback is unavailable', async () => {
  const page = await mount(acknowledged);
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expectPrivateTransferHidden(page.host);
  await settle(() => button(page.host, m.auth_transfer_recovery_review()).click());
  await settle(() => page.calls[1]!.resolve(new Response(null, { status: 503 })));
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_unavailable());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_retry());
  expectPrivateTransferHidden(page.host);
  expect(restoreTransferAttempt()).toEqual(acknowledged);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('a refused current read retires authority without settling or releasing the unknown descriptor', async () => {
  const page = await mount(unknown);
  await settle(() => button(page.host, m.auth_transfer_recovery_review()).click());
  await settle(() => page.calls[1]!.resolve(response({ kind: 'refused' }, 'refused')));
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_authority());
  expectPrivateTransferHidden(page.host);
  expect(restoreTransferAttempt()).toEqual(unknown);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('destination acceptance recovery reads only destination advice and never implies source execution', async () => {
  const page = await mount(destinationAccepted);
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_destination());
  expectPrivateTransferHidden(page.host);
  await settle(() => button(page.host, m.auth_transfer_recovery_review()).click());
  const advice = page.calls[1]!;
  expect(advice.path).toBe(OPERATOR_TRANSFER_PAGE_PATH);
  expect(advice.body).toEqual({ kind: 'destination', request });
  await settle(() =>
    advice.resolve(
      response({ kind: 'destination', destinationAccountId: request.operatorAccountId, action: 'allowed' }),
    ),
  );
  expect(page.host.textContent).toContain(m.auth_transfer_accepted());
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_destination());
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('step-up restoration does not disclose or unlock the saved source command before explicit review', async () => {
  const page = await mount(unknown, 'authentication-required');
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expectPrivateTransferHidden(page.host);
  await settle(() => {
    fill(page.host.querySelector<HTMLInputElement>('#transfer-email')!, 'operator@example.test');
    fill(page.host.querySelector<HTMLInputElement>('#transfer-password')!, 'password-value');
    page.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const signIn = page.calls.find(({ path }) => path === '/signin')!;
  await settle(() => signIn.resolve(Response.json({ account_id: session.accountId })));
  const refreshedReadiness = page.calls.filter(({ path }) => path === OPERATOR_TRANSFER_PAGE_PATH).at(-1)!;
  await settle(() => refreshedReadiness.resolve(response({ kind: 'readiness' })));
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
  expectPrivateTransferHidden(page.host);
  expect(page.host.querySelector('form[action="/account-operations/approve"]')).toBeNull();
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('same-turn reviews are excluded and a late read cannot replace newer stored work', async () => {
  const page = await mount(unknown);
  const review = button(page.host, m.auth_transfer_recovery_review())!;
  await settle(() => {
    review.click();
    review.click();
  });
  expect(page.calls.filter(({ path }) => path === OPERATOR_TRANSFER_PAGE_PATH)).toHaveLength(2);
  expect(page.host.textContent).toContain(m.auth_transfer_recovery_pending());
  const replacement: TransferAttempt = {
    ...unknown,
    request: { ...unknown.request, sourceOperationKey: 'replacement-operation' },
  };
  expect(storeTransferAttempt(replacement)).toBe(true);
  await settle(() => page.calls[1]!.resolve(response({ kind: 'source', relation: oldRelation, action: 'allowed' })));
  expect(restoreTransferAttempt()).toEqual(replacement);
  expect(page.host.textContent).not.toContain(m.auth_transfer_recovery_observed());
  expectPrivateTransferHidden(page.host);
  expect(page.calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
});

test('recovery presentation messages are present in every supported locale', () => {
  const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
  const messages = [
    m.auth_transfer_recovery_heading,
    m.auth_transfer_recovery_source_unknown,
    m.auth_transfer_recovery_acknowledged,
    m.auth_transfer_recovery_destination,
    m.auth_transfer_recovery_authority,
    m.auth_transfer_recovery_pending,
    m.auth_transfer_recovery_unavailable,
    m.auth_transfer_recovery_observed,
    m.auth_transfer_recovery_review,
    m.auth_transfer_recovery_retry,
    m.auth_transfer_recovery_return,
  ];
  try {
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      for (const message of messages) expect(message()).not.toBe('');
    }
  } finally {
    overwriteGetLocale(() => 'en');
  }
});
