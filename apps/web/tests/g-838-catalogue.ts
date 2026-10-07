// The records the G-838 e2e reads, written through Main's public routes on an isolated QA stack:
// Sword Art Online (a series of three volumes; volume 1 in English with a paperback, an audiobook and
// an omnibus release over all three), A Certain Magical Index (three volumes, the first two in
// Traditional Chinese) and So I'm a Spider, So What? (the web serial and the book, recorded as
// equivalent counterparts).
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { grantPlatformResource, grantPlatformUse, platformAdministratorSession, type PlatformGrantSession }
  from '../../../tests/qa/fixtures/platform-grant.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import type { MediaStack } from '../../../tests/qa/integration/media-support.ts';

const ID = 'https://rezics.com/id/';
const id = () => `${ID}${randomUUID()}`;
const short = (iri: string) => iri.slice(-36);
const types = ['https://schema.org/Book'];

let administrator: Promise<PlatformGrantSession> | undefined;

function administratorSession(): Promise<PlatformGrantSession> {
  administrator ??= platformAdministratorSession(process.env,
    'openid access:grant agent:create work:create work:edit work:read').catch(error => {
    administrator = undefined;
    throw error;
  });
  return administrator;
}

/** Open one exposure group for a seed actor's own principal. A stale authority
 * epoch is read again once; the grant is never given to the shared reader. */
export async function openActorPlatformGroup(principalId: string, group: string): Promise<void> {
  const session = await administratorSession();
  try {
    await grantPlatformUse(session, principalId, group);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('grant_stale')) throw error;
    await grantPlatformUse(session, principalId, group);
  }
}

export interface SeedReader { principalId: string; actor: string }
interface Work { work: string; mainVersion: string; mainRevision: string; title: string }
interface Written { revision: string }
interface Composition { structure: string; revision: string }

export interface CataloguePort {
  actor: string;
  read(path: string): Promise<Response>;
  send(method: string, path: string, body?: unknown, key?: string): Promise<Response>;
}

/** A cancelled basis is a new edit: read the current head and reapply the
 * ordered append intent with a new command key, rather than replay cancellation. */
export async function appendCatalogueParts(
  editor: CataloguePort,
  structure: string,
  parts: { work: string; label: string }[],
): Promise<void> {
  const path = `/v1/compositions/${short(structure)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await editor.read(path);
    if (await retryBasisChanged(current, attempt)) continue;
    const composition = await json<Composition>(current);
    const changed = await editor.send('POST', `${path}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
      operations: parts.map(part => ({ op: 'insert', parent: structure, position: 'last', role: 'part',
        target: part.work, displayLabel: part.label, inclusion: 'required' })),
    }, randomUUID());
    if (await retryBasisChanged(changed, attempt)) continue;
    await json(changed);
    return;
  }
}

async function retryBasisChanged(response: Response, attempt: number): Promise<boolean> {
  if (response.status !== 409 || attempt === 3) return false;
  const problem = await response.clone().json() as { code?: string };
  if (problem.code !== 'read_basis_changed') return false;
  return true;
}

async function readCatalogue<T>(editor: CataloguePort, path: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await editor.read(path);
    if (await retryBasisChanged(response, attempt)) continue;
    return json<T>(response);
  }
  throw new Error(`Catalogue read did not expose its current basis: ${path}`);
}

/** Controller and author baselines come from the public provisioning and
 * authoring operations; selected publication makes the fixture publicly readable. */
export async function createCatalogueWork(editor: CataloguePort, title: string): Promise<Work> {
  const created = await json<Omit<Work, 'title'>>(await editor.send('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
    semanticTypes: types, actingSubject: editor.actor,
  }), 201);
  const draft = await json<{ contribution: string; draftRevision: string }>(await editor.send('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: created.work, language: 'ja',
    body: `${title}（本文）`, actingSubject: editor.actor,
  }), 201);
  const published = await json<{ publicationDecision: string }>(await editor.send('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution,
    expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: editor.actor,
  }), 201);
  await json(await editor.send('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: created.mainVersion },
    work: created.work, contribution: draft.contribution, publicationDecision: published.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: editor.actor,
  }), 201);
  return { ...created, title };
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  const replayed = status === 201 && response.status === 200 && body.includes('"replayed":true');
  if (response.status !== status && !replayed) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

export interface Catalogue {
  sao: { series: Work; volumes: Work[]; paperback: string; audiobook: string; omnibus: string };
  index: { series: Work; volumes: Work[] };
  spider: { web: Work; book: Work };
}

