import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { bindReceiptKeys, receiptKeysFor } from '../../src/command/receipt-key.ts';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import {
  createCollectionPublicationEpisodes,
  readCollectionPublicationEpisode,
} from '../../src/library/collection-publication-episodes.ts';
import { createCollectionPublicationFinalActivation } from '../../src/library/collection-publication-final.ts';
import { admitCollectionPublicationStep } from '../../src/library/collection-publication-work-admission.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import {
  beginCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import { readSavedCollectionRule } from '../../src/library/collection-rules.ts';
import { readCollection } from '../../src/library/collection-store.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { sourceAllowance } from './support/canonical-source-runtime-fixture.ts';
import { membersPreparationRuntime } from './support/members-preparation-runtime.ts';

let f: Awaited<ReturnType<typeof membersPreparationRuntime>>;
beforeAll(async () => {
  f = await membersPreparationRuntime();
  await setupSemantic(f.db.pool, bundledRelease);
  for (const group of ['personal_library', 'reading_progress'])
    expect((await f.send(f.personas.staff, 'POST', `/v1/platform/exposure/${group}:open`, {})).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
const filter = { type: { in: ['schema:Book'] } };

async function paused() {
  const owner = await f.person(),
    actor = await f.actor(owner);
  if (actor.kind !== 'account') throw new Error('Native account required');
  const response = await f.send(owner, 'POST', '/v1/collections', {
    title: 'Shared saved view',
    membershipKind: 'dynamic',
    visibility: 'private',
    rule: { filter },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const { collection } = await response.json();
  const id = collection.id as string,
    route = routeOf(id)!;
  expect((await f.send(owner, 'PATCH', `/v1/collections/${id}`, { revision: 1, visibility: 'public' })).status).toBe(
    200,
  );
  const a = { route, collectionId: id, generation: randomUUID() },
    deadline = Date.now() + 30000;
  // Install A through the existing native output producer, with genuine command custody.
  await runCommand(
    f.db.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline,
      receipt: {
        kind: 'library.collection.refresh-test-output',
        key: randomUUID(),
        digest: createHash('sha256').update(JSON.stringify(a)).digest(),
      },
      authorization: resourceAuthorization({
        access: f.kernel.testAccess,
        actor,
        action: 'collection:update',
        anchor: {
          resource: { route, id },
          async validate(client) {
            const current = await readCollection(client, route, id);
            return (
              current?.curatorAccountId === owner.accountId &&
              current.state === 'active' &&
              current.visibility === 'public'
            );
          },
        },
        context: { pool: f.db.pool, partition: partitionOf(route), deadline },
      }),
    },
    async (tx) => {
      await beginCollectionSourceOutput(tx, { ...a, expectedMembers: 0 });
      await completeCollectionSourceOutput(tx, a);
      return {
        value: a,
        events: [{ type: 'com.rezics.library.collection.updated.v1', subject: id, data: { collectionId: id } }],
      };
    },
  );
  const episodes = createCollectionPublicationEpisodes({ pool: f.db.pool, access: f.kernel.testAccess });
  const input = { collectionId: id, revision: 2, visibility: 'public' as const },
    key = randomUUID();
  const b = (await episodes.begin(actor, input, key)).value.locator;
  const consent = createCurrentConsentReader({ database: f.auth.authPool });
  const final = createCollectionPublicationFinalActivation({
    workContext: {
      pool: f.db.pool,
      clock: () => new Date(),
      getAuthorization: () => ({
        access: f.kernel.testAccess,
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      }),
    },
  });
  const rule = () => readSavedCollectionRule(f.db.pool, route, id);
  const metadata = async () =>
    (
      await readNativeCollectionMetadata(f.db.pool, a, {
        deadline: Date.now() + 30000,
        allowance: sourceAllowance(),
      })
    ).metadata;
  return { owner, actor, id, route, a, b, input, key, episodes, final, rule, metadata };
}

test('incomplete B cannot replace A; unchanged rules preserve A and real edits retire B before a fresh explicit republish', async () => {
  const p = await paused(),
    before = (await p.rule())!;
  expect((await p.metadata())?.outputGeneration).toBe(p.a.generation);
  await expect(p.final.activate(p.b, randomUUID())).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect((await p.metadata())?.outputGeneration).toBe(p.a.generation);
  expect((await f.send(p.owner, 'PUT', `/v1/collections/${p.id}/rule`, { revision: 2, filter })).status).toBe(200);
  expect(await p.rule()).toEqual(before);
  expect((await p.metadata())?.outputGeneration).toBe(p.a.generation);
  expect((await readCollectionPublicationEpisode(f.db.pool, p.b))?.phase).toBe('staging');
  const edit = { revision: 2, filter: { not: filter } };
  expect((await f.send(p.owner, 'PUT', `/v1/collections/${p.id}/rule`, edit)).status).toBe(200);
  const after = (await p.rule())!;
  expect(after.revision).toBe(before.revision + 1);
  expect(BigInt(after.sourceGeneration)).toBe(BigInt(before.sourceGeneration) + 1n);
  expect((await p.metadata())?.outputGeneration).toBeNull();
  expect((await readCollectionPublicationEpisode(f.db.pool, p.b))?.phase).toBe('refused');
  await expect(p.episodes.begin(p.actor, p.input, p.key)).rejects.toMatchObject({ code: 'dependency_unavailable' });
  const next = await p.episodes.begin(p.actor, { ...p.input, revision: after.collectionRevision }, randomUUID());
  expect(next.value.locator.publicationId).not.toBe(p.b.publicationId);
  await expect(p.final.activate(next.value.locator, randomUUID())).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
  expect((await readCollectionPublicationEpisode(f.db.pool, next.value.locator))?.selected).toBeNull();
}, 120000);

test('private visibility during paused work withdraws A immediately and old work stays refused after reopening', async () => {
  const p = await paused(),
    before = (await p.rule())!;
  expect((await f.send(p.owner, 'PATCH', `/v1/collections/${p.id}`, { revision: 2, title: 'Renamed' })).status).toBe(
    200,
  );
  expect((await p.rule())?.revision).toBe(before.revision);
  expect(
    (await f.send(p.owner, 'PATCH', `/v1/collections/${p.id}`, { revision: 3, visibility: 'private' })).status,
  ).toBe(200);
  expect((await p.metadata())?.outputGeneration).toBeNull();
  expect((await f.send(null, 'GET', `/v1/collections/${p.id}/members`)).status).toBe(404);
  expect(
    (await f.send(p.owner, 'PATCH', `/v1/collections/${p.id}`, { revision: 4, visibility: 'public' })).status,
  ).toBe(200);
  await runOperationalTransaction(
    f.db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(p.route),
      kind: 'library.collectionPublication.step',
      accounts: [p.owner.accountId],
      workClient: f.workClient,
      deadline: Date.now() + 30000,
    },
    async (tx) => {
      bindReceiptKeys(tx, receiptKeysFor(f.db.pool));
      expect(await admitCollectionPublicationStep(tx, p.b)).toBe(false);
    },
  );
  await expect(p.episodes.begin(p.actor, p.input, p.key)).rejects.toMatchObject({ code: 'dependency_unavailable' });
  await expect(p.final.activate(p.b, randomUUID())).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect((await readCollectionPublicationEpisode(f.db.pool, p.b))?.phase).toBe('refused');
  expect((await p.metadata())?.outputGeneration).toBeNull();
  const next = await p.episodes.begin(p.actor, { ...p.input, revision: 5 }, randomUUID());
  expect((await readCollectionPublicationEpisode(f.db.pool, next.value.locator))?.phase).toBe('staging');
}, 120000);
