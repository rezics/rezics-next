import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  capture,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

type World = ReleasedDiscoveryFixture;
type PinPage = {
  pins: { collectionId: string; target: Record<string, unknown> | null }[];
  revision: number;
  next: string | null;
};

function status(response: HttpResponse, expected: number): HttpResponse {
  expect(response.status, `Native HTTP ${response.status}: ${JSON.stringify(response.body)}`).toBe(expected);
  return response;
}

function page(response: HttpResponse): PinPage {
  status(response, 200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return response.body as PinPage;
}

async function createCollection(f: World, title: string) {
  const response = status(
    await f.request('alice', 'POST', '/v1/collections', { title, visibility: 'private' }, discoveryKey()),
    201,
  );
  return response.body.collection as { id: string; title: string; revision: number };
}

function ownerPopulation(name: string, accountId: string): Population {
  const route = routeOf(accountId)!;
  return {
    name,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows({ ordinal }) {
      const id = newId(route);
      const at = new Date(Date.UTC(2020, 0, 1) + ordinal * 1000).toISOString();
      return {
        'library.collection': [
          {
            route,
            collection_id: id,
            curator_account_id: accountId,
            title: `Growth noise ${ordinal}`,
            description: null,
            visibility: 'private',
            state: 'active',
            revision: 1,
            member_count: 0,
            order_epoch: 0,
            created_at: at,
            updated_at: at,
            transaction_id: randomUUID(),
            listing_ever_public: false,
            membership_kind: 'curated',
          },
        ],
      };
    },
  };
}

test('native private pin costs stay fixed as unrelated owners and the target home grow to 4096 Collections', async () => {
  let database: GrowthDatabase | undefined;
  let fixture: World | undefined;
  try {
    fixture = await createReleasedDiscoveryFixture({
      version: 1,
      kernelPool: async (url) => {
        database = await openGrowthDatabase(url);
        return database.pool;
      },
    });
    await fixture.setup.openFeatures(['personal_library']);

    const firstTarget = await createCollection(fixture, 'Pinned and later concealed target');
    const retainedTarget = await createCollection(fixture, 'Fixed returned curated header');
    const lostAckKey = discoveryKey();
    const firstWrite = await capture(database!, () =>
      fixture!.request('alice', 'PUT', `/v1/libraryPins/${firstTarget.id}`, { revision: 0 }, lostAckKey),
    );
    expect(status(firstWrite.value, 200).body).toEqual({ revision: 1 });
    const firstPinWrites = firstWrite.capture.statements.filter((sql) =>
      /(?:INSERT INTO|UPDATE) library\.collection_pins/i.test(sql),
    );
    expect(firstPinWrites.filter((sql) => /^\s*INSERT INTO/i.test(sql))).toHaveLength(1);
    expect(firstPinWrites.filter((sql) => /^\s*UPDATE library\.collection_pins/i.test(sql))).toHaveLength(0);

    const existingUpdate = await capture(database!, () =>
      fixture!.request(
        'alice',
        'PUT',
        `/v1/libraryPins/${retainedTarget.id}`,
        { revision: 1, after: firstTarget.id },
        discoveryKey(),
      ),
    );
    expect(status(existingUpdate.value, 200).body).toEqual({ revision: 2 });
    const updateWrites = existingUpdate.capture.statements.filter((sql) =>
      /(?:INSERT INTO|UPDATE) library\.collection_pins/i.test(sql),
    );
    expect(updateWrites.filter((sql) => /^\s*INSERT INTO/i.test(sql))).toHaveLength(1);
    expect(updateWrites.filter((sql) => /^\s*UPDATE library\.collection_pins/i.test(sql))).toHaveLength(1);

    // The first successful acknowledgement is intentionally discarded. Later native changes and concealment do
    // not turn an exact authorized receipt replay into a new target read or a rebased preference write.
    expect(
      status(
        await fixture.request(
          'alice',
          'DELETE',
          `/v1/collections/${firstTarget.id}?revision=${firstTarget.revision}`,
          undefined,
          discoveryKey(),
        ),
        204,
      ).status,
    ).toBe(204);
    const concealedReorder = await capture(database!, () =>
      fixture!.request(
        'alice',
        'PUT',
        `/v1/libraryPins/${firstTarget.id}`,
        { revision: 2, after: retainedTarget.id },
        discoveryKey(),
      ),
    );
    expect(status(concealedReorder.value, 200).body).toEqual({ revision: 3 });
    const concealedRemove = await capture(database!, () =>
      fixture!.request('alice', 'DELETE', `/v1/libraryPins/${firstTarget.id}?revision=3`, undefined, discoveryKey()),
    );
    expect(status(concealedRemove.value, 200).body).toEqual({ revision: 4 });
    for (const observed of [concealedReorder, concealedRemove])
      expect(observed.capture.statements.some((sql) => /\bFROM library\.collection\b/i.test(sql))).toBe(false);
    const replay = await capture(database!, () =>
      fixture!.request('alice', 'PUT', `/v1/libraryPins/${firstTarget.id}`, { revision: 0 }, lostAckKey),
    );
    expect(status(replay.value, 200).body).toEqual({ revision: 1 });
    expect(replay.capture.statements.some((sql) => /\bFROM library\.collection\b/i.test(sql))).toBe(false);
    expect(page(await fixture.request('alice', 'GET', '/v1/libraryPins'))).toMatchObject({
      revision: 4,
      pins: [{ collectionId: retainedTarget.id }],
    });

    const discovered = status(
      await fixture.request(
        'alice',
        'GET',
        `/v1/collections?curatorAccountId=${fixture.personas.alice.accountId}&limit=100`,
      ),
      200,
    ).body.collections as { id: string; builtinKind?: string }[];
    const everything = discovered.find((collection) => collection.builtinKind === 'everything');
    const liked = discovered.find((collection) => collection.builtinKind === 'liked');
    expect(everything).toBeDefined();
    expect(liked).toBeDefined();
    expect(
      status(
        await fixture.request('alice', 'PUT', `/v1/libraryPins/${everything!.id}`, { revision: 4 }, discoveryKey()),
        200,
      ).body,
    ).toEqual({ revision: 5 });
    expect(
      status(
        await fixture.request('alice', 'PUT', `/v1/libraryPins/${liked!.id}`, { revision: 5 }, discoveryKey()),
        200,
      ).body,
    ).toEqual({ revision: 6 });

    const alice = fixture.personas.alice.accountId;
    const bob = fixture.personas.bob.accountId;
    const aliceNoise = ownerPopulation('pin-target-home-collections', alice);
    const bobNoise = ownerPopulation('pin-unrelated-owner-collections', bob);
    const measuredResponseBytes: number[][] = [[], [], [], []];
    const measuredRequestBytes: number[][] = [[], [], [], []];
    const report = await checkGrowth(database!, {
      name: 'private pin ordinal pages and current curated/built-in headers',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      async grow(db, scale, previous) {
        await seed(db, aliceNoise, { from: previous, to: scale });
        await seed(db, bobNoise, { from: previous, to: scale });
      },
      async operation() {
        const paths: string[] = [];
        const readPage = async (query: string) => {
          const path = `/v1/libraryPins${query}`;
          paths.push(path);
          return page(await fixture!.request('alice', 'GET', path));
        };
        const first = await readPage('?limit=1');
        expect(first.pins).toHaveLength(1);
        expect(first.next).toBeString();
        const deep = await readPage(`?limit=1&cursor=${encodeURIComponent(first.next!)}`);
        expect(deep.pins).toHaveLength(1);
        expect(deep.next).toBeString();
        const terminal = await readPage(`?limit=1&cursor=${encodeURIComponent(deep.next!)}`);
        expect(terminal.pins).toHaveLength(1);
        expect(terminal.next).toBeNull();
        const maximum = await readPage('?limit=100');
        expect(maximum.pins.map((pin) => pin.collectionId)).toEqual([retainedTarget.id, everything!.id, liked!.id]);
        expect(maximum.pins[0]!.target).toMatchObject({ id: retainedTarget.id, membershipKind: 'curated' });
        expect(maximum.pins[1]!.target).toMatchObject({ id: everything!.id, builtinKind: 'everything' });
        expect(maximum.pins[2]!.target).toMatchObject({ id: liked!.id, builtinKind: 'liked' });
        const bytes = [first, deep, terminal, maximum].map((value) => Buffer.byteLength(JSON.stringify(value)));
        const requestBytes = paths.map((path) => Buffer.byteLength(`GET ${path}`));
        bytes.forEach((value, index) => measuredResponseBytes[index]!.push(value));
        requestBytes.forEach((value, index) => measuredRequestBytes[index]!.push(value));
        return { pageCounts: [first.pins.length, deep.pins.length, terminal.pins.length, maximum.pins.length], bytes };
      },
    });
    expect(report.samples).toHaveLength(3);
    expect(report.samples.every((sample) => sample.cost.plans > 0)).toBe(true);
    expect(report.samples.every((sample) => sample.seeding.rowsWritten > 0)).toBe(true);
    for (let index = 0; index < 4; index++) {
      expect(new Set(measuredResponseBytes[index]).size).toBe(1);
      expect(new Set(measuredRequestBytes[index]).size).toBe(1);
      expect(measuredResponseBytes[index]!.length).toBeGreaterThan(3);
    }
  } finally {
    await database?.close();
    await fixture?.close();
  }
}, 600_000);
