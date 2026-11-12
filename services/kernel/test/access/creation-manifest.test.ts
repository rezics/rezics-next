import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { standingFixture, type StandingFixtureLifecycle } from './standing-fixture.ts';
import {
  createResourceCreationManifest,
  type ResourceCreationEntry,
  type ResourceCreationManifest,
} from '../../src/access/creation-manifest.ts';
import { parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { initializeResourceGrants } from '../../src/access/resource-initialization.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  runCommand,
  type CommandTransaction,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
let fixtureLifecycle: StandingFixtureLifecycle | undefined;
let parentChecks = 0;
let parentFormulas = 0;
let validations = 0;
let bodies = 0;
const provenance = new WeakMap<CommandTransaction, string>();
beforeAll(async () => {
  // reaction:set is a mounted standing action; without it the thread and post templates drop.
  f = await standingFixture(['reaction:set'], undefined, (lifecycle) => {
    fixtureLifecycle = lifecycle;
  });
  const authorize = f.access.authorize.bind(f.access);
  f.access.authorize = async (...args) => {
    parentFormulas++;
    return authorize(...args);
  };
  await fixtureLifecycle!.run('create manifest resource table', () =>
    f.reader.query(`CREATE TABLE public.manifest_resource (
    route integer NOT NULL, id uuid NOT NULL, command_id uuid NOT NULL, created_at timestamptz NOT NULL,
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(route,id));
    CREATE FUNCTION public.freeze_manifest_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'immutable creation provenance'; END $$;
    CREATE TRIGGER immutable_provenance BEFORE UPDATE ON public.manifest_resource
    FOR EACH ROW EXECUTE FUNCTION public.freeze_manifest_provenance()`),
  );
  fixtureLifecycle!.ready();
}, 30000);
beforeEach(async () => {
  await f.reset();
  await f.grant(f.actor, 'subject:create');
  parentChecks = parentFormulas = validations = bodies = 0;
});
afterAll(async () => {
  const pendingOperation = fixtureLifecycle?.pendingOperation;
  await fixtureLifecycle?.close();
  if (pendingOperation && pendingOperation !== 'ready')
    throw new Error(`Standing fixture startup did not complete; pending operation: ${pendingOperation}`);
});
function entries(count = 2): ResourceCreationEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    resource: { route: f.otherResource.route + (i % 2), id: newId(f.otherResource.route + (i % 2)) },
    type: i === 0 ? 'content.thread' : 'content.post',
    creator: f.actor,
    creation: {
      async validate(tx, resource, time) {
        validations++;
        expect(time).toBe(currentCommand(tx).time);
        return (
          (
            await tx.query(
              `SELECT 1 FROM public.manifest_resource
          WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()
          AND command_id=$3 AND created_at=$4::timestamptz`,
              [resource.route, resource.id, provenance.get(tx), authoritativeTimeValue(time)],
            )
          ).rowCount === 1
        );
      },
    },
  }));
}
async function execute(
  declared = entries(),
  options: {
    key?: string;
    manifest?: ResourceCreationManifest;
    omit?: boolean;
    caught?: boolean;
    wrong?: 'type' | 'creator' | 'resource';
    duplicate?: boolean;
    old?: boolean;
    upsert?: boolean;
    failGrant?: boolean;
    retry?: boolean;
    partition?: number;
    wrap?: (authorization: CommandAuthorization) => CommandAuthorization;
    clientId?: string;
    legacy?: boolean;
    hold?: (tx: CommandTransaction) => void;
  } = {},
) {
  const context = await f.context();
  const parent = await f.parent();
  const authorization = parentCreationAuthorization({
    access: f.access,
    actor: context.actor,
    action: 'subject:create',
    parent: {
      resource: parent.resource,
      async validate(client) {
        parentChecks++;
        return parent.validate(client);
      },
    },
    context: {
      ...context,
      resource: declared[0]!.resource,
      creation: declared[0]!.creation,
      ...(options.legacy ? {} : { manifest: options.manifest ?? createResourceCreationManifest(declared) }),
    },
  });
  return runCommand(
    f.pool,
    {
      partition: options.partition ?? partitionOf(declared[0]!.resource.route),
      deadline: context.deadline,
      basis: {
        actorAccountId: f.actor,
        clientId: options.clientId ?? context.actor.clientId,
        requestedBy: context.actor.requestedBy,
      },
      authorization: options.wrap?.(authorization) ?? authorization,
      receipt: {
        actorAccountId: f.actor,
        kind: 'fixture.manifest',
        key: options.key ?? Bun.randomUUIDv7(),
        digest: Buffer.alloc(32),
      },
    },
    async (tx, command) => {
      bodies++;
      options.hold?.(tx);
      provenance.set(tx, command.transactionId);
      for (const entry of declared) {
        if (!options.old)
          await tx.query(
            `INSERT INTO public.manifest_resource(route,id,command_id,created_at)
        VALUES ($1,$2,$3,$4) ${options.upsert ? 'ON CONFLICT(route,id) DO NOTHING' : ''}`,
            [entry.resource.route, entry.resource.id, command.transactionId, authoritativeTimeValue(command.time)],
          );
      }
      if (options.failGrant)
        await tx.query(`CREATE FUNCTION pg_temp.fail_manifest_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'grant failure'; END $$;
      CREATE TRIGGER fail_manifest BEFORE INSERT ON access.resource_role_grant
      FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_manifest_grant()`);
      for (const [i, entry] of declared.entries()) {
        if (options.omit && i === declared.length - 1) continue;
        const input = { resource: entry.resource, type: entry.type, creator: entry.creator };
        if (i === 0 && options.wrong === 'type') input.type = 'content.post';
        if (i === 0 && options.wrong === 'creator') input.creator = f.principal;
        if (i === 0 && options.wrong === 'resource') input.resource = f.resource;
        try {
          await initializeResourceGrants(tx, input);
          if (options.duplicate) await initializeResourceGrants(tx, input);
        } catch (error) {
          if (!options.caught) throw error;
        }
      }
      if (options.retry && bodies === 1) throw Object.assign(new Error('retry'), { code: '40001' });
      return {
        value: { at: authoritativeTimeValue(command.time) },
        events: [{ type: 'com.rezics.fixture.manifest.v1', data: {} }],
      };
    },
  );
}
async function snapshot(declared: ResourceCreationEntry[]) {
  const ids = declared.map((e) => e.resource.id);
  return {
    resources: (
      await f.reader.query('SELECT * FROM public.manifest_resource WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])
    ).rows,
    grants: (
      await f.reader.query(
        'SELECT * FROM access.resource_role_grant WHERE resource_id=ANY($1::uuid[]) ORDER BY resource_id,grant_role',
        [ids],
      )
    ).rows,
    markers: (
      await f.reader.query(
        'SELECT * FROM access.resource_initialization WHERE resource_id=ANY($1::uuid[]) ORDER BY resource_id',
        [ids],
      )
    ).rows,
    effects: await f.snapshot(declared[0]!.resource.route),
  };
}
test('one parent check creates thread and firstpost with independent roles at T; replay checks authority without initialization', async () => {
  const declared = entries();
  const key = Bun.randomUUIDv7();
  const result = await execute(declared, { key });
  const before = await snapshot(declared);
  expect(parentChecks).toBe(1);
  expect(parentFormulas).toBe(1);
  expect(validations).toBe(2);
  expect(before.markers).toHaveLength(2);
  for (const entry of declared) {
    const grants = before.grants.filter((g) => g.resource_id === entry.resource.id);
    expect(grants.map((g) => g.grant_role).sort()).toEqual([`${entry.type}.owner`, `${entry.type}.standing`]);
    expect(grants.find((g) => g.subject_kind === 'identity')!.subject_id).toBe(f.actor);
  }
  expect(before.markers.every((m) => m.initialized_at.getTime() === Date.parse(result.value.at))).toBe(true);
  expect((await execute(declared, { key })).replayed).toBe(true);
  expect(parentChecks).toBe(2);
  expect(parentFormulas).toBe(2);
  expect(validations).toBe(2);
  expect(bodies).toBe(1);
  expect(await snapshot(declared)).toEqual(before);
  await f.reader.query('DELETE FROM access.resource_grant WHERE resource_id=$1 AND action=$2', [
    f.resource.id,
    'subject:create',
  ]);
  await expect(execute(declared, { key })).rejects.toBeInstanceOf(GrantDeniedError);
});
test('omission, wrong tuple, duplicate and caught initialization failures roll back resources, grants, receipt and events', async () => {
  for (const options of [
    { omit: true },
    { wrong: 'type' },
    { wrong: 'creator' },
    { wrong: 'resource' },
    { duplicate: true },
    { duplicate: true, caught: true },
    { wrong: 'type', caught: true },
    { failGrant: true },
    { failGrant: true, caught: true },
  ] as const) {
    const declared = entries();
    const before = await snapshot(declared);
    await expect(execute(declared, options)).rejects.toThrow();
    expect(await snapshot(declared)).toEqual(before);
  }
});
test('old resource and upsert cannot manufacture immutable new INSERT provenance', async () => {
  for (const upsert of [false, true]) {
    const declared = entries();
    for (const entry of declared)
      await f.reader.query(
        `INSERT INTO public.manifest_resource(route,id,command_id,created_at)
      VALUES ($1,$2,$3,now())`,
        [entry.resource.route, entry.resource.id, Bun.randomUUIDv7()],
      );
    const before = await snapshot(declared);
    await expect(execute(declared, { old: !upsert, upsert })).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await snapshot(declared)).toEqual(before);
  }
});
test('cap sixteen and fresh retry initialize each tuple once; ownerless templates stay ownerless', async () => {
  const declared = entries(16);
  const result = await execute(declared, { retry: true });
  expect(result.replayed).toBe(false);
  expect(parentChecks).toBe(2);
  expect(parentFormulas).toBe(2);
  expect(validations).toBe(32);
  expect((await snapshot(declared)).markers).toHaveLength(16);
  const communal = entries(1).map((e) => ({ ...e, type: 'semantic.communal' }));
  await execute(communal);
  expect((await snapshot(communal)).grants).toEqual([]);
});
test('forged, duplicate, oversized, cross partition and wrong command partition declarations deny', async () => {
  const declared = entries();
  for (const manifest of [
    {},
    { ...createResourceCreationManifest(declared) },
    Object.create(createResourceCreationManifest(declared)),
  ])
    await expect(execute(declared, { manifest: manifest as ResourceCreationManifest })).rejects.toThrow();
  expect(() => createResourceCreationManifest(entries(17))).toThrow();
  expect(() => createResourceCreationManifest([declared[0]!, declared[0]!])).toThrow();
  const other = entries(1)[0]!;
  expect(() => createResourceCreationManifest([declared[0]!, { ...other, resource: f.resource }])).toThrow();
  await expect(execute(declared, { partition: partitionOf(f.resource.route) })).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
});

