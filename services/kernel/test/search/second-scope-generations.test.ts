import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  allocateDiscovery,
  assertDiscoveryProducerCoverage,
  DiscoveryProducerCoverageError,
  SECOND_SCOPE_PUBLIC_METADATA_KINDS,
} from '../../src/search/generations.ts';
import type { DiscoveryRegistry } from '../../src/search/discovery.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createDefaultDiscoveryOwnerAdapters } from '../../src/search/default-discovery.ts';

test('a generation with missing public metadata producers is rejected before allocation', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('incomplete producer coverage reached allocation I/O');
    },
  } as unknown as Pool;
  const registry = {
    entries: [
      { kind: 'account', owner: 'accounts' },
      { kind: 'subject', owner: 'semantic' },
    ],
  } as unknown as DiscoveryRegistry;

  await expect(allocateDiscovery(pool, 'search', registry, SECOND_SCOPE_PUBLIC_METADATA_KINDS)).rejects.toMatchObject({
    missingKinds: [...SECOND_SCOPE_PUBLIC_METADATA_KINDS],
    unsupportedKinds: [],
    duplicateKinds: [],
  });
  expect(connections).toBe(0);
});

test('a registered kind from an owner without a generation producer remains explicitly unready', () => {
  let error: unknown;
  try {
    assertDiscoveryProducerCoverage(
      [
        { kind: 'account', owner: 'accounts' },
        { kind: 'subject', owner: 'semantic' },
        { kind: 'collection', owner: 'commerce' },
        { kind: 'review', owner: 'content' },
        { kind: 'space', owner: 'content' },
      ],
      SECOND_SCOPE_PUBLIC_METADATA_KINDS,
    );
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(DiscoveryProducerCoverageError);
  expect(error).toMatchObject({ missingKinds: [], unsupportedKinds: ['collection', 'review', 'space'] });
});

test('default native owner readers register through the canonical slots without certifying population', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('owner reader binding reached allocation I/O');
    },
  } as unknown as Pool;
  const routeKey = new Uint8Array(32);
  const ownerAdapters = createDefaultDiscoveryOwnerAdapters({
    pool,
    routeKey,
    access: {} as never,
    keys: {} as never,
    reviewSource: {} as never,
  });
  const registry = await nativeDiscoveryRegistry(pool, routeKey, {} as never, {
    release: { types: {} } as never,
    ownerAdapters,
  });

  expect(registry.getOwnerAdapter('collection').owner).toBe('commerce');
  expect(registry.getOwnerAdapter('review').owner).toBe('content');
  expect(registry.getOwnerAdapter('space').owner).toBe('content');
  await expect(allocateDiscovery(pool, 'search', registry, SECOND_SCOPE_PUBLIC_METADATA_KINDS)).rejects.toBeInstanceOf(
    DiscoveryProducerCoverageError,
  );
  expect(connections).toBe(0);
});
