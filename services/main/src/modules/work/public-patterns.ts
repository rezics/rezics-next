import { GRAPHS, iri, type WorkActivationEnvironment } from './activate.ts';
import { DISCLOSURE_COST, discloseInventory, type DisclosureChannel } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';

/** Public provenance endpoints have no acting identity. An exact Main Version
 * selector must resolve through a currently disclosed Work before its inventory
 * (including an empty inventory) can reveal that the revision exists. */
export async function publicMainRevisionVisible(environment: WorkActivationEnvironment,
  mainVersion: string, revision: string): Promise<boolean> {
  const rows = (await environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> SELECT DISTINCT ?work WHERE {
      ${publicWork('?work', iri(mainVersion))}
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} .
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
  const work = rows[0]?.work?.value;
  return rows.length === 1 && !!work && (await admittedPublicWorks(environment, [work])).has(work);
}

/** Graph publication is a candidate predicate, not audience admission. Owners
 * returning identities/counts without summaries disclose both the Work name
 * and its selected Structure revision before pagination or aggregation. */
export async function admittedPublicWorks(environment: WorkActivationEnvironment | undefined,
  works: readonly string[], viewer: Viewer = ANONYMOUS_VIEWER,
  sourcesAtCut?: ReadonlyMap<string, PublishedStructuredWorkSource>, channel: DisclosureChannel = 'read'): Promise<ReadonlySet<string>> {
  const unique = [...new Set(works)];
  if (!environment) return new Set(unique); // Graph-only legacy owner fixtures.
  const visible = new Set<string>();
  const worksPerBatch = Math.floor(DISCLOSURE_COST.batch / 3);
  for (let offset = 0; offset < unique.length; offset += worksPerBatch) {
    const batch = unique.slice(offset, offset + worksPerBatch);
    const sources = sourcesAtCut
      ? new Map([...sourcesAtCut].filter(([work]) => batch.includes(work)))
      : await readPublishedStructuredWorkSources(environment, batch);
    const sourceWorks = [...sources.keys()];
    const parents = await readWorkPublicationParents(environment, sourceWorks);
    const parentWorks = sourceWorks.filter(work => parents.has(work));
    const targets = [
      ...batch.map(resource => ({ owner: 'graph' as const, resource, component: 'name' as const, work: resource })),
      ...[...sources.values()].map(source => ({ owner: 'graph' as const, resource: source.structure,
        component: 'structure' as const, revision: source.structureRevision, work: source.work })),
      ...parentWorks.map(work => ({ owner: 'graph' as const, resource: parents.get(work)!,
        component: 'publication' as const, work: parents.get(work)! })),
    ];
    const decisions = await discloseInventory(environment, targets, viewer, channel);
    batch.forEach((work, index) => {
      const sourceIndex = sourceWorks.indexOf(work);
      const parentIndex = parentWorks.indexOf(work);
      if (decisions[index] === 'visible'
        && (!sources.has(work) || decisions[batch.length + sourceIndex] === 'visible')
        && (parentIndex < 0 || decisions[batch.length + sourceWorks.length + parentIndex] === 'visible')) {
        visible.add(work);
      }
    });
  }
  return visible;
}

export const unerased = (work: string) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
  ?erasedVariant rv:resource ${work} ; rv:contentPublicationHead ?erasedPublication }
  GRAPH ${iri(GRAPHS.revisions)} { ?erasedPublication rv:contentRevision ?erasedRevision .
    ?erasedRevision a rv:ErasedRevision } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:head ?erasedWorkHead }
    GRAPH ${iri(GRAPHS.revisions)} { ?erasedWorkHead a rv:ErasedRevision } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:protectionHead ?protection } }`;

/** Binds the current reviewed publication for consumers that need selected text. */
export const publishedWork = (work: string, main: string) => `GRAPH ${iri(GRAPHS.current)} {
  ${work} a schema:CreativeWork ; rv:mainVersion ${main} .
  ${main} a rv:MainVersion ; rv:work ${work} ; rv:selectionHead ?publicSelection .
  ?publicContribution rv:work ${work} ; rv:publicationHead ?publicDecision . }
  GRAPH ${iri(GRAPHS.revisions)} { ?publicSelection a rv:PublicationSelection ;
    rv:work ${work} ; rv:mainVersion ${main} ;
    rv:contribution ?publicContribution ; rv:publicationDecision ?publicDecision ; rv:selectedDraft ?publicDraft .
    ?publicDecision a rv:PublicationDecision ; rv:component ?publicContribution ; rv:work ${work} ;
      rv:contribution ?publicContribution ; rv:disclosure rv:Public ; rv:selectedDraft ?publicDraft .
    ?publicDraft a rv:RevisionAnchor ; rv:component ?publicContribution .
    FILTER NOT EXISTS { ?publicDraft a rv:ErasedRevision } }`;

/** Binds an admitted exact Structure source for candidate visibility. This
 * deliberately does not bind any occurrence or selected-text variables. */
export const publishedStructuredWork = (work: string, main: string) => `GRAPH ${iri(GRAPHS.current)} {
  ${work} a schema:CreativeWork ; rv:mainVersion ${main} ;
    rv:workStructurePublicationHead ?structuredDecision .
  ${main} a rv:MainVersion ; rv:work ${work} .
  ?structuredStructure a rv:Structure ; rv:structureOf ${main} ; rv:structureProfile ?structuredProfile .
  ?structuredGeneration a rv:StructureGeneration ; rv:structure ?structuredStructure . }
  GRAPH ${iri(GRAPHS.revisions)} {
    ?structuredDecision a rv:WorkStructurePublicationDecision ; rv:component ${work} ;
      rv:publicationOutcome rv:Published ; rv:publicSource ?structuredSource ;
      rv:disclosure rv:Public ; rv:rightsBasis ?structuredBasis .
    FILTER(?structuredBasis = rv:OriginalContribution || ?structuredBasis = rv:PublicDomain)
    FILTER(?structuredBasis != rv:PublicDomain || EXISTS {
      ?structuredDecision rv:sourceObservation ?structuredObservation .
      ?structuredSource rv:sourceObservation ?structuredObservation . } || EXISTS {
      ?structuredDecision rv:rightsAssessment ?structuredAssessment .
      ?structuredSource rv:rightsAssessment ?structuredAssessment ; schema:citation ?structuredCitation .
      FILTER(REGEX(STR(?structuredAssessment), "^urn:rezics:rights:assessment:[0-9a-f-]{36}$"))
      FILTER NOT EXISTS { ?structuredDecision rv:sourceObservation ?manualObservation }
      FILTER NOT EXISTS { ?structuredSource rv:sourceObservation ?manualSourceObservation } })
    ?structuredSource a rv:WorkStructurePublicSource ; rv:work ${work} ; rv:component ${main} ;
      rv:structureProfile ?structuredProfile ; rv:structure ?structuredStructure ; rv:structureRevision ?structuredRevision ;
      rv:selectedGeneration ?structuredGeneration ; rv:sourceRoot ?structuredRoot .
    ?structuredRevision a rv:StructureRevision ; rv:component ?structuredStructure ;
      rv:generation ?structuredGeneration ; rv:manifest ?structuredRoot .
    FILTER(REGEX(STR(?structuredRoot), "^urn:rezics:sha256:[0-9a-f]{64}$"))
    FILTER NOT EXISTS { ?structuredRevision a rv:ErasedRevision } }`;

export interface PublishedStructuredWorkSource {
  decision: string;
  source: string;
  work: string;
  mainVersion: string;
  structure: string;
  structureProfile: string;
  structureRevision: string;
  selectedGeneration: string;
  sourceRoot: string;
  sourceObservation?: string;
  rightsAssessmentId?: string;
}

const nativeWorkId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const structuredRoot = /^urn:rezics:sha256:[0-9a-f]{64}$/;

export class PublishedStructureSourceUnavailable extends Error {
  constructor(readonly reason: 'invalid' | 'incomplete' | 'ambiguous', batch = false) {
    super(`Published Structure source${batch ? ' batch' : ''} is ${reason}`);
    this.name = 'PublishedStructureSourceUnavailable';
  }
}

/** Read every declared root before checking the exact admission predicate: a
 * malformed root must neither disappear nor hide beside a valid root. */
export const structuredPublicationRead = (work: string, main: string) => `
  GRAPH ${iri(GRAPHS.current)} { ${work} rv:workStructurePublicationHead ?structuredDecision }
  GRAPH ${iri(GRAPHS.revisions)} { ?structuredDecision a rv:WorkStructurePublicationDecision ;
    rv:component ${work} ; rv:publicationOutcome rv:Published .
    OPTIONAL { ?structuredDecision rv:sourceObservation ?structuredObservation }
    OPTIONAL { ?structuredDecision rv:rightsAssessment ?structuredAssessment }
    OPTIONAL { ?structuredDecision rv:publicSource ?structuredSource .
      OPTIONAL { ?structuredSource rv:work ${work} ; rv:component ?structuredSourceMain ;
        rv:structure ?structuredStructure ; rv:structureProfile ?structuredProfile ;
        rv:structureRevision ?structuredRevision ; rv:selectedGeneration ?structuredGeneration ;
        rv:sourceRoot ?structuredRoot . } } }
  BIND(EXISTS { ${publishedStructuredWork(work, main)}
    FILTER(?structuredSourceMain = ${main}) } AS ?structuredExact)`;

/** Resolve the one immediate parent used by publication governance. Ambiguous
 * ancestry fails closed instead of checking only one arbitrary container. */
export async function readWorkPublicationParents(environment: WorkActivationEnvironment,
  works: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(works)];
  if (!unique.length) return new Map();
  if (unique.length > 64 || unique.some(work => !nativeWorkId.test(work))) {
    throw new Error('Publication parent batch is invalid');
  }
  const rows = (await environment.fuseki.query(`PREFIX schema: <https://schema.org/>
    SELECT ?work ?parent WHERE {
      VALUES ?work { ${unique.map(iri).join(' ')} }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work schema:isPartOf ?parent } }
    } LIMIT ${unique.length + 1}`, 32 * 1024)).results?.bindings ?? [];
  if (rows.length !== unique.length) throw new Error('Publication parent batch is ambiguous');
  const seen = new Set<string>();
  const parents = new Map<string, string>();
  for (const row of rows) {
    const work = row.work?.value;
    const parent = row.parent?.value;
    if (!work || !unique.includes(work) || seen.has(work)
      || parent !== undefined && (!nativeWorkId.test(parent) || parent === work)) {
      throw new Error('Publication parent batch is incomplete');
    }
    seen.add(work);
    if (parent) parents.set(work, parent);
  }
  if (seen.size !== unique.length) throw new Error('Publication parent batch is incomplete');
  return parents;
}

function sourceFromRow(row: NonNullable<import('../../infrastructure/fuseki.ts').SparqlResult['results']>['bindings'][number],
  work: string, mainVersion: string): PublishedStructuredWorkSource {
  const value = (key: string) => row[key]?.value;
  const source: PublishedStructuredWorkSource = {
    decision: value('structuredDecision') ?? '',
    source: value('structuredSource') ?? '',
    work, mainVersion,
    structure: value('structuredStructure') ?? '',
    structureProfile: value('structuredProfile') ?? '',
    structureRevision: value('structuredRevision') ?? '',
    selectedGeneration: value('structuredGeneration') ?? '',
    sourceRoot: value('structuredRoot') ?? '',
    ...(value('structuredObservation') ? { sourceObservation: value('structuredObservation')! } : {}),
    ...(value('structuredAssessment') ? { rightsAssessmentId:
      value('structuredAssessment')!.slice('urn:rezics:rights:assessment:'.length) } : {}),
  };
  if (![source.work, source.mainVersion, source.decision, source.structure, source.structureRevision, source.selectedGeneration]
      .every(value => nativeWorkId.test(value))
    || !source.source.startsWith('urn:rezics:work-source:')
    || !/^https:\/\/rezics\.com\/vocab\/[A-Za-z][A-Za-z0-9]*$/.test(source.structureProfile)
    || !structuredRoot.test(source.sourceRoot) || value('structuredExact') !== 'true'
    || value('structuredAssessment') !== undefined
      && (!/^urn:rezics:rights:assessment:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value('structuredAssessment')!)
        || source.sourceObservation !== undefined)) {
    throw new PublishedStructureSourceUnavailable('incomplete');
  }
  return source;
}

/** Decode the publication columns at the same cut as the owner's Work probe. */
export function publishedStructuredWorkSourceFromRows(
  rows: NonNullable<import('../../infrastructure/fuseki.ts').SparqlResult['results']>['bindings'],
  work: string, mainVersion: string): PublishedStructuredWorkSource | null {
  if (!rows.length || rows.length === 1 && !rows[0]!.structuredDecision) return null;
  if (rows.length !== 1) throw new PublishedStructureSourceUnavailable('ambiguous');
  return sourceFromRow(rows[0]!, work, mainVersion);
}

/** Resolve exact admitted roots in one bounded owner query. No current
 * Structure head or selected-text publication is substituted. */
export async function readPublishedStructuredWorkSources(environment: WorkActivationEnvironment,
  works: readonly string[]): Promise<ReadonlyMap<string, PublishedStructuredWorkSource>> {
  const unique = [...new Set(works)];
  if (!unique.length) return new Map();
  if (unique.length > 64 || unique.some(work => !nativeWorkId.test(work))) {
    throw new PublishedStructureSourceUnavailable('invalid', true);
  }
  const rows = (await environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    SELECT ?work ?main ?structuredDecision ?structuredSource ?structuredStructure ?structuredProfile
      ?structuredRevision ?structuredGeneration ?structuredRoot ?structuredObservation ?structuredAssessment ?structuredExact WHERE {
      VALUES ?work { ${unique.map(iri).join(' ')} }
      OPTIONAL { ${structuredPublicationRead('?work', '?structuredSourceMain')} }
      BIND(?structuredSourceMain AS ?main)
    } LIMIT ${unique.length + 1}`, 128 * 1024)).results?.bindings ?? [];
  if (rows.length > unique.length) throw new PublishedStructureSourceUnavailable('ambiguous', true);
  const published = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const work = row.work?.value;
    if (!work || !unique.includes(work)) throw new PublishedStructureSourceUnavailable('incomplete', true);
    if (!row.structuredDecision) continue;
    if (published.has(work)) throw new PublishedStructureSourceUnavailable('ambiguous', true);
    published.set(work, row);
  }
  return new Map([...published].map(([work, row]) => [work, sourceFromRow(row, work, row.main?.value ?? '')]));
}

