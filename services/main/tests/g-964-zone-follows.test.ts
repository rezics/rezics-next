import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { followSpace, registerFollowSpace, resolveFollowIdentity } from '../src/modules/follows/targets.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
test('G-964: Zone-only follows canonicalize either capability or Space to the same slot without fabricating a Realm', async () => {
  const session = { query: async (sql: string) => sql.includes('SELECT DISTINCT ?space')
    ? [{ space: { value: space }, zone: { value: zone } }] : [{ name: { value: 'A site' } }] } as unknown as WorkReadSession;
  for (const target of [zone, space]) {
    const identity = await followSpace(session, target);
    expect(identity).toEqual({ space, realm: null, aliases: [space, zone], nameKey: 'a site' });
    expect(await resolveFollowIdentity(session, target, 'zone')).toMatchObject({ target: space, kind: 'space' });
    const writes: unknown[][] = [];
    await registerFollowSpace({ query: async (_sql: string, args: unknown[]) => { writes.push(args); } } as unknown as PoolClient, identity!);
    expect(writes[0]).toEqual([[space, zone], space, null, 'a site']);
  }
});
