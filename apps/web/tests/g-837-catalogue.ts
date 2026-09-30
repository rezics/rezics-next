// The franchise records the G-837 e2e browses, written through Main's public
// routes on an isolated QA stack: Index (New Testament "22" and "22 Reverse",
// Genesis Testament restarting at 1), Sword Art Online (web, bunko, Progressive
// reboot, Alternative GGO spin-off, a franchise Collection, volume 1 in four
// languages, releases with an ISBN and an omnibus) and Railgun (an anime whose
// source version is unresolved, a manga that spins off from Index).
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, RV } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import type { MediaStack } from '../../../tests/qa/integration/media-support.ts';

const ID = 'https://rezics.com/id/';
const id = () => `${ID}${randomUUID()}`;
const short = (iri: string) => iri.slice(-36);
const types = ['https://schema.org/Book'];

/** The real web member the browser signs in as: reads are theirs, so Access grants them what the records need. */
export interface SeedReader { principalId: string; actor: string }
interface Work { work: string; mainVersion: string; mainRevision: string; title: string }
interface Composition { structure: string; revision: string }
interface Written { revision: string }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

export interface Catalogue {
  sao: { web: Work; bunko: Work; progressive: Work; aggo: Work; volumes: Work[]; collection: string };
  index: { overall: Work; newTestament: Work; genesisTestament: Work };
  railgun: { manga: Work; anime: Work };
  volumeOne: { work: Work; release: string; omnibus: string; isbn: string };
}

