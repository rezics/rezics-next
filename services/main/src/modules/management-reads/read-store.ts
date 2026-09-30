import type { Pool, PoolClient } from 'pg';
import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded, fusekiReadBudget }
  from '../../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved } from '../work/read-session.ts';
import { type PersonContext, readPeople } from './context.ts';
import { MANAGEMENT_READ_COST, MODERATION_CONTEXT_COST, type ManagementPosition } from './read-contract.ts';

export class ManagementReadMissing extends Error {}
export class ManagementReadUnavailable extends Error {}
export class ManagementReadLimit extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const native = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const realmGovernanceScope = (realm: string) => `governance:realm:${realm}`;
const organizationScope = (realm: string) => `publication:reject:${realm}`;

interface Options { actingSubject: string; limit?: number; cursor?: string }
interface CaseRow { id: string; kind: 'content_report' | 'rights_complaint'
  | 'contribution_submission' | 'correction_submission' | 'work_submission' | 'content-publication_submission'; state: 'open' | 'closed';
  generation: string; decision_head: string | null; opened_at: Date; opened_key: string; target_owner: string;
  target_resource: string; target_component: string; context: string; author_agent: string | null;
  reason_code: string | null; submission: unknown | null; escalation: unknown | null }
interface DecisionRow { id: string; case_id: string | null; kind: 'content_moderation' | 'rights_disposition'
  | 'organization_publication_rejection' | 'realm_management'; outcome: string; acting_subject: string; decided_at: Date;
  reason: string | null; detail: unknown | null; target: { owner: string; resource: string; component: string } | null;
  decided_key: string;
  case_sequence: string | null }

/** One indexed Access page, two bounded graph reads and a final lock-backed authority check. */
export class ManagementReadStore {
  constructor(private readonly pool: Pool, private readonly environment: WorkActivationEnvironment) {}

