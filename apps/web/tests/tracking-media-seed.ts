// Seeds the manga, the omnibus, the game and the long series the tracking-media journey reads.
// Every record goes in through Main's routes. Published works are readable without a grant, and
// each episode names the series so a reader can see it. The journey's one progress write, marking
// episode 1001, is the panel's own expected-version mark.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';

const short = (iri: string) => iri.slice(-36);
const OPERATIONS = 16;
const EPISODES = 1002;
const BOOK = ['https://schema.org/Book'];
const SERIES = ['https://schema.org/BookSeries'];
const GAME = ['https://schema.org/VideoGame'];
const SHOW = ['https://schema.org/TVSeries'];

export interface MediaFixture {
  manga: { work: string; omnibus: string; title: string };
  game: { work: string; title: string; route: string };
  episodes: { work: string; title: string };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

/** Main keeps projecting earlier writes; a write told to restart is sent again. */
async function settled(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 409 || attempt === 40 || !(await response.clone().text()).includes('read_basis_changed')) return response;
    await new Promise(done => setTimeout(done, 500));
  }
}

export async function seedMedia(stack: MediaStack): Promise<MediaFixture> {
  const editor = await stack.member('tracking-media');
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });
  const started = performance.now();
  const lap = (name: string) => console.error(`[tracking media] ${name}: ${Math.round(performance.now() - started)} ms`);

  const grantEditor = async (action: string, scopes: string[]) => {
    for (const scope of scopes) await editor.grant(scope, action);
  };

  const work = async (title: string, types: string[]) => {
    const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
      editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(created.work, editor.actor, 'en', title);
    const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${title}`);
    return created;
  };

  const compose = async (profile: 'work-composition' | 'book-composition', owner: { work: string; mainVersion: string },
    operations: (structure: string) => object[]) => {
    const base = await json<{ structure: string; revision: string }>(await settled(() => editor.send('POST', '/v1/compositions', {
      profile, work: owner.work, mainVersion: owner.mainVersion, actingSubject: editor.actor })), 201);
    const changed = await json<{ revision: string; occurrences: string[] }>(await settled(() => editor.send('POST',
      `/v1/compositions/${short(base.structure)}/changes`,
      { profile, expectedHead: base.revision, actingSubject: editor.actor, operations: operations(base.structure) })));
    return { structure: base.structure, revision: changed.revision, occurrences: changed.occurrences };
  };

  // A chapter needs a published body, and the positions read keeps its label only when that
  // target is visible. The body is the content API; selecting its main version is what makes
  // the Work public to the signed-in reader.
  const text = await stack.privateWork(editor.actor, 'Harbour chapter');
  const titleText = await stack.contribution(text.work, editor.actor, 'en', 'Harbour chapter');
  const chapterSelection = { context: { kind: 'main-version-default' as const, id: text.mainVersion }, work: text.work,
    contribution: titleText.contribution, publicationDecision: titleText.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
  const chapterSelected = await selectMainDefault(stack.env, stack.admission(editor.actor,
    `publication:select:${text.mainVersion}`, 'publication.select', mainSelectionDigest(chapterSelection)), chapterSelection);
  if (chapterSelected.outcome !== 'succeeded') throw new Error('Main selection failed for Harbour chapter');
  await grantEditor('work.read', [`work:read:${text.work}`]);
  for (const [scope, action] of [
    [`content:draft:${text.work}`, 'content.draft'],
    [`content:publish:${text.work}`, 'content.publish'],
    [`content:search-eligibility:${text.work}`, 'content.search-eligibility'],
  ] as const) await editor.grant(scope, action);
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const saved = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await editor.send('POST',
    '/v1/content-drafts', { profile: 'content-text-v1', resourceId: text.work, variantId: variant,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
      body: 'The harbour light stayed on.', actingSubject: editor.actor }), 201);
  const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new Error('Chapter text was not saved');
  const published = await json<{ decision: string }>(await editor.send('POST', '/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: `harbour-${randomUUID()}`, revisionId: saved.revisionId,
    expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
    resourceId: text.work, variantId: variant, expectedPublicationHead: null, actingSubject: editor.actor }), 201);
  await json(await editor.send('POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
    resourceId: text.work, variantId: variant, publicationDecision: published.decision,
    expectedEligibilityHead: null, actingSubject: editor.actor, rightsBasis: 'original-contribution',
    disclosure: 'public' }), 201);
  lap('chapter text');

  const volume1 = await work('Harbour Volume 1', BOOK);
  const volume2 = await work('Harbour Volume 2', BOOK);
  const manga = await work('Harbour Volumes', SERIES);
  const omnibus = await work('Harbour Omnibus', SERIES);
  await grantEditor('work.edit', [volume1, volume2, manga, omnibus].map(item => `work:edit:${item.work}`));
  const chaptersOf = (volume: { work: string; mainVersion: string }, volumeNumber: number) =>
    compose('book-composition', volume, structure =>
      [1, 2, 3, 4].map(number => ({ op: 'insert', parent: structure, position: 'last', role: 'chapter',
        target: text.work, label: { value: `Volume ${volumeNumber}, chapter ${number}`, language: 'en' } })));
  await chaptersOf(volume1, 1);
  await chaptersOf(volume2, 2);
  const part = (parent: string, target: string, label: string, inclusion: 'required' | 'extra' = 'required') =>
    ({ op: 'insert', parent, position: 'last', role: 'part', target, displayLabel: label, inclusion });
  await compose('work-composition', manga, structure => [
    part(structure, volume1.work, '1'), part(structure, volume2.work, '2')]);
  await compose('work-composition', omnibus, structure => [part(structure, volume2.work, '2')]);
  lap('manga');

  const game = await work('Harbour Route', GAME);
  const story = await work('Harbour Story', GAME);
  const route = await work('Harbour True Route', GAME);
  await grantEditor('work.edit', [game, story, route].map(item => `work:edit:${item.work}`));
  await compose('work-composition', game, structure => [
    part(structure, story.work, 'Story'), part(structure, route.work, 'True route', 'extra')]);
  lap('game');

  const show = await work('Harbour Nights', SHOW);
  await grantEditor('work.edit', [`work:edit:${show.work}`]);
  await grantEditor('work.read', [`work:read:${show.work}`]);
  await editor.grant('semantic:create:root', 'semantic.change');
  const episodes: string[] = [];
  for (let index = 0; index < 4; index++) {
    const episode = await json<{ component: string }>(await settled(() => editor.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor.actor,
      state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Harbour episode ${index + 1}`, language: 'en' } },
        { predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: show.work } },
      ] } })), 201);
    episodes.push(episode.component);
  }
  await grantEditor('semantic.read', episodes.map(resource => `semantic:read:${resource}`));
  const composition = await json<{ structure: string; revision: string }>(await settled(() => editor.send('POST', '/v1/compositions', {
    profile: 'work-composition', work: show.work, mainVersion: show.mainVersion, actingSubject: editor.actor })), 201);
  let head = composition.revision;
  const occurrences: string[] = [];
  for (let at = 0; at < EPISODES; at += OPERATIONS) {
    const count = Math.min(OPERATIONS, EPISODES - at);
    const written = await json<{ revision: string; occurrences: string[] }>(await settled(() => editor.send('POST',
      `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'work-composition', expectedHead: head, actingSubject: editor.actor,
        operations: Array.from({ length: count }, (_, index) => part(composition.structure,
          episodes[(at + index) % episodes.length]!, `Episode ${at + index + 1}`)) })));
    head = written.revision;
    occurrences.push(...written.occurrences);
  }
  if (occurrences.length !== EPISODES) throw new Error(`Expected ${EPISODES} episodes, composed ${occurrences.length}`);
  await grantEditor('work.read', [text, volume1, volume2, manga, omnibus, game, story, route, show].map(item => `work:read:${item.work}`));
  lap('episodes composed');

  return {
    manga: { work: manga.work, omnibus: omnibus.work, title: 'Harbour Volumes' },
    game: { work: game.work, title: 'Harbour Route', route: 'True route' },
    episodes: { work: show.work, title: 'Harbour Nights' },
  };
}

if (import.meta.main) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
    throw new Error('The tracking media seed writes only into an isolated QA run');
  }
  const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
  readFileSync(path);
  const stack = await startMediaStack('tracking-media');
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  Object.assign(stack.env, { objectDirectory, workObjects });
  try {
    console.log(JSON.stringify(await seedMedia(stack)));
  } finally {
    await stack.stop();
  }
}
