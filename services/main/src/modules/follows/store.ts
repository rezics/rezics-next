import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead, controlTransaction, ControlConflict, ControlDenied, ControlInvalid, ControlStale } from '../access/topology-control.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { FOLLOWS_COST, followTargetMatches, type BatchFollowCommand, type BatchFollowResult,
  type FollowCommand, type FollowKind, type FollowResult } from './contract.ts';
import { followPrincipal } from './authority.ts';

export interface FollowRow { target: string; kind: FollowKind; following: boolean; revision: string }
export function commandKey(key: string) {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new ControlInvalid('A valid Idempotency-Key is required');
}
function checkTarget(target: string, kind: FollowKind) {
  if (!followTargetMatches(target, kind)) throw new ControlInvalid('Follow target does not name its kind');
}
export class FollowsStore {
  constructor(private readonly pool: Pool) {}

  private async allowPersonFollow(client: import('pg').PoolClient, target: string, kind: FollowKind,
    following: boolean) {
    if (kind !== 'agent' || !following) return;
    await client.query('SELECT id FROM access.authority_subject WHERE id = $1 FOR SHARE', [target]);
    const policy = (await client.query<{ follow_policy: string }>(
      'SELECT follow_policy FROM access.person_preferences WHERE agent_id = $1', [target])).rows[0];
    if (policy?.follow_policy === 'nobody') throw new ControlDenied('This person does not accept new followers');
  }

  /** One receipt and inventory lock make an onboarding choice all or nothing.
   * Public target disclosure is repeated for new follows inside the transaction. */
  async batch(principal: VerifiedPrincipal, input: BatchFollowCommand, key: string,
    disclose: (target: string, kind: FollowKind) => Promise<void>): Promise<BatchFollowResult> {
    commandKey(key);
    for (const item of input.targets) checkTarget(item.target, item.kind);
    if (new Set(input.targets.map(item => item.target)).size !== input.targets.length) {
      throw new ControlInvalid('Batch follow targets must be unique');
    }
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await client.query(`INSERT INTO access.follow_inventory (principal_id, revision) VALUES ($1,$2)
        ON CONFLICT DO NOTHING`, [owner, randomUUID()]);
      const inventory = (await client.query<{ active_count: number }>(
        'SELECT active_count FROM access.follow_inventory WHERE principal_id = $1 FOR UPDATE', [owner])).rows[0]!;
      const intent = digest(input);
      const receipt = (await client.query<{ request_digest: string; result: BatchFollowResult }>(
        'SELECT request_digest, result FROM access.follow_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent || receipt.result.profile !== 'follow-batch-receipt-v1') {
          throw new ControlConflict('Idempotency key has another follow intent');
        }
        return { ...receipt.result, replayed: true };
      }
      const prior = (await client.query<FollowRow>(`SELECT target, kind, following, revision FROM access.follow
        WHERE principal_id = $1 AND target = ANY($2::text[])`,
      [owner, input.targets.map(item => item.target)])).rows;
      const byTarget = new Map(prior.map(row => [row.target, row]));
      const added = input.targets.filter(item => !byTarget.get(item.target)?.following).length;
      if (inventory.active_count + added > FOLLOWS_COST.maximumFollowing) {
        throw new ControlInvalid('Follow limit reached');
      }
      const items: BatchFollowResult['items'] = [];
      for (const item of input.targets) {
        const existing = byTarget.get(item.target);
        if (existing && existing.kind !== item.kind) throw new ControlStale('Follow kind changed');
        if (!existing?.following) {
          await this.allowPersonFollow(client, item.target, item.kind, true);
          await disclose(item.target, item.kind);
        }
        const revision = existing?.following ? existing.revision : randomUUID();
        if (!existing?.following) await client.query(`INSERT INTO access.follow
          (principal_id, target, kind, acting_subject, following, revision) VALUES ($1,$2,$3,$4,true,$5)
          ON CONFLICT (principal_id, target) DO UPDATE SET following = true,
            acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision`,
        [owner, item.target, item.kind, input.actingSubject, revision]);
        items.push({ target: item.target, kind: item.kind, following: true, revision });
      }
      if (added) await client.query(`UPDATE access.follow_inventory SET revision = $2,
        active_count = active_count + $3 WHERE principal_id = $1`, [owner, randomUUID(), added]);
      const result: BatchFollowResult = { profile: 'follow-batch-receipt-v1',
        actingSubject: input.actingSubject, items, replayed: false };
      await client.query(`INSERT INTO access.follow_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }

  /** One kind uses the navigation index; several (authors) filter the page
   * index's seek, which the 1,000-follow inventory bounds. */
  async read(principal: VerifiedPrincipal, agent: string, after = '', kind?: FollowKind | readonly FollowKind[],
    limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > FOLLOWS_COST.pageSize) throw new ControlInvalid('Invalid page size');
    const kinds = kind === undefined ? null : typeof kind === 'string' ? [kind] : [...kind];
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const inventory = (await client.query<{ revision: string }>(
        'SELECT revision FROM access.follow_inventory WHERE principal_id = $1 FOR SHARE', [owner])).rows[0];
      const rows = await client.query<FollowRow>(`SELECT target, kind, following, revision FROM access.follow
        WHERE principal_id = $1 AND following AND target > $2
          ${kinds?.length === 1 ? 'AND kind = $4' : kinds ? 'AND kind = ANY($4::text[])' : ''}
        ORDER BY target LIMIT $3`, kinds ? [owner, after, limit + 1, kinds.length === 1 ? kinds[0] : kinds]
        : [owner, after, limit + 1]);
      return { owner, revision: inventory?.revision ?? null, rows: rows.rows };
    });
  }

  async state(target: string, reader?: { principal: VerifiedPrincipal; agent: string }) {
    return controlRead(this.pool, async client => {
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

  /** Candidate membership uses at most 140 indexed relationship lookups. */
  async matches(principal: VerifiedPrincipal, agent: string, candidates: string[][]) {
    if (candidates.length > FOLLOWS_COST.matchCards
      || candidates.some(ids => ids.length > FOLLOWS_COST.matchIdentities)) {
      throw new ControlInvalid('Follow match budget exceeded');
    }
    return controlRead(this.pool, async client => {
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
    checkTarget(input.target, input.kind);
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
      if (input.following) {
        await this.allowPersonFollow(client, input.target, input.kind, true);
        await disclose();
      }
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
