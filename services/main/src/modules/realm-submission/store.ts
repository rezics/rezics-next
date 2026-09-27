import { randomUUID } from 'node:crypto';
import { requireRealmSubmissionPolicy } from '../access/realm-management-settings.ts';
import type { Pool, PoolClient } from 'pg';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { hash, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { checkedRealmSelectionReceipt, readRealmSelectionReceipt, realmSelectionDigest,
  RealmSelectionUnavailable, sealRealmSelectionAdmission, selectRealmLocal, StaleRealmSelection,
  type SelectRealmLocalInput } from '../work/select-realm.ts';
import { acknowledgeSubmission, requireCandidate } from './graph.ts';
import { SUBMISSION_COST, SubmissionInvalid, SubmissionMissing, SubmissionStale,
  SubmissionUnavailable, viewSubmission, type DecisionInput, type SubmissionInput,
  type SubmissionRow, type SubmissionView, type WithdrawalInput } from './schema.ts';

interface Adoption { admission: RegisteredAdmission; input: SelectRealmLocalInput }
interface Operation { submission_id: string; adoption: Adoption | null; result: SubmissionView | null }
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Access owns the private workflow; Jena's existing selection owner is the only
 * authority for adoption. A committed reservation is required before dispatch.
 * Row locking semantics: https://www.postgresql.org/docs/18/explicit-locking.html
 * (checked 2026-09-28). Graph calls never occur in an uncommitted adoption attempt. */
export class RealmSubmissionStore {
  constructor(private readonly pool: Pool,
    private readonly access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
    private readonly env: WorkActivationEnvironment) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${SUBMISSION_COST.statementTimeoutMs}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${SUBMISSION_COST.lockTimeoutMs}ms'`);
      const fence = await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE');
      if (!fence.rowCount) throw new SubmissionUnavailable('Access recovery is in progress');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async admission(principal: VerifiedPrincipal, actingSubject: string, action: string,
    scope: string, key: string, digest: string): Promise<RegisteredAdmission> {
    // A durable operation can settle after the original permission is revoked.
    // This lookup permits only its original principal, exact actor and intent.
    const saved = (await this.pool.query<{ admission: RegisteredAdmission }>(`SELECT jsonb_build_object(
      'id', a.id, 'principalId', a.principal_id, 'actingSubject', a.acting_subject,
      'scope', a.scope_id, 'action', a.action, 'idempotencyKey', a.idempotency_key,
      'requestDigest', a.request_digest, 'authorityEpoch', a.authority_epoch::text,
      'expiresAt', a.expires_at, 'state', a.state, 'dispatchEligible', false, 'replayed', true) AS admission
      FROM access.admission a JOIN access.principal p ON p.id = a.principal_id AND p.active
      JOIN access.realm_submission_operation o ON o.admission_id = a.id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND a.action = $3 AND a.idempotency_key = $4`,
    [principal.issuer, principal.subject, action, key])).rows[0]?.admission;
    if (saved) {
      if (saved.requestDigest !== digest || saved.actingSubject !== actingSubject || saved.scope !== scope) {
        throw new AdmissionConflict('Submission key binds another intent');
      }
      return saved;
    }
    const registered = await this.access.register({ principal, actingSubject, action, scope,
      idempotencyKey: key, requestDigest: digest });
    if (registered.state === 'sealed' || !registered.dispatchEligible) {
      throw new SubmissionStale('Submission admission is no longer dispatchable');
    }
    return this.access.claim(registered.id, digest);
  }

  private async command(principal: VerifiedPrincipal, actor: string, action: string, scope: string,
    key: string, intent: unknown,
    prepare: (client: PoolClient, admission: RegisteredAdmission) => Promise<Operation>) {
    return fusekiReadBudget.run({ signal: AbortSignal.timeout(SUBMISSION_COST.deadlineMs),
      callsLeft: SUBMISSION_COST.commandGraphCalls, bytesLeft: SUBMISSION_COST.commandGraphBytes }, async () => {
      await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
      const admission = await this.admission(principal, actor, action, scope, key,
        hash(stable({ family: 'realm-submission-v1', action, scope, intent })));
      let operation: Operation;
      try {
        operation = await this.transaction(async client => {
          const ticket = (await client.query<{ fresh: boolean }>(`SELECT
            (state = 'claimed' AND expires_at > clock_timestamp()) AS fresh
            FROM access.admission WHERE id = $1 FOR UPDATE`, [admission.id])).rows[0];
          const prior = (await client.query<Operation>(`SELECT submission_id, adoption, result
            FROM access.realm_submission_operation WHERE admission_id = $1`, [admission.id])).rows[0];
          if (prior) return prior;
          if (!ticket?.fresh) throw new SubmissionStale('Submission admission expired');
          return prepare(client, admission);
        });
      } catch (error) {
        // Only definite pre-commit domain refusals can be cancelled. A failed
        // COMMIT response is ambiguous and must be retried with the same key.
        if (error instanceof SubmissionStale || error instanceof SubmissionMissing
          || error instanceof SubmissionInvalid || error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
          await this.access.recordGraphOutcome(admission.id,
            await acknowledgeSubmission(this.env, admission, 'cancelled'));
        }
        throw error;
      }
      if (!operation.result && operation.adoption) {
        operation = await this.finishAdoption(admission, operation);
      }
      if (!operation.result) throw new SubmissionUnavailable('Submission settlement is pending');
      await this.access.recordGraphOutcome(admission.id,
        await acknowledgeSubmission(this.env, admission, 'succeeded'));
      return { submission: operation.result, replayed: admission.replayed };
    });
  }

  private async save(client: PoolClient, admission: RegisteredAdmission, row: SubmissionRow,
    adoption: Adoption | null = null): Promise<Operation> {
    const result = adoption ? null : viewSubmission(row);
    await client.query(`INSERT INTO access.realm_submission_operation
      (admission_id, submission_id, adoption, result) VALUES ($1, $2, $3, $4)`,
    [admission.id, row.id, adoption, result]);
    return { submission_id: row.id, adoption, result };
  }

  submit(principal: VerifiedPrincipal, realm: string, input: SubmissionInput, key: string) {
    if ((input.kind === 'correction') !== (input.correctionOf !== null)) {
      throw new SubmissionInvalid('A correction must name the Realm selection it replaces');
    }
    return this.command(principal, input.actingSubject, 'submission.submit', `submission:submit:${realm}`,
      key, input, async (client, admission) => {
        await requireRealmSubmissionPolicy(client, realm, admission.principalId, input.actingSubject);
        await requireCandidate(this.env, realm, input);
        const row = (await client.query<SubmissionRow>(`INSERT INTO access.realm_submission
          (id, realm, kind, work, main_version, contribution, publication_decision, selected_draft,
           correction_of, submitting_agent, state, revision)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`,
        [randomUUID(), realm, input.kind, input.work, input.mainVersion, input.contribution,
          input.publicationDecision, input.selectedDraft, input.correctionOf, input.actingSubject, randomUUID()])).rows[0]!;
        return this.save(client, admission, row);
      });
  }

  private async lockSubmission(client: PoolClient, realm: string, id: string, expectedRevision: string) {
    const row = (await client.query<SubmissionRow>(`SELECT * FROM access.realm_submission
      WHERE id = $1 AND realm = $2 FOR UPDATE`, [id, realm])).rows[0];
    if (!row) throw new SubmissionMissing('Submission is unavailable');
    if (row.revision !== expectedRevision) throw new SubmissionStale('Submission revision changed');
    return row;
  }

  decide(principal: VerifiedPrincipal, realm: string, id: string, input: DecisionInput, key: string) {
    if (input.outcome !== 'accept' && !input.publicReason?.trim()) {
      throw new SubmissionInvalid('Rejection and change requests require a public reason');
    }
    return this.command(principal, input.actingSubject, 'review.decide', `review:decide:${realm}`, key,
      { id, ...input }, async (client, admission) => {
        const row = await this.lockSubmission(client, realm, id, input.expectedRevision);
        if (row.state !== 'pending') throw new SubmissionStale('Submission is not pending');
        if (input.outcome !== 'accept') {
          try {
            await requireCandidate(this.env, realm, { actingSubject: row.submitting_agent, kind: row.kind,
              work: row.work, mainVersion: row.main_version, contribution: row.contribution,
              publicationDecision: row.publication_decision, selectedDraft: row.selected_draft,
              correctionOf: row.correction_of });
          } catch (error) {
            if (error instanceof SubmissionMissing) throw new SubmissionStale('Submission candidate was superseded');
            throw error;
          }
        }
        let adoption: Adoption | null = null;
        if (input.outcome === 'accept') {
          if (row.correction_of && row.correction_of !== input.expectedSelectionHead) {
            throw new SubmissionStale('Correction must replace its exact Realm selection');
          }
          const selection: SelectRealmLocalInput = { context: { kind: 'realm-local', id: realm },
            work: row.work, mainVersion: row.main_version, contribution: row.contribution,
            publicationDecision: row.publication_decision, expectedSelectionHead: input.expectedSelectionHead,
            selectionBasis: 'realm-manager-review', actingSubject: input.actingSubject };
          const digest = realmSelectionDigest(selection);
          const registered = await this.access.register({ principal, actingSubject: input.actingSubject,
            action: 'publication.adopt', scope: `publication:adopt:${realm}`,
            idempotencyKey: `submission:${admission.id}`, requestDigest: digest });
          const claimed = registered.state === 'sealed' || !registered.dispatchEligible
            ? registered : await this.access.claim(registered.id, digest);
          adoption = { admission: claimed, input: selection };
        }
        const updated = (await client.query<SubmissionRow>(`UPDATE access.realm_submission SET
          state = $2, revision = $3, generation = generation + 1, decision_operation = $4,
          reviewer = $5, public_reason = $6, internal_note = $7, updated_at = clock_timestamp()
          WHERE id = $1 RETURNING *`, [id, input.outcome === 'accept' ? 'deciding'
          : input.outcome === 'reject' ? 'rejected' : 'changes-requested', randomUUID(), admission.id,
        input.actingSubject, input.publicReason, input.internalNote])).rows[0]!;
        return this.save(client, admission, updated, adoption);
      });
  }

  withdraw(principal: VerifiedPrincipal, realm: string, id: string, input: WithdrawalInput, key: string) {
    return this.command(principal, input.actingSubject, 'submission.withdraw', `submission:submit:${realm}`,
      key, { id, ...input }, async (client, admission) => {
        // Check ownership before disclosing the current revision or state.
        const owner = (await client.query<{ submitting_agent: string }>(`SELECT submitting_agent
          FROM access.realm_submission WHERE id = $1 AND realm = $2`, [id, realm])).rows[0];
        if (owner?.submitting_agent !== input.actingSubject) throw new SubmissionMissing('Submission is unavailable');
        const row = await this.lockSubmission(client, realm, id, input.expectedRevision);
        if (!['pending', 'changes-requested'].includes(row.state)) throw new SubmissionStale('Submission cannot be withdrawn');
        const updated = (await client.query<SubmissionRow>(`UPDATE access.realm_submission SET state = 'withdrawn',
          revision = $2, generation = generation + 1, updated_at = clock_timestamp()
          WHERE id = $1 RETURNING *`, [id, randomUUID()])).rows[0]!;
        return this.save(client, admission, updated);
      });
  }

  private async finishAdoption(admission: RegisteredAdmission, operation: Operation): Promise<Operation> {
    const stored = operation.adoption!;
    // PostgreSQL jsonb reorders object keys. The selection owner's existing
    // digest serializes context directly, so restore its canonical field order.
    const adoption: Adoption = { admission: stored.admission, input: { ...stored.input,
      context: { kind: 'realm-local', id: stored.input.context.id } } };
    let terminal = await readRealmSelectionReceipt(this.env, adoption.admission.id);
    if (!terminal) {
      if (!adoption.admission.dispatchEligible || Date.parse(adoption.admission.expiresAt) <= Date.now()) {
        terminal = await sealRealmSelectionAdmission(this.env, adoption.admission);
      } else {
        try { terminal = await selectRealmLocal(this.env, adoption.admission, adoption.input); }
        catch (error) {
          if (!(error instanceof StaleRealmSelection || error instanceof RealmSelectionUnavailable)) throw error;
          terminal = await sealRealmSelectionAdmission(this.env, adoption.admission);
        }
      }
    }
    if (terminal.outcome === 'succeeded') {
      checkedRealmSelectionReceipt(terminal, adoption.admission, adoption.input, realmSelectionDigest(adoption.input));
    }
    await this.access.recordGraphOutcome(adoption.admission.id, terminal);
    return this.transaction(async client => {
      const saved = (await client.query<Operation>(`SELECT submission_id, adoption, result
        FROM access.realm_submission_operation WHERE admission_id = $1 FOR UPDATE`, [admission.id])).rows[0]!;
      if (saved.result) return saved;
      const row = (await client.query<SubmissionRow>(`SELECT * FROM access.realm_submission
        WHERE id = $1 AND decision_operation = $2 AND state = 'deciding' FOR UPDATE`,
      [operation.submission_id, admission.id])).rows[0];
      if (!row || terminal.outcome === 'succeeded' && terminal.selectedDraft !== row.selected_draft) {
        throw new SubmissionUnavailable('Adoption differs from the reserved submission');
      }
      const updated = (await client.query<SubmissionRow>(`UPDATE access.realm_submission SET
        state = $2, revision = $3, generation = generation + 1, selection = $4,
        adoption_receipt = $5, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      [row.id, terminal.outcome === 'succeeded' ? 'accepted' : 'stale', randomUUID(),
        terminal.selection ?? null, terminal.outcome === 'succeeded' ? terminal.receipt : null])).rows[0]!;
      const result = viewSubmission(updated);
      await client.query('UPDATE access.realm_submission_operation SET result = $2 WHERE admission_id = $1',
        [admission.id, result]);
      return { ...saved, result };
    });
  }
}
