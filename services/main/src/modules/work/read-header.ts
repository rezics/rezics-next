import { RightsInvalid, RightsUnavailable, resourceFactMaterial, workDescriptionMaterial, type WikiDisplayObligations } from '../rights/store.ts';
import { DisclosureUnavailable } from '../disclosure/read.ts';
import { workPublicationProfileFor, structureProfileForGraph } from '../structure/profiles.ts';
import { chooseMainLanguage, readMainLanguageHeads } from './selection-heads.ts';
import type { Static } from 'typebox';
import { iri, GRAPHS, WORK_SEMANTIC_TYPES } from './activate.ts';
import { workCard, workHeader } from './read-contract.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, publicWork, unerased, readRowsToken, readDependencyToken,
  type WorkReadSession } from './read-session.ts';
import { readPublishedStructuredWorkSource, readWorkPublicationParents,
  type PublishedStructuredWorkSource } from './public-patterns.ts';
import { readMetadataHeader, recordedDisplayText, selectedMetadata } from './metadata-read.ts';
import { selectedPublicationAttribution } from './sourced-structure-publication.ts';
import { readSerialStatistics } from './summary-serial.ts';
import type { NavigationOperation } from '../query/navigation-contract.ts';

/** Legacy anchors remain useful discovery names; their operations carry the
 * actual POST body. Resource operations name the mounted native GET owner. */
export function workHeaderNavigation(work: string) {
  const path = `/v1/works/${work.slice(-36)}`;
  const links = { versions: '/v1/query#work-versions', classifications: `${path}/classifications`,
    adoptions: '/v1/query#work-adoptions', ratings: `/v1/resources/${work.slice(-36)}/ratings`,
    history: `${path}/history`, credits: `${path}/credits`, metadata: `${path}/metadata`,
    editions: `${path}/editions`, releases: `${path}/releases`, realizations: `${path}/realizations` };
  const navigation = {
    versions: { kind: 'query', method: 'POST', href: '/v1/query', operationId: 'postV1Query',
      responseProfile: 'query-v1', request: { profile: 'template-query-v1',
        query: 'https://rezics.com/query/work-versions', revision: 1, parameters: { roots: [work] }, limit: 20 } },
    classifications: { kind: 'resource', method: 'GET', href: links.classifications,
      operationId: 'getV1WorksByIdClassifications', responseProfile: null },
    adoptions: { kind: 'query', method: 'POST', href: '/v1/query', operationId: 'postV1Query',
      responseProfile: 'query-v1', request: { profile: 'template-query-v1',
        query: 'https://rezics.com/query/work-adoptions', revision: 1, parameters: { roots: [work] }, limit: 20 } },
    ratings: { kind: 'resource', method: 'GET', href: links.ratings,
      operationId: 'getV1ResourcesByResourceRatings', responseProfile: 'work-rating-read-v1' },
    history: { kind: 'resource', method: 'GET', href: links.history,
      operationId: 'getV1WorksByIdHistory', responseProfile: null },
    credits: { kind: 'resource', method: 'GET', href: links.credits,
      operationId: 'getV1WorksByIdCredits', responseProfile: 'template-result-v1' },
    metadata: { kind: 'resource', method: 'GET', href: links.metadata,
      operationId: 'getV1WorksByIdMetadata', responseProfile: null },
    editions: { kind: 'resource', method: 'GET', href: links.editions,
      operationId: 'getV1WorksByIdEditions', responseProfile: null },
    releases: { kind: 'resource', method: 'GET', href: links.releases,
      operationId: 'getV1WorksByIdReleases', responseProfile: null },
    realizations: { kind: 'resource', method: 'GET', href: links.realizations,
      operationId: 'getV1WorksByIdRealizations', responseProfile: null },
  } satisfies Record<keyof typeof links, NavigationOperation>;
  return { links, navigation };
}

export type WorkCard = Static<typeof workCard>;
export interface WorkBasis { card: Omit<WorkCard, 'chapterCount' | 'wordCount' | 'lastUpdatedAt'>;
  mainRevision: string; selectedLanguage: string | null;
  dependencyToken: string;
  metadataRevision: string | null; metadata: Awaited<ReturnType<typeof readMetadataHeader>>;
  disclosure: 'public' | 'restricted'; publicationState: 'published' | 'unpublished';
  structuredPublication: PublishedStructuredWorkSource | null;
  structuredPublicationCandidate: boolean;
  structurePublicationHead: string | null;
  fieldProvenance?: Static<typeof workHeader>['fieldProvenance'] }

