import type { VerifiedSourceImportBinding } from '../source/native-work-adoption.ts';
import { validSynopsisText } from '../source/field-control-language.ts';
import { contentConnection, contentSessionClient } from '../../../../content/src/connection.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { representedGrantProof, dispatchRepresentedGrant } from '../access/composition.ts';
import type { ExportBasis, LicenseScopeHook, VerifiedExportMember } from '../export/planner.ts';
import type { DeliveryCutSnapshot } from './delivery-cut.ts';
import { assessmentFamilies, assessmentOutcomes, expressionKinds, materialScopes, obligationKinds, rightsBases,
  useKinds } from './schema.ts';

export class RightsInvalid extends Error {}
export class RightsDenied extends Error {}
export class RightsConflict extends Error {}
export class RightsStale extends Error {}
export class RightsUnavailable extends Error {}

/** Access action and scope gate for recording rights assessments. */
export const ASSESS_ACTION = 'rights.assess';
export const ASSESS_SCOPE = 'rights:assess';

export interface MaterialScope {
  scopeKind: typeof materialScopes[number];
  provider: string | null; namespace: string | null; sourceRecordId: string | null;
  contentVariantId: string | null; mediaAsset: string | null; workId?: string | null; wikiEvidenceId?: string | null; component: string;
}
export interface UseKey { family: typeof assessmentFamilies[number]; useKind: typeof useKinds[number]; useScope: string }
export interface AssessmentInput extends UseKey {
  actingSubject: string; material: MaterialScope; expressionKind: typeof expressionKinds[number];
  basis: typeof rightsBases[number]; outcome: typeof assessmentOutcomes[number];
  licenseInstrument: string | null; exceptionKind: 'fair_use' | null; rationale: string | null;
  extent: Record<string, unknown>; evidence: Record<string, unknown>;
  obligations: Array<{ kind: typeof obligationKinds[number]; instrument: string;
    appliesTo: 'display' | 'export' | 'redistribution' | 'all'; notice: string | null }>;
  expectedAssessment: string | null; idempotencyKey: string;
}
export interface Assessment extends UseKey {
  assessmentId: string; materialId: string; expressionKind: string; basis: string; outcome: string;
  licenseInstrument: string | null; exceptionKind: string | null; rationale: string | null;
  extent: Record<string, unknown>; predecessor: string | null;
  /** Head revision while current; null once superseded. */
  revision: string | null;
  obligations: Array<{ kind: string; instrument: string; appliesTo: string; notice: string | null }>;
}
export type UseEvaluation = { status: 'assessed'; assessment: Assessment } | { status: 'unassessed'; materialId: string | null };

const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const scopePattern = /^[a-z0-9][a-z0-9:_./-]{0,127}$/;
const componentPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const governanceOwnerNames = new Set(['graph', 'content', 'source', 'media']);
const governanceComponentNames = new Set(['name', 'title', 'body', 'structure', 'media_use', 'synopsis',
  'cover', 'publication', 'record']);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const PUBLIC_DOMAIN_TEXT_USE = { family: 'data_rights', useKind: 'redistribution',
  useScope: 'rezics:public-text' } as const;

export function publicDomainWorkMaterial(work: string): MaterialScope {
  if (!agentPattern.test(work)) throw new RightsInvalid('invalid public-domain Work');
  return { scopeKind: 'work', provider: null, namespace: null, sourceRecordId: null,
    contentVariantId: null, mediaAsset: null, workId: work, component: 'body' };
}

/** Provider-specific scope used for an exact service-terms retention assessment. */
export function sourceRetentionScope(provider: string, namespace: string): string {
  return `source-provider:${sha256(`${provider}\0${namespace}`)}`;
}

export function rightsExportUseScope(scope: Parameters<LicenseScopeHook>[1]): string {
  return `rezics:export:${scope}`;
}

interface ExportRightsIdentity {
  material: MaterialScope;
  target: { owner: string; resource: string; component: string; revision: string | null } | null;
}

function exportRightsIdentity(member: VerifiedExportMember): ExportRightsIdentity | null | false {
  const candidate = member.data?.rightsIdentity;
  if (candidate === undefined) return null;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const value = candidate as Partial<ExportRightsIdentity>;
  if (!value.material || !validMaterial(value.material)
    || value.target === undefined) return false;
  if (value.target !== null && (!governanceOwnerNames.has(value.target.owner)
    || !governanceComponentNames.has(value.target.component)
    || typeof value.target.resource !== 'string' || value.target.resource.length < 1
    || value.target.resource.length > 512
    || !(value.target.revision === null || typeof value.target.revision === 'string'
      && value.target.revision.length <= 512)
    || value.material.component !== value.target.component
    || value.target.revision !== (member.contentRevisionId ?? member.exactRef))) return false;
  return value as ExportRightsIdentity;
}

/** Public wiki display. A head for another use, including export, is a different key. */
export const WIKI_DISPLAY_USE = { family: 'data_rights', useKind: 'wiki_display',
  useScope: 'rezics:wiki' } as const;

export interface WikiDisplayObligation {
  kind: typeof obligationKinds[number]; instrument: string; appliesTo: 'display' | 'all'; notice: string | null;
}
/** No current head, and a disclosure-hidden head, are the same public shape. */
export type WikiDisplayObligations = { status: 'unassessed' }
  | { status: 'assessed'; use: 'wiki_display'; instrument: string | null; obligations: WikiDisplayObligation[];
      /** Exact current assessment/material association; this does not identify an unrecorded source. */
      identity?: { assessmentId: string; materialId: string; component: string;
        sourceRecordId: string | null; wikiEvidenceId: string | null } };

const displayAppliesTo = new Set(['display', 'all']);

/** The description text of a Work. Importers assess this key; the source is not part of the key. */
export function workDescriptionMaterial(work: string): MaterialScope {
  if (!agentPattern.test(work)) throw new RightsInvalid('invalid work description material');
  return { scopeKind: 'work', provider: null, namespace: null, sourceRecordId: null,
    contentVariantId: null, mediaAsset: null, workId: work, wikiEvidenceId: null, component: 'synopsis' };
}

