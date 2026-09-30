// The records the G-838 e2e reads, written through Main's public routes on an isolated QA stack:
// Sword Art Online (a series of three volumes; volume 1 in English with a paperback, an audiobook and
// an omnibus release over all three), A Certain Magical Index (three volumes, the first two in
// Traditional Chinese) and So I'm a Spider, So What? (the web serial and the book, recorded as
// equivalent counterparts).
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import type { MediaStack } from '../../../tests/qa/integration/media-support.ts';

const ID = 'https://rezics.com/id/';
const id = () => `${ID}${randomUUID()}`;
const short = (iri: string) => iri.slice(-36);
const types = ['https://schema.org/Book'];

export interface SeedReader { principalId: string; actor: string }
interface Work { work: string; mainVersion: string; mainRevision: string; title: string }
interface Written { revision: string }
interface Composition { structure: string; revision: string }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

export interface Catalogue {
  sao: { series: Work; volumes: Work[]; paperback: string; audiobook: string; omnibus: string };
  index: { series: Work; volumes: Work[] };
  spider: { web: Work; book: Work };
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

  /** A public Work the signed-in member may read: a selected native text, and their explicit Work grant. */
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
    await grantReader(`work:read:${created.work}`, 'work.read');
    return { work: created.work, mainVersion: created.mainVersion, mainRevision: created.mainRevision, title };
  };

  const compose = async (whole: Work, parts: { work: Work; label: string }[]) => {
    const composition = await json<Composition>(await editor.send('POST', '/v1/compositions', { profile: 'work-composition',
      work: whole.work, mainVersion: whole.mainVersion, actingSubject: editor.actor }), 201);
    await json(await editor.send('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
      operations: parts.map(part => ({ op: 'insert', parent: composition.structure, position: 'last', role: 'part',
        target: part.work.work, displayLabel: part.label, inclusion: 'required' })) }));
  };

  const text = async (target: Work, language: string, publisher: string) => {
    const body = { profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor, id: id(), language,
      kind: language === 'ja' ? 'original' : 'translation', translators: language === 'ja' ? [] : [editor.actor], publishers: [publisher],
      source: { kind: 'unresolved', work: target.work }, status: 'official', verification: 'verified',
      evidence: 'https://example.com/evidence' };
    const result = await json<Written>(await editor.send('PUT', `/v1/works/${short(target.work)}/realizations/${short(body.id)}`, body));
    return { id: body.id, revision: result.revision };
  };

  // The one correspondence kind the panel offers "also mark as read" for.
  await editor.grant('semantic:create:root', 'semantic.change');
  mkdirSync(scratch, { recursive: true });
  const definitions = new Map((await seedRelationLexicon({
    post: async <T>(path: string, body: object, key: string) => json<T>(await editor.send('POST', path, body, key), 201),
    authorizeDefinition: async receipt => {
      await editor.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      await editor.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
      await grantReader(`semantic:read:${receipt.component}`, 'semantic.read');
    } }, editor.actor, `g838-${randomUUID()}`, relationLexiconSeed.filter(item => item.key === 'correspondence-equivalent'),
  resolve(scratch, 'lexicon.json'))).map(item => [item.key, item]));

  // Sword Art Online: three volumes, each in English.
  const publisher = id();
  const saoSeries = await work('Sword Art Online');
  const saoVolumes = await Promise.all([1, 2, 3].map(number => work(`Sword Art Online, Vol. ${number}`)));
  await compose(saoSeries, saoVolumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  const english = await Promise.all(saoVolumes.map(volume => text(volume, 'en', publisher)));
  const release = async (title: string, platform: string, coverage: { id: string; revision: string }[]) => {
    const body = { profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: id(), kind: 'formal', status: 'official',
      title: { value: title, language: 'en' }, titleLanguage: 'en', tracklistLanguage: null, editionStatement: null,
      publisher: 'Yen Press', publicationYear: 2014, isbn13: null, originalUrl: null, fixedRelease: null, evidence: null,
      identifiers: [], platform, territory: 'US',
      coverage: coverage.map(entry => ({ realization: entry.id, revision: entry.revision, completeness: 'complete' })) };
    await json(await editor.send('PUT', `/v1/works/${short(saoVolumes[0]!.work)}/releases/${short(body.id)}`, body));
    return body.id;
  };
  const paperback = await release('Sword Art Online 1: Aincrad', 'paperback', [english[0]!]);
  const audiobook = await release('Sword Art Online 1: Aincrad (audiobook)', 'audiobook', [english[0]!]);
  const omnibus = await release('Sword Art Online: Volumes 1–3 omnibus', 'ebook', english);

  // Index: volumes 1 and 2 are available in Traditional Chinese, volume 3 is not.
  const indexSeries = await work('A Certain Magical Index');
  const indexVolumes = await Promise.all([1, 2, 3].map(number => work(`A Certain Magical Index, Vol. ${number}`)));
  await compose(indexSeries, indexVolumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  for (const volume of indexVolumes.slice(0, 2)) await text(volume, 'zh-Hant', publisher);

  // Spider: the book and the web serial are recorded as equivalent; finishing one completes neither.
  const web = await work('So I’m a Spider, So What? (web)');
  const book = await work('So I’m a Spider, So What?');
  await json(await editor.send('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', expectedHead: null, definition: definitions.get('correspondence-equivalent')!.revision,
    participations: [{ role: 'source', participant: { kind: 'resource', ref: web.work } },
      { role: 'target', participant: { kind: 'resource', ref: book.work } }],
    evidence: 'https://example.com/relation', actingSubject: editor.actor }), 201);

  return { sao: { series: saoSeries, volumes: saoVolumes, paperback, audiobook, omnibus },
    index: { series: indexSeries, volumes: indexVolumes }, spider: { web, book } };
}
