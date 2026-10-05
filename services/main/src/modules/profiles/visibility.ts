import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { requireMandate, requirePrincipal } from '../access/topology-control.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export type LibraryVisibility = 'public' | 'followers' | 'private';
export interface LibraryVisibilityState { visibility: LibraryVisibility; version: number; changedAt: string | null }
export class InvalidLibraryVisibility extends Error {}
export class LibraryVisibilityDenied extends Error {}
export class StaleLibraryVisibility extends Error {}
export class LibraryVisibilityConflict extends Error {}
export class LibraryVisibilityUnavailable extends Error {}
export const LIBRARY_VISIBILITY_COST = { accessTransactions: 1,
  readStatements: 8, writeStatements: 12, statementTimeoutMs: 5_000 } as const;

interface Row { visibility: LibraryVisibility; version: number; changed_at: Date }
const state = (row?: Row): LibraryVisibilityState => ({ visibility: row?.visibility ?? 'private',
  version: row?.version ?? 0, changedAt: row?.changed_at.toISOString() ?? null });

/** Access owns the choice and serializes the absent first version on the Agent row.
 * The followers value is reserved; it cannot publish before follow authority exists. */
export class AgentLibraryVisibilityStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = (await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
      if (!recovery?.open) throw new LibraryVisibilityUnavailable('Access recovery hold');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new LibraryVisibilityUnavailable('Visibility owner timed out');
      }
      throw error;
    } finally { client.release(); }
  }

  async read(agent: string): Promise<LibraryVisibilityState> {
    if (!ID.test(agent)) throw new InvalidLibraryVisibility('Invalid Agent');
    return this.transaction(async client => {
      const active = await client.query(`SELECT 1 FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active`, [agent]);
      if (!active.rowCount) throw new LibraryVisibilityDenied('Agent unavailable');
      const row = (await client.query<Row>(`SELECT visibility, version, changed_at
        FROM access.agent_library_visibility WHERE agent_id = $1`, [agent])).rows[0];
      return state(row);
    });
  }

  async readForOwner(principal: VerifiedPrincipal, agent: string): Promise<LibraryVisibilityState> {
    if (!ID.test(agent)) throw new InvalidLibraryVisibility('Invalid Agent');
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      await requireMandate(client, actor.id, agent, 'agent.control');
      const row = (await client.query<Row>(`SELECT visibility, version, changed_at
        FROM access.agent_library_visibility WHERE agent_id = $1`, [agent])).rows[0];
      return state(row);
    });
  }

  async write(principal: VerifiedPrincipal, agent: string, visibility: LibraryVisibility,
    expectedVersion: number, idempotencyKey: string) {
    if (!ID.test(agent) || !KEY.test(idempotencyKey) || !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 0 || !['public', 'private'].includes(visibility)) {
      throw new InvalidLibraryVisibility('Invalid visibility command');
    }
    const digest = createHash('sha256').update(JSON.stringify([agent, visibility, expectedVersion])).digest('hex');
    return this.transaction(async client => {
      const actor = await requirePrincipal(client, principal);
      // Acquire UPDATE before mandate validation takes SHARE on this same row;
      // two concurrent writers must queue rather than deadlock on lock upgrades.
      const agentRow = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR UPDATE`, [agent]);
      if (!agentRow.rowCount) throw new LibraryVisibilityDenied('Agent unavailable');
      await requireMandate(client, actor.id, agent, 'agent.control');
      const prior = (await client.query<{ request_digest: string; visibility: LibraryVisibility;
        version: number; changed_at: Date }>(`SELECT request_digest, visibility, version, changed_at
        FROM access.agent_library_visibility_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [actor.id, idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new LibraryVisibilityConflict('Idempotency key reused');
        return { ...state(prior), replayed: true };
      }
      const current = (await client.query<Row>(`SELECT visibility, version, changed_at
        FROM access.agent_library_visibility WHERE agent_id = $1 FOR UPDATE`, [agent])).rows[0];
      if ((current?.version ?? 0) !== expectedVersion) throw new StaleLibraryVisibility('Visibility changed');
      const written = (await client.query<Row>(`INSERT INTO access.agent_library_visibility
        (agent_id, visibility, version) VALUES ($1,$2,$3)
        ON CONFLICT (agent_id) DO UPDATE SET visibility = EXCLUDED.visibility,
          version = EXCLUDED.version, changed_at = clock_timestamp()
        RETURNING visibility, version, changed_at`, [agent, visibility, expectedVersion + 1])).rows[0]!;
      await client.query(`INSERT INTO access.agent_library_visibility_receipt
        (principal_id, idempotency_key, request_digest, agent_id, visibility, version, changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actor.id, idempotencyKey, digest, agent,
        written.visibility, written.version, written.changed_at]);
      return { ...state(written), replayed: false };
    });
  }
}
