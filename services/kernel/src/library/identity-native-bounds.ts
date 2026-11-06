/** Compatibility identity-native matching. Core owns arithmetic; the adapter catalog owns SQL texts. */

import { memoizedValue } from '../memoized.ts';
import { declareBound, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import { createIdentityNativeBounds, identityBasisBindValues } from './core/index.ts';
import {
  createIdentityNativeCatalog,
  libraryIdentityJobSizeSQL,
  nativeIdentityPartitionQuery,
} from './adapters/identity-statements.ts';
import { peekLibraryDomain } from './domain-binding.ts';

export { libraryIdentityJobSizeSQL, nativeIdentityPartitionQuery };

function catalog() {
  return memoizedValue(catalog, () => createIdentityNativeCatalog());
}

function local() {
  return memoizedValue(local, () => createIdentityNativeBounds(catalog()));
}

function native() {
  return peekLibraryDomain()?.identityNative ?? local();
}

function asBound(value: unknown): Bound | undefined {
  return value as Bound | undefined;
}

export function isNativeIdentitySourceBasisSQL(sql: string): boolean {
  return native().isSourceBasisSQL(sql);
}

export function isLibraryIdentityFullPartitionSQL(sql: string): boolean {
  return native().isFullPartitionSQL(sql);
}

export function nativeIdentitySourceBasisBound(sql: string, values: readonly unknown[]): Bound | undefined {
  return asBound(native().sourceBasisBound(sql, values));
}

export function nativeIdentitySourceBasisFootprint(
  sql: string,
  values: readonly unknown[],
): WorkDimensions | undefined {
  return native().sourceBasisFootprint(sql, values);
}

export function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{
  sql: string;
  values: readonly unknown[];
  work: WorkDimensions;
  engineRequests: 0;
}>[] {
  return native().basisStatements();
}

export function libraryIdentityNativeOperationBound(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): Bound | undefined {
  return asBound(native().bound(sql, values, work));
}

export function libraryIdentitySelectedOperationBound(sql: string, values: readonly unknown[]): Bound | undefined {
  return asBound(native().selectedBound(sql, values));
}

export function libraryIdentityNativeOperationFootprint(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): WorkDimensions | undefined {
  return native().footprint(sql, values, work);
}

export function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  return native().selectedFootprint(sql, values);
}

function declarationWork(input: {
  nativeRows: number;
  nativePoints: number;
  identityMetadataRows: number;
  emptySeeks: number;
  resultBytes: number;
  candidateKeys?: number;
}): Bound {
  return declareBound({
    candidateKeys: input.candidateKeys ?? 0,
    nativeRows: input.nativeRows,
    identityMetadataRows: input.identityMetadataRows,
    emptySeeks: input.emptySeeks,
    nativePoints: input.nativePoints,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });
}

/** Immutable Library-owned declarations. Each result projection remains beside its exact SQL identity. */
export function LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS() {
  return memoizedValue(LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS, () => {
    const installed = catalog();
    const bounds = local();
    return Object.freeze({
      sql: Object.freeze(
        Object.fromEntries(
          Object.entries(installed.sqlWork).map(([name, declaration]) => [
            name,
            Object.freeze({
              sql: declaration.sql,
              work: declarationWork(declaration),
              resultBytes: declaration.resultBytes,
            }),
          ]),
        ),
      ) as Readonly<Record<string, Readonly<{ sql: string; work: Bound; resultBytes: number }>>>,
      selected: Object.freeze(
        Object.fromEntries(
          Object.entries(installed.selected).map(([name, statement]) => [
            name,
            Object.freeze({
              sql: statement.sql,
              values: statement.values,
              work: declarationWork({
                nativeRows: statement.rows,
                nativePoints: statement.points,
                identityMetadataRows: statement.metadata,
                emptySeeks: statement.seeks ?? 0,
                resultBytes: statement.output,
                candidateKeys: statement.candidates ?? 0,
              }),
              resultBytes: statement.output,
            }),
          ]),
        ),
      ) as Readonly<
        Record<string, Readonly<{ sql: string; values: readonly unknown[]; work: Bound; resultBytes: number }>>
      >,
      sourceBasis: Object.freeze(
        installed.basisQueries.map((query) => {
          const values = Object.freeze(identityBasisBindValues(query.params ?? []));
          const work = bounds.sourceBasisBound(query.sql, values);
          if (!work) throw new TypeError('Identity source-basis declaration is incomplete');
          return Object.freeze({ sql: query.sql, values, work });
        }),
      ),
    });
  });
}
