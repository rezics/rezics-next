import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { ExportBasis, LicenseScopeHook, VerifiedExportMember } from '../export/planner.ts';
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

const unassessedBasis = (useScope: Parameters<LicenseScopeHook>[1], memberOrdinal: number) => ({
  basisKind: 'unprotected_fact' as const, basisRef: null, licenseExpression: null, notice: null,
  obligations: [] as Array<'attribution' | 'share_alike' | 'non_commercial' | 'no_derivatives'
    | 'notice_retention' | 'access_restriction'>,
  useScope, result: 'undetermined' as const, memberOrdinals: [memberOrdinal],
});

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

/**
 * Content-database rights basis owner. Assessments are immutable per exact
 * material, family, use and use scope; a changed use is a different key and
 * never inherits an earlier conclusion. Authority comes from an Access grant
 * checked before the Content transaction.
 */
export class RightsStore {
  constructor(private readonly content: Pool, private readonly access: Pool) {}

  /** One indexed current-head lookup. Historical or withdrawn assessments are never a public basis. */
  async currentPublicDomainAssessment(work: string, assessmentId: string): Promise<boolean> {
    if (!agentPattern.test(work) || !/^[0-9a-f-]{36}$/i.test(assessmentId)) {
      throw new RightsInvalid('invalid public-domain assessment reference');
    }
    try {
      const result = await this.content.query(`SELECT 1 FROM rights.use_assessment a
        JOIN rights.use_assessment_head h ON h.assessment_id = a.id
        JOIN rights.material m ON m.id = a.material_id
        WHERE a.id = $1 AND m.scope_kind = 'work' AND m.work_id = $2
          AND m.component = 'body' AND m.expression_kind = 'expression'
          AND a.family = 'data_rights' AND a.use_kind = 'redistribution'
          AND a.use_scope = 'rezics:public-text' AND a.basis = 'public_domain'
          AND a.outcome = 'supported' LIMIT 1`, [assessmentId, work]);
      return result.rowCount === 1;
    } catch { throw new RightsUnavailable('current public-domain assessment is unavailable'); }
  }

