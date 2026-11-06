/** Compatibility identity-native entry. Arithmetic lives in core; SQL catalog is bound at composition. */

import { declareBound, type Bound } from '@rezics/bounds';
import type { NativeCollectionWork } from './collection-source-work.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import { requireLibraryDomain } from './domain-binding.ts';
import { libraryIdentitySQL } from './identity-native-planner-statements.ts';
import {
  LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
  LIBRARY_IDENTITY_SELECTED_STATEMENTS,
} from './identity-native-planner-projection.ts';
export { default as identityTimeSql } from '../command/time.sql';
export { default as identityFenceSql } from '../command/fence.sql';
export { default as identityNoEffectFenceSql } from '../command/no-effect-fence.sql';
export { default as identityPartitionSql } from '../partition/read.sql';
export { default as identityAccountSql } from '../access/account-share.sql';

export const libraryIdentityJobSizeSQL =
  'SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3';

export const nativeIdentityPartitionQuery = Object.freeze({
  sql: `SELECT epoch, position::text AS position, write_state AS "writeState",
    CASE WHEN moved_to IS NULL THEN NULL ELSE '' END AS "movedTo"
    FROM core.partition WHERE partition_no=$1 FOR SHARE`,
  params: Object.freeze(['partition_no']),
});

function identity() {
  return requireLibraryDomain().identityNative;
}

function workHandle(work?: NativeCollectionWork) {
  return work ? { resultByteBound: (key: string) => work.resultByteBound(key) } : undefined;
}

function projected(
  rows: number,
  points: number,
  metadata: number,
  output: number,
  seeks = 0,
  candidates = 0,
): Readonly<{ work: Bound; resultBytes: number }> {
  return Object.freeze({
    work: declareBound({
      candidateKeys: candidates,
      nativeRows: rows,
      nativePoints: points,
      identityMetadataRows: metadata,
      emptySeeks: seeks,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
      engineRequests: 0,
    }),
    resultBytes: output,
  });
}

const sqlParts: Readonly<Record<keyof typeof libraryIdentitySQL, Readonly<{ work: Bound; resultBytes: number }>>> =
  Object.freeze({
    oldFacts: projected(0, 1, 0, 256, 1),
    oldReferences: projected(0, 1, 0, 256, 1),
    invalidateKey: projected(1, 1, 0, 64, 1),
    invalidateKeyInline: projected(1, 1, 0, 64, 1),
    retainedGenerations: projected(3, 1, 0, 256, 1),
    oldHead: projected(1, 1, 0, 128, 1),
    oldState: projected(1, 1, 0, 1024, 1),
    invalidateGeneration: projected(1, 1, 0, 64, 1),
    abandonWorking: projected(1, 1, 0, 64, 1),
    insertGeneration: projected(2, 2, 0, 64, 1),
    insertPlan: projected(4, 4, 0, 64, 1),
    advanceCapture: projected(1, 1, 0, 64, 1),
    mappingClaim: projected(2, 2, 2, 256, 1),
    insertEffect: projected(2, 2, 0, 64, 1),
    readEffect: projected(1, 1, 0, 4608, 1),
    insertReference: projected(2, 2, 0, 64, 1),
    advanceGeneration: projected(1, 1, 0, 64, 1),
    advancePlan: projected(1, 1, 0, 64, 1),
    detachHead: projected(2, 2, 0, 64, 1),
    detachState: projected(2, 2, 0, 64, 1),
    insertSeal: projected(2, 2, 0, 64, 1),
    sealPlan: projected(1, 1, 0, 64, 1),
    nextPlan: projected(2, 1, 0, 2304, 1),
    effectPage: projected(0, 1, 0, 512, 1),
  });

export function isNativeIdentitySourceBasisSQL(sql: string): boolean {
  return identity().isSourceBasisSQL(sql);
}
export function isLibraryIdentityFullPartitionSQL(sql: string): boolean {
  return identity().isFullPartitionSQL(sql);
}
export function nativeIdentitySourceBasisBound(sql: string, values: readonly unknown[]): Bound | undefined {
  return identity().sourceBasisBound(sql, values) as Bound | undefined;
}
export function nativeIdentitySourceBasisFootprint(
  sql: string,
  values: readonly unknown[],
): WorkDimensions | undefined {
  return identity().sourceBasisFootprint(sql, values);
}
export function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{
  sql: string;
  work: WorkDimensions;
  engineRequests: 0;
}>[] {
  return Object.freeze(
    identity()
      .basisStatements()
      .map((item) => Object.freeze({ sql: item.sql, work: item.work, engineRequests: 0 as const })),
  );
}
export function libraryIdentityNativeOperationBound(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): Bound | undefined {
  return identity().bound(sql, values, workHandle(work)) as Bound | undefined;
}
export function libraryIdentitySelectedOperationBound(sql: string, values: readonly unknown[]): Bound | undefined {
  return identity().selectedBound(sql, values) as Bound | undefined;
}
export function libraryIdentityNativeOperationFootprint(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): WorkDimensions | undefined {
  return identity().footprint(sql, values, workHandle(work));
}
export function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  return identity().selectedFootprint(sql, values);
}

/** Immutable Library-owned declarations. Each result projection remains beside its exact SQL identity. */
export function LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS() {
  const selected = LIBRARY_IDENTITY_SELECTED_STATEMENTS();
  const selectedParts = Object.freeze({
    plan: projected(1, 1, 0, LIBRARY_IDENTITY_PLAN_RESULT_BYTES, 1),
    current: projected(7, 7, 1, 64, 1),
    job: projected(16, 13, 16, 2048, 4),
    seal: projected(5, 5, 2, 256, 1),
    page: projected(1, 0, 0, 512, 0, 1),
  });
  return Object.freeze({
    sql: Object.freeze(
      Object.fromEntries(
        Object.entries(sqlParts).map(([name, value]) => [
          name,
          Object.freeze({
            sql: libraryIdentitySQL[name as keyof typeof libraryIdentitySQL],
            work: value.work,
            resultBytes: value.resultBytes,
          }),
        ]),
      ),
    ) as Readonly<Record<keyof typeof libraryIdentitySQL, Readonly<{ sql: string; work: Bound; resultBytes: number }>>>,
    selected: Object.freeze(
      Object.fromEntries(
        Object.entries(selected).map(([name, statement]) => [
          name,
          Object.freeze({ ...statement, ...selectedParts[name as keyof typeof selectedParts] }),
        ]),
      ),
    ) as Readonly<
      Record<
        keyof ReturnType<typeof LIBRARY_IDENTITY_SELECTED_STATEMENTS>,
        Readonly<{ sql: string; values: readonly unknown[]; work: Bound; resultBytes: number }>
      >
    >,
    sourceBasis: Object.freeze(
      identity()
        .basisStatements()
        .map((item) => {
          const work = identity().sourceBasisBound(item.sql, item.values) as Bound | undefined;
          if (!work) throw new TypeError('Identity source-basis declaration is incomplete');
          return Object.freeze({ sql: item.sql, values: item.values, work });
        }),
    ),
  });
}
