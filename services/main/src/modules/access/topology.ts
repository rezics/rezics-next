import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { ControlDenied, ControlInvalid, ControlStale, type ControlReceipt, WORK_SCOPE,
  agentPattern, controlTransaction, generationPattern, idPattern, lockGate, receipted,
  requireAgent, requireCeiling, requireMandate, requirePrincipal, requireReceipt }
  from './topology-control.ts';
import { MAX_PATH_EDGES, TOPOLOGY_SCOPE } from './topology-schema.ts';

const MANAGE = 'access.representation.manage';
const actionPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const commandPattern = /^[a-z][a-z0-9.+-]{0,127}$/;
export const MAX_OBLIGATIONS = 8;
const ADMISSION_LIFETIME_MS = 5 * 60_000;

export type EdgeChange =
  | { action: 'create'; edgeId: string; representativeSubject: string;
    representedSubject: string; edgeAction: string; maxPathEdges: number; validUntil: Date;
    expectedTopologyEpoch: string }
  | { action: 'revoke'; edgeId: string; representedSubject: string;
    expectedObjectGeneration: string; expectedTopologyEpoch: string };
export interface EdgeChangeResult extends Record<string, unknown> {
  edgeId: string; action: 'create' | 'revoke'; generation: string; topologyEpoch: string;
}
export interface EdgeView {
  edgeId: string; representativeSubject: string; representedSubject: string; edgeAction: string;
  maxPathEdges: number; validUntil: string; active: boolean; generation: string;
  topologyEpoch: string;
}
export interface ObligationInput {
  obligation: string; representationId: string; edgeIds: string[]; grantId: string;
}
export interface AdmissionInput {
  admissionId: string; actingSubject: string; command: string; obligations: ObligationInput[];
}
export interface AdmittedObligation {
  obligation: string; pathId: string; edgeCount: number; grantId: string; grantGeneration: string;
}
export interface AdmissionResult extends Record<string, unknown> {
  admissionId: string; actingSubject: string; command: string; authorityEpoch: string;
  expiresAt: string; obligations: AdmittedObligation[];
}

interface SelectedPath {
  mandateId: string; mandateGeneration: string; origin: string; validUntil: Date;
  edges: { id: string; generation: string; from: string; to: string }[];
}

/** Agent-to-Agent representation topology and its bounded use. Edges change
 * only under the topology gate CAS; a use pins one complete path per obligation. */
export class AccessTopology {
  constructor(private readonly pool: Pool) {}

