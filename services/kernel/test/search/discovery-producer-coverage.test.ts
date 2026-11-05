import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import {
  assertDiscoveryProducerCoverage,
  SECOND_SCOPE_PUBLIC_METADATA_KINDS,
  type DiscoveryProducerRegistration,
} from '../../src/search/generations.ts';

test('bundled discovery definitions have native producers for every discoverable kind', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('producer coverage must not open a connection');
    },
  } as unknown as Pool;
  const routeKey = new Uint8Array(32);
  const producers = createDiscoveryProducerEntry({
    pool,
    routeKey,
    access: {} as never,
    reviewSource: {} as never,
  });
  const owners = { ...producers.ownerAdapters, metadataProducers: producers.metadataProducers };
  const registry = await nativeDiscoveryRegistry(pool, routeKey, producers.subjects, {
    release: bundledRelease,
    ownerAdapters: owners,
    accounts: producers.accounts,
  });
  const registrations: DiscoveryProducerRegistration[] = [
    ...registry.entries.map(({ kind, owner }) => ({ kind, owner })),
    ...SECOND_SCOPE_PUBLIC_METADATA_KINDS.flatMap((kind) => {
      const slot = owners[kind];
      return slot.readiness === 'ready' ? [{ kind, owner: slot.adapter.owner }] : [];
    }),
  ];
  const definitionKinds = Object.keys(bundledRelease.types);
  const producerKinds = ['account', 'subject', ...Object.keys(owners.metadataProducers)];

  expect(Object.keys(owners.metadataProducers).sort()).toEqual([...SECOND_SCOPE_PUBLIC_METADATA_KINDS].sort());
  expect(() =>
    assertDiscoveryProducerCoverage(
      registrations,
      [...definitionKinds, ...SECOND_SCOPE_PUBLIC_METADATA_KINDS],
      producerKinds,
    ),
  ).not.toThrow();
  expect(connections).toBe(0);
});
