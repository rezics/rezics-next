import { afterAll, beforeAll, expect, test } from 'bun:test';
import { noEffect, runCommand } from '../../src/command/command.ts';
import {
  classifyEvent,
  ZONE_HISTORY_EVENT_TYPES,
  ZONE_HISTORY_RECEIPT_KINDS,
  type HistoryArtifactType,
} from '../../src/history/contracts.ts';
import { decodeLocator } from '../../src/history/locator.ts';
import { commandHistoryKind } from '../../src/history/record.ts';
import { HistoryRegistry, type HistoryArtifact, type HistoryBarrier } from '../../src/history/registry.ts';
import { registerZoneHistoryConsumers } from '../../src/history/zone-consumers.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createBody, resourceFixture, type ResourceFixture } from '../zones/resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('actual Zone command custody reaches the registered owners and waits for the terminal branch', async () => {
  await f.available();
  const body = createBody();
  body.configuration.scope = [];
  const zone = await f.create(body);
  const path = `/v1/zones/${zone.id}`;

  const configuration = structuredClone(body.configuration);
  configuration.labels.en = 'Private receipt payload';
  const configured = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration, mounts: [] },
    f.conditional(zone.revision),
  );
  expect(configured.status).toBe(200);
  const published = await f.call(
    'owner',
    'POST',
    `${path}:publish`,
    { visibility: 'unlisted' },
    f.conditional(configured.body.zone.revision),
  );
  expect(published.status).toBe(200);
  const deleted = await f.call('owner', 'DELETE', path, undefined, f.conditional(published.body.zone.revision));
  expect(deleted.status).toBe(200);
  const restored = await f.call('owner', 'POST', `${path}:restore`, {}, f.conditional(deleted.body.zone.revision));
  expect(restored.status).toBe(200);
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'moderation:takedown');
  const taken = await f.call(
    'operator',
    'POST',
    `${path}:takedown`,
    { pointers: ['/labels/en'] },
    f.conditional(restored.body.zone.revision),
  );
  expect(taken.status).toBe(200);
  const released = await f.call(
    'operator',
    'POST',
    `${path}:releaseTakedown`,
    { pointers: ['/labels/en'] },
    f.conditional(taken.body.zone.revision),
  );
  expect(released.status).toBe(200);

  const route = routeOf(zone.id)!;
  const partition = partitionOf(route);
  const sourceKey = JSON.stringify(['zone', zone.id]);
  const sources = await f.db.admin.query<{ artifact_type: HistoryArtifactType; locator: Buffer }>(
    `SELECT artifact_type,locator FROM core.record_history_locator
     WHERE partition_no=$1 AND source_key=$2 ORDER BY artifact_type,locator`,
    [partition, sourceKey],
  );
  expect(sources.rows).toHaveLength(14);

  const storedEvents = await f.events(zone.id);
  expect(storedEvents.map((event) => event.type).sort()).toEqual([...ZONE_HISTORY_EVENT_TYPES].sort());
  for (const event of storedEvents) {
    expect(Object.keys(event.data as object).sort()).toEqual(['id', 'revision']);
    expect(classifyEvent(event.type).kind).toBe('non-personal');
  }

  const registry = new HistoryRegistry();
  registerZoneHistoryConsumers({ history: registry });
  expect(registry.familyGaps('zones')).toEqual(['zones:durable-work/v1']);
  expect(registry.familyDefinitions().find((definition) => definition.family === 'zones')?.sources).toHaveLength(14);

  await f.tombstoneOwner();
  const barrierRow = (
    await f.db.admin.query<{ version: number; at: string }>(
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [route, f.accounts.owner],
    )
  ).rows[0]!;
  const barrier: HistoryBarrier = { accountId: f.accounts.owner, accountRoute: route, ...barrierRow };
  const artifacts: { owner: NonNullable<ReturnType<HistoryRegistry['owner']>>; artifact: HistoryArtifact }[] = [];
  for (const source of sources.rows) {
    const locator = decodeLocator(source.artifact_type, source.locator);
    let ownerName: string | undefined;
    if (locator.artifactType === 'command-receipt/v1') ownerName = commandHistoryKind(locator.commandKindId);
    else if (locator.artifactType === 'outbox-event/v1')
      ownerName = (
        await f.db.admin.query<{ type: string }>(
          'SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3',
          [partition, locator.position.toString(), locator.eventSeq],
        )
      ).rows[0]?.type;
    expect(ownerName).toBeDefined();
    const owner = registry.owner(source.artifact_type, ownerName!);
    expect(owner).toBeDefined();
    const accounts = (
      await f.db.admin.query<{ account_route: number; account_id: string; roles: number }>(
        `SELECT account_route,account_id,roles FROM core.history_locator
         WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3 ORDER BY account_route,account_id`,
        [partition, source.artifact_type, source.locator],
      )
    ).rows.map(({ account_route, account_id, roles }) => ({
      accountRoute: account_route,
      accountId: account_id,
      roles,
    }));
    artifacts.push({ owner: owner!, artifact: { partition, locator, accounts } });
  }
  expect(artifacts.map(({ owner }) => owner.name).sort()).toEqual(
    [...ZONE_HISTORY_EVENT_TYPES, ...ZONE_HISTORY_RECEIPT_KINDS].sort(),
  );

  const readiness = await runCommand(f.db.pool, { partition, deadline: Date.now() + 30_000 }, async (tx) => {
    const observations = [];
    for (const { owner, artifact } of artifacts) observations.push(await owner.readiness(tx, artifact, barrier));
    return noEffect(observations);
  });
  expect(readiness.value).toEqual(
    Array.from({ length: 14 }, () => ({ ready: false, gap: 'zone-history-terminal-account-branch-required' })),
  );
  expect((await f.raw(zone.id))?.configuration).not.toBeNull();
}, 180_000);
