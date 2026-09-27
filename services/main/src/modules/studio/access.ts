import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { ceilingFor, mandateFor, normalizeControlError, requireMandate,
  requirePrincipal } from '../access/topology-control.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';

/** Access-owned evidence for private Studio pages, fenced to one read transaction. */
export class StudioAccess {
  constructor(private readonly pool: Pool) {}

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

  /** Explicit grant only; the Access baseline owner defines when the grant is issued. */
  async canReadContentVariants(principal: VerifiedPrincipal, actingSubject: string,
    work: string): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.transaction(async client => {
      const scope = `content:variants:${work}`;
      const gate = (await client.query<{ open: boolean }>(`SELECT open FROM access.scope_gate
        WHERE id = $1 FOR SHARE`, [scope])).rows[0];
      if (!gate?.open) return false;
      const actor = await requirePrincipal(client, principal);
      const mandate = await mandateFor(client, actor.id, actingSubject, 'content.variants.read');
      const ceiling = await ceilingFor(client, actingSubject, 'content.variants.read', undefined, scope);
      return !!mandate && !!ceiling;
    });
  }
}
