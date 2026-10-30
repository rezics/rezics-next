import type { Pool, PoolClient } from 'pg';
import type { CompositionDocument } from '@rezics/composition';
import { createHash } from 'node:crypto';
import { readAccount } from '../access/account-data.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, AuthenticationError, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ZoneConfigurationResponse, ZoneMetadataResponse, ZoneOwned, ZonePublic } from './contract.ts';
import { zoneReadable, zoneReadEligibility, zoneWithheld } from './eligibility.ts';
import { hasZoneOwnerRole, ownerZoneKeys, readZoneHead, type ZoneHead, zoneOwnerIsActive } from './resource-store.ts';

export function requireZoneAccount(actor: Actor): asserts actor is AccountActor {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
}
export function zoneIdentity(id: string) {
  const route = routeOf(id);
  if (route === null) throw new ProblemError('not_found');
  return { route, id };
}
/** Only the explicitly closed shell crosses the metadata boundary. */
export function zonePublic(row: ZoneHead): ZonePublic {
  const configuration = row.configuration;
  if (!configuration) throw new ProblemError('not_found');
  const labels: ZonePublic['labels'] = { ...configuration.labels };
  for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
    if (zoneWithheld(row, `/labels/${key}`)) delete labels[key];
  }
  const homeIndex = configuration.pages.findIndex((page) => page.route === '');
  const home = configuration.pages[homeIndex];
  const appearance: ZonePublic['appearance'] = {
    ...(!zoneWithheld(row, `/pages/${homeIndex}/document`)
      ? ((home?.document.root.props.appearance as ZonePublic['appearance'] | undefined) ?? {})
      : {}),
  };
  for (const key of Object.keys(appearance) as (keyof typeof appearance)[]) {
    if (zoneWithheld(row, `/pages/${homeIndex}/document/root/props/appearance/${key}`)) delete appearance[key];
  }
  return {
    id: row.id,
    revision: row.revision,
    labels,
    visibility: row.visibility,
    appearance,
    navigation: configuration.pages
      .filter(
        (_, index) => !zoneWithheld(row, `/pages/${index}/route`) && !zoneWithheld(row, `/pages/${index}/document`),
      )
      .map((page) => ({ route: page.route })),
  };
}
export function zoneOwned(row: ZoneHead): ZoneOwned {
  if (!row.ownerId) throw new ProblemError('not_found');
  return {
    ...zonePublic(row),
    ownerId: row.ownerId,
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
    restoreUntil: row.restoreUntil === null ? null : new Date(row.restoreUntil).toISOString(),
  };
}
export async function zoneReadTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  deadline?: number,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      if (deadline !== undefined) {
        requireAccessDeadline(deadline);
        await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      }
      const result = await work(client);
      if (deadline !== undefined) requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** Copy the admitted document, never the retained original. Appearance tokens are omitted;
 * covered text is empty safe text. Unexpected covered subtrees conceal the page. */
function publicDocument(row: ZoneHead, index: number): CompositionDocument {
  const document = structuredClone(row.configuration!.pages[index]!.document);
  const base = `/pages/${index}/document`;
  const appearance = `${base}/root/props/appearance`;
  function redact(value: object, pointer: string) {
    for (const [key, child] of Object.entries(value)) {
      const path = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (zoneWithheld(row, path)) {
        if (path === appearance || path.startsWith(`${appearance}/`)) Reflect.deleteProperty(value, key);
        else if (typeof child === 'string') Reflect.set(value, key, '');
        else throw new ProblemError('not_found');
      } else if (child !== null && typeof child === 'object') redact(child, path);
    }
  }
  redact(document, base);
  return document;
}

