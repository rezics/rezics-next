import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import {
  AGENT_ACCESS_COST,
  ACCEPT_ACTION,
  type InvitationIssuerLifetime,
  type InvitationOffer,
} from './invitation-schema.ts';
import { acceptControllerInvitation } from './agent-control.ts';
import { drainRevokedAuthority } from './policy-transaction.ts';
import { realmPermissions, type RealmPermission } from '../realm-admin/contract.ts';
import { TOPOLOGY_SCOPE } from './topology-schema.ts';
import {
  ControlDenied,
  ControlInvalid,
  ControlStale,
  type ControlReceipt,
  WORK_SCOPE,
  agentPattern,
  bumpEpoch,
  controlTransaction,
  generationPattern,
  idPattern,
  lockGate,
  mandateFor,
  receipted,
  requireAgent,
  requireCeiling,
  requireMandate,
  requirePrincipal,
  requireReceipt,
} from './topology-control.ts';

export const ISSUE_ACTION = 'access.invitation.issue';
const ASSIGN = 'access.grant.assign.work.create';
const GRANT_ACTION = 'work.create';
const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60_000;
export class InvitationExpired extends Error {}

export interface InvitationView extends Record<string, unknown> {
  invitationId: string;
  issuerSubject: string;
  recipientSubject: string;
  action: string;
  grantValidUntil: string;
  issuerLifetime: InvitationIssuerLifetime;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  grantId: string | null;
  offer: InvitationOffer;
  actions: string[];
  scopeId: string;
  edgeId: string | null;
  controllerRepresentationId: string | null;
  revocationIds?: string[];
}
type InvitationRow = {
  issuer_subject: string;
  recipient_subject: string;
  action: string;
  offer: InvitationOffer;
  actions: string[];
  scope_id: string;
  grant_valid_until: Date;
  issuer_lifetime: InvitationIssuerLifetime;
  expires_at: Date;
  issued_by_principal: string;
  issuer_representation_id: string;
  issuer_representation_action: string;
  issuer_representation_generation: string;
  ceiling_grant_id: string;
  ceiling_grant_generation: string;
  grant_id: string | null;
  revoked: boolean;
  edge_id: string | null;
  controller_representation_id: string | null;
  accepted_by_principal: string | null;
};

const selection = `SELECT i.*,a.grant_id,a.edge_id,a.controller_representation_id,a.accepted_by_principal,
  (r.invitation_id IS NOT NULL) AS revoked FROM access.agent_invitation i
  LEFT JOIN access.agent_invitation_acceptance a ON a.invitation_id = i.id
  LEFT JOIN access.agent_invitation_revocation r ON r.invitation_id = i.id`;

async function invitationRow(client: PoolClient, id: string, lock = false): Promise<InvitationRow> {
  const row = await client.query<InvitationRow>(
    `${selection}
    WHERE i.id = $1 ${lock ? 'FOR UPDATE OF i' : ''}`,
    [id],
  );
  if (!row.rows[0]) throw new ControlDenied('invitation is unavailable');
  return row.rows[0];
}

function view(id: string, row: InvitationRow): InvitationView {
  return {
    invitationId: id,
    issuerSubject: row.issuer_subject,
    recipientSubject: row.recipient_subject,
    action: row.action,
    offer: row.offer,
    actions: row.actions,
    scopeId: row.scope_id,
    edgeId: row.edge_id,
    controllerRepresentationId: row.controller_representation_id,
    grantValidUntil: row.offer === 'control' ? 'infinity' : row.grant_valid_until.toISOString(),
    issuerLifetime: row.issuer_lifetime,
    expiresAt: row.expires_at.toISOString(),
    grantId: row.grant_id,
    status: row.revoked
      ? 'revoked'
      : row.grant_id || row.edge_id || row.controller_representation_id
        ? 'accepted'
        :row.expires_at.getTime() <= Date.now()
          ? 'expired'
          : 'pending',
  };
}

/** The controller's ceiling covers this Agent's resources only. An ownership
 * bootstrap is a server-read creation fact, not a caller-selected label. */
