import { operationOutcome, type OperationItem } from '../operation/outcome.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { GLOBAL_CONTEXT } from '../governance/schema.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceUnavailable,
  normalizeGovernanceError, sha256, type CapturedEvidence } from '../governance/store.ts';
import { categoryProcesses, correspondenceInput, PLATFORM_SCOPE, PUBLIC_REPORT_COST,
  publicReportInput, validContentLanguage, type CorrespondenceInput, type PublicReportInput } from './contract.ts';
import { lockPreservationTarget } from './preservation.ts';
import { partyDeclarations, recordCounterNotice } from '../rights/counter-notice.ts';

export interface ReportTarget {
  evidence: CapturedEvidence;
  author: string | null;
  realm: string | null;
}
export interface PublicReportOwners {
  resolve(input: PublicReportInput, request: Request, principal: VerifiedPrincipal | null): Promise<ReportTarget>;
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const keyPattern = /^[A-Za-z0-9:_./-]{32,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Server-only hook for G-565, after it authorizes the affected party.
 * Return the secret through the private notice; never put it in a URL or outbox. */
export async function mintPartyCredential(client: PoolClient, caseId: string, reportId: string,
  party: 'affected' | 'reporter' = 'affected'): Promise<string> {
  const credential = randomBytes(PUBLIC_REPORT_COST.credentialBytes).toString('base64url');
  await client.query(`INSERT INTO access.governance_case_credential (id, case_id, report_id, party, secret_hash)
    VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), caseId, reportId, party, sha256(credential)]);
  return credential;
}

/** Public transport over the existing governance cases, evidence and process chain. */
export class PublicReports {
  constructor(private readonly pool: Pool, private readonly owners: PublicReportOwners,
    private readonly clock: () => Date = () => new Date()) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => { throw new GovernanceUnavailable('Governance is unavailable'); });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      if (!(await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0]?.open) {
        throw new GovernanceUnavailable('Governance is held for recovery');
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const normalized = normalizeGovernanceError(error);
      if (normalized !== error) normalized.cause = error;
      throw normalized;
    } finally { client.release(); }
  }

  async submit(input: PublicReportInput, key: string, request: Request, principal: VerifiedPrincipal | null) {
    const received = this.clock();
    if (!Value.Check(publicReportInput, input) || !validContentLanguage(input.contentLanguage)
      || !keyPattern.test(key) || !input.statement.trim()
      || (input.category === 'ncii' && (!input.contactEmail || !input.ncii))
      || (input.category === 'copyright' && (!input.contactEmail || !input.copyright))
      || (input.category !== 'ncii' && input.ncii !== undefined)
      || (input.category !== 'copyright' && input.copyright !== undefined)
      || (input.category === 'realm_rules') !== (input.realm !== undefined)) {
      throw new GovernanceInvalid('Report does not match its category requirements');
    }
    // The random intake key is also a recovery capability. Store only its hash;
    // a replay gets a newly minted secret, never the previous secret's plaintext.
    const receiptHash = sha256(key);
    const digest = sha256(canonical(input));
    const replay = await this.transaction(async client => this.replay(client, receiptHash, digest));
    if (replay) return replay;
    let target = await this.owners.resolve(input, request, principal);
    if (input.realm && target.realm !== input.realm) throw new GovernanceInvalid('Target is outside the reported Realm');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 564))', [receiptHash]);
      const prior = await this.replay(client, receiptHash, digest);
      if (prior) return prior;
      if (input.category === 'child_exploitation') {
        await lockPreservationTarget(client, target.evidence.resource);
        // Erasure may have won while the first owner read was in flight. Re-admit
        // under its fence before committing a hold on material that no longer exists.
        const current = await this.owners.resolve(input, request, principal);
        if (current.evidence.resource !== target.evidence.resource) throw new GovernanceConflict('Report target moved');
        target = current;
      }
      if (principal) await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, $2, $3) ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
      [randomUUID(), principal.issuer, principal.subject]);
      const reporter = principal ? (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0]?.id ?? null : null;
      const mapping = categoryProcesses[input.category];
      const scope = input.realm ? `governance:realm:${input.realm}` : PLATFORM_SCOPE;
      if (input.realm) await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      if (!(await client.query('SELECT 1 FROM access.scope_gate WHERE id = $1 AND open FOR SHARE', [scope])).rowCount) {
        throw new GovernanceUnavailable('Report authority is unavailable');
      }
      const kind = input.category === 'copyright' ? 'rights_complaint' : 'content_report';
      const context = input.realm ?? GLOBAL_CONTEXT;
      const e = target.evidence;
      await client.query(`INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id,
        context, target_owner, target_resource, target_component, disclosure, urgent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'private', $9) ON CONFLICT DO NOTHING`,
      [randomUUID(), kind, input.realm ? 'realm' : 'platform', scope, context, e.owner, e.resource, e.component, mapping.urgent]);
      const caseId = (await client.query<{ id: string }>(`SELECT id FROM access.governance_case WHERE
        target_owner = $1 AND target_resource = $2 AND target_component = $3 AND context = $4
        AND authority_scope_id = $5 AND kind = $6 AND state = 'open' FOR UPDATE`,
      [e.owner, e.resource, e.component, context, scope, kind])).rows[0]?.id;
      if (!caseId) throw new GovernanceConflict('Case changed during intake');
      if (mapping.urgent) await client.query('UPDATE access.governance_case SET urgent = true WHERE id = $1', [caseId]);
      const reportId = Bun.randomUUIDv7();
      const declarations = input.ncii ?? input.copyright ?? null;
      const receivedAt = (await client.query<{ received_at: Date }>(`INSERT INTO access.governance_report
        (id, case_id, principal_id, idempotency_key, request_digest, reason_code, statement,
         evidence_count, evidence_digest, content_language, contact_email, declarations, public_receipt_hash, process, received_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $4, $12, $13) RETURNING received_at`,
      [reportId, caseId, reporter, receiptHash, digest, input.category, input.statement.trim(), sha256(canonical([e])),
        input.contentLanguage, input.contactEmail ?? null, declarations, mapping.process, received])).rows[0]!.received_at;
      await client.query(`INSERT INTO access.governance_evidence (report_id, ordinal, owner, resource, component,
        locator, revision, representation, revision_digest, state, provenance)
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [reportId, e.owner, e.resource, e.component, e.locator, e.revision, e.representation, e.revisionDigest, e.state, e.provenance]);
      await this.step(client, caseId, reportId, mapping.process, 'intake', receivedAt, null, null,
        input.contentLanguage, declarations);
      if (input.category === 'ncii') await this.step(client, caseId, reportId, 'ncii', 'removal_deadline',
        receivedAt, new Date(receivedAt.getTime() + 48 * 3600_000), null, input.contentLanguage, null);
      if (input.copyright) {
        const c = input.copyright;
        await client.query(`INSERT INTO access.rights_complaint (report_id, case_id, process, claimant_kind,
          claimant_name, claimant_contact, claimed_work, claimed_right, notice_digest, notice_received_at)
          VALUES ($1, $2, 'dmca_512', 'authorized_agent', $3, $4, $5, 'copyright', $6, $7)`,
        [reportId, caseId, c.claimantName.trim(), input.contactEmail, c.claimedWork, sha256(canonical(c)), receivedAt]);
      }
      if (input.category === 'child_exploitation') {
        await client.query(`INSERT INTO access.governance_preservation_hold
          (id, case_id, target_resource, author_subject, account_issuer, account_subject, reason)
          SELECT $1, $2, $3, $4, p.account_issuer, p.account_subject, 'child_exploitation'
          FROM (SELECT 1) seed LEFT JOIN LATERAL (
            SELECT p.account_issuer, p.account_subject FROM access.principal p
            WHERE p.id = COALESCE((SELECT principal_id FROM access.agent_provision WHERE agent_id = $4),
              (SELECT principal_id FROM access.representation WHERE subject_id = $4 ORDER BY id LIMIT 1))
          ) p ON true ON CONFLICT DO NOTHING`,
        [randomUUID(), caseId, e.resource, target.author]);
      }
      return { reportId, caseId, receivedAt: receivedAt.toISOString(),
        credential: await mintPartyCredential(client, caseId, reportId, 'reporter'), replayed: false };
    });
  }

  private async replay(client: PoolClient, hash: string, digest: string) {
    const row = (await client.query<{ id: string; case_id: string; request_digest: string; received_at: Date }>(
      `SELECT id, case_id, request_digest, received_at FROM access.governance_report
       WHERE public_receipt_hash = $1`, [hash])).rows[0];
    if (!row) return null;
    if (row.request_digest !== digest) throw new GovernanceConflict('Idempotency key reused');
    return { reportId: row.id, caseId: row.case_id, receivedAt: row.received_at.toISOString(),
      credential: await mintPartyCredential(client, row.case_id, row.id, 'reporter'), replayed: true };
  }

  private async credential(client: PoolClient, caseId: string, secret: string) {
    // Wrong and nonexistent case credentials share the same query and outcome.
    if (!uuidPattern.test(caseId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new GovernanceDenied('Case is unavailable');
    const row = (await client.query<{ id: string; report_id: string; party: 'reporter' | 'affected' }>(
      `SELECT id, report_id, party FROM access.governance_case_credential WHERE case_id = $1 AND secret_hash = $2`,
      [caseId, sha256(secret)])).rows[0];
    if (!row) throw new GovernanceDenied('Case is unavailable');
    return row;
  }

  async status(caseId: string, secret: string, after?: string) {
    if (after && !uuidPattern.test(after)) throw new GovernanceInvalid('Invalid correspondence cursor');
    return this.transaction(async (client) => {
      const credential = await this.credential(client, caseId, secret);
      const row = (await client.query<{ state: string; generation: string; received_at: Date;
        reason_code: string; content_language: string; process: string; outcome: string | null; rationale: string | null;
        statement: string | null; declarations: Record<string, unknown> | null; contact_email: string | null;
          statement_of_reasons: unknown;
          decision_head: string | null;
          cancelled: boolean | null;
        }>(
      `SELECT c.state, c.generation::text, r.received_at,
        CASE WHEN c.kind = 'rights_complaint' THEN 'copyright' ELSE r.reason_code END AS reason_code,
        COALESCE(r.content_language,'en') AS content_language,COALESCE(rc.process,r.process,'platform_rules') AS process,
        r.statement,COALESCE(r.declarations,CASE WHEN rc.report_id IS NOT NULL THEN jsonb_build_object(
          'claimantName',rc.claimant_name,'claimantContact',rc.claimant_contact,
          'claimedWork',rc.claimed_work,'claimedRight',rc.claimed_right,'noticeDigest',rc.notice_digest) END) AS declarations,
        CASE WHEN $2 = 'reporter' THEN COALESCE(r.contact_email,rc.claimant_contact) END AS contact_email,
        d.outcome, CASE WHEN $2 = 'affected' OR d.disclosure <> 'private' THEN d.statement_of_reasons END AS statement_of_reasons,
        c.decision_head,op.cancelled, CASE WHEN d.disclosure <> 'private' THEN d.rationale END AS rationale
        FROM access.governance_report r JOIN access.governance_case c ON c.id = r.case_id
        LEFT JOIN access.rights_complaint rc ON rc.report_id = r.id
        LEFT JOIN access.moderation_decision d ON d.id = c.decision_head LEFT JOIN access.safety_decision_operation op ON op.decision_id = d.id WHERE r.id = $1`, [credential.report_id, credential.party])).rows[0]!;
      const steps = (await client.query<{ id: string; step: string; occurred_at: Date; due_at: Date | null;
        statement: string | null; content_language: string | null; party: string | null;
        declarations: Record<string, unknown> | null;
        }>(`SELECT id, step, occurred_at, due_at, party, declarations,
        statement, content_language FROM access.governance_process_step
        WHERE case_id = $5 AND (report_id = $1 OR report_id IS NULL)
        AND (party IS NULL OR party = $4 OR step IN ('intake','counter_notice','claimant_action'))
        AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`,
      [credential.report_id, after ?? null, PUBLIC_REPORT_COST.page + 1, credential.party, caseId])).rows;
      const page = steps.slice(0, PUBLIC_REPORT_COST.page);
      const effects =
        row.decision_head && row.cancelled !== null
          ? (
              await client.query<OperationItem>(
                `SELECT
        e.ordinal,t.resource AS target,e.state,e.receipt,e.continuation,e.error FROM access.safety_decision_effect e
        JOIN access.moderation_decision_target t USING (decision_id,ordinal)
        WHERE e.decision_id = $1 ORDER BY ordinal`,
                [row.decision_head],
              )
            ).rows
          : null;
      return { caseId, reportId: credential.report_id, state: row.state, generation: row.generation,
        receivedAt: row.received_at.toISOString(), category: row.reason_code, contentLanguage: row.content_language,
        process: row.process, outcome: row.outcome, reasons: row.rationale,
        notice: { statement: row.statement,
          contactEmail: row.contact_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contact_email) ? row.contact_email : null,
          declarations: partyDeclarations('intake', row.declarations, credential.party === 'reporter') },
        statementOfReasons: row.statement_of_reasons,
        operation: effects
          ? operationOutcome(row.decision_head!, effects, row.cancelled ?? false)
          : null,
        steps: page.map((step) => ({ id: step.id, kind: step.step, occurredAt: step.occurred_at.toISOString(),
          dueAt: step.due_at?.toISOString() ?? null, statement: step.statement, contentLanguage: step.content_language,
          declarations: partyDeclarations(step.step, step.declarations,
            (step.party ?? (step.step === 'intake' ? 'reporter' : null)) === credential.party) })),
        nextCursor: steps.length > PUBLIC_REPORT_COST.page ? page.at(-1)!.id : null };
    });
  }

  async correspond(caseId: string, secret: string, key: string, input: CorrespondenceInput) {
    if (!Value.Check(correspondenceInput, input) || !validContentLanguage(input.contentLanguage)
      || !keyPattern.test(key) || !input.statement.trim()
      || (input.kind === 'counter_notice') !== (input.counterNotice !== undefined)
      || (input.kind === 'claimant_action') !== (input.courtFiling !== undefined)) {
      throw new GovernanceInvalid('Correspondence is incomplete');
    }
    return this.transaction(async client => {
      const credential = await this.credential(client, caseId, secret);
      await client.query('SELECT id FROM access.governance_case WHERE id = $1 FOR UPDATE', [caseId]);
      const digest = sha256(canonical(input));
      const prior = (await client.query<{ request_digest: string; step_id: string }>(
        `SELECT request_digest, step_id FROM access.governance_correspondence_receipt
         WHERE credential_id = $1 AND key_hash = $2`, [credential.id, sha256(key)])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new GovernanceConflict('Idempotency key reused');
        return { stepId: prior.step_id, replayed: true };
      }
      const report = (await client.query<{ process: string }>(
        `SELECT COALESCE(rc.process,r.process,'platform_rules') AS process FROM access.governance_report r
         LEFT JOIN access.rights_complaint rc ON rc.report_id = r.id WHERE r.id = $1`, [credential.report_id])).rows[0]!;
      if (input.kind === 'counter_notice' && (credential.party !== 'affected' || report.process !== 'dmca_512')) {
        throw new GovernanceDenied('Counter-notice requires the affected copyright party');
      }
      if (input.kind === 'claimant_action' && (credential.party !== 'reporter' || report.process !== 'dmca_512')) {
        throw new GovernanceDenied('Court-filing notice requires the copyright claimant');
      }
      const received = this.clock();
      const process = input.kind === 'appeal' ? 'platform_appeal' : report.process;
      const stepId = input.kind === 'counter_notice'
        ? await recordCounterNotice(client, { caseId, reportId: credential.report_id,
          statement: input.statement, contentLanguage: input.contentLanguage, declarations: input.counterNotice!,
          key: Bun.randomUUIDv7(), requestDigest: digest, now: received })
        : await this.step(client, caseId, credential.report_id, process, input.kind, received, null,
          input.statement, input.contentLanguage, input.courtFiling ?? null, credential.party);
      await client.query(`INSERT INTO access.governance_correspondence_receipt
        (credential_id, key_hash, request_digest, step_id) VALUES ($1, $2, $3, $4)`,
      [credential.id, sha256(key), digest, stepId]);
      return { stepId, replayed: false };
    });
  }

  private async step(client: PoolClient, caseId: string, reportId: string, process: string, kind: string,
    received: Date, due: Date | null, statement: string | null, language: string, declarations: unknown,
    party: 'reporter' | 'affected' | null = null) {
    const id = Bun.randomUUIDv7();
    await client.query(`INSERT INTO access.governance_process_step (id, case_id, report_id, process, step,
      idempotency_key, request_digest, statement, occurred_at, due_at, content_language, declarations, party)
      VALUES ($1, $2, $3, $4, $5, $13, $6, $7, $8, $9, $10, $11, $12)`,
    [id, caseId, reportId, process, kind, sha256(canonical([kind, declarations, statement])), statement,
      received, due, language, declarations, party, id]);
    return id;
  }

  async list(principal: VerifiedPrincipal, after?: string) {
    if (after && !uuidPattern.test(after)) throw new GovernanceInvalid('Invalid report cursor');
    return this.transaction(async client => {
      const rows = (await client.query<{ id: string; case_id: string; reason_code: string; received_at: Date }>(
        `SELECT r.id, r.case_id, r.reason_code, r.received_at FROM access.governance_report r
         JOIN access.principal p ON p.id = r.principal_id WHERE p.account_issuer = $1 AND p.account_subject = $2
         AND p.active AND r.public_receipt_hash IS NOT NULL AND ($3::uuid IS NULL OR r.id > $3)
         ORDER BY r.id LIMIT $4`, [principal.issuer, principal.subject, after ?? null, PUBLIC_REPORT_COST.page + 1])).rows;
      const page = rows.slice(0, PUBLIC_REPORT_COST.page);
      return { reports: page.map(row => ({ reportId: row.id, caseId: row.case_id, category: row.reason_code,
        receivedAt: row.received_at.toISOString() })), nextCursor: rows.length > PUBLIC_REPORT_COST.page ? page.at(-1)!.id : null };
    });
  }
}
