import { expect, test } from 'bun:test';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { TERMINAL_ERASURE_BARRIER_TABLE } from './support/terminal-erasure-worker.ts';
import { createTerminalErasureFixture } from './support/terminal-erasure-fixture.ts';

test('terminal erasure combined Edition prerequisites publish and capture each native seller independently', async () => {
  const world = await createTerminalErasureFixture();
  try {
    const worker = await world.startWorker();
    await prepareSourceWithWorker(world);
    await world.json(world.people.staff, 'POST', '/v1/platform/exposure/selling:open');
    for (const seller of [world.people.alice, world.people.bob]) {
      await world.json(world.people.staff, 'POST', '/v1/grants', {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: seller.accountId },
        actions: ['offer:create'],
        valid: '(,)',
      });
      // Exercise restoration of both an open gate and a gate already held by the caller.
      const held = seller === world.people.bob;
      if (held) await worker.hold(world.pool);
      const publisher = await world.editions(seller);
      const edition = await publisher.publish({ title: 'Native erasure edition', body: 'Seller-owned sale copy' });
      const metadata = await world.json(seller, 'GET', `/v1/contentEditions/${edition.contentEditionId}`);
      expect(metadata).toMatchObject({
        state: 'published',
        creatorAccountId: seller.accountId,
        targetSubjectId: edition.targetSubjectId,
        revisionId: edition.revisionId,
        sha256: edition.sha256,
      });
      const response = await world.command(seller, 'POST', '/v1/offers', {
        contentEditionId: edition.contentEditionId,
        title: edition.title,
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      });
      const body = await response.json();
      expect({ status: response.status, body: response.ok ? null : body }).toEqual({ status: 201, body: null });
      expect(body.offer.contentEdition.creatorAccountId).toBe(seller.accountId);
      expect(body.offer.contentEdition.benefit.resource.id).toBe(edition.contentEditionId);
      const [gate] = await world.readOnly<{ held: boolean }>(
        `SELECT held FROM ${TERMINAL_ERASURE_BARRIER_TABLE} WHERE singleton=true`,
      );
      expect(gate!.held).toBe(held);
      expect(
        world.editionSubjectWrites
          .filter((write) => write.sellerAccountId === seller.accountId)
          .map((write) => ({ type: write.subjectType, held: write.held })),
      ).toEqual([
        { type: 'skos:ConceptScheme', held },
        { type: 'skos:Concept', held },
        { type: 'skos:Concept', held },
      ]);
      if (held) await worker.release(world.pool);
    }
  } finally {
    await world.close();
  }
}, 180_000);

test('terminal erasure activation and Source preparation complete with the native worker running', async () => {
  const world = await createTerminalErasureFixture();
  try {
    await world.startWorker();
    await prepareSourceWithWorker(world);
  } finally {
    await world.close();
  }
}, 180_000);

async function prepareSourceWithWorker(world: Awaited<ReturnType<typeof createTerminalErasureFixture>>) {
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
}
