import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { FixtureLock } from '../fixtures/pull.ts';
import { prideEditionSet } from '../../tests/fixtures/sources/open-library.ts';
import { stableId } from '../dev/seed/state.ts';
import { seedCatalogueProfileWorks } from './catalogue-work.ts';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from './compatibility.ts';
import { workProfileCorpusApi, type CorpusApi, type CorpusBackupDriver } from './work-profile-corpus.ts';

const root = resolve(import.meta.dir, '../..');
const budgetMs = 600_000;
const recipe = 'launch-books-v2';
const short = (id: string) => id.slice(-36);

interface OpenLibraryRecord {
  key: string;
  title: string;
  revision: number;
  works?: { key: string }[];
  languages?: { key: string }[];
  publishers?: string[];
  publish_date?: string;
  edition_name?: string;
  isbn_13?: string[];
  physical_format?: string;
}

/** Only the seven records needed for edition choice. The 250-record library
 * slice and Wikidata labels belong to later journeys and are not imported. */
export function launchBookSources() {
  const lock = JSON.parse(readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
  if (lock.version !== 1) throw new Error('Unsupported launch fixture lock');
  return ['work-OL66554W', ...prideEditionSet.map(row => `edition-${row.edition}`)].map(id => {
    const entry = lock.entries.find(row => row.source === 'open-library' && row.id === id);
    if (!entry || !entry.reuseBasis.includes('CC0')) throw new Error(`Missing CC0 pin: ${id}`);
    const bytes = readFileSync(join(root, entry.seed));
    if (bytes.byteLength !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Launch fixture digest mismatch: ${id}`);
    const record = JSON.parse(bytes.toString('utf8')) as OpenLibraryRecord;
    const externalId = id.replace(/^(work|edition)-/, '');
    if (record.key !== `${id.startsWith('work-') ? '/works/' : '/books/'}${externalId}`
      || !record.title || !Number.isSafeInteger(record.revision)
      || (id.startsWith('edition-') && !record.works?.some(work => work.key === '/works/OL66554W')))
      throw new Error(`Wrong launch fixture grain: ${id}`);
    return { entry, record, bytes, externalId };
  });
}

export interface LaunchBookEdition {
  externalId: string;
  release: string;
  revision: string;
  observation: string;
  title: string;
  sourceFormat: string | null;
  /** Catalogue seeds expose their medium through release-v2.platform. */
  platform: string | null;
  format: string | null;
  language: string;
  contentLanguages: string[];
  publisher: string | null;
  publicationYear: number | null;
  realization: string | null;
  realizationRevision: string | null;
}

export interface LaunchBooksCorpus {
  recipe: typeof recipe;
  id: string;
  compatibility: LoadCompatibility;
  sources: { id: string; sha256: string; reuseBasis: string }[];
  counts: { works: 1; realizations: 1; releases: 6; contentObservations: 7; librarySlice: 0; wikidataLabels: 0; covers: 0 };
  work: string;
  editions: LaunchBookEdition[];
  backup: string;
  buildMs: number;
}

/** Writes only public Main commands. Authority setup belongs to the caller's
 * existing seed helper; no catalogue data bypasses the APIs. */
async function buildBooks(api: CorpusApi, actor: string, key: string,
  authorize: (work: string) => Promise<void>, signal: AbortSignal) {
  const sources = launchBookSources();
  const observations = new Map<string, string>();
  for (const { entry, record, bytes, externalId } of sources) {
    const result = await api.command<{ observation: { observation: string; byteDigest: string } }>(
      `${key}:source:${externalId}`, { method: 'POST', path: '/v1/sources/intakes', body: {
        profile: 'source-manual-intake-v1', provider: 'open-library',
        namespace: entry.id.startsWith('work-') ? 'work' : 'edition', externalId,
        sourceRevision: `open-library-revision:${record.revision}`, mediaType: 'application/json',
        retention: 'retained', rawBytesBase64: bytes.toString('base64'),
        coverage: { scope: 'pinned-open-library-record-v1', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'license', note: entry.reuseBasis },
      } }, signal);
    if (result.observation.byteDigest !== entry.sha256) throw new Error(`Intake digest differs: ${externalId}`);
    observations.set(externalId, result.observation.observation);
  }
  const source = sources[0]!;
  const [created] = await seedCatalogueProfileWorks(api, actor, [{ key: `${key}:OL66554W`, input: {
    profile: 'work-catalogue-import-v1', expectedWorkHead: null,
    title: source.record.title, language: 'en', aliases: [], semanticTypes: ['https://schema.org/Book'],
    credits: [], classifications: [],
    evidence: `${source.entry.requestUrl} sha256:${source.entry.sha256} observation:${observations.get('OL66554W')}`,
  } }], signal);
  if (!created) throw new Error('Books catalogue import returned no Work');
  await authorize(created.work);
  await api.command(`${key}:header`, { method: 'PUT', path: `/v1/works/${short(created.work)}/metadata`, body: {
    profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: actor,
    state: { kind: 'header', originalTitle: { value: source.record.title, language: 'en' },
      localized: [{ language: 'en', title: source.record.title, description: null, mainVersionLabel: null }] },
  } }, signal);
  const realization = `https://rezics.com/id/${stableId(`${recipe}:OL66554W:en`)}`;
  const original = await api.command<{ realization: string; revision: string }>(`${key}:original:en`, {
    method: 'PUT', path: `/v1/works/${short(created.work)}/realizations/${short(realization)}`, body: {
      profile: 'realization-v1', expectedHead: null, actingSubject: actor, id: realization,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: { kind: 'main-version', work: created.work, mainVersion: created.mainVersion, revision: created.mainRevision },
      status: 'official', verification: 'verified', evidence: observations.get('OL66554W'),
    },
  }, signal);
  const editions: LaunchBookEdition[] = [];
  for (const { externalId, record } of sources.slice(1)) {
    // This bounded source selection has only English and French records. Unknown
    // language codes must not silently become English in future selections.
    const contentLanguages = (record.languages ?? []).map(({ key: language }) => {
      if (language === '/languages/eng') return 'en';
      if (language === '/languages/fre') return 'fr';
      throw new Error(`Unmapped edition language: ${language}`);
    });
    const release = `https://rezics.com/id/${stableId(`${recipe}:${externalId}`)}`;
    const language = contentLanguages[0];
    if (!language || contentLanguages.length !== 1) throw new Error(`Unexpected pinned edition languages: ${externalId}`);
    const sourceFormat = record.physical_format ?? null;
    const platform = sourceFormat === 'Audiobook' ? 'audiobook' : sourceFormat === 'E-book' ? 'ebook' : sourceFormat;
    const publisher = record.publishers?.join('; ') ?? null;
    const publicationYear = record.publish_date ? Number(record.publish_date.slice(0, 4)) : null;
    // The French pin supplies no translator attribution. Preserve its legacy
    // release language instead of fabricating an Agent to admit v2 coverage.
    const coverage = language === 'en' ? {
      profile: 'release-v2', identifiers: [], platform, territory: null,
      coverage: [{ realization, revision: original.revision, completeness: 'complete' }],
    } : { profile: 'release-v1', contentLanguages, isTranslation: true, originalLanguages: ['en'], coverage: null };
    const written = await api.command<{ release: string; revision: string }>(`${key}:release:${externalId}`, {
      method: 'PUT', path: `/v1/works/${short(created.work)}/releases/${short(release)}`, body: {
        ...coverage, expectedHead: null, actingSubject: actor, id: release,
        kind: 'formal', status: 'official',
        titleLanguage: null, tracklistLanguage: null, title: { value: record.title, language: 'en' },
        editionStatement: record.edition_name ?? null, publisher, publicationYear,
        isbn13: record.isbn_13?.[0] ?? null, originalUrl: null, fixedRelease: null, evidence: null,
      },
    }, signal);
    if (written.release !== release) throw new Error('Release receipt differs from pinned edition identity');
    editions.push({ externalId, release, revision: written.revision, observation: observations.get(externalId)!,
      title: record.title, sourceFormat, platform, format: platform, language, contentLanguages, publisher, publicationYear,
      realization: language === 'en' ? realization : null, realizationRevision: language === 'en' ? original.revision : null });
  }
  return { work: created.work, editions };
}

/** Retain one completed API build, then restore each reader's isolated copy
 * with createCorpusBackupDriver. Source digests invalidate changed selections. */
export async function prepareLaunchBooksCorpus(input: {
  api: CorpusApi; actor: string; backups: CorpusBackupDriver; directory: string;
  authorize(work: string): Promise<void>;
}): Promise<LaunchBooksCorpus> {
  const sources = launchBookSources().map(({ entry }) => ({ id: entry.id, sha256: entry.sha256, reuseBasis: entry.reuseBasis }));
  const compatibility = loadCompatibility(root);
  const id = `launch-books-${createHash('sha256').update(JSON.stringify([recipe, sources, compatibility.digest])).digest('hex').slice(0, 20)}`;
  const directory = resolve(input.directory);
  if (!relative(root, directory).startsWith('.temp/')) throw new Error('Launch corpus must stay in this checkout .temp');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.json`);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as LaunchBooksCorpus;
    if (saved.id !== id || saved.recipe !== recipe || JSON.stringify(saved.sources) !== JSON.stringify(sources)
      || !compatibleLoadStorage(saved.compatibility, compatibility) || !existsSync(saved.backup)
      || !Number.isFinite(saved.buildMs) || saved.buildMs < 0 || saved.buildMs > budgetMs)
      throw new Error('Incompatible or incomplete launch corpus');
    console.log(JSON.stringify({ launchCorpus: id, reused: true, sources, counts: saved.counts, buildMs: Math.round(saved.buildMs) }));
    return saved;
  }
  const lock = `${path}.lock`;
  mkdirSync(lock);
  const started = performance.now();
  const signal = AbortSignal.timeout(budgetMs);
  try {
    const built = await buildBooks(input.api, input.actor, id, input.authorize, signal);
    const listed = await input.api.read<{ items: { id: string; revision: string }[]; nextCursor: string | null }>(
      `/v1/works/${short(built.work)}/releases?actingSubject=${encodeURIComponent(input.actor)}`, signal);
    if (listed.nextCursor || listed.items.length !== 6 || built.editions.some(edition =>
      !listed.items.some(item => item.id === edition.release && item.revision === edition.revision)))
      throw new Error('Launch corpus release verification differs');
    const backup = await input.backups.backup(id, signal);
    signal.throwIfAborted();
    const manifest: LaunchBooksCorpus = { recipe, id, compatibility, sources, ...built,
      counts: { works: 1, realizations: 1, releases: 6, contentObservations: 7, librarySlice: 0, wikidataLabels: 0, covers: 0 },
      backup, buildMs: performance.now() - started };
    writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    console.log(JSON.stringify({ launchCorpus: id, sources, counts: manifest.counts, buildMs: Math.round(manifest.buildMs) }));
    return manifest;
  } finally {
    rmSync(`${path}.tmp`, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function restoreLaunchBooksCorpus(corpus: LaunchBooksCorpus, target: string, backups: CorpusBackupDriver) {
  const started = performance.now();
  const signal = AbortSignal.timeout(budgetMs);
  await backups.restore(corpus.backup, target, signal);
  signal.throwIfAborted();
  const restoreMs = performance.now() - started;
  console.log(JSON.stringify({ launchCorpus: corpus.id, target, restoreMs: Math.round(restoreMs) }));
  return restoreMs;
}

/** The current browser runner owns a fresh stack. Keep that preparation
 * explicit; only the API fixture's backup driver qualifies restored copies. */
async function prepareBrowserBooks() {
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId))
    throw new Error('Browser books preparation requires an isolated QA run');
  const directory = join(root, '.temp/launch-corpus');
  const path = join(directory, `browser-${runId}.json`);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { corpus: LaunchBooksCorpus; restored: false };
    if (saved.corpus.recipe !== recipe || saved.restored !== false
      || !compatibleLoadStorage(saved.corpus.compatibility, loadCompatibility(root)))
      throw new Error('Incompatible browser books preparation');
    console.log(JSON.stringify(saved));
    return;
  }
  const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
  if (!objectDirectory) throw new Error('Browser books preparation needs the running stack object directory');
  const { grantRecordedPlatformUse } = await import('../../tests/qa/fixtures/platform-grant.ts');
  const { startMediaStack } = await import('../../tests/qa/integration/media-support.ts');
  // The source-import fixture owns its bearer independently of the website's
  // OAuth ceiling. Product records still use the same public route handlers.
  const stack = await startMediaStack('launch-books-browser-source', { library: true, profileCredits: true });
  try {
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  Object.assign(stack.env, { objectDirectory, workObjects });
  const editor = await stack.member('launch-books-browser-importer', { stable: true, verified: true });
  await grantRecordedPlatformUse(stack.accessPool, editor.principalId, ['catalogue-import']);
  for (const scope of ['work:create:root', 'work:create:catalogue-import']) await editor.grant(scope, 'work.create');
  const started = performance.now();
  const signal = AbortSignal.timeout(budgetMs);
  const api = workProfileCorpusApi('http://main.local', editor.token, { signal,
    fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
  });
  const built = await buildBooks(api, editor.actor, `browser-books:${runId}`,
    work => editor.grant(`work:edit:${work}`, 'work.edit').then(() => {}), signal);
  const listed = await api.read<{ items: { id: string; revision: string; platform: string | null }[]; nextCursor: string | null }>(
    `/v1/works/${short(built.work)}/releases?actingSubject=${encodeURIComponent(editor.actor)}`, signal);
  if (listed.nextCursor || listed.items.length !== built.editions.length || built.editions.some(edition =>
    !listed.items.some(item => item.id === edition.release && item.revision === edition.revision && item.platform === edition.platform)))
    throw new Error('Browser books release read differs from API build');
  const sources = launchBookSources().map(({ entry }) => ({ id: entry.id, sha256: entry.sha256, reuseBasis: entry.reuseBasis }));
  const corpus: LaunchBooksCorpus = { recipe, id: `browser-books-${runId}`, compatibility: loadCompatibility(root), sources,
    ...built, counts: { works: 1, realizations: 1, releases: 6, contentObservations: 7, librarySlice: 0, wikidataLabels: 0, covers: 0 },
    backup: '', buildMs: performance.now() - started };
  const prepared = { corpus, restored: false as const };
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(prepared, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  console.log(JSON.stringify(prepared));
  } finally {
    await stack.stop();
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).join() !== '--browser-prepare') throw new Error('Use --browser-prepare');
  await prepareBrowserBooks();
}
