// IAM18 operations. A mute only feeds the principal's presentation selection, a
// block only admits or refuses interactions, and resource access stays with
// access.policy. None of these operations reads another one's records.
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { publicDecisionResult } from './decision-snapshot-schema.ts';
import { FrameInputs, insertFrame } from './decision-snapshot-store.ts';
import {
  INTERACTION_KINDS, interactionScope, type InteractionBlockRow, type InteractionChangeReceiptRow,
  type InteractionKind, type InteractionMutePreferenceRow,
} from './interaction-schema.ts';
import {
  agentPattern, generationPattern, PolicyConflict, PolicyDenied, PolicyInvalid, PolicyStale,
  PolicyUnavailable, uuidPattern,
} from './policy-errors.ts';
import { BudgetExhausted } from './policy-evaluator.ts';
import type { MembershipBasis } from './policy-schema.ts';
import {
  advanceScopeEpoch, findPrincipal, inAccessTransaction, lockOpenScope, requireActivePrincipal,
  requireMandate, requireRecoveryOpen,
} from './policy-transaction.ts';

export const INTERACTION_MANAGE = 'access.interaction.manage';
export const MAX_ACTIVE_BLOCKS = 64;
export const MAX_MUTES = 256;

export interface ReceiptKey { idempotencyKey: string; requestDigest: string }
export interface MuteChange {
  targetKind: 'realm' | 'agent'; target: string; match: InteractionMutePreferenceRow['match'];
  muted: boolean; expectedRevision: string | null;
}
export type BlockTarget = { kind: 'agent'; subject: string }
  | { kind: 'member-set'; setKind: 'org' | 'realm'; setOwnerSubject: string; basis: MembershipBasis };
export type BlockChange =
  | { action: 'block'; blockId: string; target: BlockTarget; interactions: InteractionKind[] }
  | { action: 'unblock'; blockId: string; expectedGeneration: string };

function validKey(key: ReceiptKey): boolean {
  return key.idempotencyKey.length > 0 && key.idempotencyKey.length <= 128
    && !key.idempotencyKey.includes('\0') && /^[0-9a-f]{64}$/.test(key.requestDigest);
}

export class AccessInteractions {
  constructor(private readonly pool: Pool) {}

