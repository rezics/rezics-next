import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkDimensions } from '../library/collection-source.ts';

const dimensions = (rows: number, points: number, statements: number, bytes: number, emptySeeks: number): WorkDimensions =>
  Object.freeze({ candidateKeys: 0, identityMetadataRows: 0, nativeRows: rows, nativePoints: points,
    witnessKeys: 0, statements, bytes, emptySeeks });
const legalRole = "('actor','author','editor','acting-human','delegate','owner','subject','operator')";
const roleProjection = `account_id::text, CASE WHEN octet_length(role)<=12 THEN CASE WHEN role IN ${legalRole} THEN role END END AS role`;
const delegated = "CASE WHEN octet_length(requested_by)=92 THEN requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' ELSE false END";
/** Each LIMIT is ONE indexed seek. Completeness follows only from reaching the actual empty seek.
 * No aggregate count, history scan, maintenance-role cap or result-dependent free dispatch.
 */
export const searchReceivingCaptureStatements = Object.freeze({
  enable: "SELECT set_config('semantic.identity_receiving_capture','on',true)",
  next: `SELECT q.ordinal::text,q.partition_no,q.store,q.record_key::text,
    coalesce(q.source_transaction_id,j.recorded_transaction_id)::text AS source_transaction_id,
    nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid::text AS native_transaction_id
    FROM semantic.identity_receiving_capture_pending q
    LEFT JOIN semantic.identity_epoch_job j ON j.partition_no=q.partition_no AND j.job_id=q.job_id
    WHERE q.transaction_xid=pg_current_xact_id()::text AND q.ordinal>$1::bigint ORDER BY q.ordinal LIMIT 1`,
  copyFirst: `SELECT ${roleProjection} FROM semantic.erasure_copy_role
    WHERE partition_no=$1 AND store=$2 AND record_key=$3 AND transaction_id=$4
    ORDER BY erasure_copy_role.account_id,erasure_copy_role.role LIMIT 1`,
  copyNext: `SELECT ${roleProjection} FROM semantic.erasure_copy_role
    WHERE partition_no=$1 AND store=$2 AND record_key=$3 AND transaction_id=$4
    AND (account_id,role)>($5::uuid,$6::text) ORDER BY erasure_copy_role.account_id,erasure_copy_role.role LIMIT 1`,
  sourceFirst: `SELECT ${roleProjection} FROM semantic.erasure_source_role
    WHERE partition_no=$1 AND transaction_id=$2 ORDER BY erasure_source_role.account_id,erasure_source_role.role LIMIT 1`,
  sourceNext: `SELECT ${roleProjection} FROM semantic.erasure_source_role
    WHERE partition_no=$1 AND transaction_id=$2 AND (account_id,role)>($3::uuid,$4::text)
    ORDER BY erasure_source_role.account_id,erasure_source_role.role LIMIT 1`,
  basis: `SELECT principal_kind='account' AS actor,${delegated} AS delegated,
    CASE WHEN octet_length(requested_by)=92 THEN 92 ELSE 0 END AS requested_bytes
    FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2`,
  arm: `UPDATE semantic.identity_receiving_capture_pending SET source_transaction_id=$2,
    native_transaction_id=$3,copy_roles=$4,source_roles=$5,basis_locators=$6,basis_bytes=$7,
    native_basis_locators=$8,native_basis_bytes=$9,copy_identity=$10,source_identity=$11,armed=true
    WHERE transaction_xid=pg_current_xact_id()::text AND ordinal=$1 AND NOT armed RETURNING ordinal`,
});
export const searchReceivingCaptureStatementCosts = Object.freeze(Object.entries(searchReceivingCaptureStatements).map(
  ([name, sql]) => Object.freeze({ sql, work: name === 'enable' ? dimensions(1, 0, 1, 128, 0)
    : name === 'next' ? dimensions(2, 2, 1, 512, 1)
      : name === 'arm' ? dimensions(1, 1, 1, 1024, 0)
      : dimensions(1, 1, 1, 256, 1) })));

