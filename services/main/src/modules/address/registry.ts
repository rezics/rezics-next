import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import { identityKeyUuid } from '@rezics/model/address/sid';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { ALIAS_POLICIES, type ScopePolicy } from './policy.ts';

export const NATIVE_ADDRESS_HOLDER =
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type AliasScope = 'agent' | 'space' | 'work' | `zone:${string}`;
export type AliasState = 'current' | 'redirect' | 'retired';
export interface AliasRow {
  scope: AliasScope;
  key: string;
  skeleton: string;
  holder: string;
  controller: string;
  state: AliasState;
  revision: string;
  successor: string | null;
  claimed_at: Date;
  changed_at: Date;
}
export type AliasWrite = {
  scope: AliasScope;
  holder: string;
  actingSubject: string;
  operation: 'claim' | 'rename' | 'release' | 'merge';
  alias?: string;
  expectedRevision: string | null;
  successor?: string;
  idempotencyKey: string;
};
export interface AliasReceipt {
  profile: 'alias-write-v1';
  scope: AliasScope;
  holder: string;
  key: string;
  state: AliasState;
  revision: string;
  previousKey: string | null;
  changedAt: string;
  successor?: string;
  replayed: boolean;
}
export class AliasInvalid extends Error {}
export class AliasDenied extends Error {}
export class AliasConflict extends Error {}
export class AliasUnavailable extends Error {}
export class AliasCooldown extends AliasConflict {
  constructor(readonly availableAt: string) {
    super(`Alias can change after ${availableAt}`);
  }
}
export const ALIAS_COST = {
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
  throw new AliasInvalid('Invalid alias scope');
}

/** The registry is Access-owned. Its transaction and authority locks are the
 * same transaction: revocation cannot acknowledge before an admitted alias write. */
