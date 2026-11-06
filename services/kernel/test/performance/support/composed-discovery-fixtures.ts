import assert from 'node:assert/strict';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  readCost,
  UI_LOCALES,
  validateComposition,
  validateDocumentFilters,
  type CompositionDocument,
  type CompositionNode,
  type MemberSource,
  type ZoneStarter,
} from '@rezics/composition';
import type { FilterDocument } from '@rezics/filter';
import bookZoneStarter from '../../../../../packages/definitions/presentation/book/zone.json';
import recipeZoneStarter from '../../../../../packages/definitions/presentation/recipe/zone.json';
import type { CollectionView, DynamicCollectionView } from '../../../../../specs/dynamic-collections-driver.ts';
import type { Subject } from '../../../../../specs/semantic-driver.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import type { ZoneConfigurationResponse, ZoneResponse } from '../../../src/zones/contract.ts';
import {
  createReleasedLibraryPopulation,
  type ReleasedLibraryPopulation,
} from '../../library/support/released-library-population.ts';
import { discoveryKey, type CreatedSubject, type ReleasedDiscoveryFixture } from '../../support/released-discovery.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { COMPOSED_READS, COMPOSED_SLOT_EACH, COMPOSED_SLOTS, PAGE_SLOTS } from './composed-discovery-bounds.ts';
import { PUBLIC_JOBS, jobFilter, jobType, type JobFilterSet, type PublicJob } from './composed-discovery-matrix.ts';

export type StatusResponse = Awaited<ReturnType<ReleasedDiscoveryFixture['request']>>;

export function requireStatus(response: StatusResponse, expected: number, operation: string): StatusResponse {
  if (response.status !== expected)
    throw new Error(
      `${operation}: expected HTTP ${expected}, observed ${response.status}: ${JSON.stringify(response.body)}`,
    );
  return response;
}