type OriginalRole = Readonly<{ account_id: string; role: string | null }>;
type Basis = Readonly<{ locators: number; bytes: number }>;
const fixed = dimensions(8, 8, 8, 2048, 5);
const role = dimensions(10, 10, 9, 3072, 5);
// A distinct native origin adds its write-basis lookup in the deferred body.
// The planner's actually dispatched lookup is independently instrumented.
const nativeOrigin = dimensions(1, 1, 1, 256, 1);
// Additional identity state: 128 parameter bytes, 128 pending-row bytes,
// 128 deferred projection bytes and two 64-byte rolling states. The arm SQL's
// own text/parameters/result are independently prepaid in its 1024-byte bound.
const originControl = dimensions(0, 0, 0, 1536, 0);
// Per visited role, including repeats/refusals: bounded UUID/role key, origin
// reference and temporary key construction (512 bytes), plus BOTH planner and
// deferred identity hashing (512 bytes). Each hash uses at most a 160-byte UTF8
// frame, 32-byte binary digest and 64-byte hex result. No row, point, statement,
// key, witness, metadata or seek is added by these in-memory transformations.
const originMemory = dimensions(0, 0, 0, 1024, 0);
// One bounded state per complete prefix, not one retained object per identity.
// The same framing is verified by the deferred native body. Counts alone do not
// detect replacement of a role between planning and the actual native COMMIT.
const emptyIdentity = '0'.repeat(64);
function appendIdentity(previous: string, kind: 'copy' | 'source', transaction: string, row: OriginalRole): string {
  return createHash('sha256').update(`${previous}|${kind}|${transaction}|${row.account_id}|${row.role}`).digest('hex');
}
function unavailable(detail: string): Error {
  return Object.assign(new Error(`Search receiving capture unavailable funding: ${detail}`), { code: 'identity_epoch_unavailable' });
}
/** Deferred physical I/O subtotal, separate from instrumented planner SQL and bookkeeping.
 * The planner additionally prepays identity hashing in BOTH bodies via originControl/originMemory.
 * copyRoles counts both complete, distinct transaction prefixes. The fixed eight
 * rows/points/statements cover budget read/consume, partition, both copy EOFs,
 * both source EOFs and the original basis probe. A distinct native basis probe
 * remains additional. Shared origins conservatively retain the same base.
 * The optional fourth operand describes a DISTINCT native transaction: null means its
 * basis is absent; undefined means no distinct native origin. This retains the original
 * conservative five-seek layout, not a repaired whole Source quote or an allowance.
 * Zero candidate/metadata/witness work describes these operational capture bodies only.
 */
export function searchReceivingCaptureCost(copyRoles: number, sourceRoles: number, basis: Basis | null,
  nativeBasis?: Basis | null): WorkDimensions {
  const count = copyRoles + sourceRoles;
  if (![copyRoles, sourceRoles, count, basis?.locators ?? 0, basis?.bytes ?? 0,
    nativeBasis?.locators ?? 0, nativeBasis?.bytes ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0)
    || [basis, nativeBasis].some((value) => value && (value.locators > 5 || value.bytes > 92)))
    throw new TypeError('Invalid complete receiving capture cost');
  const locators = basis?.locators ?? 0;
  const nativeProbe = nativeBasis === undefined ? dimensions(0, 0, 0, 0, 0) : nativeOrigin;
  const nativeBody = nativeBasis ? basisCost(nativeBasis) : dimensions(0, 0, 0, 0, 0);
  const result = dimensions(fixed.nativeRows + count * role.nativeRows + (basis ? 2 + 9 * locators : 0) + nativeProbe.nativeRows + nativeBody.nativeRows,
    fixed.nativePoints + count * role.nativePoints + (basis ? 2 + 9 * locators : 0) + nativeProbe.nativePoints + nativeBody.nativePoints,
    fixed.statements + count * role.statements + (basis ? 2 + 8 * locators : 0) + nativeProbe.statements + nativeBody.statements,
    fixed.bytes + count * role.bytes + (basis ? 512 + basis.bytes + 2816 * locators : 0) + nativeProbe.bytes + nativeBody.bytes,
    fixed.emptySeeks + count * role.emptySeeks + 5 * locators + nativeProbe.emptySeeks + nativeBody.emptySeeks);
  if (!Object.values(result).every(Number.isSafeInteger)) throw unavailable('complete original cardinality overflow');
  return result;
}

function basisCost(basis: Basis): WorkDimensions {
  return dimensions(2 + 9 * basis.locators, 2 + 9 * basis.locators, 2 + 8 * basis.locators,
    512 + basis.bytes + 2816 * basis.locators, 5 * basis.locators);
}

