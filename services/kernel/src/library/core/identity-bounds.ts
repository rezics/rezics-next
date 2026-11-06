/** Identity-native bound arithmetic. SQL texts arrive as catalog values; this module imports none of them. */

import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { IdentityNativeCatalog, IdentityWorkHandle, QueryText } from '../contract/index.ts';
import type { WorkDimensions } from '../contract/work-dimensions.ts';

type LibraryWork = Omit<Bound, 'engineRequests'>;

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

const normalize = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .trim();

const equal = (left: string, right: string) => normalize(left) === normalize(right);

function part(values: Partial<LibraryWork> = {}): LibraryWork {
  return {
    candidateKeys: values.candidateKeys ?? 0,
    nativeRows: values.nativeRows ?? 0,
    identityMetadataRows: values.identityMetadataRows ?? 0,
    emptySeeks: values.emptySeeks ?? 0,
    nativePoints: values.nativePoints ?? 0,
    witnessKeys: values.witnessKeys ?? 0,
    statements: values.statements ?? 0,
    bytes: values.bytes ?? 0,
  };
}

function bound(values: Partial<LibraryWork> = {}): Bound {
  const work = part(values);
  return declareBound({
    candidateKeys: work.candidateKeys,
    nativeRows: work.nativeRows,
    identityMetadataRows: work.identityMetadataRows,
    emptySeeks: work.emptySeeks,
    nativePoints: work.nativePoints,
    witnessKeys: work.witnessKeys,
    statements: work.statements,
    bytes: work.bytes,
    engineRequests: 0,
  });
}

function workDimensions(value: Bound): WorkDimensions {
  if (value.engineRequests !== 0) throw new TypeError('Library SQL cannot declare engine requests');
  return Object.freeze({
    candidateKeys: value.candidateKeys,
    nativeRows: value.nativeRows,
    identityMetadataRows: value.identityMetadataRows,
    emptySeeks: value.emptySeeks,
    nativePoints: value.nativePoints,
    witnessKeys: value.witnessKeys,
    statements: value.statements,
    bytes: value.bytes,
  });
}

function bindText(values: readonly unknown[]): string | undefined {
  const text = JSON.stringify(values, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  return typeof text === 'string' ? text : undefined;
}

function expectedBindCount(sql: string): number {
  const text = normalize(sql);
  let highest = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) highest = Math.max(highest, Number(match[1]));
  if (highest > 0) return highest;
  return new Set([...text.matchAll(/(?<!:):([a-z_][a-z_0-9]*)/g)].map((match) => match[1])).size;
}

function base(sql: string, values: readonly unknown[]): Bound | undefined {
  const serialized = bindText(values);
  if (serialized === undefined || values.length !== expectedBindCount(sql)) return undefined;
  return bound({
    statements: 1,
    bytes: utf8(sql) + utf8(serialized),
  });
}

function one(
  sql: string,
  values: readonly unknown[],
  nativeRows: number,
  nativePoints: number,
  identityMetadataRows: number,
  resultBytes: number,
  candidateKeys = 0,
  emptySeeks = 0,
): Bound | undefined {
  const query = base(sql, values);
  if (!query) return undefined;
  return sumBounds(
    query,
    bound({
      candidateKeys,
      nativeRows,
      identityMetadataRows,
      nativePoints,
      emptySeeks,
      bytes: resultBytes,
    }),
  );
}

function count(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
}

function ranged(
  sql: string,
  values: readonly unknown[],
  limitParameter: number,
  resultBytesPerItem: number,
  candidates: boolean,
  max = 100,
  itemDeclaration?: Bound,
): Bound | undefined {
  const n = count(values[limitParameter - 1], max);
  const query = base(sql, values);
  if (n === undefined || !query) return undefined;
  const item = sumBounds(
    itemDeclaration ?? bound({ candidateKeys: candidates ? 1 : 0, nativeRows: 1 }),
    bound({ bytes: resultBytesPerItem }),
  );
  const tail = bound({ nativeRows: 1, nativePoints: 1, emptySeeks: 1 });
  const actual = sumBounds(query, repeatBound(item, n), tail);
  const ceiling = sumBounds(query, repeatBound(item, max), tail);
  return withinCeiling(actual, ceiling) ? actual : undefined;
}

function repeatedRows(
  sql: string,
  values: readonly unknown[],
  inputIndex: number,
  rowsPerItem: number,
  pointsPerItem: number,
  metadataPerItem: number,
  bytesPerItem: number,
  max = 100,
): Bound | undefined {
  const source = values[inputIndex];
  const n = Array.isArray(source) ? count(source.length, max) : undefined;
  const query = base(sql, values);
  if (n === undefined || !query) return undefined;
  const item = bound({
    nativeRows: rowsPerItem,
    identityMetadataRows: metadataPerItem,
    emptySeeks: 1,
    nativePoints: pointsPerItem,
    bytes: bytesPerItem,
  });
  const actual = sumBounds(query, repeatBound(item, n));
  const ceiling = sumBounds(query, repeatBound(item, max));
  return withinCeiling(actual, ceiling) ? actual : undefined;
}