export class AliasRegistry {
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
      if (!fence.rowCount) throw new AliasUnavailable('Access recovery hold');
      const result = await this.reading.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error)
        throw new AliasUnavailable('Alias owner is unavailable');
      throw error;
    } finally {
      client.release();
    }
  }

  policy(scope: string): ScopePolicy {
    return ALIAS_POLICIES[scopeKind(scope)];
  }
  async isReserved(
    scope: AliasScope,
    key: string,
    client: Pick<PoolClient, 'query'> = this.reading.getStore() ?? this.pool,
  ) {
    return !!(
      await client.query(
        `SELECT 1 FROM access.alias_reserved_word WHERE word = $1
      AND CASE WHEN $2 IN ('agent','space') THEN handles ELSE titles END`,
        [key, scopeKind(scope)],
      )
    ).rowCount;
  }
  /** Platform authority is proved by Main, never taken from AliasWrite. It
   * permits official Space handles without relaxing any ownership gate. */
  async assertAliasAllowed(
    scope: AliasScope,
    key: string,
    client: Pick<PoolClient, 'query'>,
    platformAuthority = false,
  ) {
    if (!(platformAuthority && scope === 'space') && (await this.isReserved(scope, key, client)))
      throw new AliasInvalid('Alias is reserved');
  }
  async lookup(scope: AliasScope, key: string): Promise<AliasRow | null> {
    scopeKind(scope);
    return (
      (
        await (this.reading.getStore() ?? this.pool).query<AliasRow>(
          'SELECT * FROM access.alias_registry WHERE scope = $1 AND key = $2',
          [scope, key],
        )
      ).rows[0] ?? null
    );
  }

  async identify(scope: AliasScope, key: string) {
    scopeKind(scope);
    if (!key || key.length > 512) throw new AliasInvalid('Address key exceeds its bound');
    const uuid = identityKeyUuid(key);
    if (uuid) return { holder: `https://rezics.com/id/${uuid}`, alias: null };
    let normalized;
    try {
      normalized = normalizeAddressAlias(key, (await this.policy(scope)).characters);
    } catch {
      return { holder: null, alias: null };
    }
    const alias = await this.lookup(scope, normalized.key);
    return { holder: alias?.holder ?? null, alias };
  }

  async currents(holders: readonly string[]): Promise<Map<string, AliasRow>> {
    if (!holders.length) return new Map();
    if (
      holders.length > ALIAS_COST.batch ||
      holders.some((holder) => !NATIVE_ADDRESS_HOLDER.test(holder))
    )
      throw new AliasInvalid('Invalid address batch');
    const result = await this.pool.query<AliasRow>(
      `SELECT * FROM access.alias_registry
      WHERE holder = ANY($1::text[]) AND state = 'current' AND scope IN ('agent','space','work')`,
      [holders],
    );
    return new Map(result.rows.map((row) => [`${row.scope}\0${row.holder}`, row]));
  }

  async availability(scope: AliasScope, raw: string) {
    const policy = await this.policy(scope);
    let alias;
    try {
      alias = normalizeAddressAlias(raw, policy.characters);
    } catch {
      return { available: false, reason: 'invalid' as const };
    }
    if (await this.isReserved(scope, alias.key))
      return { available: false, reason: 'reserved' as const };
    const row = await this.lookup(scope, alias.key);
    if (row)
      return {
        available: false,
        reason: row.state === 'current' ? ('claimed' as const) : ('retained' as const),
      };
    const confusable = await (this.reading.getStore() ?? this.pool).query(
      `SELECT 1 FROM access.alias_registry WHERE skeleton = $1
      AND (scope = $2 OR $2 IN ('agent','space') AND scope IN ('agent','space')) LIMIT 1`,
      [alias.skeleton, scope],
    );
    return {
      available: !confusable.rowCount,
      reason: confusable.rowCount ? ('confusable' as const) : ('available' as const),
    };
  }

  /** The same reservation, retained-key and skeleton gates as availability,
   * evaluated over one bounded candidate batch in its caller's read snapshot. */
  async firstAvailable(scope: AliasScope, candidates: readonly string[]): Promise<string | null> {
    if (candidates.length > ALIAS_COST.batch)
      throw new AliasInvalid('Alias candidate batch exceeds its bound');
    const policy = this.policy(scope);
    const aliases = candidates.flatMap((raw, ordinal) => {
      try {
        return [{ ...normalizeAddressAlias(raw, policy.characters), ordinal }];
      } catch {
        return [];
      }
    });
    if (!aliases.length) return null;
    const row = (
      await (this.reading.getStore() ?? this.pool).query<{ key: string }>(
        `
      SELECT wanted.key FROM jsonb_to_recordset($1::jsonb)
        AS wanted(key text, skeleton text, ordinal int)
      WHERE NOT EXISTS (SELECT 1 FROM access.alias_reserved_word WHERE word = wanted.key
        AND CASE WHEN $2 IN ('agent','space') THEN handles ELSE titles END)
        AND NOT EXISTS (SELECT 1 FROM access.alias_registry WHERE scope = $2 AND key = wanted.key)
        AND NOT EXISTS (SELECT 1 FROM access.alias_registry WHERE skeleton = wanted.skeleton
          AND (scope = $2 OR $2 IN ('agent','space') AND scope IN ('agent','space')))
      ORDER BY wanted.ordinal LIMIT 1`,
        [JSON.stringify(aliases), scope],
      )
    ).rows[0];
    return row?.key ?? null;
  }

  async heads(scopes: readonly AliasScope[], holders: readonly string[]) {
    if (holders.length > ALIAS_COST.batch || scopes.length !== holders.length)
      throw new AliasInvalid('Invalid alias head batch');
    const rows = await (this.reading.getStore() ?? this.pool).query<AliasRow>(
      `SELECT head.*
      FROM unnest($1::text[],$2::text[]) AS wanted(scope,holder) CROSS JOIN LATERAL (
        SELECT * FROM access.alias_registry n WHERE n.scope = wanted.scope AND n.holder = wanted.holder
        ORDER BY (state = 'current') DESC,changed_at DESC,revision DESC LIMIT 1) head`,
      [scopes, holders],
    );
    return new Map(rows.rows.map((row) => [`${row.scope}\0${row.holder}`, row]));
  }

  async write(
    client: PoolClient,
    principal: VerifiedPrincipal,
    input: AliasWrite,
    controller: string,
    creationAdmission: string | null = null,
    platformAuthority = false,
  ): Promise<AliasReceipt> {
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
      throw new AliasInvalid('Invalid alias write');
    const policy = this.policy(input.scope);
    let alias;
    try {
      alias =
        input.alias === undefined ? null : normalizeAddressAlias(input.alias, policy.characters);
    } catch (error) {
      throw new AliasInvalid(error instanceof Error ? error.message : 'Invalid alias');
    }
    if (alias) await this.assertAliasAllowed(input.scope, alias.key, client, platformAuthority);
    if (
      ['claim', 'rename'].includes(input.operation) !== !!alias ||
      (input.operation === 'merge') !== !!input.successor ||
      (input.operation === 'claim') !== (input.expectedRevision === null)
    )
      throw new AliasInvalid('Invalid alias transition');
    const digest = createHash('sha256')
      .update(JSON.stringify({ ...input, alias: alias?.key, idempotencyKey: undefined }))
      .digest('hex');
    const identity = (
      await client.query<{ id: string }>(
        `SELECT id FROM access.principal WHERE
      account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
        [principal.issuer, principal.subject],
      )
    ).rows[0];
    if (!identity) throw new AliasDenied('Principal is unavailable');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('alias-receipt:' || $1 || ':' || $2,0))",
      [identity.id, input.idempotencyKey],
    );
    const prior = (
      await client.query<{ request_digest: string; result: AliasReceipt }>(
        `SELECT request_digest,result
      FROM access.alias_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
        [identity.id, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_digest !== digest)
        throw new AliasConflict('Idempotency key binds another intent');
      return { ...prior.result, replayed: true };
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('alias-holder:' || $1 || ':' || $2,0))",
      [input.scope, input.holder],
    );
    const current = (
      await client.query<AliasRow>(
        `SELECT * FROM access.alias_registry
      WHERE scope = $1 AND holder = $2 AND state = 'current' FOR UPDATE`,
        [input.scope, input.holder],
      )
    ).rows[0];
    if ((current?.revision ?? null) !== input.expectedRevision)
      throw new AliasConflict('Alias head changed');
    if (
      current &&
      policy.cooldown_days &&
      Date.now() < current.changed_at.getTime() + policy.cooldown_days * 86400_000
    ) {
      throw new AliasCooldown(
        new Date(current.changed_at.getTime() + policy.cooldown_days * 86400_000).toISOString(),
      );
    }
    if (alias?.key === current?.key) throw new AliasConflict('Alias is already current');
    if (alias) {
      const crossHandle = input.scope === 'agent' || input.scope === 'space';
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `alias-skeleton:${crossHandle ? 'handle' : input.scope}:${alias.skeleton}`,
      ]);
      const occupied = await client.query(
        // Two indexed ranges skip a holder's retained aliases rather than
        // filtering an ever-growing alias inventory with holder <> $3.
        `SELECT 1 FROM (
          (SELECT 1 FROM access.alias_registry WHERE scope = $2 AND skeleton = $1 AND holder < $3
            AND NOT (scope = 'space' AND controller = $4 AND state = 'retired' AND EXISTS (
              SELECT 1 FROM access.admission a WHERE a.id = creation_admission AND a.state = 'sealed'
              AND a.graph_outcome = 'cancelled')) LIMIT 1)
          UNION ALL
          (SELECT 1 FROM access.alias_registry WHERE scope = $2 AND skeleton = $1 AND holder > $3
            AND NOT (scope = 'space' AND controller = $4 AND state = 'retired' AND EXISTS (
              SELECT 1 FROM access.admission a WHERE a.id = creation_admission AND a.state = 'sealed'
              AND a.graph_outcome = 'cancelled')) LIMIT 1)
          UNION ALL
          (SELECT 1 FROM access.alias_registry WHERE $5 AND scope IN ('agent','space')
            AND skeleton = $1 AND controller < $4 LIMIT 1)
          UNION ALL
          (SELECT 1 FROM access.alias_registry WHERE $5 AND scope IN ('agent','space')
            AND skeleton = $1 AND controller > $4 LIMIT 1)
        ) collisions LIMIT 1`,
        [alias.skeleton, input.scope, input.holder, controller, crossHandle],
      );
      if (occupied.rowCount) throw new AliasConflict('Alias is occupied or confusable');
    }
    let written: AliasRow;
    if (current) {
      written = (
        await client.query<AliasRow>(
          `UPDATE access.alias_registry SET state = $3, successor = $4,
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
    } else if (!alias) throw new AliasConflict('Holder has no current alias');
    if (alias) {
      const row = await client.query<AliasRow>(
        `INSERT INTO access.alias_registry(scope,key,skeleton,holder,controller,state,creation_admission)
        VALUES ($1,$2,$3,$4,$5,'current',$6) ON CONFLICT(scope,key) DO UPDATE SET state = 'current',
        holder = EXCLUDED.holder,creation_admission = EXCLUDED.creation_admission,
        controller = EXCLUDED.controller,successor = NULL,
        revision = gen_random_uuid(),changed_at = clock_timestamp()
        WHERE access.alias_registry.holder = EXCLUDED.holder OR
          (access.alias_registry.scope = 'space' AND access.alias_registry.controller = EXCLUDED.controller
            AND access.alias_registry.state = 'retired' AND EXISTS (
              SELECT 1 FROM access.admission a WHERE a.id = access.alias_registry.creation_admission
              AND a.state = 'sealed' AND a.graph_outcome = 'cancelled')) RETURNING *`,
        [input.scope, alias.key, alias.skeleton, input.holder, controller, creationAdmission],
      );
      if (!row.rowCount) throw new AliasConflict('Alias is permanently retained');
      written = row.rows[0]!;
      await this.recordHistory(client, written);
    }
    const result: AliasReceipt = {
      profile: 'alias-write-v1',
      scope: input.scope,
      holder: input.holder,
      key: written!.key,
      state: written!.state,
      revision: written!.revision,
      previousKey: current?.key ?? null,
      changedAt: written!.changed_at.toISOString(),
      ...(input.successor ? { successor: input.successor } : {}),
      replayed: false,
    };
    await client.query(
      'INSERT INTO access.alias_receipt(principal_id,idempotency_key,request_digest,result) VALUES ($1,$2,$3,$4)',
      [identity.id, input.idempotencyKey, digest, result],
    );
    return result;
  }

  async recordHistory(client: PoolClient, row: AliasRow) {
    await client.query(
      `INSERT INTO access.alias_history(revision,scope,key,holder,state,successor)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.revision, row.scope, row.key, row.holder, row.state, row.successor],
    );
  }

  /** A cancelled creation has never established a holder. Its controller may
   * reclaim the key after the sealed cancellation; other controllers may not. */
  async retireFailedCreation(holder: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = (
        await client.query<AliasRow>(
          `UPDATE access.alias_registry SET state = 'retired',
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

  async exact(scope: AliasScope, key: string, revision: string) {
    return (
      (
        await this.pool.query(
          `SELECT revision,scope,key,holder,state,successor
      FROM access.alias_history WHERE revision = $1 AND scope = $2 AND key = $3`,
          [revision, scope, key],
        )
      ).rows[0] ?? null
    );
  }
}
