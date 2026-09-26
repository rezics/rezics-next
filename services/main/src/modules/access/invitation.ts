import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { ACCEPT_ACTION, type InvitationIssuerLifetime } from './invitation-schema.ts';
import { ControlDenied, ControlInvalid, ControlStale, type ControlReceipt, WORK_SCOPE,
  agentPattern, bumpEpoch, controlTransaction, generationPattern, idPattern, lockGate,
  mandateFor, receipted, requireCeiling, requireMandate, requirePrincipal, requireReceipt }
  from './topology-control.ts';

export const ISSUE_ACTION = 'access.invitation.issue';
const ASSIGN = 'access.grant.assign.work.create';
const GRANT_ACTION = 'work.create';
const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60_000;

export interface InvitationView extends Record<string, unknown> {
  invitationId: string; issuerSubject: string; recipientSubject: string; action: string;
  grantValidUntil: string; issuerLifetime: InvitationIssuerLifetime; expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired'; grantId: string | null;
}
type InvitationRow = { issuer_subject: string; recipient_subject: string; action: string;
  grant_valid_until: Date; issuer_lifetime: InvitationIssuerLifetime; expires_at: Date;
  issued_by_principal: string; issuer_representation_id: string;
  issuer_representation_generation: string; ceiling_grant_id: string;
  ceiling_grant_generation: string; grant_id: string | null; revoked: boolean };

async function invitationRow(client: PoolClient, id: string, lock = false): Promise<InvitationRow> {
  const row = await client.query<InvitationRow>(`SELECT i.issuer_subject, i.recipient_subject,
    i.action, i.grant_valid_until, i.issuer_lifetime, i.expires_at, i.issued_by_principal,
    i.issuer_representation_id, i.issuer_representation_generation, i.ceiling_grant_id,
    i.ceiling_grant_generation, a.grant_id, (r.invitation_id IS NOT NULL) AS revoked
    FROM access.agent_invitation i
    LEFT JOIN access.agent_invitation_acceptance a ON a.invitation_id = i.id
    LEFT JOIN access.agent_invitation_revocation r ON r.invitation_id = i.id
    WHERE i.id = $1 ${lock ? 'FOR UPDATE OF i' : ''}`, [id]);
  if (!row.rows[0]) throw new ControlDenied('invitation is unavailable');
  return row.rows[0];
}

function view(id: string, row: InvitationRow): InvitationView {
  return { invitationId: id, issuerSubject: row.issuer_subject,
    recipientSubject: row.recipient_subject, action: row.action,
    grantValidUntil: row.grant_valid_until.toISOString(), issuerLifetime: row.issuer_lifetime,
    expiresAt: row.expires_at.toISOString(), grantId: row.grant_id,
    status: row.grant_id ? 'accepted' : row.revoked ? 'revoked'
      : row.expires_at.getTime() <= Date.now() ? 'expired' : 'pending' };
}

/** Object invitations (IAM12). The recipient is a stable Agent IRI that may be
 * cataloged but not admitted; only a principal holding that Agent's current
 * accept mandate activates it, and the grant goes to the Agent. */
export class AccessInvitations {
  constructor(private readonly pool: Pool) {}