function findTypeList(node: CompositionNode): CompositionNode | undefined {
  if (node.type === 'TypeList') return node;
  for (const value of Object.values(node.props)) {
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      if (child && typeof child === 'object' && 'type' in child) {
        const found = findTypeList(child as CompositionNode);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function overlayInstalledTypeList(
  starter: ZoneStarter,
  types: readonly string[],
  filter: FilterDocument,
  id: string,
  limit = PAGE_SLOTS,
): CompositionDocument {
  const document = structuredClone(starter.pages[0]!.document) as CompositionDocument;
  const list = document.content.map(findTypeList).find((node) => node !== undefined);
  assert(list, 'Installed vertical Zone starter has a TypeList');
  expectTypes(list, types);
  list.props.id = id;
  list.props.types = [...types];
  list.props.filter = filter;
  list.props.sort = 'name';
  list.props.limit = limit;
  return document;
}

function expectTypes(node: CompositionNode, types: readonly string[]) {
  assert(Array.isArray(node.props.types));
  expectEqual(node.props.types, [...types]);
}

function expectEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Installed TypeList types ${JSON.stringify(actual)} differ from ${JSON.stringify(expected)}`);
}

export type TypeListRead = Readonly<{
  id: string;
  types: readonly string[];
  filter?: FilterDocument;
  limit: number;
}>;

export function typeListNode(read: TypeListRead): CompositionNode {
  return {
    type: 'TypeList',
    props: {
      id: read.id,
      title: { en: read.id },
      types: [...read.types],
      ...(read.filter ? { filter: read.filter } : {}),
      sort: 'name',
      limit: read.limit,
    },
  };
}

export function listDocument(read: TypeListRead): CompositionDocument {
  return { root: { props: {} }, content: [typeListNode(read)] };
}

export function composedLimitReads(
  filters: JobFilterSet,
  classification: { lightNovel: { id: string }; harem: { id: string } },
  diet: { vegetarian: { id: string }; nonvegetarian: { id: string } },
  meaning: ReleasedDiscoveryFixture['meaning'],
): readonly TypeListRead[] {
  const book = ['schema:Book'] as const;
  const recipe = ['schema:Recipe'] as const;
  const reads: TypeListRead[] = [
    {
      id: 'words',
      types: book,
      filter: { statement: { property: meaning.words, range: { gte: 1000001, unit: '1' } } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'form',
      types: book,
      filter: { statement: { property: meaning.form, in: [classification.lightNovel.id] } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'harem',
      types: book,
      filter: { statement: { property: 'schema:keywords', in: [classification.harem.id] } },
      limit: COMPOSED_SLOT_EACH,
    },
    { id: 'form-harem', types: book, filter: filters.formHarem, limit: COMPOSED_SLOT_EACH },
    { id: 'combined', types: book, filter: filters.combined, limit: COMPOSED_SLOT_EACH },
    { id: 'books', types: book, limit: COMPOSED_SLOT_EACH },
    {
      id: 'edge-words',
      types: book,
      filter: { statement: { property: meaning.words, range: { gte: 1000000, unit: '1' } } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'empty-words',
      types: book,
      filter: { statement: { property: meaning.words, range: { gte: 2000000, unit: '1' } } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'diet',
      types: recipe,
      filter: { statement: { property: meaning.diet, in: [diet.vegetarian.id] } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'time',
      types: recipe,
      filter: { statement: { property: meaning.time, range: { lte: 30, unit: meaning.minuteFilter } } },
      limit: COMPOSED_SLOT_EACH,
    },
    { id: 'diet-time', types: recipe, filter: filters.dietTime, limit: COMPOSED_SLOT_EACH },
    { id: 'recipes', types: recipe, limit: COMPOSED_SLOT_EACH },
    {
      id: 'quick',
      types: recipe,
      filter: { statement: { property: meaning.time, range: { lte: 25, unit: meaning.minuteFilter } } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'meat',
      types: recipe,
      filter: { statement: { property: meaning.diet, in: [diet.nonvegetarian.id] } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'slow',
      types: recipe,
      filter: { statement: { property: meaning.time, range: { gte: 31, unit: meaning.minuteFilter } } },
      limit: COMPOSED_SLOT_EACH,
    },
    {
      id: 'recipe-harem',
      types: recipe,
      filter: { statement: { property: 'schema:keywords', in: [classification.harem.id] } },
      limit: COMPOSED_SLOT_EACH,
    },
  ];
  if (reads.length !== COMPOSED_READS) throw new Error(`Composed page must declare ${COMPOSED_READS} TypeLists`);
  return reads;
}

export function composedLimitDocument(reads: readonly TypeListRead[]): CompositionDocument {
  const document: CompositionDocument = { root: { props: {} }, content: reads.map(typeListNode) };
  const violations = validateComposition(platformRegistry, document);
  if (violations.length) throw new Error(`Composed TypeList page is invalid: ${JSON.stringify(violations)}`);
  const plan = planReads(platformRegistry, document, { subject: null });
  const keys = Object.keys(plan.reads);
  if (keys.length !== COMPOSED_READS)
    throw new Error(`Composed page collapsed to ${keys.length} reads; each TypeList must stay distinct`);
  const slots = Object.values(plan.reads).reduce((sum, read) => sum + readCost(read), 0);
  if (slots !== COMPOSED_SLOTS) throw new Error(`Composed page slots ${slots} !== ${COMPOSED_SLOTS}`);
  if (slots > MAX_PAGE_COST || keys.length > MAX_PAGE_READS)
    throw new Error('Composed page exceeds composition admission');
  return document;
}

export type PublicSource = Awaited<ReturnType<ReleasedLibraryPopulation['sources']>>['sources'][number];

export type ComposedDiscoveryWorld = Readonly<{
  population: ReleasedLibraryPopulation;
  fixture: ReleasedDiscoveryFixture;
  database: GrowthDatabase;
  books: Awaited<ReturnType<ReleasedDiscoveryFixture['books']>>;
  recipes: Awaited<ReturnType<ReleasedDiscoveryFixture['recipes']>>;
  classification: Awaited<ReturnType<ReleasedDiscoveryFixture['classification']>>;
  diet: Awaited<ReturnType<ReleasedDiscoveryFixture['diet']>>;
  filters: JobFilterSet;
  sources: Awaited<ReturnType<ReleasedLibraryPopulation['sources']>>;
  publicCollection: PublicSource;
  labels: Map<string, string>;
  everythingId: string;
  ownStateIds: Readonly<Record<'schema:Book' | 'schema:Recipe', string>>;
  zones: Readonly<Record<PublicJob | 'composed', string>>;
  documents: Readonly<Record<PublicJob | 'composed', CompositionDocument>>;
  typelistRoutes: Readonly<Record<PublicJob, string>>;
  duplicateNotes: readonly string[];
  close(): Promise<void>;
}>;

async function subjectLabel(fixture: ReleasedDiscoveryFixture, subject: CreatedSubject): Promise<string> {
  const read = requireStatus(await fixture.read(subject), 200, `Read ${subject.id}`);
  const labels = (read.body.subject as Subject).labels;
  assert(labels.en);
  return labels.en;
}

async function publishZone(
  population: ReleasedLibraryPopulation,
  fixture: ReleasedDiscoveryFixture,
  configuration: ZoneStarter,
  mounts: readonly string[],
): Promise<string> {
  await fixture.grant('editor', ['zone:create'], GLOBAL_CONTEXT);
  await fixture.setup.openFeatures(['zone_sources']);
  const created = requireStatus(
    await population.request(
      'editor',
      'POST',
      '/v1/zones',
      { configuration, mounts, visibility: 'private' },
      discoveryKey(),
    ),
    201,
    'Create discovery Zone',
  ).body as ZoneResponse;
  const published = requireStatus(
    await population.request(
      'editor',
      'POST',
      `/v1/zones/${created.zone.id}:publish`,
      { visibility: 'public' },
      { ...discoveryKey(), 'if-match': JSON.stringify(created.zone.revision) },
    ),
    200,
    'Publish discovery Zone',
  ).body as ZoneResponse;
  const configured = requireStatus(
    await population.request('editor', 'GET', `/v1/zones/${created.zone.id}/configuration`),
    200,
    'Read published Zone configuration',
  ).body as ZoneConfigurationResponse;
  if (configured.zone.revision !== published.zone.revision)
    throw new Error('Published Zone revision disagrees with configuration');
  if (JSON.stringify(configured.mounts) !== JSON.stringify(mounts))
    throw new Error('Published Zone mounts disagree with the requested public Collection');
  return created.zone.id;
}

async function publishTypeLists(
  fixture: ReleasedDiscoveryFixture,
  routes: readonly Readonly<{ route: string; document: CompositionDocument }>[],
): Promise<void> {
  await fixture.grant('steward', ['presentation:publish', 'presentation:activate'], GLOBAL_CONTEXT);
  const published = requireStatus(
    await fixture.request(
      'steward',
      'POST',
      '/v1/presentation/profiles',
      {
        profile: {
          format: PROFILE_FORMAT,
          generic: routes[0]!.document,
          bases: [],
          types: [],
          routes: routes.map(({ route, document }) => ({ route, document })),
        },
      },
      discoveryKey(),
    ),
    201,
    'Publish Book and Recipe TypeList routes',
  );
  const active = requireStatus(
    await fixture.request('anonymous', 'GET', '/v1/presentation/active'),
    200,
    'Read active presentation',
  );
  requireStatus(
    await fixture.request(
      'steward',
      'POST',
      `/v1/presentation/profiles/${published.body.digest}:activate`,
      { expected_head: active.body.head },
      discoveryKey(),
    ),
    200,
    'Activate Book and Recipe TypeList routes',
  );
}

async function builtinCollection(
  population: ReleasedLibraryPopulation,
  fixture: ReleasedDiscoveryFixture,
  kind: 'everything' | 'state',
  type: 'schema:Book' | 'schema:Recipe',
): Promise<string> {
  const accepted = population.profile(type);
  const set = accepted.profile.entryStateSet;
  assert(set);
  const active = set.states.find(({ role }) => role === 'active');
  assert(active);
  const discovered = requireStatus(
    await population.request(
      'alice',
      'GET',
      `/v1/collections?curatorAccountId=${fixture.personas.alice.accountId}&limit=100`,
    ),
    200,
    'List Alice Collections',
  );
  if (discovered.body.next !== null) throw new Error('Alice Collection directory was not exhausted');
  const choices = (discovered.body.collections as CollectionView[]).filter((row): row is DynamicCollectionView => {
    if (row.membershipKind !== 'dynamic') return false;
    if (kind === 'everything') return row.builtinKind === 'everything';
    return (
      row.builtin?.kind === 'state' &&
      row.builtin.profileId === accepted.profile.id &&
      row.builtin.stateSetId === set.id &&
      row.builtin.stateId === active.id
    );
  });
  if (choices.length !== 1) throw new Error(`Expected one ${kind} Collection for ${type}, found ${choices.length}`);
  return choices[0]!.id;
}

async function settleComposedWorld(
  population: ReleasedLibraryPopulation | undefined,
  database: GrowthDatabase | undefined,
  cause?: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await population?.close();
  } catch (error) {
    errors.push(error);
  }
  // Driver close already ends the instrumented runtime pool; only the admin checkout remains.
  try {
    await database?.admin.end();
  } catch (error) {
    errors.push(error);
  }
  if (cause && errors.length)
    throw new AggregateError([cause, ...errors], 'Composed discovery world setup and cleanup failed', { cause });
  if (cause) throw cause;
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Composed discovery world cleanup failed');
}

export async function createComposedDiscoveryWorld(options: {
  version: 1;
  search: 'native';
}): Promise<ComposedDiscoveryWorld> {
  let database: GrowthDatabase | undefined;
  let population: ReleasedLibraryPopulation | undefined;
  try {
    population = await createReleasedLibraryPopulation({
      version: options.version,
      search: options.search,
      async kernelPool(url) {
        database = await openGrowthDatabase(url);
        return database.pool;
      },
    });
    const fixture = population.base;
    await fixture.setup.openFeatures(['search', 'search_advanced', 'personal_library', 'reading_progress']);
    // One editor stream: classification/diet/books/recipes share that account's command home.
    const classification = await fixture.classification();
    const diet = await fixture.diet();
    const books = await fixture.books();
    const recipes = await fixture.recipes();
    const filters = fixture.filters(classification, diet);
    const filterErrors = [...PUBLIC_JOBS].flatMap((job) =>
      validateDocumentFilters(
        platformRegistry,
        listDocument({
          id: job,
          types: [jobType(job)],
          filter: jobFilter(job, filters),
          limit: PAGE_SLOTS,
        }),
        fixture.release.definition,
      ),
    );
    if (filterErrors.length)
      throw new Error(`Released TypeList predicates fail admission: ${JSON.stringify(filterErrors)}`);
    await fixture.setup.openFeatures(['personal_library', 'reading_progress']);
    const sources = await population.sources();
    const publicCollection = sources.sources.find(({ source }) => source.visibility === 'public');
    assert(publicCollection);
    await fixture.catchUp(sources.subjects);
    const labels = new Map<string, string>();
    for (const subject of [...Object.values(books.subjects), books.edition, ...Object.values(recipes.subjects)])
      labels.set(subject.id, await subjectLabel(fixture, subject));
    const duplicateNotes = publicCollection.occurrences
      .filter(({ member }) => member.subjectId === books.subjects['B-long'].id)
      .map(({ member }) => member.note)
      .filter((note): note is string => typeof note === 'string');
    if (duplicateNotes.length !== 2) throw new Error('C-public must retain two B-long occurrences with notes');
    const currentHeader = requireStatus(
      await population.request('alice', 'GET', `/v1/collections/${publicCollection.source.id}`),
      200,
      'Read current public Collection',
    ).body.collection as { id: string; revision: number };
    const mount: MemberSource = { kind: 'collection', id: currentHeader.id };
    const bookDocument = overlayInstalledTypeList(
      structuredClone(bookZoneStarter) as ZoneStarter,
      ['schema:Book'],
      jobFilter('long-harem-light-novels', filters),
      'works',
    );
    const recipeDocument = overlayInstalledTypeList(
      structuredClone(recipeZoneStarter) as ZoneStarter,
      ['schema:Recipe'],
      jobFilter('quick-vegetarian-recipes', filters),
      'works',
    );
    const composedReads = composedLimitReads(filters, classification, diet, fixture.meaning);
    const composedDocument = composedLimitDocument(composedReads);
    const composedErrors = validateDocumentFilters(platformRegistry, composedDocument, fixture.release.definition);
    if (composedErrors.length)
      throw new Error(`Composed TypeList predicates fail admission: ${JSON.stringify(composedErrors)}`);
    const bookConfiguration = structuredClone(bookZoneStarter) as ZoneStarter;
    for (const saved of bookConfiguration.scope) {
      if (!fixture.release.definition.filters?.[saved])
        throw new Error(`Installed Book Zone scope ${saved} is missing from the bundled release`);
    }
    bookConfiguration.pages = [{ route: '', document: bookDocument }];
    const recipeConfiguration = structuredClone(recipeZoneStarter) as ZoneStarter;
    recipeConfiguration.pages = [{ route: '', document: recipeDocument }];
    const composedConfiguration = structuredClone(bookZoneStarter) as ZoneStarter;
    composedConfiguration.pages = [{ route: '', document: composedDocument }];
    composedConfiguration.labels = Object.fromEntries(
      UI_LOCALES.map((locale) => [locale, 'Composed discovery']),
    ) as ZoneStarter['labels'];
    const [bookZone, recipeZone, composedZone] = await Promise.all([
      publishZone(population, fixture, bookConfiguration, [mount.id]),
      publishZone(population, fixture, recipeConfiguration, [mount.id]),
      publishZone(population, fixture, composedConfiguration, [mount.id]),
    ]);
    const typelistRoutes = {
      'long-harem-light-novels': '/composed-discovery/books',
      'quick-vegetarian-recipes': '/composed-discovery/recipes',
    } as const;
    await publishTypeLists(fixture, [
      { route: typelistRoutes['long-harem-light-novels'], document: bookDocument },
      { route: typelistRoutes['quick-vegetarian-recipes'], document: recipeDocument },
    ]);
    const acceptedBook = population.profile('schema:Book');
    const acceptedRecipe = population.profile('schema:Recipe');
    const bookActive = acceptedBook.profile.entryStateSet?.states.find(({ role }) => role === 'active');
    const recipeActive = acceptedRecipe.profile.entryStateSet?.states.find(({ role }) => role === 'active');
    assert(bookActive && recipeActive);
    const label = requireStatus(
      await population.request('alice', 'POST', '/v1/libraryLabels', { name: 'Released public jobs' }, discoveryKey()),
      201,
      'Create Alice label',
    ).body.label as { id: string };
    for (const subject of [...Object.values(books.subjects), ...Object.values(recipes.subjects)]) {
      requireStatus(
        await population.request(
          'alice',
          'POST',
          `/v1/libraryLabels/${label.id}:assign`,
          { subjectId: subject.id },
          discoveryKey(),
        ),
        200,
        `Assign label to ${subject.id}`,
      );
    }
    for (const [subject, state] of [
      ...Object.values(books.subjects).map((subject) => [subject, bookActive.id] as const),
      ...Object.values(recipes.subjects).map((subject) => [subject, recipeActive.id] as const),
    ]) {
      const existing = await population.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`);
      if (existing.status === 404) {
        requireStatus(
          await population.request('alice', 'PUT', `/v1/libraryEntries/${subject.id}`, { state }, discoveryKey()),
          201,
          `Admit Alice state for ${subject.id}`,
        );
      } else requireStatus(existing, 200, `Read Alice state for ${subject.id}`);
    }
    const everythingId = await builtinCollection(population, fixture, 'everything', 'schema:Book');
    const ownStateIds = {
      'schema:Book': await builtinCollection(population, fixture, 'state', 'schema:Book'),
      'schema:Recipe': await builtinCollection(population, fixture, 'state', 'schema:Recipe'),
    };
    for (const persona of ['anonymous', 'bob'] as const) {
      requireStatus(
        await population.request(persona, 'GET', `/v1/collections/${everythingId}`),
        404,
        'Conceal Everything',
      );
      requireStatus(
        await population.request(persona, 'GET', `/v1/collections/${ownStateIds['schema:Book']}`),
        404,
        'Conceal own state',
      );
    }
    if (!database) throw new Error('Composed discovery world requires the instrumented growth database');
    let closed = false;
    return {
      population,
      fixture,
      database,
      books,
      recipes,
      classification,
      diet,
      filters,
      sources,
      publicCollection,
      labels,
      everythingId,
      ownStateIds,
      zones: {
        'long-harem-light-novels': bookZone,
        'quick-vegetarian-recipes': recipeZone,
        composed: composedZone,
      },
      documents: {
        'long-harem-light-novels': bookDocument,
        'quick-vegetarian-recipes': recipeDocument,
        composed: composedDocument,
      },
      typelistRoutes,
      duplicateNotes,
      async close() {
        if (closed) return;
        closed = true;
        await settleComposedWorld(population, database);
      },
    };
  } catch (error) {
    await settleComposedWorld(population, database, error);
    throw error;
  }
}

