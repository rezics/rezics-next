import type { WorkDimensions } from './collection-source.ts';
import accountQuery from './native-source-custody-account.sql';
import sourceQuery from './native-source-custody-source.sql';
import outputQuery from './native-source-custody-output.sql';
import fencesQuery from './native-source-custody-fences.sql';
import identityCapture from './identity-native-planner-source.sql';
import proofQuery from './native-source-custody-proof.sql';
import {
  LIBRARY_IDENTITY_SELECTED_STATEMENTS, LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
  libraryIdentitySelectedBindBound, libraryIdentityBoundedPlanSQL,
} from './identity-native-planner-projection.ts';

type Query = { sql: string; params: readonly string[] };
const sameSQL = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
export const nativeIdentityPartitionQuery: Query = {
  sql: `SELECT epoch, position::text AS position, write_state AS "writeState",
    CASE WHEN moved_to IS NULL THEN NULL ELSE '' END AS "movedTo"
    FROM core.partition WHERE partition_no=$1 FOR SHARE`,
  params: ['partition_no'],
};
const boundId = 'f'.repeat(36), boundDecimal = '9'.repeat(20), boundText = String.fromCharCode(1);
const basisBindings: Readonly<Record<string, unknown>> = Object.freeze({
  route: 65535, account_route: 65535, partition_no: 4095, owner_epoch: 2147483647,
  collection_id: boundId, account_id: boundId, capture_id: boundId, output_generation: boundId,
  publication_transaction_id: boundId, publication_position: boundDecimal,
  incarnation: boundText.repeat(128), generation: boundDecimal, scope: 'active_explicit_output',
  receiving_epoch: boundDecimal, effect_key: boundText.repeat(256),
  collection_fence: boundDecimal, account_fence: boundDecimal,
});
const basisQueries = [nativeIdentityPartitionQuery, accountQuery, sourceQuery, outputQuery, fencesQuery, identityCapture, proofQuery] as const;
const basisBindBounds = new Map(basisQueries.map((query) => [sameSQL(query.sql),
  Buffer.byteLength(JSON.stringify(query.params.map((name) => basisBindings[name]))),
]));
// Schema widths: after<=512 and tie<=64 UTF8 bytes. Include their maximum JSON escaping,
// not the typical UUID cursor, and distinguish the full read from the minimal current projection.
const currentCaptureProjectionBytes = Buffer.byteLength(JSON.stringify({
  captureId: boundId, collectionFence: boundDecimal, accountFence: boundDecimal, complete: false,
  driver: 'entry_deleted', after: boundText.repeat(512), tie: boundText.repeat(64), sessionId: boundId,
  scanned: boundDecimal, version: 2147483647,
}));
// Closed enum values and native integer/UUID columns bound the other current-basis results.
// The source incarnation is UUID ':' native timestamptz epoch text, within its native 128 bytes.
const basisResultBounds = new Map<Query, number>([
  [nativeIdentityPartitionQuery, Buffer.byteLength(JSON.stringify({ epoch: 2147483647, position: boundDecimal,
    writeState: 'active', movedTo: null }))],
  [accountQuery, Buffer.byteLength(JSON.stringify({ state: 'suspended', fenced: false, epoch: boundDecimal }))],
  [sourceQuery, Buffer.byteLength(JSON.stringify({ accountId: boundId, incarnation: boundText.repeat(128),
    generation: boundDecimal, state: 'deleted', kind: 'dynamic', builtin: 'everything', visibility: 'unlisted', ruleReady: false }))],
  [outputQuery, Buffer.byteLength(JSON.stringify({ generation: boundId, transactionId: boundId,
    position: boundDecimal, nativeXid: boundDecimal, members: boundDecimal, memberFence: boundDecimal, sourceGeneration: boundDecimal }))],
  [fencesQuery, Buffer.byteLength(JSON.stringify([{ kind: 'collection', generation: boundDecimal },
    { kind: 'account', generation: boundDecimal }]))],
  [identityCapture, currentCaptureProjectionBytes],
  [proofQuery, Buffer.byteLength(JSON.stringify({ transactionId: boundId, position: boundDecimal }))],
]);

const basisCosts: readonly (readonly [Query, number, number, number])[] = [
  [nativeIdentityPartitionQuery, 16, 1, 1], [accountQuery, 16, 1, 0], [sourceQuery, 16, 1, 0],
  [outputQuery, 56, 7, 1], [fencesQuery, 32, 2, 0], [identityCapture, 32, 1, 0], [proofQuery, 64, 3, 1],
];
function price(sql: string, values: readonly unknown[], rows: number, points: number, metadata: number,
  output: number, candidates = 0, seeks = points): WorkDimensions {
  return Object.freeze({ candidateKeys: candidates, nativeRows: rows, identityMetadataRows: metadata,
    nativePoints: points, witnessKeys: 0, statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + output, emptySeeks: seeks });
}
export function isNativeIdentitySourceBasisSQL(sql: string): boolean {
  return basisBindBounds.has(sameSQL(sql));
}
/** Shared by actual native dispatch and static installed pricing. No runtime grant,
 * callback, ledger or executable owner module is loaded to construct this data.
 */
export function nativeIdentitySourceBasisFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const text = sameSQL(sql);
  const found = basisCosts.find(([query]) => sameSQL(query.sql) === text);
  if (!found || values.length !== found[0].params.length ||
      Buffer.byteLength(JSON.stringify(values)) > basisBindBounds.get(text)!) return undefined;
  const [query, rows, points, metadata] = found;
  return price(sql, values, rows, points, metadata, basisResultBounds.get(query)!);
}
export function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{ sql: string; work: WorkDimensions; engineRequests: 0 }>[] {
  return Object.freeze(basisQueries.map((query) => Object.freeze({ sql: query.sql,
    work: nativeIdentitySourceBasisFootprint(query.sql, query.params.map((name) => basisBindings[name]))!,
    engineRequests: 0 as const,
  })));
}
/** The selected native body literals; ordinary pages retain their <=100 bound.
 * Multiplicity and selected limit1 are enforced separately before dispatch.
 */
export function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  if (!libraryIdentitySelectedBindBound(sql, values)) return undefined;
  const text = sameSQL(sql), selected = LIBRARY_IDENTITY_SELECTED_STATEMENTS;
  if ([sameSQL(selected.plan.sql), sameSQL(libraryIdentityBoundedPlanSQL)].includes(text))
    return price(sql, values, 1, 1, 0, LIBRARY_IDENTITY_PLAN_RESULT_BYTES, 0, 1);
  if (text === sameSQL(selected.current.sql)) return price(sql, values, 7, 7, 1, 64, 0, 1);
  if (text === sameSQL(selected.job.sql)) return price(sql, values, 16, 13, 16, 2048, 0, 4);
  if (text === sameSQL(selected.seal.sql)) return price(sql, values, 5, 5, 2, 256, 0, 1);
  if (text === sameSQL(selected.page.sql)) {
    const n = values[5];
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 100
      ? price(sql, values, n + 1, 1, 0, 512 * n, n, 1) : undefined;
  }
  return undefined;
}