  async changeEdge(principal: VerifiedPrincipal, receipt: ControlReceipt,
    change: EdgeChange): Promise<EdgeChangeResult & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(change.edgeId) || !agentPattern.test(change.representedSubject)
      || !generationPattern.test(change.expectedTopologyEpoch)
      || change.action === 'create' && (!agentPattern.test(change.representativeSubject)
        || !actionPattern.test(change.edgeAction) || !Number.isInteger(change.maxPathEdges)
        || change.maxPathEdges < 1 || change.maxPathEdges > MAX_PATH_EDGES
        || Number.isNaN(change.validUntil.getTime()))
      || change.action === 'revoke' && !generationPattern.test(change.expectedObjectGeneration)) {
      throw new ControlInvalid('invalid representation edge change');
    }
    return controlTransaction(this.pool, async client => {
      const epoch = await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      const mandate = await requireMandate(client, actor.id, change.representedSubject, MANAGE);
      return receipted<EdgeChangeResult>(client, actor.id, receipt, 'representation-edge',
        change.action, change.representedSubject, change.edgeId, async () => {
          if (epoch !== change.expectedTopologyEpoch) {
            throw new ControlStale('representation topology epoch changed');
          }
          let generation = '0';
          if (change.action === 'create') {
            if (change.validUntil.getTime() <= Date.now()) {
              throw new ControlInvalid('edge validity ended');
            }
            await requireAgent(client, change.representativeSubject);
            // Representation beyond the represented Agent's assignment ceiling is
            // an unapproved expansion and never becomes an edge.
            const ceiling = await requireCeiling(client, change.representedSubject,
              `access.representation.assign.${change.edgeAction}`, change.validUntil);
            await client.query(`INSERT INTO access.representation_edge (id,
              representative_subject, represented_subject, action, max_path_edges, valid_until,
              assigned_by_principal, issuer_representation_id, issuer_representation_generation,
              issuer_representation_action, ceiling_grant_id, ceiling_grant_generation,
              ceiling_scope_id, ceiling_action)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [change.edgeId, change.representativeSubject, change.representedSubject,
              change.edgeAction, change.maxPathEdges, change.validUntil, actor.id, mandate.id,
              mandate.generation, MANAGE, ceiling.id, ceiling.generation, WORK_SCOPE,
              `access.representation.assign.${change.edgeAction}`]);
          } else {
            const edge = await client.query<{ active: boolean; generation: string }>(`SELECT
              active, generation FROM access.representation_edge
              WHERE id = $1 AND represented_subject = $2 FOR UPDATE`,
            [change.edgeId, change.representedSubject]);
            if (!edge.rows[0]) throw new ControlDenied('edge is unavailable to this subject');
            if (edge.rows[0].generation !== change.expectedObjectGeneration) {
              throw new ControlStale('edge generation changed');
            }
            if (!edge.rows[0].active) throw new ControlDenied('edge is already revoked');
            const revoked = await client.query<{ generation: string }>(`UPDATE
              access.representation_edge SET active = false WHERE id = $1 RETURNING generation`,
            [change.edgeId]);
            generation = revoked.rows[0]!.generation;
          }
          const topologyEpoch = await lockGate(client, TOPOLOGY_SCOPE, true);
          return { epoch: topologyEpoch, result: { edgeId: change.edgeId,
            action: change.action, generation, topologyEpoch } };
        });
    });
  }

  async readEdge(principal: VerifiedPrincipal, edgeId: string,
    representedSubject: string): Promise<EdgeView> {
    if (!idPattern.test(edgeId) || !agentPattern.test(representedSubject)) {
      throw new ControlInvalid('invalid edge read');
    }
    return controlTransaction(this.pool, async client => {
      const topologyEpoch = await lockGate(client, TOPOLOGY_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, representedSubject, MANAGE);
      const row = await client.query<{ representative_subject: string; action: string;
        max_path_edges: number; valid_until: Date; active: boolean; generation: string }>(`
        SELECT representative_subject, action, max_path_edges, valid_until, active, generation
        FROM access.representation_edge WHERE id = $1 AND represented_subject = $2`,
      [edgeId, representedSubject]);
      const edge = row.rows[0];
      if (!edge) throw new ControlDenied('edge is unavailable to this subject');
      return { edgeId, representativeSubject: edge.representative_subject, representedSubject,
        edgeAction: edge.action, maxPathEdges: edge.max_path_edges,
        validUntil: edge.valid_until.toISOString(), active: edge.active,
        generation: edge.generation, topologyEpoch };
    });
  }

  /** The complete path from the caller's own mandate to the acting subject. */
  private async selectPath(client: PoolClient, principalId: string, actingSubject: string,
    action: string, representationId: string, edgeIds: string[]): Promise<SelectedPath> {
    const mandate = await client.query<{ generation: string; subject_id: string;
      valid_until: Date; max_path_edges: number }>(`SELECT r.generation, r.subject_id,
      r.valid_until, r.max_path_edges FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE r.id = $1 AND r.principal_id = $2 AND r.action = $3 AND r.active
        AND r.valid_until > clock_timestamp() AND s.active FOR SHARE OF r, s`,
    [representationId, principalId, action]);
    const first = mandate.rows[0];
    if (!first) throw new ControlDenied('selected mandate does not cover this obligation');
    if (edgeIds.length > 0 && edgeIds.length > first.max_path_edges) {
      throw new ControlDenied('path exceeds the mandate composition limit');
    }
    const rows = await client.query<{ id: string; generation: string; representative_subject: string;
      represented_subject: string; max_path_edges: number; valid_until: Date }>(`SELECT e.id,
      e.generation, e.representative_subject, e.represented_subject, e.max_path_edges,
      e.valid_until FROM access.representation_edge e
      JOIN access.authority_subject s ON s.id = e.represented_subject
      JOIN access.permission_grant c ON c.id = e.ceiling_grant_id
      WHERE e.id = ANY($1::uuid[]) AND e.action = $2 AND e.active
        AND e.valid_until > clock_timestamp() AND s.active AND c.active
        AND c.generation = e.ceiling_grant_generation
        AND c.valid_until > clock_timestamp() FOR SHARE OF e, s, c`, [edgeIds, action]);
    const byId = new Map(rows.rows.map(row => [row.id, row]));
    let previous = first.subject_id;
    let validUntil = first.valid_until;
    const edges: SelectedPath['edges'] = [];
    for (const edgeId of edgeIds) {
      const edge = byId.get(edgeId);
      if (!edge || edge.representative_subject !== previous
        || edge.max_path_edges < edgeIds.length) {
        throw new ControlDenied('no admitted bounded representation path');
      }
      edges.push({ id: edge.id, generation: edge.generation, from: previous,
        to: edge.represented_subject });
      previous = edge.represented_subject;
      if (edge.valid_until < validUntil) validUntil = edge.valid_until;
    }
    if (previous !== actingSubject) {
      throw new ControlDenied('no admitted bounded representation path to the acting subject');
    }
    return { mandateId: representationId, mandateGeneration: first.generation,
      origin: first.subject_id, validUntil, edges };
  }

  /** One obligation's grant must belong to the acting subject for exactly that
   * action; a policy-pinned institutional grant also needs a roster mandate. */
  private async obligationGrant(client: PoolClient, actingSubject: string, action: string,
    grantId: string, path: SelectedPath): Promise<{ generation: string; validUntil: Date }> {
    const row = await client.query<{ generation: string; valid_until: Date;
      recipient_subject: string; policy_id: string | null }>(`SELECT g.generation, g.valid_until,
      g.recipient_subject, l.representative_policy_id AS policy_id
      FROM access.permission_grant g LEFT JOIN access.grant_lineage l ON l.grant_id = g.id
      WHERE g.id = $1 AND g.scope_id = $2 AND g.action = $3 AND g.active
        AND g.valid_until > clock_timestamp() FOR SHARE OF g`, [grantId, WORK_SCOPE, action]);
    const grant = row.rows[0];
    if (!grant) throw new ControlDenied('selected grant does not cover this obligation');
    if (grant.recipient_subject !== actingSubject) {
      throw new ControlDenied('a grant held by another subject cannot complete this path');
    }
    if (grant.policy_id) {
      const roster = await client.query(`SELECT 1 FROM access.representation r
        JOIN access.representative_policy p ON p.id = r.representative_policy_id
        JOIN access.representative_policy_revision v
          ON v.policy_id = p.id AND v.revision = p.active_revision
        WHERE r.id = $1 AND p.id = $2 AND r.action = ANY(v.actions)`,
      [path.mandateId, grant.policy_id]);
      if (path.edges.length > 0 || !roster.rows[0]) {
        throw new ControlDenied('institutional grant needs a mandate under its approved policy');
      }
    }
    return { generation: grant.generation, validUntil: grant.valid_until };
  }

  /** Registers one admitted command whose distinct obligations each carry one
   * complete path and grant in the same principal/acting-subject context. */
  async registerAdmission(principal: VerifiedPrincipal, receipt: ControlReceipt,
    input: AdmissionInput): Promise<AdmissionResult & { replayed: boolean }> {
    requireReceipt(receipt);
    const names = new Set(input.obligations.map(item => item.obligation));
    if (!idPattern.test(input.admissionId) || !agentPattern.test(input.actingSubject)
      || !commandPattern.test(input.command) || input.obligations.length < 1
      || input.obligations.length > MAX_OBLIGATIONS || names.size !== input.obligations.length
      || input.obligations.some(item => !actionPattern.test(item.obligation)
        || !idPattern.test(item.representationId) || !idPattern.test(item.grantId)
        || item.edgeIds.length > MAX_PATH_EDGES || item.edgeIds.some(id => !idPattern.test(id)))) {
      throw new ControlInvalid('invalid compound admission');
    }
    return controlTransaction(this.pool, async client => {
      const authorityEpoch = await lockGate(client, WORK_SCOPE, false);
      const topologyEpoch = await lockGate(client, TOPOLOGY_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      return receipted<AdmissionResult>(client, actor.id, receipt, 'representation-path',
        'register-admission', input.actingSubject, input.admissionId, async () => {
          await requireAgent(client, input.actingSubject);
          const selected = [];
          let expiresAt = new Date(Date.now() + ADMISSION_LIFETIME_MS);
          for (const item of input.obligations) {
            const path = await this.selectPath(client, actor.id, input.actingSubject,
              item.obligation, item.representationId, item.edgeIds);
            const grant = await this.obligationGrant(client, input.actingSubject,
              item.obligation, item.grantId, path);
            for (const until of [path.validUntil, grant.validUntil]) {
              if (until < expiresAt) expiresAt = until;
            }
            selected.push({ item, path, grant });
          }
          await client.query(`INSERT INTO access.admission (id, principal_id, acting_subject,
            scope_id, action, idempotency_key, request_digest, authority_epoch, expires_at, state)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'registered')`,
          [input.admissionId, actor.id, input.actingSubject, WORK_SCOPE, input.command,
            receipt.idempotencyKey, receipt.requestDigest, authorityEpoch, expiresAt]);
          const obligations: AdmittedObligation[] = [];
          for (const { item, path, grant } of selected) {
            const pathId = randomUUID();
            await client.query(`INSERT INTO access.representation_path_proof (id, principal_id,
              principal_epoch, representation_id, representation_generation, origin_subject,
              acting_subject, action, edge_count, topology_epoch, valid_until)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [pathId, actor.id, actor.epoch, path.mandateId, path.mandateGeneration, path.origin,
              input.actingSubject, item.obligation, path.edges.length, topologyEpoch,
              path.validUntil]);
            for (const [index, edge] of path.edges.entries()) {
              await client.query(`INSERT INTO access.representation_path_step (path_id,
                position, edge_id, edge_generation, representative_subject, represented_subject,
                action) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [pathId, index + 1, edge.id, edge.generation, edge.from, edge.to, item.obligation]);
            }
            await client.query(`INSERT INTO access.admission_obligation (admission_id, obligation,
              principal_id, acting_subject, scope_id, path_id, source_kind, grant_id,
              grant_generation) VALUES ($1,$2,$3,$4,$5,$6,'grant',$7,$8)`,
            [input.admissionId, item.obligation, actor.id, input.actingSubject, WORK_SCOPE,
              pathId, item.grantId, grant.generation]);
            obligations.push({ obligation: item.obligation, pathId, edgeCount: path.edges.length,
              grantId: item.grantId, grantGeneration: grant.generation });
          }
          return { epoch: authorityEpoch, result: { admissionId: input.admissionId,
            actingSubject: input.actingSubject, command: input.command, authorityEpoch,
            expiresAt: expiresAt.toISOString(), obligations } };
        });
    });
  }

  /** Selected proofs are rechecked in the caller's owner transaction, including
   * the command that consumes them. No result from a prior HTTP check is trusted.
   * Cost: one admission and receipt lookup, at most eight obligation rows and
   * eight saved edge steps per row; unrelated receipts/paths are never walked. */
  private async inspectAdmission(client: PoolClient, principalId: string,
    admissionId: string): Promise<{ actingSubject: string; command: string;
      authorityEpoch: string; obligations: string[] }> {
      const admission = await client.query<{ expires_at: Date; state: string;
        acting_subject: string; action: string; authority_epoch: string }>(`SELECT
        expires_at, state, acting_subject, action, authority_epoch FROM access.admission
        WHERE id = $1 AND principal_id = $2`, [admissionId, principalId]);
      const record = admission.rows[0];
      if (!record || record.state !== 'registered'
        || record.expires_at.getTime() <= Date.now()) {
        throw new ControlDenied('admission is unavailable');
      }
      const consumed = await client.query(`SELECT 1 FROM access.grant_change_receipt
        WHERE selected_admission_id = $1`, [admissionId]);
      if (consumed.rowCount !== 0) throw new ControlDenied('admission is already consumed');
      const obligations = await client.query<{ obligation: string; live: boolean }>(`
        SELECT o.obligation,
          (g.active AND g.generation = o.grant_generation AND g.valid_until > clock_timestamp()
            AND g.recipient_subject = o.acting_subject AND acting.active AND origin.active
            AND r.active AND r.generation = p.representation_generation
            AND r.valid_until > clock_timestamp() AND pr.active
            AND pr.enforcement_epoch = p.principal_epoch
            AND (l.representative_policy_id IS NULL OR (p.edge_count = 0
              AND r.representative_policy_id = l.representative_policy_id
              AND EXISTS (SELECT 1 FROM access.representative_policy policy
                JOIN access.representative_policy_revision revision
                  ON revision.policy_id = policy.id
                  AND revision.revision = policy.active_revision
                WHERE policy.id = l.representative_policy_id
                  AND r.action = ANY(revision.actions))))
            AND NOT EXISTS (SELECT 1 FROM access.representation_path_step s
              JOIN access.representation_edge e ON e.id = s.edge_id
              JOIN access.permission_grant c ON c.id = e.ceiling_grant_id
              JOIN access.authority_subject represented ON represented.id = e.represented_subject
              WHERE s.path_id = p.id AND (NOT e.active OR e.generation <> s.edge_generation
                OR e.valid_until <= clock_timestamp() OR NOT represented.active
                OR NOT c.active OR c.generation <> e.ceiling_grant_generation
                OR c.valid_until <= clock_timestamp()))) AS live
        FROM access.admission_obligation o
        JOIN access.representation_path_proof p ON p.id = o.path_id
        JOIN access.representation r ON r.id = p.representation_id
        JOIN access.principal pr ON pr.id = p.principal_id
        JOIN access.permission_grant g ON g.id = o.grant_id
        LEFT JOIN access.grant_lineage l ON l.grant_id = g.id
        JOIN access.authority_subject acting ON acting.id = o.acting_subject
        JOIN access.authority_subject origin ON origin.id = p.origin_subject
        WHERE o.admission_id = $1 ORDER BY o.obligation LIMIT 9`, [admissionId]);
      const failed = obligations.rows.find(row => !row.live);
      if (failed || obligations.rows.length === 0 || obligations.rows.length > MAX_OBLIGATIONS) {
        throw new ControlDenied(`obligation ${failed?.obligation ?? 'set'} lost its selected proof`);
      }
      return { actingSubject: record.acting_subject, command: record.action,
        authorityEpoch: record.authority_epoch,
        obligations: obligations.rows.map(row => row.obligation) };
  }

  /** Claim-time read: every saved proof must still be the same live row. */
  async recheckAdmission(principal: VerifiedPrincipal,
    admissionId: string): Promise<{ admissionId: string; decision: 'admitted'; obligations: number }> {
    if (!idPattern.test(admissionId)) throw new ControlInvalid('invalid admission');
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, false);
      await lockGate(client, TOPOLOGY_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      const selected = await this.inspectAdmission(client, actor.id, admissionId);
      return { admissionId, decision: 'admitted', obligations: selected.obligations.length };
    });
  }

  /** Delegated revocation needs independent assignment and delegated-revocation
   * authority for the same acting Agent. Each obligation has its own complete
   * selected path and grant, rechecked in the grant owner's transaction. */
  async consumeGrantRevokeAdmission(client: PoolClient, principalId: string,
    admissionId: string, issuerSubject: string, grantId: string,
    authorityEpoch: string): Promise<void> {
    if (!idPattern.test(admissionId)) throw new ControlInvalid('invalid selected admission');
    await lockGate(client, TOPOLOGY_SCOPE, false);
    const selected = await this.inspectAdmission(client, principalId, admissionId);
    if (selected.actingSubject !== issuerSubject
      || selected.command !== `grant.revoke.${grantId}`
      || selected.authorityEpoch !== authorityEpoch
      || selected.obligations.length !== 2
      || selected.obligations[0] !== 'access.grant.assign.work.create'
      || selected.obligations[1] !== 'access.grant.delegated-revoke.work.create') {
      throw new ControlDenied('selected admission does not authorize this grant revocation');
    }
  }
}
