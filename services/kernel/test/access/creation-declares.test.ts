import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { standingFixture } from './standing-fixture.ts';
import {
  creationDeclares,
  createResourceCreationManifest,
  parentCreationAuthorization,
} from '../../src/access/index.ts';
import type { ResourceCreationEntry } from '../../src/access/creation-manifest.ts';
import { initializeResourceGrants } from '../../src/access/resource-initialization.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  currentCommand,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../../src/command/command.ts';
import type { Resource } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
let statements = 0;
let observe: ((sql: string) => void) | undefined;
beforeAll(async () => {
  f = await standingFixture(['reaction:set']);
  const observed = new WeakSet<PoolClient>();
  f.pool.on('acquire', (client) => {
    if (observed.has(client)) return;
    observed.add(client);
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<typeof query>) => {
      statements++;
      const raw = args[0] as string | { text: string };
      observe?.(typeof raw === 'string' ? raw : raw.text);
      return query(...args);
    }) as typeof client.query;
  });
}, 30000);
beforeEach(async () => {
  await f.reset();
  await f.grant(f.actor, 'subject:create');
});
afterAll(() => f?.close());

function entries(): ResourceCreationEntry[] {
  return ['content.thread', 'content.post'].map((type, index) => {
    const route = f.otherResource.route + index;
    return {
      resource: { route, id: newId(route) },
      type,
      creator: f.actor,
      creation: {
        async validate(tx, resource) {
          // Provenance validation runs while the entry is initializing.
          expect(creationDeclares(tx, resource)).toBe(true);
          return (
            (
              await tx.query(
                `SELECT 1 FROM public.standing_resource
                 WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()`,
                [resource.route, resource.id],
              )
            ).rowCount === 1
          );
        },
      },
    };
  });
}

async function initialize(tx: CommandTransaction, declared: ResourceCreationEntry[]) {
  for (const entry of declared) {
    await tx.query('INSERT INTO public.standing_resource(route,id) VALUES ($1,$2)', [
      entry.resource.route,
      entry.resource.id,
    ]);
    await initializeResourceGrants(tx, entry);
  }
}

async function execute(
  declared: ResourceCreationEntry[],
  body: (tx: CommandTransaction) => Promise<void>,
  wrap?: (authorization: CommandAuthorization) => CommandAuthorization,
) {
  const context = await f.context();
  const authorization = parentCreationAuthorization({
    access: f.access,
    actor: context.actor,
    action: 'subject:create',
    parent: await f.parent(),
    context: { ...context, resource: declared[0]!.resource, manifest: createResourceCreationManifest(declared) },
  });
  return runCommand(
    f.pool,
    {
      partition: partitionOf(declared[0]!.resource.route),
      deadline: context.deadline,
      basis: {
        actorAccountId: f.actor,
        clientId: context.actor.clientId,
        requestedBy: context.actor.requestedBy,
      },
      authorization: wrap?.(authorization) ?? authorization,
      receipt: {
        actorAccountId: f.actor,
        kind: 'fixture.manifest',
        key: Bun.randomUUIDv7(),
        digest: Buffer.alloc(32),
      },
    },
    async (tx) => {
      await body(tx);
      return { value: {}, events: [{ type: 'com.rezics.fixture.manifest.v1', data: {} }] };
    },
  );
}

test('a resource declared by the live parent creation is reported', async () => {
  const declared = entries();
  await execute(declared, async (tx) => {
    for (const entry of declared) expect(creationDeclares(tx, { ...entry.resource })).toBe(true);
    await initialize(tx, declared);
    for (const entry of declared) expect(creationDeclares(tx, entry.resource)).toBe(true);
  });
});

test('an undeclared resource or the parent itself is not reported', async () => {
  const declared = entries();
  await execute(declared, async (tx) => {
    expect(creationDeclares(tx, f.resource)).toBe(false);
    expect(creationDeclares(tx, { route: f.otherResource.route, id: newId(f.otherResource.route) })).toBe(false);
    await initialize(tx, declared);
  });
});

test('a resource with the declared id on another route is not reported', async () => {
  const declared = entries();
  await execute(declared, async (tx) => {
    expect(creationDeclares(tx, { ...declared[0]!.resource, route: declared[1]!.resource.route })).toBe(false);
    await initialize(tx, declared);
  });
});

test('it is false outside a command after the attempt and in another transaction', async () => {
  const declared = entries();
  let retained!: CommandTransaction;
  expect(creationDeclares({ query: f.pool.query.bind(f.pool) }, declared[0]!.resource)).toBe(false);
  await execute(declared, async (tx) => {
    retained = tx;
    expect(creationDeclares({ query: tx.query }, declared[0]!.resource)).toBe(false);
    await initialize(tx, declared);
  });
  expect(creationDeclares(retained, declared[0]!.resource)).toBe(false);
  const next = entries();
  await execute(next, async (tx) => {
    expect(creationDeclares(tx, declared[0]!.resource)).toBe(false);
    expect(creationDeclares(retained, declared[0]!.resource)).toBe(false);
    await initialize(tx, next);
  });
});

test('it is false after the creation failed and in receipt-only mode', async () => {
  const declared = entries();
  let retained!: CommandTransaction;
  await expect(
    execute(declared, async (tx) => {
      retained = tx;
      await expect(initializeResourceGrants(tx, { ...declared[0]!, creator: f.principal })).rejects.toBeInstanceOf(
        GrantDeniedError,
      );
      expect(creationDeclares(tx, declared[0]!.resource)).toBe(false);
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(creationDeclares(retained, declared[0]!.resource)).toBe(false);

  let checked = false;
  observe = (sql) => {
    if (!sql.includes('FROM core.receipt')) return;
    expect(currentCommand(retained).authorization?.mode).toBe('receipt-only');
    expect(creationDeclares(retained, declared[0]!.resource)).toBe(false);
    checked = true;
  };
  try {
    await expect(
      execute(
        declared,
        async () => {
          throw new Error('Receipt-only authorization must not run the body');
        },
        (base) => ({
          ...base,
          async authorize(tx, attempt, proof) {
            await base.authorize(tx, attempt, proof);
            retained = tx;
            return 'receipt-only';
          },
        }),
      ),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    expect(checked).toBe(true);
  } finally {
    observe = undefined;
  }
});

test('a false answer neither throws nor poisons the creation', async () => {
  const declared = entries();
  const result = await execute(declared, async (tx) => {
    expect(creationDeclares(tx, f.otherResource)).toBe(false);
    for (const resource of [null, undefined, {}, { route: 'invalid', id: declared[0]!.resource.id }])
      expect(creationDeclares(tx, resource as Resource)).toBe(false);
    expect(creationDeclares(null as unknown as CommandTransaction, declared[0]!.resource)).toBe(false);
    await initialize(tx, declared);
  });
  expect(result.replayed).toBe(false);
  expect(
    (
      await f.reader.query('SELECT 1 FROM access.resource_initialization WHERE resource_id=ANY($1::uuid[])', [
        declared.map((entry) => entry.resource.id),
      ])
    ).rowCount,
  ).toBe(2);
});

test('it issues no query', async () => {
  const declared = entries();
  await execute(declared, async (tx) => {
    const before = statements;
    expect(creationDeclares(tx, declared[0]!.resource)).toBe(true);
    expect(creationDeclares(tx, f.resource)).toBe(false);
    expect(statements).toBe(before);
    await initialize(tx, declared);
  });
});