/** Structure visibility is exact to the admitted revision and its Work. Work
 * readability alone cannot disclose another Structure revision. */
export async function structureRevisionDisclosureVisible(session: WorkReadSession, input: {
  work: string; workRevision?: string; structure: string; revision: string;
}): Promise<boolean> {
  try {
    const environment = session.deps?.environment;
    const parents = environment
      ? await readWorkPublicationParents(environment, [input.work]) : new Map<string, string>();
    const parent = parents.get(input.work);
    const decisions = await session.disclosure([
      { owner: 'graph', resource: input.work, component: 'name', work: input.work,
        ...(input.workRevision ? { workRevision: input.workRevision } : {}) },
      { owner: 'graph', resource: input.structure, component: 'structure', revision: input.revision,
        work: input.work, ...(input.workRevision ? { workRevision: input.workRevision } : {}) },
      ...(parent ? [{ owner: 'graph' as const, resource: parent, component: 'publication' as const, work: parent }] : []),
    ]);
    if (decisions.length !== (parent ? 3 : 2)) {
      throw new WorkReadUnavailable('Structure disclosure result is incomplete');
    }
    return decisions.every(decision => decision === 'visible');
  } catch (error) {
    if (error instanceof DisclosureUnavailable) {
      throw new WorkReadUnavailable('Structure disclosure is unavailable', { cause: error });
    }
    if (!(error instanceof WorkReadUnavailable)) {
      throw new WorkReadUnavailable('Structure disclosure is unavailable', { cause: error });
    }
    throw error;
  }
}

async function workPublicationContainerDisclosureVisible(session: WorkReadSession, work: string): Promise<boolean> {
  const environment = session.deps?.environment;
  if (!environment) return true;
  try {
    const parent = (await readWorkPublicationParents(environment, [work])).get(work);
    const decisions = await session.disclosure([
      { owner: 'graph', resource: work, component: 'name', work },
      ...(parent ? [{ owner: 'graph' as const, resource: parent, component: 'publication' as const, work: parent }] : []),
    ]);
    if (decisions.length !== (parent ? 2 : 1)) {
      throw new WorkReadUnavailable('Work disclosure result is incomplete');
    }
    return decisions.every(decision => decision === 'visible');
  } catch (error) {
    if (error instanceof DisclosureUnavailable) {
      throw new WorkReadUnavailable('Work disclosure is unavailable', { cause: error });
    }
    if (error instanceof WorkReadUnavailable) throw error;
    throw new WorkReadUnavailable('Work disclosure is unavailable', { cause: error });
  }
}

