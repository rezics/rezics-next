import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  controlRead,
  controlTransaction,
  ControlConflict,
  ControlDenied,
  ControlInvalid,
  ControlStale,
} from '../access/topology-control.ts';
import { digest } from '../recommendation/derived-generation.ts';
import {
  defaultFollowLevel,
  FOLLOWS_COST,
  followTargetMatches,
  type BatchFollowCommand,
  type BatchFollowResult,
  type FollowCommand,
  type FollowKind,
  type FollowLevel,
  type FollowResult,
  type FollowSource,
} from './contract.ts';
import { followPrincipal } from './authority.ts';
import { registerFollowSpace, type SpaceIdentity } from './targets.ts';

export interface FollowRow {
  target: string;
  kind: FollowKind;
  following: boolean;
  revision: string;
  level: FollowLevel;
  source: FollowSource;
  pin_position: number | null;
  changed_at: Date;
  order_key?: string;
}
export function commandKey(key: string) {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key))
    throw new ControlInvalid('A valid Idempotency-Key is required');
}
export const followMetadata = (row: Pick<FollowRow, 'level' | 'source' | 'pin_position'>) => ({
  level: row.level,
  source: row.source,
  pinPosition: row.pin_position,
});
export type FollowDescription = { target: string; kind: string; nameKey?: string; space?: SpaceIdentity };
type Describe = (target: string, kind?: string) => Promise<FollowDescription | void>;
/** Old immutable receipts remain replayable after adding relationship metadata.
 * Defaults describe their original explicit intent, not today's mutable row. */
export function replayFollowReceipt<T extends { profile: string; replayed: boolean }>(
  result: T,
): T {
  const metadata = <Item extends { kind: string }>(
    item: Item & Partial<Pick<FollowResult, 'level' | 'source' | 'pinPosition'>>,
  ) => ({
    ...item,
    level: item.level ?? defaultFollowLevel(item.kind),
    source: item.source ?? ('explicit' as const),
    pinPosition: item.pinPosition ?? null,
  });
  if (result.profile === 'follow-receipt-v1')
    return { ...metadata(result as unknown as FollowResult), replayed: true } as unknown as T;
  if (result.profile === 'follow-batch-receipt-v1')
    return {
      ...result,
      items: (result as unknown as BatchFollowResult).items.map(metadata),
      replayed: true,
    } as T;
  return { ...result, replayed: true };
}
export async function automaticFollow(
  client: PoolClient,
  owner: string,
  agent: string,
  target: string,
  kind: string,
  source: 'join' | 'library',
  following: boolean,
  nameKey?: string | null,
) {
  return (await client.query<{ automatic_follow: boolean }>('SELECT access.automatic_follow($1,$2,$3,$4,$5,$6,$7)', [
    owner,
    agent,
    target,
    kind,
    source,
    following,
    nameKey ?? null,
  ])).rows[0]!.automatic_follow;
}

