import type { Pool } from 'pg';
import { t } from 'elysia';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { realmManager, realmTransaction } from '../access/realm-management-authority.ts';
import { RealmAdminInvalid, RealmAdminStale, RealmAdminUnavailable, RealmAdminDenied } from '../realm-admin/contract.ts';
import { realmRulesRef } from '../governance/rules.ts';
import type { CapturedEvidence, TargetHeads } from '../governance/store.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved } from '../work/read-session.ts';
import { readId, readUuid } from '../work/read-contract.ts';

// Four report records, each with <=16 immutable evidence anchors; no copied
// content bodies. Two graph position checks plus <=64 owner head point reads.
export const DECISION_BASIS_COST = { reports: 4, evidence: 64, graphCalls: 66, graphBytes: 16_384,
  sqlStatements: 12, deadlineMs: 10_000 } as const;
export const decisionBasisPage = t.Object({ caseId: readUuid,generation: t.String(),decisionHead: t.Nullable(readUuid),
  state: t.String(),target: t.Object({ owner: t.String(),resource: t.String(),component: t.String() }),
  ruleBasis: t.Nullable(t.Object({ ref: t.String(),revision: t.String(),digest: t.String(),document: t.Record(t.String(),t.Unknown()) })),
  reports: t.Array(t.Object({ id: readUuid,actingSubject: t.Nullable(readId),reasonCode: t.String(),statement: t.Nullable(t.String()),
    evidenceDigest: t.String(),receivedAt: t.String(),evidence: t.Array(t.Object({ ordinal: t.Integer(),
      owner: t.String(),resource: t.String(),component: t.String(),revision: t.Nullable(t.String()),locator: t.Nullable(t.String()),
      state: t.String(),representation: t.Nullable(t.String()),revisionDigest: t.Nullable(t.String()),
      expectedHead: t.Nullable(t.String()),provenance: t.Record(t.String(),t.String()) }),{ maxItems: 16 }) }),{ maxItems: 4 }),
  nextCursor: t.Nullable(t.String()),sourcePosition: t.Object({ dataEpoch: t.String(),sequence: t.String() }) });

interface Report { id: string; acting_subject: string | null; reason_code: string; statement: string | null;
  evidence_digest: string; received_at: Date; received_key: string }
interface Evidence extends CapturedEvidence { report_id: string; ordinal: number }

