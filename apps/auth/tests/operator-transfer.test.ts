import { expect, spyOn, test } from 'bun:test';
import type { OperatorRelation, TransferAttempt, TransferRequest, TransferResult } from '../src/operator-transfer';
import { restoreTransferAttempt, storeTransferAttempt } from '../src/operator-transfer';
import { confirmsTransferReadback, retainsTransferWork, transferRecoveryKind } from '../src/operator-transfer-recovery';
import { creationFixture } from './creation-page-fixture';

creationFixture();

const relation: OperatorRelation = {
  previous: { operatorAccountId: 'old', subjectAccountId: 'subject', reservationId: 'old-slot' },
  expectedVersion: '12',
};
const request = { ...relation, version: 1 as const, operatorAccountId: 'new', sourceOperationKey: 'operation-key' };
const source: TransferAttempt = {
  accountId: 'human',
  request,
  side: 'source',
  acceptance: 'acceptance',
  reference: 'approval',
  phase: 'execute',
};
const unusual = 'quote"slash\\nonBMP😀lone\ud800';
const unusualRequest = { ...request, sourceOperationKey: unusual };
const unusualSource: TransferAttempt = {
  ...source,
  accountId: unusual,
  request: unusualRequest,
  acceptance: unusual,
  reference: unusual,
};
const destinationApprove: TransferAttempt = {
  accountId: unusual,
  request: unusualRequest,
  side: 'destination',
  reference: unusual,
  phase: 'approve',
};
const maximumRequestBase: TransferRequest = {
  ...request,
  previous: {
    operatorAccountId: 'a'.repeat(128),
    subjectAccountId: 'b'.repeat(128),
    reservationId: 'c'.repeat(128),
  },
  operatorAccountId: 'd'.repeat(128),
  sourceOperationKey: 'e'.repeat(128),
};
const maximumRequest: TransferRequest = {
  ...maximumRequestBase,
  expectedVersion: '9223372036854775807',
};
const maximumAttempt: TransferAttempt = {
  ...source,
  accountId: '\ud800'.repeat(128),
  request: maximumRequest,
  acceptance: '\ud800'.repeat(4096),
  reference: '\ud800'.repeat(4096),
  phase: 'readback',
};

test('stored transfer attempts round-trip every valid phase and the maximum escaped envelope', () => {
  for (const attempt of [
    { ...unusualSource, phase: 'approve' },
    unusualSource,
    { ...unusualSource, phase: 'readback' },
    destinationApprove,
    { ...destinationApprove, phase: 'accepted' },
  ] satisfies TransferAttempt[]) {
    expect(storeTransferAttempt(attempt)).toBe(true);
    expect(restoreTransferAttempt()).toEqual(attempt);
  }
  expect(JSON.stringify(maximumRequest).length).toBeLessThan(4096);
  expect(storeTransferAttempt(maximumAttempt)).toBe(true);
  expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')!.length).toBeLessThan(54_109);
  expect(restoreTransferAttempt()).toEqual(maximumAttempt);
});

