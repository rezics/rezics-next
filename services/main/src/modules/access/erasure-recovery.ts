import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResult } from 'pg';
import { contentErasureDigest, erasureReceiptIri } from '../erasure/request.ts';
import { ERASURE_JOURNAL_EPOCH } from '../erasure/journal.ts';
import { accessAuthorityValues, accessRecoveryCatalog, accessRecoveryRule,
  resetAccessRecoveryState, scanAccessOutbox, scanAccessTables } from '../work/access-recovery-coverage.ts';
import { canonicalRowText, ownerCatalog, type OwnerTable, type RowCoverage } from '../work/pg-recovery-frontier.ts';

export const ACCESS_ERASURE_RECOVERY_CATALOG_VERSION = 2 as const;
export const ACCESS_ERASURE_RECOVERY_VERSION = 1 as const;
export const ACCESS_ERASURE_RECOVERY_PAGE = 1000;
export const ACCESS_ERASURE_RECOVERY_PROFILE = 'rezics-access-erasure-recovery-v1' as const;

const IMPORT_ORDER = [
  'access.admission',
  'access.admission_receipt',
  'access.outbox',
  'access.discovery_source_change',
  'access.also_enjoyed_source_change',
] as const;
const IMPORTABLE = new Set<string>(IMPORT_ORDER);
const SOURCE_INVALIDATIONS = new Set<string>([
  'access.discovery_source_change',
  'access.also_enjoyed_source_change',
]);
const ERASURE_OUTBOX_KINDS = new Set(['admission.registered', 'admission.claimed', 'admission.sealed']);

export class AccessErasureRecoveryConflict extends Error {}

export interface AccessErasureRecoveryHeader {
  kind: 'header';
  profile: typeof ACCESS_ERASURE_RECOVERY_PROFILE;
  version: typeof ACCESS_ERASURE_RECOVERY_VERSION;
  /** Absent means the original raw-catalog, access-state-v5 attachment. */
  catalogVersion?: 1 | 2;
  legacyBaseState?: RowCoverage;
  catalogDigest: string;
  baseFenceGeneration: string;
  sourceFenceGeneration: string;
  baseState: RowCoverage;
  sourceState: RowCoverage;
  baseOutbox: RowCoverage;
  sourceOutbox: RowCoverage;
}

/** A database-native row represented as exact PostgreSQL text values. */
export interface AccessErasureRecoveryRow {
  kind: 'row';
  table: string;
  key: Record<string, string>;
  values: Record<string, unknown>;
}

export interface AccessErasureRecoveryFooter {
  kind: 'end';
  profile: typeof ACCESS_ERASURE_RECOVERY_PROFILE;
  version: typeof ACCESS_ERASURE_RECOVERY_VERSION;
  /** Absent means the original raw-catalog, access-state-v5 attachment. */
  catalogVersion?: 1 | 2;
  legacyBaseState?: RowCoverage;
  catalogDigest: string;
  rowCount: string;
  rowDigest: string;
}

export interface AccessErasureRecoverySummary {
  profile: typeof ACCESS_ERASURE_RECOVERY_PROFILE;
  version: typeof ACCESS_ERASURE_RECOVERY_VERSION;
  /** Absent means the original raw-catalog, access-state-v5 attachment. */
  catalogVersion?: 1 | 2;
  legacyBaseState?: RowCoverage;
  catalogDigest: string;
  baseFenceGeneration: string;
  sourceFenceGeneration: string;
  baseState: RowCoverage;
  sourceState: RowCoverage;
  baseOutbox: RowCoverage;
  sourceOutbox: RowCoverage;
  rowCount: string;
  rowDigest: string;
  plaintextBytes: string;
  plaintextDigest: string;
}

export interface AccessErasureRecoveryExpectation extends AccessErasureRecoverySummary {}

export interface NativeAccessErasureAdmission {
  id: string;
  principalId: string;
  actingSubject: string;
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
  authorityEpoch: string;
  terminalEpoch: string;
  targetResource: string;
}

export type AccessErasureAdmissionVerifier = (
  admissions: readonly NativeAccessErasureAdmission[],
) => Promise<void>;

/** Reuse the public request digest helper for the ordered native journal targets. */
export function assertPublicRevisionErasureRequestDigest(admission: NativeAccessErasureAdmission,
  revisionIds: readonly string[]): void {
  if (!revisionIds.length || contentErasureDigest({ actingSubject: admission.actingSubject,
    resourceId: admission.targetResource, revisionIds: [...revisionIds] }) !== admission.requestDigest) {
    throw new AccessErasureRecoveryConflict('native Access erasure digest differs from its exact journal targets');
  }
}

interface NativeRow {
  key: Record<string, string>;
  values: Record<string, unknown>;
  building?: boolean;
}

interface NativeColumn { name: string; type: 'json' | 'jsonb' | 'text'; generated: boolean }

interface FenceRow { open: boolean; generation: string }

const ident = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const relation = (table: OwnerTable): string => `${ident(table.schema)}.${ident(table.table)}`;

