import { GRAPHS, iri, type WorkActivationEnvironment } from './activate.ts';
import { DISCLOSURE_COST, discloseInventory } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';

/** Graph publication is a candidate predicate, not audience admission. Owners
 * returning identities/counts without summaries disclose both the Work name
 * and its selected Structure revision before pagination or aggregation. */
export async function admittedPublicWorks(environment: WorkActivationEnvironment | undefined,
  works: readonly string[], viewer: Viewer = ANONYMOUS_VIEWER): Promise<ReadonlySet<string>> {
  const unique = [...new Set(works)];
  if (!environment) return new Set(unique); // Graph-only legacy owner fixtures.
  const visible = new Set<string>();
  const worksPerBatch = Math.floor(DISCLOSURE_COST.batch / 2);
  for (let offset = 0; offset < unique.length; offset += worksPerBatch) {
    const batch = unique.slice(offset, offset + worksPerBatch);
    const sources = await readPublishedStructuredWorkSources(environment, batch);
    const sourceWorks = [...sources.keys()];
    const targets = [
      ...batch.map(resource => ({ owner: 'graph' as const, resource, component: 'name' as const, work: resource })),
      ...[...sources.values()].map(source => ({ owner: 'graph' as const, resource: source.structure,
        component: 'structure' as const, revision: source.structureRevision, work: source.work })),
    ];
    const decisions = await discloseInventory(environment, targets, viewer, 'read');
    batch.forEach((work, index) => {
      if (decisions[index] === 'visible'
        && (!sources.has(work) || decisions[batch.length + sourceWorks.indexOf(work)] === 'visible')) visible.add(work);
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
  ${main} a rv:MainVersion ; rv:work ${work} . }
  GRAPH ${iri(GRAPHS.revisions)} {
    ?structuredDecision a rv:WorkStructurePublicationDecision ; rv:component ${work} ;
      rv:publicationOutcome rv:Published ; rv:publicSource ?structuredSource ;
      rv:disclosure rv:Public ; rv:rightsBasis rv:OriginalContribution .
    ?structuredSource a rv:WorkStructurePublicSource ; rv:work ${work} ; rv:component ${main} ;
      rv:structureProfile ?structuredProfile ; rv:structure ?structuredStructure ; rv:structureRevision ?structuredRevision ;
      rv:selectedGeneration ?structuredGeneration ; rv:sourceRoot ?structuredRoot .
    ?structuredStructure a rv:Structure ; rv:structureOf ${main} ; rv:structureProfile ?structuredProfile .
    ?structuredGeneration a rv:StructureGeneration ; rv:structure ?structuredStructure .
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
}

const nativeWorkId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const structuredRoot = /^urn:rezics:sha256:[0-9a-f]{64}$/;

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
  };
  if (![source.decision, source.structure, source.structureRevision, source.selectedGeneration]
      .every(value => nativeWorkId.test(value))
    || !source.source.startsWith('urn:rezics:work-source:')
    || !/^https:\/\/rezics\.com\/vocab\/[A-Za-z][A-Za-z0-9]*$/.test(source.structureProfile)
    || !structuredRoot.test(source.sourceRoot)) {
    throw new Error('Published Structure source is incomplete');
  }
  return source;
}

/** Resolve exact admitted roots in one bounded owner query. No current
 * Structure head or selected-text publication is substituted. */
export async function readPublishedStructuredWorkSources(environment: WorkActivationEnvironment,
  works: readonly string[]): Promise<ReadonlyMap<string, PublishedStructuredWorkSource>> {
  const unique = [...new Set(works)];
  if (!unique.length) return new Map();
  if (unique.length > 64 || unique.some(work => !nativeWorkId.test(work))) {
    throw new Error('Published Structure source batch is invalid');
  }
  const rows = (await environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    SELECT ?work ?main ?structuredDecision ?structuredSource ?structuredStructure ?structuredProfile
      ?structuredRevision ?structuredGeneration ?structuredRoot WHERE {
      VALUES ?work { ${unique.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main . }
      ${publishedStructuredWork('?work', '?main')}
    } LIMIT ${unique.length + 1}`, 128 * 1024)).results?.bindings ?? [];
  if (rows.length > unique.length) throw new Error('Published Structure source batch is ambiguous');
  const result = new Map<string, PublishedStructuredWorkSource>();
  for (const row of rows) {
    const work = row.work?.value, mainVersion = row.main?.value;
    if (!work || !mainVersion || !unique.includes(work) || result.has(work)
      || !nativeWorkId.test(mainVersion)) throw new Error('Published Structure source batch is incomplete');
    result.set(work, sourceFromRow(row, work, mainVersion));
  }
  return result;
}

/** Resolve the exact admitted root used by the common public-candidate branch.
 * No current Structure head or selected-text publication is substituted. */
export async function readPublishedStructuredWorkSource(environment: WorkActivationEnvironment,
  work: string, mainVersion: string): Promise<PublishedStructuredWorkSource | null> {
  if (!nativeWorkId.test(work) || !nativeWorkId.test(mainVersion)) return null;
  const rows = (await environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    SELECT ?structuredDecision ?structuredSource ?structuredStructure ?structuredProfile
      ?structuredRevision ?structuredGeneration ?structuredRoot WHERE {
      ${publishedStructuredWork(iri(work), iri(mainVersion))}
    } LIMIT 2`, 16 * 1024)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('Published Structure source is ambiguous');
  return sourceFromRow(rows[0]!, work, mainVersion);
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