/** The fact set displayed for a subject resource. */
export function resourceFactMaterial(resource: string): MaterialScope {
  if (!agentPattern.test(resource)) throw new RightsInvalid('invalid fact-set material');
  return { scopeKind: 'work', provider: null, namespace: null, sourceRecordId: null,
    contentVariantId: null, mediaAsset: null, workId: resource, wikiEvidenceId: null, component: 'record' };
}

export function projectWikiDisplay(row: { assessmentId: string | null; licenseInstrument: string | null;
  materialId?: string; component?: string; sourceRecordId?: string | null; wikiEvidenceId?: string | null;
  obligations: Array<{ kind: string; instrument: string; appliesTo: string; notice: string | null }> } | undefined,
  hidden: boolean): WikiDisplayObligations {
  if (hidden || !row?.assessmentId) return { status: 'unassessed' };
  return { status: 'assessed', use: 'wiki_display', instrument: row.licenseInstrument,
    ...(row.materialId && row.component ? { identity: { assessmentId: row.assessmentId, materialId: row.materialId,
      component: row.component, sourceRecordId: row.sourceRecordId ?? null, wikiEvidenceId: row.wikiEvidenceId ?? null } } : {}),
    obligations: row.obligations.flatMap(item => displayAppliesTo.has(item.appliesTo)
      && (obligationKinds as readonly string[]).includes(item.kind)
      ? [{ kind: item.kind as typeof obligationKinds[number], instrument: item.instrument,
        appliesTo: item.appliesTo as 'display' | 'all', notice: item.notice }] : []) };
}

/** A missing export head is not an unprotected fact. The result stays undetermined. */
export function unassessedExportBasis(useScope: Parameters<LicenseScopeHook>[1], memberOrdinal: number): ExportBasis {
  return { basisKind: 'unassessed', basisRef: null, licenseExpression: null, notice: null, obligations: [],
    useScope, result: 'undetermined', memberOrdinals: [memberOrdinal] };
}

/** Kinds the export profile can carry. `other` stays unsupported and leaves the member undetermined. */
export const exportSupportedObligationKinds = {
  attribution: 'attribution', share_alike: 'share_alike', non_commercial: 'non_commercial',
  no_derivatives: 'no_derivatives', notice_retention: 'notice_retention', change_indication: 'change_indication',
} as const;

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

function normalize(error: unknown): Error {
  if (error instanceof RightsInvalid || error instanceof RightsDenied || error instanceof RightsConflict
    || error instanceof RightsStale || error instanceof RightsUnavailable) return error;
  const code = (error as { code?: string }).code;
  if (code === '23505' || code === '40001' || code === '40P01') return new RightsConflict('concurrent rights change');
  if (code === '23514') return new RightsInvalid('rights record violates its profile');
  if (code === '23503') return new RightsStale('rights basis changed');
  return new RightsUnavailable('rights owner is unavailable');
}

function validMaterial(material: MaterialScope): boolean {
  return (materialScopes as readonly string[]).includes(material.scopeKind) && componentPattern.test(material.component)
    && (material.scopeKind !== 'work' || agentPattern.test(material.workId ?? ''))
    && (material.scopeKind !== 'wiki_evidence' || agentPattern.test(material.wikiEvidenceId ?? ''));
}

/** Admission and delivery follow the same exact material/use identity.
 * Bound the head seek before other joins so a missing use cannot scan unrelated heads. */
function publicDomainAssessmentSelection(work = '$1', assessment = '$2'): string {
  return `SELECT h.assessment_id::text AS assessment_head, a.basis, a.outcome
    FROM (
      SELECT assessment_id FROM rights.use_assessment_head
      WHERE material_id = (SELECT material_id FROM rights.use_assessment WHERE id = ${assessment}::uuid)
        AND family = 'data_rights' AND use_kind = 'redistribution'
        AND use_scope = 'rezics:public-text'
      LIMIT 1
    ) h
    JOIN rights.use_assessment a ON a.id = h.assessment_id
    JOIN rights.material m ON m.id = a.material_id
    WHERE m.scope_kind = 'work' AND m.work_id = ${work}
      AND m.component = 'body' AND m.expression_kind = 'expression'
    LIMIT 1`;
}

function supportedPublicDomainHead(row: { assessment_head: string; basis: string; outcome: string },
  assessmentId: string): boolean {
  return row.assessment_head === assessmentId.toLowerCase()
    && row.basis === 'public_domain' && row.outcome === 'supported';
}

/**
 * Content-database rights basis owner. Assessments are immutable per exact
 * material, family, use and use scope; a changed use is a different key and
 * never inherits an earlier conclusion. Authority comes from an Access grant
 * selected before the Content transaction and fenced through its commit.
 */
export class RightsStore {
  constructor(private readonly content: Pool, private readonly access: Pool) {}

  /** Fresh autocommit snapshots: one indexed statement per applicable owner.
   * Original contributions have no Rights reference; unrelated assessments
   * cannot change their token or add work to their delivery. */
  async deliveryCutSnapshot(resourceId: string, assessmentId: string | null): Promise<DeliveryCutSnapshot> {
    if (!agentPattern.test(resourceId) || (assessmentId !== null && !/^[0-9a-f-]{36}$/i.test(assessmentId))) {
      throw new RightsInvalid('invalid delivery target');
    }
    try {
      const [assessment, preservation] = await Promise.all([
        assessmentId === null ? Promise.resolve({ rows: [] })
          : this.content.query<{ assessment_head: string }>(publicDomainAssessmentSelection(),
            [resourceId, assessmentId]),
        this.access.query<{ version: string; held: boolean }>(`SELECT version::text,
          active_holds > 0 AS held FROM access.governance_preservation_delivery_head
          WHERE target_resource = $1`, [resourceId]),
      ]);
      return { assessmentHead: assessmentId === null ? 'no-assessment' : assessment.rows[0]?.assessment_head ?? null,
        preservationVersion: preservation.rows[0]?.version ?? '0',
        held: preservation.rows[0]?.held ?? false };
    } catch { throw new RightsUnavailable('delivery cut is unavailable'); }
  }

