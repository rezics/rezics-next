import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { normalizeControlError, requirePrincipal, requireMandate } from '../access/topology-control.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { AgentLibraryVisibilityStore } from './visibility.ts';
import { AgentListingStore } from './listing.ts';
import { baselineMemberProof } from '../access/baseline.ts';

export interface OwnRatingHead { id: string; revision: string; work: string; mainVersion: string;
  context: string; slot: string; principalId: string; admission: string; digest: string;
  receipt: string; epoch: string; sequence: string; actingSubject: string; contextRevision: string }

/** Access-only adapter: private Account/Agent links and counting slots never
 * leave this boundary in an HTTP response. No new authority or SQL schema. */
export class ProfilesAccess {
  readonly visibility: AgentLibraryVisibilityStore;
  readonly listing: AgentListingStore;
  constructor(private readonly pool: Pool) {
    this.visibility = new AgentLibraryVisibilityStore(pool);
    this.listing = new AgentListingStore(pool);
  }

  /** `read` callbacks write nothing; see controlRead for their asynchronous commit. */
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>, read = false): Promise<T> {
    const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(10_000);
    signal.throwIfAborted();
    const client = await new Promise<PoolClient>((resolve, reject) => {
      let waiting = true;
      const abort = () => { waiting = false; reject(new WorkReadUnavailable('Profile Access deadline exceeded')); };
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
      await client.query(read ? 'BEGIN; SET LOCAL synchronous_commit = off' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
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

  async agentFence(agent: string): Promise<string | null> {
    return (await this.agentFences([agent])).get(agent) ?? null;
  }

  /** One indexed probe for a page of Agents; an inactive Agent is absent. */
  async agentFences(agents: readonly string[]): Promise<Map<string, string>> {
    if (!agents.length) return new Map();
    return this.transaction(async client => {
      const rows = await client.query<{ id: string; generation: string; recovery: string }>(`SELECT s.id,
        s.generation, f.generation AS recovery FROM access.authority_subject s CROSS JOIN access.recovery_fence f
        WHERE s.id = ANY($1::text[]) AND s.kind = 'agent' AND s.active AND f.id = true`, [agents]);
      return new Map(rows.rows.map(row => [row.id, `${row.recovery}:${row.generation}`]));
    }, true);
  }

  async libraryFence(principal: VerifiedPrincipal, agent: string,
    action: 'contribution.read' | 'rating.observation.read') {
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      const baseline = action === 'contribution.read' && principal.emailVerified === true
        ? await baselineMemberProof(client, actor.id, agent) : null;
      const mandate = baseline ? { id: baseline.representation_id, generation: baseline.representation_generation }
        : await requireMandate(client, actor.id, agent, action);
      const row = (await client.query<{ generation: string; recovery: string }>(`SELECT s.generation,
        f.generation AS recovery FROM access.authority_subject s CROSS JOIN access.recovery_fence f
        WHERE s.id = $1 AND s.active AND f.id = true`, [agent])).rows[0];
      if (!row) throw new WorkReadUnavailable('Library authority is unavailable');
      return { principalId: actor.id, stamp: JSON.stringify([actor.id, actor.epoch, mandate.id,
        mandate.generation, row.generation, row.recovery, baseline?.policy_generation ?? null,
        baseline?.provision_id ?? null]) };
    });
  }

  async ratings(principalId: string, after: string, limit: number): Promise<OwnRatingHead[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 21) throw new WorkReadUnavailable('Invalid page budget');
    return this.transaction(async client => {
      // Principal partition is selected before paging. The existing inventory
      // has no principal-leading seek index: five-second timeout, no scaling claim.
      const result = await client.query<{ id: string; revision: string; work: string; main_version: string;
        context: string; slot: string; principal_id: string; admission: string; request_digest: string;
        graph_receipt: string; graph_data_epoch: string; graph_sequence: string; acting_subject: string;
        context_revision: string; valid: boolean }>(`
        SELECT h.observation AS id, h.revision, h.work, h.main_version, h.context, h.slot,
          h.principal_id, a.id AS admission, a.request_digest, a.graph_receipt,
          a.graph_data_epoch, a.graph_sequence, a.acting_subject, c.revision AS context_revision,
          (a.principal_id = h.principal_id AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
            AND a.action = 'rating.observation.set') AS valid
        FROM access.rating_aggregate_head h
        JOIN access.rating_aggregate_context c ON c.context = h.context
        JOIN access.admission a ON a.id = h.admission_id
        WHERE h.principal_id = $1 AND c.realm = $2 AND h.target_release IS NULL
          AND h.observation > $3 ORDER BY h.observation LIMIT $4`,
      [principalId, GLOBAL_RATING_POPULATION_OWNER, after, limit]);
      return result.rows.map(row => {
        if (!row.valid || !/^\d+$/.test(row.graph_sequence)) throw new WorkReadUnavailable('Rating inventory is unsealed');
        return { id: row.id, revision: row.revision, work: row.work, mainVersion: row.main_version,
          context: row.context, slot: row.slot, principalId: row.principal_id, admission: row.admission,
          digest: row.request_digest, receipt: row.graph_receipt, epoch: row.graph_data_epoch,
          sequence: row.graph_sequence, actingSubject: row.acting_subject, contextRevision: row.context_revision };
      });
    });
  }
}
