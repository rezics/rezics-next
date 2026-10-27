import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('deleted curator freezes collaborator writes and receipt replay without hiding public Collections', async () => {
  const route = 0x6a10,
    ownerId = newId(route),
    collaboratorId = newId(route),
    actions = ['collection:create', 'collection:read', 'collection:update', 'collection:delete', 'subject:read'];
  const real = await createRealAccess(db.admin, { owner: ownerId, collaborator: collaboratorId }, actions),
    access = real.access({
      actions: new Map(
        actions.map((action) => [
          action,
          {
            anonymous: action === 'subject:read',
            ...(action === 'collection:create' ? { 'x-resource-types': ['library.collection'] } : {}),
          },
        ]),
      ),
    });
  const auth = (persona: 'owner' | 'collaborator') =>
      access.authenticate(real.bearer(persona), { pool: db.pool, deadline: Date.now() + 5000 }),
    commands = createCollectionCommands({ pool: db.pool, access });
  const created = await commands.createCollection(
      await auth('owner'),
      { title: 'Public', visibility: 'public' },
      randomUUID(),
    ),
    resource = { route: routeOf(created.value.id)!, id: created.value.id };
  await real.grant(resource, 'collaborator', 'collection:update');
  const key = randomUUID(),
    input = { revision: 1, title: 'Collaborator' },
    changed = await commands.updateCollection(await auth('collaborator'), created.value.id, input, key);
  await db.admin.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [route, ownerId]);
  await expect(commands.updateCollection(await auth('collaborator'), created.value.id, input, key)).rejects.toThrow();
  await expect(
    commands.updateCollection(
      await auth('collaborator'),
      created.value.id,
      { revision: changed.value.revision, title: 'Forbidden' },
      randomUUID(),
    ),
  ).rejects.toThrow();
  const row = (
    await db.admin.query(
      'SELECT title,state,visibility,curator_account_id FROM library.collection WHERE route=$1 AND collection_id=$2',
      [route, created.value.id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    title: 'Collaborator',
    state: 'active',
    visibility: 'public',
    curator_account_id: ownerId,
  });
});
