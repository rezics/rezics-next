import type { Pool } from 'pg';
import { deadlineFor } from '../request/deadline.ts';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  currentIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  identitySourceConsumerNativeWork,
} from '../semantic/identity-source-consumer-maintenance.ts';

export function searchIdentityWorkContext(pool: Pool) {
  const funded = activeIdentitySourceConsumerMaintenance(pool);
  const deadline = funded?.deadline ?? deadlineFor(1000);
  const token = currentIdentitySourceConsumerMaintenance(pool, deadline);
  const parent = identitySourceConsumerLibraryWork(pool, token ?? undefined, deadline);
  const allowance = identitySourceConsumerNativeWork(pool, token ?? undefined, deadline);
  if (!token || !parent || !allowance)
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Search requires the original live Source maintenance frame',
    );
  const axes = [
    'candidateKeys',
    'identityMetadataRows',
    'nativeRows',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'emptySeeks',
  ] as const;
  const ceiling = Object.fromEntries(axes.map((axis) => [axis, parent.available(axis)])) as unknown as WorkDimensions;
  return { deadline, identityConsumerWork: token, ceiling, allowance };
}

export function searchIdentityWorkUsed(
  pool: Pool,
  context: ReturnType<typeof searchIdentityWorkContext>,
): NativeStepWork {
  const { allowance, deadline, identityConsumerWork } = context;
  const remaining = identitySourceConsumerNativeWork(pool, identityConsumerWork, deadline);
  if (!remaining)
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'The original native work frame ended before Search settlement',
    );
  return {
    rows: allowance.rows - remaining.rows,
    points: allowance.points - remaining.points,
    statements: allowance.statements - remaining.statements,
    bytes: allowance.bytes - remaining.bytes,
    engineRequests: allowance.engineRequests - remaining.engineRequests,
  };
}
