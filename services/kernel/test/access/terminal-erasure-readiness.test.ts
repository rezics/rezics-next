import { expect, test } from 'bun:test';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { createTerminalErasureFixture } from './support/terminal-erasure-fixture.ts';

test('terminal erasure activation and Source preparation complete with the native worker running', async () => {
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
    const alice = world.people.alice;
    const { subject } = await world.subject('Source preparation member');
    await world.json(alice, 'PUT', `/v1/libraryEntries/${subject.id}`, { state: 'planned' });
    const { label } = await world.json<{ label: { id: string } }>(alice, 'POST', '/v1/libraryLabels', {
      name: 'Source preparation label',
    });
    await world.json(alice, 'POST', `/v1/libraryLabels/${label.id}:assign`, { subjectId: subject.id });
    const { collection } = await world.json<{ collection: { id: string; revision: number } }>(
      alice,
      'POST',
      '/v1/collections',
      {
        membershipKind: 'dynamic',
        title: 'Source preparation',
        visibility: 'private',
        rule: { filter: { owner: { presence: true } } },
      },
    );
    await world.prepareSource(alice, collection.id);
    const selected = await world.command(alice, 'POST', `/v1/collections/${collection.id}:publishSelected`, {
      revision: collection.revision,
      subjectIds: [subject.id],
    });
    expect(selected.status).toBe(200);
    expect((await selected.json()).publication).toMatchObject({ state: 'complete', itemCount: 1 });
  } finally {
    await world.close();
  }
}, 180_000);
