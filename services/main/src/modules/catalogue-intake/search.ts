import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { queryPublicMainPhrase } from '../work/search-public.ts';
import { publicWork, workRead, type WorkReadSession } from '../work/read-session.ts';
import { readReleasesByIdentifier, readWorkReleases } from '../release/read.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import type { FieldMatch } from '../search/fields.ts';
import { parsedMetadataState } from '../work/metadata-read.ts';
import { publicAgent } from '../profiles/read.ts';
import { CATALOGUE_COST, CatalogueUnavailable, type CandidateInput } from './schema.ts';

export interface CatalogueCandidate {
  work: string; mainVersion: string; revision: string;
  attributes: { field: string; value: string; language: string | null }[];
}

/** The existing lexical index supplies published candidates; the live public
 * metadata join also covers aliases and newly provisioned catalogue stubs.
 * Identifier evidence remains a Release/realization match, never Work identity. */
export async function searchCatalogue(deps: MainWorkDependencies, input: CandidateInput) {
  const terms = [...new Set([input.originalTitle, ...input.aliases, ...input.romanizations]
    .map(title => title.value).concat(input.creators))];
  // Candidate intake retrieves only public facts. The authenticated contributor
  // is bound to the receipt separately; private Work access never expands it.
  const request = new Request('http://main.local/internal/catalogue-public-read');
  return workRead(deps, request, {}, async session => {
    const ids = new Set<string>();
    const matchedAttributes = new Map<string, CatalogueCandidate['attributes']>();
    for (const phrase of terms) {
      if (phrase.trim().length < 2) continue; // Single-character titles use the live title relation.
      const found = await queryPublicMainPhrase(deps.environment, { phrase: phrase.slice(0, 80), language: null,
        publicFields: { names: deps.sourceAuthorNames,
          restrictedTitles: deps.governance?.store
            ? (heads, context) => deps.governance!.store.restrictedTitles(heads, context) : undefined } });
      for (const row of found.results) {
        ids.add(row.work);
        const match = row as Partial<FieldMatch>;
        if (typeof match.matchedText === 'string' && match.matchedField) {
          const attributes = matchedAttributes.get(row.work) ?? [];
          attributes.push({ field: match.matchedField, value: match.matchedText, language: match.matchedLanguage ?? null });
          matchedAttributes.set(row.work, attributes);
        }
      }
    }
    const titleFilters = [...new Set(terms.flatMap(term => [term.normalize('NFC'), term.normalize('NFD')]))]
      .map(term => `CONTAINS(LCASE(STR(?value)), ${lit(term.toLowerCase())})`);
    const dateFilters = input.dates.map(year => `REGEX(STR(?value), ${lit(`"publicationYear":${year}[,}]`)})`);
    const rows = await session.query(`SELECT DISTINCT ?work ?metadataState WHERE {
      ${publicWork('?work', '?main')}
      { GRAPH ${iri(GRAPHS.current)} { ?work ?predicate ?value .
          VALUES ?predicate { rdfs:label schema:alternateName } }
        FILTER(${titleFilters.join(' || ')}) }
      UNION { GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?metadata }
        GRAPH ${iri(GRAPHS.revisions)} { ?metadata rv:metadataState ?metadataState }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?metadata a rv:ErasedRevision } }
        BIND(?metadataState AS ?value)
        FILTER(${titleFilters.join(' || ')}) }
      UNION { GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ?work ;
          rv:creditRevision ?creditHead ; rv:agent ?agent ; schema:roleName "author" }
        GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:NativeAgentCreditRevision ; rv:component ?credit .
          FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } }
        ${publicAgent('?agent')} BIND(?displayName AS ?value)
        FILTER(${titleFilters.join(' || ')}) }
    } ORDER BY STR(?work) LIMIT ${CATALOGUE_COST.candidates + 1}`, CATALOGUE_COST.candidates);
    for (const row of rows) {
      if (!row.work) throw new CatalogueUnavailable('Candidate identity is incomplete');
      if (row.metadataState) {
        const metadata = parsedMetadataState(row.metadataState.value);
        if (metadata.kind !== 'header') throw new CatalogueUnavailable('Work title metadata is incomplete');
        const titles = [metadata.originalTitle?.value, ...metadata.localized.map(locale => locale.title)]
          .filter((value): value is string => typeof value === 'string');
        // JSON also carries descriptions. Only the title fields can qualify
        // this branch; serialized prose is not an alternate title match.
        if (!titles.some(value => terms.some(term => value.normalize('NFC').toLowerCase()
          .includes(term.normalize('NFC').toLowerCase())))) continue;
      }
      ids.add(row.work.value);
    }
    const releaseEvidence = matchedAttributes;
    if (input.dates.length) {
      const dated = await session.query(`SELECT DISTINCT ?work WHERE {
        ${publicWork('?work', '?main')}
        GRAPH ${iri(GRAPHS.current)} { ?release a rv:Release ; rv:work ?work ; rv:releaseHead ?head }
        GRAPH ${iri(GRAPHS.revisions)} { ?head rv:releaseState ?value }
        FILTER(${dateFilters.join(' || ')}) } LIMIT 129`, 128);
      for (const row of dated) {
        // The Release owner fences every covered Work of an omnibus. A raw
        // date projection cannot qualify a release with an undisclosed member.
        const page = await readWorkReleases(session, row.work!.value);
        if (page.nextCursor) throw new CatalogueUnavailable('Publication dates exceed the complete search bound');
        for (const release of page.items) {
          if (!release.publicationYear || !input.dates.includes(release.publicationYear)) continue;
          ids.add(row.work!.value);
          const attributes = releaseEvidence.get(row.work!.value) ?? [];
          attributes.push({ field: 'publication-year', value: String(release.publicationYear), language: null },
            { field: 'release', value: release.id, language: null });
          releaseEvidence.set(row.work!.value, attributes);
        }
      }
    }
    for (const identifier of input.identifiers) {
      const found = await readReleasesByIdentifier(session, identifier);
      if (found.nextCursor) throw new CatalogueUnavailable('Identifier candidates exceed the complete search bound');
      for (const release of found.items) {
        const works = release.coverage.map(item => item.work);
        for (const work of works) {
          ids.add(work);
          const attributes = releaseEvidence.get(work) ?? [];
          attributes.push({ field: 'release', value: release.id, language: null },
            { field: 'identifier', value: JSON.stringify(identifier), language: null });
          if (release.publicationYear) attributes.push({ field: 'publication-year', value: String(release.publicationYear), language: null });
          releaseEvidence.set(work, attributes);
        }
      }
    }
    if (ids.size > CATALOGUE_COST.candidates) throw new CatalogueUnavailable('Candidates exceed the complete search bound');
    const candidates = await hydrateCandidates(session, [...ids].sort(), releaseEvidence);
    return { candidates, sourcePosition: session.position };
  });
}

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
    GRAPH ${iri(GRAPHS.current)} { ?work schema:alternateName ?alias } } LIMIT 2049`, 2048);
  const creators = await session.query(`SELECT DISTINCT ?work ?displayName WHERE { VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ?work ; rv:creditRevision ?creditHead ;
      rv:agent ?agent ; schema:roleName "author" }
    GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:NativeAgentCreditRevision ; rv:component ?credit .
      FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } }
    ${publicAgent('?agent')} } LIMIT 513`, 512);
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
  return output.sort((a, b) => a.work < b.work ? -1 : a.work > b.work ? 1 : 0);
}
