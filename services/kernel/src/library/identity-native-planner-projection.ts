import { sql as planSQL } from './identity-native-planner-read.sql';
import { sql as jobSQL } from './identity-native-planner-job.sql';
import { sql as currentSQL } from './identity-native-planner-current.sql';
import { sql as sealSQL } from './identity-scope-effects-seal.sql';
import { libraryIdentitySQL } from './identity-native-planner-statements.ts';

/** Bound an exact fragment in a compiled native statement without changing its parameter order or marker. */
function projectNativeSQL(sql: string, projections: readonly (readonly [string, string])[]): string {
  let projected = sql;
  for (const [selected, bounded] of projections) {
    const at = projected.indexOf(selected);
    if (at === -1 || projected.indexOf(selected, at + selected.length) !== -1)
      throw new Error(`Native Library projection requires exactly one ${selected}`);
    projected = projected.replace(selected, bounded);
  }
  return projected;
}

/** The SQL source owns the bounds so compiled formatting does not shape the native projection. */
export const libraryIdentityBoundedPlanSQL = planSQL;

// The actual admission producer writes a SHA256 hex digest. Do not return arbitrary stored text.
export const libraryIdentityBoundedJobSQL = projectNativeSQL(jobSQL, [
  [
    'j.scope_digest,\n jsonb_build_array',
    `CASE WHEN j.scope_digest ~ '^[0-9a-f]{64}$' THEN j.scope_digest ELSE NULL END AS scope_digest,\n jsonb_build_array`,
  ],
]);

/** Inclusive JSON projection from schema widths: four <=2048-byte JSON values, UTF8 scope <=256,
 * UUIDs, signed bigint decimal widths and the retained native state (two UUIDs/two <=256-byte bases).
 * A byte of text may require six JSON bytes; existing schema JSON limits already include escaping.
 */
const id = 'f'.repeat(36),
  bigint = '9'.repeat(20),
  text = String.fromCharCode(1);
export const LIBRARY_IDENTITY_PLAN_RESULT_BYTES = Buffer.byteLength(
  JSON.stringify({
    route: 65535,
    collection_id: id,
    plan_key: 'f'.repeat(64),
    source_identity: 'x'.repeat(2048),
    job_id: id,
    job_epoch: bigint,
    scope: text.repeat(256),
    generation: id,
    capture_id: id,
    capture_frontier: 'x'.repeat(2048),
    collection_fence: bigint,
    account_fence: bigint,
    job_transaction_id: id,
    scope_digest: 'f'.repeat(64),
    job_writer_fence: 'x'.repeat(2048),
    phase: 'old-references',
    driver: 'session',
    after_subject: id,
    after_fact: id,
    version: bigint,
    state: 'invalidated',
    old_head: id,
    old_state: {
      readyGeneration: id,
      readyBasis: text.repeat(256),
      workingGeneration: id,
      workingBasis: text.repeat(256),
    },
    seal_transaction_id: id,
    frontier: 'x'.repeat(2048),
    projection_valid: false,
  }),
);

// The native writer's immutable effect key is library-native:SHA256(operation), never user text.
export const libraryIdentityBoundedEffectPageSQL = projectNativeSQL(libraryIdentitySQL.effectPage, [
  [
    'SELECT effect_key,',
    "SELECT CASE WHEN effect_key ~ '^library-native:[0-9a-f]{64}$' THEN effect_key ELSE NULL END AS effect_key,",
  ],
]);

// Maximum ORIGINAL JSON binds, derived from the native source/plan field widths. A control byte
// is the largest JSON encoding of one allowed UTF8 byte. No caller can enlarge these declarations.
const nativeId = 'f'.repeat(36),
  decimal = '9'.repeat(20),
  escaped = String.fromCharCode(1);
export const LIBRARY_IDENTITY_SELECTED_STATEMENTS = Object.freeze({
  plan: Object.freeze({
    sql: libraryIdentityBoundedPlanSQL.replace(/;\s*$/, ' FOR UPDATE'),
    values: Object.freeze([65535, nativeId, 'f'.repeat(64)]),
  }),
  current: Object.freeze({
    sql: currentSQL,
    values: Object.freeze([
      65535,
      nativeId,
      nativeId,
      65535,
      nativeId,
      2147483647,
      escaped.repeat(128),
      decimal,
      'active_explicit_output',
      decimal,
      escaped.repeat(256),
      decimal,
      decimal,
      2147483647,
      decimal,
    ]),
  }),
  job: Object.freeze({ sql: libraryIdentityBoundedJobSQL, values: Object.freeze([4095, nativeId, decimal]) }),
  seal: Object.freeze({ sql: sealSQL, values: Object.freeze([65535, nativeId, 'f'.repeat(64)]) }),
  page: Object.freeze({
    sql: libraryIdentityBoundedEffectPageSQL,
    values: Object.freeze([65535, nativeId, 'f'.repeat(64), escaped.repeat(256), 'first-apply', 1]),
  }),
});

/** Bound original serialized binds before dispatch, including invalid/foreign runtime inputs.
 * Ordinary <=100 paging keeps its own enforced LIMIT; only the selected original declares LIMIT1.
 */
export function libraryIdentitySelectedBindBound(sql: string, values: readonly unknown[]): boolean {
  const normalize = (text: string) =>
    text
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/;$/, '');
  const identity = normalize(sql);
  const statement = Object.values(LIBRARY_IDENTITY_SELECTED_STATEMENTS).find(
    (item) =>
      normalize(item.sql) === identity ||
      (item === LIBRARY_IDENTITY_SELECTED_STATEMENTS.plan && normalize(libraryIdentityBoundedPlanSQL) === identity),
  );
  if (!statement) return true;
  const binds = JSON.stringify(values, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
  const ordinaryLimitDigits = statement === LIBRARY_IDENTITY_SELECTED_STATEMENTS.page ? 2 : 0;
  return (
    values.length === statement.values.length &&
    Buffer.byteLength(binds) <= Buffer.byteLength(JSON.stringify(statement.values)) + ordinaryLimitDigits
  );
}