export class FollowsStore {
  constructor(readonly pool: Pool) {}
  private async descriptions(principal: VerifiedPrincipal, agent: string, input: unknown, key: string,
    profile: string, targets: BatchFollowCommand['targets'], describe: Describe) {
    commandKey(key);
    const preflight = await controlRead(this.pool, async client => {
      const owner = await followPrincipal(client,principal,agent);
      const receipt = (await client.query<{ request_digest: string; result: FollowResult | BatchFollowResult }>(
        'SELECT request_digest,result FROM access.follow_receipt WHERE principal_id=$1 AND idempotency_key=$2', [owner,key])).rows[0];
      if (receipt && (receipt.request_digest !== digest(input) || receipt.result.profile !== profile))
        throw new ControlConflict('Idempotency key has another follow intent');
      return { receipt, rows: (await client.query<FollowRow & { requested_target: string }>(`WITH targets AS (
        SELECT id,COALESCE(alias.space,id) AS target FROM unnest($2::text[]) id
          LEFT JOIN access.follow_space_alias alias ON alias.alias=id)
        SELECT f.*,t.id AS requested_target FROM targets t JOIN access.follow f ON
          (f.target=t.target OR f.target IN (SELECT alias FROM access.follow_space_alias WHERE space=t.target))
          WHERE f.principal_id=$1`,
        [owner,targets.map(item => item.target)])).rows };
    });
    if (preflight.receipt) return { receipt: replayFollowReceipt(preflight.receipt.result), describe };
    const descriptions = new Map<string,FollowDescription | void>();
    // Graph disclosure never holds an Access transaction or scope gate.
    for (const item of targets) {
      if (item.kind && !followTargetMatches(item.target,item.kind))
        throw new ControlInvalid('Follow target does not name its kind');
      if (item.following !== false && (!preflight.rows.some(row => row.requested_target===item.target && row.following)
        || item.expectedRevision === null)) descriptions.set(item.target,await describe(item.target,item.kind));
    }
    return { receipt: null, describe: async (target: string) => descriptions.get(target) };
  }
  private async allowPerson(client: PoolClient, target: string, kind: string) {
    if (kind !== 'agent') return;
    await client.query('SELECT id FROM access.authority_subject WHERE id=$1 FOR SHARE', [target]);
    const policy = (
      await client.query<{ follow_policy: string }>(
        'SELECT follow_policy FROM access.person_preferences WHERE agent_id=$1',
        [target],
      )
    ).rows[0];
    if (policy?.follow_policy === 'nobody')
      throw new ControlDenied('This person does not accept new followers');
  }
  /** Receipt and inventory lock serialize absence, budget and all twenty CAS
   * tokens. Lost responses replay before touching a mutable target. */
  private command<T extends { profile: string; replayed: boolean }>(
    principal: VerifiedPrincipal,
    agent: string,
    input: unknown,
    key: string,
    profile: string,
    apply: (client: PoolClient, owner: string) => Promise<T>,
  ): Promise<T> {
    commandKey(key);
    return controlTransaction(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, agent);
      await client.query(
        'INSERT INTO access.follow_inventory(principal_id,revision) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [owner, randomUUID()],
      );
      await client.query(
        'SELECT revision FROM access.follow_inventory WHERE principal_id=$1 FOR UPDATE',
        [owner],
      );
      const intent = digest(input);
      const receipt = (
        await client.query<{ request_digest: string; result: T }>(
          'SELECT request_digest,result FROM access.follow_receipt WHERE principal_id=$1 AND idempotency_key=$2',
          [owner, key],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent || receipt.result.profile !== profile)
          throw new ControlConflict('Idempotency key has another follow intent');
        return replayFollowReceipt(receipt.result);
      }
      const result = await apply(client, owner);
      await client.query(
        'INSERT INTO access.follow_receipt(principal_id,idempotency_key,request_digest,result) VALUES($1,$2,$3,$4)',
        [owner, key, intent, result],
      );
      return result;
    });
  }
  private async put(
    client: PoolClient,
    owner: string,
    agent: string,
    input: BatchFollowCommand['targets'][number],
    describe: Describe,
  ): Promise<FollowRow> {
    if (input.kind && !followTargetMatches(input.target, input.kind))
      throw new ControlInvalid('Follow target does not name its kind');
    const alias = (
      await client.query<{ space: string }>(
        'SELECT space FROM access.follow_space_alias WHERE alias=$1',
        [input.target],
      )
    ).rows[0];
    const originalTarget = alias?.space ?? input.target;
    const old = (
      await client.query<FollowRow>(
        `SELECT f.*,EXISTS(SELECT 1 FROM access.follow active WHERE active.principal_id=$1 AND active.following
          AND (active.target=$2 OR active.target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2))) AS following
          FROM access.follow f WHERE f.principal_id=$1 AND
          (f.target=$2 OR f.target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2))
          ORDER BY (f.target=$2) DESC,f.following DESC,f.changed_at DESC LIMIT 1`,
        [owner, originalTarget],
      )
    ).rows[0];
    const following =
      input.following ??
      (input.level !== undefined || input.pinPosition !== undefined
        ? (old?.following ?? true)
        : true);
    const described =
      following && (!old?.following || input.expectedRevision === null)
        ? await describe(input.target, input.kind)
        : undefined;
    const target = described?.target ?? originalTarget;
    if (described?.space) await registerFollowSpace(client, described.space);
    const prior =
      target === originalTarget
        ? old
        : (
            await client.query<FollowRow>(
              `SELECT f.*,EXISTS(SELECT 1 FROM access.follow active WHERE active.principal_id=$1 AND active.following
          AND (active.target=$2 OR active.target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2))) AS following
          FROM access.follow f WHERE f.principal_id=$1 AND
          (f.target=$2 OR f.target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2))
          ORDER BY (f.target=$2) DESC,f.following DESC,f.changed_at DESC LIMIT 1`,
              [owner, target],
            )
          ).rows[0];
    const kind = described?.kind ?? (alias ? 'space' : prior?.kind) ?? input.kind;
    if (!kind) throw new ControlInvalid('Follow target kind is unavailable');
    if (
      input.kind &&
      input.kind !== kind &&
      !(kind === 'space' && ['realm', 'zone'].includes(input.kind))
    )
      throw new ControlInvalid('Follow kind does not match target');
    if (!following && !prior) throw new ControlInvalid('No follow exists to remove');
    if (
      input.expectedRevision !== undefined &&
      (prior?.revision ?? null) !== input.expectedRevision
    )
      throw new ControlStale('Follow changed; refresh its state');
    if (following && !prior?.following) await this.allowPerson(client, target, kind);
    const level = input.level ?? prior?.level ?? defaultFollowLevel(kind);
    const pin = following
      ? input.pinPosition === undefined
        ? (prior?.pin_position ?? null)
        : input.pinPosition
      : null;
    if (
      !['all', 'highlights', 'off'].includes(level) ||
      (pin !== null && (!Number.isInteger(pin) || pin < 0 || pin >= FOLLOWS_COST.maximumFollowing))
    )
      throw new ControlInvalid('Invalid follow settings');
    const inventory = (
      await client.query<{ active_count: number }>(
        'SELECT active_count FROM access.follow_inventory WHERE principal_id=$1',
        [owner],
      )
    ).rows[0]!;
    if (following && !prior?.following && inventory.active_count >= FOLLOWS_COST.maximumFollowing)
      throw new ControlInvalid('Follow budget exceeded');
    const settingsOnly = prior && following === prior.following &&
      (input.level !== undefined || input.pinPosition !== undefined);
    const source = settingsOnly ? prior.source : 'explicit';
    await client.query(`DELETE FROM access.follow WHERE principal_id=$1 AND target<>$2
      AND target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2)`,[owner,target]);
    if (prior && prior.target !== target) await client.query(
      'DELETE FROM access.follow WHERE principal_id=$1 AND target=$2',[owner,prior.target]);
    if (!following) await client.query(`UPDATE access.follow SET following=false,revision=$3,pin_position=NULL
      WHERE principal_id=$1 AND following AND target IN
        (SELECT alias FROM access.follow_space_alias WHERE space=$2)`,[owner,target,randomUUID()]);
    return (
      await client.query<FollowRow>(
        `INSERT INTO access.follow
      (principal_id,target,kind,acting_subject,following,revision,level,source,pin_position,name_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(principal_id,target) DO UPDATE SET
      kind=EXCLUDED.kind,following=EXCLUDED.following,acting_subject=EXCLUDED.acting_subject,
      revision=EXCLUDED.revision,level=EXCLUDED.level,source=EXCLUDED.source,pin_position=EXCLUDED.pin_position,
      name_key=COALESCE(EXCLUDED.name_key,access.follow.name_key),changed_at=clock_timestamp() RETURNING *`,
        [owner, target, kind, agent, following, randomUUID(), level, source, pin, described?.nameKey ?? null],
      )
    ).rows[0]!;
  }
  async set(
    principal: VerifiedPrincipal,
    input: FollowCommand,
    key: string,
    describe: Describe,
  ): Promise<FollowResult> {
    const ready = await this.descriptions(principal,input.actingSubject,input,key,'follow-receipt-v1',[input],describe);
    if (ready.receipt) return ready.receipt as FollowResult;
    return this.command(
      principal,
      input.actingSubject,
      input,
      key,
      'follow-receipt-v1',
      async (client, owner) => {
        const row = await this.put(client, owner, input.actingSubject, input, ready.describe);
        return {
          profile: 'follow-receipt-v1',
          target: row.target,
          kind: row.kind,
          actingSubject: input.actingSubject,
          following: row.following,
          revision: row.revision,
          ...followMetadata(row),
          replayed: false,
        };
      },
    );
  }
  async batch(
    principal: VerifiedPrincipal,
    input: BatchFollowCommand,
    key: string,
    describe: Describe,
  ): Promise<BatchFollowResult> {
    const ready = await this.descriptions(principal,input.actingSubject,input,key,'follow-batch-receipt-v1',input.targets,describe);
    if (ready.receipt) return ready.receipt as BatchFollowResult;
    return this.command(
      principal,
      input.actingSubject,
      input,
      key,
      'follow-batch-receipt-v1',
      async (client, owner) => {
        if (
          !input.targets.length ||
          input.targets.length > 20 ||
          new Set(input.targets.map((item) => item.target)).size !== input.targets.length
        )
          throw new ControlInvalid('Batch targets must be unique and bounded');
        const items: BatchFollowResult['items'] = [];
        for (const item of input.targets) {
          if (
            (item.following === false ||
              item.level !== undefined ||
              item.pinPosition !== undefined) &&
            item.expectedRevision === undefined
          )
            throw new ControlInvalid('Management requires expectedRevision');
          const row = await this.put(client, owner, input.actingSubject, item, ready.describe);
          if (items.some((prior) => prior.target === row.target))
            throw new ControlInvalid('Canonical batch targets repeat');
          items.push({
            target: row.target,
            kind: row.kind,
            following: row.following,
            revision: row.revision,
            ...followMetadata(row),
          });
        }
        return {
          profile: 'follow-batch-receipt-v1',
          actingSubject: input.actingSubject,
          items,
          replayed: false,
        };
      },
    );
  }
  /** Identity seek for feed, Continue and author readers: P+1 rows. */
  async read(
    principal: VerifiedPrincipal,
    agent: string,
    after = '',
    kind?: FollowKind | readonly FollowKind[],
    limit = 20,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > FOLLOWS_COST.pageSize)
      throw new ControlInvalid('Invalid page size');
    const kinds = kind === undefined ? null : typeof kind === 'string' ? [kind] : [...kind];
    return controlRead(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, agent);
      const inventory = (
        await client.query<{ revision: string }>(
          'SELECT revision FROM access.follow_inventory WHERE principal_id=$1 FOR SHARE',
          [owner],
        )
      ).rows[0];
      const rows = (
        await client.query<FollowRow>(
          `SELECT * FROM access.follow WHERE principal_id=$1 AND following
        AND target>$2 AND ($4::text[] IS NULL OR kind=ANY($4)) ORDER BY target LIMIT $3`,
          [owner, after, limit + 1, kinds],
        )
      ).rows;
      return { owner, revision: inventory?.revision ?? null, rows };
    });
  }
  /** Tuple keyset over the bounded inventory. Name filtering precedes seeking and LIMIT in SQL. */
  async manage(
    principal: VerifiedPrincipal,
    agent: string,
    after: string | null,
    kind: string | undefined,
    order: 'recent' | 'pinned',
    limit: number,
    q?: string,
  ) {
    let seek: { key: string; target: string } | null = null;
    if (after) {
      try {
        seek = JSON.parse(after) as { key: string; target: string };
      } catch {
        throw new ControlInvalid('Invalid follow cursor');
      }
      if (!seek || typeof seek.key !== 'string' || typeof seek.target !== 'string')
        throw new ControlInvalid('Invalid follow cursor');
    }
    return controlRead(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, agent);
      const inventory = (
        await client.query<{ revision: string }>(
          'SELECT revision FROM access.follow_inventory WHERE principal_id=$1 FOR SHARE',
          [owner],
        )
      ).rows[0];
      const expression =
        order === 'pinned'
          ? 'COALESCE(f.pin_position,10000)'
          : '-extract(epoch FROM COALESCE(a.activity_at,f.changed_at))';
      const rows = (
        await client.query<FollowRow>(
          `SELECT f.*,(${expression})::text AS order_key FROM access.follow f
        LEFT JOIN access.follow_space_alias s ON s.alias=f.target
        LEFT JOIN access.agent_provision agent ON agent.agent_id=f.target
        LEFT JOIN access.saved_filter view ON view.principal_id=f.principal_id
          AND f.target='urn:rezics:saved-view:'||view.id::text
        LEFT JOIN LATERAL (SELECT max(activity_at) AS activity_at FROM access.follow_activity
          WHERE target=f.target OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=f.target)) a ON true
        WHERE f.principal_id=$1 AND f.following
        AND ($2::text IS NULL OR f.kind=$2 OR $2 IN ('realm','zone') AND f.kind='space')
        AND ($6::text IS NULL OR access.follow_space_notifying(f.principal_id,f.target)
          AND strpos(lower(normalize(COALESCE(view.name,f.name_key,s.name_key,agent.display_name,''),NFKC)),$6)>0)
        AND ($3::numeric IS NULL OR (${expression},f.target)>($3::numeric,$4::text))
        ORDER BY ${expression},f.target LIMIT $5`,
          [owner, kind ?? null, seek?.key ?? null, seek?.target ?? null, limit + 1, q?.normalize('NFKC').toLowerCase() || null],
        )
      ).rows;
      return { owner, revision: inventory?.revision ?? null, rows };
    });
  }
  async state(target: string, reader?: { principal: VerifiedPrincipal; agent: string }) {
    return controlRead(this.pool, async (client) => {
      target = (await client.query<{ space: string }>(
        'SELECT space FROM access.follow_space_alias WHERE alias=$1',[target])).rows[0]?.space ?? target;
      const owner = reader ? await followPrincipal(client, reader.principal, reader.agent) : null;
      const row = owner
        ? (
            await client.query<FollowRow>(
              `SELECT f.*,EXISTS(SELECT 1 FROM access.follow active WHERE active.principal_id=$1 AND active.following
                AND (active.target=$2 OR active.target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2))) AS following
                FROM access.follow f WHERE f.principal_id=$1 AND
          (f.target=$2 OR f.target IN (SELECT alias FROM access.follow_space_alias WHERE space=$2))
          ORDER BY (f.target=$2) DESC,f.following DESC,f.changed_at DESC LIMIT 1`,
              [owner, target],
            )
          ).rows[0]
        : undefined;
      const counts = (
        await client.query<{ count: number; scanned: number }>(
          `WITH candidates AS MATERIALIZED (
        SELECT DISTINCT f.principal_id FROM access.follow f WHERE following AND
          (target=$1 OR target IN (SELECT alias FROM access.follow_space_alias WHERE space=$1))
          AND NOT (source='join' AND EXISTS(SELECT 1 FROM access.follow_space_alias alias
            JOIN access.private_membership member ON member.owner_subject=alias.realm AND member.principal_id=f.principal_id
            WHERE alias.space=$1 AND member.kind='realm' AND member.state='joined'))
          ORDER BY f.principal_id LIMIT $2)
        SELECT count(*)::integer AS scanned,count(p.id)::integer AS count FROM candidates c
        LEFT JOIN access.principal p ON p.id=c.principal_id AND p.active`,
          [target, FOLLOWS_COST.countProbe],
        )
      ).rows[0]!;
      return {
        following: owner ? (row?.following ?? false) : null,
        revision: row?.revision ?? null,
        level: row?.level ?? null,
        source: row?.source ?? null,
        pinPosition: row?.pin_position ?? null,
        followers: {
          value: counts.count,
          kind:
            counts.scanned === FOLLOWS_COST.countProbe
              ? ('lower-bound' as const)
              : ('exact' as const),
        },
      };
    });
  }
  /** Alias matching adds no graph read: at most 140 identities, all private. */
  async matches(principal: VerifiedPrincipal, agent: string, candidates: string[][]) {
    if (
      candidates.length > FOLLOWS_COST.matchCards ||
      candidates.some((ids) => ids.length > FOLLOWS_COST.matchIdentities)
    )
      throw new ControlInvalid('Follow match budget exceeded');
    return controlRead(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, agent);
      const rows = (
        await client.query<{ target: string; kind: FollowKind; identity: string }>(
          `WITH identities AS (
        SELECT id,COALESCE(a.space,id) AS target FROM unnest($2::text[]) id LEFT JOIN access.follow_space_alias a ON a.alias=id)
        SELECT f.target,f.kind,i.id AS identity FROM identities i JOIN access.follow f ON (f.target=i.target OR f.target IN
          (SELECT alias FROM access.follow_space_alias WHERE space=i.target))
        WHERE f.principal_id=$1 AND f.following`,
          [owner, [...new Set(candidates.flat())]],
        )
      ).rows;
      const inventory = (
        await client.query<{ revision: string; active_count: number }>(
          'SELECT revision,active_count FROM access.follow_inventory WHERE principal_id=$1',
          [owner],
        )
      ).rows[0];
      return {
        owner,
        revision: inventory?.revision ?? null,
        count: inventory?.active_count ?? 0,
        matches: candidates.map((ids) => ids.some((id) => rows.some((row) => row.identity === id))),
        reasons: candidates.map((ids) =>
          ids.flatMap((id) =>
            rows.filter((row) => row.identity === id).map(({ target, kind }) => ({ target, kind })),
          ),
        ),
      };
    });
  }
}