async function requireOwnedScope(client: PoolClient, issuer: string, scope: string) {
  if (scope === `content:draft:${issuer}`) return;
  const realm =
    /^(?:governance:realm:|review:decide:|publication:adopt:)(https:\/\/rezics\.com\/id\/[0-9a-f-]{36})$/.exec(
      scope,
    )?.[1];
  if (
    !realm ||
    !(
      await client.query(
        `SELECT 1 FROM access.realm_admin_owner_bootstrap
    WHERE realm = $1 AND owner_subject = $2`,
        [realm, issuer],
      )
    ).rowCount
  ) {
    throw new ControlDenied('management scope is outside this Agent’s resources');
  }
}

type OfferInput = {
  invitationId: string;
  issuerSubject: string;
  recipientSubject: string;
  grantValidUntil?: Date;
  issuerLifetime: InvitationIssuerLifetime;
  expectedAuthorityEpoch: string;
  offer: InvitationOffer;
  actions?: string[];
  scopeId?: string;
  expiresAt?: Date;
};

/** Object invitations (IAM12). The recipient is a stable Agent IRI that may be
 * cataloged but not admitted; only a principal holding that Agent's current
 * accept mandate activates it, and the grant goes to the Agent. */
export class AccessInvitations {
  constructor(private readonly pool: Pool) {}

  /** O(actions) indexed ceiling probes and inserts, with no principal roster.
   * Control needs no permission_grant; use of publishing/resource rights still
   * requires each exact live grant held by the issuing Agent. */
  private async issueOffer(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    input: OfferInput,
  ) {
    const scope = input.scopeId ?? WORK_SCOPE;
    const actions = input.offer === 'control' ? ['agent.control'] : (input.actions ?? []);
    const expiresAt = input.expiresAt ?? new Date( Date.now() + INVITATION_LIFETIME_MS);
    if (
      !idPattern.test(input.invitationId) ||
      !agentPattern.test(input.issuerSubject) ||
      !agentPattern.test(input.recipientSubject) ||
      input.issuerSubject === input.recipientSubject ||
      !['institutional', 'operator-dependent'].includes(input.issuerLifetime) ||
      !['control', 'represent', 'manage'].includes(input.offer) ||
      !generationPattern.test(input.expectedAuthorityEpoch) ||
      !scope ||
      scope.length > 256 ||
      !actions.length ||
      actions.length > AGENT_ACCESS_COST.actions ||
      new Set(actions).size !== actions.length ||
      actions.some((a) => !/^[a-z][a-z0-9.-]{0,127}$/.test(a)) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      expiresAt.getTime() > Date.now() + 30 * 24 * 60 * 60_000 ||
      (input.offer !== 'control' &&
        (!input.grantValidUntil ||
          !Number.isFinite(input.grantValidUntil.getTime()) ||
          input.grantValidUntil <= expiresAt)) ||
      (input.offer === 'control' &&
        (input.actions !== undefined ||
          input.grantValidUntil !== undefined ||
          scope !== WORK_SCOPE)) ||
      (input.offer === 'represent' &&
        (scope !== WORK_SCOPE || actions.length !== 1 || actions[0] !== 'work.create'))
    ) {
      throw new ControlInvalid('invalid Agent invitation offer');
    }
    return controlTransaction(this.pool, async (client) => {
      const epoch = await lockGate(client, scope, false);
      const actor = await requirePrincipal(client, principal);
      return receipted<InvitationView>(
        client,
        actor.id,
        receipt,
        'agent-invitation',
        'issue',
        input.issuerSubject,
        input.invitationId,
        async () => {
          if (epoch !== input.expectedAuthorityEpoch)
            throw new ControlStale('scope authority epoch changed');
          const mandate = await requireMandate(
            client,
            actor.id,
            input.issuerSubject,
            'agent.control',
          );
          const person = await client.query(
            `SELECT 1 FROM access.agent_provision
          WHERE agent_id = $1 AND agent_kind = 'person' AND state = 'active'`,
            [input.recipientSubject],
          );
          if (!person.rowCount) throw new ControlDenied('recipient needs an admitted Person Agent');
          if (input.offer === 'manage') {
            await requireOwnedScope(client, input.issuerSubject, scope);
            if (
              actions.some(
                (a) => a !== 'content.draft' && !realmPermissions.includes(a as RealmPermission),
              )
            ) {
              throw new ControlInvalid(
                'management action is outside the installed resource profile',
              );
            }
          }
          let ceiling: { id: string; generation: string } | null = null;
          for (const action of input.offer === 'control' ? [] : actions) {
            const checked = await requireCeiling(
              client,
              input.issuerSubject,
              action,
              input.grantValidUntil,
              scope,
            );
            ceiling ??= checked;
          }
          await client.query(
            `INSERT INTO access.agent_invitation (id,issuer_subject,recipient_subject,
          scope_id,action,offer,actions,grant_valid_until,issuer_lifetime,issued_by_principal,
          issuer_representation_id,issuer_representation_generation,issuer_representation_action,
          ceiling_grant_id,ceiling_grant_generation,ceiling_scope_id,ceiling_action,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'agent.control',$13,$14,$4,$5,$15)`,
            [
              input.invitationId,
              input.issuerSubject,
              input.recipientSubject,
              scope,
              actions[0],
              input.offer,
              actions,
              input.offer === 'control' ? 'infinity' : input.grantValidUntil,
              input.issuerLifetime,
              actor.id,
              mandate.id,
              mandate.generation,
              ceiling?.id ?? null,
              ceiling?.generation ?? null,
              expiresAt,
            ],
          );
          return { epoch, result: view(input.invitationId, await invitationRow(client,
            input.invitationId)) };
        },
      );
    });
  }

