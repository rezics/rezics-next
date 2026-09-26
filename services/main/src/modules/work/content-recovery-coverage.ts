import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { RV } from './activate.ts';
import { canonicalRowText, ownerCatalog, scanOwnerTable,
  type OwnerCatalog, type OwnerTable, type RowCoverage } from './pg-recovery-frontier.ts';

export class ContentRecoveryConflict extends Error {}

/**
 * One graph quad whose object has the owner-row IRI form. For
 * `rv:contentRevision`, the subject's byte digest, preparation and owner
 * position are Content's revision pin; other predicates carry no pin.
 */
export interface GraphContentReference {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
  byteDigest: string | null;
  preparationId: string | null;
  ownerEpoch: string | null;
  ownerSequence: string | null;
}

/** Version 5 derives its table set from the Content owner catalog. */
export interface ContentRecoveryCoverage {
  version: 5;
  dataEpoch: string;
  sequence: string;
  graphReferencesCount: string;
  graphReferencesDigest: string;
  catalogDigest: string;
  tables: Record<string, RowCoverage>;
  excluded: Record<string, string>;
}

const CONTENT_REVISION = `${RV}contentRevision`;
const REVISION_TABLE = 'content.revision';
const REVISION = 'urn:rezics:content:revision:';
/** `urn:rezics:<schema>:<table with - for _>:<primary key text>` names one owner row. */
const OWNER_IRI = /^urn:rezics:([a-z][a-z0-9_]*):([a-z][a-z0-9-]*):(.+)$/;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stable(value: unknown): unknown {
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

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const order = (reference: GraphContentReference): string => JSON.stringify([
  reference.graph, reference.subject, reference.predicate, reference.object, reference.byteDigest,
  reference.preparationId, reference.ownerEpoch, reference.ownerSequence]);

function sorted(references: readonly GraphContentReference[]): GraphContentReference[] {
  return references.map(reference => ({ reference, key: order(reference) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(item => item.reference);
}

function wellFormed(reference: GraphContentReference): boolean {
  const pinned = reference?.predicate === CONTENT_REVISION;
  return typeof reference?.graph === 'string' && reference.graph !== ''
    && typeof reference.subject === 'string' && reference.subject !== ''
    && typeof reference.predicate === 'string' && reference.predicate !== ''
    && typeof reference.object === 'string'
    && (pinned ? reference.object.startsWith(REVISION)
      && UUID.test(reference.object.slice(REVISION.length)) : OWNER_IRI.test(reference.object))
    && (reference.byteDigest === null || (pinned && SHA.test(reference.byteDigest)))
    && (reference.preparationId === null || (pinned && reference.preparationId !== ''))
    && (reference.ownerSequence === null || (pinned && DECIMAL.test(reference.ownerSequence)))
    && (reference.ownerEpoch === null) === (reference.ownerSequence === null)
    && (reference.ownerEpoch === null || UUID.test(reference.ownerEpoch));
}

/**
 * Enumerate every graph quad that may reference an owner row: each
 * `rv:contentRevision` with its pin, and any other IRI object of the owner-row
 * form. The owner catalog later decides which candidates name owner rows.
 */
export async function graphContentReferences(fuseki: FusekiClient): Promise<GraphContentReference[]> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?graph ?subject ?predicate ?object ?digest ?preparation ?epoch ?sequence WHERE {
      { GRAPH ?graph { ?subject rv:contentRevision ?object .
          OPTIONAL { ?subject rv:byteDigest ?digest }
          OPTIONAL { ?subject rv:contentPreparation ?preparation }
          OPTIONAL { ?subject rv:ownerDataEpoch ?epoch }
          OPTIONAL { ?subject rv:ownerSequence ?sequence } }
        BIND(rv:contentRevision AS ?predicate) }
      UNION
      { GRAPH ?graph { ?subject ?predicate ?object }
        FILTER(?predicate != rv:contentRevision && isIRI(?object)
          && STRSTARTS(STR(?object), "urn:rezics:")
          && REGEX(STR(?object), "^urn:rezics:[a-z][a-z0-9_]*:[a-z][a-z0-9-]*:.")) }
    }`);
  const rows = result.results?.bindings;
  if (!rows) throw new ContentRecoveryConflict('graph Content reference query is incomplete');
  const references = rows.map(row => {
    const value = (name: string) => row[name]?.value ?? null;
    const reference: GraphContentReference = { graph: value('graph')!, subject: value('subject')!,
      predicate: value('predicate')!, object: value('object')!, byteDigest: value('digest'),
      preparationId: value('preparation'), ownerEpoch: value('epoch'), ownerSequence: value('sequence') };
    if (!wellFormed(reference)) throw new ContentRecoveryConflict('graph Content reference is malformed');
    return reference;
  });
  return sorted(references);
}

interface OwnedReferences {
  /** Sorted owner references; the only candidates bound into coverage. */
  references: GraphContentReference[];
  /** `rv:contentRevision` references, checked against Content's revision pin. */
  pinned: GraphContentReference[];
  /** Other references by table name and canonical primary-key text. */
  keys: Map<string, Set<string>>;
}

/** Keep candidates whose IRI names a covered owner table; fail closed on unverifiable ones. */
export function ownedReferences(catalog: Pick<OwnerCatalog, 'tables' | 'excluded'>,
  candidates: readonly GraphContentReference[]): OwnedReferences {
  const tables = new Map<string, OwnerTable>();
  for (const table of catalog.tables) {
    if (IDENTIFIER.test(table.schema) && IDENTIFIER.test(table.table)) tables.set(table.name, table);
  }
  const owned: OwnedReferences = { references: [], pinned: [], keys: new Map() };
  for (const reference of sorted(candidates)) {
    if (!wellFormed(reference)) throw new ContentRecoveryConflict('graph Content reference is malformed');
    if (reference.predicate === CONTENT_REVISION) {
      if (!tables.has(REVISION_TABLE)) {
        throw new ContentRecoveryConflict('Content revision table is not covered');
      }
      owned.references.push(reference);
      owned.pinned.push(reference);
      continue;
    }
    const [, schema, slug, key] = OWNER_IRI.exec(reference.object)!;
    const name = `${schema}.${slug!.replaceAll('-', '_')}`;
    if (Object.hasOwn(catalog.excluded, name)) {
      throw new ContentRecoveryConflict(`graph references excluded owner state: ${reference.object}`);
    }
    const table = tables.get(name);
    if (!table) continue;
    if (table.key.length !== 1) {
      throw new ContentRecoveryConflict(`graph references a composite-key owner row: ${reference.object}`);
    }
    owned.references.push(reference);
    const keys = owned.keys.get(name) ?? new Set<string>();
    keys.add(key!);
    owned.keys.set(name, keys);
  }
  return owned;
}

async function assertRevisionPins(client: PoolClient, references: readonly GraphContentReference[],
  ownerEpoch: string, sequence: string): Promise<void> {
  for (const ref of references) {
    const revisionId = ref.object.slice(REVISION.length);
    const revision = await client.query<{ byte_digest: string; availability: string;
      serialized_bytes: Buffer | null; byte_length: number }>(
      'SELECT byte_digest, availability, serialized_bytes, byte_length FROM content.revision WHERE id = $1',
      [revisionId]);
    const row = revision.rows[0];
    if (revision.rowCount !== 1 || row?.availability !== 'available'
      || !row.serialized_bytes || digestBytes(row.serialized_bytes) !== row.byte_digest
      || row.serialized_bytes.length !== row.byte_length
      || (ref.byteDigest !== null && ref.byteDigest !== row.byte_digest)) {
      throw new ContentRecoveryConflict(`exact Content revision is unavailable: ${revisionId}`);
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
        [ref.preparationId, revisionId]);
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
          AND revision_id = $3`, [ref.ownerEpoch, ref.ownerSequence, revisionId]);
      if (ref.ownerEpoch !== ownerEpoch || BigInt(ref.ownerSequence) > BigInt(sequence)
        || event.rowCount !== 1) {
        throw new ContentRecoveryConflict(`Content outbox position is unavailable: ${ref.ownerSequence}`);
      }
    }
  }
}

