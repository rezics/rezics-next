import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { assertPublicTextReady, assertSameTextInstance } from '../work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { catalogueTitleKey } from './title-keys.ts';
import { publicWork, workRead, type WorkReadSession } from '../work/read-session.ts';
import { readReleasesByIdentifier, readWorkReleases } from '../release/read.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { parsedMetadataState } from '../work/metadata-read.ts';
import { publicAgent } from '../profiles/read.ts';
import { CATALOGUE_COST, CatalogueUnavailable, type CandidateInput } from './schema.ts';

export interface CatalogueCandidate {
  work: string; mainVersion: string; revision: string;
  attributes: { field: string; value: string; language: string | null }[];
}

/** Top-N evidence, never a uniqueness proof. Jena's bounded text:query
 * returns indexed hits in score order; literal-key probes find catalogue stubs:
 * https://jena.apache.org/documentation/query/text-query.html#query-with-sparql
 * Dates and creators refine the retrieved Works rather than scan a population. */
export async function searchCatalogue(deps: MainWorkDependencies, input: CandidateInput) {
  const titles = [input.originalTitle, ...input.aliases, ...input.romanizations];
  const terms = [...new Set(titles.map(title => title.value))];
  const request = new Request('http://main.local/internal/catalogue-public-read');
  return workRead(deps, request, {}, async session => {
    const ranks = new Map<string, { priority: number; score: number }>();
    const evidence = new Map<string, CatalogueCandidate['attributes']>();
    const add = (work: string, priority: number, score = 0) => {
      const prior = ranks.get(work);
      ranks.set(work, { priority: Math.min(priority, prior?.priority ?? priority),
        score: Math.max(score, prior?.score ?? score) });
    };
    const keys = [...new Set(terms.map(catalogueTitleKey))];
    const literals = [...new Set(titles.flatMap(title => [title.value.normalize('NFC'), title.value.normalize('NFD')]
      .map(value => `${lit(value)}@${title.language}`)))];
    const exact = await session.query(`SELECT DISTINCT ?work WHERE {
      { VALUES ?key { ${keys.map(lit).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?work ?predicate ?key .
          VALUES ?predicate { rv:catalogueTitleKey rv:catalogueMetadataTitleKey } } }
      UNION { VALUES ?value { ${literals.join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?work ?predicate ?value .
          VALUES ?predicate { rdfs:label schema:alternateName } } }
      ${publicWork('?work', '?main')}
    } ORDER BY STR(?work) LIMIT ${CATALOGUE_COST.candidates}`, CATALOGUE_COST.candidates);
    for (const row of exact) if (row.work) add(row.work.value, 0);
    const index = await assertPublicTextReady(deps.environment.fuseki, deps.environment.lineage);
    for (const term of terms) {
      // Literal phrases cannot inject Lucene operators. The index limit applies
      // before joins and stays bounded even for "It", "Origin" and one CJK character.
      const phrase = term.slice(0, 80).replace(/[\\"]/g, '\\$&');
      const rows = await session.query(`PREFIX text: <http://jena.apache.org/text#>
        SELECT DISTINCT ?work ?score WHERE {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            # The named-graph adapter admits one field per query.
            { (?unit ?score) text:query (rv:publicTitle ${lit(`"${phrase}"`)} ${CATALOGUE_COST.candidates}) }
            UNION { (?unit ?score) text:query (rv:searchBody ${lit(`"${phrase}"`)} ${CATALOGUE_COST.candidates}) }
            ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:work ?indexedWork ;
              rv:mainVersion ?indexedMain ; rv:context ?indexedMain ; rv:selection ?selection .
            OPTIONAL { ?unit rv:searchResultWork ?resultWork }
          }
          GRAPH ${iri(GRAPHS.current)} { ?indexedMain rv:selectionHead ?selection }
          BIND(COALESCE(?resultWork, ?indexedWork) AS ?work)
          ${publicWork('?work', '?main')}
        } ORDER BY DESC(?score) STR(?work) LIMIT ${CATALOGUE_COST.candidates}`, CATALOGUE_COST.candidates);
      for (const row of rows) {
        const score = Number(row.score?.value);
        if (!row.work || !Number.isFinite(score)) throw new CatalogueUnavailable('Index candidate is incomplete');
        add(row.work.value, 2, score);
      }
    }
    await assertSameTextInstance(deps.environment.fuseki, index);
    for (const identifier of input.identifiers) {
      const page = await readReleasesByIdentifier(session, identifier);
      for (const release of page.items) {
        for (const { work } of release.coverage) {
          add(work, 1);
          const attributes = evidence.get(work) ?? [];
          attributes.push({ field: 'release', value: release.id, language: null },
            { field: 'identifier', value: JSON.stringify(identifier), language: null });
          if (release.publicationYear) attributes.push({ field: 'publication-year', value: String(release.publicationYear), language: null });
          evidence.set(work, attributes);
        }
      }
    }
    const ordered = [...ranks].sort(([a, x], [b, y]) => x.priority - y.priority || y.score - x.score || compare(a, b));
    const works = ordered.slice(0, CATALOGUE_COST.candidates).map(([work]) => work);
    if (input.dates.length) {
      // At most eight release-owner pages, each fencing every omnibus member.
      // A frequent publication year never expands the candidate population.
      for (const work of works.slice(0, CATALOGUE_COST.dateProbes)) {
        const page = await readWorkReleases(session, work);
        for (const release of page.items) {
          if (!release.publicationYear || !input.dates.includes(release.publicationYear)) continue;
          const attributes = evidence.get(work) ?? [];
          attributes.push({ field: 'publication-year', value: String(release.publicationYear), language: null },
            { field: 'release', value: release.id, language: null });
          evidence.set(work, attributes);
        }
      }
    }
    const candidates = await hydrateCandidates(session, works, evidence);
    const refinements = (candidate: CatalogueCandidate) => candidate.attributes.reduce((score, attribute) =>
      score + (attribute.field === 'publication-year' && input.dates.includes(Number(attribute.value)) ? 1 : 0)
        + (attribute.field === 'creator' && input.creators.some(name => catalogueTitleKey(attribute.value)
          .includes(catalogueTitleKey(name))) ? 1 : 0), 0);
    candidates.sort((a, b) => {
      const x = ranks.get(a.work)!, y = ranks.get(b.work)!;
      return x.priority - y.priority || refinements(b) - refinements(a) || y.score - x.score || compare(a.work, b.work);
    });
    return { complete: false as const, candidates, sourcePosition: session.position };
  });
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
async function hydrateCandidates(session: WorkReadSession, works: string[], releaseEvidence: Map<string, CatalogueCandidate['attributes']>) {
  if (!works.length) return [];
  const rows = await session.query(`SELECT DISTINCT ?work ?main ?head ?title ?metadataState ?provisional ?grain WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    ${publicWork('?work', '?main')}
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head ; rdfs:label ?title .
    }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?metadata }
      GRAPH ${iri(GRAPHS.revisions)} { ?metadata rv:metadataState ?metadataState .
        FILTER NOT EXISTS { ?metadata a rv:ErasedRevision } } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:provisional ?provisional } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:declaredGrain ?grain } }
  } LIMIT ${CATALOGUE_COST.candidates + 1}`, CATALOGUE_COST.candidates);
  const heads = rows.map(row => ({ work: row.work!.value, revision: row.head!.value }));
  const restricted = await session.deps.governance?.store.restrictedTitles(heads, DEFAULT_MEDIA_CONTEXT) ?? new Set<string>();
  const aliases = await session.query(`SELECT ?work ?alias WHERE { VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work schema:alternateName ?alias } } LIMIT 2048`, 2048);
  const creators = await session.query(`SELECT DISTINCT ?work ?displayName WHERE { VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ?work ; rv:creditRevision ?creditHead ;
      rv:agent ?agent ; schema:roleName "author" }
    GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:NativeAgentCreditRevision ; rv:component ?credit .
      FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } }
    ${publicAgent('?agent')} } LIMIT 512`, 512);
  const output: CatalogueCandidate[] = [];
  for (const row of rows) {
    if (!row.work || !row.main || !row.head || !row.title) throw new CatalogueUnavailable('Candidate attributes are incomplete');
    if (restricted.has(row.work.value)) continue;
    const attributes: CatalogueCandidate['attributes'] = [
      { field: 'title', value: row.title.value, language: row.title['xml:lang'] ?? null },
      { field: 'grain', value: row.grain?.value ?? 'work', language: null },
      ...(row.provisional ? [{ field: 'verification', value: row.provisional.value === 'true' ? 'unverified' : 'verified', language: null }] : []),
      ...(releaseEvidence.get(row.work.value) ?? []),
      ...aliases.filter(alias => alias.work?.value === row.work!.value && alias.alias)
        .map(alias => ({ field: 'alias', value: alias.alias!.value, language: alias.alias!['xml:lang'] ?? null })),
      ...creators.filter(creator => creator.work?.value === row.work!.value && creator.displayName)
        .map(creator => ({ field: 'creator', value: creator.displayName!.value, language: creator.displayName!['xml:lang'] ?? null })),
    ];
    if (row.metadataState) {
      const metadata = parsedMetadataState(row.metadataState.value);
      if (metadata.kind !== 'header') throw new CatalogueUnavailable('Work title metadata is incomplete');
      if (metadata.originalTitle) attributes.push({ field: 'original-title', ...metadata.originalTitle });
      for (const locale of metadata.localized) {
        if (locale.title) attributes.push({ field: 'alias', value: locale.title, language: locale.language });
      }
    }
    output.push({ work: row.work.value, mainVersion: row.main.value, revision: row.head.value,
      attributes: [...new Map(attributes.map(value => [JSON.stringify(value), value])).entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value) });
  }
  return output;
}
