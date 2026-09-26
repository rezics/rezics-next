import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { RV } from './activate.ts';

export class ContentRecoveryConflict extends Error {}

export interface GraphContentReference {
  graph: string;
  subject: string;
  revisionId: string;
  byteDigest: string | null;
  preparationId: string | null;
  ownerEpoch: string | null;
  ownerSequence: string | null;
}

export interface ContentRecoveryCoverage {
  version: 3;
  dataEpoch: string;
  sequence: string;
  graphReferencesCount: string;
  graphReferencesDigest: string;
  tables: Record<'variant' | 'revision' | 'receipt' | 'publication_preparation' | 'outbox' | 'comment' |
    'projection_checkpoint', { count: string; digest: string }>;
  packageTables: Record<'go_resolution' | 'go_proxy_capture' | 'go_sumdb_head_history' |
    'go_sumdb_head' | 'go_sumdb_verification' | 'cargo_resolution',
    { count: string; digest: string }>;
}

const REVISION = 'urn:rezics:content:revision:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const TABLES = [
  ['variant', 'id'], ['revision', 'id'], ['receipt', 'operation_id'],
  ['publication_preparation', 'operation_id'], ['outbox', 'id'],
  ['comment', 'id'], ['projection_checkpoint', 'consumer'],
] as const;
const PACKAGE_TABLES = [
  ['go_resolution', 'id'], ['go_proxy_capture', 'id'],
  ['go_sumdb_head_history', 'id'], ['go_sumdb_head', 'server'],
  ['go_sumdb_verification', 'id'], ['cargo_resolution', 'id'],
] as const;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stable(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  return value;
}

function exactBodyMatches(bytes: Buffer, body: unknown): boolean {
  try { return JSON.stringify(stable(JSON.parse(bytes.toString('utf8'))))
    === JSON.stringify(stable(body)); }
  catch { return false; }
}

/** Enumerate every graph Content reference, including historical decisions and receipts. */
export async function graphContentReferences(fuseki: FusekiClient): Promise<GraphContentReference[]> {
  const references: GraphContentReference[] = [];
  for (let offset = 0; ; offset += 200) {
    const result = await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?graph ?subject ?revision ?digest ?preparation ?epoch ?sequence WHERE {
        GRAPH ?graph { ?subject rv:contentRevision ?revision .
          OPTIONAL { ?subject rv:byteDigest ?digest }
          OPTIONAL { ?subject rv:contentPreparation ?preparation }
          OPTIONAL { ?subject rv:ownerDataEpoch ?epoch }
          OPTIONAL { ?subject rv:ownerSequence ?sequence }
        }
      } ORDER BY ?graph ?subject ?revision ?digest ?preparation ?epoch ?sequence
      LIMIT 200 OFFSET ${offset}`);
    const rows = result.results?.bindings;
    if (!rows) throw new ContentRecoveryConflict('graph Content reference query is incomplete');
    for (const row of rows) {
      const value = (name: string) => row[name]?.value ?? null;
      const revision = value('revision');
      const revisionId = revision?.startsWith(REVISION) ? revision.slice(REVISION.length) : '';
      if (!value('graph') || !value('subject') || !UUID.test(revisionId)
        || (value('digest') !== null && !SHA.test(value('digest')!))
        || (value('sequence') !== null && !DECIMAL.test(value('sequence')!))
        || (value('epoch') === null) !== (value('sequence') === null)
        || (value('epoch') !== null && !UUID.test(value('epoch')!))) {
        throw new ContentRecoveryConflict('graph Content reference is malformed');
      }
      references.push({ graph: value('graph')!, subject: value('subject')!, revisionId,
        byteDigest: value('digest'), preparationId: value('preparation'),
        ownerEpoch: value('epoch'), ownerSequence: value('sequence') });
    }
    if (rows.length < 200) return references;
  }
}

async function scanTable(client: PoolClient, schema: 'content' | 'pkg',
  name: typeof TABLES[number][0] | typeof PACKAGE_TABLES[number][0], key: string) {
  const hash = createHash('sha256');
  let count = 0;
  let after: string | null = null;
  for (;;) {
    const result: QueryResult<Record<string, unknown>> = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${schema}.${name} WHERE ($1::text IS NULL OR ${key}::text > $1)
       ORDER BY ${key}::text LIMIT 128`, [after]);
    for (const row of result.rows as Record<string, unknown>[]) {
      if (schema === 'content' && name === 'revision' && row.availability === 'available') {
        const bytes = row.serialized_bytes;
        if (!Buffer.isBuffer(bytes) || digestBytes(bytes) !== row.byte_digest
          || bytes.length !== row.byte_length || !exactBodyMatches(bytes, row.body)) {
          throw new ContentRecoveryConflict(`exact Content body is missing or corrupt: ${row.id}`);
        }
      }
      hash.update(JSON.stringify(stable(row))).update('\n');
      count++;
      after = String(row[key]);
    }
    if (result.rows.length < 128) break;
  }
  return { count: String(count), digest: hash.digest('hex') };
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertReferences(client: PoolClient, references: readonly GraphContentReference[],
  ownerEpoch: string, sequence: string): Promise<void> {
  for (const ref of references) {
    const revision = await client.query<{ byte_digest: string; availability: string;
      serialized_bytes: Buffer | null; byte_length: number }>(
      'SELECT byte_digest, availability, serialized_bytes, byte_length FROM content.revision WHERE id = $1',
      [ref.revisionId]);
    const row = revision.rows[0];
    if (revision.rowCount !== 1 || row?.availability !== 'available'
      || !row.serialized_bytes || digestBytes(row.serialized_bytes) !== row.byte_digest
      || row.serialized_bytes.length !== row.byte_length
      || (ref.byteDigest !== null && ref.byteDigest !== row.byte_digest)) {
      throw new ContentRecoveryConflict(`exact Content revision is unavailable: ${ref.revisionId}`);
    }
    if (ref.preparationId !== null) {
      const proof = await client.query<{ revision_id: string; data_epoch: string;
        sequence: string; outbox_id: string | null }>(
        `SELECT p.revision_id, r.data_epoch::text, r.sequence::text, o.id::text AS outbox_id
         FROM content.publication_preparation p
         JOIN content.receipt r ON r.operation_id = p.operation_id
           AND r.action = 'publication.prepare' AND r.outcome = 'succeeded'
         LEFT JOIN content.outbox o ON o.operation_id = r.operation_id
           AND o.data_epoch = r.data_epoch AND o.sequence = r.sequence
         WHERE p.operation_id = $1 AND p.revision_id = $2`,
        [ref.preparationId, ref.revisionId]);
      const pin = proof.rows[0];
      if (proof.rowCount !== 1 || !pin?.outbox_id || pin.data_epoch !== ownerEpoch
        || (ref.ownerEpoch !== null && ref.ownerEpoch !== pin.data_epoch)
        || (ref.ownerSequence !== null && ref.ownerSequence !== pin.sequence)
        || BigInt(pin.sequence) > BigInt(sequence)) {
        throw new ContentRecoveryConflict(`Content preparation, receipt or outbox is unavailable: ${ref.preparationId}`);
      }
    } else if (ref.ownerEpoch !== null && ref.ownerSequence !== null) {
      const event = await client.query<{ id: string }>(
        `SELECT id::text FROM content.outbox WHERE data_epoch = $1 AND sequence = $2
          AND revision_id = $3`, [ref.ownerEpoch, ref.ownerSequence, ref.revisionId]);
      if (ref.ownerEpoch !== ownerEpoch || BigInt(ref.ownerSequence) > BigInt(sequence)
        || event.rowCount !== 1) {
        throw new ContentRecoveryConflict(`Content outbox position is unavailable: ${ref.ownerSequence}`);
      }
    }
  }
}