export async function readWorkBasis(session: WorkReadSession, work: string): Promise<WorkBasis> {
  const types = `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
    ${iri(work)} a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } } }`;
  const maximumRows = 9;
  const rows = await session.query(`SELECT ?head ?main ?mainHead ?metadataHead ?publicationHead ?type ?public ?provisional ?provenance
    WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${iri(work)} ; rv:head ?mainHead .
      OPTIONAL { ${iri(work)} rv:descriptiveMetadataHead ?metadataHead }
      OPTIONAL { ${iri(work)} rv:workStructurePublicationHead ?publicationHead }
      OPTIONAL { ${iri(work)} rv:provisional ?provisional }
      OPTIONAL { ${iri(work)} rv:fieldProvenance ?provenance }
    }
    ${types}
    ${unerased(iri(work))}
    BIND(EXISTS { ${publicWork(iri(work), '?main')} } AS ?public)
  } LIMIT ${maximumRows + 1}`, maximumRows);
  const row = rows[0];
  if (!row) throw new WorkReadMissing('Work is unavailable');
  if (!row.head || !row.main || !row.mainHead || !row.public
    || ['head', 'main', 'mainHead', 'metadataHead', 'publicationHead', 'public', 'provenance'].some(key =>
      new Set(rows.map(item => item[key]?.value)).size !== 1)) {
    throw new WorkReadUnavailable('Work basis is ambiguous');
  }
  const isPublic = row.public.value === 'true';
  if (!isPublic && (!session.principal || !session.options.actingSubject
    || !await session.deps.access.canReadWork(session.principal, session.options.actingSubject, work))) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const readPublication = () => readPublishedStructuredWorkSource(session.deps.environment, work, row.main!.value);
  let source: PublishedStructuredWorkSource | null;
  try { source = await readPublication(); }
  catch (error) { throw new WorkReadUnavailable('Work publication state is unavailable', { cause: error }); }
  const structuredPublicationCandidate = source !== null;
  if (session.fencesSelectedUnits) {
    session.observeDependency(`structured-work-publication:${work}`, source, readPublication);
  }
  if (source) {
    if (!await workPublicationContainerDisclosureVisible(session, work)) {
      throw new WorkReadMissing('Work is unavailable');
    }
    try {
      workPublicationProfileFor(structureProfileForGraph(source.structureProfile));
    } catch (error) {
      throw new WorkReadUnavailable('Work publication profile is unavailable', { cause: error });
    }
    if (!await structureRevisionDisclosureVisible(session, { work, workRevision: row.head.value,
      structure: source.structure, revision: source.structureRevision })) source = null;
  }
  if (source?.sourceObservation) await selectedPublicationAttribution(session, source);
  const readHeads = async () => isPublic ? (await readMainLanguageHeads(session.deps.environment,
    row.main!.value, true)).sort((a, b) => a.language.localeCompare(b.language)) : [];
  const heads = await readHeads();
  const languageToken = session.fencesSelectedUnits
    ? session.observeDependency(`language-heads:${row.main.value}`, heads, readHeads)
    : readDependencyToken(heads);
  const selected = isPublic ? chooseMainLanguage(heads, session.options.language) : null;
  const selectedProfiles = [...new Set(['work-metadata-v1', ...(row.metadataHead ? ['work-metadata-details-v1'] : []),
    ...(session.options.localProfiles ?? [])])].sort();
  const profiles = session.fencesSelectedUnits ? await session.dependency(`work-profiles:${JSON.stringify(selectedProfiles)}`, async () => {
    const health = await session.deps.environment.fuseki.commandHealth();
    return selectedProfiles
      .map(profile => { const digest = health.profiles[profile];
        if (!digest) throw new WorkReadUnavailable('Selected Work profile is unavailable');
        return [profile, digest]; });
  }) : null;
  const summary = (await session.summaries([work]))[0];
  if (summary?.status !== 'available' || summary.type !== 'work') throw new WorkReadMissing('Work is unavailable');
  const metadata = await readMetadataHeader(session, work, row.metadataHead?.value ?? null);
  const selectedMetadataValue = selectedMetadata(metadata, session.options.language);
  return { card: { id: work, revision: row.head.value, mainVersion: row.main.value,
    ...(row.provisional ? { verification: row.provisional.value === 'true' ? 'unverified' as const : 'verified' as const } : {}),
    title: summary.name, cover: summary.avatar, types: [...new Set(rows.flatMap(item => item.type ? [item.type.value] : []))].sort(),
    tagline: selectedMetadataValue.tagline, completionStatus: metadata.completionStatus },
  mainRevision: row.mainHead.value, metadataRevision: row.metadataHead?.value ?? null, metadata,
  dependencyToken: readDependencyToken([readRowsToken(rows), languageToken, profiles, summary, source]),
  selectedLanguage: selected?.language ?? null,
  disclosure: isPublic ? 'public' : 'restricted',
  publicationState: source ? 'published' : 'unpublished', structuredPublication: source,
  structuredPublicationCandidate, structurePublicationHead: row.publicationHead?.value ?? null,
  ...(row.provenance ? { fieldProvenance: JSON.parse(row.provenance.value) as Static<typeof workHeader>['fieldProvenance'] } : {}) };
}