test('forged/reused proofs, changed attempt/basis and mismatched finalization deny and roll back', async () => {
  const cases: NonNullable<Parameters<typeof execute>[1]>[] = [
    { clientId: 'other-client' },
    { wrap: (base) => ({ ...base, authorize: (tx, attempt) => base.authorize(tx, attempt, {}) }) },
    { wrap: (base) => ({ ...base, finalize: (tx, attempt) => base.finalize!(tx, attempt, {}) }) },
    { wrap: (base) => ({ ...base, finalize: (tx, attempt, proof) => base.finalize!(tx, { ...attempt }, proof) }) },
  ];
  for (const options of cases) {
    const declared = entries();
    const before = await snapshot(declared);
    await expect(execute(declared, options)).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await snapshot(declared)).toEqual(before);
  }
  let previous: unknown;
  const wrap = (base: CommandAuthorization): CommandAuthorization => ({
    ...base,
    async prepare(attempt) {
      const fresh = await base.prepare!(attempt);
      if (previous) return previous;
      previous = fresh;
      return fresh;
    },
  });
  const first = entries();
  await execute(first, { wrap });
  const second = entries();
  const before = await snapshot(second);
  await expect(execute(second, { wrap })).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await snapshot(second)).toEqual(before);
  previous = undefined;
  bodies = 0;
  await expect(execute(second, { wrap, retry: true })).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await snapshot(second)).toEqual(before);
});