  private async graphBasis(realm: string): Promise<{ epoch: string; sequence: string; exists: boolean }> {
    const env = this.environment;
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?realm WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { BIND(${iri(realm)} AS ?realm)
        ?realm a rv:Realm ; rv:realmState rv:Active . } }
    } LIMIT 2`, MANAGEMENT_READ_COST.graphBytes)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.epoch || !/^\d+$/.test(rows[0].sequence?.value ?? '')) {
      throw new ManagementReadUnavailable('Graph basis is unavailable');
    }
    return { epoch: rows[0].epoch.value, sequence: rows[0].sequence!.value,
      exists: rows[0].realm?.value === realm };
  }

  private async authority(client: PoolClient, principal: VerifiedPrincipal, subject: string, scope: string,
    optional = false) {
    const row = (await client.query(`SELECT 1 FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3
        AND r.active AND r.valid_until > clock_timestamp() AND r.action IN ($5, 'agent.control')
      JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
      JOIN access.permission_grant g ON g.recipient_subject = s.id AND g.scope_id = $4
        AND g.action = $5 AND g.active AND g.valid_until > clock_timestamp()
      JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
      LIMIT 1 FOR SHARE OF p, r, s, g, gate`, [principal.issuer, principal.subject, subject, scope,
      scope.startsWith('review:decide:') ? 'review.decide' : 'governance.moderate'])).rows[0];
    if (!row && !optional) throw new ManagementReadMissing('Realm management is unavailable');
    return !!row;
  }

  private async revision(client: PoolClient, realm: string, final: boolean): Promise<string> {
    const row = (await client.query<{ revision: string }>(`SELECT revision::text FROM
      access.realm_management_read_revision WHERE realm = $1${final ? ' FOR SHARE' : ''}`,
    [realm])).rows[0];
    if (!row) throw new ManagementReadUnavailable('Realm Access position is unavailable');
    return row.revision;
  }

  private async page<T extends { id: string }>(principal: VerifiedPrincipal, realm: string, options: Options,
    family: 'moderation' | 'audit', filter: string | null,
    select: (client: PoolClient, after: { time: string; id: string } | null, limit: number,
      submissions: boolean) => Promise<T[]>,
    map: (row: T) => unknown, time: (row: T) => string, reviewOnly = false,
    includeSubmissions = false) {
    if (!native.test(realm) || !native.test(options.actingSubject)) throw new WorkReadInvalid('Invalid Realm read');
    const limit = options.limit ?? MANAGEMENT_READ_COST.pageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > MANAGEMENT_READ_COST.pageSize) {
      throw new WorkReadInvalid('Invalid page size');
    }
    const client = await this.pool.connect().catch(() => {
      throw new ManagementReadUnavailable('Access owner is unavailable');
    });
    const signal = AbortSignal.timeout(MANAGEMENT_READ_COST.deadlineMs);
    try {
      return await fusekiReadBudget.run({ signal, callsLeft: MANAGEMENT_READ_COST.graphCalls,
        bytesLeft: MANAGEMENT_READ_COST.graphBytes * MANAGEMENT_READ_COST.graphCalls }, async () => {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${MANAGEMENT_READ_COST.statementTimeoutMs}ms'`);
      const scope = reviewOnly ? `review:decide:${realm}` : realmGovernanceScope(realm);
      await this.authority(client, principal, options.actingSubject, scope);
      const submissions = reviewOnly || includeSubmissions && family === 'moderation'
        && await this.authority(client, principal, options.actingSubject, `review:decide:${realm}`, true);
      const start = await this.graphBasis(realm);
      if (!start.exists) throw new ManagementReadMissing('Realm management is unavailable');
      // Materialize an empty Realm position before reading it; this also fences
      // the first concurrent write when a Realm has no earlier queue records.
      await client.query(`INSERT INTO access.realm_management_read_revision (realm, revision)
        VALUES ($1, 0) ON CONFLICT DO NOTHING`, [realm]);
      // Queue mutations advance this row in their transaction. Pin the SQL
      // population until COMMIT; readers share the lock and writers wait within
      // the existing statement deadline instead of invalidating a first page.
      const revision = await this.revision(client, realm, true);
      const position: ManagementPosition = { dataEpoch: start.epoch,
        sequence: `${start.sequence}:${revision}` };
      // No graph-derived payload is in these pages: graph authority/existence
      // stays live, but unrelated graph writes are not a queue revision.
      const cursorPosition = { dataEpoch: start.epoch, sequence: revision };
      const binding = [family, realm, options.actingSubject, principal.issuer, principal.subject, filter, submissions];
      const cursor = decodeReadCursor(options.cursor, binding, cursorPosition);
      const after = cursor ? { time: cursor.after, id: cursor.order } : null;
      if (after && (!Number.isFinite(Date.parse(after.time)) || !uuid.test(after.id))) {
        throw new WorkReadInvalid('Invalid page cursor');
      }
      const rows = await select(client, after, limit + 1, submissions);
      if (rows.length > limit + 1) throw new ManagementReadLimit('Page exceeds its row budget');
      const chosen = rows.slice(0, limit);
      const nextCursor = rows.length > limit
        ? encodeReadCursor(binding, cursorPosition, time(chosen.at(-1)!), chosen.at(-1)!.id) : null;
      const end = await this.graphBasis(realm);
      if (!end.exists) throw new ManagementReadMissing('Realm management is unavailable');
      if (end.epoch !== start.epoch) throw new ManagementReadUnavailable('Realm recovery basis changed');
      if (await this.revision(client, realm, true) !== revision) {
        throw new WorkReadMoved('Access basis changed');
      }
      await this.authority(client, principal, options.actingSubject, scope);
      signal.throwIfAborted();
      await client.query('COMMIT');
      return { items: chosen.map(map), nextCursor, sourcePosition: position,
        count: { value: chosen.length, kind: 'exact-page' as const, total: null } };
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (signal.aborted) throw new ManagementReadUnavailable('Management read deadline exceeded');
      if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) {
        throw new ManagementReadLimit('Graph read budget exceeded');
      }
      if (error instanceof WorkReadInvalid || error instanceof WorkReadMoved || error instanceof ManagementReadMissing
        || error instanceof ManagementReadLimit || error instanceof ManagementReadUnavailable) throw error;
      throw new ManagementReadUnavailable('Management read is unavailable');
    } finally { client.release(); }
  }

  /**
   * `reason` keeps the cases one of whose reports gave that reason code; the
   * candidate branch then also reads each scanned case's report index, and
   * submissions, which have no reason codes, drop out.
   */
  moderation(principal: VerifiedPrincipal, realm: string, options: Options,
    state: 'open' | 'closed', kind: CaseRow['kind'] | null, includeSubmissions = false, reason: string | null = null) {
    const scope = realmGovernanceScope(realm);
    const reviewOnly = kind?.endsWith('_submission') ?? false;
    return this.page(principal, realm, options, 'moderation',
      `${state}:${kind ?? '*'}${reason ? `:${reason}` : ''}`,
      // Each indexed branch stops at pageSize + 1 before the bounded merge.
      // Review-only readers cannot inspect governance reports; governance-only
      // readers cannot inspect offers or their author-visible decision state.
      async (client, after, limit, submissions) => (await client.query<CaseRow>(`SELECT candidates.*,
        (SELECT jsonb_build_object('id', e.id, 'reason', e.reason, 'actingSubject', e.acting_subject,
          'escalatedAt', e.escalated_at, 'target', 'owners') FROM access.realm_admin_escalation e
          WHERE e.realm = $2 AND e.item_id = candidates.id AND e.item_kind =
            CASE WHEN candidates.kind IN ('content_report','rights_complaint') THEN 'report' ELSE 'submission' END
        ) AS escalation FROM (
        (SELECT cases.*, first_report.acting_subject AS author_agent, first_report.reason_code,
          NULL::jsonb AS submission
        FROM (SELECT id, kind, CASE WHEN decision_head IS NULL AND state = 'open' THEN 'open' ELSE 'closed' END AS state,
          generation::text, decision_head, opened_at,
          to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened_key,
          target_owner, target_resource, target_component, context
          FROM access.governance_case WHERE authority_scope_id = $1 AND authority_kind = 'realm'
            AND $8 AND context = $2 AND NOT urgent
            AND (CASE WHEN decision_head IS NULL AND state = 'open' THEN 'open' ELSE 'closed' END) = $3
            AND ${kind ? 'kind = $4' : '$4::text IS NULL'}
            AND ($10::text IS NULL OR EXISTS (SELECT 1 FROM access.governance_report reason
              WHERE reason.case_id = governance_case.id AND reason.reason_code = $10))
            AND ($5::timestamptz IS NULL OR (opened_at, id) > ($5::timestamptz, $6::uuid))
          ORDER BY opened_at, id LIMIT $7) cases
        LEFT JOIN LATERAL (SELECT acting_subject, reason_code FROM access.governance_report
          WHERE case_id = cases.id ORDER BY received_at, id LIMIT 1) first_report ON true
        ORDER BY cases.opened_at, cases.id LIMIT $7)
        UNION ALL
        (SELECT id, kind || '_submission' AS kind,
          CASE WHEN state IN ('pending', 'deciding') THEN 'open' ELSE 'closed' END AS state,
          generation::text, CASE WHEN state = 'pending' THEN NULL ELSE revision END AS decision_head,
          opened_at, to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened_key,
          'graph' AS target_owner, work AS target_resource, COALESCE(contribution, target->>'variant', work) AS target_component,
          realm AS context, submitting_agent AS author_agent, public_reason AS reason_code,
          jsonb_build_object('revision', revision, 'state', state, 'contribution', contribution,
            'publicationDecision', publication_decision, 'selectedDraft', selected_draft,
            'correctionOf', correction_of) AS submission
          FROM access.realm_submission WHERE realm = $2 AND $9 AND $10::text IS NULL
            AND ${state === 'open' ? "state IN ('pending', 'deciding')" : "state IN ('accepted', 'rejected', 'changes-requested', 'withdrawn', 'stale')"}
            AND ${kind ? "kind = replace($4, '_submission', '')" : '$4::text IS NULL'}
            AND ($5::timestamptz IS NULL OR (opened_at, id) > ($5::timestamptz, $6::uuid))
          ORDER BY opened_at, id LIMIT $7)
        ) candidates ORDER BY opened_at, id LIMIT $7`, [scope, realm, state, kind, after?.time ?? null,
        after?.id ?? null, limit, !reviewOnly, submissions, reason])).rows,
      row => ({ id: row.id, kind: row.kind, state: row.state, generation: row.generation,
        decisionHead: row.decision_head, openedAt: row.opened_at.toISOString(),
        authorAgent: row.author_agent, reasonCode: row.reason_code,
        escalation: row.escalation ?? null,
        target: { owner: row.target_owner, resource: row.target_resource,
          component: row.target_component }, context: row.context, submission: row.submission }),
      row => row.opened_key, reviewOnly, includeSubmissions);
  }

  /**
   * The records of the people a queue page names, in one short transaction:
   * the reader must moderate or review here, and sees the history that both
   * the permission and the token's consent cover.
   */
  async people(principal: VerifiedPrincipal, realm: string, actingSubject: string, agents: readonly string[],
    consent: { reports: boolean; submissions: boolean }): Promise<PersonContext[]> {
    if (!native.test(realm) || !native.test(actingSubject)) throw new WorkReadInvalid('Invalid Realm read');
    const client = await this.pool.connect().catch(() => {
      throw new ManagementReadUnavailable('Access owner is unavailable');
    });
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${MODERATION_CONTEXT_COST.statementTimeoutMs}ms'`);
      const scope = realmGovernanceScope(realm);
      const sees = {
        reports: consent.reports && await this.authority(client, principal, actingSubject, scope, true),
        submissions: consent.submissions
          && await this.authority(client, principal, actingSubject, `review:decide:${realm}`, true) };
      if (!sees.reports && !sees.submissions) throw new ManagementReadMissing('Realm management is unavailable');
      const people = await readPeople(client, realm, scope, agents, sees);
      await client.query('COMMIT');
      return people;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof WorkReadInvalid || error instanceof ManagementReadMissing) throw error;
      throw new ManagementReadUnavailable('Management read is unavailable');
    } finally { client.release(); }
  }

  audit(principal: VerifiedPrincipal, realm: string, options: Options, kind: DecisionRow['kind'] | null) {
    const scope = realmGovernanceScope(realm);
    return this.page(principal, realm, options, 'audit', kind,
      // The page's own cases name each decision's target: at most one primary-key lookup per row.
      async (client, after, limit) => (await client.query<DecisionRow>(`SELECT candidates.id, case_id, candidates.kind,
        outcome, reason, detail, acting_subject, decided_at,
        to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_key,
        case_sequence::text, CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('owner', c.target_owner,
          'resource', c.target_resource, 'component', c.target_component) END AS target FROM (
        (SELECT id, case_id, kind, outcome, acting_subject, decided_at, case_sequence,
          rationale AS reason, NULL::jsonb AS detail
          FROM access.moderation_decision
          WHERE authority_kind = 'realm' AND context = $1 AND authority_scope_id = $2
            AND ${kind ? 'kind = $4' : '$4::text IS NULL'}
            AND ($5::timestamptz IS NULL OR (decided_at, id) > ($5::timestamptz, $6::uuid))
          ORDER BY decided_at, id LIMIT $7)
        UNION ALL
        (SELECT id, case_id, kind, outcome, acting_subject, decided_at, case_sequence,
          rationale AS reason, NULL::jsonb AS detail
          FROM access.moderation_decision
          WHERE authority_kind = 'realm' AND context = $1 AND authority_scope_id = $3
            AND ${kind ? 'kind = $4' : '$4::text IS NULL'}
            AND ($5::timestamptz IS NULL OR (decided_at, id) > ($5::timestamptz, $6::uuid))
          ORDER BY decided_at, id LIMIT $7)
        UNION ALL
        (SELECT id, NULL::uuid AS case_id, 'realm_management' AS kind, action AS outcome,
          acting_subject, created_at AS decided_at, NULL::bigint AS case_sequence, reason,
          CASE WHEN action = 'realm.roles.manage' THEN result->'auditDetail' ELSE NULL END AS detail
          FROM access.realm_admin_receipt WHERE realm = $1
            AND ($4::text IS NULL OR $4 = 'realm_management')
            AND ($5::timestamptz IS NULL OR (created_at,id) > ($5::timestamptz,$6::uuid))
          ORDER BY created_at,id LIMIT $7)
        ) candidates LEFT JOIN access.governance_case c ON c.id = candidates.case_id
        ORDER BY decided_at, candidates.id LIMIT $7`, [realm, scope, organizationScope(realm), kind,
        after?.time ?? null, after?.id ?? null, limit])).rows,
      row => ({ id: row.id, caseId: row.case_id, kind: row.kind, outcome: row.outcome,
        reason: row.reason ?? null, detail: row.detail ?? null, target: row.target ?? null,
        actingSubject: row.acting_subject, decidedAt: row.decided_at.toISOString(),
        caseSequence: row.case_sequence }), row => row.decided_key);
  }
}
