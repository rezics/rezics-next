import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { groupChangeIntentDigest } from './group-intent.ts';
import { applyAgentController, applyAgentRecovery } from './agent-control.ts';
import { type ProtectedChangeKind, MAX_PROTECTED_APPROVALS } from './protected-set-schema.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, type ControlReceipt,
  WORK_SCOPE, agentPattern, bumpEpoch, controlTransaction, generationPattern,
  idPattern, lockGate, mandateFor, receipted, requireAgent, requireCeiling, requireMandate,
  requirePrincipal, requireReceipt } from './topology-control.ts';
import { activePolicy, appendPolicyRevision, type PolicyCeiling, validCeiling, widens }
  from './topology-policy.ts';
import { TOPOLOGY_SCOPE } from './topology-schema.ts';

export const APPROVE = 'access.protected-change.approve';
const GROUP_MANAGE = 'access.group.manage';
const GROUP_ASSIGN = 'access.group.assign.work.create';
const ROLE_MANAGE = 'access.role.manage';
const GRANT_ASSIGN = 'access.grant.assign.work.create';
const REPRESENTATION_MANAGE = 'access.representation.manage';
const PROPOSAL_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_REBINDS = 256;

export type ProposalInput =
  | { kind: 'agent-controller'; recipientSubject: string; representationId: string }
  | { kind: 'group-member'; groupId: string; memberId: string; agentSubject: string }
  | { kind: 'group-parent'; groupId: string; parentId: string | null;
    expectedObjectGeneration: string }
  | { kind: 'role-revision'; familyId: string; expectedHeadRevision: string;
    permissions: string[]; approvalSubject?: string }
  | { kind: 'automation-install'; installationId: string; enrollmentId: string;
    approvalSubject: string }
  | { kind: 'representative-policy'; policyId: string; expectedGeneration: string;
    ceiling: PolicyCeiling };
export interface ProposalView extends Record<string, unknown> {
  proposalId: string; kind: ProtectedChangeKind; targetSubject: string;
  targetObject: string | null; approvalSubject: string; requiredApprovals: number;
  approvals: number; resultingCeiling: string[]; changeDigest: string;
  preview: Record<string, unknown>; notBefore: string; expiresAt: string;
  status: 'pending' | 'ready' | 'activated' | 'expired';
}
interface Staged {
  kind: ProtectedChangeKind; targetObject: string | null; scoped: boolean;
  objectGeneration: string; ceiling: string[]; change: Record<string, unknown>;
  approvalSubject: string; required: number; ceilingUntil: Date | null;
}
type ProposalRow = { id: string; kind: ProtectedChangeKind; target_subject: string;
  target_object: string | null; scope_id: string | null; expected_authority_epoch: string | null;
  expected_object_generation: string; resulting_ceiling: string[];
  staged_change: Record<string, unknown>; change_digest: string; approval_subject: string;
  required_approvals: number; requested_by: string; requester_subject: string | null;
  not_before: Date; expires_at: Date };

/** The protected set, if any, whose authority the group path changes. */
async function protectedGroupSet(client: PoolClient, groupIds: (string | null)[],
  descendantsOf: string | null): Promise<{ approval_subject: string;
    required_approvals: number } | null> {
  const row = await client.query<{ approval_subject: string; required_approvals: number }>(`
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM access.recipient_group WHERE id = ANY($1::uuid[])
      UNION SELECT g.id, g.parent_id, u.depth + 1 FROM access.recipient_group g
        JOIN up u ON g.id = u.parent_id WHERE u.depth < 33
    ), down(id, depth) AS (
      SELECT $2::uuid, 0 WHERE $2::uuid IS NOT NULL
      UNION SELECT g.id, d.depth + 1 FROM access.recipient_group g
        JOIN down d ON g.parent_id = d.id WHERE d.depth < 256
    ) SELECT p.approval_subject, p.required_approvals FROM access.protected_set p
    WHERE p.group_id IN (SELECT id FROM up UNION SELECT id FROM down)
    ORDER BY p.required_approvals DESC, p.object_id LIMIT 1`, [groupIds, descendantsOf]);
  return row.rows[0] ?? null;
}

