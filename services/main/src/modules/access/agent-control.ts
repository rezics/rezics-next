import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { CONTROL_ACTION, MAX_CONTROLLERS, type RecoveryReason } from './agent-control-schema.ts';
import { groupChangeIntentDigest } from './group-intent.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, type ControlReceipt,
  agentPattern, bumpEpoch, controlTransaction, generationPattern, idPattern, lockGate,
  receipted, requireAgent, requireMandate, requirePrincipal, requireReceipt }
  from './topology-control.ts';
import { TOPOLOGY_SCOPE } from './topology-schema.ts';

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface ControlView extends Record<string, unknown> {
  subjectId: string; minControllers: number; maxControllers: number; recoverySubject: string;
  recoveryApprovals: number; recoveryDelaySeconds: number; generation: string;
  liveControllers: number;
}
export interface RecoveryView extends Record<string, unknown> {
  recoveryId: string; subjectId: string; reason: RecoveryReason; recoverySubject: string;
  requiredApprovals: number; changeDigest: string; notBefore: string; expiresAt: string;
}

async function liveControllers(client: PoolClient, subject: string): Promise<number> {
  const row = await client.query<{ count: number }>(
    'SELECT access.agent_controller_count($1) AS count', [subject]);
  return Number(row.rows[0]!.count);
}

async function controlView(client: PoolClient, subject: string, lock: boolean): Promise<ControlView> {
  const row = await client.query<{ min_controllers: number; max_controllers: number;
    recovery_subject: string; recovery_approvals: number; delay: number; generation: string }>(`
    SELECT min_controllers, max_controllers, recovery_subject, recovery_approvals,
      extract(epoch FROM recovery_delay)::integer AS delay, generation
    FROM access.agent_control WHERE subject_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [subject]);
  const control = row.rows[0];
  if (!control) throw new ControlDenied('Agent has no admitted control policy');
  return { subjectId: subject, minControllers: control.min_controllers,
    maxControllers: control.max_controllers, recoverySubject: control.recovery_subject,
    recoveryApprovals: control.recovery_approvals, recoveryDelaySeconds: control.delay,
    generation: control.generation, liveControllers: await liveControllers(client, subject) };
}

/** Recovery effect, run inside the protected-change activation: the claimant
 * becomes a controller and every other live controller is revoked. Their past
 * mandates, proofs and decisions stay as recorded. */
export async function applyAgentRecovery(client: PoolClient, proposalId: string,
  activatedBy: string): Promise<void> {
  const recovery = await client.query<{ subject_id: string; replacement_principal: string;
    expected_control_generation: string; generation: string }>(`SELECT r.subject_id,
    r.replacement_principal, r.expected_control_generation, c.generation
    FROM access.agent_recovery r JOIN access.agent_control c ON c.subject_id = r.subject_id
    WHERE r.proposal_id = $1 FOR UPDATE OF c`, [proposalId]);
  const row = recovery.rows[0];
  if (!row) throw new ControlDenied('recovery is unavailable');
  if (row.generation !== row.expected_control_generation) {
    throw new ControlStale('Agent control changed while recovery was pending');
  }
  await client.query(`UPDATE access.representation SET active = false
    WHERE subject_id = $1 AND action = $2 AND active`, [row.subject_id, CONTROL_ACTION]);
  await client.query(`UPDATE access.representation_edge SET active = false
    WHERE represented_subject = $1 AND action = $2 AND active`, [row.subject_id, CONTROL_ACTION]);
  await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action,
    valid_until, assigned_by_principal, protected_change_id)
    VALUES ($1,$2,$3,$4,'infinity',$5,$6)`, [randomUUID(), row.replacement_principal,
    row.subject_id, CONTROL_ACTION, activatedBy, proposalId]);
}

/** Agent controller continuity and independent recovery (IAM08). Controllers
 * are open-ended 'agent.control' mandates; the recovery authority is another
 * subject the Agent does not control, approving through protected changes. */
export class AccessAgentControl {
  constructor(private readonly pool: Pool) {}

