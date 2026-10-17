import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { seekChapter } from '../../../services/main/src/modules/structure/reading-order.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';

let stack: MediaStack;
let editor: Awaited<ReturnType<MediaStack['member']>>;
const short = (id: string) => id.slice(-36);
type Changed = { structure: string; revision: string; occurrences: string[] };
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
beforeAll(async () => {
  // This fixture constructs the production dependency graph through composeMain.
  stack = await startMediaStack('profile-traversal');
  editor = await stack.member('profile-editor');
}, 120_000);
afterAll(async () => { await stack?.stop(); });

async function work(title: string, types: string[] = []) {
  const created = await stack.catalogueWork(editor.actor, title, types);
  await editor.grant(`work:edit:${created.work}`, 'work.edit');
  await editor.grant(`work:read:${created.work}`, 'work.read');
  if (types.includes('https://schema.org/Recipe')) await editor.grant(`work:edit:${created.work}`, 'recipe.edit');
  return created;
}
async function composition(owner: Awaited<ReturnType<typeof work>>, profile = 'section-list-v1') {
  return json<Changed>(await editor.send('POST', '/v1/compositions', {
    profile, work: owner.work, mainVersion: owner.mainVersion, actingSubject: editor.actor,
  }), 201);
}
async function change(created: Changed, operations: object[]) {
  return json<Changed>(await editor.send('POST', `/v1/compositions/${short(created.structure)}/changes`, {
    profile: 'section-list-v1', expectedHead: created.revision, operations, actingSubject: editor.actor,
  }));
}

test('a section-list reader navigates nested declared containers and lists readable entries', async () => {
  const owner = await work('Section list navigation');
  const target = await work('Entry target');
  const created = await composition(owner);
  const outer = await change(created, [{ op: 'insert', role: 'section', parent: created.structure, position: 'last' }]);
  const inner = await change({ ...created, ...outer }, [{ op: 'insert', role: 'section', parent: outer.occurrences[0], position: 'last' }]);
  const inserted = await change({ ...created, ...inner }, [{ op: 'insert', role: 'entry', parent: inner.occurrences[0],
    position: 'last', target: target.work, qualifier: { note: 'Read this entry' } }]);
  const found = await seekChapter(stack.env, { structure: created.structure, canReadTarget: async () => true });
  expect(found?.record).toMatchObject({ occurrence: inserted.occurrences[0], role: 'entry', target: target.work });
  const contents = await json<{ items: Array<{ role: string; target: string; availability: string }> }>(await editor.read(
    `/v1/works/${short(owner.work)}/contents?parent=${encodeURIComponent(inner.occurrences[0]!)}`));
  expect(contents.items).toMatchObject([{ role: 'entry', target: target.work, availability: 'available' }]);
  await editor.grant(`work:publish:${owner.work}`, 'work.publish');
  const current = await json<{ revision: string }>(await editor.read(`/v1/works/${short(owner.work)}`));
  await json(await editor.send('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: owner.work,
    expectedWorkHead: current.revision, expectedMainVersion: owner.mainVersion,
    structure: created.structure, expectedStructureHead: inserted.revision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: editor.actor,
  }), 201);
  const stranger = await stack.member('profile-stranger');
  for (const read of [
    (path: string) => stack.call('GET', path),
    (path: string) => stranger.read(path),
  ]) {
    const publicContents = await json<typeof contents>(await read(
      `/v1/works/${short(owner.work)}/contents?parent=${encodeURIComponent(inner.occurrences[0]!)}`));
    expect(publicContents.items).toMatchObject([{ role: 'entry', target: target.work, availability: 'available' }]);
    const page = await json<{ occurrences: Array<{ occurrence: string; target: string }> }>(await read(
      `/v1/compositions/${short(created.structure)}?parent=${encodeURIComponent(inner.occurrences[0]!)}`));
    expect(page.occurrences).toMatchObject([{ occurrence: inserted.occurrences[0], target: target.work }]);
  }
}, 120_000);

test('a section-list editor refreshes nested entries with exact source correspondence and retry recovery', async () => {
  const sourceOwner = await work('Source sections'), localOwner = await work('Local sections');
  const target = await work('Refresh entry');
  const source = await composition(sourceOwner), local = await composition(localOwner);
  const section = await change(source, [{ op: 'insert', role: 'section', parent: source.structure, position: 'last' }]);
  const entry = await change({ ...source, ...section }, [{ op: 'insert', role: 'entry', parent: section.occurrences[0],
    position: 'last', target: target.work, qualifier: { note: 'Retain this note' } }]);
  const body = { expectedHead: local.revision, sourceStructure: source.structure,
    sourceRevision: entry.revision, actingSubject: editor.actor };
  const path = `/v1/compositions/${short(local.structure)}/refreshes`;
  const refreshed = await json<{ status: string; revision: string }>(await editor.send('POST', path, body, 'section-refresh'));
  expect(refreshed.status).toBe('activated');
  const retry = await json<{ revision: string }>(await editor.send('POST', path, body, 'section-refresh'));
  expect(retry.revision).toBe(refreshed.revision);
  const header = await readCompositionHeader(stack.env, local.structure);
  expect(header?.head).toBe(refreshed.revision);
  const found = await seekChapter(stack.env, { structure: local.structure, canReadTarget: async () => true });
  expect(found?.record.qualifier).toEqual({ type: 'fields', id: 'entry', values: { note: 'Retain this note' } });
  expect(found?.record.sourceKey).toMatch(/^source:/);
}, 120_000);

test('an attached Recipe profile refuses removal of its required owner type', async () => {
  const owner = await work('Recipe type dependency', ['https://schema.org/Recipe']);
  const created = await composition(owner, 'recipe-composition');
  const current = await stack.fuseki.query(`SELECT ?head WHERE { GRAPH <urn:rezics:graph:current> { <${owner.work}> <https://rezics.com/vocab/head> ?head } }`);
  const response = await editor.send('PUT', `/v1/works/${short(owner.work)}/type`, {
    profile: 'work-type-v3', expectedHead: current.results!.bindings![0]!.head!.value,
    types: [], actingSubject: editor.actor,
  });
  expect(response.status).toBe(409);
  expect((await readCompositionHeader(stack.env, created.structure))?.profile).toBe('recipe-composition');
}, 120_000);
