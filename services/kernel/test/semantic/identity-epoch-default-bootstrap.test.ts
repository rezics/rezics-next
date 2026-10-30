import { afterAll, expect, test } from 'bun:test';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
  queryCommunityDatabase,
} from '../community/community-driver.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';

afterAll(closeCommunityDrivers);

test('default Community worker closes every native home and then repairs real caller work within its default settle', async () => {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  await driver.settle();
  const closure = await queryCommunityDatabase<{ homes: number; custody: number; remaining: number }>(`
    SELECT
      (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_home h
       JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
            (h.partition_no,h.sealed_transaction_id,h.sealed_epoch,h.sealed_position)
       JOIN core.partition p ON p.partition_no=h.partition_no AND p.epoch=h.sealed_epoch
       WHERE c.purpose='bootstrap' AND p.write_state='active' AND p.position>=h.sealed_position
         AND NOT h.needs_work) homes,
      (SELECT count(*)::integer FROM semantic.identity_epoch_topology_custody) custody,
      (SELECT remaining FROM semantic.identity_epoch_bootstrap_topology WHERE partition_no=0) remaining
  `);
  expect(closure).toEqual([{ homes: 4096, custody: 4096, remaining: 0 }]);
  const { system } = communityFixtureRuntime();
  expect(await identityEpochStore.readMapping(system.database.pool, fixture.subject.id)).toMatchObject({
    state: 'mapped',
    original: fixture.subject.id,
    terminal: fixture.subject.id,
  });
  const changed = await driver.subjectCommand(
    'edit',
    fixture.subjectOwner,
    fixture.subject.id,
    '"native-bootstrap-edit"',
  );
  expect(changed.status).toBeLessThan(300);
  await driver.settle();
  const dirty = await queryCommunityDatabase<{ revision: string; captured_revision: string }>(
    'SELECT revision,captured_revision FROM semantic.identity_epoch_dirty WHERE original=$1',
    [fixture.subject.id],
  );
  expect(dirty).toHaveLength(1);
  expect(dirty[0]!.captured_revision).toBe(dirty[0]!.revision);
  expect(await identityEpochStore.readMapping(system.database.pool, fixture.subject.id)).toMatchObject({
    state: 'mapped',
    original: fixture.subject.id,
    terminal: fixture.subject.id,
  });
}, 180_000);

test('fresh native default startup does not sweep empty homes when no legacy identity source exists', async () => {
  // A new actual Community system clones the untouched migrated template. Neither this test nor
  // the driver installs legacy subjects, ready bits, mappings, receiving receipts or source ACKs.
  await closeCommunityDrivers();
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  await driver.settle();
  const closure = await queryCommunityDatabase<{ empty_home_exports: number; empty_home_custody: number }>(`
    SELECT
      (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_home h
       WHERE NOT EXISTS (SELECT 1 FROM semantic.subject s WHERE s.route / 16 = h.partition_no)
         AND NOT EXISTS (SELECT 1 FROM semantic.merge_member m WHERE m.route / 16 = h.partition_no)
      ) empty_home_exports,
      (SELECT count(*)::integer FROM semantic.identity_epoch_topology_custody c
       WHERE NOT EXISTS (SELECT 1 FROM semantic.subject s WHERE s.route / 16 = c.source_partition)
         AND NOT EXISTS (SELECT 1 FROM semantic.merge_member m WHERE m.route / 16 = c.source_partition)
      ) empty_home_custody
  `);
  expect(closure).toEqual([{ empty_home_exports: 0, empty_home_custody: 0 }]);
  const { system } = communityFixtureRuntime();
  expect(await identityEpochStore.readMapping(system.database.pool, fixture.subject.id)).toMatchObject({
    state: 'mapped',
    original: fixture.subject.id,
    terminal: fixture.subject.id,
  });
}, 180_000);
