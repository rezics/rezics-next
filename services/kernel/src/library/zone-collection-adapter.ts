/** Library implementation of the Zone-owned Collection work and mounted-read port. */

import type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
import { CollectionSourceLedger, NativeCollectionWork } from './collection-native-work.ts';
import { collectionReadView, createCollectionReads, type CollectionResourceView } from './collection-reads.ts';
import { collectionResourceSchema } from './collection-routes.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';

const axes = [
  'candidateKeys',
  'identityMetadataRows',
  'nativeRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
] as const satisfies readonly (keyof WorkDimensions)[];

function zero(): Record<keyof WorkDimensions, number> {
  return Object.fromEntries(axes.map((axis) => [axis, 0])) as Record<keyof WorkDimensions, number>;
}

function isReceipt(value: unknown): value is WorkReceipt {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reservationId' in value &&
    'used' in value &&
    typeof value.reservationId === 'string' &&
    typeof value.used === 'object' &&
    value.used !== null &&
    axes.every((axis) => typeof Reflect.get(Object(value.used), axis) === 'number')
  );
}

function createWork(initial: WorkAllowance, deadline: number) {
  const ledger = new CollectionSourceLedger(initial, deadline);
  return {
    initial: ledger.initial,
    deadline: ledger.deadline,
    remaining: () => ledger.allowance(),
    consume: (receipt: WorkReceipt) => ledger.take(receipt),
    isReceipt,
    async bounded<T>(
      allowance: WorkAllowance,
      cost: Partial<WorkDimensions>,
      operation: () => Promise<T>,
      actual: ((result: T) => Partial<WorkDimensions>) | undefined,
      take: (receipt: WorkReceipt) => void,
    ): Promise<T> {
      const work = new NativeCollectionWork(allowance, deadline);
      const reservation = work.reserve({ ...zero(), ...cost });
      reservation.dispatch();
      let settled: Partial<WorkDimensions> = {};
      try {
        const result = await operation();
        settled = actual?.(result) ?? {};
        return result;
      } finally {
        reservation.settle(settled);
        take(work.receipt());
      }
    },
  };
}

function projectPublic(value: { readonly id: string; readonly revision: number }) {
  const view = collectionReadView(value as CollectionResourceView);
  if (!('allowedVisibilityActions' in view)) return view;
  const { allowedVisibilityActions: _ownerActions, ...publicView } = view;
  return publicView;
}

function isConcealed(error: unknown): boolean {
  return error instanceof ProblemError && error.code === 'not_found';
}

function reads(dependencies: { pool: Pool; access: Access; tokens: KeyRing }) {
  const collections = createCollectionReads(dependencies);
  return {
    async readCollection(actor: Actor, id: string, deadline: number) {
      return collections.readCollection(actor, id, deadline);
    },
    projectPublic,
    isConcealed,
  };
}

/** Concrete Library adapter. Composition assigns it to the Zone collection port. */
export function createZoneCollectionAdapter() {
  return {
    createWork,
    reads,
    resourceSchema: () => collectionResourceSchema(),
  };
}
