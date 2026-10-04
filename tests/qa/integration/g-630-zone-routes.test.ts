import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { ZONE_RESERVED_SEGMENTS } from '../../../services/main/src/modules/zone/route-path.ts';
import type { ZoneRoute, ZoneNavigationItem } from '../../../services/main/src/modules/zone/route.ts';
import { zoneRoutes } from '../../../services/main/src/routes/zones.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { readResourceSummaries } from '../../../services/main/src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

test('G630: mounted Zone routes enforce current typed bindings, complete paging and population disclosure', async () => {
  const stack = await startMediaStack('g-630-routes', { profileCredits: true });
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const editor = await stack.member('zone-editor');
    const outsider = await stack.member('zone-outsider');
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string; realm: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Routed wiki', capabilities: ['realm'], actingSubject: editor.actor,
    }), 201);
    const zone = native();
    await editor.grant(`zone:edit:${zone}`, 'zone.edit');
    await editor.grant(`semantic:read:${zone}`, 'semantic.read');
    const created = await json<{ navigation: string; revision: string }>(await editor.send('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: editor.actor,
    }), 201);
    const root = `/v1/zones/${short(zone)}`;
    await json(await editor.send('PUT', `${root}/configuration`, {
      expectedHead: (await readZoneConfiguration(stack.env, zone)).revision,
      defaultRealm: space.realm, actingSubject: editor.actor,
    }));
    const collection = native();
    await editor.grant(`collection:edit:${collection}`, 'collection.edit');
    await editor.grant(`semantic:read:${collection}`, 'semantic.read');
    const curated = await json<{ structure: string; revision: string }>(await editor.send('POST', '/v1/collections', {
      collection, name: 'Picks', disclosure: 'public', actingSubject: editor.actor,
    }), 201);
    const works = [];
    for (let index = 1; index <= 25; index++) {
      const work = await stack.publicWork(editor.actor, ['en'], `Pick ${index}`);
      await editor.grant(`work:read:${work.work}`, 'work.read');
      works.push(work);
    }
    const hidden = await stack.privateWork(editor.actor, 'Private member');
    await editor.grant(`work:read:${hidden.work}`, 'work.read');
    const insert = (target: string) => ({ op: 'insert', role: 'member', parent: curated.structure,
      position: 'last', target, selection: { mode: 'follow-context' } });
    let collectionHead = curated.revision;
    const memberOccurrences: string[] = [];
    for (const target of [...works.map(item => item.work), hidden.work]) {
      const changed = await json<{ revision: string; occurrences: string[] }>(await editor.send('POST',
        `/v1/collections/${short(collection)}/changes`, { expectedHead: collectionHead, actingSubject: editor.actor,
          operations: [insert(target)] }));
      collectionHead = changed.revision;
      memberOccurrences.push(...changed.occurrences);
    }
    const nonMember = await stack.publicWork(editor.actor, ['en'], 'Outside the mounted population');
    await editor.grant(`work:read:${nonMember.work}`, 'work.read');
    await editor.grant('work:create:root', 'work.create');
    const guide = await json<{ work: string; mainVersion: string }>(await editor.send('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Guide', language: 'en',
      semanticTypes: ['https://schema.org/DigitalDocument'], actingSubject: editor.actor,
    }), 201);
    await editor.grant(`work:read:${guide.work}`, 'work.read');
    const contribution = await stack.contribution(guide.work, editor.actor, 'en', 'The wiki guide');
    await editor.grant(`publication:select:${guide.mainVersion}`, 'publication.select');
    await json(await editor.send('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: guide.mainVersion },
      work: guide.work, contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: editor.actor,
    }), 201);
    let head = created.revision;
    const mount = async (target: string, segment: string, disclosure: 'public' | 'private' = 'public',
      position: 'first' | 'last' = 'last', alias = false, key = randomUUID()) => {
      const body = { expectedHead: head, ...(alias ? { collection: target } : { target }),
        routeSegment: segment, disclosure, position, actingSubject: editor.actor };
      const result = await json<{ revision: string; occurrences: string[]; replayed: boolean }>(
        await editor.send('POST', `${root}/mounts`, body, key));
      head = result.revision;
      return { ...result, body, key };
    };
    const picks = await mount(collection, 'picks', 'public', 'last', true);
    const document = await mount(guide.work, 'guide', 'public', 'first');
    expect(await json(await editor.send('POST', `${root}/mounts`, document.body, document.key)))
      .toMatchObject({ revision: document.revision, replayed: true });
    const privateMount = await mount(collection, 'private-picks', 'private');
    await mount(hidden.work, 'private-guide');
    const routeUrl = (path: string, cursor?: string) => `${root}/routes?${new URLSearchParams({ path,
      ...(cursor ? { cursor } : {}) })}`;
    const get = (path: string, cursor?: string) => stack.call('GET', routeUrl(path, cursor));
    const missing = async (response: Response) => {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'route_missing' });
    };
    expect(await json(await get('/'))).toMatchObject({ kind: 'home', zone, realm: space.realm });
    const first = await json<ZoneRoute>(await get('/picks'));
    expect(first.kind).toBe('index');
    if (first.kind !== 'index') throw new Error('Index binding is missing');
    expect(first.items).toHaveLength(24);
    expect(first.items.map(item => item.id)).toEqual(works.slice(0, 24).map(item => item.work));
    expect(first.items[0]).toMatchObject({ id: works[0]!.work, title: { value: 'Pick 1' },
      tagline: null, chapterCount: null });
    expect(first.nextCursor).toBeString();
    const rest = await json<ZoneRoute>(await get('/picks', first.nextCursor!));
    expect(rest).toMatchObject({ kind: 'index', items: [{ id: works[24]!.work }], nextCursor: null });
    expect(rest.cost).toEqual(first.cost);
    expect(await json(await get(`/picks/${short(works[0]!.work)}`))).toMatchObject({ kind: 'detail',
      collection, resource: { id: works[0]!.work }, tab: null });
    expect(await json(await get(`/picks/${short(works[0]!.work)}/discussion`))).toMatchObject({ kind: 'detail', tab: 'discussion' });
    await missing(await get(`/picks/${short(nonMember.work)}`));
    await missing(await editor.read(routeUrl(`/picks/${short(nonMember.work)}`)));
    await missing(await get(`/picks/${short(hidden.work)}`));
    expect(await json(await editor.read(routeUrl(`/picks/${short(hidden.work)}`))))
      .toMatchObject({ kind: 'detail', resource: { id: hidden.work } });
    // Access grants remain identical; only the Account token's OAuth scope differs.
    const scopedMain = zoneRoutes(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async (request, scopes) => {
        if (scopes.includes('work:read') && request.headers.get('authorization') !== 'Bearer work-scope') {
          throw new AccountAssertionDenied('work:read OAuth scope is required');
        }
        return editor.principal;
      } } } as MainWorkDependencies);
    const scopedRead = (path: string, workScope: boolean) => scopedMain.handle(new Request(
      `http://main.local${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(editor.actor)}`,
      { headers: { authorization: `Bearer ${workScope ? 'work-scope' : 'semantic-only'}` } }));
    for (const path of [routeUrl(`/picks/${short(hidden.work)}`), routeUrl('/private-guide')]) {
      await missing(await scopedRead(path, false));
      expect((await scopedRead(path, true)).status).toBe(200);
    }
    for (const path of [root, `${root}/revisions/${short(head)}`]) {
      const denied = await json<{ mounts: Array<{ target?: string }> }>(await scopedRead(path, false));
      expect(denied.mounts.map(item => item.target)).not.toContain(hidden.work);
      expect(denied.mounts.map(item => item.target)).not.toContain(guide.work);
      expect(denied.mounts.map(item => item.target)).toContain(collection);
      const allowed = await json<{ mounts: Array<{ target?: string }> }>(await scopedRead(path, true));
      expect(allowed.mounts.map(item => item.target)).toContain(hidden.work);
      expect(allowed.mounts.map(item => item.target)).toContain(guide.work);
    }
    const scopedPresentation = await json<{ navigation: ZoneNavigationItem[] }>(
      await scopedRead(`${root}/presentation`, false));
    expect(scopedPresentation.navigation.map(item => item.target)).not.toContain(hidden.work);
    const allowedPresentation = await json<{ navigation: ZoneNavigationItem[] }>(
      await scopedRead(`${root}/presentation`, true));
    expect(allowedPresentation.navigation.map(item => item.target)).toContain(hidden.work);
    await missing(await outsider.read(routeUrl(`/picks/${short(hidden.work)}`)));
    await missing(await get('/private-picks'));
    expect(await json(await editor.read(routeUrl('/private-picks')))).toMatchObject({ kind: 'index' });
    await missing(await outsider.read(routeUrl('/private-picks')));
    expect(await json(await get('/guide'))).toMatchObject({ kind: 'document', resource: { id: guide.work,
      types: expect.arrayContaining(['https://schema.org/DigitalDocument']) } });
    await missing(await get(`/guide/${short(guide.work)}`));
    const presentation = await json<{ navigation: ZoneNavigationItem[] }>(await stack.call('GET', `${root}/presentation`));
    expect(presentation.navigation.map(item => [item.segment, item.kind, item.name.value]))
      .toEqual([['guide', 'document', 'Guide'], ['picks', 'index', 'Picks']]);
    expect(presentation.navigation.map(item => item.occurrence))
      .toEqual([document.occurrences[0]!, picks.occurrences[0]!]);
    // Commit an unrelated Work after the opening position probe. Every surface,
    // including a continuation, must discard its first attempt and retry.
    for (const path of [routeUrl('/picks'), routeUrl('/picks', first.nextCursor!), `${root}/presentation`]) {
      const query = stack.fuseki.query;
      let openingProbes = 0;
      stack.fuseki.query = async (...args) => {
        const result = await query.call(stack.fuseki, ...args);
        if (args[0].includes('SELECT ?sequence WHERE') && ++openingProbes === 1) {
          await stack.privateWork(editor.actor, 'Concurrent unrelated Work');
        }
        return result;
      };
      try {
        expect((await stack.call('GET', path)).status).toBe(200);
        expect(openingProbes).toBeGreaterThanOrEqual(3);
      } finally { stack.fuseki.query = query; }
    }
    const etag = (await stack.call('GET', `${root}/presentation`)).headers.get('etag');
    await json(await editor.send('PUT', `/v1/collections/${short(collection)}/name`, {
      profile: 'collection-public-name-v1', expectedHead: null, actingSubject: editor.actor,
      name: { original: 'en', labels: { en: 'Picks', fr: 'Choix' } },
    }), 201);
    const french = await stack.main.handle(new Request(`http://main.local${root}/presentation`, {
      headers: { 'accept-language': 'fr' } }));
    expect(french.headers.get('vary')).toContain('accept-language');
    expect(french.headers.get('etag')).not.toBe(etag);
    expect((await json<{ navigation: ZoneNavigationItem[] }>(french)).navigation[1]!.name)
      .toMatchObject({ value: 'Choix', language: 'fr' });
    for (const segment of [...ZONE_RESERVED_SEGMENTS, 'picks']) {
      const body = { expectedHead: head, target: collection, routeSegment: segment,
        disclosure: 'public', actingSubject: editor.actor };
      const key = randomUUID();
      for (let retry = 0; retry < 2; retry++) {
        expect(await json(await editor.send('POST', `${root}/mounts`, body, key), 409))
          .toMatchObject({ code: 'zone_route_conflict' });
      }
    }
    const raceBody = { expectedHead: head, target: collection, routeSegment: 'race',
      disclosure: 'public', actingSubject: editor.actor };
    const raceKeys = [randomUUID(), randomUUID()];
    const racing = await Promise.all(raceKeys.map(key => editor.send('POST', `${root}/mounts`, raceBody, key)));
    expect(racing.filter(response => response.status === 200)).toHaveLength(1);
    const winner = await json<{ revision: string; occurrences: string[] }>(racing.find(response => response.status === 200)!);
    const loserIndex = racing.findIndex(response => response.status !== 200);
    let loser = racing[loserIndex]!;
    expect([202, 409]).toContain(loser.status);
    // An in-flight admission may need reconciliation; its retry must keep the
    // original head and key so it cannot become a second successful mount.
    const raceDeadline = Date.now() + 60_000;
    let operationId: string | undefined;
    while (loser.status === 202) {
      const pending = await json<{ operationId: string; status: string; phase: string; result: null;
        retry: { allowed: boolean; afterMs: number } }>(loser, 202);
      expect(pending).toMatchObject({ status: 'reconciling', phase: 'work-edit', result: null,
        retry: { allowed: true } });
      expect(pending.operationId).toBeString();
      operationId ??= pending.operationId;
      expect(pending.operationId).toBe(operationId);
      expect(Number.isFinite(pending.retry.afterMs)).toBe(true);
      expect(pending.retry.afterMs).toBeGreaterThanOrEqual(0);
      if (Date.now() + pending.retry.afterMs >= raceDeadline) {
        throw new Error('Racing mount did not reconcile to a conflict within 60 seconds');
      }
      await Bun.sleep(pending.retry.afterMs);
      loser = await editor.send('POST', `${root}/mounts`, raceBody, raceKeys[loserIndex]!);
    }
    expect(await json(loser, 409)).toMatchObject({ code: 'zone_conflict' });
    expect(await json(await editor.read(root))).toMatchObject({ revision: winner.revision });
    head = (await json<{ revision: string }>(await editor.send('DELETE',
      `${root}/mounts/${short(winner.occurrences[0]!)}`, { expectedHead: winner.revision, actingSubject: editor.actor }))).revision;
    expect((await editor.send('POST', `${root}/mounts`, { expectedHead: head, target: guide.work,
      collection, routeSegment: 'mismatch', disclosure: 'public', actingSubject: editor.actor })).status).toBe(400);
    // A semantic grant cannot substitute for a Work read grant when mounting.
    await editor.grant(`semantic:read:${nonMember.work}`, 'semantic.read');
    await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2`, [editor.actor, `work:read:${nonMember.work}`]);
    expect((await editor.send('POST', `${root}/mounts`, { expectedHead: head, target: nonMember.work,
      routeSegment: 'unreadable', disclosure: 'public', actingSubject: editor.actor })).status).toBe(404);
    await missing(await get(`/w/${short(works[0]!.work)}`));
    await editor.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
    const adopted = await json<{ selection: string }>(await editor.send('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: space.realm },
      work: works[0]!.work, mainVersion: works[0]!.mainVersion,
      contribution: works[0]!.variants[0]!.contribution, publicationDecision: works[0]!.variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: editor.actor,
    }), 201);
    expect(await json(await get(`/w/${short(works[0]!.work)}/discussion`))).toMatchObject({ kind: 'detail', tab: 'discussion' });
    await missing(await get(`/w/${short(nonMember.work)}`));
    // Names, navigation and Realm publication writes do not change membership.
    expect(await json(await get('/picks', first.nextCursor!)))
      .toMatchObject({ kind: 'index', items: [{ id: works[24]!.work }], nextCursor: null });
    await editor.grant(`publication:reject:${space.realm}`, 'publication.reject');
    await json(await editor.send('POST', '/v1/publication-rejections', {
      profile: 'realm-local-rejection-v1', context: { kind: 'realm-local', id: space.realm },
      work: works[0]!.work, mainVersion: works[0]!.mainVersion, expectedSelectionHead: adopted.selection,
      decisionBasis: 'realm-manager-review', reasonCode: 'not-approved', actingSubject: editor.actor,
    }), 201);
    await missing(await get(`/w/${short(works[0]!.work)}`));
    // Removing a member changes detail membership without deleting the Work.
    await json(await editor.send('POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: collectionHead, actingSubject: editor.actor,
      operations: [{ op: 'remove', occurrence: memberOccurrences[0]! }],
    }));
    await missing(await get(`/picks/${short(works[0]!.work)}`));
    expect((await get('/picks', first.nextCursor!)).status).toBe(409);
    // Removing a route preserves the mounted Collection and all remaining members.
    const removed = await json<{ revision: string }>(await editor.send('DELETE',
      `${root}/mounts/${short(picks.occurrences[0]!)}`, { expectedHead: head, actingSubject: editor.actor }));
    head = removed.revision;
    await missing(await get('/picks'));
    await missing(await get(`/picks/${short(works[1]!.work)}`));
    expect((await editor.read(`/v1/collections/${short(collection)}`)).status).toBe(200);
    expect((await stack.call('GET', `${root}/presentation`)).headers.get('etag')).not.toBe(etag);
    await mount(collection, 'picks');
    expect(await json(await get('/picks'))).toMatchObject({ kind: 'index' });
    // A private target stays unavailable despite its public mount until Access admits it.
    const privateCollection = native();
    await editor.grant(`collection:edit:${privateCollection}`, 'collection.edit');
    await editor.grant(`semantic:read:${privateCollection}`, 'semantic.read');
    await json(await editor.send('POST', '/v1/collections', { collection: privateCollection,
      name: 'Private target', disclosure: 'private', actingSubject: editor.actor }), 201);
    await mount(privateCollection, 'restricted');
    await missing(await get('/restricted'));
    expect(await json(await editor.read(routeUrl('/restricted')))).toMatchObject({ kind: 'index', items: [] });
    await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id IN ($2, $3)`,
    [editor.actor, `semantic:read:${privateCollection}`, `work:read:${hidden.work}`]);
    await missing(await editor.read(routeUrl('/restricted')));
    await missing(await editor.read(routeUrl(`/picks/${short(hidden.work)}`)));
    await missing(await get('/unknown'));
    expect(privateMount.occurrences).toHaveLength(1);
    // Exercise the common summary query on real RDF for both Work references
    // and their MainVersions; OAuth/Access cannot override protected or erased heads.
    const summaries = (work: { work: string; mainVersion: string }, granted = false) =>
      readResourceSummaries(stack.env, undefined, granted ? { canReadWork: async () => true } : {},
        { resources: [work.work, work.mainVersion], context: DEFAULT_MEDIA_CONTEXT, language: null });
    const protectedWork = await stack.publicWork(editor.actor, ['en'], 'Protected summary');
    expect((await summaries(protectedWork)).summaries.every(item => item.status === 'available')).toBe(true);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(protectedWork.work)} <${RV}protectionHead> ${iri(native())} } }`);
    expect((await summaries(protectedWork, true)).summaries.map(item => item.status))
      .toEqual(['unavailable', 'unavailable']);
    const erasedWork = await stack.publicWork(editor.actor, ['en'], 'Erased summary');
    expect((await summaries(erasedWork)).summaries.every(item => item.status === 'available')).toBe(true);
    await stack.fuseki.update(`INSERT { GRAPH ${iri(GRAPHS.revisions)} { ?head a <${RV}ErasedRevision> } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(erasedWork.work)} <${RV}head> ?head } }`);
    expect((await summaries(erasedWork, true)).summaries.map(item => item.status))
      .toEqual(['unavailable', 'unavailable']);
    const superseded = await stack.publicWork(editor.actor, ['en'], 'Earlier public selection');
    expect((await summaries(superseded)).summaries.every(item => item.status === 'available')).toBe(true);
    const privateDecision = native();
    await stack.fuseki.update(`DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(superseded.variants[0]!.contribution)} <${RV}publicationHead> ?old } }
      INSERT { GRAPH ${iri(GRAPHS.current)} {
        ${iri(superseded.variants[0]!.contribution)} <${RV}publicationHead> ${iri(privateDecision)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(privateDecision)} a <${RV}PublicationDecision> ;
          <${RV}disclosure> <${RV}Private> } }
      WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(superseded.variants[0]!.contribution)} <${RV}publicationHead> ?old } }`);
    expect((await summaries(superseded)).summaries.map(item => item.status)).toEqual(['unavailable', 'unavailable']);
    expect((await summaries(superseded, true)).summaries.map(item =>
      item.status === 'available' ? item.disclosure : item.status)).toEqual(['restricted', 'restricted']);
  } finally { await stack.stop(); }
}, 300_000);
