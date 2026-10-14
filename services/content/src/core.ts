import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { ownerControl } from './typed-schema.ts';
import { ContentEmbedInvalid, directContentEmbeds } from './embed.ts';
import { ContentConflict, ContentLimitExceeded, ContentUnavailable } from './errors.ts';
import { appendContentEvent, contentEventPosition, sequenceContentEvents,
  type ContentEvent } from './event-sequencer.ts';
import { retainedDocumentBody, retainedPostNotes, POST_CONTENT_MODEL, CONTENT_TEXT_COST, checkedContentText } from './document-body.ts';
import { documentImageUses, guardDocumentImageUses, DocumentMediaInvalid } from './document-media.ts';
import { hasDocumentContent } from '@rezics/document';
import { ContentDerivations } from './derivation.ts';

export { ContentConflict, ContentLimitExceeded, ContentPositionPending, ContentUnavailable } from './errors.ts';
export { appendContentEvent, contentEventPosition, sequenceContentEvents, type ContentEvent } from './event-sequencer.ts';

function revisionImageUses(body: Record<string, unknown>) {
  const notes = retainedPostNotes(body.notes);
  return [body.document, notes?.before?.document, notes?.after?.document]
    .flatMap(document => documentImageUses(document as Parameters<typeof documentImageUses>[0]));
}

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
  resourceId: string;
  variantId: string;
  revisionId: string;
  format: 'rezics-content-json-v1';
  model: string;
  byteDigest: string;
  byteLength: number;
  language: LanguageIdentity;
  direction: VariantIdentity['direction'];
  sourceRevision: string | null;
  predecessor: string | null;
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
export interface AdmittedAuthorProvenance {
  kind: 'admitted-original-contribution-v1';
  author: string;
  admissionId: string;
  authorityEpoch: string;
  scope: string;
  requestDigest: string;
  expectedHead: string | null;
  rightsBasis: 'original-contribution';
}
export interface PublicDomainTextSource {
  provider: string;
  identifier: string;
  url: string;
  byteDigest: string;
  retrievedAt: string;
}
export interface AdmittedPublicDomainProvenance {
  kind: 'admitted-public-domain-v1';
  transcriber: string;
  rightsBasis: 'public-domain';
  rightsAssessmentId: string;
  source: PublicDomainTextSource;
  admissionId: string;
  authorityEpoch: string;
  scope: string;
  requestDigest: string;
  expectedHead: string | null;
}
export interface SaveDraftResult {
  outcome: 'succeeded' | 'stale_head' | 'cancelled';
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
export interface ProjectionPublication {
  preparationId: string;
  preparationPosition: ContentPosition;
  reference: ExactContentReference;
  status: 'active' | 'rejected';
  graph: GraphTerminalProof;
}
export interface EligibilityDeliveryProgress {
  streamScope: string;
  graphDataEpoch: string;
  contentDataEpoch: string;
  sequence: string;
}
export interface EligibilityDeliverySourceEvent {
  id: string;
  type: 'com.rezics.content.search-eligible.v1';
  ordinal: number;
  sourcePosition: { dataEpoch: string; sequence: string };
  receipt: {
    id: string;
    action: 'content.search-eligibility';
    outcome: 'succeeded';
    requestDigest: string;
    resource: string;
    variant: string;
    publicationDecision: string;
    eligibilityDecision: string;
    disclosure: 'public';
  };
  publication: { preparationId: string; revisionId: string };
}
export interface EligibilityDeliveryBatch {
  sequence: string;
  id: string;
  digest: string;
  events: readonly EligibilityDeliverySourceEvent[];
}
export interface EligibilityDeliveryResult {
  progress: EligibilityDeliveryProgress;
  replayed: boolean;
  events: Array<{
    sourceEventId: string;
    sourceReceiptId: string;
    operationId: string;
    appended: boolean;
    position: ContentPosition | null;
  }>;
}
export interface EligibilityDeliveryPage {
  expected: EligibilityDeliveryProgress;
  batches: readonly EligibilityDeliveryBatch[];
}
export type ExactReadResult =
  | { revisionId: string; status: 'available'; reference: ExactContentReference; serializedJson: string; body: Record<string, unknown> }
  | { revisionId: string; status: 'denied' | 'missing' | 'erased' | 'unavailable' | 'corrupt' };

const MAX_BODY_BYTES = 1_048_576;
const MAX_READ_ITEMS = 64;
const MAX_READ_BYTES = 4_194_304;
const MAX_ELIGIBILITY_DELIVERY_BATCHES = 100;
const MAX_ELIGIBILITY_DELIVERY_EVENTS = 100;
const MAX_SQL_BIGINT = 9_223_372_036_854_775_807n;
const FORMAT = 'rezics-content-json-v1' as const;
const RECIPE = 'content-body-v1';
const ELIGIBILITY_DELIVERY_ACTION = 'publication.eligibility-deliver';
const ELIGIBILITY_DELIVERY_EVENT = 'content.publication.eligibility-delivered';

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

/** The Access request and later rights audit bind the same exact Content bytes. */
export function contentDraftIntentDigest(command: Pick<SaveDraftCommand,
  'variant' | 'expectedHead' | 'model' | 'sourceRevision' | 'serializedJson'>,
author: string, publicDomain?: { rightsAssessmentId: string; source: PublicDomainTextSource }): string {
  if (publicDomain) return hash(stable({ family: 'content-draft-public-domain-v1', variant: command.variant,
    expectedHead: command.expectedHead, model: command.model,
    sourceRevision: command.sourceRevision, byteDigest: hash(Buffer.from(command.serializedJson, 'utf8')),
    transcriber: author, rightsBasis: 'public-domain', ...publicDomain }));
  return hash(stable({ family: 'content-draft-author-v1', variant: command.variant,
    expectedHead: command.expectedHead, model: command.model,
    sourceRevision: command.sourceRevision, byteDigest: hash(Buffer.from(command.serializedJson, 'utf8')),
    author, rightsBasis: 'original-contribution' }));
}

export function validPublicDomainSource(source: PublicDomainTextSource): boolean {
  return typeof source.provider === 'string' && source.provider.length >= 1 && source.provider.length <= 100
    && typeof source.identifier === 'string' && source.identifier.length >= 1 && source.identifier.length <= 300
    && typeof source.url === 'string' && source.url.length <= 2048
    && /^https:\/\/[^\s]+$/i.test(source.url)
    && typeof source.byteDigest === 'string' && /^[0-9a-f]{64}$/.test(source.byteDigest)
    && typeof source.retrievedAt === 'string' && Number.isFinite(Date.parse(source.retrievedAt))
    && new Date(source.retrievedAt).toISOString() === source.retrievedAt;
}

function checkId(value: string, name: string, max = 300): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw new ContentConflict(`invalid ${name}`);
  }
}

function checkedMainPosition(value: string, name: string): bigint {
  return checkedDeliverySequence(value, name);
}

function checkedDeliverySequence(value: string, name: string, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ContentConflict(`invalid ${name}`);
  }
  const sequence = BigInt(value);
  if ((!allowZero && sequence === 0n) || sequence > MAX_SQL_BIGINT) {
    throw new ContentConflict(`invalid ${name}`);
  }
  return sequence;
}