test('oversized attempts are rejected before parsing without changing storage; absence stays null', () => {
  const boundary = JSON.stringify(maximumAttempt).padEnd(54_109, ' ');
  expect(boundary.length).toBe(54_109);
  const parse = spyOn(JSON, 'parse');
  try {
    for (const raw of [boundary + ' ', 'x'.repeat(54_110)]) {
      window.sessionStorage.setItem('rezics.operator-transfer.attempt', raw);
      expect(restoreTransferAttempt()).toBe('invalid');
      expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')).toBe(raw);
    }
    window.sessionStorage.clear();
    expect(restoreTransferAttempt()).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test('recovery keeps source uncertainty, native acknowledgement and destination acceptance distinct', () => {
  expect(transferRecoveryKind(source)).toBe('source-unknown');
  expect(retainsTransferWork(transferRecoveryKind(source))).toBe(true);
  expect(transferRecoveryKind({ ...source, phase: 'readback' })).toBe('source-acknowledged');
  expect(
    transferRecoveryKind({ ...source, phase: 'readback' }, {
      kind: 'acknowledged',
      reference: 'approval',
      readback: { kind: 'failure', reason: 'conflict' },
    } satisfies TransferResult),
  ).toBe('source-acknowledged-conflict');
  expect(transferRecoveryKind({ ...source, side: 'destination', phase: 'accepted', acceptance: undefined })).toBe(
    'destination-accepted',
  );
});

test('a matching current relation is only an acknowledgement readback when native execution was already acknowledged', () => {
  const observed: OperatorRelation = {
    previous: { operatorAccountId: 'new', subjectAccountId: 'subject', reservationId: 'new-slot' },
    expectedVersion: '13',
  };
  expect(confirmsTransferReadback({ ...source, phase: 'execute' }, observed)).toBe(false);
  expect(confirmsTransferReadback({ ...source, phase: 'readback' }, observed)).toBe(true);
  expect(confirmsTransferReadback({ ...source, phase: 'readback' }, relation)).toBe(false);
  expect(
    transferRecoveryKind({ ...source, phase: 'readback' }, {
      kind: 'acknowledged',
      reference: 'approval',
      readback: { kind: 'current', relation: observed },
    } satisfies TransferResult),
  ).toBe('source-acknowledged');
});

const { submitTransferAttempt } = await import('../src/operator-transfer');
const { TRANSFER_APPROVAL_MAX_RESPONSE_BYTES, TRANSFER_EXECUTION_MAX_RESPONSE_BYTES } =
  await import('@rezics/auth-contract');
const subject = '00000000-0000-7000-8000-000000000001';
const command: TransferAttempt = {
  ...source,
  request: { ...request, previous: { ...request.previous, subjectAccountId: subject } },
};
const approval = { reference: '\ud800'.repeat(4096), expiresAt: '+010000-01-01T00:00:00.000Z' };
function installReply(reply: () => Response | Promise<Response>, selected: TransferAttempt = command) {
  window.sessionStorage.clear();
  storeTransferAttempt(selected);
  const calls: { path: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === '/session') return Response.json({ account_id: selected.accountId });
    if (path.includes('/transfer-review'))
      return Response.json({
        viewer: { kind: 'ready' },
        review:
          selected.side === 'source'
            ? {
                kind: 'source',
                relation: { previous: selected.request.previous, expectedVersion: selected.request.expectedVersion },
                action: 'allowed',
              }
            : { kind: 'destination', destinationAccountId: selected.request.operatorAccountId, action: 'allowed' },
      });
    return reply();
  }) as typeof fetch;
  return calls;
}

test('installed approval admits maximum escaped reference and split UTF-8, expires no command, and keeps destination-only costs', async () => {
  const destination: TransferAttempt = {
    ...command,
    side: 'destination',
    phase: 'approve',
    acceptance: undefined,
    reference: undefined,
  };
  for (const reference of [approval.reference, '😀'.repeat(2048)]) {
    const raw = JSON.stringify({ ...approval, reference });
    if (reference === approval.reference)
      expect(new TextEncoder().encode(raw).length).toBe(TRANSFER_APPROVAL_MAX_RESPONSE_BYTES);
    const bytes = new TextEncoder().encode(raw);
    const calls = installReply(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 127) controller.enqueue(bytes.slice(i, i + 127));
              controller.close();
            },
          }),
        ),
      destination,
    );
    expect(await submitTransferAttempt(destination)).toEqual({ kind: 'accepted', reference });
    expect(calls.map(({ path }) => path)).toEqual([
      '/session',
      '/session',
      '/account-management/operators/transfer-review',
      '/account-operations/approve',
      '/session',
    ]);
    expect(restoreTransferAttempt()).toMatchObject({ phase: 'accepted', reference });
  }
  const calls = installReply(() => Response.json({ ...approval, expiresAt: '2000-01-01T00:00:00.000Z' }), {
    ...command,
    phase: 'approve',
  });
  expect(await submitTransferAttempt({ ...command, phase: 'approve' })).toMatchObject({ reason: 'uncertain' });
  expect(calls.some(({ path }) => path.endsWith('/execute'))).toBe(false);
});