  async issue(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    invitationId: string; issuerSubject: string; recipientSubject: string; grantValidUntil: Date;
    issuerLifetime: InvitationIssuerLifetime; expectedAuthorityEpoch: string }):
    Promise<InvitationView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.invitationId) || !agentPattern.test(input.issuerSubject)
      || !agentPattern.test(input.recipientSubject)
      || input.issuerSubject === input.recipientSubject
      || !['institutional', 'operator-dependent'].includes(input.issuerLifetime)
      || !generationPattern.test(input.expectedAuthorityEpoch)
      || Number.isNaN(input.grantValidUntil.getTime())) {
      throw new ControlInvalid('invalid invitation');
    }
    return controlTransaction(this.pool, async client => {
      const epoch = await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      const mandate = await requireMandate(client, actor.id, input.issuerSubject, ISSUE_ACTION);
      return receipted<InvitationView>(client, actor.id, receipt, 'agent-invitation', 'issue',
        input.issuerSubject, input.invitationId, async () => {
          if (epoch !== input.expectedAuthorityEpoch) {
            throw new ControlStale('scope authority epoch changed');
          }
          const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
          if (input.grantValidUntil <= expiresAt) {
            throw new ControlInvalid('offered grant must outlast the invitation');
          }
          const ceiling = await requireCeiling(client, input.issuerSubject, ASSIGN,
            input.grantValidUntil);
          await client.query(`INSERT INTO access.agent_invitation (id, issuer_subject,
            recipient_subject, scope_id, action, grant_valid_until, issuer_lifetime,
            issued_by_principal, issuer_representation_id, issuer_representation_generation,
            issuer_representation_action, ceiling_grant_id, ceiling_grant_generation,
            ceiling_scope_id, ceiling_action, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$4,$14,$15)`,
          [input.invitationId, input.issuerSubject, input.recipientSubject, WORK_SCOPE,
            GRANT_ACTION, input.grantValidUntil, input.issuerLifetime, actor.id, mandate.id,
            mandate.generation, ISSUE_ACTION, ceiling.id, ceiling.generation, ASSIGN, expiresAt]);
          return { epoch, result: view(input.invitationId, await invitationRow(client,
            input.invitationId)) };
        });
    });
  }

  /** The issuer's operators and the recipient's accepting representatives read it. */
  async read(principal: VerifiedPrincipal, invitationId: string): Promise<InvitationView> {
    if (!idPattern.test(invitationId)) throw new ControlInvalid('invalid invitation read');
    return controlTransaction(this.pool, async client => {
      const actor = await requirePrincipal(client, principal);
      const row = await invitationRow(client, invitationId);
      if (!await mandateFor(client, actor.id, row.issuer_subject, ISSUE_ACTION)
        && !await mandateFor(client, actor.id, row.recipient_subject, ACCEPT_ACTION)) {
        throw new ControlDenied('invitation is unavailable');
      }
      return view(invitationId, row);
    });
  }

  async accept(principal: VerifiedPrincipal, receipt: ControlReceipt, input: {
    invitationId: string; grantId: string }): Promise<InvitationView & {
      authorityEpoch: string; replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(input.invitationId) || !idPattern.test(input.grantId)) {
      throw new ControlInvalid('invalid invitation acceptance');
    }
    return controlTransaction(this.pool, async client => {
      await lockGate(client, WORK_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      return receipted<InvitationView & { authorityEpoch: string }>(client, actor.id, receipt,
        'agent-invitation', 'accept', null, input.invitationId, async () => {
          const row = await invitationRow(client, input.invitationId, true);
          // A profile editor, a matching display name or an Account alone holds no
          // accept mandate for this exact Agent, so it cannot activate the offer.
          const acceptor = await mandateFor(client, actor.id, row.recipient_subject, ACCEPT_ACTION);
          if (!acceptor) throw new ControlDenied('invitation needs the recipient Agent’s representative');
          if (row.grant_id || row.revoked) throw new ControlStale('invitation already has an outcome');
          if (row.expires_at.getTime() <= Date.now()) throw new ControlStale('invitation expired');
          const recipient = await client.query<{ generation: string }>(`SELECT generation
            FROM access.authority_subject WHERE id = $1 AND active FOR SHARE`,
          [row.recipient_subject]);
          let ceiling = { id: row.ceiling_grant_id, generation: row.ceiling_grant_generation };
          if (row.issuer_lifetime === 'institutional') {
            // Recheck the issuer Agent's current authority, not the sending operator's.
            ceiling = await requireCeiling(client, row.issuer_subject, ASSIGN,
              row.grant_valid_until);
          }
          await client.query(`INSERT INTO access.permission_grant (id, issuer_subject,
            recipient_subject, scope_id, action, valid_until, assigned_by_principal)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.grantId, row.issuer_subject,
            row.recipient_subject, WORK_SCOPE, row.action, row.grant_valid_until,
            row.issued_by_principal]);
          await client.query(`INSERT INTO access.grant_lineage (grant_id, issuer_subject,
            recipient_subject, scope_id, action, lifetime, assigned_by_principal,
            issuer_representation_id, issuer_representation_generation,
            issuer_representation_action, ceiling_grant_id, ceiling_grant_generation,
            ceiling_scope_id, ceiling_action, root_grant_id, depth, redelegation_depth,
            invitation_id) VALUES ($1,$2,$3,$4,$5,'institutional',$6,$7,$8,$9,$10,$11,$4,$12,
              $1,0,0,$13)`,
          [input.grantId, row.issuer_subject, row.recipient_subject, WORK_SCOPE, row.action,
            row.issued_by_principal, row.issuer_representation_id,
            row.issuer_representation_generation, ISSUE_ACTION, ceiling.id, ceiling.generation,
            ASSIGN, input.invitationId]);
          await client.query(`INSERT INTO access.agent_invitation_acceptance (invitation_id,
            issuer_subject, recipient_subject, scope_id, action, accepted_by_principal,
            acceptor_representation_id, acceptor_representation_generation,
            acceptor_representation_action, recipient_generation, grant_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [input.invitationId, row.issuer_subject, row.recipient_subject, WORK_SCOPE, row.action,
            actor.id, acceptor.id, acceptor.generation, ACCEPT_ACTION,
            recipient.rows[0]!.generation, input.grantId]);
          const authorityEpoch = await bumpEpoch(client, WORK_SCOPE);
          return { epoch: authorityEpoch, result: { ...view(input.invitationId,
            await invitationRow(client, input.invitationId)), authorityEpoch } };
        });
    });
  }

  async revoke(principal: VerifiedPrincipal, receipt: ControlReceipt,
    invitationId: string): Promise<InvitationView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(invitationId)) throw new ControlInvalid('invalid invitation revocation');
    return controlTransaction(this.pool, async client => {
      const epoch = await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      return receipted<InvitationView>(client, actor.id, receipt, 'agent-invitation', 'revoke',
        null, invitationId, async () => {
          const row = await invitationRow(client, invitationId, true);
          await requireMandate(client, actor.id, row.issuer_subject, ISSUE_ACTION);
          if (row.grant_id || row.revoked) throw new ControlStale('invitation already has an outcome');
          await client.query(`INSERT INTO access.agent_invitation_revocation (invitation_id,
            revoked_by_principal) VALUES ($1,$2)`, [invitationId, actor.id]);
          return { epoch, result: view(invitationId, await invitationRow(client, invitationId)) };
        });
    });
  }
}
