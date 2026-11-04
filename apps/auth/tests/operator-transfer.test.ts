import { expect, test } from 'bun:test';
import type { OperatorRelation, TransferAttempt, TransferResult } from '../src/operator-transfer';
import { confirmsTransferReadback, retainsTransferWork, transferRecoveryKind } from '../src/operator-transfer-recovery';

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
