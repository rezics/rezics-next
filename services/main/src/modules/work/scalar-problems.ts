import { problem, status, t } from 'elysia';
import { problemDefinition, type ProblemSet } from '../problem.ts';
import { IdempotencyConflict } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { StaleWorkHead, WorkEditUnavailable } from './edit.ts';
import { RecoveryHold } from './restore-lineage.ts';
import { InvalidWorkScalarValue } from './scalar-value.ts';
import type { Static } from 'typebox';
import { pendingOperation } from '../../api-contract.ts';
import { admissionConflictSchema, idempotencyConflict } from '../access/composition.ts';

export const invalidIdempotencyKey = problemDefinition(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
export const invalidScalarValue = problemDefinition(400, 'invalid_scalar_value', 'Work scalar value is invalid');
export const staleWorkHead = problemDefinition(409, 'stale_head', 'Expected Work revision is stale');
export const workUnavailable = problemDefinition(404, 'work_unavailable', 'Work is unavailable');
export const recoveryHold = problemDefinition(503, 'recovery_hold', 'Product access is held for recovery reconciliation');

export const scalarProblemSchemas = {
  400: t.Union([invalidIdempotencyKey.schema, invalidScalarValue.schema]),
  404: workUnavailable.schema,
  409: t.Union([staleWorkHead.schema, admissionConflictSchema]),
  503: recoveryHold.schema,
};

export function recoveryFailure(error: unknown) {
  if (error instanceof RecoveryHold) return problem(recoveryHold.body);
}

export function scalarFailure(error: unknown, set: ProblemSet) {
  if (error instanceof InvalidWorkScalarValue) return problem(invalidScalarValue.body);
  if (error instanceof IdempotencyConflict) return problem(idempotencyConflict.body);
  if (error instanceof StaleWorkHead) return problem(staleWorkHead.body);
  if (error instanceof WorkEditUnavailable) return problem(workUnavailable.body);
  const recovery = recoveryFailure(error);
  if (recovery) return recovery;
  if (error instanceof PendingAdmittedWork) {
    set.headers['retry-after'] = '1';
    return status(202, { operationId: error.operationId, status: 'reconciling', phase: error.phase,
      result: null, retry: { allowed: true, afterMs: 1000 } } satisfies Static<typeof pendingOperation>);
  }
}