test('exact execution acknowledgement survives failed persistence/readback; malformed success and error envelopes stay uncertain', async () => {
  for (const [status, body, reason] of [
    [200, { accountId: subject }, undefined],
    [200, { accountId: subject, expired: true }, 'uncertain'],
    [200, { accountId: '00000000-0000-7000-8000-000000000002' }, 'uncertain'],
    [200, { accountId: subject, pending: true }, 'uncertain'],
    [400, { error: 'account_operation_denied', effect_status: 'not_applied' }, 'unavailable'],
    [401, { error: 'step_up_required', effect_status: 'not_applied' }, 'step-up'],
    [403, { error: 'account_operation_denied', effect_status: 'not_applied' }, 'denied'],
    [409, { error: 'account_operation_denied', effect_status: 'not_applied' }, 'conflict'],
    [403, { error: 'step_up_required', effect_status: 'not_applied' }, 'uncertain'],
    [409, { error: 'account_operation_denied' }, 'uncertain'],
    [409, { error: 'account_operation_denied', effect_status: 'not_applied', extra: 1 }, 'uncertain'],
  ] as const) {
    const calls = installReply(() => Response.json(body, { status }));
    const result = await submitTransferAttempt(command);
    expect(result).toMatchObject(
      reason ? { kind: 'failure', reason } : { kind: 'acknowledged', readback: { reason: 'conflict' } },
    );
    expect(calls.map(({ path }) => path)).toEqual(
      reason
        ? ['/session', '/session', '/account-operations/execute']
        : [
            '/session',
            '/session',
            '/account-operations/execute',
            '/session',
            '/account-management/operators/transfer-review',
          ],
    );
    const execute = calls.find(({ path }) => path.endsWith('/execute'))!;
    expect(execute.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(execute.init!.body))).toEqual({
      operationKey: command.request.sourceOperationKey,
      operation: {
        kind: 'transfer',
        previous: command.request.previous,
        expectedVersion: command.request.expectedVersion,
        operatorAccountId: command.request.operatorAccountId,
        acceptance: command.acceptance,
      },
      reference: command.reference,
    });
  }
  const calls = installReply(() => Response.json({ accountId: subject }));
  expect(
    await submitTransferAttempt(command, (next) => next.phase !== 'readback' && storeTransferAttempt(next)),
  ).toMatchObject({ kind: 'acknowledged', readback: { reason: 'unavailable' } });
  expect(calls).toHaveLength(3);
  expect(restoreTransferAttempt()).toMatchObject({ phase: 'execute' });
});

test('raw overflow, malformed 200/4xx, fatal UTF-8 and absent/lying length cannot classify a refusal', async () => {
  const excess = JSON.stringify({ accountId: subject }).padEnd(TRANSFER_EXECUTION_MAX_RESPONSE_BYTES + 1);
  for (const reply of [
    () => new Response(excess),
    () => new Response(excess, { headers: { 'content-length': '1' } }),
    () => new Response('{', { status: 400 }),
    () => new Response('{'),
    () => new Response(new Uint8Array([0xff])),
  ]) {
    const calls = installReply(reply);
    const parse = spyOn(JSON, 'parse');
    try {
      expect(await submitTransferAttempt(command)).toMatchObject({ reason: 'uncertain' });
      expect(parse.mock.calls.some(([raw]) => raw === excess)).toBe(false);
    } finally {
      parse.mockRestore();
    }
    expect(calls).toHaveLength(3);
  }
});

test('retirement before dispatch, between approval/execution and replacement during execution preserve original storage without later reads', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = installReply(() => {
    throw new Error('must not send');
  });
  expect(await submitTransferAttempt(command, storeTransferAttempt, () => true, controller.signal)).toMatchObject({
    reason: 'unavailable',
  });
  expect(calls).toHaveLength(0);
  let active = true;
  const approving = { ...command, phase: 'approve' as const };
  calls = installReply(() => {
    active = false;
    return Response.json(approval);
  }, approving);
  expect(await submitTransferAttempt(approving, storeTransferAttempt, () => active)).toMatchObject({
    reason: 'uncertain',
  });
  expect(restoreTransferAttempt()).toEqual(approving);
  expect(calls.some(({ path }) => path.endsWith('/execute'))).toBe(false);
  const replacement = { ...command, request: { ...command.request, sourceOperationKey: 'newer' } };
  calls = installReply(() => {
    storeTransferAttempt(replacement);
    return Response.json({ accountId: subject });
  });
  expect(await submitTransferAttempt(command)).toMatchObject({ reason: 'uncertain' });
  expect(restoreTransferAttempt()).toEqual(replacement);
  expect(calls).toHaveLength(3);
});

test('each command deadline settles stalled or abort-ignoring headers/body without advancing the saved phase', async () => {
  for (const stage of ['headers', 'body'] as const) {
    let expire: (() => void) | undefined;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      expect(ms).toBe(5000);
      expire = fn;
      return 0;
    }) as typeof setTimeout);
    const entered = Promise.withResolvers<void>();
    const calls = installReply(() => {
      entered.resolve();
      return stage === 'headers'
        ? new Promise<Response>(() => {})
        : new Response(
            new ReadableStream({
              cancel() {
                return new Promise(() => {});
              },
            }),
          );
    });
    try {
      const pending = submitTransferAttempt(command);
      await entered.promise;
      await Promise.resolve();
      expire!();
      expect(await pending).toMatchObject({ reason: 'uncertain' });
      expect(restoreTransferAttempt()).toEqual(command);
      expect(calls).toHaveLength(3);
    } finally {
      timer.mockRestore();
    }
  }
});
