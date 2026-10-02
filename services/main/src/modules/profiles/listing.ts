import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { requireMandate, requirePrincipal } from '../access/topology-control.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export type AgentListing = 'listed' | 'unlisted';
export interface AgentListingState { listing: AgentListing; version: number; changedAt: string | null }
export class InvalidAgentListing extends Error {}
export class AgentListingDenied extends Error {}
export class StaleAgentListing extends Error {}
export class AgentListingConflict extends Error {}
export class AgentListingUnavailable extends Error {}


interface Row { listing: AgentListing; version: number; changed_at: Date }
const state = (row?: Row): AgentListingState => ({ listing: row?.listing ?? 'listed',
  version: row?.version ?? 0, changedAt: row?.changed_at.toISOString() ?? null });

/** Access owns discovery listing, independently of library and profile disclosure.
 * The active Agent row serializes first writes; retries recheck controller authority. */
export class AgentListingStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => { throw new AgentListingUnavailable('Access is unavailable'); });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = (await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
      if (!recovery?.open) throw new AgentListingUnavailable('Access recovery hold');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new AgentListingUnavailable('Listing owner timed out');
      }
      throw error;
    } finally { client.release(); }
  }

  async read(agent: string): Promise<AgentListingState> {
    if (!ID.test(agent)) throw new InvalidAgentListing('Invalid Agent');
    return this.transaction(async client => {
      const active = await client.query(`SELECT 1 FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active`, [agent]);
      if (!active.rowCount) throw new AgentListingDenied('Agent unavailable');
      const row = (await client.query<Row>(`SELECT listing, version, changed_at
        FROM access.agent_listing WHERE agent_id = $1`, [agent])).rows[0];
      return state(row);
    });
  }

  /** At most 50 active Agent point rows for search/suggestion owners. Missing
   * Agents have no entry and must not be treated as implicitly listed. */
  async readBatch(agents: readonly string[]) {
    if (agents.length > 50 || agents.some(agent => !ID.test(agent))) throw new InvalidAgentListing('Invalid Agent batch');
    return this.transaction(async client => {
      const rows = (await client.query<{ agent: string; listing: AgentListing }>(`SELECT a.id AS agent,
        COALESCE(l.listing,'listed') AS listing FROM access.authority_subject a
        LEFT JOIN access.agent_listing l ON l.agent_id = a.id
        WHERE a.id = ANY($1::text[]) AND a.kind = 'agent' AND a.active`,[agents])).rows;
      return new Map(rows.map(row => [row.agent,row.listing]));
    });
  }

  async readForOwner(principal: VerifiedPrincipal, agent: string): Promise<AgentListingState> {
    if (!ID.test(agent)) throw new InvalidAgentListing('Invalid Agent');
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, agent, 'agent.control');
      const row = (await client.query<Row>(`SELECT listing, version, changed_at
        FROM access.agent_listing WHERE agent_id = $1`, [agent])).rows[0];
      return state(row);
    });
  }

  async write(principal: VerifiedPrincipal, agent: string, listing: AgentListing,
    expectedVersion: number, idempotencyKey: string) {
    if (!ID.test(agent) || !KEY.test(idempotencyKey) || !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 0 || expectedVersion >= 2_147_483_647 || !['listed', 'unlisted'].includes(listing)) {
      throw new InvalidAgentListing('Invalid listing command');
    }
    const digest = createHash('sha256').update(JSON.stringify([agent, listing, expectedVersion])).digest('hex');
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-listing:${actor.id}:${idempotencyKey}`]);
      const agentRow = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR UPDATE`, [agent]);
      if (!agentRow.rowCount) throw new AgentListingDenied('Agent unavailable');
      await requireMandate(client, actor.id, agent, 'agent.control');
      const prior = (await client.query<{ request_digest: string; listing: AgentListing;
        version: number; changed_at: Date }>(`SELECT request_digest, listing, version, changed_at
        FROM access.agent_listing_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [actor.id, idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new AgentListingConflict('Idempotency key reused');
        return { ...state(prior), replayed: true };
      }
      const current = (await client.query<Row>(`SELECT listing, version, changed_at
        FROM access.agent_listing WHERE agent_id = $1 FOR UPDATE`, [agent])).rows[0];
      if ((current?.version ?? 0) !== expectedVersion) throw new StaleAgentListing('Listing changed');
      const written = (await client.query<Row>(`INSERT INTO access.agent_listing
        (agent_id, listing, version) VALUES ($1,$2,$3)
        ON CONFLICT (agent_id) DO UPDATE SET listing = EXCLUDED.listing,
          version = EXCLUDED.version, changed_at = clock_timestamp()
        RETURNING listing, version, changed_at`, [agent, listing, expectedVersion + 1])).rows[0]!;
      await client.query(`INSERT INTO access.agent_listing_receipt
        (principal_id, idempotency_key, request_digest, agent_id, listing, version, changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actor.id, idempotencyKey, digest, agent,
        written.listing, written.version, written.changed_at]);
      return { ...state(written), replayed: false };
    });
  }
}
