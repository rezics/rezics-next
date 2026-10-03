import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { normalizeAddressName } from '@rezics/model/address/names';
import { identityKeyUuid } from '@rezics/model/address/sid';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { NAME_POLICIES, type ScopePolicy } from './policy.ts';

export const NATIVE_ADDRESS_HOLDER =
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type NameScope = 'agent' | 'space' | 'work' | `zone:${string}`;
export type NameState = 'current' | 'redirect' | 'retired';
export interface NameRow {
  scope: NameScope;
  key: string;
  display: string;
  skeleton: string;
  holder: string;
  controller: string;
  state: NameState;
  revision: string;
  successor: string | null;
  claimed_at: Date;
  changed_at: Date;
}
export type NameWrite = {
  scope: NameScope;
  holder: string;
  actingSubject: string;
  operation: 'claim' | 'rename' | 'release' | 'merge';
  name?: string;
  expectedRevision: string | null;
  successor?: string;
  idempotencyKey: string;
};
export interface NameReceipt {
  profile: 'name-write-v1';
  scope: NameScope;
  holder: string;
  key: string;
  display: string;
  state: NameState;
  revision: string;
  previousKey: string | null;
  changedAt: string;
  successor?: string;
  replayed: boolean;
}
export class NameInvalid extends Error {}
export class NameDenied extends Error {}
export class NameConflict extends Error {}
export class NameUnavailable extends Error {}
export class NameCooldown extends NameConflict {
  constructor(readonly availableAt: string) {
    super(`Name can change after ${availableAt}`);
  }
}
export const NAME_COST = {
  batch: 64,
  historyPage: 50,
  identifySqlQueries: 2,
  canonicalSqlQueries: 1,
  availabilitySqlQueries: 3,
  writeSqlQueries: 20,
  redirectHops: 32,
  deadlineMs: 10_000,
  fusekiRequests: {
    claim: 4,
    rename: 4,
    release: 4,
    merge: 39,
    resolve: 24,
    resolvePerHop: 24,
    exact: 24,
  },
  complexity:
    'Indexed scope/key, current-holder, skeleton and receipt probes; O(B log N) batch reads, O(log N) writes. History uses keyset pagination, independent of retained alias count.',
} as const;

export function scopeKind(scope: string): 'agent' | 'space' | 'work' | 'zone' {
  if (scope === 'agent' || scope === 'space' || scope === 'work') return scope;
  if (scope.startsWith('zone:') && NATIVE_ADDRESS_HOLDER.test(scope.slice(5))) return 'zone';
  throw new NameInvalid('Invalid name scope');
}

/** The registry is Access-owned. Its transaction and authority locks are the
 * same transaction: revocation cannot acknowledge before an admitted name write. */
export class NameRegistry {
  private readonly reading = new AsyncLocalStorage<PoolClient>();
  constructor(readonly pool: Pool) {}

