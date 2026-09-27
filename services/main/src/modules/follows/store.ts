import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlTransaction, ControlConflict, ControlInvalid, ControlStale } from '../access/topology-control.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { FOLLOWS_COST, type FollowCommand, type FollowKind, type FollowResult } from './contract.ts';
import { followPrincipal } from './authority.ts';

export interface FollowRow { target: string; kind: FollowKind; following: boolean; revision: string }
export function commandKey(key: string) {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new ControlInvalid('A valid Idempotency-Key is required');
}
export class FollowsStore {
  constructor(private readonly pool: Pool) {}

  async read(principal: VerifiedPrincipal, agent: string, after = '', kind?: FollowKind, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > FOLLOWS_COST.pageSize) throw new ControlInvalid('Invalid page size');
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const inventory = (await client.query<{ revision: string }>(
        'SELECT revision FROM access.follow_inventory WHERE principal_id = $1 FOR SHARE', [owner])).rows[0];
      const rows = await client.query<FollowRow>(`SELECT target, kind, following, revision FROM access.follow
        WHERE principal_id = $1 AND following AND target > $2 ${kind ? 'AND kind = $4' : ''}
        ORDER BY target LIMIT $3`, kind ? [owner, after, limit + 1, kind] : [owner, after, limit + 1]);
      return { owner, revision: inventory?.revision ?? null, rows: rows.rows };
    });
  }

  async state(target: string, reader?: { principal: VerifiedPrincipal; agent: string }) {
    return controlTransaction(this.pool, async client => {
      const owner = reader ? await followPrincipal(client, reader.principal, reader.agent) : null;
      const row = owner ? (await client.query<FollowRow>(`SELECT target, kind, following, revision
        FROM access.follow WHERE principal_id = $1 AND target = $2`, [owner, target])).rows[0] : undefined;
      const counts = (await client.query<{ count: number; scanned: number }>(`WITH candidates AS MATERIALIZED (
        SELECT principal_id FROM access.follow WHERE target = $1 AND following ORDER BY principal_id LIMIT $2
      ) SELECT count(*)::integer AS scanned, count(p.id)::integer AS count FROM candidates c
        LEFT JOIN access.principal p ON p.id = c.principal_id AND p.active`,
      [target, FOLLOWS_COST.countProbe])).rows[0]!;
      return { following: owner ? row?.following ?? false : null, revision: row?.revision ?? null,
        followers: { value: counts.count, kind: counts.scanned === FOLLOWS_COST.countProbe ? 'lower-bound' as const : 'exact' as const } };
    });
  }

  /** Candidate membership uses at most 80 indexed relationship lookups. */
  async matches(principal: VerifiedPrincipal, agent: string, candidates: string[][]) {
    if (candidates.length > 20 || candidates.some(ids => ids.length > 4)) throw new ControlInvalid('Follow match budget exceeded');
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const rows = await client.query<{ target: string; kind: FollowKind }>(`SELECT target, kind FROM access.follow
        WHERE principal_id = $1 AND following AND target = ANY($2::text[])`, [owner, candidates.flat()]);
      const followed = new Set(rows.rows.map(row => row.target));
      const inventory = (await client.query<{ revision: string; active_count: number }>(
        'SELECT revision, active_count FROM access.follow_inventory WHERE principal_id = $1', [owner])).rows[0];
      return { owner, revision: inventory?.revision ?? null, count: inventory?.active_count ?? 0, matches: candidates.map(ids => ids.some(id => followed.has(id))),
        reasons: candidates.map(ids => ids.flatMap(id => rows.rows.filter(row => row.target === id))) };
    });
  }

  async set(principal: VerifiedPrincipal, input: FollowCommand, key: string,
    disclose: () => Promise<void>): Promise<FollowResult> {
    commandKey(key);
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query(`INSERT INTO access.follow_inventory (principal_id, revision) VALUES ($1,$2)
        ON CONFLICT DO NOTHING`, [owner, randomUUID()]);
      await client.query('SELECT revision FROM access.follow_inventory WHERE principal_id = $1 FOR UPDATE', [owner]);
      const intent = digest(input);
      const receipt = (await client.query<{ request_digest: string; result: FollowResult }>(
        'SELECT request_digest, result FROM access.follow_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has a different follow intent');
        return { ...receipt.result, replayed: true };
      }
      const prior = (await client.query<FollowRow>('SELECT * FROM access.follow WHERE principal_id = $1 AND target = $2',
        [owner, input.target])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision || (prior && prior.kind !== input.kind)) {
        throw new ControlStale('Follow changed; refresh its state');
      }
      // Removing a hidden/deleted target remains possible. Replay precedes all
      // mutable target reads, so a lost response can always recover its receipt.
      if (input.following) await disclose();
      const revision = randomUUID();
      const delta = Number(input.following) - Number(prior?.following ?? false);
      const changed = await client.query(`UPDATE access.follow_inventory SET revision = $2,
        active_count = active_count + $3 WHERE principal_id = $1 AND active_count + $3 <= $4`,
      [owner, randomUUID(), delta, FOLLOWS_COST.maximumFollowing]);
      if (changed.rowCount !== 1) throw new ControlInvalid('Follow limit reached');
      await client.query(`INSERT INTO access.follow (principal_id, target, kind, acting_subject, following, revision)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id, target) DO UPDATE SET
        following = EXCLUDED.following, acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision`,
      [owner, input.target, input.kind, input.actingSubject, input.following, revision]);
      const result: FollowResult = { profile: 'follow-receipt-v1', target: input.target, kind: input.kind,
        actingSubject: input.actingSubject, following: input.following, revision, replayed: false };
      await client.query(`INSERT INTO access.follow_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }
}