/** Called on the SAME actual client after command callbacks and its native fence, before COMMIT.
 * reserve debits the existing eight-axis AND native frame. Every traversal SQL is independently
 * instrumented before dispatch. A failed/refused/rolled-back attempt retains all admitted work.
 */
export async function prepareSearchReceivingCaptures(client: PoolClient, reserve: (cost: WorkDimensions) => void): Promise<void> {
  let after = '0';
  for (;;) {
    const entry = (await client.query<{ ordinal: string; partition_no: number; store: string; record_key: string;
      source_transaction_id: string | null; native_transaction_id: string | null }>(searchReceivingCaptureStatements.next, [after])).rows[0];
    if (!entry) return;
    const { ordinal, partition_no: home, store, record_key: key, source_transaction_id: original, native_transaction_id: native } = entry;
    if (!original) throw unavailable('original job transaction is absent');
    reserve(fixed);
    reserve(originControl);
    const transactions = [...new Set([original, native].filter((id): id is string => id !== null))];
    if (transactions.length === 2) reserve(nativeOrigin);
    let copies = 0, sources = 0;
    let copyIdentity = emptyIdentity, sourceIdentity = emptyIdentity;
    // Explicit copies retain their genuine origins in the native directory. Gather
    // BOTH complete copy prefixes before considering carried source roles. The
    // conservative source-only collision guard still requires complete Source
    // support/copy closure; it must not discard an explicitly registered copy.
    const origins = new Map<string, Set<string>>();
    const retainOrigin = (row: OriginalRole, transaction: string, copy = false) => {
      reserve(originMemory);
      const locatorKey = JSON.stringify([row.account_id, row.role]);
      const previous = origins.get(locatorKey);
      if (!copy && previous !== undefined && !previous.has(transaction)) throw Object.assign(
        new Error('Search receiving capture unavailable provenance: shared locator cannot retain distinct transaction origins'),
        { code: 'identity_epoch_unavailable' });
      if (previous) previous.add(transaction);
      else origins.set(locatorKey, new Set([transaction]));
    };
    for (const transaction of transactions) {
      let previous: OriginalRole | undefined;
      for (;;) {
        const row: OriginalRole | undefined = (await client.query<OriginalRole>(previous
          ? searchReceivingCaptureStatements.copyNext : searchReceivingCaptureStatements.copyFirst,
        previous ? [home, store, key, transaction, previous.account_id, previous.role] : [home, store, key, transaction])).rows[0];
        if (!row) break;
        if (!row.role) throw unavailable('original copy role is not a legal erasure locator role');
        reserve(role);
        retainOrigin(row, transaction, true);
        copyIdentity = appendIdentity(copyIdentity, 'copy', transaction, row);
        copies++;
        previous = row;
      }
    }
    for (const transaction of transactions) {
      let previous: OriginalRole | undefined;
      for (;;) {
        const row: OriginalRole | undefined = (await client.query<OriginalRole>(previous
          ? searchReceivingCaptureStatements.sourceNext : searchReceivingCaptureStatements.sourceFirst,
        previous ? [home, transaction, previous.account_id, previous.role] : [home, transaction])).rows[0];
        if (!row) break;
        if (!row.role) throw unavailable('original source role is not a legal erasure locator role');
        reserve(role);
        retainOrigin(row, transaction);
        sourceIdentity = appendIdentity(sourceIdentity, 'source', transaction, row);
        sources++;
        previous = row;
      }
    }
    const bases: (Basis | null)[] = [];
    for (const transaction of transactions) {
      const row = (await client.query<{ actor: boolean; delegated: boolean; requested_bytes: number }>(
        searchReceivingCaptureStatements.basis, [home, transaction])).rows[0];
      const basis = row ? { locators: (row.actor ? 2 : 0) + (row.delegated ? 3 : 0), bytes: row.requested_bytes } : null;
      if (basis) reserve(basisCost(basis));
      bases.push(basis);
    }
    const [basis, nativeBasis] = bases;
    const armed = await client.query(searchReceivingCaptureStatements.arm,
      [ordinal, original, native, copies, sources, basis?.locators ?? null, basis?.bytes ?? null,
        nativeBasis?.locators ?? null, nativeBasis?.bytes ?? null, copyIdentity, sourceIdentity]);
    if (armed.rowCount !== 1) throw unavailable('capture event was already armed or changed');
    after = ordinal;
  }
}
