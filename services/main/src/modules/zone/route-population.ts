import type { CompositionHeader } from '../structure/graph.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { publicWork, WorkReadUnavailable, type ReadRow } from '../work/read-session.ts';

/** Exact selected-generation membership, shared by detail routes and card batches. */
export function collectionPopulation(structure: string, head: string, generation: string,
  resource: string) {
  return `GRAPH ${iri(GRAPHS.current)} {
      ${structure} rv:structureHead ${head} ; rv:selectedGeneration ${generation} .
      ?placement a rv:OccurrencePlacement ; rv:generation ${generation} ;
        rv:occurrenceRole rv:MemberRole ; schema:item ${resource} .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    }`;
}

/** The same current public publication witness used by the Zone's /w detail route. */
export function realmPopulation(realm: string, resource: string) {
  return `GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ${resource} ;
          rv:mainVersion ?main ; rv:selectionHead ?selection .
        ?contribution rv:publicationHead ?decision . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:component ?slot ;
        rv:context ${iri(realm)} ; rv:work ${resource} ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
        ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      ${publicWork(resource, '?main')}`;
}

export type ZonePopulation = { realm: string }
  | { collection: CompositionHeader }
  | { realm: string; editorial: { zone: string; members: readonly { work: string; collection: string }[] } };
export const ZONE_POPULATION_COST = { queriesPerPage: 1, resources: 24, editorialMembers: 16,
  graphBytes: 16 * 1024 } as const;
export const editorialPopulationKey = (work: string, collection: string) => `${collection}\0${work}`;

/** One bounded VALUES batch per page; native matching may scan the selected
 * generation/Realm slots O(N), with at most P returned rows and O(P) hydration.
 * Missing membership is false; malformed/oversized graph results fail the read.
 * Editorial results use Collection/Work keys so a different list cannot confer membership. */
export async function readZonePopulation(query: (sparql: string, rows: number) => Promise<ReadRow[]>,
  population: ZonePopulation, resources: readonly string[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(resources)];
  const pairs = 'editorial' in population ? [...new Map(population.editorial.members.map(member =>
    [editorialPopulationKey(member.work, member.collection), member])).values()] : null;
  if (ids.length > ZONE_POPULATION_COST.resources
    || 'editorial' in population && population.editorial.members.length > ZONE_POPULATION_COST.editorialMembers) {
    throw new WorkReadUnavailable('Zone population batch exceeds its bound');
  }
  if (!ids.length) return new Set();
  const relation = 'collection' in population
    ? collectionPopulation(iri(population.collection.structure), iri(population.collection.head),
      iri(population.collection.generation), '?work')
    : realmPopulation(population.realm, '?work');
  const editorial = 'editorial' in population && population.editorial.members.length
    ? `UNION {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(population.editorial.zone)} a rv:Zone ; rv:zoneState rv:Active ;
          rv:disclosure rv:Public ; rv:navigation ?navigation .
        ?navigation a rv:Structure ; rv:structureProfile rv:ZoneNavigation ;
          rv:structureOf ${iri(population.editorial.zone)} ; rv:selectedGeneration ?navigationGeneration .
        ?navigationGeneration rv:generationState rv:Active .
        ?mount a rv:OccurrencePlacement ; rv:generation ?navigationGeneration ;
          rv:occurrenceRole rv:MountRole ; schema:item ?collection ; rv:qualifier ?qualifier .
        ?qualifier a rv:ZoneMount ; rv:zone ${iri(population.editorial.zone)} ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?mount rv:removedBy ?mountRemoval }
        ?collection a rv:Collection ; rv:collectionState rv:Active ; rv:disclosure rv:Public ;
          rv:structure ?structure .
        ?structure a rv:Structure ; rv:structureProfile rv:CollectionMembership ;
          rv:structureOf ?collection ; rv:structureHead ?head ; rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active .
      }
      ${collectionPopulation('?structure', '?head', '?generation', '?work')}
    }` : '';
  const keys = pairs ? pairs.map(member => editorialPopulationKey(member.work, member.collection)) : ids;
  const rowKey = (row: ReadRow) => pairs && row.collection
    ? editorialPopulationKey(row.work!.value, row.collection.value) : row.work!.value;
  const rows = await query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    # Zone population batch
    SELECT DISTINCT ?work ${pairs ? '?collection' : ''} WHERE {
      ${pairs ? `VALUES (?work ?collection) { ${pairs.map(member =>
        `(${iri(member.work)} ${iri(member.collection)})`).join(' ')} }`
    : `VALUES ?work { ${ids.map(iri).join(' ')} }`}
      { ${relation} } ${editorial}
    } LIMIT ${keys.length + 1}`, keys.length);
  if (rows.length > keys.length || rows.some(row => !row.work || pairs && !row.collection
    || !keys.includes(rowKey(row))) || new Set(rows.map(rowKey)).size !== rows.length) {
    throw new WorkReadUnavailable('Zone population batch is ambiguous');
  }
  return new Set(rows.map(rowKey));
}