/** Repeat the admission after hydration; Access restrictions need not move the graph. */
export async function fenceWorkBasis(session: WorkReadSession, basis: WorkBasis): Promise<void> {
  if (basis.disclosure === 'restricted' && (!session.principal || !session.options.actingSubject
    || !await session.deps.access.canReadWork(session.principal, session.options.actingSubject, basis.card.id))) {
    throw new WorkReadMissing('Work is unavailable');
  }
  if (basis.structuredPublicationCandidate
    && !await workPublicationContainerDisclosureVisible(session, basis.card.id)) {
    throw new WorkReadMoved('Published Work disclosure changed');
  }
  if (basis.structuredPublication && !await structureRevisionDisclosureVisible(session, {
    work: basis.card.id, workRevision: basis.card.revision,
    structure: basis.structuredPublication.structure, revision: basis.structuredPublication.structureRevision,
  })) throw new WorkReadMoved('Published Structure disclosure changed');
  const summary = (await session.summaries([basis.card.id]))[0];
  if (summary?.status !== 'available') throw new WorkReadMissing('Work is unavailable');
}

export async function readWorkHeader(session: WorkReadSession, work: string) {
  const basis = await readWorkBasis(session, work);
  // Admission is shared by Recipe, contents, editions and other readers that
  // never display these asynchronously projected facts. Only their consumer
  // owns this dependency; relay progress must not invalidate another read.
  const stats = (await readSerialStatistics(session, [work]))?.get(work) ?? null;
  const metadata = basis.metadata;
  const selected = selectedMetadata(metadata, session.options.language);
  // Catalogue creation can carry a source synopsis before an editor has made
  // a separate metadata component. It keeps the same disclosure and licence.
  if (!metadata.revision && !selected.description) {
    const descriptions = await session.query(`SELECT ?text WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} schema:description ?text } } LIMIT 2`, 2);
    if (descriptions.length > 1) throw new WorkReadUnavailable('Work description is ambiguous');
    const text = descriptions[0]?.text;
    if (text) selected.description = { ...recordedDisplayText({ value: text.value, language: text['xml:lang'] ?? 'und' }),
      basis: 'fallback' };
  }
  if (selected.description && (await session.disclosure([
    { owner: 'graph', resource: work, component: 'synopsis' },
  ]))[0] !== 'visible') selected.description = null;
  await fenceWorkBasis(session, basis);
  const store = session.deps.rights?.store;
  let descriptionObligations: WikiDisplayObligations = { status: 'unassessed' };
  let factObligations: WikiDisplayObligations = { status: 'unassessed' };
  if (store) {
    try {
      const read = () => store.currentWikiDisplayObligations([workDescriptionMaterial(work), resourceFactMaterial(work)]);
      const rights = await read();
      descriptionObligations = rights[0] ?? descriptionObligations;
      factObligations = rights[1] ?? factObligations;
      session.observeDependency(`work-display-rights:${work}`, rights, read);
    } catch (error) {
      if (error instanceof RightsUnavailable || error instanceof RightsInvalid) {
        throw new WorkReadUnavailable('Rights obligations are unavailable');
      }
      throw error;
    }
  }
  const attribution = await selectedPublicationAttribution(session, basis.structuredPublication);
  return { profile: 'work-read-v1' as const, ...basis.card,
    chapterCount: stats?.chapterCount ?? null, wordCount: stats?.wordCount ?? null,
    lastUpdatedAt: stats?.lastUpdatedAt ?? null, disclosure: basis.disclosure,
    publicationState: basis.publicationState,
    ...(attribution ? { rights: { basis: 'public-domain' as const, source: attribution } } : {}),
    ...(session.principal && session.options.actingSubject
      && await session.deps.access.canEditWork(session.principal, session.options.actingSubject, work)
      ? { structurePublicationHead: basis.structurePublicationHead } : {}),
    descriptionObligations, factObligations,
    ...(basis.fieldProvenance ? { fieldProvenance: basis.fieldProvenance } : {}),
    title: selected.title ?? basis.card.title, description: selected.description,
    tagline: selected.tagline, completionStatus: metadata.completionStatus,
    metadataRevision: metadata.revision,
    originalTitle: metadata.originalTitle ? recordedDisplayText(metadata.originalTitle) : null,
    mainVersionRevision: basis.mainRevision, mainVersionLabel: selected.mainVersionLabel,
    selectedLanguage: basis.selectedLanguage, sourcePosition: { ...session.position,
      ...(session.options.localBasis ? { dependencyToken: basis.dependencyToken } : {}) },
    ...workHeaderNavigation(work) };
}