/** Active work.create grants reachable through a group's ancestor path. */
async function pathGrants(client: PoolClient, groupId: string | null):
  Promise<{ id: string; valid_until: Date }[]> {
  if (!groupId) return [];
  const rows = await client.query<{ id: string; valid_until: Date }>(`
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM access.recipient_group WHERE id = $1
      UNION SELECT g.id, g.parent_id, u.depth + 1 FROM access.recipient_group g
        JOIN up u ON g.id = u.parent_id WHERE u.depth < 33
    ) SELECT gg.id, gg.valid_until FROM access.group_permission_grant gg
    JOIN up ON up.id = gg.group_id WHERE gg.active AND gg.valid_until > clock_timestamp()
    ORDER BY gg.id LIMIT 257`, [groupId]);
  if (rows.rows.length > 256) throw new ControlDenied('group grant path exceeds its bound');
  return rows.rows;
}

function latest(dates: Date[]): Date | null {
  return dates.reduce<Date | null>((max, date) => !max || date > max ? date : max, null);
}

/** Staged approval of protected authority changes (IAM05, IAM30, IAM32): the
 * requester's resulting ceiling is checked at proposal and activation, distinct
 * approvers of the declared subject approve the exact digest, and activation
 * rechecks every pinned generation before applying the effect once. */
export class AccessProtectedChanges {
  constructor(private readonly pool: Pool) {}