async function nativeAccessCatalog(client: PoolClient, version: 1 | 2 = 2) {
  try { const catalog = await ownerCatalog(client);
    return version === 1 ? catalog : accessRecoveryCatalog(catalog); }
  catch (error) {
    throw new AccessErasureRecoveryConflict(error instanceof Error ? error.message
      : 'Access native catalog is unavailable', { cause: error });
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireTimestamp(values: Record<string, unknown>, column: string): void {
  const value = textValue(values[column]);
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new AccessErasureRecoveryConflict(`native Access erasure row is missing ${column}`);
  }
}

function isNativeJsonValue(value: unknown): value is { $rezicsNativeJson: 'sql-null' } |
  { $rezicsNativeJson: 'value'; $value: string } {
  if (!isObject(value)) return false;
  if (value.$rezicsNativeJson === 'sql-null') {
    return Object.keys(value).length === 1;
  }
  return value.$rezicsNativeJson === 'value' && Object.keys(value).length === 2
    && typeof value.$value === 'string';
}

function incomingRowsSql(table: OwnerTable, columns: readonly NativeColumn[]): string {
  const jsonColumns = columns.filter(column => column.type !== 'text');
  const stripJson = jsonColumns.length
    ? `raw.wire - ARRAY[${jsonColumns.map(column => `'${column.name.replaceAll("'", "''")}'`).join(',')}]::text[]`
    : 'raw.wire';
  const populate = `jsonb_populate_record(NULL::${relation(table)}, ${stripJson})`;
  const projection = columns.map(column => {
    if (column.type === 'text') return `native.${ident(column.name)}`;
    const jsonValue = `raw.wire->'${column.name.replaceAll("'", "''")}'`;
    return `CASE WHEN ${jsonValue}->>'$rezicsNativeJson' = 'sql-null' THEN NULL::${column.type}
      ELSE (${jsonValue}->>'$value')::${column.type} END AS ${ident(column.name)}`;
  });
  return `WITH raw AS (SELECT value AS wire FROM jsonb_array_elements($1::jsonb)), incoming AS (
    SELECT ${projection.join(', ')} FROM raw CROSS JOIN LATERAL ${populate} AS native
  )`;
}

function rowDigestUpdate(hash: ReturnType<typeof createHash>, line: string): void {
  hash.update(line, 'utf8').update('\n');
}

async function readFence(client: PoolClient): Promise<FenceRow> {
  const row = (await client.query<FenceRow>(
    'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
  if (!row || !/^(0|[1-9][0-9]*)$/.test(row.generation)) {
    throw new AccessErasureRecoveryConflict('Access recovery fence is unavailable');
  }
  if (row.open) throw new AccessErasureRecoveryConflict('Access recovery fence must stay closed during capture');
  return row;
}

async function columnsFor(client: PoolClient, table: OwnerTable): Promise<NativeColumn[]> {
  const result = await client.query<{ name: string; type: string; generated: boolean }>(`SELECT a.attname::text AS name,
      format_type(a.atttypid, a.atttypmod) AS type, a.attgenerated <> '' AS generated
    FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`, [`${ident(table.schema)}.${ident(table.table)}`]);
  if (result.rows.length === 0) throw new AccessErasureRecoveryConflict(`Access table schema is unavailable: ${table.name}`);
  return result.rows.map(row => ({ name: row.name, generated: row.generated,
    type: row.type === 'json' || row.type === 'jsonb' ? row.type : 'text' }));
}

async function* nativeRows(client: PoolClient, table: OwnerTable,
  columns: readonly NativeColumn[]): AsyncGenerator<NativeRow> {
  const tableRef = relation(table);
  const keyObject = `jsonb_build_object(${table.key.flatMap(key => [
    `'${key.replaceAll("'", "''")}'`, `t.${ident(key)}::text`,
  ]).join(', ')})`;
  // Keep native JSON as database text so JavaScript never rounds PostgreSQL numeric values.
  const valuesObject = `jsonb_build_object(${columns.flatMap(column => [
    `'${column.name.replaceAll("'", "''")}'`, column.type === 'text'
      ? `CASE WHEN t.${ident(column.name)} IS NULL THEN NULL ELSE to_jsonb(t.${ident(column.name)}::text) END`
      : `CASE WHEN t.${ident(column.name)} IS NULL THEN jsonb_build_object('$rezicsNativeJson','sql-null')
         ELSE jsonb_build_object('$rezicsNativeJson','value','$value',t.${ident(column.name)}::text) END`,
  ]).join(', ')})`;
  const rule = accessRecoveryRule(table);
  const building = rule.generationColumn
    ? `, EXISTS (SELECT 1 FROM access.derived_generation g WHERE g.id = t.${ident(rule.generationColumn)} AND g.state = 'building') AS building` : '';
  const authoritative = rule.authorityWhere ? `, (${rule.authorityWhere}) AS authoritative` : '';
  const select = `SELECT ${keyObject}::text AS key, ${valuesObject}::text AS values${building}${authoritative} FROM ${tableRef} t`;
  const keyTerms = table.key.map((column, index) => `t.${ident(column)}`);
  const order = `ORDER BY ${keyTerms.join(', ')} LIMIT ${ACCESS_ERASURE_RECOVERY_PAGE}`;
  const resume = `${select} WHERE (${keyTerms.join(', ')}) > (${table.keyTypes
    .map((type, index) => `$${index + 1}::${type}`).join(', ')}) ${order}`;
  let after: string[] | null = null;
  for (;;) {
    const result = await client.query<{ key: string; values: string; building?: boolean; authoritative?: boolean }>(
      after ? resume : `${select} ${order}`, after ?? []);
    for (const row of result.rows) {
      const key = JSON.parse(row.key) as Record<string, string>;
      const values = JSON.parse(row.values) as Record<string, unknown>;
      after = table.key.map(column => key[column]!);
      if ((!rule.generationPayload || row.building !== true) && (!rule.authorityWhere || row.authoritative !== false)) {
        yield { key, values, building: row.building };
      }
    }
    if (result.rows.length < ACCESS_ERASURE_RECOVERY_PAGE) return;
  }
}

function strictDeltaGeneration(base: string, source: string): 'same' | 'reopened' {
  const before = BigInt(base), after = BigInt(source);
  if (after === before) return 'same';
  if (after === before + 2n) return 'reopened';
  throw new AccessErasureRecoveryConflict('Access fence movement is outside the retained reopen/refence transition');
}

function validateTerminalAdmission(row: NativeRow): NativeAccessErasureAdmission {
  const value = row.values;
  const id = textValue(value.id);
  const principalId = textValue(value.principal_id);
  const actingSubject = textValue(value.acting_subject);
  const scope = textValue(value.scope_id);
  const action = textValue(value.action);
  const idempotencyKey = textValue(value.idempotency_key);
  const requestDigest = textValue(value.request_digest);
  const authorityEpoch = textValue(value.authority_epoch);
  const terminalEpoch = textValue(value.graph_sequence);
  const graphDataEpoch = textValue(value.graph_data_epoch);
  const outcome = textValue(value.graph_outcome);
  const receipt = textValue(value.graph_receipt);
  const state = textValue(value.state);
  const expiresAt = textValue(value.expires_at);
  const registeredAt = textValue(value.registered_at);
  const claimedAt = textValue(value.claimed_at);
  const sealedAt = textValue(value.sealed_at);
  const resource = scope?.startsWith('erasure:') ? scope.slice('erasure:'.length) : '';
  const invalid: string[] = [];
  if (!id) invalid.push('id');
  if (!principalId) invalid.push('principal_id');
  if (!actingSubject) invalid.push('acting_subject');
  if (!scope) invalid.push('scope_id');
  if (action !== 'erasure.request') invalid.push('action');
  if (!idempotencyKey) invalid.push('idempotency_key');
  if (!requestDigest || !/^[0-9a-f]{64}$/.test(requestDigest)) invalid.push('request_digest');
  if (!authorityEpoch || !/^(0|[1-9][0-9]*)$/.test(authorityEpoch)) invalid.push('authority_epoch');
  if (!terminalEpoch || !/^[1-9][0-9]*$/.test(terminalEpoch)) invalid.push('graph_sequence');
  if (graphDataEpoch !== ERASURE_JOURNAL_EPOCH) invalid.push('graph_data_epoch');
  if (outcome !== 'succeeded') invalid.push('graph_outcome');
  if (state !== 'sealed') invalid.push('state');
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) invalid.push('expires_at');
  if (!registeredAt || !Number.isFinite(Date.parse(registeredAt))) invalid.push('registered_at');
  if (!claimedAt || !Number.isFinite(Date.parse(claimedAt))) invalid.push('claimed_at');
  if (!sealedAt || !Number.isFinite(Date.parse(sealedAt))) invalid.push('sealed_at');
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(resource)) invalid.push('erasure_resource');
  if (!id || receipt !== erasureReceiptIri(id)) invalid.push('graph_receipt');
  if (invalid.length) {
    throw new AccessErasureRecoveryConflict(
      `new Access admission is not a completed public revision erasure (${invalid.join(', ')})`);
  }
  return { id: id!, principalId: principalId!, actingSubject: actingSubject!, scope: scope!, action: action!,
    idempotencyKey: idempotencyKey!, requestDigest: requestDigest!, authorityEpoch: authorityEpoch!,
    terminalEpoch: terminalEpoch!, targetResource: resource };
}

async function assertNativeAdmissionClosure(client: PoolClient,
  admissions: readonly NativeAccessErasureAdmission[]): Promise<void> {
  if (admissions.length === 0) return;
  const ids = admissions.map(row => row.id);
  if (new Set(ids).size !== ids.length) throw new AccessErasureRecoveryConflict('duplicate Access erasure admission row');
  const receipts = await client.query<{ admission_id: string; principal_id: string; action: string;
    idempotency_key: string; request_digest: string; outcome: string }>(`SELECT admission_id::text,
      principal_id::text, action, idempotency_key, request_digest, outcome
    FROM access.admission_receipt WHERE admission_id = ANY($1::uuid[]) ORDER BY admission_id`, [ids]);
  if (receipts.rows.length !== admissions.length) {
    throw new AccessErasureRecoveryConflict('new Access erasure admission is missing its native registration receipt');
  }
  const byId = new Map(admissions.map(row => [row.id, row]));
  for (const receipt of receipts.rows) {
    const admission = byId.get(receipt.admission_id);
    if (!admission || receipt.principal_id !== admission.principalId || receipt.action !== admission.action
      || receipt.idempotency_key !== admission.idempotencyKey
      || receipt.request_digest !== admission.requestDigest || receipt.outcome !== 'registered') {
      throw new AccessErasureRecoveryConflict('native Access erasure receipt differs from its admission');
    }
  }
  const outbox = await client.query<{ admission_id: string; kind: string; scope_id: string;
    principal_id: string | null; authority_epoch: string }>(`SELECT admission_id::text, kind, scope_id,
      principal_id::text, authority_epoch::text FROM access.outbox
    WHERE admission_id = ANY($1::uuid[]) ORDER BY admission_id, kind`, [ids]);
  const kinds = new Map<string, Set<string>>();
  for (const event of outbox.rows) {
    const admission = byId.get(event.admission_id);
    if (!admission || !ERASURE_OUTBOX_KINDS.has(event.kind) || event.scope_id !== admission.scope
      || event.principal_id !== null || event.authority_epoch !== admission.authorityEpoch) {
      throw new AccessErasureRecoveryConflict('native Access erasure outbox differs from its admission');
    }
    const found = kinds.get(event.admission_id) ?? new Set<string>();
    if (found.has(event.kind)) throw new AccessErasureRecoveryConflict('duplicate native Access erasure outbox event');
    found.add(event.kind);
    kinds.set(event.admission_id, found);
  }
  if (outbox.rows.length !== admissions.length * ERASURE_OUTBOX_KINDS.size
    || admissions.some(row => kinds.get(row.id)?.size !== ERASURE_OUTBOX_KINDS.size)) {
    throw new AccessErasureRecoveryConflict('new Access erasure admission is missing a native outbox phase');
  }
}

async function assertNewRelatedRows(client: PoolClient, baseClient: PoolClient,
  tableName: string, rows: readonly NativeRow[]): Promise<void> {
  if (!rows.length) return;
  const timestampColumn = tableName === 'access.admission_receipt' ? 'committed_at'
    : tableName === 'access.outbox' ? 'created_at' : null;
  if (timestampColumn) for (const row of rows) requireTimestamp(row.values, timestampColumn);
  const admissions = rows.map(row => textValue(row.values.admission_id));
  if (admissions.some(id => !id)) throw new AccessErasureRecoveryConflict('new Access row is not linked to an erasure admission');
  const ids = [...new Set(admissions as string[])];
  const base = await baseClient.query<{ id: string }>(
    'SELECT id::text FROM access.admission WHERE id = ANY($1::uuid[])', [ids]);
  if (base.rows.length) throw new AccessErasureRecoveryConflict('an existing Access admission gained later native rows');
  const current = await client.query<{ id: string; principal_id: string; acting_subject: string; scope_id: string;
    action: string; idempotency_key: string; request_digest: string; authority_epoch: string; state: string; graph_receipt: string | null;
    graph_outcome: string | null; graph_data_epoch: string | null; graph_sequence: string | null;
    expires_at: string; registered_at: string; claimed_at: string | null; sealed_at: string | null }>(
    `SELECT id::text, principal_id::text, acting_subject, scope_id, action, idempotency_key, request_digest,
      authority_epoch::text, state, graph_receipt, graph_outcome, graph_data_epoch, graph_sequence,
      expires_at::text, registered_at::text, claimed_at::text, sealed_at::text
     FROM access.admission WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
  if (current.rows.length !== ids.length) throw new AccessErasureRecoveryConflict('new Access native row has no admission');
  const admitted = current.rows.map(row => validateTerminalAdmission({ key: { id: row.id }, values: {
    id: row.id, principal_id: row.principal_id, acting_subject: row.acting_subject, scope_id: row.scope_id,
    action: row.action, idempotency_key: row.idempotency_key,
    request_digest: row.request_digest, authority_epoch: row.authority_epoch,
    state: row.state, graph_receipt: row.graph_receipt, graph_outcome: row.graph_outcome,
    graph_data_epoch: row.graph_data_epoch, graph_sequence: row.graph_sequence,
    expires_at: row.expires_at, registered_at: row.registered_at,
    claimed_at: row.claimed_at, sealed_at: row.sealed_at,
  } }));
  const baseAuthority = await baseClient.query<{ principal_id: string; acting_subject: string; scope_id: string }>(
    `SELECT p.id::text AS principal_id, s.id AS acting_subject, g.id AS scope_id
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS requested(principal_id, acting_subject, scope_id)
       JOIN access.principal p ON p.id = requested.principal_id
       JOIN access.authority_subject s ON s.id = requested.acting_subject
       JOIN access.scope_gate g ON g.id = requested.scope_id`,
    [admitted.map(row => row.principalId), admitted.map(row => row.actingSubject), admitted.map(row => row.scope)]);
  if (baseAuthority.rows.length !== admitted.length) {
    throw new AccessErasureRecoveryConflict('new erasure admission uses authority or scope absent at the base cut');
  }
  await assertNativeAdmissionClosure(client, admitted);
}

