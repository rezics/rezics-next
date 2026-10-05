import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { advanceContentSequence } from '../content-sequence.ts';
import { editorialFieldSlot, validEditorialControlBasis, validProtectionTransition,
  type EditorialControlBasis, type EditorialFieldTarget } from '../protection/field-control.ts';
import { validLabels, UNASSESSED, type Assessment } from '../suitability/policy.ts';
import type { ReadAssessment } from '../suitability/contract.ts';
import { SCREEN_POLICY, screenVerdict, type Scores } from '../media-screen/policy.ts';
import { assetIri, DEFAULT_MEDIA_CONTEXT, MediaConflict, MediaFenced, MediaInvalid,
  MediaMissing, MediaStale, type MediaAdmission } from './store.ts';

export const IMAGE_INFERENCE_POLICY = 'image-nsfw-v1';
export type ImageNsfw = 'unknown' | 'sfw' | 'nsfw';
export type ImageField = 'nsfw' | 'ageRating' | 'conceal';
export interface MediaFieldControl {
  target: EditorialFieldTarget; basis: EditorialControlBasis;
  valueHead: string | null; locked: boolean; canEdit:boolean; canProtect:boolean;
}
export interface ImageMetadata {
  representation: string; asset: string; sha256: string; use: string | null;
  mediaType: string; width: number; height: number; url: string;
  nsfw: ImageNsfw; ageRating: ReadAssessment; conceal: boolean;
  controls: { nsfw: MediaFieldControl; ageRating: MediaFieldControl; conceal: MediaFieldControl | null };
  canEdit: boolean; canProtect: boolean;
}
export type MetadataRef = { representation: string; use?: string } | { selection: string };
export interface MetadataBasis {
  metadata: ImageMetadata; owner: string; actor: string | null; target: string | null;
  context: string; disclosure: string; objectNamespace: string; byteLength: number;
}
export interface MediaFieldInput {
  representation?: string; use?: string; field: ImageField;
  expectedValueHead: string | null; basis: EditorialControlBasis;
  value: ImageNsfw | Assessment | boolean; mode: 'edit' | 'lock' | 'unlock';
  authority: 'author' | 'platform';
}
export interface ImageInferenceInput {
  representation: string; sha256: string; model: string; modelVersion: string;
  weightsDigest: string; policyVersion: string; result: ImageNsfw;
  scores?: Scores; status: 'completed' | 'unavailable';
}
export interface DocumentImageUseInput {
  representation: string; target: string; occurrence: string; context: string; conceal: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const IRI = (value: string | null) => value ? assetIri(value) : null;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fieldTarget = (field: ImageField, representation: string, use?: string,
  context = DEFAULT_MEDIA_CONTEXT): EditorialFieldTarget => ({
    component: assetIri(field === 'conceal' ? use! : representation),
    definition: `https://rezics.com/definition/media-${field}-v1`,
    occurrence: field === 'conceal' ? assetIri(use!) : null,
    context: field === 'conceal' ? context ?? DEFAULT_MEDIA_CONTEXT : DEFAULT_MEDIA_CONTEXT,
  });
export function validateMediaField(input: MediaFieldInput): void {
  if (!['nsfw', 'ageRating', 'conceal'].includes(input.field)
    || (input.field === 'conceal' ? !UUID.test(input.use ?? '') : !UUID.test(input.representation ?? ''))
    || !validEditorialControlBasis(input.basis)
    || [input.basis.head, input.basis.protection, input.expectedValueHead].some(value => value !== null && !NATIVE.test(value))
    || !['edit', 'lock', 'unlock'].includes(input.mode) || !['author', 'platform'].includes(input.authority)) {
    throw new MediaInvalid('exact media field basis is required');
  }
  if (input.field === 'nsfw' && !['unknown', 'sfw', 'nsfw'].includes(input.value as string)
    || input.field === 'conceal' && typeof input.value !== 'boolean') throw new MediaInvalid('invalid media field value');
  if (input.field === 'ageRating') {
    const value = input.value as Assessment;
    if (!value || !['assessed', 'unassessed'].includes(value.status)
      || value.status === 'assessed' && !validLabels(value.labels)) throw new MediaInvalid('invalid media assessment');
  }
  if (input.authority !== 'platform' && input.mode !== 'edit') throw new MediaFenced('platform authority is required');
}
/** Client evidence is untrusted. Recompute its result using the admitted policy,
 * retaining the actual producer rather than claiming server execution. */
export function validateImageInference(input: ImageInferenceInput): ImageNsfw {
  if (!UUID.test(input.representation) || !/^[0-9a-f]{64}$/.test(input.sha256)
    || input.model !== SCREEN_POLICY.model || input.modelVersion !== SCREEN_POLICY.version
    || input.weightsDigest !== SCREEN_POLICY.weightsDigest || input.policyVersion !== IMAGE_INFERENCE_POLICY) {
    throw new MediaInvalid('unsupported image inference provenance');
  }
  if (input.status === 'unavailable') {
    if (input.result !== 'unknown' || input.scores !== undefined) throw new MediaInvalid('unavailable inference has no verdict');
    return 'unknown';
  }
  if (input.status !== 'completed' || !input.scores
    || Object.keys(input.scores).sort().join(',') !== 'Drawing,Hentai,Neutral,Porn,Sexy') throw new MediaInvalid('invalid classifier scores');
  let result: ImageNsfw;
  try { result = screenVerdict(input.scores).reason === 'likely-explicit' ? 'nsfw' : 'sfw'; }
  catch { throw new MediaInvalid('invalid classifier scores'); }
  if (input.result !== result) throw new MediaInvalid('verdict differs from the admitted policy');
  return result;
}

export class MediaPresentationStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(run: (client: PoolClient) => Promise<T>,
    rejection?: {operation:string;digest:string;action:string}): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) {
      if (rejection && (error instanceof MediaFenced || error instanceof MediaStale || error instanceof MediaMissing)
        && !(await client.query('SELECT 1 FROM content.receipt WHERE operation_id = $1',[rejection.operation])).rowCount) {
        await advanceContentSequence(client,{operationId:rejection.operation,requestDigest:rejection.digest,
          action:rejection.action,outcome:error instanceof MediaStale?'stale_head':'rejected',reason:error.message,
          eventType:'media.presentation.rejected',recipe:'media-v1',payload:{operationId:rejection.operation}});
        await client.query('COMMIT');
      } else await client.query('ROLLBACK');
      throw error;
    }
    finally { client.release(); }
  }
  /** One bounded SQL batch, with only exact representation/use and head probes. */
  async metadata(refs: readonly MetadataRef[]): Promise<Array<MetadataBasis | null>> {
    if (!refs.length || refs.length > 64 || refs.some(ref => 'selection' in ref ? !UUID.test(ref.selection)
      : !UUID.test(ref.representation) || ref.use !== undefined && !UUID.test(ref.use))) throw new MediaInvalid('invalid media metadata batch');
    const rows = (await this.pool.query(`WITH requested AS (
      SELECT r.value->>'representation' AS representation, r.value->>'use' AS use,
        r.value->>'selection' AS selection, r.ordinality
        FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY r(value,ordinality))
      SELECT q.ordinality,p.id,p.asset_id,p.byte_digest,p.media_type,p.pixel_width,p.pixel_height,p.byte_length,
        a.owner,a.object_namespace,s.disclosure,u.id AS use_id,u.actor,u.target,u.context,
        n.head AS nsfw_head,n.epoch AS nsfw_epoch,n.protection_head AS nsfw_protection,n.value_head AS nsfw_value,
        COALESCE(nr.value,CASE WHEN legacy.reason = 'likely-explicit' THEN '"nsfw"'::jsonb
          WHEN legacy.reason IS NULL AND legacy.evidence ? 'scores' THEN '"sfw"'::jsonb ELSE NULL END) AS nsfw,
        ag.head AS age_head,ag.epoch AS age_epoch,ag.protection_head AS age_protection,
        ag.value_head AS age_value,ar.value AS age_rating,ar.predecessor AS age_predecessor,
        ar.source AS age_source,ar.created_at AS age_created,
        c.head AS conceal_head,c.epoch AS conceal_epoch,c.protection_head AS conceal_protection,
        c.value_head AS conceal_value,cr.value AS conceal
      FROM requested q
      LEFT JOIN media.selection_revision selection ON selection.id = q.selection::uuid
      LEFT JOIN media.selection_slot selection_slot ON (selection_slot.target,selection_slot.context,selection_slot.role)
        = (selection.target,selection.context,selection.role) AND media.delivered_selection(selection_slot) = selection.id
      LEFT JOIN media.use selected_use ON selected_use.id = selection.use_id AND selection_slot.target IS NOT NULL
      JOIN media.representation p ON p.id = COALESCE(q.representation::uuid,selected_use.representation_id)
      JOIN media.asset a ON a.id = p.asset_id JOIN media.asset_state s ON s.id = a.state_head
      LEFT JOIN media.use u ON u.id = COALESCE(q.use::uuid,selected_use.id)
        AND (u.representation_id = p.id OR (p.kind = 'rendition' AND p.source_id = u.representation_id
          AND p.crop IS NOT DISTINCT FROM u.crop))
      LEFT JOIN media.field_slot n ON n.representation_id = p.id AND n.field = 'nsfw'
      LEFT JOIN media.field_revision nr ON nr.id = n.value_head
      LEFT JOIN media.screen_result legacy ON legacy.source_id = p.id
      LEFT JOIN media.field_slot ag ON ag.representation_id = p.id AND ag.field = 'ageRating'
      LEFT JOIN media.field_revision ar ON ar.id = ag.value_head
      LEFT JOIN media.field_slot c ON c.use_id = u.id AND c.field = 'conceal'
      LEFT JOIN media.field_revision cr ON cr.id = c.value_head
      WHERE p.availability = 'available' AND s.lifecycle = 'active' AND s.moderation = 'none'
        AND media.delivery_clearance(p) = 'cleared' AND (q.use IS NULL OR u.id IS NOT NULL)
        AND (u.role IS NULL OR u.role NOT LIKE 'showcase-%' OR EXISTS (
          SELECT 1 FROM media.selection_slot slot JOIN media.selection_revision current ON current.id=slot.head
          WHERE slot.target=u.target AND slot.context=u.context AND slot.role=u.role AND current.use_id=u.id))
      ORDER BY q.ordinality`, [JSON.stringify(refs)])).rows;
    const byIndex = new Map(rows.map(row => [Number(row.ordinality) - 1, row]));
    return refs.map((ref, index) => {
      const row = byIndex.get(index); if (!row) return null;
      const control = (field: ImageField, prefix: string): MediaFieldControl => ({
        target: fieldTarget(field, row.id, row.use_id, row.context ?? DEFAULT_MEDIA_CONTEXT),
        basis: { head: IRI(row[`${prefix}_head`] ?? null), epoch: String(row[`${prefix}_epoch`] ?? '0'),
          protection: IRI(row[`${prefix}_protection`] ?? null) },
        valueHead: IRI(row[`${prefix}_value`] ?? null), locked: row[`${prefix}_protection`] != null,
        canEdit:false,canProtect:false,
      });
      const ageRating: ReadAssessment = row.age_rating?.status === 'assessed'
        ? { status: 'assessed', labels: row.age_rating.labels, revision: IRI(row.age_value)!,
          predecessor: IRI(row.age_predecessor), basis: row.age_source === 'platform' ? 'platform' : 'author',
          sourceId: null, createdAt: row.age_created.toISOString() } : UNASSESSED;
      return { metadata: { representation: row.id, asset: row.asset_id, sha256: row.byte_digest,
        use: row.use_id ?? null, mediaType: row.media_type, width: row.pixel_width, height: row.pixel_height,
        url: `/v1/media/representations/${row.id}/bytes${row.use_id ? `?use=${row.use_id}` : ''}`,
        nsfw: row.nsfw ?? 'unknown', ageRating, conceal: row.conceal ?? false,
        controls: { nsfw: control('nsfw','nsfw'), ageRating: control('ageRating','age'),
          conceal: row.use_id ? control('conceal','conceal') : null }, canEdit: false, canProtect: false },
        owner: row.owner, actor: row.actor ?? null, target: row.target ?? null,
        context: row.context ?? DEFAULT_MEDIA_CONTEXT, disclosure: row.disclosure,
        objectNamespace: row.object_namespace, byteLength: row.byte_length };
    });
  }
  private async replay(client: PoolClient, operation: string, digest: string, action: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operation]);
    const prior = (await client.query('SELECT * FROM content.receipt WHERE operation_id = $1', [operation])).rows[0];
    if (prior && (prior.request_digest !== digest || prior.action !== action)) throw new MediaConflict('operation binds another media intent');
    return prior;
  }
  private async slot(client: PoolClient, field: ImageField, representation: string, use?: string, context?: string) {
    const target = fieldTarget(field, representation, use, context);
    const slot = editorialFieldSlot(target);
    await client.query(`INSERT INTO media.field_slot(slot,representation_id,use_id,field)
      VALUES ($1,$2,$3,$4) ON CONFLICT (slot) DO NOTHING`,
    [slot, field === 'conceal' ? null : representation, field === 'conceal' ? use : null, field]);
    return (await client.query('SELECT * FROM media.field_slot WHERE slot = $1 FOR UPDATE', [slot])).rows[0]!;
  }
  private async append(client: PoolClient, row: Record<string, any>, operation: string, actor: string,
    value: unknown, mode: MediaFieldInput['mode'], source: 'author' | 'platform' | 'client' | 'server') {
    const id = randomUUID();
    await client.query(`INSERT INTO media.field_revision(id,slot,predecessor,epoch,expected_protection,
      expected_value,mode,source,value,actor,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, row.slot, row.head, (BigInt(row.epoch) + 1n).toString(), row.protection_head,
      row.value_head, mode, source, JSON.stringify(value), actor, operation]);
    return id;
  }
  async changeField(admission: MediaAdmission, input: MediaFieldInput) {
    validateMediaField(input);
    const operation = `media-field:${admission.admissionId}`;
    return this.transaction(async client => {
      const prior = await this.replay(client, operation, admission.requestDigest, 'media.field.change');
      if (prior) {
        if (prior.outcome === 'stale_head') throw new MediaStale(prior.reason);
        if (prior.outcome !== 'succeeded') throw new MediaFenced(prior.reason);
        return { revision: IRI((await client.query('SELECT id FROM media.field_revision WHERE operation_id = $1', [operation])).rows[0]?.id), replayed: true,
          position: { owner: 'content' as const, dataEpoch: prior.data_epoch, sequence: String(prior.sequence) } };
      }
      if (input.field === 'conceal') await client.query('SELECT id FROM media.use WHERE id = $1 FOR UPDATE',[input.use]);
      const resource = (await client.query(`SELECT p.id,a.owner,u.actor,u.context FROM media.representation p
        JOIN media.asset a ON a.id = p.asset_id JOIN media.asset_state s ON s.id = a.state_head
        LEFT JOIN media.use u ON u.id = $2 AND u.representation_id = p.id
        WHERE (p.id = $1 OR ($1 IS NULL AND u.id = $2))
          AND p.availability = 'available' AND s.lifecycle = 'active' AND s.moderation = 'none' FOR SHARE OF a,p`,
      [input.representation ?? null, input.use ?? null])).rows[0];
      if (!resource || (input.authority === 'author' && (input.field === 'conceal' ? resource.actor : resource.owner) !== admission.actingSubject))
        throw new MediaMissing('editable media is unavailable');
      const row = await this.slot(client,input.field,resource.id,input.use,resource.context);
      if (IRI(row.head) !== input.basis.head || String(row.epoch) !== input.basis.epoch
        || IRI(row.protection_head) !== input.basis.protection || IRI(row.value_head) !== input.expectedValueHead)
        throw new MediaStale('media control basis changed');
      if (row.protection_head && input.authority !== 'platform') throw new MediaFenced('media field is protected');
      if (input.mode !== 'edit' && !validProtectionTransition(row.protection_head ? 'review-required' : 'open',
        input.mode === 'unlock' ? 'relax' : row.protection_head ? 'confirm' : 'tighten'))
        throw new MediaStale('media protection mode changed');
      const position = await advanceContentSequence(client, { operationId: operation, requestDigest: admission.requestDigest,
        action: 'media.field.change', outcome: 'succeeded', eventType: 'media.field.changed', recipe: 'media-v1',
        payload: { representation: resource.id, use: input.use ?? null, field: input.field } });
      const revision = await this.append(client,row,operation,admission.actingSubject,input.value,input.mode,input.authority);
      return { revision: IRI(revision), replayed: false, position };
    },{operation,digest:admission.requestDigest,action:'media.field.change'});
  }
  async recordInference(admission: MediaAdmission, input: ImageInferenceInput, producer: 'client' | 'server' = 'client') {
    const result = validateImageInference(input);
    const operation = `media-inference:${admission.admissionId}`;
    return this.transaction(async client => {
      const prior = await this.replay(client,operation,admission.requestDigest,'media.inference.record');
      if (prior) {
        if (prior.outcome === 'stale_head') throw new MediaStale(prior.reason);
        if (prior.outcome !== 'succeeded') throw new MediaFenced(prior.reason);
        const evidence = (await client.query('SELECT id,result FROM media.inference_observation WHERE operation_id = $1',[operation])).rows[0]!;
        return { observation: evidence.id,result: evidence.result, replayed: true,
          position: { owner: 'content' as const,dataEpoch: prior.data_epoch,sequence: String(prior.sequence) } };
      }
      const resource = (await client.query(`SELECT p.byte_digest,a.owner FROM media.representation p
        JOIN media.asset a ON a.id = p.asset_id JOIN media.asset_state s ON s.id = a.state_head
        WHERE p.id = $1 AND p.availability = 'available'
          AND s.lifecycle = 'active' AND s.moderation = 'none' FOR SHARE OF a,p`,[input.representation])).rows[0];
      if (!resource || producer === 'client' && resource.owner !== admission.actingSubject) throw new MediaMissing('editable image is unavailable');
      if (resource.byte_digest !== input.sha256) throw new MediaStale('image bytes changed');
      const row = await this.slot(client,'nsfw',input.representation);
      const position = await advanceContentSequence(client,{operationId:operation,requestDigest:admission.requestDigest,
        action:'media.inference.record',outcome:'succeeded',eventType:'media.inference.recorded',recipe:'media-v1',
        payload:{representation:input.representation,producer}});
      const observation = randomUUID();
      await client.query(`INSERT INTO media.inference_observation(id,representation_id,byte_digest,producer,model,
        model_version,weights_digest,policy_version,status,result,scores,actor,operation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[observation,input.representation,input.sha256,
        producer,input.model,input.modelVersion,input.weightsDigest,input.policyVersion,input.status,result,
        input.scores ? JSON.stringify(input.scores) : null,admission.actingSubject,operation]);
      if (!row.value_head && !row.protection_head && result !== 'unknown')
        await this.append(client,row,operation,admission.actingSubject,result,'edit',producer);
      return {observation,result,replayed:false,position};
    },{operation,digest:admission.requestDigest,action:'media.inference.record'});
  }
  async createDocumentUse(admission: MediaAdmission, input: DocumentImageUseInput) {
    if (!UUID.test(input.representation) || !UUID.test(input.occurrence) || !NATIVE.test(input.target)
      || input.context !== DEFAULT_MEDIA_CONTEXT && !NATIVE.test(input.context) || typeof input.conceal !== 'boolean')
      throw new MediaInvalid('invalid document image occurrence');
    const operation = `media-document-use:${admission.admissionId}`;
    return this.transaction(async client => {
      const prior = await this.replay(client,operation,admission.requestDigest,'media.use.create');
      if (prior) {
        if (prior.outcome !== 'succeeded') throw new MediaFenced('media admission was fenced');
        const use = (await client.query('SELECT id,asset_id FROM media.use WHERE operation_id = $1',[operation])).rows[0]!;
        return {use:use.id,asset:use.asset_id,representation:input.representation,occurrence:input.occurrence,replayed:true,
          position:{owner:'content' as const,dataEpoch:prior.data_epoch,sequence:String(prior.sequence)}};
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
        `media-document-occurrence:${input.target}:${input.occurrence}`]);
      if ((await client.query('SELECT 1 FROM media.use WHERE target = $1 AND occurrence = $2 AND role = \'document-image\'',
        [input.target,input.occurrence])).rowCount) throw new MediaConflict('document image occurrence already has a binding');
      const resource = (await client.query(`SELECT a.id,a.variant_id,v.draft_head FROM media.representation p
        JOIN media.asset a ON a.id = p.asset_id JOIN media.asset_state s ON s.id = a.state_head
        JOIN content.variant v ON v.id = a.variant_id
        WHERE p.id = $1 AND a.owner = $2 AND p.availability = 'available' AND s.lifecycle = 'active'
          AND s.moderation = 'none' AND media.delivery_clearance(p) = 'cleared' AND v.draft_head IS NOT NULL FOR SHARE OF a,p`,
      [input.representation,admission.actingSubject])).rows[0];
      if (!resource) throw new MediaMissing('image is unavailable');
      const position = await advanceContentSequence(client,{operationId:operation,requestDigest:admission.requestDigest,
        action:'media.use.create',outcome:'succeeded',eventType:'media.use.created',recipe:'media-v1',payload:{target:input.target}});
      const use = randomUUID();
      await client.query(`INSERT INTO media.use(id,asset_id,asset_variant_id,asset_revision_id,representation_id,
        target,context,role,crop,actor,operation_id,occurrence) VALUES ($1,$2,$3,$4,$5,$6,$7,'document-image',NULL,$8,$9,$10)`,
      [use,resource.id,resource.variant_id,resource.draft_head,input.representation,input.target,input.context,admission.actingSubject,operation,input.occurrence]);
      // Initial concealment is part of this exact occurrence, independent of its image labels.
      if (input.conceal) {
        const row = await this.slot(client,'conceal',input.representation,use,input.context);
        const concealOperation = `${operation}:conceal`;
        await advanceContentSequence(client,{operationId:concealOperation,requestDigest:hash(`${admission.requestDigest}:conceal`),
          action:'media.field.change',outcome:'succeeded',eventType:'media.field.changed',recipe:'media-v1',payload:{use,field:'conceal'}});
        await this.append(client,row,concealOperation,admission.actingSubject,true,'edit','author');
      }
      return {use,asset:resource.id,representation:input.representation,occurrence:input.occurrence,replayed:false,position};
    },{operation,digest:admission.requestDigest,action:'media.use.create'});
  }
}
