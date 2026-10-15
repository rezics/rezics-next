import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';

export interface SeedCheckpointPopulationTargets {
  recipeOccurrences: number;
  readerShelfEntries: number;
  zoneNavigationEntries: number;
  mountedCollectionResources: number;
}
export interface SeedCheckpointPublicWork { work: string; mainVersion: string }
export interface SeedCheckpointPopulation {
  actor: string;
  recipe: { work: string; mainVersion: string; structure: string; revision: string; occurrences: string[] };
  collection: { id: string; structure: string; revision: string; members: Array<{ occurrence: string; work: string }> };
  zone: { id: string; navigation: string; revision: string; mounts: Array<{ occurrence: string; segment: string; target: string }> };
  home: { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
  shelfWorks: string[];
  works: SeedCheckpointPublicWork[];
}
type Grant = (scope: string, action: string) => Promise<unknown>;
const short = (id: string) => id.slice(-36);
const queryPath = (path: string, query: Record<string, string>): `/v1/${string}` =>
  `${path}?${new URLSearchParams(query)}` as `/v1/${string}`;

/** Scenario setup only: the corpus owner controls growth, cuts, deadlines and backups. */
export async function initializeSeedCheckpointPopulation(
  api: CorpusApi,
  input: { actor: string; grant: Grant },
): Promise<SeedCheckpointPopulation> {
  const { actor, grant } = input;
  const recipe = await api.command<{ work: string; mainVersion: string }>('checkpoint:recipe-work', {
    method: 'POST', path: '/v1/works', body: { profile: 'metadata-only-v1', authoring: 'own-work',
      title: 'Checkpoint recipe', language: 'en', semanticTypes: ['https://schema.org/Recipe'], actingSubject: actor },
  });
  await grant(`work:edit:${recipe.work}`, 'recipe.edit');
  await grant(`work:read:${recipe.work}`, 'work.read');
  const composition = await api.command<{ structure: string; revision: string }>('checkpoint:recipe-composition', {
    method: 'POST', path: '/v1/compositions', body: { profile: 'recipe-composition',
      work: recipe.work, mainVersion: recipe.mainVersion, actingSubject: actor },
  });
  await grant('space:create:root', 'space.create');
  const site = await api.command<{ zone: string; navigation: string; navigationRevision: string }>('checkpoint:zone', {
    method: 'POST', path: '/v1/spaces', body: { profile: 'space-zone-v1', name: 'Checkpoint navigation',
      capabilities: ['zone'], actingSubject: actor },
  });
  await grant(`zone:edit:${site.zone}`, 'zone.edit');
  const configurationPath = `/v1/zones/${short(site.zone)}/configuration` as const;
  const configurationQuery = queryPath(configurationPath, { actingSubject: actor });
  const configuration = await api.read<{ revision: string }>(configurationQuery);
  await api.command('checkpoint:zone-home-document', {
    method: 'PUT', path: configurationPath, body: {
      expectedHead: configuration.revision, prepareHomeDocument: true, actingSubject: actor,
    },
  });
  const prepared = await api.read<{ configuration: { homeDocument?: string } }>(configurationQuery);
  const homeDocument = prepared.configuration.homeDocument;
  if (!homeDocument) throw new Error('Checkpoint Zone home document was not prepared');
  const collection = `https://rezics.com/id/${randomUUID()}`;
  await grant(`collection:edit:${collection}`, 'collection.edit');
  await grant(`semantic:read:${collection}`, 'semantic.read');
  const curated = await api.command<{ structure: string; revision: string }>('checkpoint:collection', {
    method: 'POST', path: '/v1/collections', body: { collection, name: 'Checkpoint mounted Works',
      disclosure: 'public', actingSubject: actor },
  });
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const home = await api.command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    'checkpoint:zone-home', { method: 'POST', path: '/v1/content-drafts', body: {
      profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
      document: fromPlainText('Checkpoint reading site', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
    } },
  );
  return { actor, recipe: { ...recipe, ...composition, occurrences: [] },
    collection: { id: collection, ...curated, members: [] },
    zone: { id: site.zone, navigation: site.navigation, revision: site.navigationRevision, mounts: [] },
    home: { page: homeDocument, variantId, revisionId: home.revisionId, byteDigest: home.byteDigest, contentEpoch: home.sourcePosition.dataEpoch },
    shelfWorks: [], works: [] };
}

/** Related Works are distinct from the unrelated catalogue population. */
export async function growSeedCheckpointPopulation(
  api: CorpusApi,
  handles: SeedCheckpointPopulation,
  targets: SeedCheckpointPopulationTargets,
): Promise<void> {
  if (Object.values(targets).some(value => !Number.isSafeInteger(value) || value < 0))
    throw new Error('Checkpoint population targets are invalid');
  const works = handles.works;
  while (works.length < Math.max(targets.readerShelfEntries, targets.mountedCollectionResources)) {
    const index = works.length;
    works.push(await seedPublicProfileWork(api, `checkpoint:population-work:${index}`, {
      actingSubject: handles.actor, title: `Checkpoint population Work ${index}`,
      body: `Checkpoint population text ${index}`,
    }));
  }
  const { actor, recipe, collection, zone } = handles;
  const previousMembers = collection.members.length, previousMounts = zone.mounts.length;
  if (Object.values(targets).some(value => !Number.isSafeInteger(value) || value < 0)
    || targets.readerShelfEntries > works.length || targets.mountedCollectionResources > works.length)
    throw new Error('Checkpoint population targets exceed the available public Works');
  while (recipe.occurrences.length < targets.recipeOccurrences) {
    const offset = recipe.occurrences.length;
    const count = Math.min(16, targets.recipeOccurrences - offset);
    const changed = await api.command<{ revision: string; occurrences: string[] }>(`checkpoint:recipe:${offset}`, {
      method: 'POST', path: `/v1/compositions/${short(recipe.structure)}/changes`, body: {
        profile: 'recipe-composition', expectedHead: recipe.revision, actingSubject: actor,
        operations: Array.from({ length: count }, (_, index) => ({ op: 'insert', parent: recipe.structure,
          position: 'last', role: 'ingredient', qualifier: { type: 'ingredient-line',
            originalText: { value: `1 cup ingredient ${offset + index}`, language: 'en' },
            amountLexical: '1', amount: { numerator: 1, denominator: 1 }, unitText: 'cup',
            optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' } })),
      },
    });
    if (changed.occurrences.length !== count) throw new Error('Recipe occurrence insertion was incomplete');
    recipe.revision = changed.revision;
    recipe.occurrences.push(...changed.occurrences);
  }
  for (let index = handles.shelfWorks.length; index < targets.readerShelfEntries; index++) {
    const work = works[index]!.work;
    await api.command(`checkpoint:shelf:${index}`, { method: 'PUT', path: `/v1/works/${short(work)}/reader-status`,
      body: { actingSubject: actor, expectedVersion: 0, status: 'reading', startedOn: null, finishedOn: null } });
    handles.shelfWorks.push(work);
  }
  while (collection.members.length < targets.mountedCollectionResources) {
    const offset = collection.members.length;
    const additions = works.slice(offset, Math.min(targets.mountedCollectionResources, offset + 16));
    const changed = await api.command<{ revision: string; occurrences: string[] }>(`checkpoint:members:${offset}`, {
      method: 'POST', path: `/v1/collections/${short(collection.id)}/changes`, body: {
        expectedHead: collection.revision, actingSubject: actor,
        operations: additions.map(work => ({ op: 'insert', role: 'member', parent: collection.structure,
          position: 'last', target: work.work, selection: { mode: 'follow-context' } })),
      },
    });
    if (changed.occurrences.length !== additions.length) throw new Error('Collection insertion was incomplete');
    collection.revision = changed.revision;
    collection.members.push(...additions.map((work, index) => ({ work: work.work, occurrence: changed.occurrences[index]! })));
  }
  for (let index = zone.mounts.length; index < targets.zoneNavigationEntries; index++) {
    const segment = index === 0 ? 'reading' : `reading-${index}`;
    const changed = await api.command<{ revision: string; occurrences: string[] }>(`checkpoint:mount:${index}`, {
      method: 'POST', path: `/v1/zones/${short(zone.id)}/mounts`, body: {
        expectedHead: zone.revision, collection: collection.id, routeSegment: segment,
        disclosure: 'public', position: 'last', actingSubject: actor,
      },
    });
    if (changed.occurrences.length !== 1) throw new Error('Zone mount insertion was incomplete');
    zone.revision = changed.revision;
    zone.mounts.push({ occurrence: changed.occurrences[0]!, segment, target: collection.id });
  }
  if (!zone.mounts.length || previousMembers === collection.members.length && previousMounts === zone.mounts.length) return;
  const configuration = await api.read<{ revision: string }>(queryPath(`/v1/zones/${short(zone.id)}/configuration`, { actingSubject: actor }));
  await api.command(`checkpoint:site-publication:${zone.mounts.length}:${collection.members.length}`, {
    method: 'POST', path: `/v1/zones/${short(zone.id)}/site-publications`, body: {
      routesRevision: zone.revision, navigationRevision: zone.revision, expectedHead: configuration.revision,
      actingSubject: actor, pages: [handles.home],
    },
  });
}

function equalIdentities(actual: string[], expected: readonly string[], label: string) {
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort()))
    throw new Error(`Retained ${label} identities do not match their API census`);
}

/** A paginated API census proves retained identities beyond presentation/page caps. */
export async function verifySeedCheckpointPopulation(
  api: CorpusApi,
  handles: SeedCheckpointPopulation,
): Promise<SeedCheckpointPopulationTargets> {
  const { actor, recipe, collection, zone } = handles;
  const recipeIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.read<{ structure: string; revision: string; occurrences: Array<{ occurrence: string }>; next?: string }>(
      queryPath(`/v1/recipes/works/${short(recipe.work)}`, { actingSubject: actor, ...(cursor ? { cursor } : {}) }));
    if (page.structure !== recipe.structure || page.revision !== recipe.revision) throw new Error('Retained recipe basis changed');
    recipeIds.push(...page.occurrences.map(item => item.occurrence));
    cursor = page.next;
  } while (cursor);
  equalIdentities(recipeIds, recipe.occurrences, 'recipe occurrence');
  const shelfWorks: string[] = [];
  cursor = undefined;
  do {
    const page: { items: Array<{ work: string; status: string }>; nextCursor: string | null } = await api.read(
      queryPath('/v1/me/shelves/status/reading/works', { actingSubject: actor, limit: '20', sort: 'added', order: 'asc', ...(cursor ? { cursor } : {}) }));
    if (page.items.some(item => item.status !== 'reading')) throw new Error('Retained shelf status changed');
    shelfWorks.push(...page.items.map(item => item.work));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  equalIdentities(shelfWorks, handles.shelfWorks, 'reader shelf Work');
  const memberIds: string[] = [], memberWorks: string[] = [];
  cursor = undefined;
  do {
    const page: { revision: string; occurrences: Array<{ occurrence: string; target: string }>; next: string | null } = await api.read(
      queryPath(`/v1/collections/${short(collection.id)}`, { actingSubject: actor, limit: '100', ...(cursor ? { after: cursor } : {}) }));
    if (page.revision !== collection.revision) throw new Error('Retained collection revision changed');
    memberIds.push(...page.occurrences.map(item => item.occurrence));
    memberWorks.push(...page.occurrences.map(item => item.target));
    cursor = page.next ?? undefined;
  } while (cursor);
  equalIdentities(memberIds, collection.members.map(item => item.occurrence), 'collection member');
  equalIdentities(memberWorks, collection.members.map(item => item.work), 'mounted collection Work');
  const mountIds: string[] = [], mountSegments: string[] = [];
  cursor = undefined;
  do {
    const page: { revision: string; mounts: Array<{ occurrence: string; target: string; qualifier: { routeSegment: string; disclosure: string } }>; next: string | null } = await api.read(
      queryPath(`/v1/zones/${short(zone.id)}`, { actingSubject: actor, limit: '100', ...(cursor ? { after: cursor } : {}) }));
    if (page.revision !== zone.revision || page.mounts.some(item => item.target !== collection.id || item.qualifier.disclosure !== 'public'))
      throw new Error('Retained public Zone mounts changed');
    mountIds.push(...page.mounts.map(item => item.occurrence));
    mountSegments.push(...page.mounts.map(item => item.qualifier.routeSegment));
    cursor = page.next ?? undefined;
  } while (cursor);
  equalIdentities(mountIds, zone.mounts.map(item => item.occurrence), 'Zone mount');
  equalIdentities(mountSegments, zone.mounts.map(item => item.segment), 'Zone route segment');
  const routed = await api.read<{ kind: string; items: Array<{ id: string }> }>(
    queryPath(`/v1/zones/${short(zone.id)}/routes`, { path: '/reading' }));
  if (routed.kind !== 'index') throw new Error('Retained mounted Collection route is unavailable');
  const routedWorks = routed.items.map(item => item.id);
  if (routedWorks.length !== Math.min(24, collection.members.length)
    || new Set(routedWorks).size !== routedWorks.length
    || routedWorks.some(work => !collection.members.some(member => member.work === work)))
    throw new Error('Retained mounted route page does not match its Collection population');
  return { recipeOccurrences: recipeIds.length, readerShelfEntries: shelfWorks.length,
    zoneNavigationEntries: mountIds.length, mountedCollectionResources: memberWorks.length };
}
