import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { searchableStructureProfiles } from './profiles.ts';
import { CompositionUnavailable, itemPosition, readCompositionHeader, roleIri } from './graph.ts';
import { publishedCompositionRevision, readCompositionSnapshot } from './read.ts';
import { recordTree } from './change.ts';
import { admittedPublicWorks, readPublishedStructuredWorkSources } from '../work/public-patterns.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import { DisclosureUnavailable } from '../disclosure/read.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { PHRASE_HIT_PROBE } from '../work/search-readiness.ts';

export interface SearchPlacement {
  resource: string; work: string; occurrence: string; profile: string; title: string;
  /** Omitted when equal to the enclosing hit revision. */
  revision?: string;
}

/** Keep every active occurrence. A fixed use only matches its exact selected revision.
 * A full-Content index cannot prove that a phrase lies inside a selector. */
function currentPlacement(resource: string, work: string, main: string, revision: string,
  occurrence = '?searchOccurrence', profile = '?searchProfile') {
  const registrations = searchableStructureProfiles().filter(profile => !profile.workPublication);
  if (!registrations.length) return 'FILTER(false)';
  return `GRAPH ${iri(GRAPHS.current)} {
    VALUES (?searchGraphProfile ?searchOwnerType ?searchRole ${profile}) {
      ${registrations.flatMap(registration => registration.searchableRoles!.map(role =>
        `(<${registration.graphProfile}> <${registration.ownerType}> <${roleIri(role)}> ${lit(registration.id)})`)).join('\n')}
    }
    ${work} a ?searchOwnerType ; rv:mainVersion ${main} .
    ${main} a rv:MainVersion ; rv:work ${work} .
    ?searchStructure a rv:Structure ; rv:structureProfile ?searchGraphProfile ;
      rv:structureOf ${main} ; rv:selectedGeneration ?searchGeneration .
    ?searchGeneration rv:generationState rv:Active .
    ?searchPlacement a rv:OccurrencePlacement ; rv:generation ?searchGeneration ;
      rv:occurrenceRole ?searchRole ; <https://schema.org/item> ${resource} ; rv:occurrence ${occurrence} ; <https://schema.org/position> ?searchPosition .
    FILTER NOT EXISTS { ?searchPlacement rv:removedBy ?searchRemoval }
    FILTER NOT EXISTS { ?searchPlacement rv:selectionSelector ?partialSelection }
    FILTER NOT EXISTS { ?searchPlacement rv:selectionMode rv:FixedRevision ; rv:pinnedRevision ?searchPin .
      FILTER(?searchPin != ${revision}) }
  }`;
}


/** Search asks Structure for its admitted relation before joining/ranking hits.
 * Current projections only discover candidates. Published profiles resolve the
 * owner's immutable revision, including old occurrences after a later draft.
 * A drifted root needs a bounded retained scan; exceeding it refuses the complete
 * search instead of silently substituting a draft or dropping old placements. */