export async function seedCatalogue(stack: MediaStack, reader: SeedReader, scratch: string): Promise<Catalogue> {
  const editor = await stack.member('catalogue');
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });

  const grantReader = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.actor, scope, action]);
  };

  /** A public Work: a selected native text makes it readable to the signed-in member. */
  const work = async (title: string): Promise<Work> => {
    const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
      editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(created.work, editor.actor, 'ja', `${title}（本文）`);
    const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${title}`);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    await editor.grant(`work:read:${created.work}`, 'work.read');
    // Parts, wholes and relations are read by explicit Work grant, even for a public Work.
    await grantReader(`work:read:${created.work}`, 'work.read');
    return { work: created.work, mainVersion: created.mainVersion, mainRevision: created.mainRevision, title };
  };

  const compose = async (whole: Work, parts: { work: Work; label: string; inclusion?: string }[],
    completion?: { status: 'concluded' | 'ongoing'; evidence: string[] }) => {
    let composition = await json<Composition>(await editor.send('POST', '/v1/compositions', { profile: 'work-composition',
      work: whole.work, mainVersion: whole.mainVersion, actingSubject: editor.actor }), 201);
    composition = await json<Composition>(await editor.send('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
      operations: parts.map(part => ({ op: 'insert', parent: composition.structure, position: 'last', role: 'part',
        target: part.work.work, displayLabel: part.label, inclusion: part.inclusion ?? 'required' })) }));
    if (completion) await json(await editor.send('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
      operations: [{ op: 'completion', completion }] }));
  };

  // The shared relation lexicon: only the kinds this page shows, in every interface language.
  const kinds = new Set(['rewrite', 'reboot', 'spin-off', 'sequel', 'adaptation']);
  await editor.grant('semantic:create:root', 'semantic.change');
  mkdirSync(scratch, { recursive: true });
  const definitions = new Map((await seedRelationLexicon({
    post: async <T>(path: string, body: object, key: string) => json<T>(await editor.send('POST', path, body, key), 201),
    authorizeDefinition: async receipt => {
      await editor.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      await editor.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
      await grantReader(`semantic:read:${receipt.component}`, 'semantic.read');
    } }, editor.actor, `g837-${randomUUID()}`, relationLexiconSeed.filter(item => kinds.has(item.key)),
  resolve(scratch, 'lexicon.json'))).map(item => [item.key, item]));

  /** A Main Version's head now: selecting its text moved it past the one its creation returned. */
  const head = async (target: Work) => (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(target.mainVersion)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
  const derive = async (target: Work, source: Work, kind: string, unresolved = false) => json(await editor.send('POST',
    `/v1/resources/${short(target.work)}/derivations`, { profile: 'work-derivation-v2', targetMainVersion: target.mainVersion,
      expectedTargetHead: await head(target), sourceWork: source.work, sourceMainVersion: unresolved ? null : source.mainVersion,
      sourceMainRevision: unresolved ? null : await head(source), kind, evidence: 'https://example.com/derivation',
      actingSubject: editor.actor }), 201);
  const relate = async (kind: string, bindings: Record<string, Work>) => json(await editor.send('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', expectedHead: null, definition: definitions.get(kind)!.revision,
    participations: Object.entries(bindings).map(([role, target]) => ({ role, participant: { kind: 'resource', ref: target.work } })),
    evidence: 'https://example.com/relation', actingSubject: editor.actor }), 201);

  // Index: the overall sequence holds two subseries, each with its own volume labels.
  const overall = await work('A Certain Magical Index');
  const newTestament = await work('A Certain Magical Index: New Testament');
  const genesisTestament = await work('A Certain Magical Index: Genesis Testament');
  const ntVolumes = await Promise.all(['1', '2', '22', '22 Reverse'].map(label => work(`New Testament ${label}`)));
  const gtVolumes = await Promise.all(['1', '2'].map(label => work(`Genesis Testament ${label}`)));
  await compose(overall, [{ work: newTestament, label: 'New Testament' }, { work: genesisTestament, label: 'Genesis Testament' }]);
  await compose(newTestament, ntVolumes.map((volume, index) => ({ work: volume, label: ['1', '2', '22', '22 Reverse'][index]! })),
    { status: 'concluded', evidence: ['https://example.com/index-new-testament/concluded'] });
  await compose(genesisTestament, gtVolumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  await relate('sequel', { predecessor: newTestament, sequel: genesisTestament });

  // Railgun: the anime's source version is not pinned; the manga spins off from Index.
  const manga = await work('A Certain Scientific Railgun (manga)');
  const anime = await work('A Certain Scientific Railgun (anime)');
  await derive(anime, manga, 'adaptation', true);
  await relate('spin-off', { source: await work('A Certain Magical Index (novel)'), 'spin-off': manga });

  // Sword Art Online: the web serial, the bunko Rewrite of it, a Reboot and a SpinOff of the bunko.
  const web = await work('Sword Art Online (web)');
  const bunko = await work('Sword Art Online');
  const progressive = await work('Sword Art Online Progressive');
  const aggo = await work('Sword Art Online Alternative Gun Gale Online');
  const volumes = await Promise.all([1, 2, 3].map(number => work(`Sword Art Online, Vol. ${number}`)));
  const progressiveVolumes = await Promise.all([1, 2].map(number => work(`Sword Art Online Progressive, Vol. ${number}`)));
  await compose(bunko, volumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  await compose(progressive, progressiveVolumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  await derive(bunko, web, 'rewrite');
  await derive(progressive, bunko, 'reboot');
  await relate('spin-off', { source: bunko, 'spin-off': aggo });

  // The franchise is a Collection of series; the series' volumes are its parts.
  const collection = id();
  await editor.grant(`collection:edit:${collection}`, 'collection.edit');
  await editor.grant(`semantic:read:${collection}`, 'semantic.read');
  await grantReader(`semantic:read:${collection}`, 'semantic.read');
  const created = await json<Composition>(await editor.send('POST', '/v1/collections',
    { collection, name: 'Sword Art Online', disclosure: 'public', actingSubject: editor.actor }), 201);
  await json<Written>(await editor.send('POST', `/v1/collections/${short(collection)}/changes`, {
    expectedHead: created.revision, actingSubject: editor.actor,
    operations: [web, bunko, progressive, aggo].map(target => ({ op: 'insert', role: 'member', parent: created.structure,
      position: 'last', target: target.work, selection: { mode: 'follow-context' } })) }));

  // Volume 1: one text per language and script, then the releases that carry them.
  const publishers = { yen: id(), kadokawa: id(), hunan: id() };
  const text = async (target: Work, language: string, extra: Record<string, unknown>) => {
    const body = { profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor, id: id(), language,
      kind: 'translation', translators: [editor.actor], publishers: [], source: { kind: 'unresolved', work: target.work },
      status: 'official', verification: 'verified', evidence: 'https://example.com/evidence', ...extra };
    const result = await json<Written>(await editor.send('PUT', `/v1/works/${short(target.work)}/realizations/${short(body.id)}`, body));
    return { id: body.id, revision: result.revision };
  };
  const [volumeOne] = volumes as [Work, ...Work[]];
  const japanese = await text(volumeOne, 'ja', { kind: 'original', translators: [], publishers: [publishers.kadokawa] });
  const english = await text(volumeOne, 'en', { publishers: [publishers.yen],
    source: { kind: 'realization', work: volumeOne.work, realization: japanese.id, revision: japanese.revision } });
  await text(volumeOne, 'zh-Hant', { publishers: [publishers.kadokawa],
    source: { kind: 'realization', work: volumeOne.work, realization: japanese.id, revision: japanese.revision } });
  await text(volumeOne, 'zh-Hans', { publishers: [publishers.hunan], status: 'unofficial', verification: 'unverified', evidence: null });
  const others = [];
  for (const volume of volumes.slice(1)) others.push(await text(volume, 'en', { publishers: [publishers.yen] }));
  const release = async (title: string, coverage: { realization: string; revision: string }[], extra: Record<string, unknown> = {}) => {
    const body = { profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: id(), kind: 'formal', status: 'official',
      title: { value: title, language: 'en' }, titleLanguage: 'en', tracklistLanguage: null, editionStatement: null,
      publisher: 'Yen Press', publicationYear: 2014, isbn13: null, originalUrl: null, fixedRelease: null, evidence: null,
      identifiers: [], platform: 'paperback', territory: 'US',
      coverage: coverage.map(entry => ({ ...entry, completeness: 'complete' })), ...extra };
    await json(await editor.send('PUT', `/v1/works/${short(volumeOne.work)}/releases/${short(body.id)}`, body));
    return body.id;
  };
  const isbn = '9780316371247';
  const paperback = await release('Sword Art Online 1: Aincrad', [{ realization: english.id, revision: english.revision }], { isbn13: isbn });
  const omnibus = await release('Sword Art Online: Volumes 1–3 omnibus',
    [english, ...others].map(entry => ({ realization: entry.id, revision: entry.revision })), { platform: 'ebook' });

  return { sao: { web, bunko, progressive, aggo, volumes, collection }, index: { overall, newTestament, genesisTestament },
    railgun: { manga, anime }, volumeOne: { work: volumeOne, release: paperback, omnibus, isbn } };
}
