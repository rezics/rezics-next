import plan from './identity-native-planner-read.sql';
import job from './identity-native-planner-job.sql';
import current from './identity-native-planner-current.sql';
import seal from './identity-scope-effects-seal.sql';
import { libraryIdentitySQL } from './identity-native-planner-statements.ts';

const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const fields = ['readyGeneration', 'readyBasis', 'workingGeneration', 'workingBasis'] as const;
// These are the four native retained-state fields, not an arbitrary JSON intent size cap.
const oldShape = `jsonb_build_object(${fields.map((field) => `'${field}',old_state->'${field}'`).join(',')})`;
const oldValid = `(old_state IS NULL OR (jsonb_typeof(old_state)='object'
 AND old_state=${oldShape} AND ${fields
   .map(
     (field) =>
       `(old_state->'${field}'='null'::jsonb OR (jsonb_typeof(old_state->'${field}')='string' AND ${
         field.endsWith('Generation')
           ? `old_state->>'${field}' ~ '${uuid}'`
           : `octet_length(old_state->>'${field}') BETWEEN 1 AND 256`
       }))`,
   )
   .join(' AND ')}
 AND (old_state->'readyGeneration'='null'::jsonb)=(old_state->'readyBasis'='null'::jsonb)
 AND (old_state->'workingGeneration'='null'::jsonb)=(old_state->'workingBasis'='null'::jsonb)))`;
const digestValid = "scope_digest ~ '^[0-9a-f]{64}$'";

/** Invalid native state is returned as a bounded invalid marker, never truncated or treated as absent. */
export const libraryIdentityBoundedPlanSQL = plan.sql
  .replace('scope_digest,', `CASE WHEN ${digestValid} THEN scope_digest ELSE NULL END AS scope_digest,`)
  .replace('old_state,', `CASE WHEN ${oldValid} THEN old_state ELSE NULL END AS old_state,`)
  .replace(
    'FROM library.identity_scope_plan',
    `, (${digestValid} AND ${oldValid}) AS projection_valid FROM library.identity_scope_plan`,
  );

// The actual admission producer writes a SHA256 hex digest. Do not return arbitrary stored text.
export const libraryIdentityBoundedJobSQL = job.sql.replace(
  'j.scope_digest,\n jsonb_build_array',
  `CASE WHEN j.scope_digest ~ '^[0-9a-f]{64}$' THEN j.scope_digest ELSE NULL END AS scope_digest,\n jsonb_build_array`,
);

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
export const libraryIdentityBoundedEffectPageSQL = libraryIdentitySQL.effectPage.replace(
  'SELECT effect_key,',
  "SELECT CASE WHEN effect_key ~ '^library-native:[0-9a-f]{64}$' THEN effect_key ELSE NULL END AS effect_key,",
);

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
    sql: current.sql,
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
  seal: Object.freeze({ sql: seal.sql, values: Object.freeze([65535, nativeId, 'f'.repeat(64)]) }),
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
