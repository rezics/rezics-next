import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESETS }
  from '../../../services/main/src/modules/zone/presentation-format.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';

test('WIKI01/WIKI02/VIEW03/VIEW06/CTX01: two Zones mount one Collection without owning or disclosing it', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-wiki-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit owner:operate collection:edit semantic:read context:write');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor, kind: 'person',
      displayName: 'Wiki editor', digest: createHash('sha256').update(f.actor).digest('hex') });
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Shared wiki', capabilities: ['realm'], actingSubject: f.actor,
    }), 201);
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const curated = await f.json<{ structure: string; revision: string }>(await f.call('POST', '/v1/collections', {
      collection, name: 'Shared references', disclosure: 'public', actingSubject: f.actor,
    }), 201);
    const sharedWork = await f.json<{ work: string }>(await f.call('POST', '/v1/works', { language: 'en',
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Shared wiki member', actingSubject: f.actor }), 201);
    await f.grant(`work:read:${sharedWork.work}`, 'work.read');
    await f.json(await f.call('POST', `/v1/collections/${shortId(collection)}/changes`, {
      expectedHead: curated.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', role: 'member', parent: curated.structure,
        position: 'last', target: sharedWork.work, selection: { mode: 'follow-context' } }],
    }), 200);
    const secondSpace = await f.json<{ space: string; realm: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v2', handle: 'books', name: 'Second wiki', capabilities: ['realm'], actingSubject: f.actor,
    }), 201);
    const zoneIds = [nativeId(), nativeId()];
    const created: Array<{ zone: string; navigation: string; revision: string }> = [];
    for (const [index, zone] of zoneIds.entries()) {
      await f.grant(`zone:edit:${zone}`, 'zone.edit');
      await f.grant(`semantic:read:${zone}`, 'semantic.read');
      const result = await f.json<{ zone: string; navigation: string; revision: string }>(
        await f.call('POST', '/v1/zones', { zone, space: index === 0 ? space.space : secondSpace.space,
          disclosure: 'public', actingSubject: f.actor }), 201);
      created.push(result);
    }
    // CTX01 Zone clause: one shared Context has independent exact selections in each Zone.
    await f.grant('context:create:root', 'context.create');
    const sharedContext = await f.json<{ context: string; semanticRevision: string }>(await f.call(
      'POST', '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public',
        base: null, entries: [], actingSubject: f.actor }), 201);
    await f.grant(`context:change:${sharedContext.context}`, 'context.change');
    const laterContext = await f.json<{ semanticRevision: string }>(await f.call('POST',
      `/v1/contexts/${shortId(sharedContext.context)}/semantic-revisions`, {
        profile: 'context-v1', expectedSemanticHead: sharedContext.semanticRevision,
        base: null, entries: [], actingSubject: f.actor }), 201);
    for (const [index, zone] of created.entries()) {
      const path = `/v1/zones/${shortId(zone.zone)}/configuration`;
      const revision = index === 0 ? sharedContext.semanticRevision : laterContext.semanticRevision;
      const ownerHead = (await readZoneConfiguration(f.env, zone.zone)).revision;
      const selected = await f.json<{ revision: string }>(await f.call('PUT', path, {
        expectedHead: ownerHead, actingSubject: f.actor,
        defaultContext: { context: sharedContext.context, semanticRevision: revision },
      }), 200);
      const state = await readZoneConfiguration(f.env, zone.zone);
      expect(state.revision).toBe(selected.revision);
      expect(state.configuration.defaultContext).toEqual({ context: sharedContext.context,
        semanticRevision: revision });
      expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH <urn:rezics:graph:current> { <${zone.zone}> rv:defaultContext
          <${sharedContext.context}> ; rv:defaultContextRevision <${revision}> . } }`)).boolean).toBe(true);
    }
    const publicationZone = created[1]!;
    const publicationHead = (await readZoneConfiguration(f.env, publicationZone.zone)).revision;
    expect((await f.call('PUT', `/v1/zones/${shortId(publicationZone.zone)}/configuration`, {
      expectedHead: publicationHead, actingSubject: f.actor,
      presentation: 'https://rezics.com/definition/unvalidated-theme',
    })).status).toBe(400);
    const publication = { ...DEFAULT_ZONE_PRESENTATION, preset: 'serial' as const,
      tokens: ZONE_PRESETS.serial,
      modules: [{ id: 'featured', type: 'editorial-list' as const, title: 'Featured',
        source: { kind: 'collection' as const, collection } }] };
    const publicationWrite = await f.json<{ revision: string }>(await f.call('PUT',
      `/v1/zones/${shortId(publicationZone.zone)}/configuration`, {
        expectedHead: publicationHead, actingSubject: f.actor, presentation: publication,
      }), 200);
    const anonymous = createMainApp(f.env.fuseki, { environment: f.env,
      account: f.account.verifier, access: f.access });
    const presentationUrl = `http://main.local/v1/zones/${shortId(publicationZone.zone)}/presentation`;
    const publicResponse = await anonymous.handle(new Request(presentationUrl));
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('cache-control')).toBe('public, no-cache');
    const etag = publicResponse.headers.get('etag')!;
    expect(await publicResponse.json()).toMatchObject({ revision: publicationWrite.revision,
      presentation: publication, execution: { state: 'fallback', reason: 'none_approved' },
      moduleData: [{ id: 'featured', sources: [{ source: { kind: 'collection', collection },
        state: 'complete' }] }],
      cost: { graphReads: 1, objectReads: 2, maxModules: 24 } });
    expect((await anonymous.handle(new Request(presentationUrl,
      { headers: { 'if-none-match': etag } }))).status).toBe(304);
    const safeView = await anonymous.handle(new Request(presentationUrl + '?safe-theme=1',
      { headers: { 'if-none-match': etag } }));
    expect(safeView.status).toBe(200);
    expect(await safeView.json()).toMatchObject({ execution: { reason: 'safe_mode' },
      renderTokens: { accent: ZONE_PRESETS.clean.accent } });
    expect((await f.call('PUT', `/v1/zones/${shortId(publicationZone.zone)}/configuration`, {
      expectedHead: publicationWrite.revision, actingSubject: f.actor,
      official: {}, defaultRealm: secondSpace.realm,
    })).status).toBe(403);
    await f.grant(`zone:official:${publicationZone.zone}`, 'zone.official');
    const marked = await f.json<{ revision: string }>(await f.call('PUT',
      `/v1/zones/${shortId(publicationZone.zone)}/configuration`, {
        expectedHead: publicationWrite.revision, actingSubject: f.actor,
        official: {}, defaultRealm: secondSpace.realm,
      }), 200);
    expect(marked.revision).not.toBe(publicationWrite.revision);
    const officialPage = await (await anonymous.handle(new Request(
      'http://main.local/v1/zones?official=true'))).json() as {
      items: Array<{ zone: string; realm: string; routeSegment: string;
        address: { prefix: string; key: string; suffixSource: string } }>;
      cost: { graphReads: number; rows: number } };
    expect(officialPage.items).toContainEqual({ zone: publicationZone.zone,
      realm: secondSpace.realm, routeSegment: 'books',
      address: { prefix: '/z/', key: 'books', suffixSource: '' } });
    expect(officialPage.cost).toEqual({ graphReads: 1, rows: officialPage.items.length });
    expect(await (await anonymous.handle(new Request(
      'http://main.local/v1/addresses/resolve?scope=space&key=books'))).json()).toMatchObject({
      holder: secondSpace.space, capabilities: { zone: publicationZone.zone, realm: secondSpace.realm } });
    await f.grant(`zone:official:${created[0]!.zone}`, 'zone.official');
    expect((await f.call('PUT', `/v1/zones/${shortId(created[0]!.zone)}/configuration`, {
      expectedHead: (await readZoneConfiguration(f.env, created[0]!.zone)).revision,
      actingSubject: f.actor, official: {}, defaultRealm: secondSpace.realm,
    })).status).toBe(400);
    const mountBody = (zone: typeof created[number], presentation: string) => ({
      expectedHead: zone.revision, collection, routeSegment: 'shared', disclosure: 'public',
      presentation, actingSubject: f.actor,
    });
    const first = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/zones/${shortId(created[0]!.zone)}/mounts`, mountBody(created[0]!, 'https://rezics.com/definition/presentation-a')), 200);
    const second = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/zones/${shortId(created[1]!.zone)}/mounts`, mountBody(created[1]!, 'https://rezics.com/definition/presentation-b')), 200);
    expect(first.occurrences[0]).not.toBe(second.occurrences[0]);
    const readZone = async (zone: string) => f.json<{ mounts: Array<{ target: string;
      qualifier: { presentation: string } }> }>(await f.call('GET',
      `/v1/zones/${shortId(zone)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect((await readZone(created[0]!.zone)).mounts[0]).toMatchObject({ target: collection,
      qualifier: { presentation: 'https://rezics.com/definition/presentation-a' } });
    expect((await readZone(created[1]!.zone)).mounts[0]).toMatchObject({ target: collection,
      qualifier: { presentation: 'https://rezics.com/definition/presentation-b' } });
    const sharedRead = await f.json<{ occurrences: Array<{ target: string }> }>(await f.call('GET',
      `/v1/collections/${shortId(collection)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(sharedRead.occurrences.map(item => item.target)).toEqual([sharedWork.work]);
    const activeZoneHead = (await readZoneConfiguration(f.env, created[0]!.zone)).revision;
    expect((await f.call('POST', `/v1/zones/${shortId(created[0]!.zone)}/retirements`,
      { expectedHead: activeZoneHead, actingSubject: f.actor })).status).toBe(400);
    const removed = await f.json<{ revision: string }>(await f.call('DELETE',
      `/v1/zones/${shortId(created[0]!.zone)}/mounts/${shortId(first.occurrences[0]!)}`,
      { expectedHead: first.revision, actingSubject: f.actor }), 200);
    expect(removed.revision).not.toBe(first.revision);
    expect((await readZone(created[0]!.zone)).mounts).toEqual([]);
    expect((await readZone(created[1]!.zone)).mounts).toHaveLength(1);
    const configurationPath = `/v1/zones/${shortId(created[0]!.zone)}/configuration`;
    const configurationQuery = `actingSubject=${encodeURIComponent(f.actor)}`;
    const initial = await f.json<{ revision: string; configuration: { advanced?: string } }>(
      await f.call('GET', `${configurationPath}?${configurationQuery}`), 200);
    expect((await f.call('PUT', configurationPath, { expectedHead: initial.revision,
      actingSubject: f.actor, defaultRealm: secondSpace.realm })).status).toBe(400);
    const realmConfigured = await f.json<{ revision: string }>(await f.call('PUT', configurationPath, {
      expectedHead: initial.revision, actingSubject: f.actor, defaultRealm: space.realm,
    }), 200);
    const advancedBase64 = Buffer.from(JSON.stringify({ futureFeature: { retained: true } })).toString('base64');
    const configured = await f.json<{ revision: string }>(await f.call('PUT', configurationPath,
      { expectedHead: realmConfigured.revision, actingSubject: f.actor, advancedBase64,
        budget: { timeMs: 500, rows: 20 } }), 200);
    const edited = await f.json<{ revision: string }>(await f.call('PUT', configurationPath,
      { expectedHead: configured.revision, actingSubject: f.actor,
        presentation: publication }), 200);
    const preserved = await readZoneConfiguration(f.env, created[0]!.zone);
    expect(preserved.configuration.advanced).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preserved.advancedBase64).toBe(advancedBase64);
    expect(preserved.configuration.budget).toEqual({ timeMs: 500, rows: 20 });
    expect(preserved.configuration.defaultRealm).toBe(space.realm);
    expect(preserved.configuration.defaultContext?.context).toBe(sharedContext.context);
    expect((await readZoneConfiguration(f.env, created[1]!.zone)).configuration.defaultContext)
      .toEqual({ context: sharedContext.context, semanticRevision: laterContext.semanticRevision });
    expect((await f.call('PUT', configurationPath, { expectedHead: initial.revision,
      actingSubject: f.actor, presentation: publication })).status).toBe(409);
    const originalFuseki = f.env.fuseki;
    let lostRetire = false;
    f.env.fuseki = new Proxy(originalFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (!lostRetire && args[0].update.includes('ZoneRetireEvent')) {
          lostRetire = true;
          throw new Error('lost Zone retirement acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof originalFuseki;
    const retireKey = `zone-retire-${randomUUID()}`;
    const retired = await f.json<{ revision: string }>(await f.call('POST',
      `/v1/zones/${shortId(created[0]!.zone)}/retirements`,
      { expectedHead: edited.revision, actingSubject: f.actor }, retireKey), 200);
    f.env.fuseki = originalFuseki;
    expect(lostRetire).toBe(true);
    expect((await f.json<{ revision: string; replayed: boolean }>(await f.call('POST',
      `/v1/zones/${shortId(created[0]!.zone)}/retirements`,
      { expectedHead: edited.revision, actingSubject: f.actor }, retireKey), 200)))
      .toMatchObject({ revision: retired.revision, replayed: true });
    expect(retired.revision).not.toBe(edited.revision);
    expect((await f.call('GET', `/v1/zones/${shortId(created[0]!.zone)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`)).status).toBe(404);
    expect((await f.call('GET', `/v1/collections/${shortId(collection)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`)).status).toBe(200);
    expect((await f.env.fuseki.query(`PREFIX schema: <https://schema.org/> ASK {
      GRAPH <urn:rezics:graph:current> { <${sharedWork.work}> a schema:CreativeWork . } }`)).boolean)
      .toBe(true);
    expect((await f.call('GET', `/v1/spaces/${shortId(space.space)}`)).status).toBe(200);
    const recovered = await f.json<{ revision: string }>(await f.call('POST',
      `/v1/zones/${shortId(created[0]!.zone)}/recoveries`,
      { expectedHead: retired.revision, actingSubject: f.actor }), 200);
    expect(recovered.revision).not.toBe(retired.revision);
    expect((await readZone(created[0]!.zone)).mounts).toEqual([]);
    // Revoking Collection read authority suppresses its route in both Zones.
    await f.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'semantic.read'`,
    [f.actor, `semantic:read:${collection}`]);
    expect((await readZone(created[1]!.zone)).mounts).toEqual([]);
    expect((await f.call('GET', `/v1/zones/${shortId(created[1]!.zone)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`, undefined, randomUUID(), f.account.tokenB)).status)
      .toBe(404);
    expect(curated.structure).toBeTruthy();
    expect(space.realm).toBeTruthy();
  } finally { await f.close(); }
}, 180_000);
