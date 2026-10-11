import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';

test('zone navigation move keeps mount metadata and refuses a stale head', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-navigation-move-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit owner:operate collection:edit semantic:read');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor, kind: 'person',
      displayName: 'Navigation editor', digest: createHash('sha256').update(f.actor).digest('hex') });
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Move navigation', capabilities: ['realm'], actingSubject: f.actor,
    }), 201);
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    await f.json(await f.call('POST', '/v1/collections', {
      collection, name: 'Mounted pages', disclosure: 'public', actingSubject: f.actor,
    }), 201);
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    const created = await f.json<{ zone: string; navigation: string; revision: string }>(
      await f.call('POST', '/v1/zones', {
        zone, space: space.space, disclosure: 'public', actingSubject: f.actor,
      }), 201);
    const presentationA = 'https://rezics.com/definition/presentation-a';
    const presentationB = 'https://rezics.com/definition/presentation-b';
    const first = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/zones/${shortId(zone)}/mounts`, {
        expectedHead: created.revision, target: collection, routeSegment: 'charts',
        disclosure: 'private', key: 'alias', presentation: presentationA, actingSubject: f.actor,
      }), 200);
    const second = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/zones/${shortId(zone)}/mounts`, {
        expectedHead: first.revision, target: collection, routeSegment: 'tides',
        disclosure: 'public', key: 'id', presentation: presentationB, actingSubject: f.actor,
      }), 200);
    const before = await f.json<{ revision: string; mounts: Array<{
      occurrence: string;
      qualifier: { routeSegment: string; disclosure: string; key?: string; presentation?: string };
    }> }>(await f.call('GET',
      `/v1/zones/${shortId(zone)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(before.mounts.map(mount => mount.occurrence)).toEqual([first.occurrences[0], second.occurrences[0]]);
    expect(before.mounts[0]?.qualifier).toMatchObject({
      routeSegment: 'charts', disclosure: 'private', key: 'alias', presentation: presentationA,
    });
    expect(before.mounts[1]?.qualifier).toMatchObject({
      routeSegment: 'tides', disclosure: 'public', key: 'id', presentation: presentationB,
    });

    const moved = await f.json<{ revision: string }>(await f.call('POST',
      `/v1/compositions/${shortId(created.navigation)}/changes`, {
        profile: 'zone-navigation',
        expectedHead: second.revision,
        actingSubject: f.actor,
        operations: [{
          op: 'move',
          occurrence: second.occurrences[0],
          parent: created.navigation,
          position: 'first',
        }],
      }), 200);
    expect(moved.revision).not.toBe(second.revision);

    const after = await f.json<{ revision: string; mounts: Array<{
      occurrence: string;
      qualifier: { routeSegment: string; disclosure: string; key?: string; presentation?: string };
    }> }>(await f.call('GET',
      `/v1/zones/${shortId(zone)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(after.revision).toBe(moved.revision);
    expect(after.mounts.map(mount => mount.occurrence)).toEqual([second.occurrences[0], first.occurrences[0]]);
    expect(after.mounts[0]?.qualifier).toMatchObject({
      routeSegment: 'tides', disclosure: 'public', key: 'id', presentation: presentationB,
    });
    expect(after.mounts[1]?.qualifier).toMatchObject({
      routeSegment: 'charts', disclosure: 'private', key: 'alias', presentation: presentationA,
    });

    const stale = await f.call('POST', `/v1/compositions/${shortId(created.navigation)}/changes`, {
      profile: 'zone-navigation',
      expectedHead: second.revision,
      actingSubject: f.actor,
      operations: [{
        op: 'move',
        occurrence: first.occurrences[0],
        parent: created.navigation,
        position: 'first',
      }],
    });
    expect(stale.status).toBe(409);
    const problem = await stale.json() as { code?: string };
    expect(problem.code).toBe('stale_composition_head');
    const unchanged = await f.json<{ revision: string; mounts: Array<{ occurrence: string }> }>(await f.call('GET',
      `/v1/zones/${shortId(zone)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(unchanged.revision).toBe(moved.revision);
    expect(unchanged.mounts.map(mount => mount.occurrence)).toEqual([second.occurrences[0], first.occurrences[0]]);
  } finally {
    await f.close();
  }
}, 180_000);
