import { ProblemError } from '../../src/http/problem.ts';
import { newId } from '../../src/route/route.ts';
import { preparationBasis } from '../../src/library/members-preparation.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { preparationDefinitionBases, restorePreparationDefinition } from '../../src/library/members-preparation.ts';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import { partitionOf } from '../../src/route/route.ts';
import { definition, membersPreparationRuntime, retainEpisodes } from './support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;
beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120000);
afterAll(async () => {
  await native?.close();
});

test('mixed admission at quota returns live reused episodes without rewriting their LRU time', async () => {
  const f = await native.fixture();
  for (const start of [0, 16])
    await f.store.reserve(
      f.actor,
      f.collectionId,
      Array.from({ length: 16 }, (_, i) => definition(start + i)),
    );
  const initial = (await native.rows(f.owner)).sort(
    (a, b) =>
      new Date(a.last_read_at).getTime() - new Date(b.last_read_at).getTime() ||
      String(a.episode_id).localeCompare(String(b.episode_id)),
  );
  const reused = initial.slice(0, 2);
  await retainEpisodes(
    native.db,
    {
      route: reused[0]!.route,
      ownerAccountId: f.owner.accountId,
      collectionId: f.collectionId,
      episodeId: reused[0]!.episode_id,
    },
    64,
    { headers: true, queued: false },
  );
  native.advance(1);
  const result = await f.store.reserve(f.actor, f.collectionId, [
    ...reused.map((row) => ({ ...definition(), filter: JSON.parse(row.canonical_basis)[3] })),
    definition(32),
    definition(33),
  ]);
  expect(result.episodes.slice(0, 2).map((e) => e.locator.episodeId)).toEqual(reused.map((r) => r.episode_id));
  expect(result.intent!.input.episodes).toHaveLength(2);
  expect(result.intent!.input.cleanup.map((e) => e.episodeId).sort()).toEqual(
    initial
      .slice(2, 4)
      .map((r) => r.episode_id)
      .sort(),
  );
  const saved = await native.rows(f.owner);
  expect(saved).toHaveLength(98);
  expect(saved.filter((row) => row.state === 'live')).toHaveLength(32);
  for (const previous of reused) {
    const row = saved.find((r) => r.episode_id === previous.episode_id)!;
    expect(row.state).toBe('live');
    expect(row.last_read_at).toEqual(previous.last_read_at);
  }
  for (const episode of result.episodes) expect(await native.step(episode.locator)).toBe(true);
});

test('a positive native reservation and admitted step supply no unbound Source definition', async () => {
  const f = await native.fixture();
  const { episodes } = await f.store.reserve(f.actor, f.collectionId, [definition()]);
  const locator = episodes[0]!.locator;
  const result = runOperationalTransaction(
    native.db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: 'library.membersPreparation.step',
      accounts: [locator.ownerAccountId],
      workClient: native.workClient,
    },
    async (tx) => {
      expect(await f.store.admitStep(tx, locator)).toBe(true);
      return f.store.readWorkDefinition(tx, locator);
    },
  );
  await expect(result).rejects.toMatchObject({ code: 'dependency_unavailable' });
});

test('preparation keys deduplicate only identical accepted owner definitions', () => {
  const owner = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const collection = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const selected = definition();
  const [basis] = preparationDefinitionBases(owner, collection, [selected, selected]);
  expect(basis?.canonicalBasis).toBe(
    canonicalize([1, owner, collection, selected.filter, selected.sort, selected.release.digest]),
  );
  expect(basis?.basisDigest).toEqual(createHash('sha256').update(basis!.canonicalBasis).digest());
  expect(preparationDefinitionBases(owner, collection, [selected, { ...selected, sort: 'ordinal' }])).toHaveLength(2);
});

test('retained definitions recover exact immutable meaning and reject invalid bytes before release I/O', async () => {
  const owner = 'owner';
  const collection = 'collection';
  const selected = definition();
  const [retained] = preparationDefinitionBases(owner, collection, [selected]);
  const reads: string[] = [];
  const load = async (digest: string) => {
    reads.push(digest);
    return structuredClone(selected.release.value);
  };
  expect(await restorePreparationDefinition(owner, collection, retained!, load)).toEqual(selected);
  expect(reads).toEqual([selected.release.digest]);
  reads.length = 0;
  for (const [addressedOwner, addressedCollection, bytes] of [
    ['foreign', collection, retained!.canonicalBasis],
    [owner, 'foreign', retained!.canonicalBasis],
    [owner, collection, ` ${retained!.canonicalBasis}`],
    [owner, collection, canonicalize([2, owner, collection, selected.filter, 'id', selected.release.digest])!],
  ]) {
    const canonicalBasis = bytes!;
    await expect(
      restorePreparationDefinition(
        addressedOwner!,
        addressedCollection!,
        { canonicalBasis, basisDigest: createHash('sha256').update(canonicalBasis).digest() },
        load,
      ),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
  }
  await expect(
    restorePreparationDefinition(owner, collection, { ...retained!, basisDigest: new Uint8Array(32) }, load),
  ).rejects.toMatchObject({ code: 'unsupported_query' });
  expect(reads).toEqual([]);
  await expect(restorePreparationDefinition(owner, collection, retained!, async () => null)).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
  await expect(
    restorePreparationDefinition(owner, collection, retained!, async () => ({ ...selected.release.value, types: {} })),
  ).rejects.toMatchObject({ code: 'unsupported_query' });
});

test('preparation identity uses the expanded immutable release meaning and distinguishes internal curated order', () => {
  const owner = newId(16);
  const collection = newId(16);
  const admitted = definition();
  expect(preparationBasis(owner, collection, admitted)).toBe(
    canonicalize([1, owner, collection, admitted.filter, 'id', admitted.release.digest])!,
  );
  expect(preparationBasis(owner, collection, { ...admitted, sort: 'ordinal' })).toBe(
    canonicalize([1, owner, collection, admitted.filter, 'ordinal', admitted.release.digest])!,
  );
  expect(preparationBasis(owner, collection, admitted)).not.toBe(
    preparationBasis(owner, collection, { ...admitted, sort: 'ordinal' }),
  );
});

test('preparation identity refuses a release whose bytes do not match its immutable digest', () => {
  const admitted = definition();
  const invalid = { ...admitted, release: { ...admitted.release, digest: 'sha256:' + '0'.repeat(64) } };
  expect(() => preparationBasis(newId(16), newId(16), invalid)).toThrow(new ProblemError('unsupported_query'));
});