test('retained or structurally copied transactions cannot initialize another resource', async () => {
  const declared = entries();
  let retained!: CommandTransaction;
  await execute(declared, {
    hold: (tx) => {
      retained = tx;
    },
  });
  await expect(initializeResourceGrants(retained, declared[0]!)).rejects.toThrow();
  const second = entries();
  const before = await snapshot(second);
  await expect(
    execute(second, {
      hold: (tx) => {
        // The owning connection alone is insufficient: command context binds the exact transaction token.
        retained = { query: tx.query };
      },
      wrap: (base) => ({
        ...base,
        async finalize(tx, attempt, proof) {
          await initializeResourceGrants(retained, second[0]!);
          await base.finalize!(tx, attempt, proof);
        },
      }),
    }),
  ).rejects.toThrow();
  expect(await snapshot(second)).toEqual(before);
});

test('an initialization still awaiting provenance cannot satisfy manifest finalization', async () => {
  const declared = entries(1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const port = declared[0]!.creation;
  declared[0] = {
    ...declared[0]!,
    creation: {
      async validate(...args) {
        await held;
        return port.validate(...args);
      },
    },
  };
  let pending!: Promise<void>;
  const before = await snapshot(declared);
  await expect(
    execute(declared, {
      omit: true,
      hold: (tx) => {
        // The asynchronous call reserves the tuple before yielding to its owning port.
        pending = initializeResourceGrants(tx, declared[0]!);
        void pending.catch(() => {});
      },
    }),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  release();
  await expect(pending).rejects.toThrow();
  expect(await snapshot(declared)).toEqual(before);
});

test('legacy single-resource commands keep strict initialization and allow ownerless creation without initialization', async () => {
  const declared = entries(1).map((entry) => ({ ...entry, type: 'semantic.communal' }));
  await execute(declared, { legacy: true, omit: true });
  const result = await snapshot(declared);
  expect(result.resources).toHaveLength(1);
  expect(result.grants).toEqual([]);
  expect(result.markers).toEqual([]);
  const next = entries(1);
  const before = await snapshot(next);
  await expect(execute(next, { legacy: true, wrong: 'creator', caught: true })).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await snapshot(next)).toEqual(before);
});
