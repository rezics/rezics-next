import { memoizedValue } from '../memoized.ts';
import {
  SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS,
  SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE,
  assertSourceFenceAccount,
  assertSourceFenceOptions,
  sourceFenceResponse,
} from './dispatch-lifetime-source-fence.ts';
import type { CommandDispatchPrice } from './dispatch-lifetime.ts';

const sum = (...parts: readonly CommandDispatchPrice[]): CommandDispatchPrice => {
  const work = { ...parts[0]!.work };
  for (const part of parts.slice(1))
    for (const axis of Object.keys(work) as (keyof typeof work)[]) work[axis] += part.work[axis];
  return Object.freeze({ work: Object.freeze({ ...work }), engineRequests: 0 });
};

const price = (
  nativeRows: number,
  nativePoints: number,
  statements: number,
  bytes: number,
  emptySeeks = 0,
): CommandDispatchPrice =>
  Object.freeze({
    work: Object.freeze({
      candidateKeys: 0,
      nativeRows,
      identityMetadataRows: 0,
      nativePoints,
      witnessKeys: 0,
      statements,
      bytes,
      emptySeeks,
    }),
    engineRequests: 0,
  });

/** Two deferred Source callbacks (producer roles, then custody insert or terminal append)
 * receive the executor-minted transaction id. History record-sources stay refused. */
export const SOURCE_ASSOCIATION_CALLBACK_MAX = 2;

export function SOURCE_ASSOCIATION_COMMAND_DISPATCH_CONTROLS() {
  return memoizedValue(SOURCE_ASSOCIATION_COMMAND_DISPATCH_CONTROLS, () =>
    Object.freeze({
      ...SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS,
      callbackAdmission: price(0, 0, 0, 72),
      sourceAssociation: price(0, 0, 0, 0),
    }),
  );
}

export function SOURCE_ASSOCIATION_COMMAND_DISPATCH_ALLOWANCE() {
  return memoizedValue(SOURCE_ASSOCIATION_COMMAND_DISPATCH_ALLOWANCE, () => {
    const c = SOURCE_ASSOCIATION_COMMAND_DISPATCH_CONTROLS();
    const fence = SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE;
    return Object.freeze({
      profile: 'event-callback-source-association' as const,
      components: c,
      branches: Object.freeze({
        noEffect: sum(fence.branches.noEffect, c.callbackAdmission, c.sourceAssociation),
        event: sum(fence.branches.event, c.callbackAdmission, c.sourceAssociation),
      }),
      effect: sum(fence.effect, c.callbackAdmission, c.sourceAssociation),
      cleanup: c.cleanupRollback,
      total: sum(fence.total, c.callbackAdmission, c.sourceAssociation),
      maxima: Object.freeze({
        attempts: 1,
        checkouts: 1,
        fences: 1,
        events: 1,
        callbacks: SOURCE_ASSOCIATION_CALLBACK_MAX,
        cleanupRollbacks: 1,
      }),
    });
  });
}

export type SourceAssociationCommandDispatchAllowance = ReturnType<
  typeof SOURCE_ASSOCIATION_COMMAND_DISPATCH_ALLOWANCE
>;
export type SourceAssociationCommandDispatchOwner = Readonly<{
  original: object;
  validate(): void;
  reserve(allowance: SourceAssociationCommandDispatchAllowance): void | Promise<void>;
}>;

export {
  assertSourceFenceAccount as assertSourceAssociationAccount,
  assertSourceFenceOptions as assertSourceAssociationOptions,
  sourceFenceResponse as sourceAssociationResponse,
};
