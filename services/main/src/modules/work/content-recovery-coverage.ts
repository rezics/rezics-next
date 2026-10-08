import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sequenceContentEvents } from '../../../../content/src/event-sequencer.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri, lit } from './activate.ts';
import { openCommentSourceRevisions, probeContentErasure } from '../erasure/content.ts';
import { readErasure } from '../erasure/journal.ts';
import { readRetainedNativeGraphSuppressionProof } from '../erasure/custody.ts';
import { publicationSupersessionsMatch } from '../erasure/replay-supersessions.ts';
import { graphErasureSuppressed } from '../erasure/graph.ts';
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

/** Caller owns the allocator-held READ COMMITTED relay transaction and, when
 * supplied, the same Content REPEATABLE READ snapshot used for every pin read. */
export interface ContentRecoveryProofContext {
  fuseki: FusekiClient;
  relayClient: PoolClient;
  contentClient?: PoolClient;
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
 * Quiesced named graphs partition the full scan into independently bounded
 * requests, including after an offline rebuild restarts Fuseki cold. O(Q + G)
 * engine work and O(R log R) client work for Q quads, G graphs and R references.
 */
export async function graphContentReferences(fuseki: FusekiClient): Promise<GraphContentReference[]> {
  const inventory = await fuseki.query('SELECT ?graph WHERE { GRAPH ?graph {} }');
  if (!inventory.results?.bindings) throw new ContentRecoveryConflict('graph inventory query is incomplete');
  const graphs = new Set(inventory.results.bindings.map(row => {
    if (row.graph?.type !== 'uri' || !row.graph.value)
      throw new ContentRecoveryConflict('graph inventory name is not an IRI');
    return row.graph.value;
  }));
  const references: GraphContentReference[] = [];
  for (const graph of graphs) {
    const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?graph ?subject ?predicate ?object ?digest ?preparation ?epoch ?sequence WHERE {
      BIND(IRI(${JSON.stringify(graph)}) AS ?graph)
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
    for (const row of rows) {
      if (row.graph?.value !== graph) throw new ContentRecoveryConflict('graph reference scan crossed its graph');
      const value = (name: string) => row[name]?.value ?? null;
      const reference: GraphContentReference = { graph: value('graph')!, subject: value('subject')!,
        predicate: value('predicate')!, object: value('object')!, byteDigest: value('digest'),
        preparationId: value('preparation'), ownerEpoch: value('epoch'), ownerSequence: value('sequence') };
      if (!wellFormed(reference)) throw new ContentRecoveryConflict('graph Content reference is malformed');
      references.push(reference);
    }
  }
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

async function transactionIdentity(client: PoolClient, isolation: string): Promise<string> {
  if ((await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation !== isolation) {
    throw new ContentRecoveryConflict(`Content recovery requires an active ${isolation} transaction`);
  }
  const first = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]?.id;
  const second = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]?.id;
  if (!first || !DECIMAL.test(first) || first !== second) {
    throw new ContentRecoveryConflict(`Content recovery requires an active ${isolation} transaction`);
  }
  return first;
}

/** Native events keep the immutable pin on their receipt; private projection
 * receipts keep it on their revision anchor. Signed reference tuples stay unchanged. */
async function linkedHistoricalPin(ref: GraphContentReference,
  proof: ContentRecoveryProofContext | undefined): Promise<GraphContentReference> {
  if (!proof?.fuseki) throw new ContentRecoveryConflict('erased Content pin requires retained graph digest');
  const rows = (await proof.fuseki.query(`PREFIX rv: <${RV}>
    SELECT DISTINCT ?digest ?preparation ?epoch ?sequence WHERE {
      GRAPH ${iri(ref.graph)} { ${iri(ref.subject)} rv:contentRevision ${iri(ref.object)} .
        FILTER NOT EXISTS { ${iri(ref.subject)} rv:byteDigest ?directDigest } }
      { GRAPH ${iri(ref.graph)} { ${iri(ref.subject)} rv:receipt ?anchor }
        GRAPH ${iri(GRAPHS.receipts)} { ?anchor a rv:OperationReceipt ; rv:contentRevision ${iri(ref.object)} ; rv:byteDigest ?digest .
          OPTIONAL { ?anchor rv:contentPreparation ?preparation }
          OPTIONAL { ?anchor rv:ownerDataEpoch ?epoch ; rv:ownerSequence ?sequence } } }
      UNION
      { GRAPH ${iri(ref.graph)} { ${iri(ref.subject)} rv:projection ?anchor }
        GRAPH ${iri(GRAPHS.revisions)} { ?anchor a rv:ContentPrivateProjection ; rv:contentRevision ${iri(ref.object)} ; rv:byteDigest ?digest .
          OPTIONAL { ?anchor rv:ownerDataEpoch ?epoch ; rv:ownerSequence ?sequence } } }
    } LIMIT 2`, 16_384)).results?.bindings ?? [];
  const row = rows[0];
  const anchor = { preparationId: row?.preparation?.value ?? null,
    ownerEpoch: row?.epoch?.value ?? null, ownerSequence: row?.sequence?.value ?? null };
  for (const field of ['preparationId','ownerEpoch','ownerSequence'] as const) {
    if (ref[field] !== null && ref[field] !== anchor[field]) {
      throw new ContentRecoveryConflict(`retained graph Content pin ${field} conflicts: ${ref.object}`);
    }
  }
  const pin = { ...ref, byteDigest: row?.digest?.value ?? null,
    preparationId: ref.preparationId ?? anchor.preparationId,
    ownerEpoch: ref.ownerEpoch ?? anchor.ownerEpoch, ownerSequence: ref.ownerSequence ?? anchor.ownerSequence };
  if (rows.length !== 1 || !wellFormed(pin) || !pin.byteDigest) {
    throw new ContentRecoveryConflict(`retained graph Content digest is unavailable or ambiguous: ${ref.object}`);
  }
  return pin;
}

async function assertErasedRevision(client: PoolClient, ref: GraphContentReference,
  revisionId: string, proof: ContentRecoveryProofContext | undefined): Promise<void> {
  if (!proof?.relayClient) throw new ContentRecoveryConflict('erased Content pin requires retained erasure proof context');
  const relay = proof.relayClient;
  const transaction = await transactionIdentity(relay, 'read committed');
  const allocator = (await relay.query<{ held: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid=((hashtextextended('rezics-relay-erasure-epoch',0) >> 32) & 4294967295)::oid
      AND objid=(hashtextextended('rezics-relay-erasure-epoch',0) & 4294967295)::oid
      AND objsubid=1 AND mode='ExclusiveLock' AND granted
  ) AS held`)).rows[0];
  if (allocator?.held !== true) throw new ContentRecoveryConflict('erased Content pin requires the retained journal allocator');
  const tombstone = (await client.query<{ erasure_id: string; erasure_epoch: string }>(
    'SELECT erasure_id::text, erasure_epoch::text FROM content.revision_erasure WHERE revision_id=$1',
    [revisionId])).rows;
  const erased = tombstone[0];
  if (tombstone.length !== 1 || !erased || !UUID.test(erased.erasure_id)
    || !/^[1-9][0-9]{0,18}$/.test(erased.erasure_epoch)) {
    throw new ContentRecoveryConflict(`Content erasure tombstone is unavailable: ${revisionId}`);
  }
  const report = await readErasure(relay, erased.erasure_id);
  const targets = report.targets.map(target => target.ref);
  if (!['revision', 'resource'].includes(report.kind) || report.suppression !== 'suppressed'
    || report.erasureId !== erased.erasure_id || report.erasureEpoch !== erased.erasure_epoch
    || !targets.length || targets.length > 64 || new Set(targets).size !== targets.length
    || !targets.includes(revisionId) || targets.some(target => !UUID.test(target))
    || report.targets.some(target => target.owner !== 'content' || target.kind !== 'content_revision')) {
    throw new ContentRecoveryConflict(`retained Content erasure journal differs: ${revisionId}`);
  }
  const probes = await probeContentErasure(client, erased.erasure_id, targets);
  if (targets.some(target => probes.get(target) !== 'erased')) {
    throw new ContentRecoveryConflict(`Content erasure targets are absent or foreign: ${revisionId}`);
  }
  const tombstones = (await client.query<{ mismatch: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM unnest($1::uuid[]) AS wanted(id)
    LEFT JOIN content.revision r ON r.id=wanted.id
    LEFT JOIN content.revision_erasure e ON e.revision_id=wanted.id
    WHERE r.id IS NULL OR r.availability IS DISTINCT FROM 'erased'
      OR r.serialized_bytes IS NOT NULL OR r.body IS NOT NULL
      OR e.erasure_id IS DISTINCT FROM $2::uuid OR e.erasure_epoch IS DISTINCT FROM $3::bigint
  ) AS mismatch`, [targets, erased.erasure_id, erased.erasure_epoch])).rows[0];
  if (tombstones?.mismatch !== false) {
    throw new ContentRecoveryConflict(`Content erasure tombstones differ from the full retained target set: ${revisionId}`);
  }
  const retained = await readRetainedNativeGraphSuppressionProof(relay,
    erased.erasure_id, erased.erasure_epoch, targets);
  if (!proof.fuseki || !await graphErasureSuppressed(proof.fuseki,
    erased.erasure_id, erased.erasure_epoch, targets)
    || (await proof.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(retained.original.receipt)} rv:dataEpoch ${lit(retained.original.dataEpoch)} ;
        rv:sequence ${retained.original.sequence} . } }`)).boolean !== true) {
    throw new ContentRecoveryConflict(`actual graph Content suppression differs from its retained proof: ${revisionId}`);
  }
  const operation = (await client.query<{ operation_id: string }>(`SELECT s.operation_id
    FROM content.publication_erasure_supersession s JOIN content.revision_erasure e
      ON e.revision_id=s.revision_id AND e.erasure_id=s.erasure_id AND e.erasure_epoch=s.erasure_epoch
    WHERE s.revision_id=$1 AND s.erasure_id=$2::uuid AND s.erasure_epoch=$3::bigint
      AND ($4::text IS NULL OR s.operation_id=$4)
      AND s.graph_receipt=$5 AND s.graph_data_epoch=$6 AND s.graph_sequence=$7::bigint
    LIMIT 1`, [revisionId, erased.erasure_id, erased.erasure_epoch, ref.preparationId,
    retained.original.receipt, retained.original.dataEpoch, retained.original.sequence])).rows;
  if (operation.length !== 1 || !await publicationSupersessionsMatch(client,
    targets, erased.erasure_id, erased.erasure_epoch, retained.original)) {
    throw new ContentRecoveryConflict(`Content publication erasure supersession differs: ${revisionId}`);
  }
  if (await transactionIdentity(relay, 'read committed') !== transaction) {
    throw new ContentRecoveryConflict('retained erasure transaction changed');
  }
}

/**
 * Call only after signed coverage comparison and erasure replay.
 * assertErasedRevision does not call this: a pre-replay cut may still hold
 * selectors. Success is the existing tombstone row plus indexed absence of an
 * open selector. It does not read the cleared-comment population, and an empty
 * target list is not a completed source erasure.
 */
export async function assertReplayedCommentSourcesTerminal(client: Pool | PoolClient,
  revisionIds: readonly string[], erasureId: string, erasureEpoch: string): Promise<void> {
  if (!revisionIds.length || revisionIds.length > 256) {
    throw new ContentRecoveryConflict('source terminal check exceeds the retained target bound');
  }
  let open: string[];
  try {
    open = await openCommentSourceRevisions(client, revisionIds);
    // Evidence selectors keep the same terminal rule: an erased revision has no open source row.
    open.push(...(await client.query<{ revision_id: string }>(
      'SELECT revision_id::text FROM verification.open_evidence_source_revisions($1::uuid[])',
      [revisionIds])).rows.map(row => row.revision_id));
  } catch (error) {
    throw new ContentRecoveryConflict('source terminal check exceeds the retained target bound',
      { cause: error });
  }
  if (open.length) {
    throw new ContentRecoveryConflict(`erased source selectors remain: ${open[0]}`);
  }
  const mismatch = (await client.query<{ mismatch: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM unnest($1::uuid[]) AS wanted(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM content.revision_erasure e
      JOIN content.revision r ON r.id = e.revision_id
      WHERE e.revision_id = wanted.id
        AND e.erasure_id = $2::uuid
        AND e.erasure_epoch = $3::bigint
        AND r.availability = 'erased'
        AND r.serialized_bytes IS NULL
        AND r.body IS NULL
    )
  ) AS mismatch`, [revisionIds, erasureId, erasureEpoch])).rows[0];
  if (mismatch?.mismatch !== false) {
    throw new ContentRecoveryConflict('comment source terminal does not match the revision tombstone');
  }
}