  async withRead<T>(operation: () => Promise<T>): Promise<T> {
    if (this.reading.getStore()) return operation();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query(
        'SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE',
      );
      if (!fence.rowCount) throw new NameUnavailable('Access recovery hold');
      const result = await this.reading.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error)
        throw new NameUnavailable('Name owner is unavailable');
      throw error;
    } finally {
      client.release();
    }
  }

  policy(scope: string): ScopePolicy {
    return NAME_POLICIES[scopeKind(scope)];
  }
  async isReserved(
    scope: NameScope,
    key: string,
    client: Pick<PoolClient, 'query'> = this.reading.getStore() ?? this.pool,
  ) {
    return !!(
      await client.query(
        `SELECT 1 FROM access.name_reserved_word WHERE word = $1
      AND CASE WHEN $2 IN ('agent','space') THEN handles ELSE titles END`,
        [key, scopeKind(scope)],
      )
    ).rowCount;
  }
  /** Platform authority is proved by Main, never taken from NameWrite. It
   * permits official Space handles without relaxing any ownership gate. */
  async assertNameAllowed(
    scope: NameScope,
    key: string,
    client: Pick<PoolClient, 'query'>,
    platformAuthority = false,
  ) {
    if (!(platformAuthority && scope === 'space') && (await this.isReserved(scope, key, client)))
      throw new NameInvalid('Name is reserved');
  }
  async lookup(scope: NameScope, key: string): Promise<NameRow | null> {
    scopeKind(scope);
    return (
      (
        await (this.reading.getStore() ?? this.pool).query<NameRow>(
          'SELECT * FROM access.name_registry WHERE scope = $1 AND key = $2',
          [scope, key],
        )
      ).rows[0] ?? null
    );
  }

  async identify(scope: NameScope, key: string) {
    scopeKind(scope);
    if (!key || key.length > 512) throw new NameInvalid('Address key exceeds its bound');
    const uuid = identityKeyUuid(key);
    if (uuid) return { holder: `https://rezics.com/id/${uuid}`, name: null };
    let normalized;
    try {
      normalized = normalizeAddressName(key, (await this.policy(scope)).characters);
    } catch {
      return { holder: null, name: null };
    }
    const name = await this.lookup(scope, normalized.key);
    return { holder: name?.holder ?? null, name };
  }

  async currents(holders: readonly string[]): Promise<Map<string, NameRow>> {
    if (!holders.length) return new Map();
    if (
      holders.length > NAME_COST.batch ||
      holders.some((holder) => !NATIVE_ADDRESS_HOLDER.test(holder))
    )
      throw new NameInvalid('Invalid address batch');
    const result = await this.pool.query<NameRow>(
      `SELECT * FROM access.name_registry
      WHERE holder = ANY($1::text[]) AND state = 'current' AND scope IN ('agent','space','work')`,
      [holders],
    );
    return new Map(result.rows.map((row) => [`${row.scope}\0${row.holder}`, row]));
  }

  async availability(scope: NameScope, raw: string) {
    const policy = await this.policy(scope);
    let name;
    try {
      name = normalizeAddressName(raw, policy.characters);
    } catch {
      return { available: false, reason: 'invalid' as const };
    }
    if (await this.isReserved(scope, name.key))
      return { available: false, reason: 'reserved' as const };
    const row = await this.lookup(scope, name.key);
    if (row)
      return {
        available: false,
        reason: row.state === 'current' ? ('claimed' as const) : ('retained' as const),
      };
    const confusable = await (this.reading.getStore() ?? this.pool).query(
      `SELECT 1 FROM access.name_registry WHERE skeleton = $1
      AND (scope = $2 OR $2 IN ('agent','space') AND scope IN ('agent','space')) LIMIT 1`,
      [name.skeleton, scope],
    );
    return {
      available: !confusable.rowCount,
      reason: confusable.rowCount ? ('confusable' as const) : ('available' as const),
    };
  }

  /** The same reservation, retained-key and skeleton gates as availability,
   * evaluated over one bounded candidate batch in its caller's read snapshot. */
  async firstAvailable(scope: NameScope, candidates: readonly string[]): Promise<string | null> {
    if (candidates.length > NAME_COST.batch)
      throw new NameInvalid('Name candidate batch exceeds its bound');
    const policy = this.policy(scope);
    const names = candidates.flatMap((raw, ordinal) => {
      try {
        return [{ ...normalizeAddressName(raw, policy.characters), ordinal }];
      } catch {
        return [];
      }
    });
    if (!names.length) return null;
    const row = (
      await (this.reading.getStore() ?? this.pool).query<{ key: string }>(
        `
      SELECT wanted.key FROM jsonb_to_recordset($1::jsonb)
        AS wanted(key text, skeleton text, ordinal int)
      WHERE NOT EXISTS (SELECT 1 FROM access.name_reserved_word WHERE word = wanted.key
        AND CASE WHEN $2 IN ('agent','space') THEN handles ELSE titles END)
        AND NOT EXISTS (SELECT 1 FROM access.name_registry WHERE scope = $2 AND key = wanted.key)
        AND NOT EXISTS (SELECT 1 FROM access.name_registry WHERE skeleton = wanted.skeleton
          AND (scope = $2 OR $2 IN ('agent','space') AND scope IN ('agent','space')))
      ORDER BY wanted.ordinal LIMIT 1`,
        [JSON.stringify(names), scope],
      )
    ).rows[0];
    return row?.key ?? null;
  }

  async heads(scopes: readonly NameScope[], holders: readonly string[]) {
    if (holders.length > NAME_COST.batch || scopes.length !== holders.length)
      throw new NameInvalid('Invalid name head batch');
    const rows = await (this.reading.getStore() ?? this.pool).query<NameRow>(
      `SELECT head.*
      FROM unnest($1::text[],$2::text[]) AS wanted(scope,holder) CROSS JOIN LATERAL (
        SELECT * FROM access.name_registry n WHERE n.scope = wanted.scope AND n.holder = wanted.holder
        ORDER BY (state = 'current') DESC,changed_at DESC,revision DESC LIMIT 1) head`,
      [scopes, holders],
    );
    return new Map(rows.rows.map((row) => [`${row.scope}\0${row.holder}`, row]));
  }

  async write(
    client: PoolClient,
    principal: VerifiedPrincipal,
    input: NameWrite,
    controller: string,
    creationAdmission: string | null = null,
    platformAuthority = false,
  ): Promise<NameReceipt> {
    if (
      !NATIVE_ADDRESS_HOLDER.test(input.holder) ||
      !NATIVE_ADDRESS_HOLDER.test(input.actingSubject) ||
      !NATIVE_ADDRESS_HOLDER.test(controller) ||
      !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey) ||
      (input.expectedRevision !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          input.expectedRevision,
        )) ||
      (input.successor !== undefined &&
        (!NATIVE_ADDRESS_HOLDER.test(input.successor) || input.successor === input.holder))
    )
      throw new NameInvalid('Invalid name write');
    const policy = this.policy(input.scope);
    let name;
    try {
      name = input.name === undefined ? null : normalizeAddressName(input.name, policy.characters);
    } catch (error) {
      throw new NameInvalid(error instanceof Error ? error.message : 'Invalid name');
    }
    if (name) await this.assertNameAllowed(input.scope, name.key, client, platformAuthority);
    if (
      ['claim', 'rename'].includes(input.operation) !== !!name ||
      (input.operation === 'merge') !== !!input.successor ||
      (input.operation === 'claim') !== (input.expectedRevision === null)
    )
      throw new NameInvalid('Invalid name transition');
    const digest = createHash('sha256')
      .update(JSON.stringify({ ...input, name: name?.key, idempotencyKey: undefined }))
      .digest('hex');
    const identity = (
      await client.query<{ id: string }>(
        `SELECT id FROM access.principal WHERE
      account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
        [principal.issuer, principal.subject],
      )
    ).rows[0];
    if (!identity) throw new NameDenied('Principal is unavailable');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('name-receipt:' || $1 || ':' || $2,0))",
      [identity.id, input.idempotencyKey],
    );
    const prior = (
      await client.query<{ request_digest: string; result: NameReceipt }>(
        `SELECT request_digest,result
      FROM access.name_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
        [identity.id, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_digest !== digest)
        throw new NameConflict('Idempotency key binds another intent');
      return { ...prior.result, replayed: true };
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('name-holder:' || $1 || ':' || $2,0))",
      [input.scope, input.holder],
    );
    const current = (
      await client.query<NameRow>(
        `SELECT * FROM access.name_registry
      WHERE scope = $1 AND holder = $2 AND state = 'current' FOR UPDATE`,
        [input.scope, input.holder],
      )
    ).rows[0];
    if ((current?.revision ?? null) !== input.expectedRevision)
      throw new NameConflict('Name head changed');
    if (
      current &&
      policy.cooldown_days &&
      Date.now() < current.changed_at.getTime() + policy.cooldown_days * 86400_000
    ) {
      throw new NameCooldown(
        new Date(current.changed_at.getTime() + policy.cooldown_days * 86400_000).toISOString(),
      );
    }
    if (name?.key === current?.key) throw new NameConflict('Name is already current');
    if (name) {
      const crossHandle = input.scope === 'agent' || input.scope === 'space';
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `name-skeleton:${crossHandle ? 'handle' : input.scope}:${name.skeleton}`,
      ]);
      const occupied = await client.query(
        // Two indexed ranges skip a holder's retained aliases rather than
        // filtering an ever-growing alias inventory with holder <> $3.
        `SELECT 1 FROM (
          (SELECT 1 FROM access.name_registry WHERE scope = $2 AND skeleton = $1 AND holder < $3
            AND NOT (scope = 'space' AND controller = $4 AND state = 'retired' AND EXISTS (
              SELECT 1 FROM access.admission a WHERE a.id = creation_admission AND a.state = 'sealed'
              AND a.graph_outcome = 'cancelled')) LIMIT 1)
          UNION ALL
          (SELECT 1 FROM access.name_registry WHERE scope = $2 AND skeleton = $1 AND holder > $3
            AND NOT (scope = 'space' AND controller = $4 AND state = 'retired' AND EXISTS (
              SELECT 1 FROM access.admission a WHERE a.id = creation_admission AND a.state = 'sealed'
              AND a.graph_outcome = 'cancelled')) LIMIT 1)
          UNION ALL
          (SELECT 1 FROM access.name_registry WHERE $5 AND scope IN ('agent','space')
            AND skeleton = $1 AND controller < $4 LIMIT 1)
          UNION ALL
          (SELECT 1 FROM access.name_registry WHERE $5 AND scope IN ('agent','space')
            AND skeleton = $1 AND controller > $4 LIMIT 1)
        ) collisions LIMIT 1`,
        [name.skeleton, input.scope, input.holder, controller, crossHandle],
      );
      if (occupied.rowCount) throw new NameConflict('Name is occupied or confusable');
    }
    let written: NameRow;
    if (current) {
      written = (
        await client.query<NameRow>(
          `UPDATE access.name_registry SET state = $3, successor = $4,
        revision = gen_random_uuid(),changed_at = clock_timestamp() WHERE scope = $1 AND key = $2 RETURNING *`,
          [
            input.scope,
            current.key,
            input.operation === 'release' ? 'retired' : 'redirect',
            input.successor ?? null,
          ],
        )
      ).rows[0]!;
      await this.recordHistory(client, written);
    } else if (!name) throw new NameConflict('Holder has no current name');
    if (name) {
      const row = await client.query<NameRow>(
        `INSERT INTO access.name_registry(scope,key,display,skeleton,holder,controller,state,creation_admission)
        VALUES ($1,$2,$3,$4,$5,$6,'current',$7) ON CONFLICT(scope,key) DO UPDATE SET state = 'current',
        holder = EXCLUDED.holder,creation_admission = EXCLUDED.creation_admission,
        display = EXCLUDED.display,controller = EXCLUDED.controller,successor = NULL,
        revision = gen_random_uuid(),changed_at = clock_timestamp()
        WHERE access.name_registry.holder = EXCLUDED.holder OR
          (access.name_registry.scope = 'space' AND access.name_registry.controller = EXCLUDED.controller
            AND access.name_registry.state = 'retired' AND EXISTS (
              SELECT 1 FROM access.admission a WHERE a.id = access.name_registry.creation_admission
              AND a.state = 'sealed' AND a.graph_outcome = 'cancelled')) RETURNING *`,
        [
          input.scope,
          name.key,
          name.display,
          name.skeleton,
          input.holder,
          controller,
          creationAdmission,
        ],
      );
      if (!row.rowCount) throw new NameConflict('Name is permanently retained');
      written = row.rows[0]!;
      await this.recordHistory(client, written);
    }
    const result: NameReceipt = {
      profile: 'name-write-v1',
      scope: input.scope,
      holder: input.holder,
      key: written!.key,
      display: written!.display,
      state: written!.state,
      revision: written!.revision,
      previousKey: current?.key ?? null,
      changedAt: written!.changed_at.toISOString(),
      ...(input.successor ? { successor: input.successor } : {}),
      replayed: false,
    };
    await client.query(
      'INSERT INTO access.name_receipt(principal_id,idempotency_key,request_digest,result) VALUES ($1,$2,$3,$4)',
      [identity.id, input.idempotencyKey, digest, result],
    );
    return result;
  }

  async recordHistory(client: PoolClient, row: NameRow) {
    await client.query(
      `INSERT INTO access.name_history(revision,scope,key,holder,display,state,successor)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.revision, row.scope, row.key, row.holder, row.display, row.state, row.successor],
    );
  }

  /** A cancelled creation has never established a holder. Its controller may
   * reclaim the key after the sealed cancellation; other controllers may not. */
  async retireFailedCreation(holder: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = (
        await client.query<NameRow>(
          `UPDATE access.name_registry SET state = 'retired',
        revision = gen_random_uuid(),changed_at = clock_timestamp()
        WHERE scope = 'space' AND holder = $1 AND state = 'current' RETURNING *`,
          [holder],
        )
      ).rows;
      for (const row of rows) await this.recordHistory(client, row);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async exact(scope: NameScope, key: string, revision: string) {
    return (
      (
        await this.pool.query(
          `SELECT revision,scope,key,holder,display,state,successor
      FROM access.name_history WHERE revision = $1 AND scope = $2 AND key = $3`,
          [revision, scope, key],
        )
      ).rows[0] ?? null
    );
  }
}
