import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

interface Work { work: string; mainVersion: string }
interface Composition { structure: string; revision: string; occurrences: string[] }
interface Page { parts?: Array<{ work: string }>; wholes?: Array<{ work: string }>;
  occurrences?: Array<{ target: string }>; items?: Array<{ relation: string }>; next: string | null }

test('G-829: every public resource/composition/Collection GET admits anonymous and ordinary readers; private inventories remain absent', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `g-829-${randomUUID()}`),
    'openid work:create work:edit work:read collection:edit semantic:read rating:configure');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  const content = new ContentCore(f.pool);
  f.access.configureBaseline(f.env.fuseki);
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier, access: f.access,
    structureObjects: objects, content, realmReplies: new RealmReplyStore(new RealmReplyContentStore(f.pool), content, f.access, f.env),
    reviews: new ReaderReviews(f.accessPool) });
  const call = (method: string, path: string, body?: object, token?: string) => app.handle(new Request(`http://main.local${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const body = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
    return JSON.parse(body) as T;
  };
  const write = <T>(path: string, body: object, status = 200) => call('POST', path,
    { ...body, actingSubject: f.actor }, f.account.tokenA).then(response => json<T>(response, status))
    .catch((error: unknown) => { throw new Error(`POST ${path}`, { cause: error }); });
  try {
    await objects.initialize();
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor, kind: 'person',
      displayName: 'Public composition author', digest: hash(f.actor) });
    const publicWorks: Work[] = [];
    for (let index = 0; index < 3; index++) {
      const work = await write<Work>('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
        title: `Public composition ${index}`, language: 'en', semanticTypes: ['https://schema.org/Book'] }, 201);
      await f.grant(`work:read:${work.work}`, 'work.read');
      await f.grant(`contribution:create:${work.work}`, 'contribution.create');
      const draft = await write<{ contribution: string; draftRevision: string }>('/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en', body: `Published composition ${index}` }, 201);
      await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
      await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
      const publication = await write<{ publicationDecision: string }>('/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public' }, 201);
      await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
      await write('/v1/publication-selections', { profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
        contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' }, 201);
      publicWorks.push(work);
    }
    const [series, part, later] = publicWorks as [Work, Work, Work];
    const privateWork = await write<Work>('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
      title: 'Private part', language: 'en', semanticTypes: ['https://schema.org/Book'] }, 201);
    const privateWhole = await write<Work>('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
      title: 'Private whole', language: 'en', semanticTypes: ['https://schema.org/Book'] }, 201);
    for (const work of [...publicWorks, privateWork, privateWhole]) {
      await f.grant(`work:edit:${work.work}`, 'work.edit');
      await f.grant(`work:read:${work.work}`, 'work.read');
    }
    const composition = await write<Composition>('/v1/compositions', {
      profile: 'work-composition', work: series.work, mainVersion: series.mainVersion }, 201);
    const changed = await write<Composition>(`/v1/compositions/${shortId(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision,
      operations: [privateWork, part, later, privateWork].map((work, index) => ({ op: 'insert',
        parent: composition.structure, position: 'last', role: 'part', target: work.work,
        displayLabel: index === 0 || index === 3 ? 'Secret part' : String(index), inclusion: 'required' })) });
    const privateComposition = await write<Composition>('/v1/compositions', {
      profile: 'work-composition', work: privateWhole.work, mainVersion: privateWhole.mainVersion }, 201);
    await write(`/v1/compositions/${shortId(privateComposition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: privateComposition.revision,
      operations: [{ op: 'insert', parent: privateComposition.structure, position: 'last',
        role: 'part', target: part.work, displayLabel: 'Secret whole', inclusion: 'required' }] });
    const sealed = await write<{ seal: string }>(`/v1/compositions/${shortId(composition.structure)}/seals`, {
      expectedHead: changed.revision });
    const collection = nativeId(), privateCollection = nativeId();
    let publicCollection!: Composition;
    for (const [id, disclosure] of [[collection, 'public'], [privateCollection, 'private']] as const) {
      await f.grant(`collection:edit:${id}`, 'collection.edit');
      await f.grant(`semantic:read:${id}`, 'semantic.read');
      const created = await write<Composition>('/v1/collections', { collection: id, name: 'Composition reading list',
        language: 'en', disclosure }, 201);
      const populated = await write<Composition>(`/v1/collections/${shortId(id)}/changes`, {
        expectedHead: created.revision, operations: [privateWork, part, later, privateWork].map(work => ({
          op: 'insert', parent: created.structure, position: 'last', role: 'member', target: work.work })) });
      if (disclosure === 'public') publicCollection = populated;
    }
    await f.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await write<{ context: string }>('/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Public fixture rating' }, 201);
    // Remove private grants after composing; public reads must not require any Work grant.
    await f.accessPool.query('DELETE FROM access.permission_grant WHERE recipient_subject=$1 AND action=$2', [f.actor, 'work.read']);
    const base = `/v1/resources/${shortId(series.work)}`;
    const structure = `/v1/compositions/${shortId(composition.structure)}`;
    const collectionPath = `/v1/collections/${shortId(collection)}`;
    const paths: Record<string, string> = {
      '/v1/resources/:resource/parts': `${base}/parts`,
      '/v1/resources/:resource/wholes': `/v1/resources/${shortId(part.work)}/wholes`,
      '/v1/resources/:resource/relations': `/v1/resources/${shortId(part.work)}/relations`,
      '/v1/resources/:resource/rating-contexts': `${base}/rating-contexts`,
      '/v1/resources/:resource/ratings': `${base}/ratings?context=${encodeURIComponent(context.context)}`,
      '/v1/resources/:resource/reviews': `${base}/reviews?context=${encodeURIComponent(context.context)}`,
      '/v1/resources/:resource/discussion': `${base}/discussion`,
      '/v1/resources/:resource/page': `${base}/page`,
      '/v1/resources/:resource/statements': `${base}/statements`,
      '/v1/compositions/:id': structure,
      '/v1/compositions/:id/revisions/:revision': `${structure}/revisions/${shortId(changed.revision)}`,
      '/v1/compositions/:id/occurrences/:occurrence': `${structure}/occurrences/${shortId(changed.occurrences[1]!)}`,
      '/v1/compositions/:id/seals/:seal': `${structure}/seals/${shortId(sealed.seal)}`,
      '/v1/collections/:id': collectionPath,
      '/v1/collections/:id/name': `${collectionPath}/name`,
      '/v1/collections/:id/revisions/:revision': `${collectionPath}/revisions/${shortId(publicCollection.revision)}`,
    };
    const personal = ['/v1/compositions/:id/stages/:stage', '/v1/compositions/:id/occurrences/:occurrence/progress'];
    const gets = app.routes.filter(route => route.method === 'GET'
      && /^\/v1\/(resources\/:resource\/|compositions\/|collections\/)/.test(route.path)).map(route => route.path);
    expect(gets.sort()).toEqual([...Object.keys(paths), ...personal].sort());
    const actor = nativeId(); // Ordinary reader has no representation or grants.
    const authenticatedPath = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(actor)}`;
    for (const [route, path] of Object.entries(paths)) {
      for (const token of [undefined, f.account.tokenB]) {
        // Collection names have no reader query; their public-only contract is unchanged.
        const requestPath = token && !route.endsWith('/name') ? authenticatedPath(path) : path;
        const response = await call('GET', requestPath, undefined, token);
        expect(response.status, `${route}: ${await response.clone().text()}`).toBe(200);
        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain(privateWork.work);
        expect(JSON.stringify(body)).not.toContain(privateCollection);
      }
    }
    for (const token of [undefined, f.account.tokenB]) {
      const get = (path: string) => call('GET', token ? authenticatedPath(path) : path, undefined, token);
      const first = await json<Page>(await get(`${base}/parts?limit=1`));
      expect(first.parts?.map(item => item.work)).toEqual([part.work]);
      expect(first.next).not.toBeNull();
      const last = await json<Page>(await get(`${base}/parts?limit=1&after=${encodeURIComponent(first.next!)}`));
      expect(last.parts?.map(item => item.work)).toEqual([later.work]);
      expect(last.next).toBeNull();
      const members = await json<Page>(await get(`${collectionPath}?limit=1`));
      expect(members.occurrences?.map(item => item.target)).toEqual([part.work]);
      const lastMember = await json<Page>(await get(`${collectionPath}?limit=1&after=${encodeURIComponent(members.next!)}`));
      expect(lastMember.occurrences?.map(item => item.target)).toEqual([later.work]);
      expect(lastMember.next).toBeNull();
      const wholes = await json<Page>(await get(`/v1/resources/${shortId(part.work)}/wholes?limit=1`));
      expect(wholes.wholes?.map(item => item.work)).toEqual([series.work]);
      expect(wholes.next).toBeNull();
      const relations = await json<Page>(await get(`/v1/resources/${shortId(part.work)}/relations?limit=1`));
      expect(relations.items?.map(item => item.relation)).toEqual([collection]);
      expect(relations.next).toBeNull();
      for (const suffix of ['parts', 'wholes', 'relations']) {
        const hidden = await get(`/v1/resources/${shortId(privateWork.work)}/${suffix}`);
        const absent = await get(`/v1/resources/${shortId(nativeId())}/${suffix}`);
        expect(hidden.status).toBe(404);
        expect(await hidden.json()).toEqual(await absent.json());
      }
      expect((await get(`/v1/resources/${shortId(privateWhole.work)}/parts`)).status).toBe(404);
      const hiddenComposition = await get(`/v1/compositions/${shortId(privateComposition.structure)}`);
      const absentComposition = await get(`/v1/compositions/${shortId(nativeId())}`);
      expect(hiddenComposition.status).toBe(404);
      expect(await hiddenComposition.json()).toEqual(await absentComposition.json());
      expect((await get(`/v1/collections/${shortId(privateCollection)}`)).status).toBe(404);
      expect((await get(`${structure}/occurrences/${shortId(changed.occurrences[0]!)}`)).status).toBe(404);
      for (const page of [first, last, members, lastMember, wholes, relations]) {
        expect(page).not.toHaveProperty('count');
        expect(page).not.toHaveProperty('placementCount');
        expect(page).not.toHaveProperty('cost');
        expect(JSON.stringify(page)).not.toContain('Secret part');
        expect(JSON.stringify(page)).not.toContain(changed.occurrences[0]!);
        expect(JSON.stringify(page)).not.toContain(changed.occurrences[3]!);
      }
    }
    for (const path of [`${base}/parts`, `${base}/wholes`, `${base}/relations`, structure, collectionPath]) {
      expect((await call('GET', authenticatedPath(path), undefined, f.account.noScope)).status).toBe(401);
      expect((await call('GET', path, undefined, f.account.tokenB)).status).toBe(400);
      expect((await call('GET', authenticatedPath(path), undefined, 'invalid-token')).status).toBe(401);
    }
  } finally { await f.close(); }
}, 240_000);
