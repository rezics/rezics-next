import { withReadTransaction } from './read.ts';
import type { Pool } from 'pg';
import { createResourcePublicEligibility, initializeResourceGrants, type ParentAnchor } from '../access/index.ts';
import { readAccount } from '../access/account-data.ts';
import { authoritativeTimeValue, runCommand, type CommandAuthorization } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { itemFacts } from './item.ts';
import insertContext from './create-context.sql';
import contextPublicExists from './context-public-exists.sql';
import contextPublicEvidence from './context-public-evidence.sql';
import readContextStatement from './read-context.sql';
import readGlobalContext from './context-read-global.sql';
import readCommunityContext from './context-read-community.sql';
import readContextCreator from './context-read-creator.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';

export const CREATE_CONTEXT = 'context.create';

export const globalContextAnchor: ParentAnchor = Object.freeze({
  resource: Object.freeze({ route: 0, id: GLOBAL_CONTEXT }),
  async validate(client, time) {
    authoritativeTimeValue(time);
    const found = await readGlobalContext.run(client, { route: 0, context_id: GLOBAL_CONTEXT });
    return found !== null;
  },
});

/** A server-bound editorial Context anchor. The caller chooses a Context id;
 * this binding fixes its route and verifies the community row on the released
 * authorization connection before Access evaluates the grant at command T.
 */
export function editorialContextAnchor(id: string): ParentAnchor {
  if (id === GLOBAL_CONTEXT) return globalContextAnchor;
  const route = routeOf(id);
  if (route === null) throw new RangeError('Context anchor id must carry a route');
  return Object.freeze({
    resource: Object.freeze({ route, id }),
    async validate(client, time) {
      authoritativeTimeValue(time);
      const found = await readCommunityContext.run(client, { route, context_id: id });
      if (found === null) throw new ContextNotFoundError();
      return true;
    },
  });
}

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

export type ContextRecord = {
  id: string;
  kind: 'community' | 'global';
  labels: Record<string, string>;
  settings: { id: string; release: string } | null;
  defaults: Record<string, 'inherit' | 'suppress'>;
};

export async function createContext(
  pool: Pool,
  options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    input: unknown;
    settings?: ContextRecord['settings'];
    defaults?: ContextRecord['defaults'];
    authorize?: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
  },
) {
  const { route, id } = options.target;
  if (routeOf(id) !== route) throw new RangeError('Context target id must carry its route');
  const settings = options.settings ?? null;
  const defaults = options.defaults ?? {};
  // itemFacts is the shared validator for subject labels, including language and length limits.
  const labels = contextLabels(id, options.input);
  const command = await runCommand(
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
      authorization: options.authorization ?? {
        action: 'context:create',
        resource: options.target,
        denied: () => new ContextAccessDeniedError(),
        async authorize(tx, attempt) {
          if (!options.authorize || !(await options.authorize(tx, attempt.time))) throw new ContextAccessDeniedError();
          return 'execute';
        },
      },
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      await insertContext.run(tx, {
        route,
        context_id: id,
        labels,
        settings_id: settings?.id ?? null,
        settings_release: settings?.release ?? null,
        defaults,
        transaction_id: transactionId,
      });
      if (options.authorization)
        await initializeResourceGrants(tx, {
          resource: options.target,
          type: 'semantic.context',
          creator: options.actor.accountId,
        });
      return {
        value: { id, kind: 'community' as const, labels, settings, defaults },
        events: [{ type: 'com.rezics.semantic.context.created.v1', data: { id } }],
      };
    },
  );
  return {
    context: command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

type ContextRow = {
  id: string;
  kind: ContextRecord['kind'];
  labels: Record<string, string>;
  settings_id: string | null;
  settings_release: string | null;
  defaults: Record<string, 'inherit' | 'suppress'>;
  recorded_transaction_id: string | null;
};

export async function readContext(
  pool: Pool,
  id: string,
  authorize: (client: Parameters<AccessCheck>[0]) => Promise<boolean>,
): Promise<{ context: ContextRecord; component: { partition: number; epoch: number; position: bigint } } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const partitionNo = partitionOf(route);
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionNo);
    if (!partition) {
      return null;
    }
    const row = (await readContextStatement.run(client, { route, context_id: id })) as ContextRow | undefined;
    if (!row || !(await authorize(client))) {
      return null;
    }
    if (row.kind === 'community') {
      const creator = await readContextCreator.run(client, { route, context_id: id });
      if (!creator?.accountId) return null;
      const account = await readAccount(client, routeOf(creator.accountId)!, creator.accountId);
      if (!account || account.state !== 'active' || account.fenced) return null;
    }
    return {
      context: {
        id: row.id,
        kind: row.kind,
        labels: row.labels,
        settings: row.settings_id === null ? null : { id: row.settings_id, release: row.settings_release! },
        defaults: row.defaults,
      },
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
}

export async function contextSnapshot(pool: Pool, id: string): Promise<ContextRecord | null> {
  return (await readContext(pool, id, async () => true))?.context ?? null;
}

export function contextLabels(id: string, input: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  const labelInput =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? { labels: (input as Record<string, unknown>).labels }
      : input;
  for (const fact of itemFacts(id, labelInput)) {
    if (fact.kind === 'label' && fact.language !== null) labels[fact.language] = fact.body as string;
  }
  return labels;
}

export function publicContextEligibility(resource: Resource) {
  return createResourcePublicEligibility({
    resource,
    action: 'context:read',
    async prepare({ pool, resource: identity }) {
      const row = await contextPublicEvidence.run(pool, { route: identity.route, context_id: identity.id });
      return row ?? null;
    },
    async verify({ client, resource: identity }) {
      const row = await contextPublicExists.run(client, { route: identity.route, context_id: identity.id });
      return row !== null;
    },
  });
}
