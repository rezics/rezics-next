import { GRAPHS, iri, lit } from '../work/activate.ts';
import { searchableStructureProfiles } from './profiles.ts';
import { roleIri } from './graph.ts';

export interface SearchPlacement {
  resource: string; work: string; occurrence: string; profile: string; title: string;
  /** Omitted when equal to the enclosing hit revision. */
  revision?: string;
}

/** Keep every active occurrence. A fixed use only matches its exact selected revision.
 * A full-Content index cannot prove that a phrase lies inside a selector. */
export function searchablePlacement(resource: string, work: string, main: string, revision: string,
  occurrence = '?searchOccurrence', profile = '?searchProfile') {
  const registrations = searchableStructureProfiles();
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
