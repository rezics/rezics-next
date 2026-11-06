import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Actor, AccessClient } from '../request/access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { handleHolder } from '../access/handle-holder.ts';
import { normalizeHandle } from '../access/lifecycle.ts';
import { readOrganizationRole } from '../access/account-data.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { derivedId, newId, partitionOf, routeOf } from '../route/route.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  SpaceConflictError,
  SpaceInputError,
  readSpace,
  type Space,
  type SpaceDependencies,
  type SpaceContext,
} from './space.ts';
import readAddress from './space-address-read.sql';
import readActiveAddresses from './space-address-batch-active.sql';
import reserveAddress from './space-address-pending.sql';
import activateAddress from './space-address-activate.sql';
import redirectAddress from './space-address-reserve.sql';
import appendRevision from './space-revision.sql';
import moveSpaceHead from './space-head.sql';

const SPACE_ADDRESS_PENDING_TTL_MS = 30 * 60 * 1000;
const SPACE_ADDRESS_RESERVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_NAMESPACE = '613b8772-23c0-4b88-97fb-843e30582c7a';

export class SpaceAddressConflictError extends Error {
  constructor() {
    super('Space address is unavailable');
    this.name = 'SpaceAddressConflictError';
  }
}

type AddressRow = Readonly<{ spaceId: string; state: string }>;
type AddressStepContext = Readonly<{
  dependencies: SpaceDependencies;
  actor: Actor;
  spaceId: string;
  spaceRoute: number;
  targetRoute: number;
  context: SpaceContext;
}>;

function account(actor: Actor) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return actor;
}

function addressRoute(address: string): number {
  return createHash('sha256').update(address).digest().readUInt16BE(0);
}

function normalizeAddress(value: string): string {
  try {
    return normalizeHandle(value);
  } catch {
    throw new SpaceInputError();
  }
}

function stepOptions(input: AddressStepContext, kind: string, body: unknown) {
  const identity = principalCommandIdentity(account(input.actor));
  return {
    ...identity,
    partition: partitionOf(input.targetRoute),
    deadline: input.context.deadline,
    clock: input.dependencies.clock,
    receipt: {
      kind,
      key: input.context.idempotencyKey,
      digest: createHash('sha256')
        .update(canonicalize([identity, kind, body])!)
        .digest(),
    },
  };
}

function spaceAuthorization(input: AddressStepContext) {
  const current = new WeakMap<AuthoritativeTime, Space>();
  const authorization = resourceAuthorization({
    access: input.dependencies.access,
    actor: input.actor,
    action: 'space:manage',
    anchor: {
      resource: { route: input.spaceRoute, id: input.spaceId },
      async validate(client, time) {
        const row = await readSpace(client, input.spaceId, authoritativeTimeValue(time));
        if (!row) return false;
        current.set(time, row);
        return true;
      },
    },
    context: {
      pool: input.dependencies.pool,
      deadline: input.context.deadline,
      partition: partitionOf(input.targetRoute),
    },
  });
  return { authorization, current };
}

function affected(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
}

async function verifyHandleHolder(dependencies: SpaceDependencies, actor: Actor, address: string): Promise<void> {
  const claimant = account(actor).accountId;
  const holder = await withConnection(dependencies.pool, (client) => handleHolder(client, address));
  if (!holder || holder.accountId === claimant) return;
  const holderRoute = routeOf(holder.accountId);
  const at = dependencies.clock();
  if (!Number.isFinite(at.getTime())) throw new SpaceInputError();
  const role =
    holderRoute === null
      ? null
      : await readOrganizationRole(dependencies.pool, holderRoute, holder.accountId, claimant, at);
  if (role !== 'owner') throw new GrantDeniedError();
}

/** Point-resolve an active address. Permission for the Space remains the caller's responsibility. */
export async function readSpaceAddress(client: AccessClient, address: string): Promise<AddressRow | null> {
  const normalized = normalizeAddress(address);
  const row = await readAddress.run(client, { route: addressRoute(normalized), address: normalized });
  if (!row) return null;
  return { spaceId: row.spaceId, state: row.state };
}

