import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkClient } from '../../src/work/client.ts';
import {
  claimOperationalWorkOriginal,
  debitOperationalWorkAttempt,
  openOperationalWorkOriginal,
  OPERATIONAL_WORK_ATTEMPT_BOUND,
  OPERATIONAL_WORK_LOCAL_DECLARATION,
  OPERATIONAL_WORK_REGISTRATION,
} from '../../src/history/operational-work-budget.ts';
import { ProblemError } from '../../src/http/problem.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import {
  MEMBERS_PREPARATION_CHILDREN,
  declareMembersPreparationParent,
  type MembersPreparationDeclarations,
} from '../../src/library/members-preparation-budget.ts';
import {
  MEMBERS_PREPARATION_RESERVATION_SUBTOTAL,
  MEMBERS_PREPARATION_STEP_CEILING,
} from '../../src/library/members-preparation-cost.ts';
import { declareMembersPreparationRequest } from '../../src/library/members-preparation-request.ts';

const cost = (amount: number): WorkDimensions => ({
  candidateKeys: amount,
  nativeRows: amount,
  identityMetadataRows: amount,
  emptySeeks: amount,
  nativePoints: amount,
  witnessKeys: amount,
  statements: amount,
  bytes: amount,
});
const declarations = (): MembersPreparationDeclarations =>
  Object.fromEntries(MEMBERS_PREPARATION_CHILDREN.map((name) => [name, cost(2)])) as MembersPreparationDeclarations;

test('the static Members equation includes constant History bounds and refuses an incomplete or oversized body', () => {
  const declared = declareMembersPreparationParent(declarations());
  expect(declared.children.historyRegistration.statements).toBe(464);
  expect(declared.children.receivingReadback.statements).toBe(429);
  expect(declared.children.members.statements).toBeLessThanOrEqual(16);
  expect(declareMembersPreparationRequest(declarations()).children.history).toEqual(OPERATIONAL_WORK_LOCAL_DECLARATION);
  expect(MEMBERS_PREPARATION_STEP_CEILING.statements).toBe(16);
  expect(OPERATIONAL_WORK_REGISTRATION.statements).toBe(464);
  expect(MEMBERS_PREPARATION_RESERVATION_SUBTOTAL.statements).toBeGreaterThan(464 + 429);
  expect(() => declareMembersPreparationParent({ ...declarations(), sourceResolve: null })).toThrow(ProblemError);
  expect(() => declareMembersPreparationParent({ ...declarations(), members: cost(17) })).toThrow(
    'Members preparation body exceeds 16 statements',
  );
});

test('History original is opened from static bounds and refuses a fourth attempt without a caller ledger', () => {
  const pool = {} as Pool;
  const work = {} as WorkClient;
  const deadline = Date.now() + 60_000;
  expect(() => openOperationalWorkOriginal(pool, Date.now() - 1, work)).toThrow('deadline');
  const history = openOperationalWorkOriginal(pool, deadline, work);
  expect(() => debitOperationalWorkAttempt(history)).toThrow('original-unavailable');
  for (const [p, w, d, token] of [
    [{} as Pool, work, deadline, history],
    [pool, {} as WorkClient, deadline, history],
    [pool, work, deadline + 1, history],
    [pool, work, deadline, { ...history }],
  ] as const)
    expect(() => claimOperationalWorkOriginal(token, p, w, d)).toThrow('original-unavailable');
  expect(claimOperationalWorkOriginal(history, pool, work, deadline)).toBe(history);
  expect(() => claimOperationalWorkOriginal(history, pool, work, deadline)).toThrow('original-unavailable');
  for (let attempt = 0; attempt < OPERATIONAL_WORK_ATTEMPT_BOUND; attempt++) debitOperationalWorkAttempt(history);
  expect(() => debitOperationalWorkAttempt(history)).toThrow('attempt-bound');
});
