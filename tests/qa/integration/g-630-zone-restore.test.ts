import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { structureProfileFor } from '../../../services/main/src/modules/structure/profiles.ts';
import { GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('G630/G830: Zone navigation restores retain mounts and seal duplicate/reserved candidate rejections', async () => {
  const stack = await startMediaStack('g-630-zone-restore');
  const profile = structureProfileFor('zone-navigation'), validate = profile.qualifierValidations!;
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const editor = await stack.member('zone-restore-editor');
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Restored Zone', capabilities: ['realm'], actingSubject: editor.actor,
    }), 201);
    const collection = id(), zone = id();
    await editor.grant(`collection:edit:${collection}`, 'collection.edit');
    await editor.grant(`semantic:read:${collection}`, 'semantic.read');
    await json(await editor.send('POST', '/v1/collections', {
      collection, name: 'Retained target', disclosure: 'public', actingSubject: editor.actor,
    }), 201);
    await editor.grant(`zone:edit:${zone}`, 'zone.edit');
    await editor.grant(`semantic:read:${zone}`, 'semantic.read');
    const root = `/v1/zones/${short(zone)}`;
    const created = await json<{ navigation: string; revision: string }>(await editor.send('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: editor.actor,
    }), 201);
    let head = created.revision;
    const occurrences: string[] = [];
    for (const segment of ['picks', 'guide']) {
      const mounted = await json<{ revision: string; occurrences: string[] }>(await editor.send('POST', `${root}/mounts`, {
        expectedHead: head, target: collection, routeSegment: segment, disclosure: 'public', actingSubject: editor.actor,
      }));
      head = mounted.revision;
      occurrences.push(...mounted.occurrences);
    }
    const retained = head, live = (await readCompositionHeader(stack.env, created.navigation))!;
    const path = `/v1/compositions/${short(created.navigation)}/restorations`;
    const body = { expectedHead: head, restoredFrom: retained, actingSubject: editor.actor }, key = randomUUID();
    const restored = await json<{ revision: string }>(await editor.send('POST', path, body, key));
    head = restored.revision;
    expect((await readCompositionHeader(stack.env, created.navigation))!.generation).not.toBe(live.generation);
    expect(await json(await editor.send('POST', path, body, key))).toMatchObject({ revision: head, replayed: true });
    const mounts = await json<{ mounts: Array<{ occurrence: string; target: string }> }>(await editor.read(root));
    expect(mounts.mounts.map(mount => mount.occurrence)).toEqual(occurrences);
    expect(mounts.mounts.map(mount => mount.target)).toEqual([collection, collection]);
    const removed = await json<{ revision: string }>(await editor.send('DELETE', `${root}/mounts/${short(occurrences[1]!)}`, {
      expectedHead: head, actingSubject: editor.actor,
    }));
    head = (await json<{ revision: string }>(await editor.send('POST', path, {
      expectedHead: removed.revision, restoredFrom: retained, actingSubject: editor.actor,
    }))).revision;
    expect((await json<{ mounts: Array<{ occurrence: string }> }>(await editor.read(root))).mounts
      .map(mount => mount.occurrence)).toEqual(occurrences);
    expect((await editor.read(`/v1/collections/${short(collection)}`)).status).toBe(200);

    // Inject an invalid complete candidate at the owner boundary, leaving the
    // changed projection batch valid. The real Zone validator must reject it.
    for (const invalid of ['duplicate', 'reserved']) {
      let validations = 0;
      profile.qualifierValidations = async (env, changed, context) => {
        validations++;
        expect(context?.replacement).toBe(true);
        const first = context!.placements![0]!;
        if (first.qualifier?.type !== 'zone-mount') throw new Error('Expected candidate mount');
        return validate(env, changed, { ...context!, placements: [...context!.placements!,
          { ...first, occurrence: id(), placement: id(), qualifier: { ...first.qualifier,
            routeSegment: invalid === 'duplicate' ? first.qualifier.routeSegment : 'browse' } }] });
      };
      const rejectionKey = randomUUID(), rejection = { expectedHead: head, restoredFrom: retained, actingSubject: editor.actor };
      for (let retry = 0; retry < 2; retry++) expect((await editor.send('POST', path, rejection, rejectionKey)).status).toBe(409);
      expect(validations).toBe(1);
      expect((await readCompositionHeader(stack.env, created.navigation))!.head).toBe(head);
    }
    const receipts = await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:action "composition.restore" ; rv:reason rv:TopologyConflict ;
        rv:admittedScope ${lit(`zone:edit:${zone}`)} } }`);
    expect(receipts.results?.bindings).toHaveLength(2);
  } finally { profile.qualifierValidations = validate; await stack.stop(); }
}, 180_000);