  /** Source evidence supplies the positive basis; an existing Rights refusal still closes that exact Work/source. */
  async structuredPublicationRights(work: string, record: string): Promise<{ allowed: boolean; heads: string[] }> {
    if (!agentPattern.test(work) || !agentPattern.test(record)) throw new RightsInvalid('invalid structured publication rights');
    try {
      const rows = (await contentConnection(this.content).query<{ assessment_id: string; outcome: string }>(`
        SELECT h.assessment_id::text, a.outcome FROM rights.material m
        JOIN rights.use_assessment_head h ON h.material_id = m.id
        JOIN rights.use_assessment a ON a.id = h.assessment_id
        WHERE ((m.work_id = $1 AND m.component IN ('record', 'body', 'structure'))
          OR m.source_record_id = $2::uuid) AND h.family = 'data_rights'
          AND ((h.use_kind = 'wiki_display' AND h.use_scope = 'rezics:wiki')
            OR (h.use_kind = 'redistribution' AND h.use_scope IN ('rezics:imports', 'rezics:public-text')))
        ORDER BY h.assessment_id LIMIT 65`, [work, record.slice(-36)])).rows;
      if (rows.length > 64) throw new RightsUnavailable('structured publication rights exceed their bound');
      return { allowed: rows.every(row => row.outcome !== 'not_supported'), heads: rows.map(row => row.assessment_id) };
    } catch (error) {
      if (error instanceof RightsUnavailable) throw error;
      throw new RightsUnavailable('structured publication rights are unavailable');
    }
  }

  /** Source's verified factual mapping supplies its own positive basis. This
   * exact import-use check closes current Rights refusals and source-apply
   * fences; it grants neither quotation nor artwork/public delivery rights. */
  async retainedFieldReusePermitted(record: string,
    observations: readonly { record: string; observation: string }[]): Promise<boolean> {
    if (!agentPattern.test(record) || observations.length < 1 || observations.length > 512
      || observations.some(item => !agentPattern.test(item.record) || !agentPattern.test(item.observation))) {
      throw new RightsInvalid('invalid retained field reuse scope');
    }
    const records = [...new Set([record, ...observations.map(item => item.record)])];
    const targets = observations.flatMap(item => [{ record, observation: item.observation }, item]);
    try {
      const [rights, fences] = await Promise.all([
        contentConnection(this.content).query(`SELECT 1 FROM rights.material m
          JOIN rights.use_assessment_head h ON h.material_id=m.id
          JOIN rights.use_assessment a ON a.id=h.assessment_id
          WHERE m.scope_kind='source_record' AND m.source_record_id=ANY($1::uuid[])
            AND h.family='data_rights' AND h.use_kind='redistribution'
            AND h.use_scope='rezics:imports' AND a.outcome='not_supported' LIMIT 1`,
        [records.map(value => value.slice(-36))]),
        this.access.query(`SELECT 1 FROM unnest($1::text[],$2::text[]) AS wanted(record,observation)
          JOIN access.governance_enforcement e ON e.owner='source' AND e.resource=wanted.record
            AND e.state='restricted' AND e.effect='source_apply'
            AND e.context='urn:rezics:context:global'
            AND (e.revision IS NULL OR e.revision=wanted.observation) LIMIT 1`,
        [targets.map(item => item.record), targets.map(item => item.observation)]),
      ]);
      return rights.rowCount === 0 && fences.rowCount === 0;
    } catch { throw new RightsUnavailable('retained field reuse rights are unavailable'); }
  }

  /** One indexed current-head lookup. Historical or withdrawn assessments are never a public basis. */
  async currentPublicDomainAssessment(work: string, assessmentId: string, client?: PoolClient): Promise<boolean> {
    if (!agentPattern.test(work) || !/^[0-9a-f-]{36}$/i.test(assessmentId)) {
      throw new RightsInvalid('invalid public-domain assessment reference');
    }
    try {
      const result = await (client ?? this.content).query<{ assessment_head: string; basis: string; outcome: string }>(
        publicDomainAssessmentSelection(), [work, assessmentId]);
      return result.rows.some(row => supportedPublicDomainHead(row, assessmentId));
    } catch (cause) { throw new RightsUnavailable('current public-domain assessment is unavailable', { cause }); }
  }

  /** At most 512 phrase hits share one indexed rights probe, O(hits) input and result. */
  async currentPublicDomainAssessments(refs: readonly { work: string; assessmentId: string }[]): Promise<Set<string>> {
    if (refs.length > 512 || refs.some(ref => !agentPattern.test(ref.work)
      || !/^[0-9a-f-]{36}$/i.test(ref.assessmentId))) {
      throw new RightsInvalid('invalid public-domain search rights batch');
    }
    if (!refs.length) return new Set();
    try {
      const result = await this.content.query<{
        work_id: string; assessment_id: string; assessment_head: string; basis: string; outcome: string;
      }>(`SELECT requested.work_id, requested.assessment_id, selected.*
        FROM unnest($1::text[], $2::uuid[]) AS requested(work_id, assessment_id)
        CROSS JOIN LATERAL (${publicDomainAssessmentSelection('requested.work_id', 'requested.assessment_id')}) selected`,
      [refs.map(ref => ref.work), refs.map(ref => ref.assessmentId)]);
      return new Set(result.rows.filter(row => supportedPublicDomainHead(row, row.assessment_id))
        .map(row => `${row.work_id}\0${row.assessment_id}`));
    } catch (cause) { throw new RightsUnavailable('current public-domain search rights are unavailable', { cause }); }
  }