function declaredPoint(
  sql: string,
  values: readonly unknown[],
  declaration: Readonly<{ work: Bound; resultBytes: number }>,
): Bound | undefined {
  const statement = base(sql, values);
  return statement ? sumBounds(statement, declaration.work, bound({ bytes: declaration.resultBytes })) : undefined;
}

function sqlOf(query: QueryText): string {
  return query.sql;
}

const boundId = 'f'.repeat(36);
const boundDecimal = '9'.repeat(20);
const boundText = String.fromCharCode(1);

export const IDENTITY_BASIS_BINDINGS: Readonly<Record<string, unknown>> = Object.freeze({
  route: 65535,
  account_route: 65535,
  partition_no: 4095,
  owner_epoch: 2147483647,
  collection_id: boundId,
  account_id: boundId,
  capture_id: boundId,
  output_generation: boundId,
  publication_transaction_id: boundId,
  publication_position: boundDecimal,
  incarnation: boundText.repeat(128),
  generation: boundDecimal,
  scope: 'active_explicit_output',
  receiving_epoch: boundDecimal,
  effect_key: boundText.repeat(256),
  collection_fence: boundDecimal,
  account_fence: boundDecimal,
});

export function identityBasisBindValues(params: readonly string[]): unknown[] {
  return params.map((name) => IDENTITY_BASIS_BINDINGS[name] ?? boundId);
}

