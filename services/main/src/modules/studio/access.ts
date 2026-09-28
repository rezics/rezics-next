import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { ceilingFor, mandateFor, normalizeControlError, requireMandate,
  requirePrincipal } from '../access/topology-control.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { authorWorkGeneration } from '../access/author-baseline.ts';
import { baselineMemberProof } from '../access/baseline.ts';

/** Access-owned evidence for private Studio pages, fenced to one read transaction. */
export class StudioAccess {
  constructor(private readonly pool: Pool, private readonly graph?: Pick<FusekiClient, 'query'>) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(10_000);
    signal.throwIfAborted();
    const client = await new Promise<PoolClient>((resolve, reject) => {
      let waiting = true;
      const abort = () => { waiting = false; reject(new WorkReadUnavailable('Studio Access deadline exceeded')); };
      signal.addEventListener('abort', abort, { once: true });
      this.pool.connect().then(connection => {
        signal.removeEventListener('abort', abort);
        if (!waiting) { connection.release(); return; }
        waiting = false; resolve(connection);
      }, error => { signal.removeEventListener('abort', abort); waiting = false; reject(error); });
    });
    let released = false;
    const abort = () => { if (!released) { released = true; client.release(true); } };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) { abort(); signal.throwIfAborted(); }
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (!fence.rows[0]?.open) throw new WorkReadUnavailable('Access recovery hold');
      const result = await operation(client);
      await client.query('COMMIT');
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (!released) await client.query('ROLLBACK').catch(() => {});
      throw normalizeControlError(error);
    } finally {
      signal.removeEventListener('abort', abort);
      if (!released) client.release();
    }
  }

  async studioWorks(principal: VerifiedPrincipal, agent: string, after: string, limit: number,
    view: 'authored' | 'curated' = 'authored') {
    if (!Number.isInteger(limit) || limit < 1 || limit > 201) {
      throw new WorkReadUnavailable('Invalid Studio page size');
    }
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      const mandate = await requireMandate(client, actor.id, agent, 'agent.control');
      const subject = (await client.query<{ generation: string }>(`SELECT generation::text
        FROM access.authority_subject WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [agent])).rows[0];
      if (!subject) throw new WorkReadUnavailable('Studio Agent is unavailable');
      const rows = (await client.query<{ id: string; action: string; created_at: Date }>(`SELECT id::text,
        action, registered_at AS created_at FROM access.admission a
        WHERE acting_subject = $1 AND action = 'work.create' AND state = 'sealed'
          AND graph_outcome = 'succeeded' AND id > $2::uuid
          ${view === 'authored' ? "AND a.idempotency_key NOT LIKE 'source-adopt-%'" : ''}
        ORDER BY id LIMIT $3`, [agent, after, limit])).rows;
      return { rows, stamp: JSON.stringify([actor.id, actor.epoch, mandate.id,
        mandate.generation, subject.generation]) };
    });
  }

  async studioWorkDetails(principal: VerifiedPrincipal, agent: string,
    works: readonly string[]) {
    if (works.length > 20) throw new WorkReadUnavailable('Studio page exceeds its bound');
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, agent, 'agent.control');
      const edits = (await client.query<{ work: string; updated_at: Date }>(`SELECT
        substring(scope_id FROM 11) AS work, max(sealed_at) AS updated_at
        FROM access.admission WHERE scope_id = ANY($1::text[]) AND action = 'work.edit'
          AND state = 'sealed' AND graph_outcome = 'succeeded'
        GROUP BY scope_id`, [works.map(work => `work:edit:${work}`)])).rows;
      const submissions = (await client.query<{ id: string; work: string; realm: string;
        state: string; opened_at: Date; updated_at: Date }>(`SELECT id::text, work, realm, state,
        opened_at, updated_at FROM access.realm_submission
        WHERE submitting_agent = $1 AND work = ANY($2::text[])
        ORDER BY work, opened_at, id LIMIT 201`, [agent, works])).rows;
      if (submissions.length > 200) throw new WorkReadUnavailable('Studio submissions exceed page budget');
      return { edits, submissions };
    });
  }

  /** Exact Work lookup; O(1) indexed Access rows, independent of inventory size. */
  async studioWork(principal: VerifiedPrincipal, agent: string, work: string) {
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      const mandate = await requireMandate(client, actor.id, agent, 'agent.control');
      const subject = (await client.query<{ generation: string }>(`SELECT generation::text
        FROM access.authority_subject WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [agent])).rows[0];
      if (!subject) throw new WorkReadUnavailable('Studio Agent is unavailable');
      const row = (await client.query<{ action: string; created_at: Date; generation: string }>(`
        SELECT a.action, a.registered_at AS created_at, s.generation::text FROM access.work_maintainer_set s
        JOIN access.work_maintainer m ON m.work = s.work AND m.agent = $2
        JOIN access.admission a ON a.id = s.creation_admission
        WHERE s.work = $1 AND a.acting_subject = $2 AND a.state = 'sealed'
          AND a.graph_outcome = 'succeeded' FOR SHARE OF s`, [work, agent])).rows[0];
      return { row: row ?? null, stamp: JSON.stringify([actor.id, actor.epoch, mandate.id,
        mandate.generation, subject.generation, row?.generation ?? null]) };
    });
  }

  /** One indexed batch of chapter owners and at most twenty Agent-control probes. */
  async chapterWriters(principal: VerifiedPrincipal, agent: string, works: readonly string[]) {
    if (works.length > 20 || works.some(work => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work))) {
      throw new WorkReadUnavailable('Studio chapter page exceeds its bound');
    }
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, agent, 'agent.control');
      const rows = (await client.query<{ work: string; writer: string }>(`
        SELECT s.work, a.acting_subject AS writer FROM access.work_maintainer_set s
        JOIN access.admission a ON a.id = s.creation_admission
        WHERE s.work = ANY($1::text[]) AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
        FOR SHARE OF s`, [works])).rows;
      if (rows.length > works.length || new Set(rows.map(row => row.work)).size !== rows.length) {
        throw new WorkReadUnavailable('Studio chapter authors are ambiguous');
      }
      const control = new Map<string, boolean>();
      for (const writer of new Set(rows.map(row => row.writer))) {
        control.set(writer, writer === agent || !!await mandateFor(client, actor.id, writer, 'agent.control'));
      }
      return new Map(rows.map(row => [row.work, { writer: row.writer, controlled: control.get(row.writer) === true }]));
    });
  }

  /** One exact author proof or an explicit grant, fenced by the same scope gate. */
  async canReadContentVariants(principal: VerifiedPrincipal, actingSubject: string,
    work: string): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.transaction(async client => {
      const scope = `content:variants:${work}`;
      const gate = (await client.query<{ open: boolean }>(`SELECT open FROM access.scope_gate
        WHERE id = $1 FOR SHARE`, [scope])).rows[0];
      if (gate && !gate.open) return false;
      const actor = await requirePrincipal(client, principal);
      if (principal.emailVerified && await baselineMemberProof(client, actor.id, actingSubject)
        && await authorWorkGeneration(client, this.graph, actor.id, actingSubject, work) !== null) return true;
      if (!gate) return false;
      const mandate = await mandateFor(client, actor.id, actingSubject, 'content.variants.read');
      const ceiling = await ceilingFor(client, actingSubject, 'content.variants.read', undefined, scope);
      return !!mandate && !!ceiling;
    });
  }
}
