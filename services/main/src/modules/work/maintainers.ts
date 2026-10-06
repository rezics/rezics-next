import { assertControllerContinuity, lockControllerContinuity } from '../access/controller-continuity.ts';
import { ControlConflict, ControlUnavailable } from '../access/topology-control.ts';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable,
  type VerifiedPrincipal } from '../access/admission.ts';
import { maintainerControllerProof } from './maintainer-proof.ts';
import { hash, GRAPHS, iri, type WorkActivationEnvironment } from './activate.ts';
import { unerased } from './public-patterns.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

export const MAINTAINER_COST = { maxMaintainers: 32, graphQueries: 2,
  graphBytes: 2048, lockTimeoutMs: 2000, statementTimeoutMs: 5000 } as const;
export interface MaintainerChange {
  work: string; actingSubject: string; target: string;
  action: 'add' | 'transfer'; expectedGeneration: string;
}
interface SetRow { main_version: string; generation: string }

/** The existing selection scope lock serializes transfer with registration and
 * claim. Claimed selections must settle before transfer can return success.
 * Registered tickets are invalidated by the saved generation, never rebound.
 * PostgreSQL row-lock semantics: https://www.postgresql.org/docs/18/explicit-locking.html
 * (reviewed 2026-09-28). Reads enumerate at most 32 members of one Work. */
