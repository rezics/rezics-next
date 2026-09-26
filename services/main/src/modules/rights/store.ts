import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
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
  contentVariantId: string | null; mediaAsset: string | null; component: string;
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
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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
  return (materialScopes as readonly string[]).includes(material.scopeKind) && componentPattern.test(material.component);
}

/**
 * Content-database rights basis owner. Assessments are immutable per exact
 * material, family, use and use scope; a changed use is a different key and
 * never inherits an earlier conclusion. Authority comes from an Access grant
 * checked before the Content transaction.
 */
export class RightsStore {
  constructor(private readonly content: Pool, private readonly access: Pool) {}

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
        AND content_variant_id IS NOT DISTINCT FROM $5 AND media_asset IS NOT DISTINCT FROM $6 AND component = $7`,
    [material.scopeKind, material.provider, material.namespace, material.sourceRecordId, material.contentVariantId,
      material.mediaAsset, material.component])).rows[0];
  }

  async assess(principal: VerifiedPrincipal, input: AssessmentInput): Promise<Assessment & { replayed: boolean }> {
    if (!agentPattern.test(input.actingSubject) || !validMaterial(input.material) || !scopePattern.test(input.useScope)
      || !keyPattern.test(input.idempotencyKey) || input.obligations.length > 16
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
          content_variant_id, media_asset, component, expression_kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING`,
      [randomUUID(), input.material.scopeKind, input.material.provider, input.material.namespace,
        input.material.sourceRecordId, input.material.contentVariantId, input.material.mediaAsset,
        input.material.component, input.expressionKind]);
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
}