  async protect(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    objectKind: 'group' | 'role-family'; objectId: string; issuerSubject: string;
    approvalSubject: string; requiredApprovals: number }):
    Promise<{ objectKind: string; objectId: string; authorityEpoch: string; replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.objectId) || !agentPattern.test(input.issuerSubject)
      || !agentPattern.test(input.approvalSubject) || !Number.isInteger(input.requiredApprovals)
      || input.requiredApprovals < 1 || input.requiredApprovals > MAX_PROTECTED_APPROVALS) {
      throw new ControlInvalid('invalid protected set');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      const manage = input.objectKind === 'group' ? GROUP_MANAGE : ROLE_MANAGE;
      await requireMandate(client, actor.id, input.issuerSubject, manage);
      await requireCeiling(client, input.issuerSubject, manage);
      return receipted(client, actor.id, receipt, 'protected-change', 'protect',
        input.issuerSubject, input.objectId, async () => {
          await requireAgent(client, input.approvalSubject);
          const owned = input.objectKind === 'group'
            ? await client.query('SELECT 1 FROM access.recipient_group WHERE id = $1 AND scope_id = $2',
              [input.objectId, WORK_SCOPE])
            : await client.query('SELECT 1 FROM access.role_family WHERE id = $1 AND owner_subject = $2',
              [input.objectId, input.issuerSubject]);
          if (!owned.rows[0]) throw new ControlDenied('object is unavailable to this issuer');
          await client.query(`INSERT INTO access.protected_set (object_kind, object_id,
            owner_subject, approval_subject, required_approvals, group_id, role_family_id,
            protected_by_principal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [input.objectKind, input.objectId, input.issuerSubject, input.approvalSubject,
            input.requiredApprovals, input.objectKind === 'group' ? input.objectId : null,
            input.objectKind === 'role-family' ? input.objectId : null, actor.id]);
          const epoch = await bumpEpoch(client, WORK_SCOPE);
          return { epoch, result: { objectKind: input.objectKind, objectId: input.objectId,
            authorityEpoch: epoch } };
        });
    });
  }

  /** Validates the requester's authority and resulting ceiling for one change. */
  private async stage(
    client: PoolClient,
    principalId: string,
    issuer: string,
    input: ProposalInput,
  ): Promise<Staged> {
    switch (input.kind) {
      case 'agent-controller': {
        if (
          !agentPattern.test(input.recipientSubject) ||
          !idPattern.test(input.representationId) ||
          input.recipientSubject === issuer
        )
          throw new ControlInvalid('invalid controller proposal');
        await requireMandate(client, principalId, issuer, 'agent.control');
        const recipient = await client.query(
          `SELECT 1 FROM access.agent_provision
        WHERE agent_id = $1 AND agent_kind = 'person' AND state = 'active'`,
          [input.recipientSubject],
        );
        if (!recipient.rowCount)
          throw new ControlDenied('controller acceptance needs a Person Agent');
        return {
          kind: input.kind,
          targetObject: null,
          scoped: true,
          objectGeneration: await requireAgent(client, issuer),
          ceiling: ['agent.control'],
          approvalSubject: input.recipientSubject,
          required: 1,
          ceilingUntil: null,
          change: {
            recipientSubject: input.recipientSubject,
            representationId: input.representationId,
          },
        };
      }
    case 'group-member': {
      await requireMandate(client, principalId, issuer, GROUP_MANAGE);
      await requireCeiling(client, issuer, GROUP_MANAGE);
      const set = await protectedGroupSet(client, [input.groupId], null);
      if (!set) throw new ControlInvalid('group is not protected; use the ordinary change');
      await requireAgent(client, input.agentSubject);
      const gained = await pathGrants(client, input.groupId);
      return { kind: input.kind, targetObject: input.groupId, scoped: true,
        objectGeneration: await this.groupGeneration(client), ceiling: gained.length
          ? ['work.create'] : [], approvalSubject: set.approval_subject,
        required: set.required_approvals, ceilingUntil: latest(gained.map(g => g.valid_until)),
        change: { groupId: input.groupId, memberId: input.memberId,
          agentSubject: input.agentSubject, gainedGrantIds: gained.map(g => g.id) } };
    }
    case 'group-parent': {
      await requireMandate(client, principalId, issuer, GROUP_MANAGE);
      await requireCeiling(client, issuer, GROUP_MANAGE);
      const group = await client.query<{ generation: string; parent_id: string | null }>(`
        SELECT generation, parent_id FROM access.recipient_group WHERE id = $1 AND scope_id = $2`,
      [input.groupId, WORK_SCOPE]);
      if (!group.rows[0]) throw new ControlDenied('group is unavailable');
      if (group.rows[0].generation !== input.expectedObjectGeneration) {
        throw new ControlStale('group object generation changed');
      }
      const set = await protectedGroupSet(client, [group.rows[0].parent_id, input.parentId],
        input.groupId);
      if (!set) throw new ControlInvalid('reparent touches no protected set');
      const before = new Set((await pathGrants(client, group.rows[0].parent_id)).map(g => g.id));
      const gained = (await pathGrants(client, input.parentId)).filter(g => !before.has(g.id));
      return { kind: input.kind, targetObject: input.groupId, scoped: true,
        objectGeneration: await this.groupGeneration(client),
        ceiling: gained.length ? ['work.create'] : [], approvalSubject: set.approval_subject,
        required: set.required_approvals, ceilingUntil: latest(gained.map(g => g.valid_until)),
        change: { groupId: input.groupId, parentId: input.parentId,
          expectedObjectGeneration: input.expectedObjectGeneration,
          gainedGrantIds: gained.map(g => g.id) } };
    }
    case 'role-revision': {
      await requireMandate(client, principalId, issuer, ROLE_MANAGE);
      await requireCeiling(client, issuer, ROLE_MANAGE);
      if (!(input.permissions.length === 0
        || input.permissions.length === 1 && input.permissions[0] === 'work.create')) {
        throw new ControlInvalid('role permissions are outside this profile');
      }
      const family = await client.query<{ head_revision: string }>(`SELECT head_revision
        FROM access.role_family WHERE id = $1 AND owner_subject = $2 AND scope_id = $3`,
      [input.familyId, issuer, WORK_SCOPE]);
      if (!family.rows[0]) throw new ControlDenied('role family is unavailable to this issuer');
      if (family.rows[0].head_revision !== input.expectedHeadRevision) {
        throw new ControlStale('role family head changed');
      }
      const bindings = await client.query<{ id: string; recipient_subject: string;
        valid_until: Date; permissions: string[] }>(`SELECT b.id, b.recipient_subject,
        b.valid_until, v.permissions FROM access.role_binding b
        JOIN access.role_revision v ON v.family_id = b.family_id AND v.revision = b.role_revision
        WHERE b.family_id = $1 AND b.active AND b.valid_until > clock_timestamp()
        ORDER BY b.id LIMIT ${MAX_REBINDS + 1}`, [input.familyId]);
      if (bindings.rows.length > MAX_REBINDS) {
        throw new ControlDenied('role family has too many holders for one rewrite');
      }
      const set = await client.query<{ approval_subject: string; required_approvals: number }>(`
        SELECT approval_subject, required_approvals FROM access.protected_set
        WHERE role_family_id = $1`, [input.familyId]);
      const approval = set.rows[0] ?? (bindings.rows.length && input.approvalSubject
        ? { approval_subject: input.approvalSubject, required_approvals: 1 } : null);
      if (!approval) {
        throw new ControlInvalid('role is neither protected nor populated; revise it directly');
      }
      if (approval.approval_subject === issuer) {
        throw new ControlDenied('the approval subject must differ from the issuer');
      }
      // Exact per-Agent preview: what each current holder gains or loses.
      const holders = bindings.rows.map(binding => ({ bindingId: binding.id,
        agentSubject: binding.recipient_subject,
        gained: input.permissions.filter(p => !binding.permissions.includes(p)),
        lost: binding.permissions.filter(p => !input.permissions.includes(p)) }));
      const gaining = bindings.rows.filter((_, index) => holders[index]!.gained.length > 0);
      return { kind: input.kind, targetObject: input.familyId, scoped: true,
        objectGeneration: input.expectedHeadRevision,
        ceiling: gaining.length ? ['work.create'] : [], approvalSubject: approval.approval_subject,
        required: approval.required_approvals,
        ceilingUntil: latest(gaining.map(binding => binding.valid_until)),
        change: { familyId: input.familyId, permissions: input.permissions, holders } };
    }
    case 'automation-install': {
      await requireMandate(client, principalId, issuer, REPRESENTATION_MANAGE);
      const enrollment = await client.query<{ actions: string[]; valid_until: Date }>(`
        SELECT actions, valid_until FROM access.automation_enrollment
        WHERE id = $1 AND owner_subject = $2 AND expires_at > clock_timestamp()`,
      [input.enrollmentId, issuer]);
      const row = enrollment.rows[0];
      if (!row) throw new ControlDenied('enrollment is unavailable to this owner');
      if (!row.actions.some(a => a.startsWith('access.') || a.startsWith('agent.'))) {
        throw new ControlInvalid('installation is not privileged; install it directly');
      }
      if (input.approvalSubject === issuer) {
        throw new ControlDenied('the approval subject must differ from the owner');
      }
      await requireAgent(client, input.approvalSubject);
      // The owner must be able to delegate every action it hands to the workload.
      for (const action of row.actions) {
        await requireCeiling(client, issuer, `access.representation.assign.${action}`,
          row.valid_until);
      }
      return { kind: input.kind, targetObject: input.installationId, scoped: false,
        objectGeneration: '0', ceiling: row.actions, approvalSubject: input.approvalSubject,
        required: 1, ceilingUntil: null, change: { installationId: input.installationId,
          enrollmentId: input.enrollmentId, actions: row.actions,
          validUntil: row.valid_until.toISOString() } };
    }
    case 'representative-policy': {
      await requireMandate(client, principalId, issuer, REPRESENTATION_MANAGE);
      if (!validCeiling(input.ceiling)) throw new ControlInvalid('invalid policy ceiling');
      const policy = await activePolicy(client, input.policyId, issuer, false);
      if (policy.generation !== input.expectedGeneration) {
        throw new ControlStale('representative policy generation changed');
      }
      if (!widens(input.ceiling, policy.ceiling)) {
        throw new ControlInvalid('revision does not widen; revise it directly');
      }
      return { kind: input.kind, targetObject: input.policyId, scoped: false,
        objectGeneration: policy.generation, ceiling: input.ceiling.actions,
        approvalSubject: policy.approvalSubject, required: 1, ceilingUntil: null,
        change: { policyId: input.policyId, ceiling: input.ceiling } };
    }
    }
  }

  private async groupGeneration(client: PoolClient): Promise<string> {
    const gate = await client.query<{ group_generation: string }>(
      'SELECT group_generation FROM access.scope_gate WHERE id = $1', [WORK_SCOPE]);
    return gate.rows[0]!.group_generation;
  }

  async propose(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    proposalId: string; issuerSubject: string; expectedAuthorityEpoch: string;
    change: ProposalInput }): Promise<ProposalView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.proposalId) || !agentPattern.test(input.issuerSubject)
      || !generationPattern.test(input.expectedAuthorityEpoch)) {
      throw new ControlInvalid('invalid protected change proposal');
    }
    return controlTransaction(this.pool, async client => {
      const epoch = await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      return receipted<ProposalView>(client, actor.id, receipt, 'protected-change', 'propose',
        input.issuerSubject, input.proposalId, async () => {
          if (epoch !== input.expectedAuthorityEpoch) {
            throw new ControlStale('scope authority epoch changed');
          }
          const staged = await this.stage(client, actor.id, input.issuerSubject, input.change);
          if (staged.ceilingUntil) {
            // The resulting ceiling: the issuer must be able to assign what the change confers.
            const assign = input.change.kind === 'role-revision' ? GRANT_ASSIGN : GROUP_ASSIGN;
            await requireCeiling(client, input.issuerSubject, assign, staged.ceilingUntil);
          }
          await requireAgent(client, staged.approvalSubject);
          const digest = groupChangeIntentDigest({ kind: staged.kind, target: staged.targetObject,
            issuer: input.issuerSubject, change: staged.change });
          await client.query(`INSERT INTO access.protected_change_proposal (id, kind,
            target_subject, target_object, scope_id, expected_authority_epoch,
            expected_object_generation, resulting_ceiling, staged_change, change_digest,
            approval_subject, required_approvals, requested_by, requester_subject, not_before,
            expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$3,now(),$14)`,
          [input.proposalId, staged.kind, input.issuerSubject, staged.targetObject,
            staged.scoped ? WORK_SCOPE : null, staged.scoped ? epoch : null,
            staged.objectGeneration, staged.ceiling,
            { ...staged.change, ceilingUntil: staged.ceilingUntil?.toISOString() ?? null },
            digest, staged.approvalSubject, staged.required, actor.id,
            new Date(Date.now() + PROPOSAL_LIFETIME_MS)]);
          return { epoch, result: await this.view(client, input.proposalId) };
        });
    });
  }

  private async proposal(client: PoolClient, id: string, lock = false): Promise<ProposalRow> {
    const row = await client.query<ProposalRow>(`SELECT id, kind, target_subject, target_object,
      scope_id, expected_authority_epoch, expected_object_generation, resulting_ceiling,
      staged_change, change_digest, approval_subject, required_approvals, requested_by,
      requester_subject, not_before, expires_at FROM access.protected_change_proposal
      WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`, [id]);
    if (!row.rows[0]) throw new ControlDenied('proposal is unavailable');
    return row.rows[0];
  }

  private async view(client: PoolClient, id: string): Promise<ProposalView> {
    const row = await this.proposal(client, id);
    const counts = await client.query<{ approvals: string; activated: boolean }>(`SELECT
      (SELECT count(*) FROM access.protected_change_approval WHERE proposal_id = $1) AS approvals,
      EXISTS (SELECT 1 FROM access.protected_change_activation WHERE proposal_id = $1)
        AS activated`, [id]);
    const approvals = Number(counts.rows[0]!.approvals);
    const { ceilingUntil: _until, ...preview } = row.staged_change;
    return { proposalId: id, kind: row.kind, targetSubject: row.target_subject,
      targetObject: row.target_object, approvalSubject: row.approval_subject,
      requiredApprovals: row.required_approvals, approvals,
      resultingCeiling: row.resulting_ceiling, changeDigest: row.change_digest, preview,
      notBefore: row.not_before.toISOString(), expiresAt: row.expires_at.toISOString(),
      status: counts.rows[0]!.activated ? 'activated'
        : row.expires_at.getTime() <= Date.now() ? 'expired'
          : approvals >= row.required_approvals ? 'ready' : 'pending' };
  }

  /** Readable by the requester or a representative of the approval subject. */
  async read(principal: VerifiedPrincipal, proposalId: string): Promise<ProposalView> {
    if (!idPattern.test(proposalId)) throw new ControlInvalid('invalid proposal read');
    return controlTransaction(this.pool, async (client) => {
      const actor = await requirePrincipal(client, principal);
      const row = await this.proposal(client, proposalId);
      if (
        row.requested_by !== actor.id &&
        !(await mandateFor(
          client,
          actor.id,
          row.approval_subject,
          row.kind === 'agent-controller' ? 'agent.control' : APPROVE,
        ))
      ) {
        throw new ControlDenied('proposal is unavailable');
      }
      return this.view(client, proposalId);
    });
  }

  /** The approval subject's own approval grant, plus the assignment ceiling
   * for any work.create authority the change confers. */
  private async approverAuthority(
    client: PoolClient,
    row: ProposalRow,
    approverId: string,
  ): Promise<{ id: string; generation: string }> {
    if (row.kind === 'agent-controller')
      return requireMandate(client, approverId, row.approval_subject, 'agent.control');
    const mandate = await requireMandate(client, approverId, row.approval_subject, APPROVE);
    await requireCeiling(client, row.approval_subject, APPROVE);
    const until = row.staged_change.ceilingUntil;
    if (row.resulting_ceiling.includes('work.create') && typeof until === 'string') {
      await requireCeiling(client, row.approval_subject, GRANT_ASSIGN, new Date(until));
    }
    if (row.kind === 'automation-install') {
      const validUntil = new Date(String(row.staged_change.validUntil));
      for (const action of row.resulting_ceiling) {
        await requireCeiling(client, row.approval_subject,
          `access.representation.assign.${action}`, validUntil);
      }
    }
    return mandate;
  }

  async approve(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    input: {
      proposalId: string;
      approverSubject: string;
      changeDigest: string;
    },
  ): Promise<ProposalView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.proposalId) || !agentPattern.test(input.approverSubject)
      || !/^[0-9a-f]{64}$/.test(input.changeDigest)) {
      throw new ControlInvalid('invalid protected change approval');
    }
    return controlTransaction(this.pool, async (client) => {
      await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      return receipted<ProposalView>(
        client,
        actor.id,
        receipt,
        'protected-change',
        'approve',
        input.approverSubject,
        input.proposalId,
        async () => {
          const row = await this.proposal(client, input.proposalId, true);
          if (row.approval_subject !== input.approverSubject) {
            throw new ControlDenied('approver does not represent the approval subject');
          }
          if (row.change_digest !== input.changeDigest) {
            throw new ControlStale('approval names another staged change');
          }
          if (row.requested_by === actor.id) throw new ControlDenied('self-approval is not independent');
          const mandate = await this.approverAuthority(client, row, actor.id);
          await client.query(
            `INSERT INTO access.protected_change_approval (proposal_id,
            approver_principal, approver_subject, approver_representation_id,
            approver_representation_generation, approver_representation_action, change_digest)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              input.proposalId,
              actor.id,
              row.approval_subject,
              mandate.id,
              mandate.generation,
              row.kind === 'agent-controller' ? 'agent.control' : APPROVE,
              row.change_digest,
            ],
          );
          const epoch = await lockGate(client, WORK_SCOPE, false);
          return { epoch, result: await this.view(client, input.proposalId) };
        },
      );
    });
  }

  /** Activation rechecks the window, approvals, pinned epoch and generations,
   * and every requester and approver authority, then applies the effect once. */
  async activate(principal: VerifiedPrincipal, receipt: ControlReceipt,
    proposalId: string): Promise<ProposalView & { authorityEpoch: string; replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(proposalId)) throw new ControlInvalid('invalid activation');
    return controlTransaction(this.pool, async client => {
      const epoch = await lockGate(client, WORK_SCOPE, true);
      await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      return receipted<ProposalView & { authorityEpoch: string }>(client, actor.id, receipt,
        'protected-change', 'activate', null, proposalId, async () => {
          const row = await this.proposal(client, proposalId, true);
          if (row.requested_by !== actor.id) throw new ControlDenied('only the requester activates');
          const done = await client.query('SELECT 1 FROM access.protected_change_activation WHERE proposal_id = $1',
            [proposalId]);
          if (done.rows[0]) throw new ControlConflict('proposal is already activated');
          if (row.expires_at.getTime() <= Date.now()) throw new ControlStale('proposal expired');
          if (row.not_before.getTime() > Date.now()) {
            throw new ControlStale('proposal waiting period has not ended');
          }
          if (row.expected_authority_epoch !== null && row.expected_authority_epoch !== epoch) {
            throw new ControlStale('scope authority epoch changed while approval was pending');
          }
          const approvals = await client.query<{ approver_principal: string }>(`SELECT
            approver_principal FROM access.protected_change_approval WHERE proposal_id = $1`,
          [proposalId]);
          if (approvals.rows.length < row.required_approvals) {
            throw new ControlDenied('required approvals are missing');
          }
          for (const approval of approvals.rows) {
            await this.approverAuthority(client, row, approval.approver_principal);
          }
          await this.recheckRequester(client, row, actor.id);
          await client.query(`INSERT INTO access.protected_change_activation (proposal_id, kind,
            target_subject, target_object, activated_by, approval_count, result_authority_epoch,
            result_object_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [proposalId, row.kind, row.target_subject, row.target_object, actor.id,
            approvals.rows.length, epoch, row.expected_object_generation]);
          await this.apply(client, row, actor.id);
          const authorityEpoch = await bumpEpoch(client, WORK_SCOPE);
          await bumpEpoch(client, TOPOLOGY_SCOPE);
          return { epoch: authorityEpoch, result: { ...await this.view(client, proposalId),
            authorityEpoch } };
        });
    });
  }

  private async recheckRequester(
    client: PoolClient,
    row: ProposalRow,
    principalId: string,
  ): Promise<void> {
    const change = row.staged_change;
    const until = typeof change.ceilingUntil === 'string' ? new Date(change.ceilingUntil) : null;
    switch (row.kind) {
    case 'agent-controller':
        await requireMandate(client, principalId, row.target_subject, 'agent.control');
        if ((await requireAgent(client, row.target_subject)) !== row.expected_object_generation) {
          throw new ControlStale('Agent changed while controller acceptance was pending');
        }
      return;
    case 'group-member': case 'group-parent':
      await requireMandate(client, principalId, row.target_subject, GROUP_MANAGE);
      if (until) await requireCeiling(client, row.target_subject, GROUP_ASSIGN, until);
      if ((await this.groupGeneration(client)) !== row.expected_object_generation) {
        throw new ControlStale('group generation changed while approval was pending');
      }
      return;
    case 'role-revision': {
      await requireMandate(client, principalId, row.target_subject, ROLE_MANAGE);
      if (until) await requireCeiling(client, row.target_subject, GRANT_ASSIGN, until);
      const family = await client.query<{ head_revision: string }>(`SELECT head_revision
        FROM access.role_family WHERE id = $1 FOR UPDATE`, [row.target_object]);
      if (family.rows[0]?.head_revision !== row.expected_object_generation) {
        throw new ControlStale('role family head changed while approval was pending');
      }
      return;
    }
    case 'automation-install': {
      await requireMandate(client, principalId, row.target_subject, REPRESENTATION_MANAGE);
      const validUntil = new Date(String(change.validUntil));
      for (const action of change.actions as string[]) {
        await requireCeiling(client, row.target_subject, `access.representation.assign.${action}`,
          validUntil);
      }
      return;
    }
    case 'representative-policy': {
      await requireMandate(client, principalId, row.target_subject, REPRESENTATION_MANAGE);
      const policy = await activePolicy(client, row.target_object!, row.target_subject, true);
      if (policy.generation !== row.expected_object_generation) {
        throw new ControlStale('representative policy changed while approval was pending');
      }
      return;
    }
    case 'agent-recovery': return;
    default: throw new ControlInvalid('unsupported protected change kind');
    }
  }

  private async apply(client: PoolClient, row: ProposalRow, principalId: string): Promise<void> {
    const change = row.staged_change;
    switch (row.kind) {
    case 'agent-controller':
        await applyAgentController(client, row.id, principalId);
      return;
    case 'group-member':
      await client.query(`INSERT INTO access.group_member (id, group_id, agent_subject,
        protected_change_id) VALUES ($1,$2,$3,$4)`,
      [change.memberId, change.groupId, change.agentSubject, row.id]);
      return;
    case 'group-parent':
      await client.query(`UPDATE access.recipient_group SET parent_id = $2,
        generation = generation + 1, protected_change_id = $3 WHERE id = $1`,
      [change.groupId, change.parentId, row.id]);
      return;
    case 'role-revision': {
      const next = (BigInt(row.expected_object_generation) + 1n).toString();
      await client.query(`INSERT INTO access.role_revision (family_id, revision, permissions,
        protected_change_id) VALUES ($1,$2,$3,$4)`,
      [row.target_object, next, change.permissions, row.id]);
      await client.query('UPDATE access.role_family SET head_revision = $2 WHERE id = $1',
        [row.target_object, next]);
      // Every current holder moves to the approved revision under this activation.
      for (const holder of change.holders as { bindingId: string }[]) {
        const old = await client.query<{ recipient_subject: string; issuer_subject: string;
          valid_until: Date; membership_id: string | null; membership_generation: string | null }>(`
          UPDATE access.role_binding SET active = false WHERE id = $1 AND active
          RETURNING recipient_subject, issuer_subject, valid_until, membership_id,
            membership_generation`, [holder.bindingId]);
        const binding = old.rows[0];
        if (!binding) throw new ControlStale('a role holder changed while approval was pending');
        await client.query(`INSERT INTO access.role_binding (id, family_id, role_revision,
          issuer_subject, recipient_subject, valid_until, assigned_by_principal, membership_id,
          membership_generation, protected_change_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), row.target_object, next, binding.issuer_subject, binding.recipient_subject,
          binding.valid_until, principalId, binding.membership_id, binding.membership_generation,
          row.id]);
      }
      return;
    }
    case 'automation-install': {
      const enrollment = await client.query<{ workload_principal: string; valid_until: Date }>(`
        SELECT workload_principal, valid_until FROM access.automation_enrollment WHERE id = $1`,
      [change.enrollmentId]);
      const workload = enrollment.rows[0]!;
      await client.query(`INSERT INTO access.automation_installation (id, owner_subject,
        workload_principal, actions, privileged, protected_change_id, installed_by_principal,
        valid_until, enrollment_id) VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8)`,
      [row.target_object, row.target_subject, workload.workload_principal, change.actions, row.id,
        principalId, workload.valid_until, change.enrollmentId]);
      for (const action of change.actions as string[]) {
        await client.query(`INSERT INTO access.representation (id, principal_id, subject_id,
          action, valid_until, assigned_by_principal, automation_installation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), workload.workload_principal,
          row.target_subject, action, workload.valid_until, principalId, row.target_object]);
      }
      return;
    }
    case 'representative-policy': {
      const policy = await activePolicy(client, row.target_object!, row.target_subject, true);
      await appendPolicyRevision(client, policy, change.ceiling as PolicyCeiling, principalId, row.id);
      return;
    }
    case 'agent-recovery':
      await applyAgentRecovery(client, row.id, principalId);
      return;
    default: throw new ControlInvalid('unsupported protected change kind');
    }
  }

  /** Non-privileged installs need no approval; privileged ones use `propose`. */
  async installAutomation(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    installationId: string; ownerSubject: string; enrollmentId: string }):
    Promise<{ installationId: string; authorityEpoch: string; replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.installationId) || !idPattern.test(input.enrollmentId)
      || !agentPattern.test(input.ownerSubject)) {
      throw new ControlInvalid('invalid automation installation');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, input.ownerSubject, REPRESENTATION_MANAGE);
      return receipted(client, actor.id, receipt, 'automation', 'install', input.ownerSubject,
        input.installationId, async () => {
          const enrollment = await client.query<{ workload_principal: string; actions: string[];
            valid_until: Date }>(`SELECT workload_principal, actions, valid_until
            FROM access.automation_enrollment WHERE id = $1 AND owner_subject = $2
              AND expires_at > clock_timestamp()`, [input.enrollmentId, input.ownerSubject]);
          const row = enrollment.rows[0];
          if (!row) throw new ControlDenied('enrollment is unavailable to this owner');
          for (const action of row.actions) {
            await requireCeiling(client, input.ownerSubject, `access.representation.assign.${action}`,
              row.valid_until);
          }
          // The owner guard classifies privilege and rejects it without approval.
          await client.query(`INSERT INTO access.automation_installation (id, owner_subject,
            workload_principal, actions, privileged, installed_by_principal, valid_until,
            enrollment_id) VALUES ($1,$2,$3,$4,false,$5,$6,$7)`,
          [input.installationId, input.ownerSubject, row.workload_principal, row.actions, actor.id,
            row.valid_until, input.enrollmentId]);
          for (const action of row.actions) {
            await client.query(`INSERT INTO access.representation (id, principal_id, subject_id,
              action, valid_until, assigned_by_principal, automation_installation_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), row.workload_principal,
              input.ownerSubject, action, row.valid_until, actor.id, input.installationId]);
          }
          const epoch = await bumpEpoch(client, WORK_SCOPE);
          return { epoch, result: { installationId: input.installationId, authorityEpoch: epoch } };
        });
    });
  }

  /** A workload enrolls itself; the owner later names only this handle. */
  async enroll(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    enrollmentId: string; ownerSubject: string; actions: string[]; validUntil: Date }):
    Promise<{ enrollmentId: string; expiresAt: string; replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.enrollmentId) || !agentPattern.test(input.ownerSubject)
      || input.actions.length < 1 || input.actions.length > 32
      || new Set(input.actions).size !== input.actions.length
      || input.actions.some(a => !/^[a-z][a-z0-9.-]{0,127}$/.test(a))
      || Number.isNaN(input.validUntil.getTime()) || input.validUntil.getTime() <= Date.now()) {
      throw new ControlInvalid('invalid automation enrollment');
    }
    return controlTransaction(this.pool, async client => {
      // Acquire the gate before the receipt key, matching all other controls.
      await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      return receipted(client, actor.id, receipt, 'automation', 'enroll', input.ownerSubject,
        input.enrollmentId, async () => {
          await requireAgent(client, input.ownerSubject);
          const expiresAt = new Date(Date.now() + 14 * 60_000);
          await client.query(`INSERT INTO access.automation_enrollment (id, workload_principal,
            owner_subject, actions, valid_until, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.enrollmentId, actor.id, input.ownerSubject, input.actions, input.validUntil,
            expiresAt]);
          const epoch = await lockGate(client, WORK_SCOPE, false);
          return { epoch, result: { enrollmentId: input.enrollmentId,
            expiresAt: expiresAt.toISOString() } };
        });
    });
  }
}