/** Called with externally quiesced writers. A repeatable-read scan binds owner rows and exact bytes. */
export async function captureContentRecoveryCoverage(pool: Pool,
  references: readonly GraphContentReference[]): Promise<ContentRecoveryCoverage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const control = await client.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch::text, sequence::text FROM content.owner_control WHERE singleton = true');
    const owner = control.rows[0];
    if (control.rowCount !== 1 || !owner || !UUID.test(owner.data_epoch)
      || !DECIMAL.test(owner.sequence)) throw new ContentRecoveryConflict('Content owner cut is unavailable');
    await assertReferences(client, references, owner.data_epoch, owner.sequence);
    const tables = {} as ContentRecoveryCoverage['tables'];
    for (const [name, key] of TABLES) tables[name] = await scanTable(client, 'content', name, key);
    const packageTables = {} as ContentRecoveryCoverage['packageTables'];
    for (const [name, key] of PACKAGE_TABLES) {
      packageTables[name] = await scanTable(client, 'pkg', name, key);
    }
    await client.query('COMMIT');
    return { version: 3, dataEpoch: owner.data_epoch, sequence: owner.sequence,
      graphReferencesCount: String(references.length), graphReferencesDigest: digest(references),
      tables, packageTables };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

export async function assertContentRecoveryCoverage(pool: Pool, fuseki: FusekiClient,
  expected: ContentRecoveryCoverage): Promise<void> {
  if (expected?.version !== 3 || !UUID.test(expected.dataEpoch ?? '')
    || !DECIMAL.test(expected.sequence ?? '') || !DECIMAL.test(expected.graphReferencesCount ?? '')
    || !SHA.test(expected.graphReferencesDigest ?? '') || !expected.tables
    || !expected.packageTables) {
    throw new ContentRecoveryConflict('Content recovery coverage is invalid');
  }
  const references = await graphContentReferences(fuseki);
  if (String(references.length) !== expected.graphReferencesCount
    || digest(references) !== expected.graphReferencesDigest) {
    throw new ContentRecoveryConflict('restored graph Content references differ from captured cut');
  }
  const actual = await captureContentRecoveryCoverage(pool, references);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ContentRecoveryConflict('restored Content owner differs from captured cut');
  }
}
