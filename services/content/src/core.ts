import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class ContentConflict extends Error {}
export class ContentUnavailable extends Error {}
export class ContentLimitExceeded extends Error {}

export type LanguageIdentity =
  | { kind: 'tag'; tag: string; originalTag: string }
  | { kind: 'missing' | 'und' | 'mul' | 'zxx' };

export interface VariantIdentity {
  id: string;
  resourceId: string;
  language: LanguageIdentity;
  direction: 'ltr' | 'rtl' | 'none';
}

export interface ContentPosition { owner: 'content'; dataEpoch: string; sequence: string }
export interface ExactContentReference {
  owner: 'content';
  variantId: string;
  revisionId: string;
  format: 'rezics-content-json-v1';
  model: string;
  byteDigest: string;
  byteLength: number;
  language: LanguageIdentity;
  direction: VariantIdentity['direction'];
  sourceRevision: string | null;
  provenance: Record<string, unknown>;
}

export interface SaveDraftCommand {
  operationId: string;
  variant: VariantIdentity;
  expectedHead: string | null;
  model: string;
  sourceRevision: string | null;
  provenance: Record<string, unknown>;
  serializedJson: string;
}
export interface SaveDraftResult {
  outcome: 'succeeded' | 'stale_head';
  revisionId: string | null;
  predecessor: string | null;
  position: ContentPosition;
  replayed: boolean;
}
export interface PublicationPreparation {
  operationId: string;
  reference: ExactContentReference;
  position: ContentPosition;
  status: 'pending' | 'active' | 'rejected';
  pinActive: boolean;
  replayed: boolean;
}
export interface GraphTerminalProof {
  outcome: 'active' | 'rejected';
  revisionId: string;
  receipt: string;
  dataEpoch: string;
  sequence: string;
}
export interface ContentOutboxEvent {
  id: string;
  position: ContentPosition;
  operationId: string;
  eventType: string;
  recipe: string;
  revisionId: string | null;
  payload: Record<string, unknown>;
}
export type ExactReadResult =
  | { revisionId: string; status: 'available'; reference: ExactContentReference; serializedJson: string; body: Record<string, unknown> }
  | { revisionId: string; status: 'denied' | 'missing' | 'erased' | 'unavailable' | 'corrupt' };

const MAX_BODY_BYTES = 1_048_576;
const MAX_READ_ITEMS = 64;
const MAX_READ_BYTES = 4_194_304;
const FORMAT = 'rezics-content-json-v1' as const;
const RECIPE = 'content-body-v1';

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkId(value: string, name: string, max = 300): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw new ContentConflict(`invalid ${name}`);
  }
}

function checkedLanguage(language: LanguageIdentity): LanguageIdentity {
  if (language.kind !== 'tag') return language;
  if (!language.originalTag || language.originalTag.length > 100) throw new ContentConflict('invalid original language tag');
  let canonical: string;
  try { canonical = Intl.getCanonicalLocales(language.originalTag)[0] ?? ''; }
  catch { throw new ContentConflict('invalid language tag'); }
  if (!canonical || canonical !== language.tag) throw new ContentConflict('language tag must be canonical');
  return language;
}

function validateVariant(variant: VariantIdentity): void {
  checkId(variant.id, 'variant id');
  checkId(variant.resourceId, 'resource id');
  checkedLanguage(variant.language);
  if (!['tag', 'missing', 'und', 'mul', 'zxx'].includes(variant.language.kind)) throw new ContentConflict('invalid language kind');
  if (!['ltr', 'rtl', 'none'].includes(variant.direction)) throw new ContentConflict('invalid direction');
}

function validateProvenance(provenance: Record<string, unknown>): void {
  if (!provenance || Array.isArray(provenance) || typeof provenance !== 'object') {
    throw new ContentConflict('invalid provenance');
  }
  try {
    if (stable(JSON.parse(JSON.stringify(provenance))) !== stable(provenance)) {
      throw new ContentConflict('provenance must be JSON');
    }
    if (Buffer.byteLength(JSON.stringify(provenance), 'utf8') > 16_384) {
      throw new ContentLimitExceeded('provenance exceeds 16 KiB');
    }
  } catch (error) {
    if (error instanceof ContentConflict || error instanceof ContentLimitExceeded) throw error;
    throw new ContentConflict('provenance must be JSON');
  }
}

function checkUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ContentConflict(`invalid ${name}`);
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function operationLock(client: PoolClient, operationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId]);
}

async function nextPosition(client: PoolClient): Promise<ContentPosition> {
  const result = await client.query('UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton RETURNING data_epoch, sequence::text');
  if (result.rowCount !== 1) throw new ContentUnavailable('Content owner position unavailable');
  return { owner: 'content', dataEpoch: result.rows[0].data_epoch, sequence: result.rows[0].sequence };
}

async function writeReceiptEvent(client: PoolClient, args: {
  operationId: string; digest: string; action: string; outcome: string; variantId: string | null;
  revisionId: string | null; reason?: string; position: ContentPosition; eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await client.query(`INSERT INTO content.receipt
    (operation_id, request_digest, action, outcome, variant_id, revision_id, reason, data_epoch, sequence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [args.operationId, args.digest, args.action,
    args.outcome, args.variantId, args.revisionId, args.reason ?? null, args.position.dataEpoch, args.position.sequence]);
  await client.query(`INSERT INTO content.outbox
    (id, data_epoch, sequence, operation_id, event_type, recipe, revision_id, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [randomUUID(), args.position.dataEpoch,
    args.position.sequence, args.operationId, args.eventType, RECIPE, args.revisionId,
    JSON.stringify(args.payload)]);
}

function position(row: { data_epoch: string; sequence: string }): ContentPosition {
  return { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence };
}

function languageFromRow(row: { language_kind: string; language_tag: string | null; original_language_tag: string | null }): LanguageIdentity {
  if (row.language_kind === 'tag') return { kind: 'tag', tag: row.language_tag!, originalTag: row.original_language_tag! };
  return { kind: row.language_kind as Exclude<LanguageIdentity['kind'], 'tag'> };
}

function referenceFromRow(row: Record<string, any>): ExactContentReference {
  return { owner: 'content', variantId: row.variant_id, revisionId: row.id, format: FORMAT,
    model: row.model, byteDigest: row.byte_digest, byteLength: row.byte_length,
    language: languageFromRow(row as any), direction: row.direction,
    sourceRevision: row.source_revision, provenance: row.provenance };
}

async function readReference(client: PoolClient, revisionId: string): Promise<ExactContentReference | null> {
  const result = await client.query(`SELECT r.id, r.variant_id, r.model, r.byte_digest, r.byte_length,
    r.availability, r.serialized_bytes, r.body, r.source_revision, r.provenance,
    v.language_kind, v.language_tag, v.original_language_tag, v.direction
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id WHERE r.id = $1`, [revisionId]);
  if (!result.rowCount || result.rows[0].availability !== 'available') return null;
  const row = result.rows[0];
  const bytes = row.serialized_bytes as Buffer;
  if (!bytes || bytes.length !== row.byte_length || hash(bytes) !== row.byte_digest) return null;
  try {
    if (stable(JSON.parse(bytes.toString('utf8'))) !== stable(row.body)) return null;
  } catch { return null; }
  return referenceFromRow(result.rows[0]);
}

export class ContentCore {
  constructor(private readonly pool: Pool) {}

  async ownerPosition(): Promise<ContentPosition> {
    const result = await this.pool.query('SELECT data_epoch, sequence::text AS sequence FROM content.owner_control WHERE singleton');
    if (result.rowCount !== 1) throw new ContentUnavailable('Content owner position unavailable');
    return position(result.rows[0]);
  }

  async saveDraft(command: SaveDraftCommand): Promise<SaveDraftResult> {
    checkId(command.operationId, 'operation id', 200);
    validateVariant(command.variant);
    if (command.expectedHead !== null) checkUuid(command.expectedHead, 'expected head');
    checkId(command.model, 'model', 200);
    if (command.sourceRevision !== null) checkId(command.sourceRevision, 'source revision');
    validateProvenance(command.provenance);
    let body: Record<string, unknown>;
    try { body = JSON.parse(command.serializedJson); }
    catch { throw new ContentConflict('body is not JSON'); }
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new ContentConflict('body must be a JSON object');
    const bytes = Buffer.from(command.serializedJson, 'utf8');
    if (bytes.toString('utf8') !== command.serializedJson) throw new ContentConflict('body contains ill-formed Unicode');
    if (bytes.length < 1 || bytes.length > MAX_BODY_BYTES) throw new ContentLimitExceeded('body exceeds 1 MiB');
    const byteDigest = hash(bytes);
    const digest = hash(stable({ action: 'draft.save', variant: command.variant,
      expectedHead: command.expectedHead, model: command.model,
      sourceRevision: command.sourceRevision, provenance: command.provenance, byteDigest }));
    return transaction(this.pool, async (client) => {
      await operationLock(client, command.operationId);
      const previous = await client.query('SELECT * FROM content.receipt WHERE operation_id = $1', [command.operationId]);
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.request_digest !== digest || row.action !== 'draft.save') throw new ContentConflict('operation key reused with another request');
        return { outcome: row.outcome, revisionId: row.revision_id, predecessor: command.expectedHead,
          position: position(row), replayed: true } as SaveDraftResult;
      }
      if (command.expectedHead === null) {
        await client.query(`INSERT INTO content.variant
          (id, resource_id, language_kind, language_tag, original_language_tag, direction)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [command.variant.id, command.variant.resourceId, command.variant.language.kind,
          command.variant.language.kind === 'tag' ? command.variant.language.tag : null,
          command.variant.language.kind === 'tag' ? command.variant.language.originalTag : null,
          command.variant.direction]);
      }
      const variants = await client.query('SELECT * FROM content.variant WHERE id = $1 FOR UPDATE', [command.variant.id]);
      const variant = variants.rows[0];
      if (variant && (variant.resource_id !== command.variant.resourceId
        || variant.language_kind !== command.variant.language.kind
        || variant.language_tag !== (command.variant.language.kind === 'tag' ? command.variant.language.tag : null)
        || variant.original_language_tag !== (command.variant.language.kind === 'tag' ? command.variant.language.originalTag : null)
        || variant.direction !== command.variant.direction)) {
        throw new ContentConflict('variant identity differs');
      }
      if (!variant || variant.draft_head !== command.expectedHead) {
        const sourcePosition = await nextPosition(client);
        await writeReceiptEvent(client, { operationId: command.operationId, digest, action: 'draft.save',
          outcome: 'stale_head', variantId: variant?.id ?? null, revisionId: null,
          reason: 'expected head differs', position: sourcePosition, eventType: 'content.draft.stale',
          payload: { variantId: command.variant.id, expectedHead: command.expectedHead } });
        return { outcome: 'stale_head', revisionId: null, predecessor: command.expectedHead,
          position: sourcePosition, replayed: false };
      }
      const revisionId = randomUUID();
      await client.query(`INSERT INTO content.revision
        (id, variant_id, predecessor, operation_id, format, model, source_revision, provenance,
          byte_digest, byte_length, serialized_bytes, body)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb)`,
      [revisionId, command.variant.id, command.expectedHead, command.operationId, FORMAT, command.model,
        command.sourceRevision, JSON.stringify(command.provenance), byteDigest, bytes.length, bytes, command.serializedJson]);
      await client.query('UPDATE content.variant SET draft_head = $2 WHERE id = $1', [command.variant.id, revisionId]);
      const sourcePosition = await nextPosition(client);
      await writeReceiptEvent(client, { operationId: command.operationId, digest, action: 'draft.save',
        outcome: 'succeeded', variantId: command.variant.id, revisionId, position: sourcePosition,
        eventType: 'content.revision.saved', payload: { variantId: command.variant.id, revisionId,
          predecessor: command.expectedHead, byteDigest, byteLength: bytes.length } });
      return { outcome: 'succeeded', revisionId, predecessor: command.expectedHead,
        position: sourcePosition, replayed: false };
    });
  }

  async preparePublication(operationId: string, revisionId: string, expectedDigest: string): Promise<PublicationPreparation> {
    checkId(operationId, 'operation id', 200);
    checkUuid(revisionId, 'revision id');
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new ContentConflict('invalid expected digest');
    const digest = hash(stable({ action: 'publication.prepare', operationId, revisionId, expectedDigest }));
    return transaction(this.pool, async (client) => {
      await operationLock(client, operationId);
      const occupied = await client.query('SELECT action FROM content.receipt WHERE operation_id = $1', [operationId]);
      if (occupied.rowCount && occupied.rows[0].action !== 'publication.prepare') throw new ContentConflict('operation key reused');
      const old = await client.query('SELECT * FROM content.publication_preparation WHERE operation_id = $1', [operationId]);
      if (old.rowCount && old.rows[0].request_digest !== digest) throw new ContentConflict('publication operation reused');
      const reference = await readReference(client, revisionId);
      if (!reference || reference.byteDigest !== expectedDigest) throw new ContentUnavailable('exact revision unavailable or digest differs');
      if (old.rowCount) {
        const receipt = await client.query('SELECT data_epoch, sequence::text AS sequence FROM content.receipt WHERE operation_id = $1', [operationId]);
        return { operationId, reference, position: position(receipt.rows[0]),
          status: old.rows[0].status, pinActive: old.rows[0].pin_active, replayed: true };
      }
      await client.query(`INSERT INTO content.publication_preparation
        (operation_id, revision_id, request_digest) VALUES ($1,$2,$3)`, [operationId, revisionId, digest]);
      const sourcePosition = await nextPosition(client);
      await writeReceiptEvent(client, { operationId, digest, action: 'publication.prepare', outcome: 'succeeded',
        variantId: reference.variantId, revisionId, position: sourcePosition,
        eventType: 'content.publication.prepared', payload: { reference } });
      return { operationId, reference, position: sourcePosition, status: 'pending', pinActive: true, replayed: false };
    });
  }

  async settlePublication(operationId: string, preparationId: string, proof: GraphTerminalProof): Promise<{
    status: 'active' | 'rejected'; pinActive: boolean; position: ContentPosition | null; replayed: boolean;
  }> {
    checkId(operationId, 'operation id', 200);
    checkId(preparationId, 'preparation id', 200);
    checkUuid(proof.revisionId, 'proof revision');
    if (!['active', 'rejected'].includes(proof.outcome) || !proof.receipt || !proof.dataEpoch
      || !/^(0|[1-9][0-9]*)$/.test(proof.sequence)) throw new ContentConflict('terminal graph proof required');
    const proofDigest = hash(stable(proof));
    const digest = hash(stable({ action: 'publication.settle', preparationId, proof }));
    return transaction(this.pool, async (client) => {
      await operationLock(client, operationId);
      const old = await client.query('SELECT * FROM content.receipt WHERE operation_id = $1', [operationId]);
      if (old.rowCount) {
        if (old.rows[0].request_digest !== digest || old.rows[0].action !== 'publication.settle') throw new ContentConflict('operation key reused');
        return { status: proof.outcome, pinActive: proof.outcome === 'active', position: position(old.rows[0]), replayed: true };
      }
      const result = await client.query('SELECT * FROM content.publication_preparation WHERE operation_id = $1 FOR UPDATE', [preparationId]);
      if (!result.rowCount) throw new ContentUnavailable('publication preparation missing');
      const preparation = result.rows[0];
      if (preparation.revision_id !== proof.revisionId) throw new ContentConflict('graph proof names another revision');
      if (preparation.status !== 'pending') {
        if (preparation.status !== proof.outcome || preparation.terminal_proof_digest !== proofDigest) {
          throw new ContentConflict('publication already settled with another proof');
        }
        return { status: proof.outcome, pinActive: preparation.pin_active, position: null, replayed: true };
      }
      await client.query(`UPDATE content.publication_preparation SET status = $2, pin_active = $3,
        graph_receipt = $4, graph_data_epoch = $5, graph_sequence = $6,
        terminal_proof_digest = $7, settled_at = now() WHERE operation_id = $1`,
      [preparationId, proof.outcome, proof.outcome === 'active', proof.receipt,
        proof.dataEpoch, proof.sequence, proofDigest]);
      const reference = await readReference(client, preparation.revision_id);
      if (!reference) throw new ContentUnavailable('prepared revision unavailable');
      const sourcePosition = await nextPosition(client);
      await writeReceiptEvent(client, { operationId, digest, action: 'publication.settle',
        outcome: proof.outcome === 'active' ? 'succeeded' : 'rejected', variantId: reference.variantId,
        revisionId: preparation.revision_id, position: sourcePosition,
        eventType: proof.outcome === 'active' ? 'content.publication.active' : 'content.publication.rejected',
        payload: { preparationId, revisionId: preparation.revision_id, graph: proof } });
      return { status: proof.outcome, pinActive: proof.outcome === 'active', position: sourcePosition, replayed: false };
    });
  }

  async readExactBatch(revisionIds: string[], authorize: (revisionIds: readonly string[]) => Promise<ReadonlySet<string>>): Promise<ExactReadResult[]> {
    if (revisionIds.length > MAX_READ_ITEMS || new Set(revisionIds).size !== revisionIds.length) {
      throw new ContentLimitExceeded('exact read requires at most 64 distinct revisions');
    }
    for (const id of revisionIds) checkUuid(id, 'revision id');
    const allowed = await authorize(revisionIds);
    const admitted = revisionIds.filter((id) => allowed.has(id));
    if (!admitted.length) return revisionIds.map((revisionId) => ({ revisionId, status: 'denied' }));
    const result = await this.pool.query(`WITH picked AS (
      SELECT r.*, v.language_kind, v.language_tag, v.original_language_tag, v.direction,
        sum(CASE WHEN r.availability = 'available' THEN r.byte_length ELSE 0 END) OVER () AS total_bytes
      FROM content.revision r JOIN content.variant v ON v.id = r.variant_id WHERE r.id = ANY($1::uuid[])
    ) SELECT id, variant_id, model, byte_digest, byte_length, availability,
      language_kind, language_tag, original_language_tag, direction, source_revision, provenance, total_bytes,
      CASE WHEN total_bytes <= $2 THEN serialized_bytes ELSE NULL END AS serialized_bytes,
      CASE WHEN total_bytes <= $2 THEN body ELSE NULL END AS body
      FROM picked`, [admitted, MAX_READ_BYTES]);
    const rows = new Map<string, Record<string, any>>(result.rows.map((row) => [row.id, row]));
    const requestedBytes = result.rows.length ? Number(result.rows[0].total_bytes) : 0;
    if (requestedBytes > MAX_READ_BYTES) throw new ContentLimitExceeded('exact read exceeds 4 MiB');
    return revisionIds.map((revisionId): ExactReadResult => {
      if (!allowed.has(revisionId)) return { revisionId, status: 'denied' };
      const row = rows.get(revisionId);
      if (!row) return { revisionId, status: 'missing' };
      if (row.availability !== 'available') return { revisionId, status: row.availability };
      const bytes = row.serialized_bytes as Buffer;
      if (!bytes || bytes.length !== row.byte_length || hash(bytes) !== row.byte_digest) return { revisionId, status: 'corrupt' };
      const serializedJson = bytes.toString('utf8');
      try {
        const body = JSON.parse(serializedJson);
        if (!body || Array.isArray(body) || typeof body !== 'object' || stable(body) !== stable(row.body)) {
          return { revisionId, status: 'corrupt' };
        }
        return { revisionId, status: 'available', reference: referenceFromRow(row), serializedJson, body };
      } catch { return { revisionId, status: 'corrupt' }; }
    });
  }

  async readOutbox(dataEpoch: string, afterSequence: string, limit: number): Promise<ContentOutboxEvent[]> {
    if (!/^[0-9a-f-]{36}$/.test(dataEpoch) || !/^(0|[1-9][0-9]*)$/.test(afterSequence)
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ContentLimitExceeded('invalid outbox window');
    const result = await this.pool.query(`SELECT id, data_epoch, sequence::text AS sequence,
      operation_id, event_type, recipe, revision_id, payload FROM content.outbox
      WHERE data_epoch = $1 AND sequence > $2::bigint ORDER BY sequence, id LIMIT $3`,
    [dataEpoch, afterSequence, limit]);
    return result.rows.map((row) => ({ id: row.id, position: position(row), operationId: row.operation_id,
      eventType: row.event_type, recipe: row.recipe, revisionId: row.revision_id, payload: row.payload }));
  }
}
