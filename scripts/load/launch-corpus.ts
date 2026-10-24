import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Pool } from 'pg';
import type { FixtureLock } from '../fixtures/pull.ts';
import { prideEditionSet } from '../../tests/fixtures/sources/open-library.ts';
import { stableId } from '../dev/seed/state.ts';
import { appEnvironment, readEnv, replacePrivate } from '../dev/config.ts';
import { stageQaBootstrap } from '../qa/bootstrap.ts';
import { qaStackEnvironment } from '../qa/stack-environment.ts';
import { runQaStartupChildAsync } from '../qa/stack-startup.ts';
import { dockerEnvironment, stream } from '../fixture/stack.ts';
import { grantFixtureAuthority } from '../../services/main/src/modules/access/fixture-authority.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../services/main/src/modules/outbox/relay.ts';
import { seedCatalogueProfileWorks } from './catalogue-work.ts';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from './compatibility.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput } from './corpus-backup-driver.ts';
import { restoreCatalogueBackup } from './catalogue-backup.ts';
import { pollUntilDeadline } from '../qa/readiness.ts';
import { CorpusCommandError, workProfileCorpusApi, type CorpusApi, type CorpusBackupDriver } from './work-profile-corpus.ts';
import type { MediaStack } from '../../tests/qa/integration/media-support.ts';
import { importedRightsAssessments } from '../../services/main/src/modules/rights/import-policy.ts';
import type { LaunchBookEdition, LaunchBooksCorpus, LaunchRecipeRecord, LaunchRecipesCorpus } from './launch-corpus-types.ts';
export type { LaunchBookEdition, LaunchBooksCorpus, LaunchRecipeRecord, LaunchRecipesCorpus } from './launch-corpus-types.ts';

const root = resolve(import.meta.dir, '../..');
const budgetMs = 600_000;
const recipe = 'launch-books-v2';
const launchRecipesRecipe = 'launch-real-recipes-v2';
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

/** Writes only public Main commands. Authority setup belongs to the caller's
 * existing seed helper; no catalogue data bypasses the APIs. */
async function buildBooks(api: CorpusApi, actor: string, key: string,
  authorize: (work: string) => Promise<void>, authorizeRights: () => Promise<void>, signal: AbortSignal,
  nativeCatalogue = false) {
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
  const catalogueInput: Parameters<typeof seedCatalogueProfileWorks>[2][number]['input'] = {
    profile: 'work-catalogue-import-v1', expectedWorkHead: null,
    title: source.record.title, language: 'en', aliases: [], semanticTypes: ['https://schema.org/Book'],
    credits: [], classifications: [],
    evidence: `${source.entry.requestUrl} sha256:${source.entry.sha256} observation:${observations.get('OL66554W')}`,
  };
  const created = nativeCatalogue ? await (async () => {
    const candidate = await api.command<{ candidateReceipt: string }>(`${key}:candidate`, { method: 'POST',
      path: '/v1/catalogue/candidates', body: { profile: 'catalogue-candidates-v1',
        originalTitle: { value: source.record.title, language: 'en' }, aliases: [], romanizations: [],
        creators: ['Jane Austen'], dates: [], identifiers: [] } }, signal);
    return api.command<{ work: string; mainVersion: string; workRevision: string; mainRevision: string }>(`${key}:work`, {
      method: 'POST', path: '/v1/works', body: { profile: 'metadata-only-v1', authoring: 'catalogue', grain: 'new-creative-scope',
        candidateReceipt: candidate.candidateReceipt, title: source.record.title, language: 'en',
        semanticTypes: ['https://schema.org/Book'], actingSubject: actor } }, signal);
  })() : (await seedCatalogueProfileWorks(api, actor, [{ key: `${key}:OL66554W`, input: catalogueInput }], signal))[0];
  if (!created) throw new Error('Books catalogue import returned no Work');
  await authorize(created.work);
  await authorizeRights();
  if (nativeCatalogue) await api.command(`${key}:verification`, { method: 'POST',
    path: `/v1/works/${short(created.work)}/catalogue-verifications`, body: {
      expectedHead: created.workRevision, actingSubject: actor, evidence: catalogueInput.evidence,
    } }, signal);
  for (const [index, assessment] of importedRightsAssessments({ provider: 'open-library',
    url: 'https://openlibrary.org/works/OL66554W' }, created.work).entries()) {
    const assessmentKey = `${key}:rights:${index}`;
    await api.command(assessmentKey, { method: 'POST', path: '/v1/rights/use-assessments',
      body: { profile: 'rights-use-assessment-v1', actingSubject: actor, ...assessment,
        idempotencyKey: assessmentKey } }, signal);
  }
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
  return { ...created, editions };
}

/** Retain one completed API build, then restore each reader's isolated copy
 * with createCorpusBackupDriver. Source digests invalidate changed selections. */
