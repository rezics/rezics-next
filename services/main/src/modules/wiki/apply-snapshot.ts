import { canonicalCandidate, EditorialBlocked, EditorialInvalid, headsEqual, type BaseHead,
  type EditorialTarget, type Json } from '../editorial-review/contract.ts';
import type { EditorialRuntime } from '../editorial-review/runtime.ts';
import { readCurrentComponent, type ComponentInput } from '../semantic/change.ts';
import { readExactDefinition, type ExactDefinition } from '../relation/change.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { readZonePublication } from '../zone/publication.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { wikiRead } from './read.ts';
import { checkWikiExtraction, validateWikiExtraction } from './validate.ts';
import type { WikiExtraction } from './protocol.ts';
import { WikiRejected } from './errors.ts';

export interface WikiSnapshot {
  submitter: string;
  quotations?: Json;
  entities: Record<string,{ head: string; state: ComponentInput } | null>;
  collections: Record<string,{ structure: string; head: string; owner: string }>;
  predicates: Record<string,{ head: string; kind: 'property' | 'relation'; definition: ExactDefinition | null }>;
}
export function extractionCandidate(value: Json | unknown): WikiExtraction { return checkWikiExtraction(value); }
export async function wikiSnapshot(runtime: EditorialRuntime & { actingSubject: string }, target: EditorialTarget,
  raw: unknown, expected: BaseHead[]) {
  const bundle = checkWikiExtraction(raw);
  if (bundle.target !== target.resource || target.work !== target.resource) throw new EditorialInvalid('Wiki bundle names another Work');
  if (!runtime.work.wikiQuotations) throw new EditorialBlocked({ code: 'owner_unavailable' });
  const principal = await runtime.work.account.verify(runtime.request,['work:correct']);
  return wikiRead(runtime.work,principal,runtime.actingSubject,async read => {
    const preview = await validateWikiExtraction(read,runtime.work.wikiQuotations!,bundle);
    const heads = [{ component: target.resource,head: preview.target.revision }];
    if (!headsEqual(heads,expected)) throw new EditorialBlocked({ code: 'stale_base',expectedHeads: expected,actualHeads: heads });
    const snapshot: WikiSnapshot = { submitter: runtime.actingSubject,entities: {},collections: {},predicates: {},
      quotations: canonicalCandidate(preview.quotations).candidate };
    // Validation already proves the installed wiki scope. Retain its exact
    // Collection heads under the same graph-position fence, including chapters.
    const publication = await readZonePublication(runtime.work.environment,bundle.zone);
    const navigation = await readCompositionHeader(runtime.work.environment,publication.configuration.navigation);
    if (!navigation) throw new WikiRejected('wiki_unavailable',404);
    const mounts = await read.session.query(`SELECT ?segment ?collection ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?placement a rv:OccurrencePlacement ; rv:generation ${iri(navigation.generation)} ;
        rv:occurrenceRole rv:MountRole ; <https://schema.org/item> ?collection ; rv:qualifier ?q .
      ?q a rv:ZoneMount ; rv:zone ${iri(bundle.zone)} ; rv:routeSegment ?segment ; rv:disclosure rv:Public .
      FILTER(?segment IN ("characters","places","events","chapters"))
      ?collection a rv:Collection ; rv:collectionState rv:Active ; rv:structure ?structure .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
    } } LIMIT 5`,4);
    for (const mount of mounts) {
      const segment = mount.segment?.value;
      const header = mount.structure ? await readCompositionHeader(runtime.work.environment,mount.structure.value) : null;
      if (!segment || snapshot.collections[segment] || !header || header.owner !== mount.collection?.value
        || header.profile !== 'collection-membership') throw new WikiRejected('wiki_target_mismatch');
      snapshot.collections[segment] = { structure: header.structure,head: header.head,owner: header.owner };
    }
    if (!snapshot.collections.chapters) throw new WikiRejected('wiki_target_mismatch');
    for (const entity of bundle.entities) {
      if (!snapshot.collections[wikiSegment(entity.type)]) throw new WikiRejected('wiki_target_mismatch');
      const current = entity.match ? await readCurrentComponent(runtime.work.environment,entity.match,'resource') : null;
      if (entity.match && (!current || current.state.component !== 'resource')) throw new WikiRejected('wiki_match_type');
      snapshot.entities[entity.id] = current ? { head: current.head,state: current.state.component === 'resource'
        ? { ...current.state,properties: current.state.properties.map(({ predicate,value }) => ({ predicate,value })) } : current.state } : null;
    }
    for (const predicate of new Set(bundle.claims.map(claim => claim.predicate))) {
      const current = await readCurrentComponent(runtime.work.environment,predicate,'definition');
      if (!current || current.state.component !== 'definition' || !['property','relation'].includes(current.state.kind)) {
        throw new WikiRejected('wiki_predicate');
      }
      const definition = current.state.kind === 'relation' ? await readExactDefinition(runtime.work.environment,current.head) : null;
      if (current.state.kind === 'relation' && (!definition || !definition.roles.some(role => definition.roleKeys[role.role] === 'subject')
        || !definition.roles.some(role => definition.roleKeys[role.role] === 'object'))) {
        throw new WikiRejected('wiki_predicate');
      }
      snapshot.predicates[predicate] = { head: current.head,kind: current.state.kind as 'property' | 'relation',definition };
    }
    return { candidate: canonicalCandidate(bundle).candidate,before: canonicalCandidate(snapshot).candidate,baseHeads: heads };
  });
}
export function wikiSegment(type: string): 'characters' | 'places' | 'events' {
  if (type === `${RV}Character`) return 'characters';
  if (type === 'https://schema.org/Event' || type === `${RV}Event`) return 'events';
  if (type === 'https://schema.org/Place' || type === `${RV}Place`) return 'places';
  throw new WikiRejected('wiki_entity_type');
}