interface CheckedEligibilityDeliveryEvent {
  input: EligibilityDeliverySourceEvent;
  batch: EligibilityDeliveryBatch;
  operationId: string;
  requestDigest: string;
  identity: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function checkedEligibilityDeliveryPage(page: EligibilityDeliveryPage): {
  expected: EligibilityDeliveryProgress;
  batches: Array<{ input: EligibilityDeliveryBatch; requestDigest: string; events: CheckedEligibilityDeliveryEvent[] }>;
  events: CheckedEligibilityDeliveryEvent[];
} {
  if (!page || !page.expected || !Array.isArray(page.batches)
    || page.batches.length < 1 || page.batches.length > MAX_ELIGIBILITY_DELIVERY_BATCHES) {
    throw new ContentLimitExceeded('eligibility delivery requires 1 to 100 Main batches');
  }
  const expected = page.expected;
  checkId(expected.streamScope, 'Main stream scope');
  checkUuid(expected.graphDataEpoch, 'Main graph epoch');
  checkUuid(expected.contentDataEpoch, 'Content owner epoch');
  let sequence = checkedDeliverySequence(expected.sequence, 'expected Main stream position', true);
  const seenEvents = new Set<string>(), seenReceipts = new Set<string>();
  let eventCount = 0;
  const checkedBatches: Array<{ input: EligibilityDeliveryBatch; requestDigest: string; events: CheckedEligibilityDeliveryEvent[] }> = [];
  const allEvents: CheckedEligibilityDeliveryEvent[] = [];
  for (const batch of page.batches) {
    const next = checkedDeliverySequence(batch.sequence, 'Main batch position');
    if (next !== sequence + 1n) throw new ContentConflict('Main eligibility delivery batches are not contiguous');
    sequence = next;
    checkId(batch.id, 'Main batch id');
    if (!/^[0-9a-f]{64}$/.test(batch.digest)) throw new ContentConflict('invalid Main batch digest');
    if (!Array.isArray(batch.events)) throw new ContentConflict('invalid Main eligibility event list');
    eventCount += batch.events.length;
    if (batch.events.length > MAX_ELIGIBILITY_DELIVERY_EVENTS
      || eventCount > MAX_ELIGIBILITY_DELIVERY_EVENTS) {
      throw new ContentLimitExceeded('eligibility delivery accepts at most 100 events');
    }
    let ordinal = -1;
    const checkedEvents: CheckedEligibilityDeliveryEvent[] = [];
    for (const input of batch.events) {
      checkId(input.id, 'Main eligibility event id', 2048);
      if (input.type !== 'com.rezics.content.search-eligible.v1') {
        throw new ContentConflict('Main source is not a succeeded Public eligibility event');
      }
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal <= ordinal) {
        throw new ContentConflict('Main eligibility event ordinals are not strictly ordered');
      }
      ordinal = input.ordinal;
      checkUuid(input.sourcePosition.dataEpoch, 'Main source epoch');
      if (input.sourcePosition.dataEpoch !== expected.graphDataEpoch
        || checkedMainPosition(input.sourcePosition.sequence, 'Main source position') === 0n) {
        throw new ContentConflict('Main eligibility event belongs to another graph epoch or position');
      }
      checkId(input.receipt.id, 'Main receipt id', 2048);
      if (input.receipt.action !== 'content.search-eligibility'
        || input.receipt.outcome !== 'succeeded' || input.receipt.disclosure !== 'public'
        || !/^[0-9a-f]{64}$/.test(input.receipt.requestDigest)) {
        throw new ContentConflict('Main eligibility receipt is not the exact succeeded Public receipt');
      }
      checkId(input.receipt.resource, 'eligibility resource');
      checkId(input.receipt.variant, 'eligibility variant');
      checkId(input.receipt.publicationDecision, 'publication decision', 2048);
      checkId(input.receipt.eligibilityDecision, 'eligibility decision', 2048);
      checkId(input.publication.preparationId, 'publication preparation id', 200);
      checkUuid(input.publication.revisionId, 'publication revision');
      if (seenEvents.has(input.id) || seenReceipts.has(input.receipt.id)) {
        throw new ContentConflict('Main eligibility page repeats an event or receipt identity');
      }
      seenEvents.add(input.id);
      seenReceipts.add(input.receipt.id);
      const identity = {
        streamScope: expected.streamScope,
        graphDataEpoch: expected.graphDataEpoch,
        contentDataEpoch: expected.contentDataEpoch,
        sourceEventId: input.id,
        sourceEventType: input.type,
        sourceOrdinal: input.ordinal,
        sourcePosition: input.sourcePosition,
        sourceReceipt: input.receipt,
        publication: input.publication,
      };
      const operationId = `content-eligibility-delivery:${hash(stable({
        contentDataEpoch: expected.contentDataEpoch, sourceEventId: input.id,
      }))}`;
      const requestDigest = hash(stable({ action: ELIGIBILITY_DELIVERY_ACTION, identity }));
      const payload = { kind: 'main-content-search-eligibility-delivery-v1', ...identity,
        deliveryBatch: { sequence: batch.sequence, id: batch.id, digest: batch.digest } };
      const checked: CheckedEligibilityDeliveryEvent = { input, batch, operationId, requestDigest, identity, payload };
      checkedEvents.push(checked);
      allEvents.push(checked);
    }
    const requestDigest = hash(stable({
      streamScope: expected.streamScope, graphDataEpoch: expected.graphDataEpoch,
      contentDataEpoch: expected.contentDataEpoch, sequence: batch.sequence,
      id: batch.id, sourceDigest: batch.digest,
      events: checkedEvents.map(event => event.identity),
    }));
    checkedBatches.push({ input: batch, requestDigest, events: checkedEvents });
  }
  return { expected, batches: checkedBatches, events: allEvents };
}

function eligibilityDeliverySourceMatches(row: Record<string, unknown>, event: CheckedEligibilityDeliveryEvent,
  expected: EligibilityDeliveryProgress): boolean {
  const input = event.input;
  return row.content_data_epoch === expected.contentDataEpoch
    && row.stream_scope === expected.streamScope
    && row.graph_data_epoch === expected.graphDataEpoch
    && row.source_event_id === input.id
    && row.source_receipt_id === input.receipt.id
    && row.source_sequence === input.sourcePosition.sequence
    && row.source_digest === input.receipt.requestDigest
    && row.source_batch_sequence === event.batch.sequence
    && row.source_batch_id === event.batch.id
    && row.source_batch_digest === event.batch.digest
    && row.source_ordinal === input.ordinal
    && row.preparation_id === input.publication.preparationId
    && row.revision_id === input.publication.revisionId
    && row.resource_id === input.receipt.resource
    && row.variant_id === input.receipt.variant
    && row.publication_decision === input.receipt.publicationDecision
    && row.eligibility_decision === input.receipt.eligibilityDecision
    && row.operation_id === event.operationId
    && row.request_digest === event.requestDigest;
}

export function canonicalContentLanguage(value: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('invalid Content language');
  }
  const canonical = Intl.getCanonicalLocales(value)[0];
  if (!canonical) throw new Error('invalid Content language');
  return canonical;
}

function checkedLanguage(language: LanguageIdentity): LanguageIdentity {
  if (language.kind !== 'tag') return language;
  if (!language.originalTag || language.originalTag.length > CONTENT_TEXT_COST.languageUnits) throw new ContentConflict('invalid original language tag');
  let canonical: string;
  try { canonical = canonicalContentLanguage(language.originalTag); }
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
    await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function ownerEpoch(client: PoolClient): Promise<string | undefined> {
  return (await client.query<{ data_epoch: string }>(
    'SELECT data_epoch FROM content.owner_control WHERE singleton')).rows[0]?.data_epoch;
}

async function operationLock(client: PoolClient, operationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId]);
}

/** Record the receipt and event; the caller resolves its position after commit. */
async function recordEvent(client: PoolClient, event: Omit<ContentEvent, 'recipe'> & { recipe?: string }): Promise<void> {
  await appendContentEvent(client, { ...event, recipe: event.recipe ?? RECIPE });
}

function position(row: { data_epoch: string; sequence: string }): ContentPosition {
  return { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence };
}

function languageFromRow(row: { language_kind: string; language_tag: string | null; original_language_tag: string | null }): LanguageIdentity {
  if (row.language_kind === 'tag') return { kind: 'tag', tag: row.language_tag!, originalTag: row.original_language_tag! };
  return { kind: row.language_kind as Exclude<LanguageIdentity['kind'], 'tag'> };
}

function referenceFromRow(row: Record<string, any>): ExactContentReference {
  return { owner: 'content', resourceId: row.resource_id,
    variantId: row.variant_id, revisionId: row.id, format: FORMAT,
    model: row.model, byteDigest: row.byte_digest, byteLength: row.byte_length,
    language: languageFromRow(row as any), direction: row.direction,
    sourceRevision: row.source_revision, predecessor: row.predecessor,
    provenance: row.provenance };
}

async function readReferenceMetadata(client: PoolClient, revisionId: string): Promise<ExactContentReference | null> {
  const result = await client.query(`SELECT r.id, r.variant_id, r.model, r.byte_digest, r.byte_length,
    r.source_revision, r.predecessor, r.provenance, v.language_kind, v.language_tag,
    v.original_language_tag, v.direction, v.resource_id
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id WHERE r.id = $1`, [revisionId]);
  return result.rows.map(referenceFromRow)[0] ?? null;
}