export async function prepareLaunchBooksCorpus(input: {
  api: CorpusApi; actor: string; backups: CorpusBackupDriver; directory: string;
  authorize(work: string): Promise<void>;
  authorizeRights(): Promise<void>;
}): Promise<LaunchBooksCorpus> {
  const sources = launchBookSources().map(({ entry }) => ({ id: entry.id, sha256: entry.sha256, reuseBasis: entry.reuseBasis }));
  const compatibility = loadCompatibility(root);
  const id = `launch-books-${createHash('sha256').update(JSON.stringify([recipe, sources, compatibility.digest, 'source-rights-v1'])).digest('hex').slice(0, 20)}`;
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
    const built = await buildBooks(input.api, input.actor, id, input.authorize, input.authorizeRights, signal);
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

interface RecipeExtractPin {
  id: string;
  edition: number;
  title: string;
  sourceSha256: string;
  recipesExtracted: number;
  ingredientLineCount: number;
  fractionCount: number;
  rangeCount: number;
  twoStageCaseIds: string[];
  recipes: { id: string; titleLine: number; ingredientLines: [number, number];
    methodLines: [number, number]; caseIds: string[] }[];
}

export interface LaunchRecipeSource {
  pinId: string;
  sourceId: string;
  sourceSha256: string;
  recipeId: string;
  title: string;
  language: 'en' | 'it';
  ingredients: string[];
  methods: string[];
  caseIds: string[];
}

/** The pins name physical lines; only blank lines are excluded from each range. */
export function launchRecipeSources(): LaunchRecipeSource[] {
  const pins = JSON.parse(readFileSync(join(root, 'tests/fixtures/gutenberg/recipe-extract-pins.json'), 'utf8')) as {
    version: number; pins: RecipeExtractPin[];
  };
  const lock = JSON.parse(readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
  if (pins.version !== 1 || lock.version !== 1) throw new Error('Unsupported Gutenberg recipe pins');
  const extracted: LaunchRecipeSource[] = [];
  for (const pin of pins.pins) {
    const entry = lock.entries.find(row => row.source === 'gutenberg' && row.id === `pg${pin.edition}`);
    if (!entry || entry.reuseBasis.toLowerCase().indexOf('public-domain') < 0)
      throw new Error(`Missing public-domain Gutenberg recipe source: ${pin.edition}`);
    const bytes = readFileSync(join(root, entry.seed));
    if (bytes.byteLength !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Gutenberg recipe fixture digest mismatch: ${pin.edition}`);
    const fixture = JSON.parse(bytes.toString('utf8')) as { edition: number; sourceSha256: string; text: string };
    if (fixture.edition !== pin.edition || fixture.sourceSha256 !== pin.sourceSha256 || typeof fixture.text !== 'string')
      throw new Error(`Gutenberg recipe fixture differs from its approved pin: ${pin.edition}`);
    const lines = fixture.text.split('\n');
    for (const item of pin.recipes) {
      const [ingredientStart, ingredientEnd] = item.ingredientLines;
      const [methodStart, methodEnd] = item.methodLines;
      const ingredients = lines.slice(ingredientStart - 1, ingredientEnd).filter(line => line.trim());
      const methods = lines.slice(methodStart - 1, methodEnd).filter(line => line.trim());
      const title = lines[item.titleLine - 1]?.trim();
      if (!title || !ingredients.length || !methods.length) throw new Error(`Empty Gutenberg recipe extract: ${item.id}`);
      extracted.push({ pinId: pin.id, sourceId: entry.id, sourceSha256: fixture.sourceSha256,
        recipeId: item.id, title, language: pin.id === 'artusi' ? 'it' : 'en', ingredients,
        methods, caseIds: item.caseIds });
    }
    const sourceRecipes = extracted.filter(row => row.pinId === pin.id);
    const ingredientLines = sourceRecipes.flatMap(row => row.ingredients);
    const fractions = ingredientLines.join('\n').match(/(?:\d+\s*)?[½¼¾⅓⅔⅛⅜⅝⅞]/gu) ?? [];
    const ranges = ingredientLines.join('\n').match(/\b\d+\s+(?:to|or)\s+\d+\b/giu) ?? [];
    if (sourceRecipes.length !== pin.recipesExtracted || ingredientLines.length !== pin.ingredientLineCount
      || fractions.length !== pin.fractionCount || ranges.length !== pin.rangeCount
      || JSON.stringify(sourceRecipes.flatMap(row => row.caseIds).sort()) !== JSON.stringify([...pin.twoStageCaseIds].sort()))
      throw new Error(`Gutenberg recipe pins changed: ${pin.id}`);
  }
  if (extracted.length !== 30) throw new Error('The launch recipe corpus must contain exactly 30 extracts');
  return extracted;
}

type RecipeWorkReceipt = { work: string; workRevision: string; mainVersion: string };
type RecipeCompositionReceipt = { structure: string; revision: string };
type RecipeFileImportReceipt = { structure: string; revision: string; sourceObservation: string; replayed: boolean };


/** Create, import and publish each pin with Main commands; the input is never parsed here. */
async function buildRecipes(api: CorpusApi, actor: string, key: string,
  authorize: (scope: string, action: string) => Promise<void>,
  importFile: (key: string, actor: string, composition: RecipeCompositionReceipt,
    file: Record<string, unknown>, signal: AbortSignal) => Promise<RecipeFileImportReceipt>,
  signal: AbortSignal, sources = launchRecipeSources()) {
  await authorize(`agent:control:${actor}`, 'agent.control');
  await authorize('space:create:root', 'space.create');
  const space = await api.command<{ space: string; realm: string }>(`${key}:space`, {
    method: 'POST', path: '/v1/spaces', body: { profile: 'space-realm-v2', name: 'Recipes',
      handle: 'launch-recipes', capabilities: ['realm'], actingSubject: actor },
  }, signal);
  const zone = `https://rezics.com/id/${stableId(`${key}:zone`)}`;
  await authorize(`zone:edit:${zone}`, 'zone.edit');
  await api.command(`${key}:zone`, { method: 'POST', path: '/v1/zones', body: {
    zone, space: space.space, disclosure: 'public', actingSubject: actor,
  } }, signal);
  const zoneConfig = await api.read<{ revision: string }>(
    `/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(actor)}`, signal);
  await api.command(`${key}:zone-default-realm`, { method: 'PUT', path: `/v1/zones/${short(zone)}/configuration`,
    body: { expectedHead: zoneConfig.revision, defaultRealm: space.realm, actingSubject: actor },
  }, signal);

  await authorize('work:create:root', 'work.create');
  await authorize('catalogue:verify:root', 'catalogue.verify');
  await authorize('rights:assess', 'rights.assess');
  await authorize(`submission:submit:${space.realm}`, 'submission.submit');
  await authorize(`publication:adopt:${space.realm}`, 'publication.adopt');
  await authorize(`review:decide:${space.realm}`, 'review.decide');

  const records: LaunchRecipeRecord[] = [];
  for (const source of sources) {
    signal.throwIfAborted();
    const credit = source.pinId === 'artusi' ? 'Pellegrino Artusi' : 'Fannie Merritt Farmer';
    const sourceUrl = `https://www.gutenberg.org/ebooks/${source.sourceId.replace(/^pg/, '')}`;
    const candidates = await api.command<{ candidateReceipt: string }>(`${key}:candidate:${source.pinId}:${source.recipeId}`, {
      method: 'POST', path: '/v1/catalogue/candidates', body: { profile: 'catalogue-candidates-v1',
        originalTitle: { value: source.title, language: source.language }, aliases: [], romanizations: [],
        creators: [credit], dates: [], identifiers: [] },
    }, signal);
    const work = await api.command<RecipeWorkReceipt>(`${key}:work:${source.pinId}:${source.recipeId}`, {
      method: 'POST', path: '/v1/works', body: { profile: 'metadata-only-v1', authoring: 'catalogue', grain: 'new-creative-scope',
        candidateReceipt: candidates.candidateReceipt, title: source.title, language: source.language,
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: actor },
    }, signal);
    await authorize(`work:edit:${work.work}`, 'recipe.edit');
    await authorize(`work:edit:${work.work}`, 'work.edit');
    await authorize(`work:read:${work.work}`, 'work.read');
    const composition = await api.command<RecipeCompositionReceipt>(
      `${key}:composition:${source.pinId}:${source.recipeId}`, { method: 'POST', path: '/v1/compositions',
        body: { profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: actor },
      }, signal);
    const file: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'Recipe',
      name: source.title, inLanguage: source.language, url: sourceUrl, author: { '@type': 'Person', name: credit },
      license: 'https://www.gutenberg.org/policy/license.html',
      isBasedOn: { url: sourceUrl, sourceSha256: source.sourceSha256, recipeId: source.recipeId },
      recipeIngredient: source.ingredients,
      recipeInstructions: source.methods.map(text => ({ '@type': 'HowToStep', text, inLanguage: source.language })) };
    const imported = await importFile(`${key}:file:${source.pinId}:${source.recipeId}`,
      actor, composition, file, signal);
    for (const [index, assessment] of importedRightsAssessments({ provider: 'project-gutenberg',
      url: `https://www.gutenberg.org/ebooks/${source.sourceId.replace(/^pg/, '')}`, credit }, work.work, true).entries()) {
      const assessmentKey = `${key}:rights:${source.pinId}:${source.recipeId}:${index}`;
      await api.command(assessmentKey, { method: 'POST', path: '/v1/rights/use-assessments',
        body: { profile: 'rights-use-assessment-v1', actingSubject: actor, ...assessment,
          evidence: { ...assessment.evidence, sourceDigest: source.sourceSha256, recipeId: source.recipeId },
          idempotencyKey: assessmentKey } }, signal);
    }

    await api.command(`${key}:verification:${source.pinId}:${source.recipeId}`, {
      method: 'POST', path: `/v1/works/${short(work.work)}/catalogue-verifications`, body: {
        expectedHead: work.workRevision, actingSubject: actor,
        evidence: `${sourceUrl} sha256:${source.sourceSha256} observation:${imported.sourceObservation}` },
    }, signal);
    await authorize(`work:publish:${work.work}`, 'work.publish');
    await api.command(`${key}:publication:${source.pinId}:${source.recipeId}`, {
      method: 'POST', path: '/v1/work-publications', body: { profile: 'work-structure-publication-v1', operation: 'publish',
        work: work.work, expectedWorkHead: work.workRevision, expectedMainVersion: work.mainVersion,
        structure: composition.structure, expectedStructureHead: imported.revision,
        expectedPublicationHead: null, rightsBasis: 'public-domain', sourceObservation: imported.sourceObservation,
        disclosure: 'public', actingSubject: actor },
    }, signal);
    type Submission = { submission: { id: string; state: string; revision: string } };
    const submitted = await api.command<Submission>(`${key}:submission:${source.pinId}:${source.recipeId}`, {
      method: 'POST', path: `/v1/realms/${short(space.realm)}/submissions`, body: {
        kind: 'work', work: work.work, mainVersion: work.mainVersion,
        workRevision: work.workRevision, actingSubject: actor },
    }, signal);
    const accepted = submitted.submission.state === 'pending' ? await api.command<Submission>(
      `${key}:adoption:${source.pinId}:${source.recipeId}`, { method: 'POST',
        path: `/v1/realms/${short(space.realm)}/submissions/${submitted.submission.id}/decisions`, body: {
          actingSubject: actor, expectedRevision: submitted.submission.revision, outcome: 'accept',
          expectedSelectionHead: null, publicReason: null, internalNote: null } }, signal) : submitted;
    if (accepted.submission.state !== 'accepted') throw new Error('Recipe Work adoption is incomplete');
    records.push({ recipeId: source.recipeId, pinId: source.pinId, title: source.title,
      language: source.language, caseIds: source.caseIds, sourceIngredients: source.ingredients,
      sourceMethods: source.methods, work: work.work, mainVersion: work.mainVersion,
      structure: composition.structure, revision: imported.revision });
  }
  return { realm: space.realm, realmHandle: 'launch-recipes' as const, zone, records };
}

/** All Recipe corpus access comes through the guarded fixture authority helper. */
export async function grantLaunchRecipeAuthority(pool: Pool, principalId: string, actor: string,
  scope: string, action: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lifetime = action === 'agent.control' ? 'infinity' : '8 hours';
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime }],
      grant: { actor, action, lifetime, requireSelfIssuer: true } });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function launchRecipeSourcesManifest() {
  const lock = JSON.parse(readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
  return launchRecipeSources().map(source => {
    const entry = lock.entries.find(row => row.source === 'gutenberg' && row.id === source.sourceId);
    if (!entry) throw new Error(`Missing Gutenberg recipe lock entry: ${source.sourceId}`);
    return { id: entry.id, sha256: entry.sha256, reuseBasis: entry.reuseBasis };
  }).filter((entry, index, all) => all.findIndex(candidate => candidate.id === entry.id) === index);
}

const launchRecipeCounts: LaunchRecipesCorpus['counts'] = { works: 30, recipes: 30,
  ingredientLines: 173, fractionLines: 47, rangeLines: 2, englishRecipes: 20, italianRecipes: 10 };

function launchRecipesIdentity(sources: LaunchRecipesCorpus['sources'], compatibility: LoadCompatibility): string {
  return `launch-recipes-${createHash('sha256')
    .update(JSON.stringify([launchRecipesRecipe, sources, compatibility.digest, 'sourced-structure-publication-v2'])).digest('hex').slice(0, 20)}`;
}

function launchRecipesManifestPath(directory: string, id: string): string {
  const resolvedDirectory = resolve(directory);
  if (!relative(root, resolvedDirectory).startsWith('.temp/'))
    throw new Error('Launch corpus must stay in this checkout .temp');
  return join(resolvedDirectory, `${id}.json`);
}

/** Read the retained API-built corpus without starting an importer or issuing commands. */
export function loadLaunchRecipesCorpus(directory = join(root, '.temp/launch-corpus/recipes/manifests')): LaunchRecipesCorpus {
  const sources = launchRecipeSourcesManifest();
  const compatibility = loadCompatibility(root);
  const id = launchRecipesIdentity(sources, compatibility);
  const path = launchRecipesManifestPath(directory, id);
  if (!existsSync(path)) throw new Error(`Launch recipes corpus is not built; run bun scripts/load/launch-corpus.ts --recipes-build`);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as LaunchRecipesCorpus;
  const backup = resolve(saved.backup ?? '');
  if (saved.id !== id || saved.recipe !== launchRecipesRecipe || JSON.stringify(saved.sources) !== JSON.stringify(sources)
    || !compatibleLoadStorage(saved.compatibility, compatibility) || !relative(root, backup).startsWith('.temp/')
    || !existsSync(backup) || JSON.stringify(saved.counts) !== JSON.stringify(launchRecipeCounts)
    || !Array.isArray(saved.records) || saved.records.length !== 30
    || !Number.isFinite(saved.buildMs) || saved.buildMs < 0 || saved.buildMs > budgetMs)
    throw new Error('Incompatible or incomplete launch recipes corpus');
  return saved;
}

export async function prepareLaunchRecipesCorpus(input: {
  api: CorpusApi;
  actor: string;
  backups: CorpusBackupDriver;
  directory: string;
  authorize(scope: string, action: string): Promise<void>;
  importFile(key: string, actor: string, composition: RecipeCompositionReceipt,
    file: Record<string, unknown>, signal: AbortSignal): Promise<RecipeFileImportReceipt>;
  /** Startup and additional native preparation consume the same preparation budget. */
  preparationStartedAt?: number;
}): Promise<LaunchRecipesCorpus> {
  const sources = launchRecipeSourcesManifest();
  const compatibility = loadCompatibility(root);
  const id = launchRecipesIdentity(sources, compatibility);
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true });
  const path = launchRecipesManifestPath(directory, id);
  if (existsSync(path)) {
    const saved = loadLaunchRecipesCorpus(directory);
    console.log(JSON.stringify({ launchCorpus: id, reused: true, sources, counts: saved.counts,
      buildMs: Math.round(saved.buildMs) }));
    return saved;
  }
  const lock = `${path}.lock`;
  mkdirSync(lock);
  const started = input.preparationStartedAt ?? performance.now();
  const remaining = Math.floor(budgetMs - (performance.now() - started));
  const signal = AbortSignal.timeout(Math.max(1, remaining));
  try {
    if (remaining <= 0) throw new Error('Launch recipes exhausted the preparation budget before native creation');
    const built = await buildRecipes(input.api, input.actor, id, input.authorize, input.importFile, signal);
    const backup = await input.backups.backup(id, signal);
    signal.throwIfAborted();
    const manifest: LaunchRecipesCorpus = { recipe: launchRecipesRecipe, id, compatibility, sources,
      ...built, counts: launchRecipeCounts, backup,
      buildMs: performance.now() - started };
    writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    console.log(JSON.stringify({ launchCorpus: id, sources, counts: manifest.counts,
      buildMs: Math.round(manifest.buildMs) }));
    return manifest;
  } finally {
    rmSync(`${path}.tmp`, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function restoreLaunchRecipesCorpus(corpus: LaunchRecipesCorpus, target: string,
  backups: CorpusBackupDriver) {
  const started = performance.now();
  const signal = AbortSignal.timeout(budgetMs);
  await backups.restore(corpus.backup, target, signal);
  signal.throwIfAborted();
  const restoreMs = performance.now() - started;
  console.log(JSON.stringify({ launchCorpus: corpus.id, target, restoreMs: Math.round(restoreMs) }));
  return restoreMs;
}

/** A restored graph cut includes the cutover's Main events. Deliver their
 * retained envelopes before proving browse coverage; a graph scan cannot
 * acknowledge the relay owner's stream on its behalf. */
export async function prepareRestoredRecipeBrowse(stack: MediaStack, signal: AbortSignal): Promise<void> {
  const { relayPool, relayConsumer, zoneBrowse } = stack.composition;
  if (!relayPool || !relayConsumer || !zoneBrowse)
    throw new Error('Restored recipes have no Main relay or Zone browse projection');
  await initializeRelayCheckpoint(relayPool, relayConsumer, stack.env.lineage.dataEpoch);
  for (let batch = 0; batch < 1024; batch++) {
    signal.throwIfAborted();
    const delivered = await relayMainOutboxOnce(stack.fuseki, relayPool, relayConsumer,
      { ownerOutbox: stack.env.receiptCustody });
    if (!delivered) {
      await zoneBrowse.backfill();
      signal.throwIfAborted();
      return;
    }
  }
  throw new Error('Restored recipes Main relay exceeded its preparation budget');
}

async function buildRecipesApiBackup(withBook = false) {
  const preparationStartedAt = performance.now();
  const corpusDirectory = join(root, '.temp/launch-corpus', withBook ? 'book-recipes' : 'recipes');
  const directory = join(corpusDirectory, 'manifests');
  const sources = launchRecipeSourcesManifest();
  const compatibility = loadCompatibility(root);
  const id = launchRecipesIdentity(sources, compatibility);
  const manifestPath = launchRecipesManifestPath(directory, id);
  if (existsSync(manifestPath)) {
    if (withBook) throw new Error('Book/Recipe preparation already retained; inspect its actual preparation.json and restore that cut instead of replaying native creation');
    const corpus = loadLaunchRecipesCorpus(directory);
    console.log(JSON.stringify({ launchCorpus: corpus.id, reused: true, sources: corpus.sources,
      counts: corpus.counts, buildMs: Math.round(corpus.buildMs) }));
    return corpus;
  }

  const sourceRunId = `recipes-build-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const evidence = join(corpusDirectory, 'attempts', sourceRunId);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const record = (value: unknown) => appendFileSync(join(evidence, 'commands.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(evidence, 'execution.json'), JSON.stringify({ format: 'audit-execution-v1',
    productBaseline: '69eac3ceeaf885be70205a70248bc951e9d81cc9', productRevision: revision,
    testRevision: revision, fixtureGeneration: sourceRunId, frontendRevision: revision,
    preparationStartedAt: new Date().toISOString(), assertionsReached: false }, null, 2) + '\n', { mode: 0o600 });
  const environment = qaStackEnvironment({ ...process.env, REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa', REZICS_STACK_RAW_UPDATE: '0' }, 'scale', 'catalogue-disk');
  const resetSourceStack = async () => {
    const reset = await runQaStartupChildAsync(root,
      ['stack:reset', '--profile', 'qa', '--run-id', sourceRunId, '--persistent'], 180_000, environment);
    if (!reset.ok) throw new Error(`Launch recipes source stack cleanup failed: ${reset.output.slice(-2000)}`);
  };
  const started = await runQaStartupChildAsync(root,
    ['stack:up', '--profile', 'qa', '--run-id', sourceRunId, '--persistent'], 180_000, environment);
  if (!started.ok) {
    await resetSourceStack();
    throw new Error(`Launch recipes source stack failed: ${started.output.slice(-2000)}`);
  }

  let sourceEnvironment: NodeJS.ProcessEnv;
  let previous: Map<string, string | undefined>;
  try {
    const stackDirectory = join(root, '.temp/stack', `rezics-qa-${sourceRunId}`);
    const compose = readEnv(join(stackDirectory, 'compose.env'));
    if (compose.REZICS_STACK_STORAGE !== 'persistent' || compose.REZICS_STACK_RAW_UPDATE !== '0')
      throw new Error('Launch recipes build requires a persistent command-only QA stack');
    const staged = stageQaBootstrap(stackDirectory);
    await stream('bun', staged.args, { ...environment, ...staged.apps }, undefined, 180_000);
    sourceEnvironment = { ...environment, ...readEnv(join(stackDirectory, 'apps.env')),
      REZICS_QA_RUN_ID: sourceRunId, REZICS_QA_STACK_MODE: 'scale',
      REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
    previous = new Map(Object.keys(sourceEnvironment).map(key => [key, Bun.env[key]]));
    Object.assign(Bun.env, sourceEnvironment);
  } catch (error) {
    await resetSourceStack();
    throw error;
  }

  let source: MediaStack | undefined;
  let relay: Pool | undefined;
  let sourceClosed = false;
  let relayClosed = false;
  let corpus: (Pick<LaunchRecipesCorpus, 'id' | 'realm' | 'backup' | 'buildMs' | 'records' | 'sources'>
    & { counts: Record<string, number> }) | undefined;
  let driver: ReturnType<typeof createCorpusBackupDriver> | undefined;
  let failure: unknown;
  let closePersonas: (() => Promise<void>) | undefined;
  try {
    const { startMediaStack } = await import('../../tests/qa/integration/media-support.ts');
    source = await startMediaStack('launch-recipes-api-source', { library: true, profileCredits: true });
    const workObjects = source.objects('semantic/work/');
    const structureObjects = source.objects('semantic/structure/');
    await Promise.all([workObjects.initialize(), structureObjects.initialize()]);
    Object.assign(source.env, { objectDirectory: sourceEnvironment.MAIN_OBJECT_DIRECTORY!, workObjects, structureObjects });
    relay = new Pool({ connectionString: sourceEnvironment.ACCOUNT_RELAY_DATABASE_URL });

    const openCopy = async (input: CorpusRestoreSmokeInput) => {
      const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId, REZICS_QA_STACK_MODE: 'scale',
        REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      const saved = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
      Object.assign(Bun.env, env);
      let stack: MediaStack | undefined;
      try {
        const opened = await startMediaStack('launch-recipes-build-smoke', { library: true, ownerUrls: {
          access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
          relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
        } });
        stack = opened;
        const readinessStarted = performance.now();
        await prepareRestoredRecipeBrowse(opened, input.signal);
        input.signal.throwIfAborted();
        console.log(JSON.stringify({ launchCorpus: corpus!.id, stage: 'restored-zone-browse-readiness',
          readinessMs: Math.round(performance.now() - readinessStarted) }));
        const importer = await opened.member('launch-recipes-importer', { stable: true, verified: true });
        const api = workProfileCorpusApi('http://main.local', importer.token, {
          fetch: (async (request, init) => opened.main.handle(new Request(request, init))) as typeof fetch,
        });
        const page = await api.read<{ items: { id: string }[]; nextCursor: string | null }>(
          `/v1/realms/${short(corpus!.realm)}/modules/browse?limit=20`);
        const expected = withBook ? corpus!.records.length : 20;
        if (page.items.length !== expected || (withBook ? page.nextCursor !== null : !page.nextCursor))
          throw new Error('Restored recipes backup did not expose its first complete browse page');
        return { stack: opened, stop: async () => opened.stop() };
      } catch (error) {
        await stack?.stop();
        throw error;
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
        }
      }
    };

    const importer = await source.member('launch-recipes-importer', { stable: true, verified: true });
    const { grantRecordedPlatformUse } = await import('../../tests/qa/fixtures/platform-grant.ts');
    await grantRecordedPlatformUse(source.accessPool, importer.principalId, ['catalogue-import']);
    await initializeRelayCheckpoint(relay, sourceEnvironment.MAIN_RELAY_CONSUMER!, source.env.lineage.dataEpoch);
    let api = workProfileCorpusApi('http://main.local', importer.token, {
      fetch: (async (request, init) => {
        for (let attempt = 0; ; attempt++) {
          init?.signal?.throwIfAborted();
          const requestedAt = new Date().toISOString();
          const response = await source!.main.handle(new Request(request, init));
          record({ requestedAt, answeredAt: new Date().toISOString(), method: init?.method ?? 'GET',
            path: new URL(String(request)).pathname + new URL(String(request)).search,
            key: new Headers(init?.headers).get('idempotency-key'),
            request: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
            response: { status: response.status, body: await response.clone().text() } });
          if (response.status !== 202 || attempt === 2) return response;
          const pending = await response.json() as { retry?: { allowed?: boolean; afterMs?: number } };
          if (!pending.retry?.allowed) throw new Error('Recipe corpus command cannot be retried');
          await Bun.sleep(Math.min(1000, Math.max(0, pending.retry.afterMs ?? 1000)));
        }
      }) as typeof fetch,
    });
    driver = createCorpusBackupDriver({ sourceRunId,
      directory: join(corpusDirectory, 'backups'), resumeSource: false,
      async quiesce(signal) {
        signal.throwIfAborted();
        await closePersonas?.();
        closePersonas = undefined;
        await relay!.end();
        relayClosed = true;
        await source!.stop();
        sourceClosed = true;
      },
      async smokeRead(input) {
        const copy = await openCopy(input);
        return async () => copy.stop();
      },
    });
    let actor = importer.actor;
    let authorize = (scope: string, action: string) => grantLaunchRecipeAuthority(source!.accessPool,
      importer.principalId, actor, scope, action);
    if (withBook) {
      const { personaSessions, retainPersonaRealm } = await import('../../tests/qa/support/personas.ts');
      let people: Awaited<ReturnType<typeof personaSessions>> | undefined;
      people = await personaSessions('public', { observeMain: async answer => {
        record({ persona: answer.caller.actingSubject, request: answer.request, response: answer.response,
          requestStartedAt: answer.requestStartedAt, answeredAt: answer.answeredAt });
        if (people && answer.request.method === 'POST' && answer.request.key) {
          const id = createHash('sha256').update(answer.request.key).digest('hex');
          const receipts = join(evidence, 'receipts');
          mkdirSync(receipts, { recursive: true, mode: 0o700 });
          const persona = (['owner', 'stranger', 'member', 'moderator', 'operator'] as const)
            .find(name => people![name].actingSubject === answer.caller.actingSubject);
          let observed: unknown;
          try { observed = JSON.parse(answer.response.body); } catch { observed = answer.response.body; }
          writeFileSync(join(receipts, `${id}.json`), JSON.stringify({ id, phase: 'prepare',
            method: answer.request.method, path: answer.request.path, key: answer.request.key,
            body: answer.request.body, status: answer.response.status, answer: observed,
            startedAt: answer.requestStartedAt, finishedAt: answer.answeredAt,
            caller: { realm: people.realm, persona, accountId: answer.caller.accountId,
              actingSubject: answer.caller.actingSubject } }, null, 2) + '\n', { mode: 0o600 });
        }
      } });
      const owner = people.owner;
      actor = owner.actingSubject!;
      closePersonas = people.close;
      writeFileSync(join(evidence, 'personas.json'), JSON.stringify(retainPersonaRealm(people), null, 2) + '\n', { mode: 0o600 });
      const principal = await source.accessPool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject=$1', [owner.accountId]);
      if (principal.rows.length !== 1) throw new Error('Book/Recipe owner needs its actual provisioned principal');
      await grantRecordedPlatformUse(source.accessPool, principal.rows[0]!.id, ['catalogue-import']);
      const platform = await source.accessPool.query(`SELECT g.id, g.issuer_subject, g.principal_id, g.scope_id,
        g.action, g.generation, g.active, g.valid_until, e.receipt FROM access.principal_permission_grant g
        JOIN access.platform_grant_episode e ON e.principal_grant_id=g.id
        WHERE g.principal_id=$1 AND g.scope_id='platform:access' AND g.action='platform:use:catalogue-import'`,
      [principal.rows[0]!.id]);
      record({ fixturePlatformUse: platform.rows, accountId: owner.accountId, actingSubject: actor });
      authorize = async (scope, action) => {
        const client = await source!.accessPool.connect();
        try {
          await client.query('BEGIN');
          const result = await grantFixtureAuthority(client, { scope, requireDispatch: true,
            representations: [{ principalId: principal.rows[0]!.id, actor, action, lifetime: '8 hours' }],
            grant: { actor, action, lifetime: '8 hours', requireSelfIssuer: true } });
          await client.query('COMMIT');
          record({ fixtureAuthority: { realm: people!.realm, persona: 'owner', accountId: owner.accountId,
            actingSubject: actor, scope, action, lifetime: '8 hours', result } });
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      };
      api = {
        async command<T>(commandKey: string, command: Parameters<CorpusApi['command']>[1], signal?: AbortSignal) {
          signal?.throwIfAborted();
          const response = await owner.main(command.method, command.path, command.body, commandKey);
          const raw = await response.text();
          if (![200, 201, 204].includes(response.status))
            throw new CorpusCommandError(commandKey, `${command.method} ${command.path}`, command.stage, response.status, raw);
          signal?.throwIfAborted();
          return response.status === 204 ? undefined as T : JSON.parse(raw) as T;
        },
        async read<T>(path: `/v1/${string}`, signal?: AbortSignal) {
          signal?.throwIfAborted();
          const response = await owner.main('GET', path), raw = await response.text();
          if (!response.ok) throw new Error(`Book/Recipe read ${path} returned HTTP ${response.status}: ${raw}`);
          signal?.throwIfAborted();
          return JSON.parse(raw) as T;
        },
      };
      for (const scope of ['work:create:root', 'work:create:catalogue-import']) await authorize(scope, 'work.create');
      await authorize('catalogue:verify:root', 'catalogue.verify');
      const remaining = Math.floor(budgetMs - (performance.now() - preparationStartedAt));
      if (remaining <= 0) throw new Error('Book/Recipe preparation exhausted its budget during startup');
      const signal = AbortSignal.timeout(remaining);
      const book = await buildBooks(api, actor, `book-recipes:${sourceRunId}`, async work => {
        await authorize(`work:edit:${work}`, 'work.edit');
        await authorize(`work:read:${work}`, 'work.read');
      }, () => authorize('rights:assess', 'rights.assess'), signal, true);
      const { prepareLaunchBookReading } = await import('./launch-book-reading.ts');
      const reading = await prepareLaunchBookReading({ api, actor, token: '', book, authorize, signal });
      const anonymous: Record<string, unknown> = {};
      for (const [name, path] of Object.entries({ header: `/v1/works/${short(book.work)}?language=en`,
        contents: `/v1/works/${short(book.work)}/contents?language=en&limit=20`,
        releases: `/v1/works/${short(book.work)}/releases?limit=20` })) {
        signal.throwIfAborted();
        const response = await people.visitor.main('GET', path), raw = await response.text();
        if (response.status !== 200) throw new Error(`Prepared public Book ${name} returned HTTP ${response.status}: ${raw}`);
        anonymous[name] = JSON.parse(raw);
      }
      writeFileSync(join(evidence, 'book.json'), JSON.stringify({ ...book, ...reading, anonymous }, null, 2) + '\n', { mode: 0o600 });
    }
    const importFile = async (key: string, actor: string, composition: RecipeCompositionReceipt,
      file: Record<string, unknown>, signal: AbortSignal): Promise<RecipeFileImportReceipt> => {
        const sourceUrl = String(file.url);
        const retained = await api.command<{ observation: { observation: string } }>(`${key}:source`, {
          method: 'POST', path: '/v1/sources/intakes', body: { profile: 'source-manual-intake-v1',
            provider: 'gutenberg', namespace: 'recipe-extract',
            externalId: `${sourceUrl.split('/').at(-1)}/${(file.isBasedOn as { recipeId: string }).recipeId}`,
            sourceRevision: (file.isBasedOn as { sourceSha256: string }).sourceSha256,
            mediaType: 'application/ld+json', retention: 'retained',
            rawBytesBase64: Buffer.from(JSON.stringify(file)).toString('base64'),
            coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
            rightsEvidence: { basis: 'public-domain', note: `Pinned Project Gutenberg extract; ${sourceUrl}` } },
        }, signal);
        const imported = await api.command<{ revision: string }>(key, {
          method: 'POST', path: `/v1/recipes/${short(composition.structure)}/imports`, body: {
            actingSubject: actor, expectedHead: composition.revision,
            sourceObservation: retained.observation.observation },
        }, signal);
        return { structure: composition.structure, revision: imported.revision,
          sourceObservation: retained.observation.observation, replayed: false };
      };
    if (withBook) {
      // The observed thirty-recipe attempt exhausted 600 seconds before backup.
      // Keep a genuine small cut through the same native owner without claiming
      // the full launch manifest or changing its thirty-recipe contract.
      const selected = launchRecipeSources().filter(row => row.pinId === 'artusi' && row.recipeId === 'passatelli-di-carne');
      if (selected.length !== 1) throw new Error('Missing exact pinned Artusi delivery source');
      const remaining = Math.floor(budgetMs - (performance.now() - preparationStartedAt));
      if (remaining <= 0) throw new Error('Book/Recipe preparation exhausted its budget before Recipe creation');
      const signal = AbortSignal.timeout(remaining);
      const sliceId = `launch-book-recipe-${createHash('sha256').update(JSON.stringify({
        recipes: id, book: '6f7ec2a018dd7b7ddaed1e6117e299c25945faa082880fe63fb0b51a722b7ccb',
        selected: selected.map(row => [row.pinId, row.recipeId, row.sourceSha256]),
      })).digest('hex').slice(0, 20)}`;
      const built = await buildRecipes(api, actor, sliceId, authorize, importFile, signal, selected);
      const backup = await driver.backup(sliceId, signal);
      signal.throwIfAborted();
      corpus = { ...built, id: sliceId, backup, sources, buildMs: performance.now() - preparationStartedAt,
        counts: { works: 2, books: 1, recipes: 1, chapters: 5, releases: 6,
          ingredientLines: selected[0]!.ingredients.length, methodLines: selected[0]!.methods.length } };
    } else {
      const complete = await prepareLaunchRecipesCorpus({ api, actor, backups: driver,
        directory, preparationStartedAt, authorize, importFile });
      if (JSON.stringify(complete.counts) !== JSON.stringify(launchRecipeCounts) || complete.records.length !== 30)
        throw new Error('Launch recipes API build returned an incomplete corpus');
      corpus = complete;
    }
  } catch (error) {
    failure = error;
    record({ stage: 'preparation-failed', assertionsReached: false,
      elapsedMs: performance.now() - preparationStartedAt, error: error instanceof Error ? error.stack : String(error) });
  } finally {
    const cleanup: unknown[] = [];
    if (closePersonas) { try { await closePersonas(); } catch (error) { cleanup.push(error); } }
    if (!relayClosed && relay) { try { await relay.end(); } catch (error) { cleanup.push(error); } }
    if (!sourceClosed && source) { try { await source.stop(); } catch (error) { cleanup.push(error); } }
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    try { await resetSourceStack(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) failure = failure === undefined
      ? new AggregateError(cleanup, 'Launch recipes API build cleanup failed')
      : new AggregateError([failure, ...cleanup], 'Launch recipes API build and cleanup failed', { cause: failure });
  }
  if (failure !== undefined) throw failure;
  if (!corpus || !driver) throw new Error('Launch recipes API build did not retain its corpus');
  writeFileSync(join(evidence, 'preparation.json'), JSON.stringify({ sourceRunId, manifest: withBook ? null : manifestPath,
    backup: corpus.backup, preparationMs: corpus.buildMs, recipeWorks: corpus.records.map(row => row.work),
    book: withBook ? join(evidence, 'book.json') : null, personas: withBook ? join(evidence, 'personas.json') : null,
    execution: join(evidence, 'execution.json'), commands: join(evidence, 'commands.jsonl'),
    readyPublicDomainManifest: false, assertionsReached: false,
    pending: withBook ? ['reviewed rich-recipe occurrence/measure correspondence', 'qualified per-recipe nutrition matrix',
      'publicDomain consumer projection and independent admission review', 'original113 compatible topology copy'] : [],
  }, null, 2) + '\n', { mode: 0o600 });
  const target = `launch-recipes-smoke-${sourceRunId}`;
  try {
    await driver.restore(corpus.backup, target, AbortSignal.timeout(budgetMs));
    writeFileSync(join(evidence, 'restore.json'), JSON.stringify({ backup: corpus.backup, target,
      preparation: driver.preparation(target) }, null, 2) + '\n', { mode: 0o600 });
  } finally { await driver.stop(target); }
  console.log(JSON.stringify({ launchCorpus: corpus.id, sources: corpus.sources, counts: corpus.counts,
    buildMs: Math.round(corpus.buildMs), backup: corpus.backup }));
  return corpus;
}

/** Repair an interrupted retained PostgreSQL cut without issuing recipe commands. */
async function recoverRecipesApiBackup() {
  const corpus = loadLaunchRecipesCorpus();
  const directory = join(root, '.temp/launch-corpus/recipes/consistent-backups');
  const manifestPath = join(root, '.temp/launch-corpus/recipes/manifests', `${corpus.id}.json`);
  if (relative(directory, corpus.backup) === join(corpus.id, 'backup.json')) {
    console.log(JSON.stringify({ launchCorpus: corpus.id, consistentBackup: true, reused: true }));
    return;
  }
  const runId = `recipes-recover-${Date.now().toString(36)}`;
  const target = `launch-recipes-${runId}`;
  const signal = AbortSignal.timeout(budgetMs);
  let recovered: CorpusRestoreSmokeInput | undefined;
  const started = performance.now();
  const driver = createCorpusBackupDriver({ sourceRunId: runId, directory, resumeSource: false,
    restoreResourceClass: 'ordinary',
    async quiesce() { throw new Error('The recovery restorer does not capture its empty source'); },
    async smokeRead(copy) {
      copy.signal.throwIfAborted();
      const pool = new Pool({ connectionString: copy.apps.ACCESS_DATABASE_URL, max: 1,
        connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
      try {
        const state = await pool.query<{ recovering: boolean }>('SELECT pg_is_in_recovery() AS recovering');
        if (state.rows[0]?.recovering !== false) throw new Error('Retained PostgreSQL recovery is incomplete');
      } finally { await pool.end(); }
      recovered = copy;
    },
  }, {
    restoreCatalogueBackup: (backup, copyRunId, options) => restoreCatalogueBackup(backup, copyRunId, {
      ...options,
      async task(args) {
        if (args[0] !== 'stack:up') return await stream('task', args, dockerEnvironment(), undefined, budgetMs, signal);
        const startup = await runQaStartupChildAsync(root, args.filter(arg => arg !== '--'), 180_000,
          { ...dockerEnvironment(), REZICS_STACK_PROFILE: 'qa' });
        if (startup.ok) return startup.output;
        signal.throwIfAborted();
        // This one-time repair keeps the interrupted copy running until crash recovery finishes.
        if (!startup.output.includes('postgres') || !startup.output.includes('unhealthy'))
          throw new Error(`Retained recovery startup failed: ${startup.output.slice(-2000)}`);
        const apps = readEnv(join(root, '.temp/stack', `rezics-qa-${copyRunId}`, 'apps.env'));
        const pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1,
          connectionTimeoutMillis: 2_000, query_timeout: 2_000 });
        try {
          const ready = await pollUntilDeadline(async () => {
            signal.throwIfAborted();
            try {
              const state = await pool.query<{ recovering: boolean }>('SELECT pg_is_in_recovery() AS recovering');
              return state.rows[0]?.recovering === false;
            } catch { return false; }
          }, Date.now() + Math.max(1, budgetMs - (performance.now() - started)), 1000);
          if (!ready) throw new Error('Retained PostgreSQL recovery exceeded 600 seconds');
        } finally { await pool.end(); }
        console.log(JSON.stringify({ stage: 'retained-postgres-recovery-complete', copyRunId,
          elapsedMs: Math.round(performance.now() - started) }));
        return startup.output;
      },
    }),
  });
  try {
    await driver.restore(corpus.backup, target, signal);
    if (!recovered) throw new Error('Retained recovery copy did not become ready');
    const capture = createCorpusBackupDriver({ sourceRunId: recovered.runId, directory, resumeSource: false,
      async quiesce() { signal.throwIfAborted(); },
      async smokeRead() { throw new Error('The recovery capture does not start another copy'); },
    });
    const backup = await capture.backup(corpus.id, signal);
    const saved = { ...corpus, backup };
    const recovery = { launchCorpus: corpus.id, previousBackup: corpus.backup, backup,
      preparation: driver.preparation(target), totalMs: Math.round(performance.now() - started) };
    writeFileSync(join(directory, `${corpus.id}-recovery.json`), JSON.stringify(recovery, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(`${manifestPath}.tmp`, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${manifestPath}.tmp`, manifestPath);
    console.log(JSON.stringify(recovery));
  } finally { await driver.stop(target); }
}

