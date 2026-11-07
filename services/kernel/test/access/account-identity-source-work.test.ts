import { expect, test } from 'bun:test';
import { agentIdentityMaintenance } from '../../src/access/adapters/bind.ts';
import { statementBytes } from '../../src/database/statement-bytes.ts';
import acceptedAccountClaim from '../../src/semantic/identity-epoch-binding-accepted-account.sql';
import retainedReference from '../../src/semantic/identity-source-consumer-custody-select.sql';
import { COMMAND_DISPATCH_ALLOWANCE } from '../../src/command/dispatch-lifetime.ts';
import { IDENTITY_SOURCE_ORIGINAL_SCHEDULE } from '../../src/semantic/identity-source-maintenance-config.ts';
import { originalWorkVector, scaleOriginalControl, sumOriginalControl } from '../../src/access/core/index.ts';
import {
  ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION,
  ACCOUNT_IDENTITY_FENCE_DECLARATION,
  ACCOUNT_IDENTITY_INTENT_DECLARATION,
  ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION,
  ACCOUNT_IDENTITY_REVERSAL_READ_DECLARATION,
  ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION,
  ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION,
  ACCOUNT_IDENTITY_ROLE_INVENTORY_DECLARATION,
  ACCOUNT_IDENTITY_SOURCE_ADMISSION_DECLARATION,
  ACCOUNT_IDENTITY_SOURCE_DECLARATION,
  ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION,
  ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION,
} from '../../src/access/agent-verification-identity-work.ts';

test('original-home reader prices fence, intent and the three-statement technical fallback, then admits that body at original/prepare/checkpoint/finish with one Core control', () => {
  const fence = ACCOUNT_IDENTITY_FENCE_DECLARATION();
  const intent = ACCOUNT_IDENTITY_INTENT_DECLARATION();
  const technical = ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION();
  expect(fence.engineRequests).toBe(0);
  expect(intent.work.statements).toBe(1);
  expect(technical.work.statements).toBe(3);
  expect(technical.work).toEqual(
    sumOriginalControl(
      ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION().work,
      ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION().work,
      ACCOUNT_IDENTITY_ROLE_INVENTORY_DECLARATION().work,
    ),
  );
  const body = ACCOUNT_IDENTITY_SOURCE_DECLARATION();
  expect(ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION).toBe(ACCOUNT_IDENTITY_SOURCE_DECLARATION);
  expect(body.work).toEqual(sumOriginalControl(fence.work, intent.work, technical.work));
  originalWorkVector(body.work);
  const schedule = IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source;
  const calls = schedule.original + schedule.prepare + schedule.checkpoint + schedule.finish;
  expect(calls).toBe(4);
  expect(ACCOUNT_IDENTITY_SOURCE_ADMISSION_DECLARATION().work).toEqual(
    sumOriginalControl(scaleOriginalControl(body.work, calls), COMMAND_DISPATCH_ALLOWANCE.effect.work),
  );
  expect(COMMAND_DISPATCH_ALLOWANCE.profile).toBe('single-no-effect');
});

test('reversal read and verify match settlementFor, with Core only on the read wrapper', () => {
  const read = ACCOUNT_IDENTITY_REVERSAL_READ_DECLARATION();
  const verify = ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION();
  originalWorkVector(read.work);
  originalWorkVector(verify.work);
  expect(verify.engineRequests).toBe(0);
  expect(ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION).toBe(ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION);
  expect(read.work).toEqual(sumOriginalControl(COMMAND_DISPATCH_ALLOWANCE.effect.work, verify.work));
  expect(read.work.statements).toBeGreaterThan(verify.work.statements);
  expect(verify.work.statements).toBeGreaterThan(3);
});

test('native Semantic producer declarations preserve accepted-binding and retained-reference work', () => {
  const producer = agentIdentityMaintenance();
  expect(ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION()).toBe(producer.acceptedBindingDeclaration());
  expect(producer.acceptedBindingDeclaration()).toEqual({
    work: {
      candidateKeys: 0,
      identityMetadataRows: 0,
      witnessKeys: 0,
      nativeRows: 5,
      nativePoints: 5,
      statements: 1,
      emptySeeks: 1,
      bytes: statementBytes(acceptedAccountClaim) + 4 + 36 + 64 + 8192 + 36,
    },
    engineRequests: 0,
  });
  expect(producer.retainedReferenceDeclaration()).toEqual({
    work: {
      candidateKeys: 0,
      identityMetadataRows: 0,
      witnessKeys: 0,
      nativeRows: 6,
      nativePoints: 6,
      statements: 1,
      emptySeeks: 1,
      bytes: statementBytes(retainedReference) + 4 + 64 + 64 + 8 + 36 + 36 + 8 + 36 + 4 + 64,
    },
    engineRequests: 0,
  });
});