async function assertRevisionPins(client: PoolClient, references: readonly GraphContentReference[],
  ownerEpoch: string, sequence: string, proof?: ContentRecoveryProofContext): Promise<void> {
  for (const original of references) {
    let ref = original;
    const revisionId = ref.object.slice(REVISION.length);
    const revision = await client.query<{ byte_digest: string; availability: string;
      serialized_bytes: Buffer | null; byte_length: number; body: unknown }>(
      'SELECT byte_digest, availability, serialized_bytes, byte_length, body FROM content.revision WHERE id = $1',
      [revisionId]);
    const row = revision.rows[0];
    if (row?.availability === 'erased' && ref.byteDigest === null) ref = await linkedHistoricalPin(ref, proof);
    if (revision.rowCount !== 1 || !row || !['available','erased'].includes(row.availability)
      || (row.availability === 'available' && (!row.serialized_bytes
        || digestBytes(row.serialized_bytes) !== row.byte_digest || row.serialized_bytes.length !== row.byte_length))
      || (row.availability === 'erased' && (row.serialized_bytes !== null || row.body !== null
        || !SHA.test(row.byte_digest) || ref.byteDigest === null))
      || (ref.byteDigest !== null && ref.byteDigest !== row.byte_digest)) {
      throw new ContentRecoveryConflict(`exact Content revision is unavailable: ${revisionId}`);
    }
    if (row.availability === 'erased') {
      try { await assertErasedRevision(client, ref, revisionId, proof); }
      catch (error) {
        if (error instanceof ContentRecoveryConflict) throw error;
        throw new ContentRecoveryConflict(`retained Content erasure proof is unavailable: ${revisionId}`, { cause: error });
      }
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

async function readOnly<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, borrowed?: PoolClient): Promise<T> {
  if (borrowed) {
    const transaction = await transactionIdentity(borrowed, 'repeatable read');
    await canonicalRowText(borrowed);
    const value = await work(borrowed);
    if (await transactionIdentity(borrowed, 'repeatable read') !== transaction) {
      throw new ContentRecoveryConflict('Content recovery transaction changed');
    }
    return value;
  }
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

const unnumbered = 'SELECT 1 FROM content.receipt WHERE sequence IS NULL LIMIT 1';

/** Called with externally quiesced writers. Their committed events are numbered
 * first, so the owner cut covers every receipt the scan binds. A repeatable-read
 * scan binds owner rows and exact bytes. */
export async function captureContentRecoveryCoverage(pool: Pool,
  references: readonly GraphContentReference[], proof?: ContentRecoveryProofContext): Promise<ContentRecoveryCoverage> {
  for (let attempt = 0; !proof?.contentClient; attempt++) {
    await sequenceContentEvents(pool);
    if (!(await pool.query(unnumbered)).rowCount) break;
    if (attempt === 50) throw new ContentRecoveryConflict('Content events are not numbered');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return readOnly(pool, async client => {
    const control = await client.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch::text, sequence::text FROM content.owner_control WHERE singleton = true');
    const owner = control.rows[0];
    if (control.rowCount !== 1 || !owner || !UUID.test(owner.data_epoch)
      || !DECIMAL.test(owner.sequence)) throw new ContentRecoveryConflict('Content owner cut is unavailable');
    if ((await client.query(unnumbered)).rowCount) {
      throw new ContentRecoveryConflict('Content writers are not quiesced');
    }
    const catalog = await ownerCatalog(client);
    const owned = ownedReferences(catalog, references);
    await assertRevisionPins(client, owned.pinned, owner.data_epoch, owner.sequence, proof);
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
  }, proof?.contentClient);
}

export async function assertContentRecoveryCoverage(pool: Pool, fuseki: FusekiClient,
  expected: ContentRecoveryCoverage, proof?: ContentRecoveryProofContext): Promise<void> {
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
  const owned = await readOnly(pool, async client => ownedReferences(await ownerCatalog(client), candidates), proof?.contentClient);
  if (String(owned.references.length) !== expected.graphReferencesCount
    || digest(owned.references) !== expected.graphReferencesDigest) {
    throw new ContentRecoveryConflict('restored graph Content references differ from captured cut');
  }
  const actual = await captureContentRecoveryCoverage(pool, candidates, proof ? { ...proof, fuseki } : undefined);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ContentRecoveryConflict('restored Content owner differs from captured cut');
  }
}