export class ManagementDecisionBasis {
  constructor(private readonly pool: Pool,private readonly env: WorkActivationEnvironment,private readonly heads: TargetHeads) {}
  private async position() {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`,1024)).results?.bindings ?? [];
    if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.sequence?.value ?? '')) throw new RealmAdminUnavailable('Graph position is unavailable');
    return rows[0]!.sequence!.value;
  }

  read(principal: VerifiedPrincipal,realm: string,caseId: string,options: { actingSubject: string; cursor?: string; limit?: number }) {
    const limit = options.limit ?? DECISION_BASIS_COST.reports;
    if (!/^[0-9a-f-]{36}$/.test(caseId) || !Number.isInteger(limit) || limit < 1 || limit > DECISION_BASIS_COST.reports) {
      throw new RealmAdminInvalid('Invalid decision basis read');
    }
    const signal = AbortSignal.timeout(DECISION_BASIS_COST.deadlineMs);
    return fusekiReadBudget.run({ signal,callsLeft: DECISION_BASIS_COST.graphCalls,
      bytesLeft: DECISION_BASIS_COST.graphCalls * DECISION_BASIS_COST.graphBytes },() => realmTransaction(this.pool,realm,false,async client => {
      await realmManager(client,principal,realm,options.actingSubject,'governance.moderate');
      const row = (await client.query<{ generation: string; decision_head: string | null; state: string;
        target_owner: string; target_resource: string; target_component: string }>(`SELECT generation::text,decision_head,state,
        target_owner,target_resource,target_component FROM access.governance_case WHERE id = $1
          AND authority_kind = 'realm' AND authority_scope_id = $2 AND context = $3 AND NOT urgent FOR SHARE`,
      [caseId,`governance:realm:${realm}`,realm])).rows[0];
      if (!row) throw new RealmAdminDenied('Case is unavailable');
      const graphSequence = await this.position();
      const revision = (await client.query<{ revision: string }>(`SELECT revision::text
        FROM access.realm_management_read_revision WHERE realm = $1 FOR SHARE`,[realm])).rows[0]?.revision ?? '0';
      const position = { dataEpoch: this.env.lineage.dataEpoch,sequence: `${graphSequence}:${revision}` };
      const binding = ['decision-basis',realm,caseId,principal.issuer,principal.subject,options.actingSubject];
      let cursor;
      try { cursor = decodeReadCursor(options.cursor,binding,position); }
      catch (error) {
        if (error instanceof WorkReadInvalid) throw new RealmAdminInvalid(error.message);
        if (error instanceof WorkReadMoved) throw new RealmAdminStale(error.message);
        throw error;
      }
      if (cursor && (!Number.isFinite(Date.parse(cursor.after)) || !/^[0-9a-f-]{36}$/.test(cursor.order))) throw new RealmAdminInvalid('Invalid report cursor');
      const reports = (await client.query<Report>(`SELECT id,acting_subject,reason_code,statement,evidence_digest,received_at,
        to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_key
        FROM access.governance_report WHERE case_id = $1
          AND ($2::timestamptz IS NULL OR (received_at,id) > ($2::timestamptz,$3::uuid))
        ORDER BY received_at,id LIMIT $4`,[caseId,cursor?.after ?? null,cursor?.order ?? null,limit + 1])).rows;
      const chosen = reports.slice(0,limit);
      const evidence = (await client.query<Evidence>(`SELECT report_id,ordinal,owner,resource,component,revision,locator,state,
        representation,revision_digest AS "revisionDigest",provenance FROM access.governance_evidence
        WHERE report_id = ANY($1::uuid[]) ORDER BY report_id,ordinal LIMIT 65`,[chosen.map(r => r.id)])).rows;
      if (evidence.length > DECISION_BASIS_COST.evidence) throw new RealmAdminUnavailable('Evidence exceeds the read budget');
      const currentEvidence: (Evidence & { expectedHead: string | null })[] = [];
      for (const item of evidence) currentEvidence.push({ ...item,expectedHead: await this.heads.current(item) });
      const rule = (await client.query<{ ref: string; revision: string; digest: string; document: Record<string,unknown> }>(`
        SELECT h.ref,h.revision::text,h.digest,r.document FROM access.governance_rule_head h
        JOIN access.governance_rule_revision r ON r.ref = h.ref AND r.revision = h.revision
        WHERE h.ref = $1 AND h.scope_id = $2 FOR SHARE OF h`,[realmRulesRef(realm),`governance:realm:${realm}`])).rows[0] ?? null;
      if (await this.position() !== graphSequence) throw new RealmAdminStale('Graph basis changed; restart the read');
      await realmManager(client,principal,realm,options.actingSubject,'governance.moderate');
      signal.throwIfAborted();
      return { caseId,generation: row.generation,decisionHead: row.decision_head,state: row.state,
        target: { owner: row.target_owner,resource: row.target_resource,component: row.target_component },ruleBasis: rule,
        reports: chosen.map(report => ({ id: report.id,actingSubject: report.acting_subject,reasonCode: report.reason_code,
          statement: report.statement,evidenceDigest: report.evidence_digest,receivedAt: report.received_at.toISOString(),
          evidence: currentEvidence.filter(e => e.report_id === report.id).map(({ report_id: _reportId,...item }) => item) })),
        nextCursor: reports.length > limit ? encodeReadCursor(binding,position,chosen.at(-1)!.received_key,chosen.at(-1)!.id) : null,
        sourcePosition: position };
    }));
  }
}
