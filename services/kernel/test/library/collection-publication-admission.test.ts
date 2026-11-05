import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import {
  createCollectionPublicationEpisodes,
  readCollectionPublicationEpisode,
} from '../../src/library/collection-publication-episodes.ts';
import {
  admitCollectionPublicationStep,
  readCollectionPublicationWorkDefinition,
} from '../../src/library/collection-publication-work-admission.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { membersPreparationRuntime } from './support/members-preparation-runtime.ts';

test('publication locator and copied query cannot admit Source IO without the original live Core client', async () => {
  let queries = 0;
  const client = {
    query() {
      queries++;
      throw new Error('Unadmitted publication attempted IO');
    },
  };
  const locator = {
    route: 32,
    ownerAccountId: newId(33),
    collectionId: newId(32),
    publicationId: newId(32),
  };
  // Deliberately enter through the untyped runtime boundary; no OperationalTransaction cast
  // can turn either the copied query method or a row-shaped object into a native transaction.
  for (const untrusted of [client, Object.create(client), { ...client }]) {
    expect(await Reflect.apply(admitCollectionPublicationStep, undefined, [untrusted, locator])).toBe(false);
    expect(await Reflect.apply(readCollectionPublicationWorkDefinition, undefined, [untrusted, locator])).toBeNull();
  }
  expect(queries).toBe(0);
});

test('publication admission binds a real live episode to its complete current private Source or stays unavailable, and changed native rule invalidates the episode', async () => {
  const native = await membersPreparationRuntime();
  try {
    const owner = await native.person();
    const created = await native.send(owner, 'POST', '/v1/collections', {
      title: 'Native publication admission',
      visibility: 'private',
      membershipKind: 'dynamic',
      rule: { filter: { owner: { presence: true } }, sort: 'id' },
    });
    expect(created.status).toBe(201);
    const { collection } = (await created.json()) as {
      collection: { id: string; revision: number };
    };
    const route = routeOf(collection.id)!;
    const actor = await native.actor(owner);
    const begun = await createCollectionPublicationEpisodes({
      pool: native.db.pool,
      access: native.kernel.testAccess,
    }).begin(actor, { collectionId: collection.id, revision: collection.revision, visibility: 'public' }, randomUUID());
    const locator = begun.value.locator;
    const deadline = Date.now() + 30000;
    const workOptions = {
      mode: 'work-step' as const,
      partition: partitionOf(route),
      kind: 'library.collectionPublication.step',
      accounts: [owner.accountId],
      workClient: native.workClient,
      deadline,
    };

    await runOperationalTransaction(native.db.pool, workOptions, async (tx) => {
      const episode = await readCollectionPublicationEpisode(tx, locator);
      expect(episode).not.toBeNull();
      expect(episode).toMatchObject({ phase: 'staging', output: { state: 'building' } });

      const admitted = await admitCollectionPublicationStep(tx, locator);
      const definition = await readCollectionPublicationWorkDefinition(tx, locator);
      expect(admitted).toBe(definition !== null);
      if (definition) {
        expect(definition.locator).toEqual(locator);
        expect(definition.input.kind).toBe('private_working_source');
        expect(isDeepStrictEqual(definition.input.identity, definition.sourceIdentity)).toBe(true);
        expect(definition.target).toMatchObject({ kind: 'collection_output', collectionId: collection.id });
        expect(definition.definition).toMatchObject({
          filter: { owner: { presence: true } },
          sort: 'id',
          release: { digest: definition.releaseDigest },
        });
        expect(definition.output.state).toBe('building');
        expect('publication' in definition.output).toBe(false);
      }

      const missingEpisode = { ...locator, publicationId: newId(route) };
      expect(await admitCollectionPublicationStep(tx, missingEpisode)).toBe(false);
      expect(await readCollectionPublicationWorkDefinition(tx, missingEpisode)).toBeNull();

      const wrongOwner = { ...locator, ownerAccountId: newId(route) };
      expect(await admitCollectionPublicationStep(tx, wrongOwner)).toBe(false);
      expect(await readCollectionPublicationWorkDefinition(tx, wrongOwner)).toBeNull();
    });

    const changed = await native.send(owner, 'PUT', `/v1/collections/${collection.id}/rule`, {
      revision: collection.revision,
      filter: { not: { owner: { presence: true } } },
      sort: 'id',
    });
    expect(changed.status).toBe(200);

    await runOperationalTransaction(native.db.pool, workOptions, async (tx) => {
      expect(await readCollectionPublicationEpisode(tx, locator)).not.toBeNull();
      expect(await admitCollectionPublicationStep(tx, locator)).toBe(false);
      expect(await readCollectionPublicationWorkDefinition(tx, locator)).toBeNull();
    });
  } finally {
    await native.close();
  }
}, 120000);
