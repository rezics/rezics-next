import { expect, test } from 'bun:test';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { drainEffects } from '../support/account-deletion.ts';
import { createTerminalErasureFixture } from './support/terminal-erasure-fixture.ts';

test('terminal erasure activation effects make the real account agent followable before graph setup', async () => {
  const world = await createTerminalErasureFixture();
  try {
    await world.startWorker();
    await drainEffects(world.pool, partitionOf(routeOf(world.people.alice.accountId)!), { deadlineMs: 45_000 });
    const follow = await world.command(
      world.people.bob,
      'PUT',
      `/v1/follows/${accountAgentId(world.people.alice.accountId)}`,
    );
    expect(follow.status).toBe(200);
  } finally {
    await world.close();
  }
}, 180_000);