export function orderedByLabel(ids: readonly string[], labels: ReadonlyMap<string, string>): string[] {
  return [...ids].sort((left, right) => {
    const a = labels.get(left);
    const b = labels.get(right);
    if (!a || !b) throw new Error('Missing native English label for ordered comparison');
    return a.localeCompare(b);
  });
}

export function occurrenceSubjectIds(source: PublicSource, selected: readonly string[]): string[] {
  return source.occurrences
    .map(({ member }) => member.subjectId)
    .filter((id) => selected.includes(id))
    .sort();
}

export async function mergeAlias(
  fixture: ReleasedDiscoveryFixture,
  terminal: CreatedSubject,
  label: string,
): Promise<CreatedSubject> {
  await fixture.grant('acceptor', ['subject:merge'], GLOBAL_CONTEXT);
  const original = await fixture.createSubject('schema:Book', label);
  const merged = await fixture.request(
    'acceptor',
    'POST',
    '/v1/subjects:merge',
    { subjects: [terminal.id, original.id].sort() },
    discoveryKey(),
  );
  if (merged.status !== 200 && merged.status !== 202)
    throw new Error(`Native merge unavailable: ${merged.status} ${JSON.stringify(merged.body)}`);
  await fixture.catchUp([terminal, original]);
  return original;
}