/** Batch-check active address anchors before the final Space home read. */
export async function readActiveSpaceAddressClaims(
  client: AccessClient,
  targets: readonly Readonly<{ spaceId: string; address: string }>[],
): Promise<ReadonlySet<string>> {
  if (!targets.length) return new Set();
  const normalized = targets.map(({ spaceId, address }) => ({ spaceId, address: normalizeAddress(address) }));
  const rows = await readActiveAddresses.run(client, {
    routes: normalized.map(({ address }) => addressRoute(address)),
    addresses: normalized.map(({ address }) => address),
    space_ids: normalized.map(({ spaceId }) => spaceId),
  });
  const valid = new Set<string>();
  for (const row of rows)
    if (row.requested_space_id === row.claimed_space_id)
      valid.add(JSON.stringify([row.requested_space_id, row.address]));
  return valid;
}

/** Change the active address through separately receipted address and Space partitions. */
export async function claimSpaceAddress(
  dependencies: SpaceDependencies,
  actor: Actor,
  input: Readonly<{ spaceId: string; expectedHead: string; address: string }>,
  context: SpaceContext,
) {
  const author = account(actor).accountId;
  const address = normalizeAddress(input.address);
  const spaceRoute = routeOf(input.spaceId);
  if (spaceRoute === null || routeOf(input.expectedHead) !== spaceRoute) throw new SpaceInputError();
  const targetRoute = addressRoute(address);
  const reservationId = derivedId(ID_NAMESPACE, `${author}\n${input.spaceId}\n${context.idempotencyKey}`, targetRoute);
  const pendingContext: AddressStepContext = {
    dependencies,
    actor,
    spaceId: input.spaceId,
    spaceRoute,
    targetRoute,
    context,
  };

  await verifyHandleHolder(dependencies, actor, address);

  const pendingBody = {
    spaceId: input.spaceId,
    expectedHead: input.expectedHead,
    address,
    reservationId,
  };
  const pendingAuth = spaceAuthorization(pendingContext);
  const pending = await runCommand(
    dependencies.pool,
    {
      ...stepOptions(pendingContext, 'community.space.address.pending', pendingBody),
      authorization: pendingAuth.authorization,
    },
    async (tx, command) => {
      const previous = pendingAuth.current.get(command.time);
      if (!previous) throw new SpaceConflictError();
      if (previous.headRevisionId !== input.expectedHead) throw new SpaceConflictError();
      const at = authoritativeTimeValue(command.time);
      const result = await reserveAddress.run(tx, {
        route: targetRoute,
        address,
        space_id: input.spaceId,
        reservation_id: reservationId,
        expires_at: new Date(Date.parse(at) + SPACE_ADDRESS_PENDING_TTL_MS).toISOString(),
        at,
        transaction_id: command.transactionId,
      });
      if (!affected(result)) throw new SpaceAddressConflictError();
      const alreadyActive = result[0]?.state === 'active';
      return {
        value: { spaceId: input.spaceId, alreadyActive },
        events: [
          {
            type: alreadyActive
              ? 'com.rezics.community.space.address-claim-accepted.v1'
              : 'com.rezics.community.space.address-claim-pending.v1',
            subject: input.spaceId,
            data: { spaceId: input.spaceId, address },
          },
        ],
      };
    },
  );

  const spaceContext: AddressStepContext = {
    ...pendingContext,
    targetRoute: spaceRoute,
  };
  const spaceBody = { ...pendingBody };
  const spaceAuth = spaceAuthorization(spaceContext);
  const changed = await runCommand(
    dependencies.pool,
    {
      ...stepOptions(spaceContext, 'community.space.address', spaceBody),
      authorization: spaceAuth.authorization,
    },
    async (tx, command) => {
      const previous = spaceAuth.current.get(command.time);
      if (!previous) throw new SpaceConflictError();
      if (previous.headRevisionId !== input.expectedHead) throw new SpaceConflictError();
      if (previous.address === address) {
        return {
          value: { spaceId: input.spaceId, revisionId: previous.headRevisionId, previousAddress: previous.address },
          events: [
            {
              type: 'com.rezics.community.space.address-claim-accepted.v1',
              subject: input.spaceId,
              data: { spaceId: input.spaceId, revisionId: previous.headRevisionId, address },
            },
          ],
        };
      }
      const revisionId = newId(spaceRoute);
      await appendRevision.run(tx, {
        route: spaceRoute,
        id: input.spaceId,
        revision: revisionId,
        predecessor: input.expectedHead,
        address,
        title: previous.title,
        summary: previous.summary,
        at: authoritativeTimeValue(command.time),
        author,
      });
      const moved = await moveSpaceHead.run(tx, {
        route: spaceRoute,
        id: input.spaceId,
        revision: revisionId,
        expected: input.expectedHead,
      });
      if (!affected(moved)) throw new SpaceConflictError();
      return {
        value: { spaceId: input.spaceId, revisionId, previousAddress: previous.address },
        events: [
          {
            type: 'com.rezics.community.space.address-changed.v1',
            subject: input.spaceId,
            data: { spaceId: input.spaceId, revisionId, address },
          },
        ],
      };
    },
  );

  if (!pending.value.alreadyActive) {
    const activateContext = { ...pendingContext };
    const activateBody = { ...pendingBody, revisionId: changed.value.revisionId };
    const activateAuth = spaceAuthorization(activateContext);
    await runCommand(
      dependencies.pool,
      {
        ...stepOptions(activateContext, 'community.space.address.activate', activateBody),
        authorization: activateAuth.authorization,
      },
      async (tx, command) => {
        const current = activateAuth.current.get(command.time);
        if (!current || current.address !== address) throw new SpaceConflictError();
        const result = await activateAddress.run(tx, {
          route: targetRoute,
          address,
          space_id: input.spaceId,
          reservation_id: reservationId,
          at: authoritativeTimeValue(command.time),
          transaction_id: command.transactionId,
        });
        if (!affected(result)) throw new SpaceAddressConflictError();
        return {
          value: { spaceId: input.spaceId, address },
          events: [
            {
              type: 'com.rezics.community.space.address-activated.v1',
              subject: input.spaceId,
              data: { spaceId: input.spaceId, address },
            },
          ],
        };
      },
    );
  }

  const oldAddress = changed.value.previousAddress;
  if (oldAddress && oldAddress !== address) {
    const oldRoute = addressRoute(oldAddress);
    const reserveOldContext: AddressStepContext = { ...pendingContext, targetRoute: oldRoute };
    const reserveOldBody = { spaceId: input.spaceId, oldAddress, address, revisionId: changed.value.revisionId };
    const reserveOldAuth = spaceAuthorization(reserveOldContext);
    await runCommand(
      dependencies.pool,
      {
        ...stepOptions(reserveOldContext, 'community.space.address.reserve-old', reserveOldBody),
        authorization: reserveOldAuth.authorization,
      },
      async (tx, command) => {
        const current = reserveOldAuth.current.get(command.time);
        if (!current) throw new SpaceConflictError();
        if (current.address === oldAddress) {
          return {
            value: { spaceId: input.spaceId, oldAddress },
            events: [
              {
                type: 'com.rezics.community.space.address-reservation-skipped.v1',
                subject: input.spaceId,
                data: { spaceId: input.spaceId, address: oldAddress },
              },
            ],
          };
        }
        const result = await redirectAddress.run(tx, {
          route: oldRoute,
          address: oldAddress,
          space_id: input.spaceId,
          reserved_until: new Date(
            Date.parse(authoritativeTimeValue(command.time)) + SPACE_ADDRESS_RESERVED_TTL_MS,
          ).toISOString(),
          transaction_id: command.transactionId,
        });
        if (!affected(result)) throw new SpaceAddressConflictError();
        return {
          value: { spaceId: input.spaceId, oldAddress },
          events: [
            {
              type: 'com.rezics.community.space.address-reserved.v1',
              subject: input.spaceId,
              data: { spaceId: input.spaceId, address: oldAddress },
            },
          ],
        };
      },
    );
  }

  return changed;
}
