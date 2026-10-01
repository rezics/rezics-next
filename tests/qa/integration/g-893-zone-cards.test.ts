import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import type { ZoneRoute } from '../../../services/main/src/modules/zone/route.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (iri: string) => iri.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
type Lists = { lists: Array<{ collection: string; items: Array<{ id: string; inZone: boolean }> }> };

test('G893: HTTP editorial and route indexes batch exact mounted/adopted membership and fence removals', async () => {
  const stack = await startMediaStack('g-893-zone-cards');
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const editor = await stack.member('g-893-editor');
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string; realm: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Card membership', capabilities: ['realm'], actingSubject: editor.actor,
    }), 201);
    const zone = id(), root = `/v1/zones/${short(zone)}`;
    await editor.grant(`zone:edit:${zone}`, 'zone.edit');
    await editor.grant(`semantic:read:${zone}`, 'semantic.read');
    const created = await json<{ revision: string }>(await editor.send('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: editor.actor,
    }), 201);
    const adopted = await stack.publicWork(editor.actor, ['en'], 'Adopted card');
    const mounted = await stack.publicWork(editor.actor, ['en'], 'Collection-only card');
    const outside = await stack.publicWork(editor.actor, ['en'], 'Outside card');
    for (const work of [adopted, mounted, outside]) await editor.grant(`work:read:${work.work}`, 'work.read');
    await editor.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
    const selection = await json<{ selection: string }>(await editor.send('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: space.realm },
      work: adopted.work, mainVersion: adopted.mainVersion, contribution: adopted.variants[0]!.contribution,
      publicationDecision: adopted.variants[0]!.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: editor.actor,
    }), 201);
    const collections = [];
    for (const name of ['Mounted picks', 'Unmounted picks']) {
      const collection = id();
      await editor.grant(`collection:edit:${collection}`, 'collection.edit');
      await editor.grant(`semantic:read:${collection}`, 'semantic.read');
      const created = await json<{ revision: string; structure: string }>(await editor.send('POST', '/v1/collections', {
        collection, name, disclosure: 'public', actingSubject: editor.actor,
      }), 201);
      const changed = await json<{ revision: string; occurrences: string[] }>(await editor.send('POST',
        `/v1/collections/${short(collection)}/changes`, { expectedHead: created.revision, actingSubject: editor.actor,
          operations: [adopted, mounted, outside].map(work => ({ op: 'insert', role: 'member',
            parent: created.structure, position: 'last', target: work.work, selection: { mode: 'follow-context' } })) }));
      collections.push({ collection, ...changed });
    }
    const mount = await json<{ revision: string; occurrences: string[] }>(await editor.send('POST', `${root}/mounts`, {
      expectedHead: created.revision, target: collections[0]!.collection, routeSegment: 'picks',
      disclosure: 'public', actingSubject: editor.actor,
    }));
    await json(await editor.send('PUT', `${root}/configuration`, {
      expectedHead: (await readZoneConfiguration(stack.env, zone)).revision, defaultRealm: space.realm,
      presentation: { ...DEFAULT_ZONE_PRESENTATION, modules: collections.map((item, index) => ({
        id: `picks-${index}`, type: 'editorial-list', title: 'Picks',
        source: { kind: 'collection', collection: item.collection } })) }, actingSubject: editor.actor,
    }));
    const routePath = (path: string) => `${root}/routes?${new URLSearchParams({ path })}`;
    const modulePath = `/v1/realms/${short(space.realm)}/modules/editor-lists`;
    const originalQuery = stack.fuseki.query;
    let batches: string[] = [];
    stack.fuseki.query = async (...args) => {
      if (args[0].includes('# Zone population batch')) batches.push(args[0]);
      return originalQuery.call(stack.fuseki, ...args);
    };
    const lists = await json<Lists>(await stack.call('GET', modulePath));
    expect(batches).toHaveLength(1);
    expect(lists.lists[0]!.items).toEqual([adopted, mounted, outside].map(work => ({
      id: work.work, inZone: true, title: expect.anything(), cover: expect.anything() })));
    expect(lists.lists[1]!.items.map(item => [item.id, item.inZone]))
      .toEqual([[adopted.work, true], [mounted.work, false], [outside.work, false]]);
    batches = [];
    const index = await json<ZoneRoute>(await stack.call('GET', routePath('/picks')));
    expect(index.kind).toBe('index');
    if (index.kind !== 'index') throw new Error('Expected index');
    expect(index.items.map(item => [item.id, item.inZone])).toEqual([adopted, mounted, outside]
      .map(work => [work.work, true]));
    expect(batches).toHaveLength(1);
    expect((await stack.call('GET', routePath(`/picks/${short(mounted.work)}`))).status).toBe(200);
    expect((await stack.call('GET', routePath(`/w/${short(mounted.work)}`))).status).toBe(404);
    expect((await stack.call('GET', routePath(`/w/${short(adopted.work)}`))).status).toBe(200);
    // A tombstoned membership cannot supply a card's mounted route.
    await json(await editor.send('POST', `/v1/collections/${short(collections[0]!.collection)}/changes`, {
      expectedHead: collections[0]!.revision, actingSubject: editor.actor,
      operations: [{ op: 'remove', occurrence: collections[0]!.occurrences[1]! }],
    }));
    const removedMember = await json<Lists>(await stack.call('GET', modulePath));
    expect(removedMember.lists[1]!.items.find(item => item.id === mounted.work)?.inZone).toBe(false);
    expect((await stack.call('GET', routePath(`/picks/${short(mounted.work)}`))).status).toBe(404);
    // A population change after its batch must discard and replay that page.
    await editor.grant(`publication:reject:${space.realm}`, 'publication.reject');
    let removed = false;
    batches = [];
    stack.fuseki.query = async (...args) => {
      const result = await originalQuery.call(stack.fuseki, ...args);
      if (args[0].includes('# Zone population batch')) {
        batches.push(args[0]);
        if (!removed) {
          removed = true;
          await json(await editor.send('POST', '/v1/publication-rejections', {
            profile: 'realm-local-rejection-v1', context: { kind: 'realm-local', id: space.realm },
            work: adopted.work, mainVersion: adopted.mainVersion, expectedSelectionHead: selection.selection,
            decisionBasis: 'realm-manager-review', reasonCode: 'not-approved', actingSubject: editor.actor,
          }), 201);
        }
      }
      return result;
    };
    const refreshed = await json<Lists>(await stack.call('GET', modulePath));
    expect(batches).toHaveLength(2);
    expect(refreshed.lists[0]!.items.find(item => item.id === adopted.work)?.inZone).toBe(true);
    expect(refreshed.lists[1]!.items.every(item => item.inZone === false)).toBe(true);
    expect((await stack.call('GET', routePath(`/w/${short(adopted.work)}`))).status).toBe(404);
    stack.fuseki.query = originalQuery;
    await json(await editor.send('DELETE', `${root}/mounts/${short(mount.occurrences[0]!)}`, {
      expectedHead: mount.revision, actingSubject: editor.actor,
    }));
    const unmounted = await json<Lists>(await stack.call('GET', modulePath));
    expect(unmounted.lists.flatMap(list => list.items).every(item => item.inZone === false)).toBe(true);
    expect((await stack.call('GET', routePath('/picks'))).status).toBe(404);
  } finally { await stack.stop(); }
}, 180_000);