  /** At most 512 phrase hits share one indexed rights probe, O(hits) input and result. */
  async currentPublicDomainAssessments(refs: readonly { work: string; assessmentId: string }[]): Promise<Set<string>> {
    if (refs.length > 512 || refs.some(ref => !agentPattern.test(ref.work)
      || !/^[0-9a-f-]{36}$/i.test(ref.assessmentId))) {
      throw new RightsInvalid('invalid public-domain search rights batch');
    }
    if (!refs.length) return new Set();
    try {
      const result = await this.content.query<{ work_id: string; id: string }>(`SELECT m.work_id, a.id
        FROM unnest($1::text[], $2::uuid[]) AS requested(work_id, assessment_id)
        JOIN rights.use_assessment a ON a.id = requested.assessment_id
        JOIN rights.use_assessment_head h ON h.assessment_id = a.id
        JOIN rights.material m ON m.id = a.material_id AND m.work_id = requested.work_id
        WHERE m.scope_kind = 'work' AND m.component = 'body' AND m.expression_kind = 'expression'
          AND a.family = 'data_rights' AND a.use_kind = 'redistribution'
          AND a.use_scope = 'rezics:public-text' AND a.basis = 'public_domain'
          AND a.outcome = 'supported'`, [refs.map(ref => ref.work), refs.map(ref => ref.assessmentId)]);
      return new Set(result.rows.map(row => `${row.work_id}\0${row.id}`));
    } catch { throw new RightsUnavailable('current public-domain search rights are unavailable'); }
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
    if (!agentPattern.test(work) || value.length < 1 || value.length > 8000) {
      throw new RightsInvalid('invalid native synopsis fence target');
    }
    const valueDigest = sha256(JSON.stringify(value));
    let rows: Array<{ record: string; observation: string }>;
    try {
      rows = (await this.content.query<{ record: string; observation: string }>(`
        SELECT DISTINCT 'https://rezics.com/id/' || s.record_id AS record,
          'https://rezics.com/id/' || c.observation_id AS observation
        FROM source.field_support s
        JOIN source.field_support_step st ON st.support_id = s.id
        LEFT JOIN source.field_support_outcome out ON out.step_id = st.id
        JOIN source.conversion c ON c.id = st.conversion_id
        WHERE s.target = $1 AND s.slot = 'work-editorial-field-v1#synopsis'
          AND s.context = 'global' AND st.value_digest = $2
          AND (out.outcome = 'applied' OR out.step_id IS NULL)
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
    const row = (await this.access.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject a ON a.id = r.subject_id
      JOIN access.permission_grant g ON g.recipient_subject = r.subject_id
      JOIN access.scope_gate s ON s.id = g.scope_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND r.subject_id = $3 AND r.active
        AND r.valid_until > clock_timestamp() AND a.active AND g.scope_id = $4 AND g.action = $5 AND g.active
        AND g.valid_until > clock_timestamp() AND s.open AND s.dispatch_open
        AND (SELECT open FROM access.recovery_fence WHERE id = true)
      LIMIT 1`, [principal.issuer, principal.subject, actingSubject, ASSESS_SCOPE, ASSESS_ACTION]).catch(() => {
      throw new RightsUnavailable('Access is unavailable');
    })).rows[0];
    if (!row) throw new RightsDenied('rights assessment authority is missing');
    return row.id;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.content.connect().catch(() => { throw new RightsUnavailable('rights owner is unavailable'); });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw normalize(error);
    } finally { client.release(); }
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
    const principalId = await this.assessor(principal, input.actingSubject);
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
    });
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
      valid.length ? this.content.query<{ ordinal: number; id: string; expression_kind: string;
        assessment_id: string | null; basis: string | null; outcome: string | null;
        license_instrument: string | null; exception_kind: string | null; rationale: string | null;
        extent: Record<string, unknown> | null; obligations: Array<{ kind: string; instrument: string;
          applies_to: string; notice: string | null }> }>(`WITH requested AS (
          SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::uuid[],
            $6::text[], $7::text[], $8::text[], $11::text[]) AS r(ordinal, scope_kind, provider,
              namespace, source_record_id, content_variant_id, media_asset, component, wiki_evidence_id)
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
      ]) : Promise.resolve({ rows: [] }),
      enforceable.length ? this.access.query<{ ordinal: number; decision_id: string | null }>(`WITH requested AS (
          SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[]) AS r(
            ordinal, owner, resource, component, revision)
        )
        SELECT r.ordinal, e.decision_id FROM requested r
        LEFT JOIN LATERAL (SELECT decision_id FROM access.governance_enforcement e
          WHERE e.owner = r.owner AND e.resource = r.resource AND e.component = r.component
            AND e.effect = 'export' AND e.state = 'restricted'
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
      if (malformed.includes(index)) return { ...unassessedBasis(useScope, ordinal),
        result: 'prohibited' as const, obligations: ['access_restriction' as const],
        notice: 'The selected member has an invalid rights identity.' };
      const identity = identities[index];
      const row = byOrdinal.get(ordinal);
      const decision = restrictions.get(ordinal);
      if (decision) {
        return { ...(row?.assessment_id ? {
          basisKind: 'use_assessment' as const, basisRef: row.assessment_id,
        } : unassessedBasis(useScope, ordinal)),
        licenseExpression: null, notice: `Export restricted by decision ${decision}.`,
        obligations: ['access_restriction' as const], useScope, result: 'prohibited' as const,
        memberOrdinals: [ordinal] };
      }
      if (!identity || !row || !row.assessment_id || !row.basis || !row.outcome) {
        return { ...unassessedBasis(useScope, ordinal) };
      }
      const supportedObligations: Record<string, 'attribution' | 'share_alike' | 'non_commercial'
        | 'no_derivatives' | 'notice_retention'> = {
        attribution: 'attribution', share_alike: 'share_alike', non_commercial: 'non_commercial',
        no_derivatives: 'no_derivatives', notice_retention: 'notice_retention',
      };
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
          | 'non_commercial' | 'no_derivatives' | 'notice_retention'>,
        useScope, result, memberOrdinals: [ordinal] };
    });
    return bases;
  };

  /** Only an explicit current provider non-retention decision blocks raw capture. */
  async rawRetentionPermitted(provider: string, namespace: string): Promise<boolean> {
    const result = await this.content.query<{ outcome: string }>(`SELECT a.outcome FROM rights.material m
      JOIN rights.use_assessment_head h ON h.material_id = m.id AND h.family = 'service_terms'
        AND h.use_kind = 'raw_retention' AND h.use_scope = $3
      JOIN rights.use_assessment a ON a.id = h.assessment_id
      WHERE m.scope_kind = 'source_provider' AND m.provider = $1 AND m.namespace = $2
        AND m.component = 'response' LIMIT 2`, [provider, namespace, sourceRetentionScope(provider, namespace)]);
    if (result.rows.length > 1) throw new RightsUnavailable('provider retention assessment is ambiguous');
    return result.rows[0]?.outcome !== 'not_supported';
  }
}