async function emitLine(write: (chunk: Uint8Array) => Promise<void>, bytes: ReturnType<typeof createHash>,
  line: string): Promise<void> {
  const chunk = Buffer.from(`${line}\n`, 'utf8');
  bytes.update(chunk);
  await write(chunk);
}

/** Stream a byte-exact, paged native Access delta from a captured base to a closed source. */
export async function exportAccessErasureRecoveryAttachment(
  baseClient: PoolClient,
  sourceClient: PoolClient,
  write: (chunk: Uint8Array) => Promise<void>,
  verifyAdmissions?: AccessErasureAdmissionVerifier,
): Promise<AccessErasureRecoverySummary> {
  await canonicalRowText(baseClient);
  await canonicalRowText(sourceClient);
  const baseFence = await readFence(baseClient);
  const sourceFence = await readFence(sourceClient);
  const baseCatalog = await nativeAccessCatalog(baseClient);
  const sourceCatalog = await nativeAccessCatalog(sourceClient);
  const baseCoverage = await scanAccessTables(baseClient);
  const sourceCoverage = await scanAccessTables(sourceClient);
  const legacyBaseState = (await scanAccessTables(baseClient, 'access-state-v5')).state;
  const baseOutbox = await scanAccessOutbox(baseClient);
  const sourceOutbox = await scanAccessOutbox(sourceClient);
  if (baseCatalog.digest !== sourceCatalog.digest) {
    throw new AccessErasureRecoveryConflict('Access native catalog differs between base and source');
  }
  const fenceMove = strictDeltaGeneration(baseFence.generation, sourceFence.generation);
  const header: AccessErasureRecoveryHeader = {
    kind: 'header', profile: ACCESS_ERASURE_RECOVERY_PROFILE,
    version: ACCESS_ERASURE_RECOVERY_VERSION, catalogVersion: ACCESS_ERASURE_RECOVERY_CATALOG_VERSION, legacyBaseState, catalogDigest: sourceCatalog.digest,
    baseFenceGeneration: baseFence.generation, sourceFenceGeneration: sourceFence.generation,
    baseState: baseCoverage.state, sourceState: sourceCoverage.state,
    baseOutbox, sourceOutbox,
  };
  const bytes = createHash('sha256');
  let plaintextBytes = 0n;
  const output = async (line: string) => {
    const chunkBytes = Buffer.byteLength(line, 'utf8') + 1;
    plaintextBytes += BigInt(chunkBytes);
    await emitLine(write, bytes, line);
  };
  await output(JSON.stringify(header));
  const rowHash = createHash('sha256');
  let rowCount = 0n;
  let admissionCount = 0n;
  let discoveryInvalidations = 0n;
  let alsoEnjoyedInvalidations = 0n;
  let relatedRows: NativeRow[] = [];
  const allTables = new Map(sourceCatalog.tables.map(table => [table.name, table]));
  if (!IMPORT_ORDER.every(name => allTables.has(name))) {
    throw new AccessErasureRecoveryConflict('Access native erasure recovery catalog is incomplete');
  }
  const orderedTables = [...sourceCatalog.tables].sort((a, b) => {
    const aOrder = IMPORT_ORDER.indexOf(a.name as typeof IMPORT_ORDER[number]);
    const bOrder = IMPORT_ORDER.indexOf(b.name as typeof IMPORT_ORDER[number]);
    return (aOrder < 0 ? IMPORT_ORDER.length : aOrder) - (bOrder < 0 ? IMPORT_ORDER.length : bOrder)
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  for (const table of orderedTables) {
    if (table.name === 'access.recovery_fence') continue;
    const rule = accessRecoveryRule(table);
    const compareBase = rule.class === 'authority' || rule.generationPayload === true;
    // Folding may change/prune old invalidations. New erasure invalidations
    // still travel with the native admission closure and their exact defaults.
    if (!compareBase && !SOURCE_INVALIDATIONS.has(table.name)) continue;
    const before = allTables.get(table.name)!;
    const [baseColumns, sourceColumns] = await Promise.all([
      columnsFor(baseClient, before), columnsFor(sourceClient, table),
    ]);
    if (stableJson(baseColumns) !== stableJson(sourceColumns)) {
      throw new AccessErasureRecoveryConflict(`Access table columns differ: ${table.name}`);
    }
    const baseRows = nativeRows(baseClient, before, baseColumns)[Symbol.asyncIterator]();
    const sourceRows = nativeRows(sourceClient, table, sourceColumns)[Symbol.asyncIterator]();
    let base = await baseRows.next();
    let source = await sourceRows.next();
    let admissionPage: NativeAccessErasureAdmission[] = [];
    let sourceInvalidationsForTable = 0n;
    const flushAdmissions = async () => {
      if (admissionPage.length) await assertNativeAdmissionClosure(sourceClient, admissionPage);
      if (admissionPage.length && verifyAdmissions) await verifyAdmissions(admissionPage);
      admissionPage = [];
    };
    const flushRelated = async () => {
      if (relatedRows.length) await assertNewRelatedRows(sourceClient, baseClient, table.name, relatedRows);
      relatedRows = [];
    };
    while (!base.done || !source.done) {
      if (base.done) {
        const added = source.value!;
        if (!IMPORTABLE.has(table.name)) {
          throw new AccessErasureRecoveryConflict(`Access row was added outside erasure recovery: ${table.name}`);
        }
        const record: AccessErasureRecoveryRow = { kind: 'row', table: table.name,
          key: added.key, values: added.values };
        const line = JSON.stringify(record);
        rowDigestUpdate(rowHash, line);
        await output(line);
        rowCount++;
        if (table.name === 'access.admission') {
          admissionPage.push(validateTerminalAdmission(added));
          admissionCount++;
          if (admissionPage.length === ACCESS_ERASURE_RECOVERY_PAGE) await flushAdmissions();
        }
        if (table.name === 'access.admission_receipt' || table.name === 'access.outbox') {
          // Keep related native rows attached only to new, successful erasure commands.
          // The admission page check below verifies the exact receipt/outbox closure.
          if (!textValue(added.values.admission_id)) throw new AccessErasureRecoveryConflict('new Access row is not linked to an erasure admission');
          relatedRows.push(added);
          if (relatedRows.length === ACCESS_ERASURE_RECOVERY_PAGE) await flushRelated();
          if (table.name === 'access.outbox' && !ERASURE_OUTBOX_KINDS.has(textValue(added.values.kind) ?? '')) {
            throw new AccessErasureRecoveryConflict('unsupported Access outbox addition is outside erasure recovery');
          }
        }
        if (table.name === 'access.discovery_source_change') {
          if (textValue(added.values.context_key) !== '' || textValue(added.values.statement) !== '') {
            throw new AccessErasureRecoveryConflict('discovery source invalidation is not the fence reopen/refence');
          }
          discoveryInvalidations++;
          sourceInvalidationsForTable++;
        }
        if (table.name === 'access.also_enjoyed_source_change') {
          if (added.values.privacy !== 'true') {
            throw new AccessErasureRecoveryConflict('also-enjoyed source invalidation is not the fence reopen/refence');
          }
          alsoEnjoyedInvalidations++;
          sourceInvalidationsForTable++;
        }
        source = await sourceRows.next();
        continue;
      }
      if (source.done) {
        if (!compareBase) { base = await baseRows.next(); continue; }
        throw new AccessErasureRecoveryConflict(`base Access row was removed: ${table.name}`);
      }
      const baseKey = stableJson(base.value!.key);
      const sourceKey = stableJson(source.value!.key);
      if (baseKey === sourceKey) {
        if (compareBase && stableJson(accessAuthorityValues(table, base.value!.values, base.value!.building))
          !== stableJson(accessAuthorityValues(table, source.value!.values, source.value!.building))) {
          throw new AccessErasureRecoveryConflict(`base Access row changed: ${table.name}`);
        }
        if (table.name === 'access.derived_generation' && source.value!.values.state === 'building') {
          // Plaintext custody authenticates this operational high-water mark.
          // It is not an authority row and does not change the admission count.
          await output(JSON.stringify({ kind: 'lease-fence', generation: source.value!.key.id,
            epoch: source.value!.values.lease_epoch }));
        }
        base = await baseRows.next();
        source = await sourceRows.next();
      } else {
        // Catalog keys arrive in native primary-key order. Compare single-key
        // tables directly; composite keys are compared through PostgreSQL below.
        const isBaseFirst = await baseClient.query<{ before: boolean }>(
          `SELECT ROW(${before.key.map((_, index) => `$${index + 1}::${before.keyTypes[index]}`).join(', ')})
              < ROW(${before.key.map((_, index) => `$${before.key.length + index + 1}::${before.keyTypes[index]}`).join(', ')})
             AS before`, [...before.key.map(column => base.value!.key[column]),
            ...before.key.map(column => source.value!.key[column])]);
        if (isBaseFirst.rows[0]?.before === true) {
          if (!compareBase) { base = await baseRows.next(); continue; }
          throw new AccessErasureRecoveryConflict(`base Access row was removed: ${table.name}`);
        }
        const added = source.value!;
        if (!IMPORTABLE.has(table.name)) {
          throw new AccessErasureRecoveryConflict(`Access row was added outside erasure recovery: ${table.name}`);
        }
        const line = JSON.stringify({ kind: 'row', table: table.name,
          key: added.key, values: added.values } satisfies AccessErasureRecoveryRow);
        rowDigestUpdate(rowHash, line);
        await output(line);
        rowCount++;
        if (table.name === 'access.admission') {
          admissionPage.push(validateTerminalAdmission(added));
          admissionCount++;
          if (admissionPage.length === ACCESS_ERASURE_RECOVERY_PAGE) await flushAdmissions();
        }
        if ((table.name === 'access.admission_receipt' || table.name === 'access.outbox')
          && !textValue(added.values.admission_id)) {
          throw new AccessErasureRecoveryConflict('new Access row is not linked to an erasure admission');
        }
        if (table.name === 'access.admission_receipt' || table.name === 'access.outbox') {
          relatedRows.push(added);
          if (relatedRows.length === ACCESS_ERASURE_RECOVERY_PAGE) await flushRelated();
        }
        if (table.name === 'access.outbox' && !ERASURE_OUTBOX_KINDS.has(textValue(added.values.kind) ?? '')) {
          throw new AccessErasureRecoveryConflict('unsupported Access outbox addition is outside erasure recovery');
        }
        if (table.name === 'access.discovery_source_change') {
          if (textValue(added.values.context_key) !== '' || textValue(added.values.statement) !== '') {
            throw new AccessErasureRecoveryConflict('discovery source invalidation is not the fence reopen/refence');
          }
          discoveryInvalidations++;
          sourceInvalidationsForTable++;
        }
        if (table.name === 'access.also_enjoyed_source_change') {
          if (added.values.privacy !== 'true') {
            throw new AccessErasureRecoveryConflict('also-enjoyed source invalidation is not the fence reopen/refence');
          }
          alsoEnjoyedInvalidations++;
          sourceInvalidationsForTable++;
        }
        source = await sourceRows.next();
      }
    }
    await flushAdmissions();
    await flushRelated();
    if (SOURCE_INVALIDATIONS.has(table.name)) {
      const expected = fenceMove === 'reopened' ? 2n : 0n;
      if (sourceInvalidationsForTable !== expected) {
        throw new AccessErasureRecoveryConflict('source invalidations do not match the exact fence reopen/refence pair');
      }
    }
  }
  if (fenceMove === 'same' && (rowCount !== 0n || admissionCount !== 0n)) {
    throw new AccessErasureRecoveryConflict('Access additions require the exact source fence reopen/refence pair');
  }
  if (fenceMove === 'reopened' && (discoveryInvalidations !== 2n || alsoEnjoyedInvalidations !== 2n)) {
    throw new AccessErasureRecoveryConflict('source fence reopen/refence invalidations are incomplete');
  }
  const footer: AccessErasureRecoveryFooter = {
    kind: 'end', profile: ACCESS_ERASURE_RECOVERY_PROFILE,
    version: ACCESS_ERASURE_RECOVERY_VERSION, catalogVersion: ACCESS_ERASURE_RECOVERY_CATALOG_VERSION, legacyBaseState, catalogDigest: sourceCatalog.digest,
    rowCount: rowCount.toString(), rowDigest: rowHash.digest('hex'),
  };
  await output(JSON.stringify(footer));
  const plaintextDigest = bytes.digest('hex');
  return { profile: ACCESS_ERASURE_RECOVERY_PROFILE, version: ACCESS_ERASURE_RECOVERY_VERSION,
    catalogVersion: ACCESS_ERASURE_RECOVERY_CATALOG_VERSION, legacyBaseState,
    catalogDigest: sourceCatalog.digest, baseFenceGeneration: baseFence.generation,
    sourceFenceGeneration: sourceFence.generation, baseState: baseCoverage.state,
    sourceState: sourceCoverage.state, baseOutbox, sourceOutbox, rowCount: rowCount.toString(),
    rowDigest: footer.rowDigest, plaintextBytes: plaintextBytes.toString(), plaintextDigest };
}

function sameCoverage(actual: RowCoverage, expected: RowCoverage): boolean {
  return actual.count === expected.count && actual.digest === expected.digest;
}

function validateExpectation(expected: AccessErasureRecoveryExpectation): void {
  if (expected?.profile !== ACCESS_ERASURE_RECOVERY_PROFILE || expected.version !== ACCESS_ERASURE_RECOVERY_VERSION
    || expected.catalogVersion !== undefined && expected.catalogVersion !== 1 && expected.catalogVersion !== 2
    || expected.catalogVersion === 2 && (!expected.legacyBaseState
      || !/^[0-9]+$/.test(expected.legacyBaseState.count) || !/^[0-9a-f]{64}$/.test(expected.legacyBaseState.digest))
    || !/^[0-9a-f]{64}$/.test(expected.catalogDigest ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(expected.baseFenceGeneration ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(expected.sourceFenceGeneration ?? '')
    || !/^[0-9]+$/.test(expected.rowCount ?? '') || !/^[0-9]+$/.test(expected.plaintextBytes ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.rowDigest ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.plaintextDigest ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(expected.baseState?.count ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.baseState?.digest ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(expected.sourceState?.count ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.sourceState?.digest ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(expected.baseOutbox?.count ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.baseOutbox?.digest ?? '')
    || !/^(0|[1-9][0-9]*)$/.test(expected.sourceOutbox?.count ?? '')
    || !/^[0-9a-f]{64}$/.test(expected.sourceOutbox?.digest ?? '')) {
    throw new AccessErasureRecoveryConflict('signed native Access attachment reference is invalid');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Incrementally validate and import exact rows on a held Access transaction. */
export async function importAccessErasureRecoveryAttachment(
  client: PoolClient,
  input: AsyncIterable<Uint8Array | string>,
  expected: AccessErasureRecoveryExpectation,
  verifyAdmissions?: AccessErasureAdmissionVerifier,
): Promise<{ imported: string; alreadyPresent: string }> {
  validateExpectation(expected);
  try { await client.query('SAVEPOINT access_erasure_recovery_guard'); }
  catch (error) {
    throw new AccessErasureRecoveryConflict('Access erasure import requires an active held transaction', { cause: error });
  }
  try {
  const readOnly = (await client.query<{ read_only: string }>(
    "SELECT current_setting('transaction_read_only') AS read_only")).rows[0]?.read_only;
  if (readOnly !== 'off') {
    throw new AccessErasureRecoveryConflict('Access erasure import requires a writable held transaction');
  }
  const fence = (await client.query<FenceRow>(`SELECT open, generation::text AS generation
    FROM access.recovery_fence WHERE id = true FOR UPDATE`)).rows[0];
  if (!fence || fence.open || fence.generation !== expected.baseFenceGeneration) {
    throw new AccessErasureRecoveryConflict('held Access base fence differs from native attachment');
  }
  await canonicalRowText(client);
  const catalogVersion = expected.catalogVersion ?? 1;
  const profile = catalogVersion === 1 ? 'access-state-v5' : 'access-authority-v6';
  const catalog = await nativeAccessCatalog(client, catalogVersion);
  const state = await scanAccessTables(client, profile);
  const legacyBaseState = catalogVersion === 2 ? (await scanAccessTables(client, 'access-state-v5')).state : undefined;
  const outbox = await scanAccessOutbox(client);
  if (catalog.digest !== expected.catalogDigest
    || stableJson(legacyBaseState) !== stableJson(expected.legacyBaseState)
    || !sameCoverage(state.state, expected.baseState) || !sameCoverage(outbox, expected.baseOutbox)) {
    throw new AccessErasureRecoveryConflict('held Access rows or schema differ from native attachment base');
  }
  const tables = new Map(catalog.tables.map(table => [table.name, table]));
  const columns = new Map<string, NativeColumn[]>();
  for (const name of IMPORT_ORDER) {
    const table = tables.get(name);
    if (!table) throw new AccessErasureRecoveryConflict(`Access native erasure recovery table is missing: ${name}`);
    columns.set(name, await columnsFor(client, table));
  }

  const digest = createHash('sha256');
  const rowHash = createHash('sha256');
  let bytes = 0n;
  let rowCount = 0n;
  let imported = 0n;
  let alreadyPresent = 0n;
  let discoveryInvalidations = 0n;
  let alsoEnjoyedInvalidations = 0n;
  let pendingTable: string | undefined;
  let pending: AccessErasureRecoveryRow[] = [];
  let lastKey: { table: string; key: Record<string, string> } | undefined;
  let footer: AccessErasureRecoveryFooter | undefined;
  let headerSeen = false;
  let buffered = '';
  const decoder = new TextDecoder();
  const admissionsStage = `access_erasure_recovery_${randomUUID().replaceAll('-', '')}`;
  const admissionsStageRef = `pg_temp.${ident(admissionsStage)}`;
  await client.query(`CREATE TEMP TABLE ${ident(admissionsStage)} (id uuid PRIMARY KEY) ON COMMIT DROP`);

  const applyPage = async (tableName: string, page: AccessErasureRecoveryRow[]) => {
    if (page.length === 0) return;
    const table = tables.get(tableName)!;
    const names = columns.get(tableName)!;
    const keyNames = table.key;
    const prior = lastKey?.table === tableName ? [lastKey.key] : [];
    const orderedKeys = [...prior, ...page.map(row => row.key)];
    if (orderedKeys.length > 1) {
      const typedKey = table.key.map((column, index) =>
        `native.${ident(column)} AS ${ident(`k${index}`)}`).join(', ');
      const currentKey = table.key.map((_, index) => ident(`k${index}`)).join(', ');
      const previousKey = table.key.map((_, index) => ident(`p${index}`)).join(', ');
      const previous = table.key.map((_, index) =>
        `lag(${ident(`k${index}`)}) OVER (ORDER BY ord) AS ${ident(`p${index}`)}`).join(', ');
      const ordered = await client.query<{ ordered: boolean }>(`WITH raw AS (
          SELECT value AS key, ordinality AS ord FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY
        ), typed AS (
          SELECT raw.ord, ${typedKey} FROM raw
          CROSS JOIN LATERAL jsonb_populate_record(NULL::${relation(table)}, raw.key) AS native
        ), sequenced AS (SELECT *, ${previous} FROM typed)
        SELECT bool_and(CASE WHEN ord = 1 THEN true
          ELSE ROW(${currentKey}) > ROW(${previousKey}) END) AS ordered FROM sequenced`,
      [JSON.stringify(orderedKeys)]);
      if (ordered.rows[0]?.ordered !== true) {
        throw new AccessErasureRecoveryConflict('native Access attachment keys are duplicated or out of order');
      }
    }
    for (const row of page) {
      if (Object.keys(row.key).length !== keyNames.length
        || keyNames.some(column => typeof row.key[column] !== 'string')
        || Object.keys(row.values).length !== names.length
        || names.some(column => column.type === 'text'
          ? row.values[column.name] !== null && typeof row.values[column.name] !== 'string'
          : !isNativeJsonValue(row.values[column.name]))
        || keyNames.some(column => row.key[column] !== textValue(row.values[column]))) {
        throw new AccessErasureRecoveryConflict('native Access attachment row does not match its catalog');
      }
      if (tableName === 'access.admission_receipt') requireTimestamp(row.values, 'committed_at');
      if (tableName === 'access.outbox') requireTimestamp(row.values, 'created_at');
      if (tableName === 'access.admission') {
        for (const column of ['expires_at', 'registered_at', 'claimed_at', 'sealed_at']) {
          requireTimestamp(row.values, column);
        }
        validateTerminalAdmission({ key: row.key, values: row.values });
      }
    }
    lastKey = { table: tableName, key: page[page.length - 1]!.key };
    const rowValues = page.map(row => row.values);
    const json = JSON.stringify(rowValues);
    const incoming = incomingRowsSql(table, names);
    const keyJoin = keyNames.map(column => `existing.${ident(column)} = incoming.${ident(column)}`).join(' AND ');
    const conflicting = await client.query(`${incoming}
      SELECT 1 FROM ${relation(table)} AS existing JOIN incoming ON ${keyJoin}
      WHERE existing IS DISTINCT FROM incoming LIMIT 1`, [json]);
    if (conflicting.rowCount) throw new AccessErasureRecoveryConflict(`held Access row conflicts with attachment: ${tableName}`);
    const present = await client.query<{ count: string }>(`${incoming}
      SELECT count(*)::text AS count FROM ${relation(table)} AS existing JOIN incoming ON ${keyJoin}`, [json]);
    const presentCount = BigInt(present.rows[0]?.count ?? '0');
    if (presentCount > 0n) throw new AccessErasureRecoveryConflict('native Access attachment repeats a base-cut row');
    const insertNames = names.filter(column => !column.generated);
    const columnList = insertNames.map(column => ident(column.name)).join(', ');
    const insert = await client.query(`${incoming}
      INSERT INTO ${relation(table)} (${columnList}) OVERRIDING SYSTEM VALUE
      SELECT ${insertNames.map(column => `incoming.${ident(column.name)}`).join(', ')} FROM incoming
      WHERE NOT EXISTS (SELECT 1 FROM ${relation(table)} AS existing WHERE ${keyNames
        .map(column => `existing.${ident(column)} = incoming.${ident(column)}`).join(' AND ')})`, [json]);
    const newlyInserted = BigInt(insert.rowCount ?? 0);
    if (newlyInserted + presentCount !== BigInt(page.length)) {
      throw new AccessErasureRecoveryConflict('native Access attachment page is not an exact set');
    }
    imported += newlyInserted;
    alreadyPresent += presentCount;
    if (tableName === 'access.admission') {
      await client.query(`INSERT INTO ${admissionsStageRef} (id)
        SELECT DISTINCT x.id::uuid FROM jsonb_to_recordset($1::jsonb) AS x(id text)`,
      [JSON.stringify(page.map(row => ({ id: textValue(row.values.id) })))]);
    }
    if (tableName === 'access.admission_receipt' || tableName === 'access.outbox') {
      const ids = page.map(row => textValue(row.values.admission_id));
      if (ids.some(id => !id)) throw new AccessErasureRecoveryConflict('new Access row is not linked to an erasure admission');
      if (tableName === 'access.outbox' && page.some(row => !ERASURE_OUTBOX_KINDS.has(textValue(row.values.kind) ?? '')))
        throw new AccessErasureRecoveryConflict('unsupported Access outbox addition is outside erasure recovery');
    }
    if (tableName === 'access.discovery_source_change') {
      if (page.some(row => textValue(row.values.context_key) !== '' || textValue(row.values.statement) !== '')) {
        throw new AccessErasureRecoveryConflict('discovery source invalidation is not the fence reopen/refence');
      }
      discoveryInvalidations += BigInt(page.length);
    }
    if (tableName === 'access.also_enjoyed_source_change') {
      if (page.some(row => row.values.privacy !== 'true')) {
        throw new AccessErasureRecoveryConflict('also-enjoyed source invalidation is not the fence reopen/refence');
      }
      alsoEnjoyedInvalidations += BigInt(page.length);
    }
  };

  const consumeLine = async (line: string) => {
    if (!line) throw new AccessErasureRecoveryConflict('native Access attachment contains an empty record');
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      throw new AccessErasureRecoveryConflict('native Access attachment is not valid JSON', { cause: error });
    }
    if (!headerSeen) {
      if (!isObject(value) || value.kind !== 'header' || value.profile !== expected.profile
        || value.version !== expected.version || (value.catalogVersion ?? 1) !== catalogVersion
        || stableJson(value.legacyBaseState) !== stableJson(expected.legacyBaseState)
        || value.catalogDigest !== expected.catalogDigest
        || value.baseFenceGeneration !== expected.baseFenceGeneration
        || value.sourceFenceGeneration !== expected.sourceFenceGeneration
        || stableJson(value.baseState) !== stableJson(expected.baseState)
        || stableJson(value.sourceState) !== stableJson(expected.sourceState)
        || stableJson(value.baseOutbox) !== stableJson(expected.baseOutbox)
        || stableJson(value.sourceOutbox) !== stableJson(expected.sourceOutbox)) {
        throw new AccessErasureRecoveryConflict('native Access attachment header differs from signed reference');
      }
      headerSeen = true;
      return;
    }
    if (!isObject(value)) throw new AccessErasureRecoveryConflict('native Access attachment record is invalid');
    if (value.kind === 'end') {
      if (footer) throw new AccessErasureRecoveryConflict('native Access attachment has duplicate footer');
      footer = value as unknown as AccessErasureRecoveryFooter;
      if (footer.profile !== expected.profile || footer.version !== expected.version
        || (footer.catalogVersion ?? 1) !== catalogVersion
        || stableJson(footer.legacyBaseState) !== stableJson(expected.legacyBaseState)
        || (catalogVersion === 2 || footer.catalogDigest !== undefined) && footer.catalogDigest !== expected.catalogDigest
        || footer.rowCount !== expected.rowCount || footer.rowDigest !== expected.rowDigest) {
        throw new AccessErasureRecoveryConflict('native Access attachment footer differs from signed reference');
      }
      if (pendingTable) await applyPage(pendingTable, pending);
      pending = [];
      pendingTable = undefined;
      return;
    }
    if (!footer && catalogVersion === 2 && value.kind === 'lease-fence') {
      const scheduler = value.table === 'access.discovery_refresh';
      if (value.table !== undefined && !scheduler
        || typeof value.generation !== 'string' || !(scheduler ? /^[0-9a-f]{64}$/ : /^[0-9a-f-]{36}$/).test(value.generation)
        || typeof value.epoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.epoch)) {
        throw new AccessErasureRecoveryConflict('native Access lease fence is invalid');
      }
      const basis = scheduler && isObject(value.basis) && value.basis.$rezicsNativeJson === 'value'
        && typeof value.basis.$value === 'string' ? value.basis.$value : undefined;
      if (scheduler && basis === undefined) throw new AccessErasureRecoveryConflict('native Access scheduler basis is invalid');
      // Older attachments supplied scheduler fences. Validate their wire data
      // above, but keep the restored scheduler exactly as in the backup.
      if (scheduler) return;
      const fenced = await client.query(`UPDATE access.derived_generation
        SET lease_epoch = greatest(lease_epoch, $2::bigint)
        WHERE id = $1 AND state = 'building'`, [value.generation, value.epoch]);
      if (fenced.rowCount !== 1) throw new AccessErasureRecoveryConflict('native Access lease fence has no base generation');
      return;
    }
    if (footer || value.kind !== 'row' || typeof value.table !== 'string' || !IMPORTABLE.has(value.table)
      || !isObject(value.key) || !isObject(value.values)) {
      throw new AccessErasureRecoveryConflict('unknown native Access attachment schema or row');
    }
    const row = value as unknown as AccessErasureRecoveryRow;
    rowDigestUpdate(rowHash, line);
    rowCount++;
    if (row.table !== pendingTable && pending.length) {
      await applyPage(pendingTable!, pending);
      pending = [];
    }
    if (!IMPORT_ORDER.includes(row.table as typeof IMPORT_ORDER[number])) {
      throw new AccessErasureRecoveryConflict('unknown native Access attachment table');
    }
    if (pendingTable && IMPORT_ORDER.indexOf(row.table as typeof IMPORT_ORDER[number])
      < IMPORT_ORDER.indexOf(pendingTable as typeof IMPORT_ORDER[number])) {
      throw new AccessErasureRecoveryConflict('native Access attachment rows are out of dependency order');
    }
    pendingTable = row.table;
    pending.push(row);
    if (pending.length === ACCESS_ERASURE_RECOVERY_PAGE) {
      await applyPage(pendingTable, pending);
      pending = [];
    }
  };

  for await (const chunk of input) {
    const bytesChunk = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    digest.update(bytesChunk);
    bytes += BigInt(bytesChunk.byteLength);
    buffered += decoder.decode(bytesChunk, { stream: true });
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      await consumeLine(line);
    }
  }
  buffered += decoder.decode();
  if (buffered.length) throw new AccessErasureRecoveryConflict('native Access attachment is missing its final newline');
  if (!headerSeen || !footer || rowCount.toString() !== expected.rowCount
    || rowHash.digest('hex') !== expected.rowDigest || bytes.toString() !== expected.plaintextBytes
    || digest.digest('hex') !== expected.plaintextDigest) {
    throw new AccessErasureRecoveryConflict('native Access attachment digest or row count differs');
  }
  const reopened = expected.sourceFenceGeneration !== expected.baseFenceGeneration;
  if (reopened ? BigInt(expected.sourceFenceGeneration) !== BigInt(expected.baseFenceGeneration) + 2n
    || discoveryInvalidations !== 2n || alsoEnjoyedInvalidations !== 2n
    : discoveryInvalidations !== 0n || alsoEnjoyedInvalidations !== 0n || rowCount !== 0n) {
    throw new AccessErasureRecoveryConflict('native Access attachment is outside the exact fence reopen/refence transition');
  }
  let afterAdmission: string | null = null;
  for (;;) {
    type StagedAdmission = { id: string; principal_id: string; acting_subject: string;
      scope_id: string; action: string; idempotency_key: string; request_digest: string; authority_epoch: string;
      state: string; graph_receipt: string | null; graph_outcome: string | null;
      graph_data_epoch: string | null; graph_sequence: string | null; expires_at: string; registered_at: string;
      claimed_at: string | null; sealed_at: string | null };
    const page: QueryResult<StagedAdmission> = await client.query<StagedAdmission>(`SELECT a.id::text, a.principal_id::text,
        a.acting_subject, a.scope_id, a.action, a.idempotency_key, a.request_digest, a.authority_epoch::text,
        a.expires_at::text, a.registered_at::text, a.claimed_at::text, a.sealed_at::text,
        a.state, a.graph_receipt, a.graph_outcome, a.graph_data_epoch, a.graph_sequence
      FROM ${admissionsStageRef} s JOIN access.admission a ON a.id = s.id
      WHERE ($1::uuid IS NULL OR a.id > $1::uuid) ORDER BY a.id LIMIT ${ACCESS_ERASURE_RECOVERY_PAGE}`,
    [afterAdmission]);
    if (!page.rows.length) break;
    const admissions = page.rows.map(row => {
      if (row.state !== 'sealed') throw new AccessErasureRecoveryConflict('imported erasure admission is not sealed');
      return validateTerminalAdmission({ key: { id: row.id }, values: {
        id: row.id, principal_id: row.principal_id, acting_subject: row.acting_subject, state: row.state,
        scope_id: row.scope_id, action: row.action, idempotency_key: row.idempotency_key,
        request_digest: row.request_digest,
        authority_epoch: row.authority_epoch, graph_receipt: row.graph_receipt,
        graph_outcome: row.graph_outcome, graph_data_epoch: row.graph_data_epoch,
        graph_sequence: row.graph_sequence, expires_at: row.expires_at, registered_at: row.registered_at,
        claimed_at: row.claimed_at, sealed_at: row.sealed_at,
      } });
    });
    await assertNativeAdmissionClosure(client, admissions);
    if (verifyAdmissions) await verifyAdmissions(admissions);
    afterAdmission = page.rows[page.rows.length - 1]!.id;
    if (page.rows.length < ACCESS_ERASURE_RECOVERY_PAGE) break;
  }
  for (const tableName of SOURCE_INVALIDATIONS) {
    const table = tables.get(tableName)!;
    const column = 'id';
    const seq = (await client.query<{ sequence: string | null }>(
      'SELECT pg_get_serial_sequence($1, $2) AS sequence', [`${table.schema}.${table.table}`, column])).rows[0]?.sequence;
    if (seq) {
      const max = (await client.query<{ value: string | null }>(
        `SELECT max(${ident(column)})::text AS value FROM ${relation(table)}`)).rows[0]?.value;
      if (max !== null && max !== undefined) {
        const last = (await client.query<{ value: string | null }>(
          'SELECT pg_sequence_last_value($1::regclass)::text AS value', [seq])).rows[0]?.value;
        const floor = BigInt(last ?? '0') > BigInt(max) ? last! : max;
        await client.query('SELECT setval($1::regclass, $2::bigint, true)', [seq, floor]);
      }
    }
  }
  if (expected.sourceFenceGeneration !== expected.baseFenceGeneration
    && BigInt(expected.sourceFenceGeneration) !== BigInt(expected.baseFenceGeneration) + 2n) {
    throw new AccessErasureRecoveryConflict('native Access source fence generation is invalid');
  }
  const actualState = await scanAccessTables(client, profile);
  const actualOutbox = await scanAccessOutbox(client);
  const finalFence = await readFence(client);
  if (!sameCoverage(actualState.state, expected.sourceState) || !sameCoverage(actualOutbox, expected.sourceOutbox)
    || finalFence.generation !== expected.baseFenceGeneration) {
    throw new AccessErasureRecoveryConflict('restored Access does not equal the signed current capture');
  }
  // The original profile signs every raw row. Preserve those bytes until the
  // release owner derives the explicitly authorized reset transition.
  if (catalogVersion === 2) await resetAccessRecoveryState(client);
  await client.query('RELEASE SAVEPOINT access_erasure_recovery_guard');
  return { imported: imported.toString(), alreadyPresent: alreadyPresent.toString() };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT access_erasure_recovery_guard');
      await client.query('RELEASE SAVEPOINT access_erasure_recovery_guard');
    } catch { /* retain the import conflict */ }
    throw error;
  }
}

