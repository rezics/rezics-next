// Seeds the manga, the omnibus, the game and the long series the tracking-media journey reads.
// Every record goes in through Main's routes. The signed-in web member reads them by explicit
// grants. Progress the episode panel must already see is written here, then handed to that
// member's account: this process's bearer is not the account the browser signs in as.
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

type Reader = { principalId: string; actor: string };

export async function seedMedia(stack: MediaStack, reader: Reader): Promise<MediaFixture> {
  const editor = await stack.member('tracking-media');
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });
  const started = performance.now();
  const lap = (name: string) => console.error(`[tracking media] ${name}: ${Math.round(performance.now() - started)} ms`);

  const grantAll = async (who: { principalId: string; actor: string }, action: string, scopes: string[]) => {
    if (!scopes.length) return;
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [scopes]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), who.principalId, who.actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      SELECT gen_random_uuid(), $1, $1, scope, $2, now() + interval '8 hours' FROM unnest($3::text[]) AS scope`,
    [who.actor, action, scopes]);
  };
  const grantEditor = (action: string, scopes: string[]) => grantAll(editor, action, scopes);
  const grantReader = (action: string, scopes: string[]) => grantAll(reader, action, scopes);

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

  // One published chapter text. Contents only lists a chapter whose target has a public body,
  // and the same text may stand for every chapter.
  const text = await stack.privateWork(editor.actor, 'Harbour chapter');
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
  const chaptersOf = (volume: { work: string; mainVersion: string }) => compose('book-composition', volume, structure =>
    [1, 2, 3, 4].map(number => ({ op: 'insert', parent: structure, position: 'last', role: 'chapter',
      target: text.work, label: { value: `Chapter ${number}`, language: 'en' } })));
  await chaptersOf(volume1);
  await chaptersOf(volume2);
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
  await editor.grant('semantic:create:root', 'semantic.change');
  const episodes: string[] = [];
  for (let index = 0; index < 4; index++) {
    const episode = await json<{ component: string }>(await settled(() => editor.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor.actor,
      state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Harbour episode ${index + 1}`, language: 'en' } },
      ] } })), 201);
    episodes.push(episode.component);
  }
  await grantEditor('semantic.read', episodes.map(resource => `semantic:read:${resource}`));
  await grantReader('semantic.read', episodes.map(resource => `semantic:read:${resource}`));
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
  const readable = [text, volume1, volume2, manga, omnibus, game, story, route, show].map(item => `work:read:${item.work}`);
  await grantEditor('work.read', readable);
  await grantReader('work.read', readable);
  lap('episodes composed');

  // The episode panel treats a page as watched when its first and last episodes are. Episode 1 and
  // every 20th through 1000 are completed, so the panel resumes at 1001. The seed's own Main does
  // not serve progress; the harness Main reads these rows for the account the browser signs in as.
  const marks = occurrences.flatMap((occurrence, index) => {
    const number = index + 1;
    return number === 1 || (number % 20 === 0 && number <= 1000) ? [{ occurrence, number }] : [];
  });
  const account = (await stack.accessPool.query<{ account_issuer: string; account_subject: string }>(
    'SELECT account_issuer, account_subject FROM access.principal WHERE id = $1 AND active',
    [reader.principalId])).rows[0];
  if (!account) throw new Error('The web reader has no account principal');
  const written = await stack.contentPool.query(
    `INSERT INTO structure.progress
       (principal_issuer, principal_subject, structure, occurrence, selection_key, completed, position, version)
     SELECT $1, $2, $3, mark.occurrence, '', true, mark.position, 1
     FROM unnest($4::text[], $5::text[]) AS mark(occurrence, position)`,
    [account.account_issuer, account.account_subject, composition.structure,
      marks.map(mark => mark.occurrence), marks.map(mark => `episode:${mark.number}`)]);
  if (written.rowCount !== marks.length) throw new Error(`Recorded ${written.rowCount} episode rows, expected ${marks.length}`);
  lap('episode progress');

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
  const { principalId, actingSubject } = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };
  const stack = await startMediaStack('tracking-media');
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  Object.assign(stack.env, { objectDirectory, workObjects });
  try {
    console.log(JSON.stringify(await seedMedia(stack, { principalId, actor: actingSubject })));
  } finally {
    await stack.stop();
  }
}
