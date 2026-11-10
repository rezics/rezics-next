import { expect, test } from 'bun:test';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { createTerminalErasureFixture } from './support/terminal-erasure-fixture.ts';

test('terminal erasure activation effects make the real account agent followable before graph setup', async () => {
  const world = await createTerminalErasureFixture();
  try {
    await world.startWorker();
    await world.prepareAccountAgent(world.people.alice);
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