export function createIdentityNativeBounds(catalog: IdentityNativeCatalog) {
  const basisBindCeiling = new Map(
    catalog.basisQueries.map((query) => {
      const values = identityBasisBindValues(query.params ?? []);
      return [normalize(query.sql), utf8(JSON.stringify(values))];
    }),
  );

  function sourceBasisBound(sql: string, values: readonly unknown[]): Bound | undefined {
    const query = catalog.basisQueries.find((item) => equal(item.sql, sql));
    if (!query || values.length !== (query.params ?? []).length) return undefined;
    const serialized = bindText(values);
    const ceiling = basisBindCeiling.get(normalize(sql));
    if (serialized === undefined || ceiling === undefined || utf8(serialized) > ceiling) return undefined;
    const queryBound = base(sql, values);
    const work = catalog.basisWork.find((item) => equal(item.sql, sql));
    if (!queryBound || !work) return undefined;
    return sumBounds(
      queryBound,
      bound({
        nativeRows: work.nativeRows,
        nativePoints: work.nativePoints,
        identityMetadataRows: work.identityMetadataRows,
        emptySeeks: work.emptySeeks,
      }),
      bound({ bytes: work.resultBytes }),
    );
  }

  function nativeOperationBound(sql: string, values: readonly unknown[], work?: IdentityWorkHandle): Bound | undefined {
    if (!Array.isArray(values)) return undefined;
    if (catalog.basisQueries.some((item) => equal(item.sql, sql))) return sourceBasisBound(sql, values);
    if (!catalog.selectedBindCeiling(sql, values)) return undefined;
    const text = normalize(sql);
    const selected = catalog.selected;
    const point = (rows: number, points: number, metadata: number, output: number, candidates = 0, seeks = 0) =>
      one(sql, values, rows, points, metadata, output, candidates, seeks);
    if (
      [
        'BEGIN ISOLATION LEVEL SERIALIZABLE',
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
        'COMMIT',
        'ROLLBACK',
        "SET LOCAL lock_timeout = '200ms'",
      ].includes(text) ||
      /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(text)
    )
      return point(0, 0, 0, 0);
    if (equal(sql, sqlOf(catalog.time))) return point(0, 0, 0, 128);
    if (equal(sql, sqlOf(catalog.partition))) return point(1, 1, 1, 256, 0, 1);
    if (equal(sql, sqlOf(catalog.account))) return point(1, 1, 0, 64, 0, 1);
    if (equal(sql, sqlOf(catalog.noEffectFence)) && values[2] === null) return point(1, 1, 1, 64, 0, 1);
    if (equal(sql, sqlOf(catalog.fence)) && values[3] === null && values[4] === null) {
      if (values.length !== expectedBindCount(sql)) return undefined;
      const events = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
      if (
        !Array.isArray(events) ||
        events.length !== 1 ||
        events[0]?.type !== 'com.rezics.semantic.identity-epoch.admitted.v1'
      )
        return undefined;
      return point(2, 2, 1, 64);
    }
    if (equal(sql, sqlOf(catalog.commit)) && values[2] === 'library-private-follow-counts') return point(2, 2, 1, 64);
    const plan = selected.plan;
    if (plan && (equal(sql, plan.sql) || equal(sql, catalog.libraryIdentityBoundedPlanSQL)))
      return declaredPoint(sql, values, {
        work: bound({
          nativeRows: plan.rows,
          nativePoints: plan.points,
          identityMetadataRows: plan.metadata,
          emptySeeks: plan.seeks ?? 1,
          candidateKeys: plan.candidates ?? 0,
        }),
        resultBytes: plan.output,
      });
    if (equal(sql, sqlOf(catalog.plan)) || equal(sql, sqlOf(catalog.plan).replace(/;\s*$/, ' FOR UPDATE')))
      return point(1, 1, 0, catalog.planResultBytes, 0, 1);
    for (const name of ['current', 'job', 'seal'] as const) {
      const statement = selected[name];
      if (statement && equal(sql, statement.sql))
        return declaredPoint(sql, values, {
          work: bound({
            nativeRows: statement.rows,
            nativePoints: statement.points,
            identityMetadataRows: statement.metadata,
            emptySeeks: statement.seeks ?? 1,
            candidateKeys: statement.candidates ?? 0,
          }),
          resultBytes: statement.output,
        });
    }
    if (equal(sql, sqlOf(catalog.job))) return point(16, 13, 16, 2048, 0, 4);
    const page = selected.page;
    if (page && equal(sql, page.sql))
      return ranged(
        sql,
        values,
        6,
        page.output,
        true,
        100,
        bound({
          nativeRows: page.rows,
          nativePoints: page.points,
          identityMetadataRows: page.metadata,
          emptySeeks: page.seeks ?? 0,
          candidateKeys: page.candidates ?? 1,
        }),
      );
    if (equal(sql, catalog.libraryIdentityJobSizeSQL)) return point(1, 1, 1, 32, 0, 1);
    if (equal(sql, sqlOf(catalog.libraryTransform))) return point(3, 3, 2, 256, 0, 3);
    if (equal(sql, catalog.identityEpochLibraryInputsSQL)) return point(3, 1, 3, 512, 0, 1);
    if (equal(sql, sqlOf(catalog.savedJob))) {
      if (values.length !== expectedBindCount(sql) || bindText(values) === undefined) return undefined;
      const resultBound = work?.resultByteBound(`library-job:${values[1]}:${values[2]}`);
      if (
        resultBound === undefined ||
        !Number.isSafeInteger(resultBound) ||
        resultBound < 0 ||
        resultBound > Number.MAX_SAFE_INTEGER - 256
      )
        return undefined;
      return point(1, 1, 1, resultBound + 256, 0, 1);
    }
    if (equal(sql, sqlOf(catalog.inputs))) return point(3, 1, 3, 512, 0, 1);
    if (equal(sql, sqlOf(catalog.originals))) {
      const n = count(values[2], 100);
      if (n === undefined) return undefined;
      return point(n + 1, 1, n + 1, n * 256, 0, 1);
    }
    for (const [statement, rows, points, metadata, output] of [
      [sqlOf(catalog.owners), 1, 1, 1, 256],
      [sqlOf(catalog.sources), 4, 4, 4, 1024],
      [sqlOf(catalog.pending), 1, 1, 1, 256],
      [sqlOf(catalog.mapping), 2, 2, 2, 256],
    ] as const) {
      if (!equal(sql, statement)) continue;
      return repeatedRows(sql, values, 0, rows, points, metadata, output);
    }
    if (equal(sql, sqlOf(catalog.facts)) || equal(sql, sqlOf(catalog.labels))) return ranged(sql, values, 5, 256, true);
    for (const [name, sqlText] of Object.entries(catalog.libraryIdentitySQL)) {
      if (!equal(sql, sqlText)) continue;
      if (name === 'oldFacts') return ranged(sql, values, 8, 256, true);
      if (name === 'oldReferences') return ranged(sql, values, 7, 256, true);
      if (name === 'effectPage') return ranged(sql, values, 6, 512, true);
      const statement = base(sql, values);
      if (!statement) return undefined;
      const rows = name === 'insertPlan' ? 4 : name.startsWith('insert') || name.startsWith('detach') ? 2 : 1;
      return sumBounds(statement, bound({ nativeRows: rows, nativePoints: rows }), bound({ bytes: 64 }));
    }
    return undefined;
  }

  function selectedBound(sql: string, values: readonly unknown[]): Bound | undefined {
    if (!catalog.selectedBindCeiling(sql, values)) return undefined;
    const selected = Object.values(catalog.selected).some(
      (item) =>
        equal(item.sql, sql) || (item === catalog.selected.plan && equal(catalog.libraryIdentityBoundedPlanSQL, sql)),
    );
    if (!selected) return undefined;
    return nativeOperationBound(sql, values);
  }

  return {
    bound: nativeOperationBound,
    footprint(sql: string, values: readonly unknown[], work?: IdentityWorkHandle) {
      const value = nativeOperationBound(sql, values, work);
      return value ? workDimensions(value) : undefined;
    },
    selectedFootprint(sql: string, values: readonly unknown[]) {
      const value = selectedBound(sql, values);
      return value ? workDimensions(value) : undefined;
    },
    isFullPartitionSQL(sql: string) {
      return equal(sql, sqlOf(catalog.partition));
    },
    isSourceBasisSQL(sql: string) {
      return catalog.basisQueries.some((item) => equal(item.sql, sql));
    },
    sourceBasisFootprint(sql: string, values: readonly unknown[]) {
      const value = sourceBasisBound(sql, values);
      return value ? workDimensions(value) : undefined;
    },
    sourceBasisBound,
    selectedBound,
    jobSizeSQL: catalog.libraryIdentityJobSizeSQL,
    workDimensions,
  };
}