  /** A source component fence follows its exact observation or the whole record. */
  async sourceSynopsisRestricted(record: string, observation: string, effects: readonly string[]): Promise<boolean> {
    if (!agentPattern.test(record) || !agentPattern.test(observation) || effects.length < 1) {
      throw new RightsInvalid('invalid synopsis fence target');
    }
    try {
      return (await this.access.query(`SELECT 1 FROM access.governance_enforcement
        WHERE owner = 'source' AND resource = $1 AND component = 'synopsis'
          AND state = 'restricted' AND effect = ANY($3::text[])
          AND context = 'urn:rezics:context:global'
          AND (revision IS NULL OR revision = $2) LIMIT 1`,
      [record, observation, effects])).rowCount !== 0;
    } catch { throw new RightsUnavailable('synopsis fence is unavailable'); }
  }

  /** One indexed Work/slot lookup, then one batched Access probe for at most 64 source snapshots.
   * A pending Content certificate can follow a committed graph write, so it remains tainted.
   * A 65th matching support fails closed instead of making disclosure depend on a truncated result. */
  async nativeSynopsisRestricted(work: string, value: string, effects: readonly string[]): Promise<boolean> {
    if (!agentPattern.test(work) || !validSynopsisText(value)) {
      throw new RightsInvalid('invalid native synopsis fence target');
    }
    const valueDigest = sha256(JSON.stringify(value));
    let rows: Array<{ record: string; observation: string }>;
    try {
      rows = (await this.content.query<{ record: string; observation: string }>(`
        SELECT DISTINCT provenance.record,provenance.observation
        FROM source.field_support s
        JOIN source.field_support_step st ON st.support_id = s.id
        LEFT JOIN source.field_support_outcome out ON out.step_id = st.id
        JOIN source.conversion c ON c.id = st.conversion_id
        LEFT JOIN source.retained_record_binding b ON b.id=st.retained_binding_id
        CROSS JOIN LATERAL (
          SELECT 'https://rezics.com/id/' || s.record_id AS record,
            'https://rezics.com/id/' || c.observation_id AS observation
          UNION ALL SELECT part->>'record',part->>'observation'
            FROM jsonb_array_elements(COALESCE(b.request#>'{retained,intakes}','[]')) part
          UNION ALL SELECT 'https://rezics.com/id/' || s.record_id,part->>'observation'
            FROM jsonb_array_elements(COALESCE(b.request#>'{retained,intakes}','[]')) part
        ) provenance
        WHERE s.target = $1 AND s.slot = 'work-editorial-field-v1#synopsis'
          AND s.context = 'global' AND st.value_digest = $2
          AND (out.outcome = 'applied' OR out.step_id IS NULL
            OR (out.outcome='attached' AND out.attachment_profile='source-field-support-attachment-v2'))
        LIMIT 65`, [work, valueDigest])).rows;
    } catch { throw new RightsUnavailable('native synopsis provenance is unavailable'); }
    if (rows.length > 64) throw new RightsUnavailable('native synopsis provenance exceeds the read bound');
    if (!rows.length) return false;
    try {
      return (await this.access.query(`SELECT 1 FROM unnest($1::text[], $2::text[])
        AS source(record, observation) JOIN access.governance_enforcement e
          ON e.owner = 'source' AND e.resource = source.record AND e.component = 'synopsis'
          AND e.state = 'restricted' AND e.effect = ANY($3::text[])
          AND e.context = 'urn:rezics:context:global'
          AND (e.revision IS NULL OR e.revision = source.observation) LIMIT 1`,
      [rows.map(row => row.record), rows.map(row => row.observation), effects])).rowCount !== 0;
    } catch { throw new RightsUnavailable('native synopsis fence is unavailable'); }
  }

