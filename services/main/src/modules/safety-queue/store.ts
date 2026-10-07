import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  GovernanceConflict,
  GovernanceDenied,
  GovernanceInvalid,
  GovernanceStale,
  GovernanceUnavailable,
  normalizeGovernanceError,
} from '../governance/store.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadExpired,
} from '../work/read-session.ts';
import { lockPreservationTarget } from '../public-report/preservation.ts';

export const SAFETY_QUEUE_COST = {
  page: 50,
  statementTimeoutMs: 5000,
  lockTimeoutMs: 2000,
  readStatements: 15,
  claimStatements: 21,
  holdStatements: 11,
} as const;
type Authority = (
  client: PoolClient,
  principal: VerifiedPrincipal,
  actor: string,
  action: string,
  lock?: boolean,
) => Promise<{ principalId: string }>;
export interface QueueFilter {
  actingSubject: string;
  urgent?: boolean;
  category?: string;
  contentLanguage?: string;
  dueBefore?: string;
  cursor?: string;
  limit?: number;
}

/** Platform authority and keyset traversal; no Realm grants contribute branches. */
export class SafetyQueue {
  constructor(
    private readonly pool: Pool,
    private readonly authority: Authority,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      if (
        !(
          await client.query(
            `SELECT 1 FROM access.recovery_fence WHERE id AND open${readOnly ? '' : ' FOR SHARE'}`,
          )
        ).rowCount
      ) {
        throw new GovernanceUnavailable('Access is held for recovery');
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof WorkReadInvalid) throw new GovernanceInvalid(error.message);
      if (error instanceof WorkReadExpired) throw new GovernanceStale(error.message);
      throw normalizeGovernanceError(error);
    } finally {
      client.release();
    }
  }

  private async actions(
    client: PoolClient,
    principal: VerifiedPrincipal,
    actor: string,
    lock = true,
  ) {
    const allowed: string[] = [];
    for (const [kind, action] of [
      ['content_report', 'governance.moderate'],
      ['rights_complaint', 'governance.rights.decide'],
    ]) {
      try {
        await this.authority(client, principal, actor!, action!, lock);
        allowed.push(kind!);
      } catch (error) {
        if (!(error instanceof GovernanceDenied)) throw error;
      }
    }
    if (!allowed.length) throw new GovernanceDenied('platform staff authority is required');
    return allowed;
  }

  async page(principal: VerifiedPrincipal, filter: QueueFilter) {
    const limit = filter.limit ?? SAFETY_QUEUE_COST.page;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SAFETY_QUEUE_COST.page ||
      (filter.dueBefore && Number.isNaN(Date.parse(filter.dueBefore)))
    )
      throw new GovernanceInvalid('invalid queue filter');
    return this.transaction(async (client) => {
      const kinds = await this.actions(client, principal, filter.actingSubject, false);
      let specialist = false;
      try {
        await this.authority(
          client,
          principal,
          filter.actingSubject,
          'governance.safety.evidence',
          false,
        );
        specialist = true;
      } catch (error) {
        if (!(error instanceof GovernanceDenied)) throw error;
      }
      const revision = (
        await client.query<{ revision: string }>(
          'SELECT access.site_moderation_basis() AS revision',
        )
      ).rows[0]!.revision;
      const position = { dataEpoch: 'safety-queue-v2', sequence: revision };
      const binding = [
        'safety-queue',
        principal.issuer,
        principal.subject,
        { ...filter, cursor: undefined, limit: undefined },
        kinds,
        specialist,
      ];
      const cursor = decodeReadCursor(filter.cursor, binding, position);
      // Descending urgency, then ascending timestamp and UUID, on every page.
      const rows = (
        await client.query<{
          id: string;
          kind: string;
          urgent: boolean;
          generation: string;
          opened_at: Date;
          opened_key: string;
          decision_head: string | null;
          target_owner: string;
          target_resource: string;
          target_component: string;
          category: string | null;
          content_language: string | null;
          due_at: Date | null;
          claimed_by: string | null;
        }>(
          `SELECT c.id,c.kind,c.urgent,c.generation::text,c.opened_at,
          to_char(c.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened_key,
          c.decision_head,c.target_owner,c.target_resource,c.target_component,
          r.reason_code AS category,r.content_language,d.due_at,claim.acting_subject AS claimed_by
        FROM access.governance_case c
        LEFT JOIN LATERAL (SELECT reason_code,content_language FROM access.governance_report
          WHERE case_id = c.id ORDER BY received_at,id LIMIT 1) r ON true
        LEFT JOIN LATERAL (SELECT due_at FROM access.governance_process_step
          WHERE case_id = c.id AND due_at IS NOT NULL ORDER BY due_at,id LIMIT 1) d ON true
        LEFT JOIN access.safety_case_claim claim ON claim.case_id = c.id
          AND claim.case_generation = c.generation AND claim.expires_at > $10
        WHERE c.authority_kind = 'platform' AND c.authority_scope_id = 'governance:platform'
          AND c.state = 'open' AND c.review_pending AND c.kind = ANY($1::text[])
          AND ($2::boolean IS NULL OR c.urgent = $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM access.governance_report
            WHERE case_id = c.id AND reason_code = $3))
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM access.governance_report
            WHERE case_id = c.id AND content_language = $4))
          AND ($5::timestamptz IS NULL OR d.due_at <= $5)
          AND ($6::timestamptz IS NULL OR c.urgent < $9::boolean
            OR (c.urgent = $9::boolean AND (c.opened_at,c.id) > ($6::timestamptz,$7::uuid)))
        ORDER BY c.urgent DESC,c.opened_at,c.id LIMIT $8`,
          [
            kinds,
            filter.urgent ?? null,
            filter.category ?? null,
            filter.contentLanguage ?? null,
            filter.dueBefore ?? null,
            cursor?.after ?? null,
            cursor?.order.slice(2) ?? null,
            limit + 1,
            cursor ? cursor.order.startsWith('1:') : null,
            this.clock(),
          ],
        )
      ).rows;
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => {
          const restricted = row.urgent && !specialist;
          return {
            caseId: row.id,
            kind: row.kind,
            urgent: row.urgent,
            restricted,
            generation: row.generation,
            decisionHead: restricted ? null : row.decision_head,
            openedAt: row.opened_at.toISOString(),
            target: restricted
              ? null
              : {
                  owner: row.target_owner,
                  resource: row.target_resource,
                  component: row.target_component,
                },
            category: row.category,
            contentLanguage: restricted ? null : row.content_language,
            dueAt: row.due_at?.toISOString() ?? null,
            claimedBy: restricted ? null : row.claimed_by,
          };
        }),
        sourcePosition: position,
        nextCursor:
          rows.length > limit
            ? encodeReadCursor(
                binding,
                position,
                page.at(-1)!.opened_key,
                `${page.at(-1)!.urgent ? '1' : '0'}:${page.at(-1)!.id}`,
              )
            : null,
      };
    }, true);
  }

  async claim(principal: VerifiedPrincipal, actor: string, caseId: string) {
    return this.transaction(async (client) => {
      const row = (
        await client.query<{ kind: string; urgent: boolean; generation: string }>(
          `SELECT kind,urgent,generation::text FROM access.governance_case
        WHERE id = $1 AND authority_kind = 'platform' AND authority_scope_id = 'governance:platform'
          AND state = 'open' FOR UPDATE`,
          [caseId],
        )
      ).rows[0];
      if (!row) throw new GovernanceDenied('case is unavailable');
      const authority = await this.authority(
        client,
        principal,
        actor,
        row.kind === 'rights_complaint' ? 'governance.rights.decide' : 'governance.moderate',
      );
      if (row.urgent) await this.authority(client, principal, actor, 'governance.safety.evidence');
      const claim = (
        await client.query<{
          acting_subject: string;
          principal_id: string;
          case_generation: string;
          expires_at: Date;
          account_issuer: string;
          account_subject: string;
        }>(
          `SELECT c.*,c.case_generation::text,p.account_issuer,p.account_subject FROM access.safety_case_claim c
           JOIN access.principal p ON p.id = c.principal_id WHERE case_id = $1`,
          [caseId],
        )
      ).rows[0];
      const now = this.clock();
      if (
        claim &&
        claim.case_generation === row.generation &&
        claim.expires_at > now &&
        (claim.principal_id !== authority.principalId || claim.acting_subject !== actor)
      ) {
        let current = true;
        try {
          const holder = { issuer: claim.account_issuer, subject: claim.account_subject };
          await this.authority(
            client,
            holder,
            claim.acting_subject,
            row.kind === 'rights_complaint' ? 'governance.rights.decide' : 'governance.moderate',
          );
          if (row.urgent)
            await this.authority(
              client,
              holder,
              claim.acting_subject,
              'governance.safety.evidence',
            );
        } catch (error) {
          if (!(error instanceof GovernanceDenied)) throw error;
          current = false;
        }
        if (current) throw new GovernanceConflict('case is claimed by another staff member');
      }
      await client.query(
        `INSERT INTO access.safety_case_claim (case_id,principal_id,acting_subject,case_generation,claimed_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (case_id) DO UPDATE SET
          principal_id = EXCLUDED.principal_id,acting_subject = EXCLUDED.acting_subject,
          case_generation = EXCLUDED.case_generation,claimed_at = EXCLUDED.claimed_at,expires_at = EXCLUDED.expires_at`,
        [
          caseId,
          authority.principalId,
          actor,
          row.generation,
          now,
          new Date(now.getTime() + 30 * 60_000),
        ],
      );
      return { caseId, claimedBy: actor };
    });
  }

  async due(principal: VerifiedPrincipal, actor: string, cursor?: string, now = this.clock()) {
    return this.transaction(async (client) => {
      const kinds = await this.actions(client, principal, actor, false);
      const rows = (
        await client.query<{ id: string; case_id: string; step: string; due_at: Date }>(
          `SELECT
        s.id,s.case_id,s.step,s.due_at FROM access.governance_process_step s
        JOIN access.governance_case c ON c.id = s.case_id
        WHERE c.authority_kind = 'platform' AND c.authority_scope_id = 'governance:platform'
          AND c.state = 'open' AND c.kind = ANY($1::text[]) AND s.process IN ('ncii','dmca_512')
          AND s.due_at <= $2 AND ($3::uuid IS NULL OR s.id > $3)
          AND (c.review_pending OR s.step IN ('restoration_not_before','restoration_not_after'))
          AND NOT EXISTS (SELECT 1 FROM access.moderation_decision d WHERE d.answers_step_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM access.rights_counter_notice j WHERE j.case_id = s.case_id
            AND ((j.restriction_id = s.decision_id AND j.phase IN ('done','stayed'))
              OR (j.report_id = s.report_id AND s.step IN ('restoration_not_before','restoration_not_after')
                AND (s.decision_id IS NULL OR (j.restriction_id = s.decision_id AND s.due_at IS DISTINCT FROM
                  CASE s.step WHEN 'restoration_not_before' THEN j.not_before ELSE j.not_after END)))))
        ORDER BY s.id LIMIT 51`,
          [kinds, now, cursor ?? null],
        )
      ).rows;
      const page = rows.slice(0, 50);
      return {
        items: page.map((row) => ({
          stepId: row.id,
          caseId: row.case_id,
          step: row.step,
          dueAt: row.due_at.toISOString(),
        })),
        nextCursor: rows.length > 50 ? page.at(-1)!.id : null,
      };
    }, true);
  }

  async hold(principal: VerifiedPrincipal, actor: string, caseId: string, reason: string) {
    if (!reason.trim() || reason.length > 4000)
      throw new GovernanceInvalid('preservation reason is required');
    return this.transaction(async (client) => {
      await this.authority(client, principal, actor, 'governance.safety.evidence');
      const row = (
        await client.query<{ target_resource: string }>(
          `SELECT target_resource
        FROM access.governance_case WHERE id = $1 AND authority_scope_id = 'governance:platform'
          AND authority_kind = 'platform' AND urgent`,
          [caseId],
        )
      ).rows[0];
      if (!row) throw new GovernanceDenied('urgent case is unavailable');
      await lockPreservationTarget(client, row.target_resource);
      const hold = (
        await client.query<{ id: string }>(
          `INSERT INTO access.governance_preservation_hold
        (id,case_id,target_resource,reason) VALUES ($1,$2,$3,$4)
        ON CONFLICT (case_id,target_resource) DO NOTHING RETURNING id`,
          [randomUUID(), caseId, row.target_resource, reason],
        )
      ).rows[0];
      return {
        caseId,
        holdId:
          hold?.id ??
          (
            await client.query<{ id: string }>(
              'SELECT id FROM access.governance_preservation_hold WHERE case_id = $1 AND target_resource = $2',
              [caseId, row.target_resource],
            )
          ).rows[0]!.id,
      };
    });
  }

  async notices(principal: VerifiedPrincipal, cursor?: string) {
    return this.transaction(async (client) => {
      const rows = (
        await client.query<{
          id: string;
          case_id: string;
          decision_id: string;
          credential: string;
          statement_of_reasons: unknown;
        }>(
          `SELECT n.* FROM access.safety_party_notice n
        JOIN access.principal p ON p.id = n.principal_id WHERE p.account_issuer = $1 AND p.account_subject = $2
        AND ($3::uuid IS NULL OR n.id > $3) ORDER BY n.id LIMIT 51`,
          [principal.issuer, principal.subject, cursor ?? null],
        )
      ).rows;
      return {
        items: rows.slice(0, 50).map((row) => ({
          id: row.id,
          caseId: row.case_id,
          decisionId: row.decision_id,
          credential: row.credential,
          reasons: row.statement_of_reasons,
        })),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      };
    }, true);
  }
}