  /** Private presentation preference, compare-and-set on its revision. */
  async setMute(principal: VerifiedPrincipal, change: MuteChange, key: ReceiptKey):
    Promise<{ revision: string; muted: boolean; replayed: boolean }> {
    const explicitMatch = change.targetKind === 'agent' ? change.match === 'author'
      : ['publishing-realm', 'author-membership', 'publication-context'].includes(change.match);
    if (!validKey(key) || !agentPattern.test(change.target) || !explicitMatch
      || (change.expectedRevision !== null && !uuidPattern.test(change.expectedRevision))) {
      throw new PolicyInvalid('invalid mute preference');
    }
    return inAccessTransaction(this.pool, 'read committed', async client => {
      await requireRecoveryOpen(client, true);
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, $2, $3) ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
      [randomUUID(), principal.issuer, principal.subject]);
      const identity = await requireActivePrincipal(client, principal);
      // The row lock serializes this principal's preference writes and receipts.
      await client.query('SELECT id FROM access.principal WHERE id = $1 FOR UPDATE', [identity.id]);
      const prior = (await client.query<InteractionChangeReceiptRow>(`SELECT * FROM
        access.interaction_change_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
      [identity.id, key.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== key.requestDigest || !prior.mute_revision) {
          throw new PolicyConflict('interaction key binds another intent');
        }
        return { revision: prior.mute_revision, muted: prior.action === 'mute', replayed: true };
      }
      const current = (await client.query<{ revision: string }>(`SELECT revision FROM
        access.interaction_mute_preference WHERE principal_id = $1 AND target_kind = $2
          AND target = $3 AND match = $4`, [identity.id, change.targetKind, change.target,
        change.match])).rows[0];
      if ((current?.revision ?? null) !== change.expectedRevision) throw new PolicyStale('mute preference changed');
      if (change.muted && !current) {
        const count = await client.query<{ n: string }>(`SELECT count(*) AS n FROM
          access.interaction_mute_preference WHERE principal_id = $1 AND muted`, [identity.id]);
        if (Number(count.rows[0]!.n) >= MAX_MUTES) throw new PolicyUnavailable('mute capacity is exhausted');
      }
      const revision = randomUUID();
      await client.query(`INSERT INTO access.interaction_mute_preference (principal_id, target_kind,
          target, match, muted, revision) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (principal_id, target_kind, target, match)
        DO UPDATE SET muted = EXCLUDED.muted, revision = EXCLUDED.revision, changed_at = now()`,
      [identity.id, change.targetKind, change.target, change.match, change.muted, revision]);
      await client.query(`INSERT INTO access.interaction_change_receipt (principal_id,
          idempotency_key, request_digest, action, mute_revision) VALUES ($1, $2, $3, $4, $5)`,
      [identity.id, key.idempotencyKey, key.requestDigest, change.muted ? 'mute' : 'unmute', revision]);
      return { revision, muted: change.muted, replayed: false };
    });
  }

  /** The presentation selection input: at most 256 current mutes, stable order. */
  async listMutes(principal: VerifiedPrincipal): Promise<Pick<InteractionMutePreferenceRow,
    'target_kind' | 'target' | 'match' | 'revision'>[]> {
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      await requireRecoveryOpen(client, false);
      const identity = await findPrincipal(client, principal);
      if (!identity?.active) return [];
      return (await client.query<InteractionMutePreferenceRow>(`SELECT target_kind, target, match,
        revision FROM access.interaction_mute_preference WHERE principal_id = $1 AND muted
        ORDER BY target_kind, target, match LIMIT ${MAX_MUTES}`, [identity.id])).rows;
    });
  }

  /** Bounded author facts for a caller's Realm-membership presentation mutes.
   * Only the supplied public authors and muted Realms can be returned. */
  async searchAuthorMemberships(authors: readonly string[], realms: readonly string[]) {
    if (authors.length > 512 || realms.length > MAX_MUTES
      || authors.some(author => !agentPattern.test(author))
      || realms.some(realm => !agentPattern.test(realm))) {
      throw new PolicyInvalid('invalid presentation membership batch');
    }
    if (!authors.length || !realms.length) return new Map<string, string[]>();
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      await requireRecoveryOpen(client, false);
      const rows = (await client.query<{ member_subject: string; owner_subject: string }>(
        `SELECT member_subject, owner_subject FROM access.membership
          WHERE kind = 'realm' AND state = 'joined'
            AND member_subject = ANY($1::text[]) AND owner_subject = ANY($2::text[])
          ORDER BY member_subject, owner_subject LIMIT 513`, [authors, realms])).rows;
      if (rows.length > 512) throw new PolicyUnavailable('presentation membership batch exceeded budget');
      const found = new Map<string, string[]>();
      for (const row of rows) found.set(row.member_subject,
        [...(found.get(row.member_subject) ?? []), row.owner_subject]);
      return found;
    });
  }

  /** The recipient Agent's representative changes its interaction admission rule. */
  async changeBlock(principal: VerifiedPrincipal, recipient: string, expectedAuthorityEpoch: string,
    change: BlockChange, key: ReceiptKey): Promise<{ blockId: string; generation: string;
      authorityEpoch: string; replayed: boolean }> {
    if (!validKey(key) || !agentPattern.test(recipient) || !uuidPattern.test(change.blockId)
      || !generationPattern.test(expectedAuthorityEpoch)
      || (change.action === 'block' && (change.interactions.length < 1
        || change.interactions.some(kind => !INTERACTION_KINDS.includes(kind))
        || (change.target.kind === 'agent' && !agentPattern.test(change.target.subject))))) {
      throw new PolicyInvalid('invalid interaction block');
    }
    const scope = interactionScope(recipient);
    await this.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    return inAccessTransaction(this.pool, 'read committed', async client => {
      await requireRecoveryOpen(client, true);
      const identity = await requireActivePrincipal(client, principal);
      const epoch = await lockOpenScope(client, scope);
      const mandate = await requireMandate(client, identity.id, recipient, INTERACTION_MANAGE);
      const prior = (await client.query<InteractionChangeReceiptRow>(`SELECT * FROM
        access.interaction_change_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
      [identity.id, key.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== key.requestDigest || prior.block_id !== change.blockId) {
          throw new PolicyConflict('interaction key binds another intent');
        }
        const block = (await client.query<{ generation: string }>(
          'SELECT generation FROM access.interaction_block WHERE id = $1', [change.blockId])).rows[0]!;
        return { blockId: change.blockId, generation: block.generation,
          authorityEpoch: prior.result_authority_epoch!, replayed: true };
      }
      if (epoch !== expectedAuthorityEpoch) throw new PolicyStale('interaction scope epoch changed');
      let generation = '0';
      if (change.action === 'block') {
        const count = await client.query<{ n: string }>(`SELECT count(*) AS n FROM access.interaction_block
          WHERE recipient_subject = $1 AND active`, [recipient]);
        if (Number(count.rows[0]!.n) >= MAX_ACTIVE_BLOCKS) throw new PolicyUnavailable('block capacity is exhausted');
        const target = change.target;
        await client.query(`INSERT INTO access.interaction_block (id, recipient_subject, scope_id,
            target_kind, target_subject, set_kind, set_owner_subject, basis, interactions,
            set_by_principal, set_by_representation_id, set_by_representation_generation)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [change.blockId, recipient,
          scope, target.kind, target.kind === 'agent' ? target.subject : null,
          target.kind === 'member-set' ? target.setKind : null,
          target.kind === 'member-set' ? target.setOwnerSubject : null,
          target.kind === 'member-set' ? target.basis : null, change.interactions, identity.id,
          mandate.id, mandate.generation]);
      } else {
        const block = (await client.query<{ generation: string; active: boolean }>(`SELECT generation,
          active FROM access.interaction_block WHERE id = $1 AND recipient_subject = $2 FOR UPDATE`,
        [change.blockId, recipient])).rows[0];
        if (!block) throw new PolicyDenied('block is unavailable to recipient');
        if (block.generation !== change.expectedGeneration) throw new PolicyStale('block changed');
        generation = block.active ? (await client.query<{ generation: string }>(`UPDATE
          access.interaction_block SET active = false WHERE id = $1 RETURNING generation`,
        [change.blockId])).rows[0]!.generation : block.generation;
      }
      const authorityEpoch = await advanceScopeEpoch(client, scope);
      await client.query(`INSERT INTO access.interaction_change_receipt (principal_id,
          idempotency_key, request_digest, action, block_id, result_authority_epoch)
        VALUES ($1, $2, $3, $4, $5, $6)`, [identity.id, key.idempotencyKey, key.requestDigest,
        change.action, change.blockId, authorityEpoch]);
      return { blockId: change.blockId, generation, authorityEpoch, replayed: false };
    });
  }

  /** Interaction admission only: blocks of the recipient against this principal
   * and its selected actor, decided in one snapshot. Mutes and policies are not read. */
  async decide(principal: VerifiedPrincipal, recipient: string, interaction: InteractionKind,
    actingSubject: string): Promise<{ decisionId: string; result: 'allow' | 'deny' | 'unavailable';
      authorityEpoch: string; expiresAt: string }> {
    if (!agentPattern.test(recipient) || !agentPattern.test(actingSubject)
      || !INTERACTION_KINDS.includes(interaction)) {
      throw new PolicyInvalid('invalid interaction decision');
    }
    const scope = interactionScope(recipient);
    await this.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    return inAccessTransaction(this.pool, 'repeatable read', async client => {
      const recoveryGeneration = await requireRecoveryOpen(client, false);
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const identity = await findPrincipal(client, principal);
      const actor = (await client.query<{ generation: string }>(`SELECT generation FROM
        access.authority_subject WHERE id = $1 AND active`, [actingSubject])).rows[0];
      const recipientRow = (await client.query(`SELECT 1 FROM access.authority_subject
        WHERE id = $1 AND active`, [recipient])).rows[0];
      const action = `interaction.${interaction}`;
      const mandate = identity?.active && actor && (await client.query<{ id: string; generation: string }>(`
        SELECT id, generation FROM access.representation WHERE principal_id = $1 AND subject_id = $2
          AND action = $3 AND active AND valid_until > $4 ORDER BY id LIMIT 1`,
      [identity.id, actingSubject, action, now])).rows[0];
      if (!identity || !actor || !recipientRow || !mandate) {
        throw new PolicyDenied('acting subject is not admitted for this interaction');
      }
      const gate = (await client.query<{ authority_epoch: string; group_generation: string; open: boolean }>(
        'SELECT authority_epoch, group_generation, open FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!;
      const inputs = new FrameInputs();
      inputs.add({ role: 'guard', kind: 'representation', observed: 'present', id: mandate.id,
        generation: mandate.generation });
      let outcome: 'allow' | 'deny' | 'indeterminate' = gate.open ? 'allow' : 'deny';
      let reason: 'interaction-permitted' | 'interaction-blocked' | 'scope-closed' | 'budget-exhausted'
        = gate.open ? 'interaction-permitted' : 'scope-closed';
      try {
        const blocks = gate.open ? (await client.query<InteractionBlockRow>(`SELECT * FROM
          access.interaction_block WHERE recipient_subject = $1 AND active AND $2 = ANY(interactions)
          ORDER BY id LIMIT ${MAX_ACTIVE_BLOCKS + 1}`, [recipient, interaction])).rows : [];
        if (blocks.length > MAX_ACTIVE_BLOCKS) throw new BudgetExhausted('block budget exhausted');
        for (const block of blocks) {
          let matches: boolean;
          if (block.target_kind === 'agent') matches = block.target_subject === actingSubject;
          else {
            const member = (await client.query<{ id: string; generation: string; state: string }>(
              block.basis === 'acting_subject'
                ? `SELECT id, generation, state FROM access.membership
                    WHERE kind = $1 AND owner_subject = $2 AND member_subject = $3`
                : `SELECT id, generation, state FROM access.private_membership
                    WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3`,
              [block.set_kind, block.set_owner_subject,
                block.basis === 'acting_subject' ? actingSubject : identity.id])).rows[0];
            inputs.add({ role: 'condition', kind: block.basis === 'acting_subject'
              ? 'membership' : 'private_membership', observed: member ? 'present' : 'absent',
            id: member?.id ?? null, generation: member?.generation ?? null,
            setKind: block.set_kind, setOwner: block.set_owner_subject });
            matches = member?.state === 'joined';
          }
          inputs.add({ role: 'condition', kind: 'interaction_block', observed: 'present',
            id: block.id, generation: block.generation });
          if (matches) {
            outcome = 'deny';
            reason = 'interaction-blocked';
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        outcome = 'indeterminate';
        reason = 'budget-exhausted';
      }
      const decisionId = randomUUID();
      const expiresAt = new Date(now.getTime() + 60_000);
      await insertFrame(client, { id: decisionId, kind: 'interaction', principalId: identity.id,
        principalEpoch: identity.enforcement_epoch, actingSubject, actingSubjectGeneration: actor.generation,
        // Legacy frame metadata only; any group authority belongs in exact inputs.
        action, scopeId: scope, authorityEpoch: gate.authority_epoch, groupGeneration: gate.group_generation,
        recoveryGeneration, policyId: null, policyRevision: null, recipientSubject: recipient, outcome,
        publicResult: publicDecisionResult(outcome), reason, deciding: null, trace: [],
        evaluatedStates: inputs.list.length, evaluatedRows: inputs.list.length, reusable: false,
        decidedAt: now, expiresAt }, inputs);
      return { decisionId, result: publicDecisionResult(outcome), authorityEpoch: gate.authority_epoch,
        expiresAt: expiresAt.toISOString() };
    });
  }
}