  private async assessor(principal: VerifiedPrincipal, actingSubject: string): Promise<string> {
    const row = await representedGrantProof(this.access, principal, actingSubject, ASSESS_SCOPE, ASSESS_ACTION)
      .catch(() => { throw new RightsUnavailable('Access is unavailable'); });
    if (!row) throw new RightsDenied('rights assessment authority is missing');
    return row.principalId;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>,
    commit?: (effect: () => Promise<void>) => Promise<void>): Promise<T> {
    const borrowed = contentSessionClient(this.content);
    const client = borrowed ?? await this.content.connect().catch(() => { throw new RightsUnavailable('rights owner is unavailable'); });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      const effect = async () => { await client.query('COMMIT'); };
      if (commit) await commit(effect);
      else await effect();
      return result;
    } catch (error) {
      await rollback(client);
      throw normalize(error);
    } finally { if (!borrowed) client.release(); }
  }

  private async findMaterial(client: PoolClient, material: MaterialScope): Promise<{ id: string;
    expression_kind: string } | undefined> {
    return (await client.query<{ id: string; expression_kind: string }>(`SELECT id, expression_kind
      FROM rights.material WHERE scope_kind = $1 AND provider IS NOT DISTINCT FROM $2
        AND namespace IS NOT DISTINCT FROM $3 AND source_record_id IS NOT DISTINCT FROM $4
        AND content_variant_id IS NOT DISTINCT FROM $5 AND media_asset IS NOT DISTINCT FROM $6
        AND work_id IS NOT DISTINCT FROM $7 AND component = $8 AND wiki_evidence_id IS NOT DISTINCT FROM $9`,
    [material.scopeKind, material.provider, material.namespace, material.sourceRecordId, material.contentVariantId,
      material.mediaAsset, material.workId ?? null, material.component, material.wikiEvidenceId ?? null])).rows[0];
  }

  async assess(principal: VerifiedPrincipal, input: AssessmentInput): Promise<Assessment & { replayed: boolean }> {
    const authority = await representedGrantProof(this.access, principal, input.actingSubject, ASSESS_SCOPE, ASSESS_ACTION)
      .catch(() => { throw new RightsUnavailable('Access is unavailable'); });
    if (!authority) throw new RightsDenied('rights assessment authority is missing');
    return this.writeAssessment(authority.principalId, input,
      effect => dispatchRepresentedGrant(this.access, principal, input.actingSubject, ASSESS_SCOPE,
        ASSESS_ACTION, authority, () => new RightsDenied('rights assessment authority ended'), effect));
  }

  /** Source verifies admission; importer policy supplies materials and uses.
   * Rights owns the same assessment, head, obligation and retry persistence as
   * operator assessments. The binding key survives partial import recovery. */
  async assessSourceImport(binding: VerifiedSourceImportBinding,
    assessments: ReadonlyArray<Omit<AssessmentInput, 'actingSubject' | 'idempotencyKey'>>): Promise<void> {
    for (const assessment of assessments) {
      if (assessment.material.scopeKind !== 'work' || assessment.material.workId !== binding.work
        || !['record', 'synopsis'].includes(assessment.material.component)) {
        throw new RightsInvalid('Imported assessment differs from the admitted material');
      }
    }
    for (const [index, assessment] of assessments.entries()) {
      await binding.assertActive();
      await this.writeAssessment(binding.principalId, { ...assessment, actingSubject: binding.actingSubject,
        idempotencyKey: `source-import:${binding.binding}:${index}` });
    }
  }

  private async writeAssessment(principalId: string, input: AssessmentInput,
    commit?: (effect: () => Promise<void>) => Promise<void>): Promise<Assessment & { replayed: boolean }> {
    if (!agentPattern.test(input.actingSubject) || !validMaterial(input.material) || !scopePattern.test(input.useScope)
      || !keyPattern.test(input.idempotencyKey) || input.obligations.length > 16
      || !(assessmentFamilies as readonly string[]).includes(input.family)
      || !(useKinds as readonly string[]).includes(input.useKind)
      || !(expressionKinds as readonly string[]).includes(input.expressionKind)
      || !(rightsBases as readonly string[]).includes(input.basis)
      || !(assessmentOutcomes as readonly string[]).includes(input.outcome)
      || ((input.family === 'service_terms') !== (input.basis === 'service_terms'))
      || (input.family === 'service_terms'
        && (input.material.scopeKind !== 'source_provider' || input.expressionKind !== 'service'))
      || (input.family === 'data_rights' && input.expressionKind === 'service')
      || (input.basis === 'unprotected_fact' && input.expressionKind !== 'fact')
      || (input.expectedAssessment !== null && !/^[0-9a-f-]{36}$/.test(input.expectedAssessment))) {
      throw new RightsInvalid('rights assessment does not match its profile');
    }
    const request = sha256(JSON.stringify({ ...input, idempotencyKey: undefined }));
    return this.transaction(async client => {
      const prior = (await client.query<{ id: string; request_digest: string }>(`SELECT id, request_digest
        FROM rights.use_assessment WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, input.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== request) throw new RightsConflict('idempotency key reused');
        return { ...await this.read(client, prior.id), replayed: true };
      }
      await client.query(`INSERT INTO rights.material (id, scope_kind, provider, namespace, source_record_id,
          content_variant_id, media_asset, work_id, component, expression_kind, wiki_evidence_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT DO NOTHING`,
      [randomUUID(), input.material.scopeKind, input.material.provider, input.material.namespace,
        input.material.sourceRecordId, input.material.contentVariantId, input.material.mediaAsset,
        input.material.workId ?? null, input.material.component, input.expressionKind, input.material.wikiEvidenceId ?? null]);
      const material = await this.findMaterial(client, input.material);
      if (!material) throw new RightsStale('material identity is unavailable');
      if (material.expression_kind !== input.expressionKind) {
        throw new RightsStale('material expression kind is already recorded differently');
      }
      const head = (await client.query<{ assessment_id: string; revision: string }>(`SELECT assessment_id,
          revision::text FROM rights.use_assessment_head WHERE material_id = $1 AND family = $2 AND use_kind = $3
          AND use_scope = $4 FOR UPDATE`, [material.id, input.family, input.useKind, input.useScope])).rows[0];
      if ((head?.assessment_id ?? null) !== input.expectedAssessment) throw new RightsStale('assessment head changed');
      const id = randomUUID();
      await client.query(`INSERT INTO rights.use_assessment (id, material_id, family, use_kind, use_scope, basis,
          outcome, license_instrument, exception_kind, rationale, extent, evidence, predecessor_id, principal_id,
          idempotency_key, request_digest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, material.id, input.family, input.useKind, input.useScope, input.basis, input.outcome,
        input.licenseInstrument, input.exceptionKind, input.rationale, input.extent, input.evidence,
        head?.assessment_id ?? null, principalId, input.idempotencyKey, request]);
      for (const [index, obligation] of input.obligations.entries()) {
        await client.query(`INSERT INTO rights.obligation (assessment_id, ordinal, kind, instrument, applies_to, notice)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, index + 1, obligation.kind, obligation.instrument, obligation.appliesTo, obligation.notice]);
      }
      if (head) {
        await client.query(`UPDATE rights.use_assessment_head SET assessment_id = $5, revision = revision + 1
          WHERE material_id = $1 AND family = $2 AND use_kind = $3 AND use_scope = $4`,
        [material.id, input.family, input.useKind, input.useScope, id]);
      } else {
        await client.query(`INSERT INTO rights.use_assessment_head (material_id, family, use_kind, use_scope,
          assessment_id, revision) VALUES ($1, $2, $3, $4, $5, 1)`,
        [material.id, input.family, input.useKind, input.useScope, id]);
      }
      return { ...await this.read(client, id), replayed: false };
    }, commit);
  }

  private async read(client: PoolClient, assessmentId: string): Promise<Assessment> {
    const row = (await client.query<{ id: string; material_id: string; family: UseKey['family'];
      use_kind: UseKey['useKind']; use_scope: string; basis: string; outcome: string; license_instrument: string | null;
      exception_kind: string | null; rationale: string | null; extent: Record<string, unknown>;
      predecessor_id: string | null; expression_kind: string; revision: string | null }>(`SELECT a.id, a.material_id,
        a.family, a.use_kind, a.use_scope, a.basis, a.outcome, a.license_instrument, a.exception_kind, a.rationale,
        a.extent, a.predecessor_id, m.expression_kind,
        (SELECT h.revision::text FROM rights.use_assessment_head h WHERE h.assessment_id = a.id) AS revision
      FROM rights.use_assessment a JOIN rights.material m ON m.id = a.material_id WHERE a.id = $1`,
    [assessmentId])).rows[0]!;
    const obligations = (await client.query<{ kind: string; instrument: string; applies_to: string;
      notice: string | null }>(`SELECT kind, instrument, applies_to, notice FROM rights.obligation
      WHERE assessment_id = $1 ORDER BY ordinal`, [assessmentId])).rows;
    return { assessmentId: row.id, materialId: row.material_id, family: row.family, useKind: row.use_kind,
      useScope: row.use_scope, expressionKind: row.expression_kind, basis: row.basis, outcome: row.outcome,
      licenseInstrument: row.license_instrument, exceptionKind: row.exception_kind, rationale: row.rationale,
      extent: row.extent, predecessor: row.predecessor_id, revision: row.revision,
      obligations: obligations.map(item => ({ kind: item.kind, instrument: item.instrument,
        appliesTo: item.applies_to, notice: item.notice })) };
  }

  /**
   * Current basis for one exact use. An unassessed use stays unassessed: no
   * other use's conclusion, license label or company status is substituted.
   */
  async evaluate(principal: VerifiedPrincipal, actingSubject: string, material: MaterialScope,
    use: UseKey): Promise<UseEvaluation> {
    if (!validMaterial(material) || !scopePattern.test(use.useScope)
      || !(useKinds as readonly string[]).includes(use.useKind)
      || !(assessmentFamilies as readonly string[]).includes(use.family)) {
      throw new RightsInvalid('use evaluation does not match its profile');
    }
    await this.assessor(principal, actingSubject);
    return this.transaction(async client => {
      const found = await this.findMaterial(client, material);
      if (!found) return { status: 'unassessed', materialId: null };
      const head = (await client.query<{ assessment_id: string }>(`SELECT assessment_id FROM rights.use_assessment_head
        WHERE material_id = $1 AND family = $2 AND use_kind = $3 AND use_scope = $4`,
      [found.id, use.family, use.useKind, use.useScope])).rows[0];
      if (!head) return { status: 'unassessed', materialId: found.id };
      return { status: 'assessed', assessment: await this.read(client, head.assessment_id) };
    });
  }

  /** Internal Media composition, called only after its disclosure gate. Database
   * terms and another use's assessment cannot authorize artwork delivery. */
  async currentMediaDelivery(material: MaterialScope): Promise<UseEvaluation> {
    if (!validMaterial(material)) throw new RightsInvalid('invalid media material');
    return this.transaction(async client => {
      const found = await this.findMaterial(client, material);
      if (!found) return { status: 'unassessed', materialId: null };
      const head = (await client.query<{ assessment_id: string }>(`SELECT assessment_id
        FROM rights.use_assessment_head WHERE material_id=$1 AND family='data_rights'
          AND use_kind='media_delivery' AND use_scope='rezics:public-media'`, [found.id])).rows[0];
      return head ? { status: 'assessed', assessment: await this.read(client, head.assessment_id) }
        : { status: 'unassessed', materialId: found.id };
    });
  }

  /**
   * Current wiki-display obligations for a page of materials. One Content
   * statement for the whole batch, then one Access statement for disclosure
   * fences on heads that exist. No graph call. A hidden head returns the
   * unassessed shape and does not carry the instrument or notice.
   */
  async currentWikiDisplayObligations(materials: readonly MaterialScope[]): Promise<WikiDisplayObligations[]> {
    if (materials.length > 64 || materials.some(material => !validMaterial(material))) {
      throw new RightsInvalid('wiki display obligation batch is invalid');
    }
    if (!materials.length) return [];
    const ordinals = materials.map((_, index) => index + 1);
    let rows: Array<{ ordinal: number; assessment_id: string | null; material_id: string | null; license_instrument: string | null;
      obligations: Array<{ kind: string; instrument: string; applies_to: string; notice: string | null }> | null }>;
    try {
      rows = (await contentConnection(this.content).query<{ ordinal: number; assessment_id: string | null; material_id: string | null;
        license_instrument: string | null;
        obligations: Array<{ kind: string; instrument: string; applies_to: string; notice: string | null }> | null
      }>(`WITH requested AS ( -- wiki-display obligations
          SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::uuid[],
            $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]) AS r(ordinal, scope_kind, provider,
              namespace, source_record_id, content_variant_id, media_asset, work_id, wiki_evidence_id, component)
        )
        SELECT r.ordinal, a.id AS assessment_id, m.id AS material_id, a.license_instrument,
          COALESCE(o.items, '[]'::jsonb) AS obligations
        FROM requested r
        LEFT JOIN LATERAL (SELECT m.id FROM rights.material m
          WHERE m.scope_kind = r.scope_kind AND m.provider IS NOT DISTINCT FROM r.provider
            AND m.namespace IS NOT DISTINCT FROM r.namespace
            AND m.source_record_id IS NOT DISTINCT FROM r.source_record_id
            AND m.content_variant_id IS NOT DISTINCT FROM r.content_variant_id
            AND m.media_asset IS NOT DISTINCT FROM r.media_asset
            AND m.work_id IS NOT DISTINCT FROM r.work_id
            AND m.wiki_evidence_id IS NOT DISTINCT FROM r.wiki_evidence_id
            AND m.component = r.component
          LIMIT 1) m ON true
        LEFT JOIN rights.use_assessment_head h ON h.material_id = m.id AND h.family = 'data_rights'
          AND h.use_kind = 'wiki_display' AND h.use_scope = $11
        LEFT JOIN rights.use_assessment a ON a.id = h.assessment_id
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('kind', b.kind, 'instrument', b.instrument,
          'applies_to', b.applies_to, 'notice', b.notice) ORDER BY b.ordinal) AS items
          FROM rights.obligation b WHERE b.assessment_id = a.id
            AND b.applies_to IN ('display', 'all')) o ON true`, [
        ordinals, materials.map(item => item.scopeKind), materials.map(item => item.provider),
        materials.map(item => item.namespace), materials.map(item => item.sourceRecordId),
        materials.map(item => item.contentVariantId), materials.map(item => item.mediaAsset),
        materials.map(item => item.workId ?? null), materials.map(item => item.wikiEvidenceId ?? null),
        materials.map(item => item.component), WIKI_DISPLAY_USE.useScope,
      ])).rows;
    } catch { throw new RightsUnavailable('wiki display obligations are unavailable'); }
    const byOrdinal = new Map(rows.map(row => [Number(row.ordinal), row]));
    const disclosed = materials.flatMap((material, index) => byOrdinal.get(index + 1)?.assessment_id && material.workId
      ? [{ ordinal: index + 1, resource: material.workId, component: material.component }] : []);
    let hidden = new Set<number>();
    if (disclosed.length) {
      try {
        const fences = await this.access.query<{ ordinal: number }>(`WITH requested AS ( -- wiki-display disclosure
            SELECT * FROM unnest($1::int[], $2::text[], $3::text[]) AS r(ordinal, resource, component)
          )
          SELECT r.ordinal FROM requested r
          WHERE EXISTS (SELECT 1 FROM access.governance_enforcement e
            WHERE e.state = 'restricted' AND e.effect = 'disclosure'
              AND (e.resource = r.resource OR e.resource = right(r.resource, 36))
              AND (e.component = r.component OR e.component IN ('record', 'publication')))`, [
          disclosed.map(item => item.ordinal), disclosed.map(item => item.resource),
          disclosed.map(item => item.component),
        ]);
        hidden = new Set(fences.rows.map(row => Number(row.ordinal)));
      } catch { throw new RightsUnavailable('wiki display obligations are unavailable'); }
    }
    return materials.map((material, index) => {
      const row = byOrdinal.get(index + 1);
      const obligations = Array.isArray(row?.obligations) ? row.obligations
        : typeof row?.obligations === 'string' ? JSON.parse(row.obligations) as typeof row.obligations : [];
      return projectWikiDisplay(row ? { assessmentId: row.assessment_id, licenseInstrument: row.license_instrument,
        ...(row.material_id ? { materialId: row.material_id, component: material.component,
          sourceRecordId: material.sourceRecordId, wikiEvidenceId: material.wikiEvidenceId ?? null } : {}),
        obligations: (obligations ?? []).map(item => ({ kind: item.kind, instrument: item.instrument,
          appliesTo: item.applies_to, notice: item.notice })) } : undefined, hidden.has(index + 1));
    });
  }

  /**
   * Export hook for one exact use. Owner readers attach an exact material key
   * and target; this owner resolves the key to its immutable material row.
   */
  readonly exportScope: LicenseScopeHook = async (members, useScope) => {
    const identities = members.map(exportRightsIdentity);
    const malformed = identities.flatMap((identity, index) => identity === false ? [index] : []);
    const valid = identities.flatMap((identity, index) => identity !== null && identity !== false
      ? [{ ordinal: index + 1, identity }] : []);
    const enforceable = valid.filter(item => item.identity.target !== null);
    const scope = rightsExportUseScope(useScope);
    const useKind = useScope === 'excerpt' || useScope === 'quotation' ? 'quotation' : 'export';
    const [materialRows, restrictionRows] = await Promise.all([
      valid.length ? contentConnection(this.content).query<{ ordinal: number; id: string; expression_kind: string;
        assessment_id: string | null; basis: string | null; outcome: string | null;
        license_instrument: string | null; exception_kind: string | null; rationale: string | null;
        extent: Record<string, unknown> | null; obligations: Array<{ kind: string; instrument: string;
          applies_to: string; notice: string | null }> }>(`WITH requested AS (
          SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::uuid[],
            $6::text[], $7::text[], $8::text[], $11::text[], $12::text[]) AS r(ordinal, scope_kind, provider,
              namespace, source_record_id, content_variant_id, media_asset, component, wiki_evidence_id, work_id)
        )
        SELECT r.ordinal, m.id, m.expression_kind, a.id AS assessment_id, a.basis, a.outcome,
          a.license_instrument, a.exception_kind, a.rationale, a.extent,
          COALESCE(o.items, '[]'::jsonb) AS obligations
        FROM requested r JOIN LATERAL (SELECT m.id, m.expression_kind FROM rights.material m
          WHERE m.scope_kind = r.scope_kind AND m.provider IS NOT DISTINCT FROM r.provider
            AND m.namespace IS NOT DISTINCT FROM r.namespace
            AND m.source_record_id IS NOT DISTINCT FROM r.source_record_id
            AND m.content_variant_id IS NOT DISTINCT FROM r.content_variant_id
            AND m.media_asset IS NOT DISTINCT FROM r.media_asset AND m.component = r.component
            AND m.wiki_evidence_id IS NOT DISTINCT FROM r.wiki_evidence_id
            AND m.work_id IS NOT DISTINCT FROM r.work_id
          LIMIT 1) m ON true
        LEFT JOIN rights.use_assessment_head h ON h.material_id = m.id AND h.family = 'data_rights'
          AND h.use_kind = $9 AND h.use_scope = $10
        LEFT JOIN rights.use_assessment a ON a.id = h.assessment_id
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('kind', b.kind, 'instrument', b.instrument,
          'applies_to', b.applies_to, 'notice', b.notice) ORDER BY b.ordinal) AS items
          FROM rights.obligation b WHERE b.assessment_id = a.id
            AND b.applies_to IN ('export', 'redistribution', 'all')) o ON true`, [
        valid.map(item => item.ordinal), valid.map(item => item.identity.material.scopeKind),
        valid.map(item => item.identity.material.provider), valid.map(item => item.identity.material.namespace),
        valid.map(item => item.identity.material.sourceRecordId), valid.map(item => item.identity.material.contentVariantId),
        valid.map(item => item.identity.material.mediaAsset), valid.map(item => item.identity.material.component),
        useKind, scope, valid.map(item => item.identity.material.wikiEvidenceId ?? null),
        valid.map(item => item.identity.material.workId ?? null),
      ]) : Promise.resolve({ rows: [] }),
      enforceable.length ? this.access.query<{ ordinal: number; decision_id: string | null }>(`WITH requested AS (
          SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[]) AS r(
            ordinal, owner, resource, component, revision)
        )
        SELECT r.ordinal, e.decision_id FROM requested r
        LEFT JOIN LATERAL (SELECT decision_id FROM access.governance_enforcement e
          WHERE e.owner = r.owner AND (e.resource = r.resource OR e.resource = right(r.resource, 36))
            AND (e.component = r.component OR e.component IN ('record', 'publication')
              OR r.component = 'record')
            AND e.effect IN ('export', 'disclosure') AND e.state = 'restricted'
            AND (e.revision IS NULL OR r.revision IS NULL OR e.revision = r.revision)
          ORDER BY e.fence_epoch DESC, e.id LIMIT 1) e ON true`, [
        enforceable.map(item => item.ordinal), enforceable.map(item => item.identity.target!.owner),
        enforceable.map(item => item.identity.target!.resource), enforceable.map(item => item.identity.target!.component),
        enforceable.map(item => item.identity.target!.revision),
      ]) : Promise.resolve({ rows: [] }),
    ]).catch(() => { throw new RightsUnavailable('rights export basis is unavailable'); });
    const byOrdinal = new Map(materialRows.rows.map(row => [row.ordinal, row]));
    const restrictions = new Map(restrictionRows.rows.filter(row => row.decision_id)
      .map(row => [row.ordinal, row.decision_id!]));
    const bases: ExportBasis[] = members.map((_member, index) => {
      const ordinal = index + 1;
      if (malformed.includes(index)) return { ...unassessedExportBasis(useScope, ordinal),
        result: 'prohibited' as const, obligations: ['access_restriction' as const],
        notice: 'The selected member has an invalid rights identity.' };
      const identity = identities[index];
      const row = byOrdinal.get(ordinal);
      const decision = restrictions.get(ordinal);
      if (decision) {
        return { ...(row?.assessment_id ? {
          basisKind: 'use_assessment' as const, basisRef: row.assessment_id,
        } : unassessedExportBasis(useScope, ordinal)),
        licenseExpression: null, notice: `Export restricted by decision ${decision}.`,
        obligations: ['access_restriction' as const], useScope, result: 'prohibited' as const,
        memberOrdinals: [ordinal] };
      }
      if (!identity || !row || !row.assessment_id || !row.basis || !row.outcome) {
        return { ...unassessedExportBasis(useScope, ordinal) };
      }
      const supportedObligations: Record<string, typeof exportSupportedObligationKinds[keyof typeof exportSupportedObligationKinds]>
        = exportSupportedObligationKinds;
      const obligations = row.obligations.map(item => supportedObligations[item.kind]);
      const notices = row.obligations.map(item => item.notice).filter((item): item is string => item !== null);
      const rationale = row.basis === 'statutory_exception'
        ? JSON.stringify({ rationale: row.rationale, extent: row.extent }) : null;
      const unsupportedCondition = obligations.some(item => !item) || obligations.length > 6
        || (rationale !== null && Buffer.byteLength(rationale) > 4000)
        || (row.expression_kind !== 'fact' && row.basis === 'unprotected_fact');
      const mappedBasis = row.basis === 'original_contribution' ? 'native_contribution'
        : row.basis === 'public_domain' ? 'public_domain'
          : row.basis === 'unprotected_fact' ? 'unprotected_fact'
            : row.basis === 'statutory_exception' ? 'statutory_exception' : 'use_assessment';
      const result: ExportBasis['result'] = unsupportedCondition ? 'undetermined'
        : row.outcome === 'not_supported' ? 'prohibited' : row.outcome as ExportBasis['result'];
      return { basisKind: mappedBasis, basisRef: row.assessment_id,
        licenseExpression: row.basis === 'license' ? row.license_instrument : null,
        notice: rationale ?? (notices.length ? JSON.stringify(notices) : null),
        obligations: unsupportedCondition ? [] : obligations as Array<'attribution' | 'share_alike'
          | 'non_commercial' | 'no_derivatives' | 'notice_retention' | 'change_indication'>,
        useScope, result, memberOrdinals: [ordinal] };
    });
    return bases;
  };

  /** Only an explicit current provider non-retention decision blocks raw capture. */
  async rawRetentionPermitted(provider: string, namespace: string): Promise<boolean> {
    const result = await contentConnection(this.content).query<{ outcome: string }>(`SELECT a.outcome FROM rights.material m
      JOIN rights.use_assessment_head h ON h.material_id = m.id AND h.family = 'service_terms'
        AND h.use_kind = 'raw_retention' AND h.use_scope = $3
      JOIN rights.use_assessment a ON a.id = h.assessment_id
      WHERE m.scope_kind = 'source_provider' AND m.provider = $1 AND m.namespace = $2
        AND m.component = 'response' LIMIT 2`, [provider, namespace, sourceRetentionScope(provider, namespace)]);
    if (result.rows.length > 1) throw new RightsUnavailable('provider retention assessment is ambiguous');
    return result.rows[0]?.outcome !== 'not_supported';
  }
}