/** Every available revision row must still hold its exact bytes and parsed body. */
function assertExactRevision(body: string): void {
  const row = JSON.parse(body) as { id: string; availability: string; serialized_bytes: string | null;
    byte_digest: string; byte_length: number; body: unknown };
  if (row.availability !== 'available') return;
  const bytes = typeof row.serialized_bytes === 'string' && row.serialized_bytes.startsWith('\\x')
    ? Buffer.from(row.serialized_bytes.slice(2), 'hex') : null;
  if (!bytes || digestBytes(bytes) !== row.byte_digest || bytes.length !== row.byte_length
    || !exactBodyMatches(bytes, row.body)) {
    throw new ContentRecoveryConflict(`exact Content body is missing or corrupt: ${row.id}`);
  }
}

async function readOnly<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await canonicalRowText(client);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { client.release(); }
}

/** Called with externally quiesced writers. A repeatable-read scan binds owner rows and exact bytes. */
export async function captureContentRecoveryCoverage(pool: Pool,
  references: readonly GraphContentReference[]): Promise<ContentRecoveryCoverage> {
  return readOnly(pool, async client => {
    const control = await client.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch::text, sequence::text FROM content.owner_control WHERE singleton = true');
    const owner = control.rows[0];
    if (control.rowCount !== 1 || !owner || !UUID.test(owner.data_epoch)
      || !DECIMAL.test(owner.sequence)) throw new ContentRecoveryConflict('Content owner cut is unavailable');
    const catalog = await ownerCatalog(client);
    const owned = ownedReferences(catalog, references);
    await assertRevisionPins(client, owned.pinned, owner.data_epoch, owner.sequence);
    const tables: Record<string, RowCoverage> = {};
    for (const table of catalog.tables) {
      const wanted = owned.keys.get(table.name);
      tables[table.name] = await scanOwnerTable(client, table, (key, body) => {
        wanted?.delete(key[0]!);
        if (table.name === REVISION_TABLE) assertExactRevision(body);
      });
      const missing = wanted?.values().next();
      if (missing && !missing.done) {
        throw new ContentRecoveryConflict(`graph owner reference is unavailable: ${
          table.name} ${missing.value}`);
      }
    }
    return { version: 5, dataEpoch: owner.data_epoch, sequence: owner.sequence,
      graphReferencesCount: String(owned.references.length),
      graphReferencesDigest: digest(owned.references), catalogDigest: catalog.digest,
      tables, excluded: { ...catalog.excluded } };
  });
}