/** Resolve the exact admitted root used by the common public-candidate branch.
 * No current Structure head or selected-text publication is substituted. */
export async function readPublishedStructuredWorkSource(environment: WorkActivationEnvironment,
  work: string, mainVersion: string): Promise<PublishedStructuredWorkSource | null> {
  if (!nativeWorkId.test(work) || !nativeWorkId.test(mainVersion)) return null;
  const rows = (await environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    SELECT ?structuredDecision ?structuredSource ?structuredStructure ?structuredProfile
      ?structuredRevision ?structuredGeneration ?structuredRoot ?structuredObservation ?structuredAssessment ?structuredExact WHERE {
      ${structuredPublicationRead(iri(work), iri(mainVersion))}
    } LIMIT 2`, 16 * 1024)).results?.bindings ?? [];
  return publishedStructuredWorkSourceFromRows(rows, work, mainVersion);
}

/** A visibility predicate: being both published and catalogue-visible must
 * still yield exactly one Work/main binding. Publication variables are local
 * to EXISTS; consumers needing a selected text use publishedWork explicitly. */
export const publicWork = (work: string, main: string) => `GRAPH ${iri(GRAPHS.current)} {
  ${work} a schema:CreativeWork ; rv:mainVersion ${main} .
  ${main} a rv:MainVersion ; rv:work ${work} . }
  FILTER(EXISTS { ${publishedWork(work, main)} }
    || EXISTS { ${publishedStructuredWork(work, main)} }
    || EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:catalogueVisible true } })
  ${unerased(work)}`;