export class WorkMaintainers {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}

  private async current(work: string): Promise<void> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) throw new AdmissionDenied('invalid Work');
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const result = await this.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} a ?kind ; rv:head ?head . VALUES ?kind { schema:CreativeWork rv:Post } }
        ${unerased(iri(work))} }`, 1024);
    if (result.boolean !== true) throw new AdmissionDenied('Work is unavailable');
  }

  private async members(client: Pick<PoolClient, 'query'>, work: string): Promise<string[]> {
    const rows = await client.query<{ agent: string }>(`SELECT agent FROM access.work_maintainer
      WHERE work = $1 ORDER BY agent LIMIT 33`, [work]);
    if (rows.rows.length > MAINTAINER_COST.maxMaintainers) throw new AdmissionUnavailable('maintainer bound exceeded');
    return rows.rows.map(row => row.agent);
  }

  async read(work: string) {
    await this.current(work);
    // One statement provides a consistent set/generation snapshot.
    const row = (await this.pool.query<{ generation: string; maintainers: string[] }>(`
      SELECT s.generation::text, ARRAY(SELECT m.agent FROM access.work_maintainer m
        WHERE m.work = s.work ORDER BY m.agent LIMIT 32) AS maintainers
      FROM access.work_maintainer_set s WHERE s.work = $1`, [work])).rows[0];
    if (!row) throw new AdmissionDenied('Work maintainers are unavailable');
    return { work, ...row };
  }

  async change(principal: VerifiedPrincipal, input: MaintainerChange, key: string) {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)
      || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedGeneration)
      || !['add', 'transfer'].includes(input.action)
      || ![input.actingSubject, input.target].every(value => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value))) {
      throw new AdmissionDenied('invalid maintainer change');
    }
    const fresh = principal.currentAssertion ? await principal.currentAssertion() : principal;
    if (fresh.issuer !== principal.issuer || fresh.subject !== principal.subject || fresh.emailVerified !== true) {
      throw new AdmissionDenied('verified Account is required');
    }
    await this.current(input.work);
    const digest = hash(JSON.stringify({ family: 'work-maintainers-v1', work: input.work,
      actor: input.actingSubject, target: input.target, action: input.action, expectedGeneration: input.expectedGeneration }));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      if (!(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE')).rowCount) {
        throw new AdmissionUnavailable('Access recovery hold');
      }
      const set = (await client.query<SetRow>(`SELECT main_version, generation::text
        FROM access.work_maintainer_set WHERE work = $1`, [input.work])).rows[0];
      if (!set) throw new AdmissionDenied('Work maintainers are unavailable');
      const scope = `publication:select:${set.main_version}`;
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      const gate = await client.query('SELECT 1 FROM access.scope_gate WHERE id = $1 AND open AND dispatch_open FOR UPDATE', [scope]);
      if (!gate.rowCount) throw new AdmissionDenied('selection scope is closed');
      const person = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`, [fresh.issuer, fresh.subject])).rows[0];
      if (!person) throw new AdmissionDenied('principal is inactive');
      const prior = (await client.query<{ id: string; request_digest: string; generation: string; maintainers: string[] }>(`
        SELECT id, request_digest, generation::text, maintainers FROM access.work_maintainer_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [person.id, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new AdmissionConflict('maintainer key binds another intent');
        await client.query('COMMIT');
        return { work: input.work, receipt: prior.id, generation: prior.generation, maintainers: prior.maintainers, replayed: true };
      }
      await lockControllerContinuity(client, [input.target]);
      await assertControllerContinuity(client, [input.target]);
      if (!await maintainerControllerProof(client, person.id, input.actingSubject)) throw new AdmissionDenied('Agent is not controlled by this member');
      const current = (await client.query<SetRow>(`SELECT main_version, generation::text
        FROM access.work_maintainer_set WHERE work = $1 FOR UPDATE`, [input.work])).rows[0]!;
      const members = await this.members(client, input.work);
      if (!members.includes(input.actingSubject)) throw new AdmissionDenied('Agent is not a Work maintainer');
      if (current.generation !== input.expectedGeneration) throw new AdmissionConflict('maintainer generation changed');
      if (input.target === input.actingSubject) throw new AdmissionConflict('target must be another Agent');
      if (!(await client.query(`SELECT 1 FROM access.authority_subject WHERE id = $1 AND active AND kind = 'agent' FOR SHARE`, [input.target])).rowCount) {
        throw new AdmissionDenied('target Agent is inactive');
      }
      if ((await client.query(`SELECT id FROM access.admission WHERE scope_id = $1
        AND action = 'publication.select' AND state = 'claimed' LIMIT 1`, [scope])).rowCount) {
        throw new AdmissionConflict('a claimed selection must settle before maintainership changes');
      }
      if ((await client.query(`SELECT a.id FROM access.baseline_admission b
        JOIN access.admission a ON a.id = b.admission_id
        WHERE b.author_work = $1 AND a.state = 'claimed' LIMIT 1`, [input.work])).rowCount) {
        throw new AdmissionConflict('a claimed author command must settle before maintainership changes');
      }
      if (input.action === 'add' && !members.includes(input.target) && members.length >= MAINTAINER_COST.maxMaintainers) {
        throw new AdmissionConflict('Work has 32 maintainers');
      }
      await client.query('INSERT INTO access.work_maintainer (work, agent) VALUES ($1,$2) ON CONFLICT DO NOTHING', [input.work, input.target]);
      if (input.action === 'transfer') await client.query('DELETE FROM access.work_maintainer WHERE work = $1 AND agent = $2', [input.work, input.actingSubject]);
      const generation = (BigInt(current.generation) + 1n).toString();
      await client.query('UPDATE access.work_maintainer_set SET generation = $2 WHERE work = $1', [input.work, generation]);
      const maintainers = await this.members(client, input.work);
      const receipt = randomUUID();
      await client.query(`INSERT INTO access.work_maintainer_receipt
        (id, work, principal_id, idempotency_key, request_digest, actor, target, action, generation, maintainers)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [receipt, input.work, person.id, key, digest,
        input.actingSubject, input.target, input.action, generation, JSON.stringify(maintainers)]);
      await client.query('COMMIT');
      return { work: input.work, receipt, generation, maintainers, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof ControlConflict) throw new AdmissionConflict(error.message);
      if (error instanceof ControlUnavailable) throw new AdmissionUnavailable(error.message);
      throw error;
    }
    finally { client.release(); }
  }
}