  private async acceptOffer(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    input: {
      invitationId: string;
      grantId?: string;
      edgeId?: string;
      representationId?: string;
      expectedAuthorityEpoch?: string;
    },
  ) {
    const ids = [input.grantId, input.edgeId, input.representationId].filter(
      (id) => id !== undefined,
    );
    if (
      ids.length !== 1 ||
      ids.some((id) => !idPattern.test(id)) ||
      !input.expectedAuthorityEpoch ||
      !generationPattern.test(input.expectedAuthorityEpoch)
    )
      throw new ControlInvalid('acceptance needs one authority ID and expected epoch');
    return controlTransaction(this.pool, async (client) => {
      const initial = await invitationRow(client, input.invitationId);
      // Control and Work invitations always take Work before topology. Scoped
      // management creates no edges, so it needs no topology write lock.
      const epoch = await lockGate(client, initial.scope_id, true);
      if (initial.offer !== 'manage') await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      return receipted<InvitationView & { authorityEpoch: string }>(
        client,
        actor.id,
        receipt,
        'agent-invitation',
        'accept',
        null,
        input.invitationId,
        async () => {
          const row = await invitationRow(client, input.invitationId, true);
          const acceptor = await requireMandate(
            client,
            actor.id,
            row.recipient_subject,
            'agent.control',
          );
          if (row.grant_id || row.edge_id || row.controller_representation_id || row.revoked) throw new ControlStale('invitation already has an outcome');
          if (row.expires_at.getTime() <= Date.now())
            throw new InvitationExpired('invitation expired');
          if (input.expectedAuthorityEpoch !== epoch)
            throw new ControlStale('scope authority epoch changed');
          if (
            row.offer === 'control'
              ? !input.representationId
              : row.offer === 'represent'
                ? !input.edgeId
                : !input.grantId
          )
            throw new ControlInvalid('acceptance needs the offered authority kind');
          if (row.issuer_lifetime === 'operator-dependent') {
            const original = await client.query(
              `SELECT 1 FROM access.representation r JOIN access.principal p ON p.id = r.principal_id AND p.active
              WHERE r.id = $1 AND r.active AND r.generation = $2 FOR SHARE OF r,p`,
              [row.issuer_representation_id, row.issuer_representation_generation],
            );
            if (!original.rowCount) throw new ControlStale('invitation issuing mandate ended');
          }
          const recipientGeneration = await requireAgent(client, row.recipient_subject);
          await requireAgent(client, row.issuer_subject);
          if (row.offer === 'control') {
            await acceptControllerInvitation(
              client,
              input.invitationId,
              row.issuer_subject,
              row.recipient_subject,
              row.issued_by_principal,
              actor.id,
              acceptor,
              input.representationId!,
              epoch,
              row.expires_at,
            );
          } else {
            if (row.offer === 'manage')
              await requireOwnedScope(client, row.issuer_subject, row.scope_id);
            for (const [index, action] of row.actions.entries()) {
              const id = index === 0 ? (input.edgeId ?? input.grantId)! : randomUUID();
              const ceiling = await requireCeiling(
                client,
                row.issuer_subject,
                action,
                row.grant_valid_until,
                row.scope_id,
              );
              if (row.offer === 'represent') {
                await client.query(
                  `INSERT INTO access.representation_edge (id,representative_subject,represented_subject,
                  action,max_path_edges,valid_until,assigned_by_principal,issuer_representation_id,issuer_representation_generation,
                  issuer_representation_action,ceiling_grant_id,ceiling_grant_generation,ceiling_scope_id,ceiling_action,invitation_id)
                  VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,'agent.control',$9,$10,$11,$4,$12)`,
                  [
                    id,
                    row.recipient_subject,
                    row.issuer_subject,
                    action,
                    row.grant_valid_until,
                    row.issued_by_principal,
                    row.issuer_representation_id,
                    row.issuer_representation_generation,
                    ceiling.id,
                    ceiling.generation,
                    row.scope_id,
                    input.invitationId,
                  ],
                );
              } else {
                await client.query(
                  `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
                  VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                  [
                    id,
                    row.issuer_subject,
                    row.recipient_subject,
                    row.scope_id,
                    action,
                    row.grant_valid_until,
                    row.issued_by_principal,
                  ],
                );
                await client.query(
                  `INSERT INTO access.grant_lineage (grant_id,issuer_subject,recipient_subject,scope_id,action,lifetime,
                  assigned_by_principal,issuer_representation_id,issuer_representation_generation,issuer_representation_action,
                  ceiling_grant_id,ceiling_grant_generation,ceiling_scope_id,ceiling_action,root_grant_id,depth,redelegation_depth,invitation_id)
                  VALUES ($1,$2,$3,$4,$5,'institutional',$6,$7,$8,'agent.control',$9,$10,$4,$5,$1,0,0,$11)`,
                  [
                    id,
                    row.issuer_subject,
                    row.recipient_subject,
                    row.scope_id,
                    action,
                    row.issued_by_principal,
                    row.issuer_representation_id,
                    row.issuer_representation_generation,
                    ceiling.id,
                    ceiling.generation,
                    input.invitationId,
                  ],
                );
              }
            }
          }
          await client.query(
            `INSERT INTO access.agent_invitation_acceptance (invitation_id,issuer_subject,recipient_subject,scope_id,action,
            accepted_by_principal,acceptor_representation_id,acceptor_representation_generation,acceptor_representation_action,
            recipient_generation,grant_id,edge_id,controller_representation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'agent.control',$9,$10,$11,$12)`,
            [
              input.invitationId,
              row.issuer_subject,
              row.recipient_subject,
              row.scope_id,
              row.action,
              actor.id,
              acceptor.id,
              acceptor.generation,
              recipientGeneration,
              input.grantId ?? null,
              input.edgeId ?? null,
              input.representationId ?? null,
            ],
          );
          const authorityEpoch = await bumpEpoch(client, row.scope_id);
          return { epoch: authorityEpoch, result: { ...view(input.invitationId,
            await invitationRow(client, input.invitationId)), authorityEpoch } };
        },
      );
    });
  }

  private async revokeOffer(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    id: string,
    expectedEpoch?: string,
  ) {
    if (!expectedEpoch || !generationPattern.test(expectedEpoch))
      throw new ControlInvalid('revocation needs expected authority epoch');
    return controlTransaction(this.pool, async (client) => {
      const initial = await invitationRow(client, id);
      const epoch = await lockGate(client, initial.scope_id, true);
      if (initial.offer !== 'manage') await lockGate(client, TOPOLOGY_SCOPE, true);
      const actor = await requirePrincipal(client, principal);
      return receipted<InvitationView>(
        client,
        actor.id,
        receipt,
        'agent-invitation',
        'revoke',
        null,
        id,
        async () => {
          const row = await invitationRow(client, id, true);
          await requireMandate(client, actor.id, row.issuer_subject, 'agent.control');
          if (epoch !== expectedEpoch)
            throw new ControlStale('scope authority epoch changed');
          if (row.revoked) throw new ControlStale('invitation already revoked');
          await bumpEpoch(client, row.scope_id);
          const revocationIds: string[] = [];
          const grants = (
            await client.query<{ id: string }>(
              `SELECT g.id FROM access.permission_grant g
          JOIN access.grant_lineage l ON l.grant_id = g.id WHERE l.invitation_id = $1 AND g.active
          ORDER BY g.id LIMIT $2 FOR UPDATE OF g`,
              [id, AGENT_ACCESS_COST.actions + 1],
            )
          ).rows;
          if (grants.length > AGENT_ACCESS_COST.actions)
            throw new ControlInvalid('invitation exceeds its mutation budget');
          for (const grant of grants) {
            const removed = (
              await client.query<{ generation: string }>(
                `UPDATE access.permission_grant SET active = false WHERE id = $1 RETURNING generation`,
                [grant.id],
              )
            ).rows[0]!;
            revocationIds.push(
              await drainRevokedAuthority(
                client,
                actor.id,
                row.issuer_subject,
                'permission_grant',
                grant.id,
                removed.generation,
                row.scope_id,
              ),
            );
          }
          const edges = (
            await client.query<{ id: string; generation: string }>(
              `UPDATE access.representation_edge
          SET active = false WHERE invitation_id = $1 AND active RETURNING id,generation`,
              [id],
            )
          ).rows;
          for (const edge of edges)
            revocationIds.push(
              await drainRevokedAuthority(
                client,
                actor.id,
                row.issuer_subject,
                'representation_edge',
                edge.id,
                edge.generation,
                row.scope_id,
              ),
            );
          if (row.controller_representation_id) {
            const removed = (
              await client.query<{ generation: string }>(
                `UPDATE access.representation SET active = false
            WHERE id = $1 AND active RETURNING generation`,
                [row.controller_representation_id],
              )
            ).rows[0];
            if (removed)
              revocationIds.push(
                await drainRevokedAuthority(
                  client,
                  actor.id,
                  row.issuer_subject,
                  'representation',
                  row.controller_representation_id,
                  removed.generation,
                  row.scope_id,
                ),
              );
          }
          await client.query(
            `INSERT INTO access.agent_invitation_revocation (invitation_id,revoked_by_principal) VALUES ($1,$2)`,
            [id, actor.id],
          );
          const authorityEpoch = await lockGate(client, row.scope_id, true);
          return {
            epoch: authorityEpoch,
            result: { ...view(id, await invitationRow(client, id)), revocationIds },
          };
        },
      );
    });
  }

  /** Keyset reads never turn a page budget into a complete inventory. */
  async addressed(principal: VerifiedPrincipal, after?: string) {
    if (after && !idPattern.test(after)) throw new ControlInvalid('invalid invitation page');
    return controlTransaction(this.pool, async (client) => {
      const actor = await requirePrincipal(client, principal);
      // Probe the recipient index for the caller's own Agent inventory. A
      // global UUID scan would visit unrelated invitations to find this page.
      // Cost scales with that inventory and 51 candidates per owned Agent.
      const rows = (
        await client.query<InvitationRow & { id: string; epoch: string }>(
          `SELECT page.* FROM (
        SELECT DISTINCT m.subject_id FROM access.representation m
        JOIN access.authority_subject s ON s.id = m.subject_id AND s.active
        WHERE m.principal_id = $1 AND m.action IN ('agent.control','access.invitation.accept')
          AND m.active AND m.valid_until > clock_timestamp()) recipients CROSS JOIN LATERAL (
        ${selection.replace('SELECT i.*', 'SELECT g.authority_epoch AS epoch,i.*')}
        JOIN access.scope_gate g ON g.id = i.scope_id WHERE i.recipient_subject = recipients.subject_id
          AND ($2::uuid IS NULL OR i.id > $2) ORDER BY i.id LIMIT $3) page ORDER BY page.id LIMIT $3`,
          [actor.id, after ?? null, AGENT_ACCESS_COST.page + 1],
        )
      ).rows;
      return {
        items: rows
          .slice(0, AGENT_ACCESS_COST.page)
          .map((row) => ({
            ...view(row.id, row),
            authorityEpoch: row.epoch,
            controllerRepresentationId:
              row.accepted_by_principal === actor.id ? row.controller_representation_id : null,
          })),
        nextCursor:
          rows.length > AGENT_ACCESS_COST.page ? rows[AGENT_ACCESS_COST.page - 1]!.id : null,
      };
    });
  }

  async access(principal: VerifiedPrincipal, subject: string, after?: string) {
    if (!agentPattern.test(subject) || (after && !idPattern.test(after)))
      throw new ControlInvalid('invalid Agent access page');
    return controlTransaction(this.pool, async (client) => {
      const authorityEpoch = await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, subject, 'agent.control');
      const own = (
        await client.query<{ id: string; generation: string }>(
          `SELECT id,generation FROM access.representation
        WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control' AND active ORDER BY id LIMIT 17`,
          [actor.id, subject],
        )
      ).rows;
      const other = (
        await client.query<{ count: string }>(
          `SELECT count(*) FROM (SELECT DISTINCT r.principal_id FROM access.representation r
        JOIN access.principal p ON p.id = r.principal_id AND p.active WHERE r.subject_id = $1 AND r.action = 'agent.control'
          AND r.active AND r.principal_id <> $2 LIMIT 17) controllers`,
          [subject, actor.id],
        )
      ).rows[0]!.count;
      const rows = (
        await client.query<InvitationRow & { id: string; epoch: string }>(
          `${selection.replace('SELECT i.*', 'SELECT g.authority_epoch AS epoch,i.*')}
        JOIN access.scope_gate g ON g.id = i.scope_id WHERE i.issuer_subject = $1 AND ($2::uuid IS NULL OR i.id > $2)
        ORDER BY i.id LIMIT $3`,
          [subject, after ?? null, AGENT_ACCESS_COST.page + 1],
        )
      ).rows;
      const items = rows
        .slice(0, AGENT_ACCESS_COST.page)
        .map((row) => ({
          ...view(row.id, row),
          authorityEpoch: row.epoch,
          controllerRepresentationId: own.some((m) => m.id === row.controller_representation_id)
            ? row.controller_representation_id
            : null,
        }));
      return {
        subjectId: subject,
        authorityEpoch,
        you: own.map((m) => ({ representationId: m.id, generation: m.generation })),
        otherControllers: Number(other),
        items,
        nextCursor:
          rows.length > AGENT_ACCESS_COST.page ? rows[AGENT_ACCESS_COST.page - 1]!.id : null,
      };
    });
  }

  async issue(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    input: {
      invitationId: string;
      issuerSubject: string;
      recipientSubject: string;
      grantValidUntil?: Date;
      issuerLifetime: InvitationIssuerLifetime;
      expectedAuthorityEpoch: string;
      offer?: InvitationOffer;
      actions?: string[];
      scopeId?: string;
      expiresAt?: Date;
    },
  ): Promise<InvitationView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (input.offer) return this.issueOffer(principal, receipt, { ...input, offer: input.offer });
    const validUntil = input.grantValidUntil;
    if (
      !idPattern.test(input.invitationId) ||
      !agentPattern.test(input.issuerSubject) ||
      !agentPattern.test(input.recipientSubject) ||
      input.issuerSubject === input.recipientSubject ||
      !['institutional', 'operator-dependent'].includes(input.issuerLifetime) ||
      !generationPattern.test(input.expectedAuthorityEpoch) ||
      !validUntil ||
      Number.isNaN(validUntil.getTime())
    ) {
      throw new ControlInvalid('invalid invitation');
    }
    return controlTransaction(this.pool, async (client) => {
      const epoch = await lockGate(client, WORK_SCOPE, false);
      const actor = await requirePrincipal(client, principal);
      const mandate = await requireMandate(client, actor.id, input.issuerSubject, ISSUE_ACTION);
      return receipted<InvitationView>(
        client,
        actor.id,
        receipt,
        'agent-invitation',
        'issue',
        input.issuerSubject,
        input.invitationId,
        async () => {
          if (epoch !== input.expectedAuthorityEpoch) {
            throw new ControlStale('scope authority epoch changed');
          }
          const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
          if (validUntil <= expiresAt) {
            throw new ControlInvalid('offered grant must outlast the invitation');
          }
          const ceiling = await requireCeiling(client, input.issuerSubject, ASSIGN, validUntil);
          await client.query(
            `INSERT INTO access.agent_invitation (id, issuer_subject,
            recipient_subject, scope_id, action, grant_valid_until, issuer_lifetime,
            issued_by_principal, issuer_representation_id, issuer_representation_generation,
            issuer_representation_action, ceiling_grant_id, ceiling_grant_generation,
            ceiling_scope_id, ceiling_action, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$4,$14,$15)`,
            [
              input.invitationId,
              input.issuerSubject,
              input.recipientSubject,
              WORK_SCOPE,
              GRANT_ACTION,
              validUntil,
              input.issuerLifetime,
              actor.id,
              mandate.id,
              mandate.generation,
              ISSUE_ACTION,
              ceiling.id,
              ceiling.generation,
              ASSIGN,
              expiresAt,
            ],
          );
          return { epoch, result: view(input.invitationId, await invitationRow(client,
            input.invitationId)) };
        },
      );
    });
  }

  /** The issuer's operators and the recipient's accepting representatives read it. */
  async read(principal: VerifiedPrincipal, invitationId: string): Promise<InvitationView> {
    if (!idPattern.test(invitationId)) throw new ControlInvalid('invalid invitation read');
    return controlTransaction(this.pool, async (client) => {
      const actor = await requirePrincipal(client, principal);
      const row = await invitationRow(client, invitationId);
      if (
        !(await mandateFor(client, actor.id, row.issuer_subject, ISSUE_ACTION)) &&
        !(await mandateFor(client, actor.id, row.issuer_subject, 'agent.control')) &&
        !(await mandateFor(client, actor.id, row.recipient_subject, 'agent.control')) &&
        !(await mandateFor(client, actor.id, row.recipient_subject, ACCEPT_ACTION))
      ) {
        throw new ControlDenied('invitation is unavailable');
      }
      return {
        ... view(invitationId, row),
        controllerRepresentationId:
          row.accepted_by_principal === actor.id ? row.controller_representation_id : null,
      };
    });
  }

  async accept(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    input: {
      invitationId: string;
      grantId?: string;
      edgeId?: string;
      representationId?: string;
      expectedAuthorityEpoch?: string;
    },
  ): Promise<
    InvitationView & {
      authorityEpoch: string;
      replayed: boolean;
    }
  > {
    requireReceipt(receipt);
    if (!idPattern.test(input.invitationId))
      throw new ControlInvalid('invalid invitation acceptance');
    const offered = (
      await this.pool.query<{ product: boolean }>(
        `SELECT
      issuer_representation_action = 'agent.control' AS product FROM access.agent_invitation WHERE id = $1`,
        [input.invitationId],
      )
    ).rows[0];
    if (offered?.product) return this.acceptOffer(principal, receipt, input);
    const grantId = input.grantId;
    if (!grantId || !idPattern.test(grantId) || input.edgeId || input.representationId) {
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

  async revoke(
    principal: VerifiedPrincipal,
    receipt: ControlReceipt,
    invitationId: string,
    expectedAuthorityEpoch?: string,
  ): Promise<InvitationView & { replayed: boolean }> {
    requireReceipt(receipt);
    if (!idPattern.test(invitationId)) throw new ControlInvalid('invalid invitation revocation');
    const offered = (
      await this.pool.query<{ product: boolean }>(
        `SELECT
      issuer_representation_action = 'agent.control' AS product FROM access.agent_invitation WHERE id = $1`,
        [invitationId],
      )
    ).rows[0];
    if (offered?.product)
      return this.revokeOffer(principal, receipt, invitationId, expectedAuthorityEpoch);
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