export async function seedCatalogue(stack: MediaStack, reader: SeedReader, scratch: string): Promise<Catalogue> {
  // Downstream Zone fixtures share this app and need its storage dependency;
  // catalogue records themselves are created by the running public API.
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });
  const session = await administratorSession();
  const send: CataloguePort['send'] = async (method, path, body, key = randomUUID()) => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const response = await fetch(new URL(path, session.mainOrigin), {
        method, headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // A pending command is observed again with its original key until its
      // terminal response is visible. A cancelled command is handled separately.
      if (response.status !== 202 || attempt === 63) return response;
      await response.text();
    }
    throw new Error(`Catalogue command did not settle: ${method} ${path}`);
  };
  const provisioned = await json<{ agent: string }>(await send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue fixture',
  }), 201);
  const editor: CataloguePort = { actor: provisioned.agent, send,
    read: path => {
      const url = new URL(path, session.mainOrigin);
      url.searchParams.set('actingSubject', provisioned.agent);
      return send('GET', `${url.pathname}${url.search}`);
    } };
  const work = (title: string) => createCatalogueWork(editor, title);

  const compose = async (whole: Work, parts: { work: Work; label: string }[]) => {
    const composition = await json<Composition>(await editor.send('POST', '/v1/compositions', { profile: 'work-composition',
      work: whole.work, mainVersion: whole.mainVersion, actingSubject: editor.actor }), 201);
    await appendCatalogueParts(editor, composition.structure,
      parts.map(part => ({ work: part.work.work, label: part.label })));
  };

  const text = async (target: Work, language: string, publisher: string) => {
    const write = async () => {
      const body = { profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor, id: id(), language,
        kind: language === 'ja' ? 'original' : 'translation', translators: language === 'ja' ? [] : [editor.actor], publishers: [publisher],
        source: { kind: 'unresolved', work: target.work }, status: 'official', verification: 'verified',
        evidence: 'https://example.com/evidence' };
      const response = await editor.send('PUT', `/v1/works/${short(target.work)}/realizations/${short(body.id)}`, body);
      return { id: body.id, response };
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      await readCatalogue(editor, `/v1/works/${short(target.work)}`);
      const written = await write();
      if (written.response.status === 409 && attempt < 3
        && (await written.response.clone().json() as { code?: string }).code === 'realization_basis_changed') continue;
      const result = await json<Written>(written.response);
      return { id: written.id, revision: result.revision };
    }
    throw new Error('Catalogue realization did not settle');
  };

  // The one correspondence kind the panel offers "also mark as read" for.
  mkdirSync(scratch, { recursive: true });
  const definition = await editor.read('/v1/lexicon/definitions/correspondence-equivalent');
  const current = definition.status === 404 ? null
    : await json<{ definition: string; revision: string }>(definition);
  // Other launch fixtures may already have admitted this stable meaning.
  // Presentation writes are closed to platform-admin; only this editor posts them.
  if (!current) await openActorPlatformGroup(session.principalId, 'platform-admin');
  const definitions = current ? new Map([['correspondence-equivalent',current]]) : new Map((await seedRelationLexicon({
    post: async <T>(path: string, body: object, key: string) => json<T>(await editor.send('POST', path, body, key), 201),
    // Provisioned controller and definition-creator policy supply stewardship.
    authorizeDefinition: async () => {},
  }, editor.actor, `catalogue-${randomUUID()}`, relationLexiconSeed.filter(item => item.key === 'correspondence-equivalent'),
  resolve(scratch, 'lexicon.json'))).map(item => [item.key, item]));

  // Sword Art Online: three volumes, each in English.
  const publisher = id();
  const saoSeries = await work('Sword Art Online');
  const saoVolumes: Work[] = [];
  for (const number of [1, 2, 3]) saoVolumes.push(await work(`Sword Art Online, Vol. ${number}`));
  await compose(saoSeries, saoVolumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  // One write at a time: each moves the graph the next one is checked against (409 realization_basis_changed).
  const english = [];
  for (const volume of saoVolumes) english.push(await text(volume, 'en', publisher));
  const release = async (title: string, platform: string, coverage: { id: string; revision: string }[]) => {
    const body = { profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: id(), kind: 'formal', status: 'official',
      title: { value: title, language: 'en' }, titleLanguage: 'en', tracklistLanguage: null, editionStatement: null,
      publisher: 'Yen Press', publicationYear: 2014, isbn13: null, originalUrl: null, fixedRelease: null, evidence: null,
      identifiers: [], platform, territory: 'US',
      coverage: coverage.map(entry => ({ realization: entry.id, revision: entry.revision, completeness: 'complete' })) };
    for (let attempt = 0; attempt < 4; attempt++) {
      await readCatalogue(editor, `/v1/works/${short(saoVolumes[0]!.work)}`);
      body.id = id();
      const response = await editor.send('PUT', `/v1/works/${short(saoVolumes[0]!.work)}/releases/${short(body.id)}`, body);
      if (response.status === 409 && attempt < 3
        && (await response.clone().json() as { code?: string }).code === 'release_basis_changed') continue;
      await json(response);
      return body.id;
    }
    throw new Error('Catalogue release did not settle');
  };
  const paperback = await release('Sword Art Online 1: Aincrad', 'paperback', [english[0]!]);
  const audiobook = await release('Sword Art Online 1: Aincrad (audiobook)', 'audiobook', [english[0]!]);
  const omnibus = await release('Sword Art Online: Volumes 1–3 omnibus', 'ebook', english);

  // Index: volumes 1 and 2 are available in Traditional Chinese, volume 3 is not.
  const indexSeries = await work('A Certain Magical Index');
  const indexVolumes: Work[] = [];
  for (const number of [1, 2, 3]) indexVolumes.push(await work(`A Certain Magical Index, Vol. ${number}`));
  await compose(indexSeries, indexVolumes.map((volume, index) => ({ work: volume, label: String(index + 1) })));
  for (const volume of indexVolumes.slice(0, 2)) await text(volume, 'zh-Hant', publisher);

  // Spider: the book and the web serial are recorded as equivalent; finishing one completes neither.
  const web = await work('So I’m a Spider, So What? (web)');
  const book = await work('So I’m a Spider, So What?');
  const relation = await json<{ occurrence: string }>(await editor.send('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', expectedHead: null, definition: definitions.get('correspondence-equivalent')!.revision,
    participations: [{ role: 'source', participant: { kind: 'resource', ref: web.work } },
      { role: 'target', participant: { kind: 'resource', ref: book.work } }],
    evidence: 'https://example.com/relation', actingSubject: editor.actor }), 201);
  // Main withholds a relation whose occurrence the reader may not read, so the panel never hears of the counterpart.
  await grantPlatformResource(session, reader.principalId, 'semantic.read',
    `semantic:read:${relation.occurrence}`, new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString());

  return { sao: { series: saoSeries, volumes: saoVolumes, paperback, audiobook, omnibus },
    index: { series: indexSeries, volumes: indexVolumes }, spider: { web, book } };
}
