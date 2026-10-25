import type { Pool } from 'pg';
import {
  createResourcePublicEligibility,
  initializeResourceGrants,
  parentCreationAuthorization,
} from '../access/index.ts';
import { resourceRoleCatalogue } from '../access/resource-roles.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { runCommand, type CommandOutcome } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { itemFacts, resolveItem } from './item.ts';
import insertContext from './create-context.sql';
import contextCreationExists from './context-creation-exists.sql';
import contextParentExists from './context-parent-exists.sql';
import contextPublicExists from './context-public-exists.sql';
import readContextStatement from './read-context.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';

export const CREATE_CONTEXT = 'context.create';
export const COMMUNITY_CONTEXT_TYPE = 'semantic.community';
const globalResource = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });

export function contextTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource {
  const route = anchorRoute(routeKey, `${accountId}\n${CREATE_CONTEXT}\n${idempotencyKey}`);
  return { route, id: newId(route) };
}

export class ContextAccessDeniedError extends Error {
  constructor() {
    super('Context creation is not authorized');
    this.name = 'ContextAccessDeniedError';
  }
}

export class ContextNotFoundError extends Error {
  constructor() {
    super('Context does not exist');
    this.name = 'ContextNotFoundError';
  }
}

export type ContextRecord = { id: string; kind: 'community' | 'global'; labels: Record<string, string> };

export async function createContext(
  pool: Pool,
  options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    input: unknown;
    access: Access;
    deadline?: number;
  },
) {
  const { route, id } = options.target;
  if (routeOf(id) !== route) throw new RangeError('Context target id must carry its route');
  // itemFacts is the shared validator for subject labels, including language and length limits.
  const labels = contextLabels(id, options.input);
  const resource = Object.freeze({ route, id });
  let creationTransactionId: string | null = null;
  const authorization = parentCreationAuthorization({
    access: options.access,
    actor: options.actor,
    action: 'context:create',
    parent: {
      resource: globalResource,
      async validate(client) {
        const row = await contextParentExists.run(client, { route: 0, context_id: GLOBAL_CONTEXT });
        return row !== null;
      },
    },
    context: {
      pool,
      deadline: options.deadline ?? Number.MAX_SAFE_INTEGER,
      resource,
      creation: {
        async validate(tx, child) {
          const row = await contextCreationExists.run(tx, {
            route: child.route,
            context_id: child.id,
            transaction_id: creationTransactionId!,
          });
          return row !== null;
        },
      },
    },
  });
  let command: CommandOutcome<{ id: string; kind: 'community'; labels: Record<string, string> }>;
  try {
    command = await runCommand(
      pool,
      {
        partition: partitionOf(route),
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        receipt: {
          actorAccountId: options.actor.accountId,
          kind: CREATE_CONTEXT,
          key: options.idempotencyKey,
          digest: options.digest,
        },
        basis: {
          actorAccountId: options.actor.accountId,
          clientId: options.actor.clientId,
          requestedBy: options.actor.requestedBy,
        },
        authorization,
      },
      async (tx, { transactionId }) => {
        creationTransactionId = transactionId;
        await insertContext.run(tx, { route, context_id: id, labels, transaction_id: transactionId });
        // Test and embedding Access implementations may not install the production role catalogue.
        if (resourceRoleCatalogue(options.access))
          await initializeResourceGrants(tx, {
            resource,
            type: COMMUNITY_CONTEXT_TYPE,
            creator: options.actor.accountId,
          });
        return {
          value: { id, kind: 'community' as const, labels },
          events: [{ type: 'com.rezics.semantic.context.created.v1', data: { id } }],
        };
      },
    );
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ContextAccessDeniedError();
    throw error;
  }
  return {
    context: command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

type ContextRow = { id: string; kind: ContextRecord['kind']; labels: Record<string, string> };

export async function readContext(
  pool: Pool,
  id: string,
  authorize: (client: Parameters<AccessCheck>[0]) => Promise<boolean>,
): Promise<{ context: ContextRecord; component: { partition: number; epoch: number; position: bigint } } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const partitionNo = partitionOf(route);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300ms'");
      const partition = await readPartition(client, partitionNo);
      if (!partition) {
        await client.query('COMMIT');
        return null;
      }
      const row = (await readContextStatement.run(client, { route, context_id: id })) as ContextRow | undefined;
      if (!row || !(await authorize(client))) {
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return {
        context: { id: row.id, kind: row.kind, labels: row.labels },
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        client.release(error as Error);
      }
      throw error;
    }
  });
}

export function contextLabels(id: string, input: unknown): Record<string, string> {
  return resolveItem(id, itemFacts(id, input)).labels;
}

export function publicContextEligibility(resource: Resource) {
  return createResourcePublicEligibility({
    resource,
    action: 'context:read',
    async prepare() {
      return null;
    },
    async verify({ client, resource: identity }) {
      const row = await contextPublicExists.run(client, { route: identity.route, context_id: identity.id });
      return row !== null;
    },
  });
}
