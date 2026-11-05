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
  expectedVersion: '1'.repeat(4098 - JSON.stringify(maximumRequestBase).length),
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
  expect(JSON.stringify(maximumRequest).length).toBe(4096);
  expect(storeTransferAttempt(maximumAttempt)).toBe(true);
  expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')?.length).toBe(54_109);
  expect(restoreTransferAttempt()).toEqual(maximumAttempt);
});

test('oversized attempts are rejected before parsing without changing storage; absence stays null', () => {
  const boundary = JSON.stringify(maximumAttempt);
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
  ).toBe('none');
});