export async function searchablePlacement(env: WorkActivationEnvironment, lucene: string,
  resource: string, work: string, main: string, revision: string,
  occurrence = '?searchOccurrence', profile = '?searchProfile'): Promise<string> {
  const current = currentPlacement(resource, work, main, revision, occurrence, profile);
  const registrations = searchableStructureProfiles().filter(profile => profile.workPublication);
  if (!registrations.length) return current;
  const resources = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT DISTINCT ?resource WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
      ?unit rv:resource ?resource ; rv:field rv:Body .
    } } LIMIT 513`, 131_072)).results?.bindings ?? [];
  if (resources.length > 512) throw new DisclosureUnavailable('Search Structure resources exceed their bound');
  const resourceIds = new Set(resources.flatMap(row => row.resource ? [row.resource.value] : []));
  if (!resourceIds.size) return current;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT DISTINCT ?work ?structure ?occurrence WHERE {
      VALUES ?profile { ${registrations.map(registration => `<${registration.graphProfile}>`).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?work rv:mainVersion ?main .
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile ?profile ;
          rv:structureHead ?head ; rv:selectedGeneration ?generation .
      }
      { GRAPH ${iri(GRAPHS.current)} {
          VALUES ?resource { ${[...resourceIds].map(iri).join(' ')} }
          ?placement rv:generation ?generation ; schema:item ?resource ; rv:occurrence ?occurrence .
        }
      } UNION {
        GRAPH ${iri(GRAPHS.current)} { ?work rv:workStructurePublicationHead ?decision }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?decision rv:publicSource ?source ; rv:publicationOutcome rv:Published .
          ?source rv:structure ?structure ; rv:structureRevision ?publishedRevision .
        }
        FILTER(?head != ?publishedRevision)
      }
    } LIMIT 513`, 131_072)).results?.bindings ?? [];
  if (rows.length > 512) throw new DisclosureUnavailable('Search Structure candidates exceed their bound');
  const works = [...new Set(rows.flatMap(row => row.work ? [row.work.value] : []))];
  if (works.length > 64) throw new DisclosureUnavailable('Search Structure owners exceed their bound');
  const sources = await readPublishedStructuredWorkSources(env, works);
  const allowed = await admittedPublicWorks(env, [...sources.keys()], currentDisclosureViewer(), sources, 'search');
  const tuples: string[] = [];
  let recordsRead = 0;
  const structures = [...new Set(rows.flatMap(row => row.structure ? [row.structure.value] : []))];
  if (structures.length > 64) throw new DisclosureUnavailable('Search Structure roots exceed their bound');
  for (const structure of structures) {
    const header = await readCompositionHeader(env, structure);
    if (!header || !allowed.has(header.work)) continue;
    let selectedRevision: string;
    try { selectedRevision = publishedCompositionRevision(header, sources.get(header.work) ?? null); }
    catch (error) { if (error instanceof CompositionUnavailable) continue; throw error; }
    const snapshot = await readCompositionSnapshot(env, { structure, header, revision: selectedRevision });
    const tree = recordTree(snapshot.objects);
    const keys = rows.filter(row => row.structure?.value === structure && row.occurrence)
      .map(row => row.occurrence!.value);
    const records = selectedRevision === header.head
      ? [...(await tree.lookup(snapshot.manifest.records, keys, snapshot.cost)).values()]
      : await tree.range(snapshot.manifest.records, '', '\uffff', 513 - recordsRead, snapshot.cost);
    recordsRead += records.length;
    if (recordsRead > 512) throw new DisclosureUnavailable('Search retained Structure records exceed their bound');
    const registration = registrations.find(item => item.id === header.profile)!;
    for (const record of records) {
      if (record.state !== 'active' || !record.target || !resourceIds.has(record.target)
        || !registration.searchableRoles!.includes(record.role)) continue;
      const selection = record.selection;
      const selector = selection?.mode === 'fixed-revision' ? selection.selector : undefined;
      // A whole Content index can prove a complete Content selector, never a
      // block or media fragment. Fixed revisions remain exact after later drafts.
      if (selector && (selector.grain !== 'content' || selector.block)) continue;
      const pin = selection?.mode === 'fixed-revision'
        ? selector ? `urn:rezics:content:revision:${selection.revision}` : selection.revision : null;
      tuples.push(`(${iri(record.target)} ${iri(header.work)} ${iri(header.component)}
        ${iri(record.occurrence)} ${lit(header.profile)}
        ${lit(itemPosition(record.segmentKey!, record.orderKey!))} ${pin ? iri(pin) : 'UNDEF'})`);
    }
  }
  if (!tuples.length) return current;
  return `{ { ${current} } UNION {
    VALUES (${resource} ${work} ${main} ${occurrence} ${profile} ?searchPosition ${revision}) {
      ${tuples.join('\n')}
    }
  } }`;
}
