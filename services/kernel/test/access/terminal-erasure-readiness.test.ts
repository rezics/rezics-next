import { expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { readContentEditionSaleAuthority } from '../../src/content/edition-sale.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { routeOf } from '../../src/route/route.ts';
import { TERMINAL_ERASURE_BARRIER_TABLE } from './support/terminal-erasure-worker.ts';
import { createTerminalErasureFixture } from './support/terminal-erasure-fixture.ts';

test('terminal erasure order prerequisite reads the offer as the buyer and creates controlled native Checkout', async () => {
  const world = await createTerminalErasureFixture();
  try {
    await world.startWorker();
    const { alice, bob, staff } = world.people;
    await world.prepareAccountAgent(alice);
    for (const group of ['selling', 'purchases'])
      await world.json(staff, 'POST', `/v1/platform/exposure/${group}:open`);
    await world.json(staff, 'POST', '/v1/grants', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: bob.accountId },
      actions: ['offer:create'],
      valid: '(,)',
    });
    const publisher = await world.editions(bob);
    const edition = await publisher.publish({ title: 'Retained order edition', body: 'Bob sale copy' });
    const created = await world.json<{ offer: { id: string; revision?: number } }>(bob, 'POST', '/v1/offers', {
      contentEditionId: edition.contentEditionId,
      title: edition.title,
      currency: 'usd',
      unitAmountMinor: 900,
      taxCode: 'txcd_10302000',
    });
    expect(created.offer.revision).toBeUndefined();
    const offerId = created.offer.id;
    const { offer } = await world.json<{ offer: { revision: number } }>(alice, 'GET', `/v1/offers/${offerId}`);
    const denied = await world.command(alice, 'POST', '/v1/orders', {
      offerId,
      expectedOfferRevision: offer.revision,
    });
    if (denied.status === 503) {
      const context = { pool: world.pool, deadline: Date.now() + 30_000 };
      const actor = await world.kernel.testAccess.authenticate(alice.bearer, context);
      const consent = createCurrentConsentReader({ database: world.auth.authPool });
      try {
        const authority = await readContentEditionSaleAuthority(
          {
            pool: world.pool,
            access: world.kernel.testAccess,
            clock: () => new Date(),
            readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
          },
          edition.contentEditionId,
          { actor, deadline: context.deadline },
        );
        console.error('Terminal erasure buyer sale authority after order 503:', authority);
      } catch (error) {
        console.error('Terminal erasure buyer sale authority after order 503:', error);
      }
    }
    expect({ status: denied.status, body: denied.status === 404 ? null : await denied.text() }).toEqual({
      status: 404,
      body: null,
    });
    expect(world.stripe.requests).toHaveLength(0);
    await world.json(staff, 'POST', '/v1/grants', {
      resource: { route: routeOf(offerId)!, id: offerId },
      subject: { kind: 'account', id: alice.accountId },
      actions: ['order:create'],
      valid: '(,)',
    });
    const { order } = await world.createOrder(alice, offerId);
    expect(order.offerId).toBe(offerId);
    expect(order.checkoutUrl).toBeString();
    const read = await world.json(alice, 'GET', `/v1/orders/${order.id}`);
    expect(read).toMatchObject({ order: { id: order.id, checkoutUrl: order.checkoutUrl } });
    const [stored] = await world.readOnly<{ buyer: string; seller: string; revision: number }>(
      `SELECT buyer_account_id::text AS buyer, creator_account_id::text AS seller, offer_revision AS revision
       FROM commerce.purchase_order WHERE order_id=$1`,
      [order.id],
    );
    expect(stored).toEqual({ buyer: alice.accountId, seller: bob.accountId, revision: offer.revision });
    expect(world.stripe.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'POST', path: '/v1/checkout/sessions' },
    ]);
  } finally {
    await world.close();
  }
}, 180_000);

test('terminal erasure combined subject and Edition prerequisites publish and capture each native seller independently', async () => {
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
        world.subjectWrites
          .filter((write) => write.actorAccountId === seller.accountId)
          .map((write) => ({ type: write.subjectType, held: write.held })),
      ).toEqual([
        { type: 'skos:ConceptScheme', held },
        { type: 'skos:Concept', held },
        { type: 'skos:Concept', held },
      ]);
      // Cover the shared Book helper and the discussion Concept path in both gate states.
      const { subject: book } = await world.subject('Pending or sentinel erasure member');
      const { subject: concept } = await world.json<{ subject: { id: string } }>(
        world.people.staff,
        'POST',
        '/v1/subjects',
        { type: 'skos:Concept', labels: { en: 'Terminal erasure board' } },
      );
      expect(book.id).not.toBe(concept.id);
      expect(world.subjectWrites.slice(-2).map((write) => ({ type: write.subjectType, held: write.held }))).toEqual([
        { type: 'schema:Book', held },
        { type: 'skos:Concept', held },
      ]);
      // A refused request must restore the same gate without a retry or bypassing admission.
      const invalid = await world.command(world.people.staff, 'POST', '/v1/subjects', { type: 'invalid:Type' });
      expect(invalid.status).toBe(400);
      const [restored] = await world.readOnly<{ held: boolean }>(
        `SELECT held FROM ${TERMINAL_ERASURE_BARRIER_TABLE} WHERE singleton=true`,
      );
      expect(restored!.held).toBe(held);
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