/** Browser and API proofs restore the same retained command-built owner stores. */
export async function restoreBrowserRecipes(input: { runId: string; webOrigin: string; accountsPort: string }) {
  const { runId } = input;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId))
    throw new Error('Browser recipes restore requires an isolated QA run');
  const corpus = loadLaunchRecipesCorpus();
  const directory = join(root, '.temp/launch-corpus');
  const path = join(directory, `browser-recipes-${runId}.json`);
  if (existsSync(path)) throw new Error('Browser recipe restore evidence already exists');
  const target = `launch-recipes-${runId}-browser`;
  let copy: CorpusRestoreSmokeInput | undefined;
  const { startMediaStack } = await import('../../tests/qa/integration/media-support.ts');
  const driver = createCorpusBackupDriver({ sourceRunId: runId,
    directory: join(root, '.temp/launch-corpus/recipes/backups'), resumeSource: false,
    async quiesce() { throw new Error('Browser recipe QA restores a retained corpus and never backs it up'); },
    async smokeRead(restored) {
      copy = restored;
      const env = { ...restored.apps, REZICS_QA_RUN_ID: restored.runId, REZICS_QA_STACK_MODE: 'scale',
        REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
      Object.assign(Bun.env, env);
      let stack: MediaStack | undefined;
      try {
        stack = await startMediaStack('launch-recipes-browser-restored', { library: true, ownerUrls: {
          access: restored.apps.ACCESS_DATABASE_URL!, content: restored.apps.CONTENT_DATABASE_URL!,
          relay: restored.apps.ACCOUNT_RELAY_DATABASE_URL!,
        } });
        await prepareRestoredRecipeBrowse(stack, restored.signal);
        restored.signal.throwIfAborted();
        const importer = await stack.member('launch-recipes-importer', { stable: true, verified: true });
        const api = workProfileCorpusApi('http://main.local', importer.token, {
          fetch: ((request, init) => stack!.main.handle(new Request(request, init))) as typeof fetch });
        const page = await api.read<{ items: { id: string }[]; nextCursor: string | null }>(
          `/v1/realms/${short(corpus.realm)}/modules/browse?limit=20`);
        if (page.items.length !== 20 || !page.nextCursor)
          throw new Error(`Restored browser recipes did not expose a complete first catalogue page: ${page.items.length} items, continuation ${Boolean(page.nextCursor)}`);
      } finally {
        await stack?.stop();
        for (const [key, value] of previous) {
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
        }
      }
    },
  });
  const started = performance.now();
  try {
    await restoreLaunchRecipesCorpus(corpus, target, driver);
    if (!copy) throw new Error('Browser recipe restore did not become ready');
    const stackDir = join(root, '.temp/stack', `rezics-qa-${copy.runId}`);
    // The retained API build has no Accounts app; use the browser runner's reserved port.
    const composePath = join(stackDir, 'compose.env');
    const compose = { ...readEnv(composePath), ACCOUNTS_PORT: input.accountsPort };
    replacePrivate(composePath, compose);
    replacePrivate(join(stackDir, 'apps.env'), appEnvironment(compose, stackDir));
    const { bootstrapWebAuth } = await import('../dev/web-auth-bootstrap.ts');
    await bootstrapWebAuth({ profile: 'qa', runId: copy.runId, redirectUris: [`${input.webOrigin}/auth/callback`] });
    const preparation = { ...driver.preparation(target), totalMs: performance.now() - started };
    if (preparation.totalMs > budgetMs) throw new Error('Browser recipe restore and readiness exceeded 600 seconds');
    const prepared = { corpus, restored: true as const, restoreRunId: copy.runId, preparation };
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(prepared, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    console.log(JSON.stringify({ launchCorpus: corpus.id, restored: true, restoreRunId: copy.runId, preparation }));
    return { runId: copy.runId, apps: readEnv(join(stackDir, 'apps.env')), stop: () => driver.stop(target) };
  } catch (error) {
    await driver.stop(target);
    throw error;
  }
}

async function prepareBrowserRecipes() {
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId))
    throw new Error('Browser recipes preparation requires an isolated QA run');
  const path = join(root, '.temp/launch-corpus', `browser-recipes-${runId}.json`);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { corpus: LaunchRecipesCorpus; restored: true };
  const retained = loadLaunchRecipesCorpus();
  if (saved.restored !== true || saved.corpus.id !== retained.id || saved.corpus.backup !== retained.backup)
    throw new Error('Browser recipes must use the restored retained API corpus');
  console.log(JSON.stringify({ launchCorpus: saved.corpus.id, restored: true, recipes: saved.corpus.records.length }));
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
    work => editor.grant(`work:edit:${work}`, 'work.edit').then(() => {}),
    () => editor.grant('rights:assess', 'rights.assess').then(() => {}), signal);
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
  const command = process.argv.slice(2).join();
  if (command === '--browser-prepare') await prepareBrowserBooks();
  else if (command === '--browser-recipes-prepare') await prepareBrowserRecipes();
  else if (command === '--recipes-build') await buildRecipesApiBackup();
  else if (command === '--book-recipes-build') await buildRecipesApiBackup(true);
  else if (command === '--recipes-recover') await recoverRecipesApiBackup();
  else throw new Error('Use --recipes-build, --book-recipes-build, --recipes-recover, --browser-prepare or --browser-recipes-prepare');
}