export function createZoneReads(dependencies: { pool: Pool; access: Access; tokens: KeyRing; clock: () => Date }) {
  const { pool, access, tokens, clock } = dependencies;
  function read(actor: Actor, id: string, configuration: false, deadline: number): Promise<ZoneMetadataResponse>;
  function read(actor: Actor, id: string, configuration: true, deadline: number): Promise<ZoneConfigurationResponse>;
  async function read(actor: Actor, id: string, configuration: boolean, deadline: number) {
    if (configuration) requireZoneAccount(actor);
    const identity = zoneIdentity(id);
    const resource = { ...identity, eligibility: zoneReadEligibility(identity) };
    const context = { pool, deadline };
    const readCheck = await accessCheck(access, actor, 'zone:read', resource, context);
    const configureCheck = configuration ? await accessCheck(access, actor, 'zone:configure', identity, context) : null;
    return zoneReadTransaction(pool, async (client) => {
      const time = await mintReadTime(client, clock);
      const at = authoritativeTimeValue(time);
      const row = await readZoneHead(client, identity.route, id);
      if (!row || !row.configuration || !row.mounts || row.state === 'purged') throw new ProblemError('not_found');
      if (!(await zoneOwnerIsActive(client, row))) throw new ProblemError('not_found');
      const allowed = await readCheck(client, time);
      if (!configuration) {
        if (!zoneReadable(row)) throw new ProblemError('not_found');
        if (!allowed) {
          if (actor.kind === 'account') {
            const account = await readAccount(client, routeOf(actor.accountId)!, actor.accountId);
            if (!account || account.state !== 'active' || account.fenced) throw new ProblemError('forbidden');
          }
          throw new ProblemError('not_found');
        }
        return { zone: zonePublic(row) };
      }
      requireZoneAccount(actor);
      const owner = await hasZoneOwnerRole(client, identity.route, id, actor.accountId, at);
      const editable = await configureCheck!(client, time);
      if (row.state === 'deleted') {
        if (!owner || !allowed) throw new ProblemError('forbidden');
        if (!row.restoreUntil || Date.parse(at) >= Date.parse(row.restoreUntil)) throw new ProblemError('not_found');
      } else if (!editable && !(owner && allowed)) throw new ProblemError('forbidden');
      return { zone: zoneOwned(row), configuration: row.configuration, mounts: row.mounts };
    });
  }
  async function list(actor: Actor, query: { limit?: number; cursor?: string; deleted?: boolean }, deadline: number) {
    requireZoneAccount(actor);
    const route = routeOf(actor.accountId)!;
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
    const binding: ListCursorBinding = {
      route: 'GET /v1/zones',
      viewer: actor.accountId,
      query: { limit, deleted: query.deleted ?? false, route },
    };
    const cursor = query.cursor ? await decodeListCursor(tokens, binding, query.cursor, clock()) : null;
    if (
      cursor &&
      (!cursor.ok ||
        cursor.after.length !== 3 ||
        typeof cursor.after[0] !== 'string' ||
        routeOf(cursor.after[0]) !== route ||
        typeof cursor.after[1] !== 'string' ||
        typeof cursor.after[2] !== 'string')
    )
      throw new ProblemError('invalid_cursor');
    if (cursor && !cursor.ok) throw new ProblemError('invalid_cursor');
    const state = query.deleted ? 'deleted' : 'active';
    const after = cursor?.ok ? (cursor.after[0] as string) : '00000000-0000-0000-0000-000000000000';
    // Raw key bound precedes all eligibility, role and payload checks. An empty eligible page still advances.
    const keys = await ownerZoneKeys(pool, { route, owner_id: actor.accountId, state, after, limit: limit + 1 });
    const considered = keys.slice(0, limit);
    const checks = await Promise.all(
      considered.map(({ id }) =>
        accessCheck(
          access,
          actor,
          'zone:read',
          { route, id, eligibility: zoneReadEligibility({ route, id }) },
          { pool, deadline },
        ),
      ),
    );
    return zoneReadTransaction(pool, async (client) => {
      const time = await mintReadTime(client, clock);
      const at = authoritativeTimeValue(time);
      const account = await readAccount(client, route, actor.accountId);
      if (
        !account ||
        account.kind !== 'actor' ||
        account.state !== 'active' ||
        account.fenced ||
        account.minimumAuthnEpoch > BigInt(actor.authnEpoch)
      )
        throw new ProblemError('forbidden');
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) throw new ProblemError('partition_unavailable');
      const security = createHash('sha256')
        .update(
          JSON.stringify([
            account.transactionId,
            account.minimumAuthnEpoch.toString(),
            actor.authnEpoch,
            actor.clientId,
            actor.requestedBy,
            [...actor.scopes].sort(),
          ]),
        )
        .digest('hex');
      if (
        cursor?.ok &&
        (cursor.epoch !== partition.epoch ||
          cursor.after[1] !== partition.position.toString() ||
          cursor.after[2] !== security)
      )
        throw new ProblemError('stale_cursor');
      const zones: ZoneOwned[] = [];
      for (const [index, key] of considered.entries()) {
        const row = await readZoneHead(client, route, key.id);
        if (
          !row ||
          row.ownerId !== actor.accountId ||
          row.state !== state ||
          !row.configuration ||
          zoneWithheld(row, '')
        )
          continue;
        if (query.deleted && (!row.restoreUntil || Date.parse(at) >= Date.parse(row.restoreUntil))) continue;
        if (
          !(await checks[index]!(client, time)) ||
          !(await hasZoneOwnerRole(client, route, key.id, actor.accountId, at))
        )
          continue;
        zones.push(zoneOwned(row));
      }
      const last = considered.at(-1);
      return {
        zones,
        next:
          keys.length > limit && last
            ? await encodeListCursor(
                tokens,
                binding,
                { epoch: partition.epoch, after: [last.id, partition.position.toString(), security] },
                clock(),
              )
            : null,
      };
    });
  }
  async function page(actor: Actor, id: string, route: string | null, deadline: number) {
    const identity = zoneIdentity(id);
    const check = await accessCheck(
      access,
      actor,
      'zone:read',
      { ...identity, eligibility: zoneReadEligibility(identity) },
      { pool, deadline },
    );
    return zoneReadTransaction(
      pool,
      async (client) => {
        const time = await mintReadTime(client, clock);
        const row = await readZoneHead(client, identity.route, id);
        if (!row || !zoneReadable(row) || !row.configuration) throw new ProblemError('not_found');
        if (!(await zoneOwnerIsActive(client, row))) throw new ProblemError('not_found');
        if (!(await check(client, time))) {
          if (actor.kind === 'account') {
            const account = await readAccount(client, routeOf(actor.accountId)!, actor.accountId);
            if (!account || account.state !== 'active' || account.fenced) throw new ProblemError('forbidden');
          }
          throw new ProblemError('not_found');
        }
        // Direct targets prove Zone authority here; runtime admits source execution separately.
        const index = row.configuration.pages.findIndex((page) => page.route === route);
        if (
          route !== null &&
          (index < 0 || zoneWithheld(row, `/pages/${index}/route`) || zoneWithheld(row, `/pages/${index}/document`))
        )
          throw new ProblemError('not_found');
        const document = route === null ? null : publicDocument(row, index);
        const zone = zonePublic(row);
        zone.appearance = {
          ...zone.appearance,
          ...(document?.root.props.appearance as ZonePublic['appearance'] | undefined),
        };
        const partition = await readPartition(client, partitionOf(identity.route));
        if (!partition) throw new ProblemError('partition_unavailable');
        return {
          zone,
          document,
          component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
        };
      },
      deadline,
    );
  }
  return {
    metadata: (actor: Actor, id: string, deadline: number) => read(actor, id, false, deadline),
    configuration: (actor: Actor, id: string, deadline: number) => read(actor, id, true, deadline),
    list,
    page,
  };
}