  /** A current controller admits the control policy once (installation input). */
  async configure(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    subjectId: string; recoverySubject: string; recoveryApprovals: number;
    recoveryDelaySeconds: number; minControllers: number; maxControllers: number }):
    Promise<ControlView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!agentPattern.test(input.subjectId) || !agentPattern.test(input.recoverySubject)
      || ![input.recoveryApprovals, input.minControllers, input.maxControllers,
        input.recoveryDelaySeconds].every(Number.isInteger)
      || input.recoveryApprovals < 1 || input.recoveryApprovals > 8
      || input.minControllers < 1 || input.maxControllers > MAX_CONTROLLERS
      || input.minControllers > input.maxControllers || input.recoveryDelaySeconds < 0
      || input.recoveryDelaySeconds > 30 * 86_400) {
      throw new ControlInvalid('invalid Agent control policy');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, input.subjectId, CONTROL_ACTION);
      return receipted<ControlView>(client, actor.id, receipt, 'agent-control', 'configure',
        input.subjectId, subjectObjectId(input.subjectId), async () => {
          await requireAgent(client, input.recoverySubject);
          await client.query(`INSERT INTO access.agent_control (subject_id, min_controllers,
            max_controllers, recovery_subject, recovery_approvals, recovery_delay)
            VALUES ($1,$2,$3,$4,$5,make_interval(secs => $6))`,
          [input.subjectId, input.minControllers, input.maxControllers, input.recoverySubject,
            input.recoveryApprovals, input.recoveryDelaySeconds]);
          const epoch = await bumpEpoch(client, TOPOLOGY_SCOPE);
          return { epoch, result: await controlView(client, input.subjectId, false) };
        });
    });
  }

  async read(principal: VerifiedPrincipal, subjectId: string): Promise<ControlView> {
    if (!agentPattern.test(subjectId)) throw new ControlInvalid('invalid Agent control read');
    return controlTransaction(this.pool, async client => {
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, subjectId, CONTROL_ACTION);
      return controlView(client, subjectId, false);
    });
  }

  /** Removing a controller keeps the continuity floor; the last one stays. */
  async removeController(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    subjectId: string; representationId: string; expectedGeneration: string }):
    Promise<ControlView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!agentPattern.test(input.subjectId) || !idPattern.test(input.representationId)
      || !generationPattern.test(input.expectedGeneration)) {
      throw new ControlInvalid('invalid controller change');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, input.subjectId, CONTROL_ACTION);
      return receipted<ControlView>(client, actor.id, receipt, 'agent-control',
        'remove-controller', input.subjectId, input.representationId, async () => {
          const control = await controlView(client, input.subjectId, true);
          const target = await client.query<{ generation: string; active: boolean }>(`SELECT
            generation, active FROM access.representation WHERE id = $1 AND subject_id = $2
              AND action = $3 FOR UPDATE`, [input.representationId, input.subjectId, CONTROL_ACTION]);
          if (!target.rows[0]) throw new ControlDenied('controller is unavailable');
          if (target.rows[0].generation !== input.expectedGeneration) {
            throw new ControlStale('controller generation changed');
          }
          if (!target.rows[0].active) throw new ControlDenied('controller is already removed');
          if (control.liveControllers - 1 < control.minControllers) {
            throw new ControlConflict('removal would break Agent control continuity');
          }
          await client.query('UPDATE access.representation SET active = false WHERE id = $1',
            [input.representationId]);
          const epoch = await bumpEpoch(client, TOPOLOGY_SCOPE);
          return { epoch, result: await controlView(client, input.subjectId, false) };
        });
    });
  }

  /** The claimant requests to become the replacement controller. The request
   * binds the current recovery policy and opens only after its waiting period. */
  async requestRecovery(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    recoveryId: string; subjectId: string; reason: RecoveryReason;
    expectedControlGeneration: string }): Promise<RecoveryView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.recoveryId) || !agentPattern.test(input.subjectId)
      || !['last-controller-lost', 'controller-compromised'].includes(input.reason)
      || !generationPattern.test(input.expectedControlGeneration)) {
      throw new ControlInvalid('invalid Agent recovery');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      return receipted<RecoveryView>(client, actor.id, receipt, 'agent-recovery', 'request',
        input.subjectId, input.recoveryId, async () => {
          const control = await controlView(client, input.subjectId, true);
          if (control.generation !== input.expectedControlGeneration) {
            throw new ControlStale('Agent control generation changed');
          }
          if (input.reason === 'last-controller-lost' && control.liveControllers > 0) {
            throw new ControlConflict('live controllers remain; recovery needs a compromise claim');
          }
          const current = await client.query(`SELECT 1 FROM access.representation
            WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active`,
          [actor.id, input.subjectId, CONTROL_ACTION]);
          if (current.rows[0]) throw new ControlDenied('a current controller cannot claim recovery');
          const change = { subjectId: input.subjectId, reason: input.reason,
            replacement: 'requesting-principal', controlGeneration: control.generation };
          const digest = groupChangeIntentDigest({ kind: 'agent-recovery', change });
          const notBefore = new Date(Date.now() + control.recoveryDelaySeconds * 1000);
          // The approval window closes within the proposal's 31-day bound.
          const windowSeconds = Math.min(RECOVERY_WINDOW_MS / 1000,
            31 * 86_400 - control.recoveryDelaySeconds - 60);
          await client.query(`INSERT INTO access.protected_change_proposal (id, kind,
            target_subject, expected_object_generation, resulting_ceiling, staged_change,
            change_digest, approval_subject, required_approvals, requested_by, not_before,
            expires_at, created_at) VALUES ($1,'agent-recovery',$2,$3,$4,$5,$6,$7,$8,$9,
              now() + make_interval(secs => $10), now() + make_interval(secs => $10)
                + make_interval(secs => $11), now())`,
          [input.recoveryId, input.subjectId, control.generation, [CONTROL_ACTION], change,
            digest, control.recoverySubject, control.recoveryApprovals, actor.id,
            control.recoveryDelaySeconds, windowSeconds]);
          await client.query(`INSERT INTO access.agent_recovery (proposal_id, subject_id, reason,
            replacement_principal, revoke_existing, expected_control_generation)
            VALUES ($1,$2,$3,$4,true,$5)`,
          [input.recoveryId, input.subjectId, input.reason, actor.id, control.generation]);
          const epoch = await lockGate(client, TOPOLOGY_SCOPE, false);
          return { epoch, result: { recoveryId: input.recoveryId, subjectId: input.subjectId,
            reason: input.reason, recoverySubject: control.recoverySubject,
            requiredApprovals: control.recoveryApprovals, changeDigest: digest,
            notBefore: notBefore.toISOString(),
            expiresAt: new Date(notBefore.getTime() + windowSeconds * 1000).toISOString() } };
        });
    });
  }
}

/** A stable receipt object ID for the one control policy of an Agent. */
function subjectObjectId(subject: string): string {
  return subject.slice(-36);
}
