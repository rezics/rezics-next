import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { startMediaStack } from './media-support.ts';
import type { CollectionWork } from '../../../services/main/src/modules/collection/grain.ts';
import type { ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (ref: string) => ref.slice(-36);
interface Composition { structure: string; revision: string; occurrences?: string[] }
interface Page { grain: string; items: CollectionWork[]; nextCursor: string | null }
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('G-892: SAO Collection selects series or volumes, traverses all cursors and never discloses releases/private members', async () => {
  const f = await startMediaStack('g-892');
  const objects = f.objects('semantic/structure/');
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const editor = await f.member('catalogue-editor');
    const outsider = await f.member('outsider');
    const specification = parse(await Bun.file('tests/fixtures/catalogue/franchises.yaml').text()) as {
      SAO: { works: Array<[string, string, string]> } };
    const entries = specification.SAO.works.filter(([key]) => ['sao.web', 'sao.bunko', 'sao.progressive', 'sao.aggo'].includes(key));
    expect(entries).toHaveLength(4);
    const series = [], volumes: CollectionWork[] = [];
    const createComposition = async (work: CollectionWork) => {
      await editor.grant(`work:edit:${work.work}`, 'work.edit');
      await editor.grant(`work:read:${work.work}`, 'work.read');
      return json<Composition>(await editor.send('POST', '/v1/compositions', {
        profile: 'work-composition', work: work.work, mainVersion: work.mainVersion,
        actingSubject: editor.actor }), 201);
    };
    // Volume identities exercise the grain contract; this specification does not
    // yet enumerate SAO's factual volume catalogue. The web's arcs remain occurrences.
    for (const [key, title] of entries) {
      const work = await f.publicWork(editor.actor, ['ja'], title);
      series.push(work);
      if (key === 'sao.web') { await editor.grant(`work:read:${work.work}`, 'work.read'); continue; }
      const composition = await createComposition(work);
      const parts = [];
      for (let index = 1; index <= 2; index++) {
        const volume = await f.publicWork(editor.actor, ['ja'], `${title} ${index}`);
        volumes.push({ work: volume.work, mainVersion: volume.mainVersion });
        await editor.grant(`work:read:${volume.work}`, 'work.read');
        parts.push({ op: 'insert', parent: composition.structure, position: 'last', role: 'part',
          target: volume.work, displayLabel: String(index), inclusion: 'required' });
      }
      await json(await editor.send('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor, operations: parts }));
    }
    const hidden = await f.privateWork(editor.actor, 'Private member');
    const hiddenComposition = await createComposition(hidden);
    // A public volume reached solely through a private series must also stay out.
    const hiddenChild = await f.publicWork(editor.actor, ['ja'], 'Volume behind private member');
    await editor.grant(`work:read:${hiddenChild.work}`, 'work.read');
    await json(await editor.send('POST', `/v1/compositions/${short(hiddenComposition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: hiddenComposition.revision, actingSubject: editor.actor,
      operations: [{ op: 'insert', parent: hiddenComposition.structure, position: 'last', role: 'part',
        target: hiddenChild.work, displayLabel: '1', inclusion: 'required' }] }));
    const release = id(), bunko = series[1]!;
    await json(await editor.send('PUT', `/v1/works/${short(bunko.work)}/releases/${short(release)}`, {
      profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: release, kind: 'formal', status: 'official',
      contentLanguages: ['en'], isTranslation: true, originalLanguages: ['ja'], titleLanguage: 'en', tracklistLanguage: null,
      title: { value: 'Sword Art Online English paperback', language: 'en' }, editionStatement: null,
      publisher: 'Yen Press', publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null,
      coverage: null, evidence: null }));
    const collection = id();
    await editor.grant(`collection:edit:${collection}`, 'collection.edit');
    await editor.grant(`semantic:read:${collection}`, 'semantic.read');
    let membership = await json<Composition>(await editor.send('POST', '/v1/collections', {
      collection, name: 'Sword Art Online franchise', disclosure: 'public', actingSubject: editor.actor }), 201);
    const path = `/v1/collections/${short(collection)}`;
    membership = await json<Composition>(await editor.send('POST', `${path}/changes`, {
      expectedHead: membership.revision, actingSubject: editor.actor,
      operations: [hidden.work, ...series.map(work => work.work), bunko.work, release, hidden.work].map(target => ({
        op: 'insert', parent: membership.structure, position: 'last', role: 'member', target })) }));
    const page = (grain: string, suffix = '') => editor.read(`${path}/works?grain=${grain}${suffix}`);
    const traverse = async (grain: string) => {
      const items: CollectionWork[] = [];
      let cursor: string | null = null;
      do {
        const result: Page = await json(await page(grain, `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        expect(result.grain).toBe(grain);
        expect(result.items).toHaveLength(1);
        expect(result).not.toHaveProperty('count');
        expect(JSON.stringify(result)).not.toContain(hidden.work);
        expect(JSON.stringify(result)).not.toContain(hiddenChild.work);
        expect(JSON.stringify(result)).not.toContain(release);
        items.push(...result.items); cursor = result.nextCursor;
        expect(items.length).toBeLessThanOrEqual(10);
      } while (cursor);
      return items;
    };
    expect(await traverse('series')).toEqual(series.map(({ work, mainVersion }) => ({ work, mainVersion }))
      .sort((a, b) => a.work.localeCompare(b.work)));
    expect(await traverse('parts')).toEqual([...volumes].sort((a, b) => a.work.localeCompare(b.work)));
    for (const read of [f.call.bind(null, 'GET'), outsider.read]) {
      expect((await json<Page>(await read(`${path}/works?grain=series`))).items).toHaveLength(4);
      expect((await json<Page>(await read(`${path}/works?grain=parts`))).items).toHaveLength(6);
    }
    const privateCollection = id();
    await editor.grant(`collection:edit:${privateCollection}`, 'collection.edit');
    await editor.grant(`semantic:read:${privateCollection}`, 'semantic.read');
    await json(await editor.send('POST', '/v1/collections', { collection: privateCollection,
      name: 'Private franchise', disclosure: 'private', actingSubject: editor.actor }), 201);
    for (const read of [f.call.bind(null, 'GET'), outsider.read]) {
      const denied = await read(`/v1/collections/${short(privateCollection)}/works?grain=series`);
      const absent = await read(`/v1/collections/${short(id())}/works?grain=series`);
      expect(denied.status).toBe(404);
      expect(await denied.text()).toBe(await absent.text());
    }
    const first = await json<Page>(await page('series', '&limit=1'));
    expect((await page('parts', `&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
    expect((await editor.read(`${path}/works`)).status).toBe(400);
    expect((await page('volumes')).status).toBe(400);
    // A member edit moves the graph basis; a stale cursor must fail explicitly.
    await json(await editor.send('POST', `${path}/changes`, { expectedHead: membership.revision,
      actingSubject: editor.actor, operations: [{ op: 'remove', occurrence: membership.occurrences![0] }] }));
    expect((await page('series', `&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(409);
    // Protection suppresses both the series and its public volumes.
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(bunko.work)} rv:protectionHead ${iri(id())} } }`);
    expect((await json<Page>(await page('series'))).items.map(item => item.work)).not.toContain(bunko.work);
    expect((await json<Page>(await page('parts'))).items.map(item => item.work)).toEqual(
      volumes.slice(2).map(volume => volume.work).sort());
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} rv:protectionHead ${iri(id())} } }`);
    expect((await page('series')).status).toBe(404);
  } finally { await f.stop(); }
}, 240_000);
