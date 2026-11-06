import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { parentCreationAuthorization } from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { standingFixture } from './standing-fixture.ts';

const GLOBAL = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
// The seeded Global Context declares its own type, as the platform root anchor does.
const globalParent = { resource: GLOBAL, resourceType: 'semantic.context', validate: async () => true };

let f: Awaited<ReturnType<typeof standingFixture>>;
beforeAll(async () => {
  f = await standingFixture();
}, 30000);
beforeEach(() => f.reset());
afterAll(() => f?.close());

// post:create declares one resource type, the case where the child type used to select the parent's profile.
async function createUnderGlobal(granted: boolean) {
  if (granted) await f.grant(f.actor, 'post:create', GLOBAL);
  const context = await f.context();
  const child = { route: f.otherResource.route, id: newId(f.otherResource.route) };
  const { actor } = context;
  const authorization = parentCreationAuthorization({
    access: f.access,
    actor,
    action: 'post:create',
    parent: globalParent,
    context: { ...context, resource: child },
  });
  return runCommand(
    f.pool,
    {
      partition: partitionOf(child.route),
      deadline: context.deadline,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization,
    },
    async (tx) => {
      await tx.query('INSERT INTO public.standing_resource VALUES ($1,$2)', [child.route, child.id]);
      return { value: child, events: [{ type: 'com.rezics.fixture.created.v1', data: child }] };
    },
  ).then((result) => ({ result, child }));
}

test('a direct Global grant for the child action permits creation under the typed Global parent', async () => {
  const { result, child } = await createUnderGlobal(true);
  expect(result.value).toEqual(child);
});

test('the typed Global parent refuses the same creation without the direct Global grant', async () => {
  await expect(createUnderGlobal(false)).rejects.toBeInstanceOf(GrantDeniedError);
});