async function readReference(client: PoolClient, revisionId: string): Promise<ExactContentReference | null> {
  const result = await client.query(`SELECT r.id, r.variant_id, r.model, r.byte_digest, r.byte_length,
    r.availability, r.serialized_bytes, r.body, r.source_revision, r.predecessor, r.provenance,
    v.language_kind, v.language_tag, v.original_language_tag, v.direction, v.resource_id
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
  readonly derivations: ContentDerivations;
  constructor(private readonly pool: Pool) { this.derivations = new ContentDerivations(pool); }

  /** Historical active pin superseded by the retained erasure and graph receipt. */
  async readPublicationErasureSupersession(operationId: string): Promise<{
    revisionId: string; erasureId: string; erasureEpoch: string;
    graphReceipt: string; graphDataEpoch: string; graphSequence: string;
  } | null> {
    checkId(operationId, 'publication operation id', 200);
    const rows = (await this.pool.query<{ revision_id: string; erasure_id: string;
      erasure_epoch: string; graph_receipt: string; graph_data_epoch: string;
      graph_sequence: string }>(`SELECT s.revision_id, s.erasure_id,
        s.erasure_epoch::text AS erasure_epoch, s.graph_receipt,
        s.graph_data_epoch, s.graph_sequence::text AS graph_sequence
      FROM content.publication_erasure_supersession s
      JOIN content.revision_erasure e ON e.revision_id = s.revision_id
        AND e.erasure_id = s.erasure_id AND e.erasure_epoch = s.erasure_epoch
      JOIN content.revision r ON r.id = s.revision_id AND r.availability = 'erased'
      WHERE s.operation_id = $1`, [operationId])).rows;
    if (rows.length > 1) throw new ContentUnavailable('publication erasure supersession is ambiguous');
    const row = rows[0];
    return row ? { revisionId: row.revision_id, erasureId: row.erasure_id,
      erasureEpoch: row.erasure_epoch, graphReceipt: row.graph_receipt,
      graphDataEpoch: row.graph_data_epoch, graphSequence: row.graph_sequence } : null;
  }

  async readDraftReceipt(operationId: string): Promise<SaveDraftResult | null> {
    checkId(operationId, 'operation id', 200);
    const result = await this.pool.query(`SELECT outcome, revision_id, data_epoch,
      sequence::text AS sequence FROM content.receipt
      WHERE operation_id = $1 AND action = 'draft.save'`, [operationId]);
    const row = result.rows[0];
    if (!row) return null;
    return { outcome: row.outcome === 'rejected' ? 'cancelled' : row.outcome,
      revisionId: row.revision_id, predecessor: null,
      position: row.sequence ? position(row) : await contentEventPosition(this.pool, operationId),
      replayed: true };
  }

  /** Fence a claimed draft after Access closes dispatch. The operation lock orders
   * this cancellation against any already admitted Content save. */
  async cancelDraft(admissionId: string, requestDigest: string): Promise<SaveDraftResult> {
    checkUuid(admissionId, 'admission id');
    if (!/^[0-9a-f]{64}$/.test(requestDigest)) throw new ContentConflict('invalid draft request digest');
    const operationId = `content-draft:${admissionId}`;
    const result = await transaction(this.pool, async client => {
      await operationLock(client, operationId);
      const prior = await client.query(`SELECT action, outcome, revision_id, request_digest
        FROM content.receipt WHERE operation_id = $1`, [operationId]);
      if (prior.rowCount) {
        const row = prior.rows[0];
        if (row.action !== 'draft.save' || row.request_digest !== requestDigest) {
          throw new ContentConflict('draft receipt differs');
        }
        return { outcome: row.outcome === 'rejected' ? 'cancelled' as const : row.outcome as 'succeeded' | 'stale_head',
          revisionId: row.revision_id as string | null, predecessor: null, replayed: true };
      }
      await recordEvent(client, { operationId, requestDigest,
        action: 'draft.save', outcome: 'rejected', reason: 'admission-fenced',
        eventType: 'content.draft.stale', payload: { admissionId, reason: 'admission-fenced' } });
      return { outcome: 'cancelled' as const, revisionId: null, predecessor: null, replayed: false };
    });
    return { ...result, position: await contentEventPosition(this.pool, operationId) };
  }

  /** Internal ownership lookup for current disclosure, independent of byte health. */
  async owningResourceForRevision(revisionId: string): Promise<string | null> {
    checkUuid(revisionId, 'revision id');
    const result = await this.pool.query<{ resource_id: string }>(
      `SELECT v.resource_id FROM content.revision r
       JOIN content.variant v ON v.id = r.variant_id WHERE r.id = $1`, [revisionId]);
    return result.rows[0]?.resource_id ?? null;
  }

  /** The last position the sequencer assigned. */
  async ownerPosition(): Promise<ContentPosition> {
    const rows = await drizzle({ client: this.pool }).select({ dataEpoch: ownerControl.dataEpoch,
      sequence: ownerControl.sequence }).from(ownerControl).where(eq(ownerControl.singleton, true));
    if (rows.length !== 1) throw new ContentUnavailable('Content owner position unavailable');
    return { owner: 'content', dataEpoch: rows[0]!.dataEpoch, sequence: rows[0]!.sequence.toString() };
  }

  /** Current draft identity at one Content owner snapshot. Private search checks
   * this again immediately before its Access-fenced delivery. */
  async readDraftHead(resourceId: string, variantId: string): Promise<{
    revisionId: string; position: ContentPosition;
  } | null> {
    checkId(resourceId, 'resource id');
    checkId(variantId, 'variant id');
    const result = await this.pool.query(`SELECT v.draft_head::text AS revision_id,
        c.data_epoch, c.sequence::text AS sequence
      FROM content.variant v CROSS JOIN content.owner_control c
      WHERE v.id = $1 AND v.resource_id = $2 AND c.singleton`, [variantId, resourceId]);
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row.revision_id) return null;
    return { revisionId: row.revision_id, position: position(row) };
  }

  /** Indexed private inventory; Main re-reads this page to fence its variant heads. */
  async listVariantHeads(resourceId: string, after: string, limit: number): Promise<{
    items: Array<{ id: string; languageKind: string; languageTag: string | null;
      originalLanguageTag: string | null; direction: string; draftHead: string | null }>;
    nextCursor: string | null;
  }> {
    checkId(resourceId, 'resource id');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || after.length > 300) {
      throw new ContentConflict('invalid variant page');
    }
    const result = await this.pool.query<{ id: string; language_kind: string;
      language_tag: string | null; original_language_tag: string | null;
      direction: string; draft_head: string | null }>(`
      SELECT v.id, v.language_kind, v.language_tag, v.original_language_tag,
        v.direction, v.draft_head::text
      FROM content.variant v
      WHERE v.resource_id = $1 AND v.id > $2
      ORDER BY v.id LIMIT $3`, [resourceId, after, limit + 1]);
    const rows = result.rows;
    const tail = rows[limit - 1];
    return { items: rows.slice(0, limit).map(row => ({ id: row.id,
      languageKind: row.language_kind, languageTag: row.language_tag,
      originalLanguageTag: row.original_language_tag, direction: row.direction,
      draftHead: row.draft_head })),
    nextCursor: rows.length > limit ? tail!.id : null };
  }

  /** Fence the Content owner cut during the short cross-owner rebuild activation.
   * Only the sequencer advances owner_control, so writers still commit while this
   * holds it; their events stay unnumbered until the graph CAS resolves. */
  async withOwnerPositionLock<T>(expected: ContentPosition, work: () => Promise<T>): Promise<T> {
    if (expected.owner !== 'content' || !/^[0-9a-f-]{36}$/.test(expected.dataEpoch)
      || !/^(0|[1-9][0-9]*)$/.test(expected.sequence)) {
      throw new ContentConflict('invalid Content owner cut');
    }
    return transaction(this.pool, async client => {
      await client.query("SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '20s'");
      const result = await client.query(`SELECT data_epoch, sequence::text AS sequence
        FROM content.owner_control WHERE singleton FOR UPDATE`);
      if (result.rowCount !== 1 || result.rows[0].data_epoch !== expected.dataEpoch
        || result.rows[0].sequence !== expected.sequence) {
        throw new ContentConflict('Content owner cut moved before rebuild activation');
      }
      return work();
    });
  }

  async readPublicationPreparation(operationId: string): Promise<PublicationPreparation | null> {
    checkId(operationId, 'operation id', 200);
    const result = await this.pool.query(`SELECT p.revision_id, p.status, p.pin_active,
      r.data_epoch, r.sequence::text AS sequence
      FROM content.publication_preparation p JOIN content.receipt r ON r.operation_id = p.operation_id
      WHERE p.operation_id = $1`, [operationId]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const client = await this.pool.connect();
    let reference: ExactContentReference | null;
    // Rejection releases byte custody. Its retained metadata lets cancellation
    // resume after erasure; settlePublication still verifies the terminal proof.
    try { reference = row.status === 'rejected' && !row.pin_active
      ? await readReferenceMetadata(client, row.revision_id)
      : await readReference(client, row.revision_id); }
    finally { client.release(); }
    if (!reference) throw new ContentUnavailable('prepared exact revision unavailable');
    return { operationId, reference,
      position: row.sequence ? position(row) : await contentEventPosition(this.pool, operationId),
      status: row.status, pinActive: row.pin_active, replayed: true };
  }

  /** Number committed events whose writers have not; consumers call this before reading. */
  sequencePending(): Promise<number> {
    return sequenceContentEvents(this.pool);
  }

  /** A zero sequencer result can also mean a busy owner lock. Rebuilds must
   * prove the committed queue is empty before retaining their exact cut. */
  async hasUnsequencedEvents(): Promise<boolean> {
    const result = await this.pool.query<{ pending: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM content.outbox WHERE sequence IS NULL) AS pending');
    return result.rows[0]?.pending !== false;
  }

  /** Await the fence before locks or receipt replays. It must not commit, roll back or release the client. */
  async saveDraft(command: SaveDraftCommand,
    transactionFence?: (client: PoolClient) => Promise<void>): Promise<SaveDraftResult> {
    checkId(command.operationId, 'operation id', 200);
    validateVariant(command.variant);
    if (command.expectedHead !== null) checkUuid(command.expectedHead, 'expected head');
    checkId(command.model, 'model', 200);
    if (command.sourceRevision !== null) checkId(command.sourceRevision, 'source revision');
    validateProvenance(command.provenance);
    if (command.provenance.kind === 'admitted-original-contribution-v1') {
      const proof = command.provenance as unknown as AdmittedAuthorProvenance;
      if (!/^[0-9a-f-]{36}$/i.test(proof.admissionId)
        || !/^(0|[1-9][0-9]*)$/.test(proof.authorityEpoch)
        || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(proof.author)
        || proof.scope !== `content:draft:${command.variant.resourceId}`
        || proof.expectedHead !== command.expectedHead
        || proof.rightsBasis !== 'original-contribution'
        || proof.requestDigest !== contentDraftIntentDigest(command, proof.author)) {
        throw new ContentConflict('author proof does not bind the exact draft');
      }
    }
    if (command.provenance.kind === 'admitted-public-domain-v1') {
      const proof = command.provenance as unknown as AdmittedPublicDomainProvenance;
      if (!['content-shape-v1', POST_CONTENT_MODEL].includes(command.model)
        || !/^[0-9a-f-]{36}$/i.test(proof.admissionId)
        || !/^[0-9a-f-]{36}$/i.test(proof.rightsAssessmentId)
        || !/^(0|[1-9][0-9]*)$/.test(proof.authorityEpoch)
        || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(proof.transcriber)
        || proof.scope !== `content:draft:${command.variant.resourceId}`
        || proof.expectedHead !== command.expectedHead || proof.rightsBasis !== 'public-domain'
        || !proof.source || !validPublicDomainSource(proof.source)
        || proof.requestDigest !== contentDraftIntentDigest(command, proof.transcriber,
          { rightsAssessmentId: proof.rightsAssessmentId, source: proof.source })) {
        throw new ContentConflict('public-domain proof does not bind the exact draft');
      }
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(command.serializedJson); }
    catch { throw new ContentConflict('body is not JSON'); }
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new ContentConflict('body must be a JSON object');
    if (body.notes !== undefined && command.model !== POST_CONTENT_MODEL) {
      throw new ContentConflict('notes require the Post Content model');
    }
    if (['content-shape-v1', POST_CONTENT_MODEL, 'catalog-description-v1'].includes(command.model)) {
      try {
        const text = retainedDocumentBody(body);
        checkedContentText(text.body);
        retainedPostNotes(body.notes);
      } catch { throw new ContentConflict('invalid Content body or notes'); }
    }
    if (body.document !== undefined) {
      try { retainedDocumentBody(body); }
      catch { throw new ContentConflict('invalid document or text projection'); }
    }
    if (command.model === 'member-reply-v1'
      && (command.provenance.kind !== 'admitted-original-contribution-v1'
        || body.originRealm != null && (typeof body.originRealm !== 'string'
          || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(body.originRealm))
        || typeof body.rootTarget !== 'string'
        || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(body.rootTarget)
        || body.rootRevision !== command.sourceRevision
        || typeof body.rootRevision !== 'string'
        || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(body.rootRevision)
        || typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > 8192
        || typeof body.deleted !== 'boolean'
        || (body.deleted ? body.body !== '' || body.document !== undefined || command.expectedHead === null
          : body.document !== undefined ? !hasDocumentContent(retainedDocumentBody(body).document!) : body.body.length === 0))) {
      throw new ContentConflict('invalid author-bound reply draft');
    }
    if (command.model === 'content-shape-v1' || command.model === POST_CONTENT_MODEL) {
      try { directContentEmbeds(body.embeds); }
      catch (error) {
        if (error instanceof ContentEmbedInvalid) throw new ContentConflict(error.message);
        throw error;
      }
    }
    const bytes = Buffer.from(command.serializedJson, 'utf8');
    if (bytes.toString('utf8') !== command.serializedJson) throw new ContentConflict('body contains ill-formed Unicode');
    if (bytes.length < 1 || bytes.length > MAX_BODY_BYTES) throw new ContentLimitExceeded('body exceeds 1 MiB');
    const byteDigest = hash(bytes);
    let imageUses: ReturnType<typeof documentImageUses>;
    try { imageUses = revisionImageUses(body); }
    catch (error) {
      if (error instanceof DocumentMediaInvalid) throw new ContentConflict(error.message);
      throw error;
    }
    const digest = command.provenance.kind === 'admitted-original-contribution-v1'
      || command.provenance.kind === 'admitted-public-domain-v1'
      ? (command.provenance as unknown as AdmittedAuthorProvenance | AdmittedPublicDomainProvenance).requestDigest
      : hash(stable({ action: 'draft.save', variant: command.variant,
      expectedHead: command.expectedHead, model: command.model,
      sourceRevision: command.sourceRevision, provenance: command.provenance, byteDigest }));
    const result = await transaction(this.pool, async (client): Promise<Omit<SaveDraftResult, 'position'>> => {
      await transactionFence?.(client);
      await operationLock(client, command.operationId);
      const previous = await client.query('SELECT * FROM content.receipt WHERE operation_id = $1', [command.operationId]);
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.request_digest !== digest || row.action !== 'draft.save') throw new ContentConflict('operation key reused with another request');
        return { outcome: row.outcome === 'rejected' ? 'cancelled' : row.outcome,
          revisionId: row.revision_id, predecessor: command.expectedHead, replayed: true };
      }
      if (command.provenance.kind === 'admitted-public-domain-v1') {
        const proof = command.provenance as unknown as AdmittedPublicDomainProvenance;
        const accepted = await client.query(`SELECT 1 FROM rights.use_assessment a
          JOIN rights.use_assessment_head h ON h.assessment_id = a.id
          JOIN rights.material m ON m.id = a.material_id
          WHERE a.id = $1 AND m.scope_kind = 'work' AND m.work_id = $2
            AND m.component = 'body' AND m.expression_kind = 'expression'
            AND a.family = 'data_rights' AND a.use_kind = 'redistribution'
            AND a.use_scope = 'rezics:public-text' AND a.basis = 'public_domain'
            AND a.outcome = 'supported' LIMIT 1 FOR SHARE OF h`,
        [proof.rightsAssessmentId, command.variant.resourceId]);
        if (accepted.rowCount !== 1) throw new ContentConflict('public-domain assessment is not current');
      }
      if (command.model === 'member-reply-v1') {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`reply-author:${command.variant.resourceId}`]);
        const author = (await client.query(`SELECT * FROM content.reply_author WHERE reply = $1`,
          [command.variant.resourceId])).rows[0];
        if (author && (author.variant_id !== command.variant.id
          || author.author !== command.provenance.author || author.root_target !== body.rootTarget
          || author.root_revision !== command.sourceRevision
          || author.origin_realm !== (body.originRealm ?? null))) throw new ContentConflict('reply authorship and origin are immutable');
        if (!author && command.expectedHead !== null) throw new ContentConflict('reply has no admitted author');
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
      let priorImageUses: ReturnType<typeof documentImageUses> = [];
      if (variant?.draft_head) {
        const head = (await client.query(`SELECT model, availability, body, provenance
          FROM content.revision WHERE id = $1 FOR SHARE`, [variant.draft_head])).rows[0];
        try { priorImageUses = head?.body ? revisionImageUses(head.body) : []; }
        catch (error) { if (!(error instanceof DocumentMediaInvalid)) throw error; }
        if (head?.model === 'member-reply-v1' && (command.model !== head.model
          || head.provenance.author !== command.provenance.author
          || head.availability !== 'available' || head.body.deleted === true)) {
          throw new ContentConflict('reply author, availability or deletion prevents editing');
        }
        if (command.model === 'member-reply-v1' && head?.model !== command.model) {
          throw new ContentConflict('reply cannot replace another content model');
        }
      }
      if (variant && (variant.resource_id !== command.variant.resourceId
        || variant.language_kind !== command.variant.language.kind
        || variant.language_tag !== (command.variant.language.kind === 'tag' ? command.variant.language.tag : null)
        || variant.original_language_tag !== (command.variant.language.kind === 'tag' ? command.variant.language.originalTag : null)
        || variant.direction !== command.variant.direction)) {
        throw new ContentConflict('variant identity differs');
      }
      if (!variant || variant.draft_head !== command.expectedHead) {
        await recordEvent(client, { operationId: command.operationId, requestDigest: digest, action: 'draft.save',
          outcome: 'stale_head', variantId: variant?.id ?? null,
          reason: 'expected head differs', eventType: 'content.draft.stale',
          payload: { variantId: command.variant.id, expectedHead: command.expectedHead } });
        return { outcome: 'stale_head', revisionId: null, predecessor: command.expectedHead, replayed: false };
      }
      const revisionId = randomUUID();
      try {
        await guardDocumentImageUses(client, imageUses, [command.variant.resourceId,
          ...(command.model === 'member-reply-v1' ? [body.rootTarget as string] : [])], priorImageUses);
      } catch (error) {
        if (error instanceof DocumentMediaInvalid) throw new ContentConflict(error.message);
        throw error;
      }
      await client.query(`INSERT INTO content.revision
        (id, variant_id, predecessor, operation_id, format, model, source_revision, provenance,
          byte_digest, byte_length, serialized_bytes, body)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb)`,
      [revisionId, command.variant.id, command.expectedHead, command.operationId, FORMAT, command.model,
        command.sourceRevision, JSON.stringify(command.provenance), byteDigest, bytes.length, bytes, command.serializedJson]);
      await client.query('UPDATE content.variant SET draft_head = $2 WHERE id = $1', [command.variant.id, revisionId]);
      await recordEvent(client, { operationId: command.operationId, requestDigest: digest, action: 'draft.save',
        outcome: 'succeeded', variantId: command.variant.id, revisionId,
        eventType: 'content.revision.saved', payload: { variantId: command.variant.id, revisionId,
          predecessor: command.expectedHead, byteDigest, byteLength: bytes.length } });
      if (command.model === 'member-reply-v1') {
        await client.query(`INSERT INTO content.reply_author
          (reply, variant_id, author, root_target, root_revision, operation_id, origin_realm)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (reply) DO NOTHING`,
        [command.variant.resourceId, command.variant.id, command.provenance.author,
          body.rootTarget, command.sourceRevision, command.operationId, body.originRealm ?? null]);
      }
      return { outcome: 'succeeded', revisionId, predecessor: command.expectedHead, replayed: false };
    });
    return { ...result, position: await contentEventPosition(this.pool, command.operationId) };
  }

  async preparePublication(operationId: string, revisionId: string, expectedDigest: string,
    requireCurrentDraftHead = false, expectedOwnerEpoch?: string): Promise<PublicationPreparation> {
    checkId(operationId, 'operation id', 200);
    checkUuid(revisionId, 'revision id');
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new ContentConflict('invalid expected digest');
    if (expectedOwnerEpoch !== undefined) checkUuid(expectedOwnerEpoch, 'expected Content owner epoch');
    const digest = hash(stable({ action: 'publication.prepare', operationId, revisionId,
      expectedDigest, requireCurrentDraftHead, expectedOwnerEpoch: expectedOwnerEpoch ?? null }));
    const result = await transaction(this.pool, async (client): Promise<Omit<PublicationPreparation, 'position'>> => {
      await operationLock(client, operationId);
      const occupied = await client.query('SELECT action FROM content.receipt WHERE operation_id = $1', [operationId]);
      if (occupied.rowCount && occupied.rows[0].action !== 'publication.prepare') throw new ContentConflict('operation key reused');
      const old = await client.query('SELECT * FROM content.publication_preparation WHERE operation_id = $1', [operationId]);
      if (old.rowCount && old.rows[0].request_digest !== digest) throw new ContentConflict('publication operation reused');
      // Erasure locks this exact row before inspecting pins. A new preparation
      // cannot slip between its pin inventory and byte removal.
      await client.query('SELECT id FROM content.revision WHERE id = $1 FOR UPDATE', [revisionId]);
      const reference = await readReference(client, revisionId);
      if (!reference || reference.byteDigest !== expectedDigest) throw new ContentUnavailable('exact revision unavailable or digest differs');
      if (old.rowCount) {
        return { operationId, reference, status: old.rows[0].status, pinActive: old.rows[0].pin_active, replayed: true };
      }
      if (reference.provenance.kind === 'admitted-public-domain-v1') {
        const assessmentId = reference.provenance.rightsAssessmentId;
        if (typeof assessmentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(assessmentId)) {
          throw new ContentConflict('public-domain assessment reference is invalid');
        }
        const accepted = await client.query(`SELECT 1 FROM rights.use_assessment a
          JOIN rights.use_assessment_head h ON h.assessment_id = a.id
          JOIN rights.material m ON m.id = a.material_id
          WHERE a.id = $1 AND m.scope_kind = 'work' AND m.work_id = $2
            AND m.component = 'body' AND m.expression_kind = 'expression'
            AND a.family = 'data_rights' AND a.use_kind = 'redistribution'
            AND a.use_scope = 'rezics:public-text' AND a.basis = 'public_domain'
            AND a.outcome = 'supported' LIMIT 1 FOR SHARE OF h`,
        [assessmentId, reference.resourceId]);
        if (accepted.rowCount !== 1) throw new ContentConflict('public-domain assessment is not current');
      }
      if (requireCurrentDraftHead) {
        const head = await client.query('SELECT draft_head FROM content.variant WHERE id = $1 FOR UPDATE', [reference.variantId]);
        if (head.rows[0]?.draft_head !== revisionId) throw new ContentConflict('Content draft head is stale');
      }
      // The epoch is read, not locked: positions take the epoch current when the
      // sequencer numbers them, and callers compare the returned position's epoch.
      if (expectedOwnerEpoch !== undefined && await ownerEpoch(client) !== expectedOwnerEpoch) {
        throw new ContentConflict('Content owner epoch is stale');
      }
      await client.query(`INSERT INTO content.publication_preparation
        (operation_id, revision_id, request_digest) VALUES ($1,$2,$3)`, [operationId, revisionId, digest]);
      await recordEvent(client, { operationId, requestDigest: digest, action: 'publication.prepare', outcome: 'succeeded',
        variantId: reference.variantId, revisionId,
        eventType: 'content.publication.prepared', payload: { reference } });
      return { operationId, reference, status: 'pending', pinActive: true, replayed: false };
    });
    return { ...result, position: await contentEventPosition(this.pool, operationId) };
  }

  async settlePublication(operationId: string, preparationId: string, proof: GraphTerminalProof,
    expectedOwnerEpoch?: string): Promise<{
    status: 'active' | 'rejected'; pinActive: boolean; position: ContentPosition | null; replayed: boolean;
  }> {
    checkId(operationId, 'operation id', 200);
    checkId(preparationId, 'preparation id', 200);
    checkUuid(proof.revisionId, 'proof revision');
    if (!['active', 'rejected'].includes(proof.outcome) || !proof.receipt || !proof.dataEpoch
      || !/^(0|[1-9][0-9]*)$/.test(proof.sequence)) throw new ContentConflict('terminal graph proof required');
    if (expectedOwnerEpoch !== undefined) checkUuid(expectedOwnerEpoch, 'expected Content owner epoch');
    const proofDigest = hash(stable(proof));
    const digest = hash(stable({ action: 'publication.settle', preparationId, proof,
      expectedOwnerEpoch: expectedOwnerEpoch ?? null }));
    const result = await transaction(this.pool, async (client) => {
      await operationLock(client, operationId);
      const old = await client.query('SELECT * FROM content.receipt WHERE operation_id = $1', [operationId]);
      if (old.rowCount) {
        if (old.rows[0].request_digest !== digest || old.rows[0].action !== 'publication.settle') throw new ContentConflict('operation key reused');
        return { status: proof.outcome, pinActive: proof.outcome === 'active', recorded: true, replayed: true };
      }
      const result = await client.query('SELECT * FROM content.publication_preparation WHERE operation_id = $1 FOR UPDATE', [preparationId]);
      if (!result.rowCount) throw new ContentUnavailable('publication preparation missing');
      const preparation = result.rows[0];
      if (preparation.revision_id !== proof.revisionId) throw new ContentConflict('graph proof names another revision');
      if (expectedOwnerEpoch !== undefined && await ownerEpoch(client) !== expectedOwnerEpoch) {
        throw new ContentConflict('Content owner epoch is stale before settlement');
      }
      if (preparation.status !== 'pending') {
        if (preparation.status !== proof.outcome || preparation.terminal_proof_digest !== proofDigest) {
          throw new ContentConflict('publication already settled with another proof');
        }
        return { status: proof.outcome, pinActive: preparation.pin_active as boolean, recorded: false, replayed: true };
      }
      await client.query(`UPDATE content.publication_preparation SET status = $2, pin_active = $3,
        graph_receipt = $4, graph_data_epoch = $5, graph_sequence = $6,
        terminal_proof_digest = $7, settled_at = now() WHERE operation_id = $1`,
      [preparationId, proof.outcome, proof.outcome === 'active', proof.receipt,
        proof.dataEpoch, proof.sequence, proofDigest]);
      const reference = await readReference(client, preparation.revision_id);
      if (!reference) throw new ContentUnavailable('prepared revision unavailable');
      await recordEvent(client, { operationId, requestDigest: digest, action: 'publication.settle',
        recipe: reference.model === 'member-reply-v1' ? 'realm-reply-v1' : undefined,
        outcome: proof.outcome === 'active' ? 'succeeded' : 'rejected', variantId: reference.variantId,
        revisionId: preparation.revision_id,
        eventType: proof.outcome === 'active' ? 'content.publication.active' : 'content.publication.rejected',
        payload: { preparationId, revisionId: preparation.revision_id, graph: proof } });
      return { status: proof.outcome, pinActive: proof.outcome === 'active', recorded: true, replayed: false };
    });
    const { recorded, ...settled } = result;
    return { ...settled, position: recorded ? await contentEventPosition(this.pool, operationId) : null };
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
      SELECT r.*, v.language_kind, v.language_tag, v.original_language_tag, v.direction, v.resource_id,
        sum(CASE WHEN r.availability = 'available' THEN r.byte_length ELSE 0 END) OVER () AS total_bytes
      FROM content.revision r JOIN content.variant v ON v.id = r.variant_id WHERE r.id = ANY($1::uuid[])
    ) SELECT id, variant_id, model, byte_digest, byte_length, availability,
      language_kind, language_tag, original_language_tag, direction, resource_id,
      source_revision, predecessor, provenance, total_bytes,
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
        if (body.document !== undefined) retainedDocumentBody(body);
        if (body.notes !== undefined && row.model !== POST_CONTENT_MODEL) return { revisionId, status: 'corrupt' };
        if (['content-shape-v1', POST_CONTENT_MODEL, 'catalog-description-v1'].includes(row.model)) {
          const text = retainedDocumentBody(body);
          checkedContentText(text.body);
          retainedPostNotes(body.notes);
        }
        return { revisionId, status: 'available', reference: referenceFromRow(row), serializedJson, body };
      } catch { return { revisionId, status: 'corrupt' }; }
    });
  }

  /** Exact delivery fence: one indexed metadata statement, no body reload.
   * The caller still supplies current authorization for these exact revisions.
   * At most the existing 64-revision read batch; erasure/withdrawal is live. */
  async readExactMetadataBatch(revisionIds: string[], authorize: (ids: readonly string[]) => Promise<ReadonlySet<string>>) {
    if (revisionIds.length > MAX_READ_ITEMS || new Set(revisionIds).size !== revisionIds.length)
      throw new ContentLimitExceeded('exact metadata read requires at most 64 revisions');
    revisionIds.forEach(id => checkUuid(id,'revision id'));
    const allowed = await authorize(revisionIds), admitted = revisionIds.filter(id => allowed.has(id));
    if (!admitted.length) return new Map<string,{ availability: string; byteDigest: string }>();
    const rows = await this.pool.query<{ id: string; availability: string; byte_digest: string }>(
      'SELECT id,availability,byte_digest FROM content.revision WHERE id=ANY($1::uuid[])', [admitted]);
    return new Map(rows.rows.map(row => [row.id,{ availability: row.availability,byteDigest: row.byte_digest }]));
  }

  async readOutbox(dataEpoch: string, afterSequence: string, limit: number): Promise<ContentOutboxEvent[]> {
    if (!/^[0-9a-f-]{36}$/.test(dataEpoch) || !/^(0|[1-9][0-9]*)$/.test(afterSequence)
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ContentLimitExceeded('invalid outbox window');
    const result = await this.pool.query(`SELECT event.id, event.data_epoch, event.sequence::text AS sequence,
      event.operation_id, event.event_type, event.recipe, event.revision_id, event.payload
      FROM content.outbox AS event WHERE event.data_epoch = $1 AND event.sequence > $2::bigint
      ORDER BY event.sequence, event.id LIMIT $3`,
    [dataEpoch, afterSequence, limit]);
    return result.rows.map((row) => ({ id: row.id, position: position(row), operationId: row.operation_id,
      eventType: row.event_type, recipe: row.recipe, revisionId: row.revision_id, payload: row.payload }));
  }

  /** Main's verified retained relay reads this cursor before requesting a bounded page. */
  async readEligibilityDeliveryProgress(streamScope: string, graphDataEpoch: string): Promise<EligibilityDeliveryProgress> {
    checkId(streamScope, 'Main stream scope');
    checkUuid(graphDataEpoch, 'Main graph epoch');
    const owner = (await this.pool.query<{ data_epoch: string }>(
      'SELECT data_epoch FROM content.owner_control WHERE singleton')).rows[0];
    if (!owner) throw new ContentUnavailable('Content owner epoch unavailable');
    const row = (await this.pool.query<{ sequence: string }>(`SELECT sequence::text AS sequence
      FROM content.eligibility_delivery_progress
      WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3`,
    [streamScope, graphDataEpoch, owner.data_epoch])).rows[0];
    return { streamScope, graphDataEpoch, contentDataEpoch: owner.data_epoch, sequence: row?.sequence ?? '0' };
  }

  /** Append a verified Main Public-eligibility page to Content custody and move
   * its source cursor atomically. Only the existing Content sequencer assigns
   * owner positions, after this transaction commits. */
  async ingestEligibilityDeliveryPage(page: EligibilityDeliveryPage): Promise<EligibilityDeliveryResult> {
    const checked = checkedEligibilityDeliveryPage(page);
    const expected = checked.expected;
    const expectedSequence = checkedDeliverySequence(expected.sequence, 'expected Main stream position', true);
    const finalSequence = checkedDeliverySequence(checked.batches.at(-1)!.input.sequence, 'Main batch position');
    const result = await transaction(this.pool, async client => {
      // The owner epoch cannot change between the source cursor check and commit.
      const owner = await client.query<{ data_epoch: string }>(
        'SELECT data_epoch FROM content.owner_control WHERE singleton FOR SHARE');
      if (owner.rows[0]?.data_epoch !== expected.contentDataEpoch) {
        throw new ContentConflict('Content owner epoch changed before eligibility delivery');
      }
      await client.query(`INSERT INTO content.eligibility_delivery_progress
        (stream_scope, graph_data_epoch, content_data_epoch, sequence)
        VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
      [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch]);
      const progress = await client.query<{ sequence: string }>(`SELECT sequence::text AS sequence
        FROM content.eligibility_delivery_progress
        WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3 FOR UPDATE`,
      [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch]);
      if (progress.rowCount !== 1) throw new ContentUnavailable('eligibility delivery progress unavailable');
      const currentSequence = checkedDeliverySequence(progress.rows[0]!.sequence, 'stored Main stream position', true);

      const compareRecordedBatches = async (): Promise<boolean> => {
        for (const batch of checked.batches) {
          const row = (await client.query<{ batch_id: string; source_digest: string; request_digest: string }>(
            `SELECT batch_id, source_digest, request_digest FROM content.eligibility_delivery_batch
             WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3 AND sequence = $4`,
            [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch, batch.input.sequence])).rows[0];
          if (!row || row.batch_id !== batch.input.id || row.source_digest !== batch.input.digest
            || row.request_digest !== batch.requestDigest) return false;
        }
        for (const event of checked.events) {
          const rows = await client.query(`SELECT * FROM content.eligibility_delivery_source
            WHERE content_data_epoch = $1 AND (source_event_id = $2 OR source_receipt_id = $3)`,
          [expected.contentDataEpoch, event.input.id, event.input.receipt.id]);
          if (rows.rowCount !== 1 || !eligibilityDeliverySourceMatches(rows.rows[0], event, expected)) return false;
        }
        return true;
      };

      if (currentSequence !== expectedSequence) {
        if (currentSequence >= finalSequence && await compareRecordedBatches()) {
          return { progress: { ...expected, sequence: currentSequence.toString() }, replayed: true,
            events: checked.events.map(event => ({ sourceEventId: event.input.id,
              sourceReceiptId: event.input.receipt.id, operationId: event.operationId, appended: false })) };
        }
        throw new ContentConflict('Main eligibility delivery progress moved before this page');
      }

      const operationIds = [...new Set(checked.events.map(event => event.operationId))].sort();
      for (const operationId of operationIds) await operationLock(client, operationId);
      for (const batch of checked.batches) {
        const inserted = await client.query(`INSERT INTO content.eligibility_delivery_batch
          (stream_scope, graph_data_epoch, content_data_epoch, sequence, batch_id,
           source_digest, request_digest, selected_events)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch,
          batch.input.sequence, batch.input.id, batch.input.digest, batch.requestDigest, batch.events.length]);
        if (inserted.rowCount !== 1) throw new ContentConflict('Main eligibility batch identity was already consumed');
      }

      const eventResults: EligibilityDeliveryResult['events'] = [];
      const pins = new Map<string, { reference: ExactContentReference; recipe: string }>();
      for (const event of checked.events) {
        const existing = await client.query(`SELECT * FROM content.eligibility_delivery_source
          WHERE content_data_epoch = $1 AND (source_event_id = $2 OR source_receipt_id = $3) FOR SHARE`,
        [expected.contentDataEpoch, event.input.id, event.input.receipt.id]);
        if (existing.rowCount) {
          if (existing.rowCount !== 1 || !eligibilityDeliverySourceMatches(existing.rows[0], event, expected)) {
            throw new ContentConflict('Main eligibility event or receipt replay differs');
          }
          const recorded = await client.query(`SELECT receipt.action, receipt.request_digest, receipt.outcome,
              receipt.variant_id, receipt.revision_id, outbox.event_type, outbox.payload
            FROM content.receipt receipt JOIN content.outbox outbox ON outbox.operation_id = receipt.operation_id
            WHERE receipt.operation_id = $1`, [event.operationId]);
          const row = recorded.rows[0];
          if (recorded.rowCount !== 1 || row.action !== ELIGIBILITY_DELIVERY_ACTION
            || row.request_digest !== event.requestDigest || row.outcome !== 'succeeded'
            || row.variant_id !== event.input.receipt.variant || row.revision_id !== event.input.publication.revisionId
            || row.event_type !== ELIGIBILITY_DELIVERY_EVENT
            || row.payload?.kind !== 'main-content-search-eligibility-delivery-v1') {
            throw new ContentUnavailable('Content eligibility delivery record is incomplete');
          }
          const source = Object.fromEntries(Object.entries(row.payload)
            .filter(([key]) => key !== 'kind' && key !== 'deliveryBatch'));
          if (stable(source) !== stable(event.identity)) {
            throw new ContentUnavailable('Content eligibility delivery source differs from its receipt');
          }
          eventResults.push({ sourceEventId: event.input.id, sourceReceiptId: event.input.receipt.id,
            operationId: event.operationId, appended: false, position: null });
          continue;
        }
        const occupied = await client.query('SELECT action FROM content.receipt WHERE operation_id = $1', [event.operationId]);
        if (occupied.rowCount) throw new ContentConflict('eligibility delivery operation key is already occupied');

        let pin = pins.get(event.input.publication.preparationId);
        if (!pin) {
          const settled = await client.query<{ id: string; variant_id: string; model: string;
            byte_digest: string; byte_length: number; source_revision: string | null; predecessor: string | null;
            provenance: Record<string, unknown>; language_kind: string; language_tag: string | null;
            original_language_tag: string | null; direction: VariantIdentity['direction']; resource_id: string;
            revision_id: string; status: string; pin_active: boolean; graph_receipt: string | null;
            graph_data_epoch: string | null; graph_sequence: string | null; terminal_proof_digest: string | null;
            settlement_action: string; settlement_outcome: string; settlement_revision_id: string | null;
            event_type: string; recipe: string; payload: Record<string, unknown> }>(`SELECT revision.id, revision.variant_id,
              revision.model, revision.byte_digest, revision.byte_length, revision.source_revision,
              revision.predecessor, revision.provenance, variant.language_kind, variant.language_tag,
              variant.original_language_tag, variant.direction, variant.resource_id,
              preparation.revision_id::text AS revision_id, preparation.status, preparation.pin_active,
              preparation.graph_receipt, preparation.graph_data_epoch, preparation.graph_sequence::text AS graph_sequence,
              preparation.terminal_proof_digest, settlement.action AS settlement_action,
              settlement.outcome AS settlement_outcome, settlement.revision_id::text AS settlement_revision_id,
              settled.event_type, settled.recipe, settled.payload
            FROM content.publication_preparation preparation
            JOIN content.receipt settlement ON settlement.action = 'publication.settle'
              AND settlement.revision_id = preparation.revision_id
            JOIN content.outbox settled ON settled.operation_id = settlement.operation_id
            JOIN content.revision revision ON revision.id = preparation.revision_id
            JOIN content.variant variant ON variant.id = revision.variant_id
            WHERE preparation.operation_id = $1 AND settled.payload->>'preparationId' = preparation.operation_id
            FOR SHARE OF preparation, revision`, [event.input.publication.preparationId]);
          if (settled.rowCount !== 1) throw new ContentUnavailable('eligibility source settled Content pin is unavailable');
          const row = settled.rows[0]!;
          const graph = row.payload?.graph as GraphTerminalProof | undefined;
          if (row.status !== 'active' || !row.pin_active || row.settlement_action !== 'publication.settle'
            || row.settlement_outcome !== 'succeeded' || row.settlement_revision_id !== event.input.publication.revisionId
            || row.revision_id !== event.input.publication.revisionId || row.event_type !== 'content.publication.active'
            || !graph || graph.outcome !== 'active' || graph.revisionId !== event.input.publication.revisionId
            || graph.receipt !== row.graph_receipt || graph.dataEpoch !== row.graph_data_epoch
            || graph.sequence !== row.graph_sequence || row.terminal_proof_digest !== hash(stable(graph))
            || stable(row.payload) !== stable({ preparationId: event.input.publication.preparationId,
              revisionId: event.input.publication.revisionId, graph })) {
            throw new ContentConflict('eligibility source does not name the exact active settled pin');
          }
          const reference = referenceFromRow(row as unknown as Record<string, any>);
          if (reference.resourceId !== event.input.receipt.resource
            || reference.variantId !== event.input.receipt.variant
            || reference.revisionId !== event.input.publication.revisionId) {
            throw new ContentConflict('eligibility source publication differs from its settled Content pin');
          }
          pin = { reference, recipe: row.recipe };
          pins.set(event.input.publication.preparationId, pin);
        }
        if (pin.reference.resourceId !== event.input.receipt.resource
          || pin.reference.variantId !== event.input.receipt.variant
          || pin.reference.revisionId !== event.input.publication.revisionId) {
          throw new ContentConflict('eligibility source publication differs from its settled Content pin');
        }

        await appendContentEvent(client, { operationId: event.operationId, requestDigest: event.requestDigest,
          action: ELIGIBILITY_DELIVERY_ACTION, outcome: 'succeeded', variantId: pin.reference.variantId,
          revisionId: pin.reference.revisionId, eventType: ELIGIBILITY_DELIVERY_EVENT,
          recipe: pin.recipe, payload: event.payload });
        await client.query(`INSERT INTO content.eligibility_delivery_source
          (content_data_epoch, stream_scope, graph_data_epoch, source_event_id, source_receipt_id,
           source_sequence, source_digest, source_batch_sequence, source_batch_id, source_batch_digest, source_ordinal,
           preparation_id, revision_id, resource_id, variant_id, publication_decision,
           eligibility_decision, operation_id, request_digest)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [expected.contentDataEpoch, expected.streamScope, expected.graphDataEpoch, event.input.id,
          event.input.receipt.id, event.input.sourcePosition.sequence, event.input.receipt.requestDigest,
          event.batch.sequence, event.batch.id, event.batch.digest, event.input.ordinal, event.input.publication.preparationId,
          event.input.publication.revisionId, event.input.receipt.resource, event.input.receipt.variant,
          event.input.receipt.publicationDecision, event.input.receipt.eligibilityDecision,
          event.operationId, event.requestDigest]);
        eventResults.push({ sourceEventId: event.input.id, sourceReceiptId: event.input.receipt.id,
          operationId: event.operationId, appended: true, position: null });
      }

      const advanced = await client.query(`UPDATE content.eligibility_delivery_progress SET sequence = $4
        WHERE stream_scope = $1 AND graph_data_epoch = $2 AND content_data_epoch = $3 AND sequence = $5`,
      [expected.streamScope, expected.graphDataEpoch, expected.contentDataEpoch,
        finalSequence.toString(), expectedSequence.toString()]);
      if (advanced.rowCount !== 1) throw new ContentConflict('Main eligibility delivery progress compare-and-set failed');
      return { progress: { ...expected, sequence: finalSequence.toString() }, replayed: false, events: eventResults };
    });

    // A process may stop after the transaction above and before this numbering
    // pass. A replay retries the existing sequencer and never creates new work.
    await sequenceContentEvents(this.pool);
    const operationIds = result.events.map(event => event.operationId);
    const positions = operationIds.length ? await this.pool.query<{ operation_id: string;
      data_epoch: string | null; sequence: string | null }>(`SELECT operation_id, data_epoch,
        sequence::text AS sequence FROM content.receipt WHERE operation_id = ANY($1::text[])`, [operationIds]) : null;
    const byOperation = new Map((positions?.rows ?? []).map(row => [row.operation_id,
      row.data_epoch && row.sequence ? position({ data_epoch: row.data_epoch, sequence: row.sequence }) : null]));
    return { progress: result.progress, replayed: result.replayed,
      events: result.events.map(event => ({ ...event, position: byOperation.get(event.operationId) ?? null })) };
  }

  /** Find a later durable Main approval delivery for the same current publication. */
  async readEligibilityDeliverySuccessor(event: ContentOutboxEvent, expected: {
    streamScope: string;
    graphDataEpoch: string;
    sourceSequence: string;
    resourceId: string;
    variantId: string;
    publicationDecision: string;
    eligibilityDecision: string;
  }): Promise<{ event: ContentOutboxEvent; sourceSequence: string } | null> {
    if (event.eventType !== ELIGIBILITY_DELIVERY_EVENT || event.recipe !== RECIPE
      || event.position.owner !== 'content' || !/^[0-9a-f-]{36}$/i.test(event.position.dataEpoch)
      || !/^(0|[1-9][0-9]*)$/.test(event.position.sequence)
      || !/^(0|[1-9][0-9]*)$/.test(expected.sourceSequence)) {
      throw new ContentConflict('eligibility successor lookup requires an exact delivered event');
    }
    const result = await this.pool.query(`SELECT event.id, event.data_epoch,
      event.sequence::text AS sequence, event.operation_id, event.event_type,
      event.recipe, event.revision_id, event.payload, delivery.source_sequence
      FROM content.eligibility_delivery_source delivery
      JOIN content.outbox event ON event.operation_id = delivery.operation_id
      WHERE delivery.content_data_epoch = $1::uuid AND delivery.stream_scope = $2
        AND delivery.graph_data_epoch = $3::uuid AND delivery.source_sequence <> $4
        AND delivery.resource_id = $5 AND delivery.variant_id = $6
        AND delivery.publication_decision = $7 AND delivery.eligibility_decision = $8
        AND event.data_epoch = $1::uuid AND event.sequence > $9::bigint
        AND event.event_type = $10 AND event.recipe = $11
      ORDER BY event.sequence LIMIT 2`,
    [event.position.dataEpoch, expected.streamScope, expected.graphDataEpoch, expected.sourceSequence,
      expected.resourceId, expected.variantId, expected.publicationDecision,
      expected.eligibilityDecision, event.position.sequence, ELIGIBILITY_DELIVERY_EVENT, RECIPE]);
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new ContentUnavailable('eligibility successor delivery is ambiguous');
    const row = result.rows[0];
    return { event: { id: row.id, position: position(row), operationId: row.operation_id,
      eventType: row.event_type, recipe: row.recipe, revisionId: row.revision_id, payload: row.payload },
    sourceSequence: row.source_sequence };
  }

  /** Find the durable approval event that takes over an active publication event. */
  async readEligibilityDeliveryForPublication(event: ContentOutboxEvent, expected: {
    streamScope: string;
    graphDataEpoch: string;
    resourceId: string;
    variantId: string;
    publicationDecision: string;
    eligibilityDecision: string;
    preparationId: string;
    revisionId: string;
  }): Promise<{ event: ContentOutboxEvent; sourceSequence: string } | null> {
    if (event.eventType !== 'content.publication.active' || event.recipe !== RECIPE || !event.revisionId
      || event.position.owner !== 'content' || !/^[0-9a-f-]{36}$/i.test(event.position.dataEpoch)
      || !/^(0|[1-9][0-9]*)$/.test(event.position.sequence)) {
      throw new ContentConflict('eligibility delivery lookup requires an exact active publication event');
    }
    const result = await this.pool.query(`SELECT event.id, event.data_epoch,
      event.sequence::text AS sequence, event.operation_id, event.event_type,
      event.recipe, event.revision_id, event.payload, delivery.source_sequence
      FROM content.eligibility_delivery_source delivery
      JOIN content.outbox event ON event.operation_id = delivery.operation_id
      WHERE delivery.content_data_epoch = $1::uuid AND delivery.stream_scope = $2
        AND delivery.graph_data_epoch = $3::uuid AND delivery.resource_id = $4
        AND delivery.variant_id = $5 AND delivery.publication_decision = $6
        AND delivery.eligibility_decision = $7 AND delivery.preparation_id = $8
        AND delivery.revision_id = $9::uuid
        AND event.data_epoch = $1::uuid AND event.sequence > $10::bigint
        AND event.event_type = $11 AND event.recipe = $12
      ORDER BY event.sequence LIMIT 2`,
    [event.position.dataEpoch, expected.streamScope, expected.graphDataEpoch, expected.resourceId,
      expected.variantId, expected.publicationDecision, expected.eligibilityDecision,
      expected.preparationId, expected.revisionId, event.position.sequence, ELIGIBILITY_DELIVERY_EVENT, RECIPE]);
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new ContentUnavailable('current eligibility delivery is ambiguous');
    const row = result.rows[0];
    return { event: { id: row.id, position: position(row), operationId: row.operation_id,
      eventType: row.event_type, recipe: row.recipe, revisionId: row.revision_id, payload: row.payload },
    sourceSequence: row.source_sequence };
  }

  /** Resolve a terminal event against its settled pin; rebuild may read historical metadata. */
  async readProjectionPublication(event: ContentOutboxEvent,
    allowUnavailableActiveReference = false): Promise<ProjectionPublication> {
    if (event.eventType === ELIGIBILITY_DELIVERY_EVENT) {
      if (event.recipe !== RECIPE || !event.revisionId) {
        throw new ContentConflict('eligibility delivery event recipe is incomplete');
      }
      const delivery = await this.pool.query(`SELECT event.data_epoch, event.sequence::text AS sequence,
        event.operation_id, event.event_type, event.recipe, event.revision_id, event.payload,
        receipt.action, receipt.request_digest, receipt.outcome, receipt.variant_id, receipt.revision_id AS receipt_revision,
        delivery.content_data_epoch, delivery.stream_scope, delivery.graph_data_epoch,
        delivery.source_event_id, delivery.source_receipt_id, delivery.source_sequence,
        delivery.source_digest, delivery.source_batch_sequence::text AS source_batch_sequence,
        delivery.source_batch_id, delivery.source_batch_digest, delivery.source_ordinal,
        delivery.preparation_id, delivery.resource_id, delivery.variant_id AS source_variant,
        delivery.publication_decision, delivery.eligibility_decision, delivery.request_digest AS source_request_digest,
        batch.batch_id, batch.source_digest AS batch_source_digest
        FROM content.outbox event
        JOIN content.receipt receipt ON receipt.operation_id = event.operation_id
        JOIN content.eligibility_delivery_source delivery ON delivery.operation_id = event.operation_id
        JOIN content.eligibility_delivery_batch batch ON batch.stream_scope = delivery.stream_scope
          AND batch.graph_data_epoch = delivery.graph_data_epoch
          AND batch.content_data_epoch = delivery.content_data_epoch
          AND batch.sequence = delivery.source_batch_sequence
        WHERE event.id = $1 AND event.data_epoch = $2::uuid AND event.sequence = $3::bigint
          AND event.operation_id = $4`,
      [event.id, event.position.dataEpoch, event.position.sequence, event.operationId]);
      const row = delivery.rows[0];
      const payload = row?.payload;
      const sourceReceipt = payload?.sourceReceipt;
      const sourcePosition = payload?.sourcePosition;
      const sourcePublication = payload?.publication;
      const deliveryBatch = payload?.deliveryBatch;
      if (delivery.rowCount !== 1 || row.event_type !== ELIGIBILITY_DELIVERY_EVENT || row.recipe !== RECIPE
        || row.data_epoch !== event.position.dataEpoch || row.sequence !== event.position.sequence
        || row.operation_id !== event.operationId
        || row.revision_id !== event.revisionId || row.receipt_revision !== event.revisionId
        || row.action !== ELIGIBILITY_DELIVERY_ACTION || row.outcome !== 'succeeded'
        || row.request_digest !== row.source_request_digest || row.variant_id !== row.source_variant
        || row.content_data_epoch !== event.position.dataEpoch
        || payload?.kind !== 'main-content-search-eligibility-delivery-v1'
        || payload?.contentDataEpoch !== row.content_data_epoch || payload?.streamScope !== row.stream_scope
        || payload?.graphDataEpoch !== row.graph_data_epoch
        || payload?.sourceEventId !== row.source_event_id
        || payload?.sourceEventType !== 'com.rezics.content.search-eligible.v1'
        || payload?.sourceOrdinal !== row.source_ordinal
        || sourcePosition?.dataEpoch !== row.graph_data_epoch
        || sourcePosition?.sequence !== row.source_sequence
        || sourceReceipt?.id !== row.source_receipt_id
        || sourceReceipt?.action !== 'content.search-eligibility'
        || sourceReceipt?.outcome !== 'succeeded'
        || sourceReceipt?.requestDigest !== row.source_digest
        || sourceReceipt?.resource !== row.resource_id || sourceReceipt?.variant !== row.source_variant
        || sourceReceipt?.publicationDecision !== row.publication_decision
        || sourceReceipt?.eligibilityDecision !== row.eligibility_decision
        || sourceReceipt?.disclosure !== 'public'
        || sourcePublication?.preparationId !== row.preparation_id
        || sourcePublication?.revisionId !== event.revisionId
        || deliveryBatch?.sequence !== row.source_batch_sequence
        || deliveryBatch?.id !== row.source_batch_id
        || deliveryBatch?.digest !== row.source_batch_digest
        || row.batch_id !== row.source_batch_id
        || row.batch_source_digest !== row.source_batch_digest
        || stable(payload) !== stable(event.payload)) {
        throw new ContentUnavailable('Content eligibility delivery differs from its immutable Main source');
      }
      const terminal = await this.pool.query(`SELECT event.id, event.data_epoch,
        event.sequence::text AS sequence, event.operation_id, event.event_type,
        event.recipe, event.revision_id, event.payload
        FROM content.publication_preparation preparation
        JOIN content.receipt settlement ON settlement.action = 'publication.settle'
          AND settlement.revision_id = preparation.revision_id
        JOIN content.outbox event ON event.operation_id = settlement.operation_id
        WHERE preparation.operation_id = $1 AND preparation.revision_id = $2::uuid
          AND event.payload->>'preparationId' = preparation.operation_id
          AND event.event_type = 'content.publication.active'`, [row.preparation_id, event.revisionId]);
      if (terminal.rowCount !== 1) throw new ContentUnavailable('eligibility source settled Content pin is unavailable');
      const source = terminal.rows[0];
      const publication = await this.readProjectionPublication({ id: source.id,
        position: position(source), operationId: source.operation_id, eventType: source.event_type,
        recipe: source.recipe, revisionId: source.revision_id, payload: source.payload }, allowUnavailableActiveReference);
      if (publication.status !== 'active' || publication.preparationId !== row.preparation_id
        || publication.reference.resourceId !== row.resource_id
        || publication.reference.variantId !== row.source_variant
        || publication.reference.revisionId !== event.revisionId) {
        throw new ContentUnavailable('Content eligibility delivery does not resolve to its exact settled pin');
      }
      return publication;
    }
    if (!['content.publication.active', 'content.publication.rejected'].includes(event.eventType)
      || event.recipe !== RECIPE || !event.revisionId) {
      throw new ContentConflict('terminal publication event required');
    }
    const result = await this.pool.query(`SELECT o.payload, o.event_type, o.revision_id,
      p.operation_id AS preparation_id, p.revision_id AS prepared_revision,
      p.status, p.pin_active, p.graph_receipt, p.graph_data_epoch, p.graph_sequence,
      prepared.data_epoch AS preparation_epoch, prepared.sequence::text AS preparation_sequence
      FROM content.outbox o JOIN content.receipt r ON r.operation_id = o.operation_id
      JOIN content.publication_preparation p ON p.operation_id = o.payload->>'preparationId'
      JOIN content.receipt prepared ON prepared.operation_id = p.operation_id
      WHERE o.id = $1 AND o.data_epoch = $2::uuid AND o.sequence = $3::bigint
        AND o.operation_id = $4 AND r.action = 'publication.settle'
        AND r.data_epoch = o.data_epoch AND r.sequence = o.sequence`,
    [event.id, event.position.dataEpoch, event.position.sequence, event.operationId]);
    if (result.rowCount !== 1) throw new ContentUnavailable('terminal publication source unavailable');
    const row = result.rows[0];
    const graph = row.payload?.graph as GraphTerminalProof | undefined;
    const status = event.eventType === 'content.publication.active' ? 'active' : 'rejected';
    if (row.event_type !== event.eventType || row.revision_id !== event.revisionId
      || row.prepared_revision !== event.revisionId || row.status !== status
      || row.pin_active !== (status === 'active')
      || row.payload?.preparationId !== row.preparation_id
      || row.payload?.revisionId !== event.revisionId
      || row.preparation_epoch !== event.position.dataEpoch
      || !graph || graph.outcome !== status || graph.revisionId !== event.revisionId
      || graph.receipt !== row.graph_receipt || graph.dataEpoch !== row.graph_data_epoch
      || graph.sequence !== row.graph_sequence
      || stable(row.payload) !== stable(event.payload)) {
      throw new ContentUnavailable('terminal publication event differs from settled pin');
    }
    const client = await this.pool.connect();
    try {
      // A quarantined rebuild may inspect an obsolete terminal publication after
      // its bytes were erased. The graph head decides whether exact bytes are
      // still required; ordinary projection always takes the strict path.
      const reference = status === 'active' && !allowUnavailableActiveReference
        ? await readReference(client, event.revisionId)
        : await readReferenceMetadata(client, event.revisionId);
      if (!reference) throw new ContentUnavailable('terminal publication exact revision unavailable');
      return { preparationId: row.preparation_id,
        preparationPosition: { owner: 'content', dataEpoch: row.preparation_epoch,
          sequence: row.preparation_sequence }, reference, status, graph };
    } finally { client.release(); }
  }
}