export async function assertContentRecoveryCoverage(pool: Pool, fuseki: FusekiClient,
  expected: ContentRecoveryCoverage): Promise<void> {
  if (expected?.version !== 5) {
    throw new ContentRecoveryConflict(`Content recovery coverage version ${String(expected?.version)
    } is not version 5; capture a fresh fenced cut`);
  }
  if (!UUID.test(expected.dataEpoch ?? '') || !DECIMAL.test(expected.sequence ?? '')
    || !DECIMAL.test(expected.graphReferencesCount ?? '')
    || !SHA.test(expected.graphReferencesDigest ?? '') || !SHA.test(expected.catalogDigest ?? '')
    || !expected.tables || typeof expected.tables !== 'object'
    || !expected.excluded || typeof expected.excluded !== 'object') {
    throw new ContentRecoveryConflict('Content recovery coverage is invalid');
  }
  const candidates = await graphContentReferences(fuseki);
  const owned = await readOnly(pool, async client => ownedReferences(await ownerCatalog(client), candidates));
  if (String(owned.references.length) !== expected.graphReferencesCount
    || digest(owned.references) !== expected.graphReferencesDigest) {
    throw new ContentRecoveryConflict('restored graph Content references differ from captured cut');
  }
  const actual = await captureContentRecoveryCoverage(pool, candidates);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ContentRecoveryConflict('restored Content owner differs from captured cut');
  }
}
