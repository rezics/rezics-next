import { listResult } from '../../api-list.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import {
  publicWork,
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { readAgentCards, publicAgent } from '../profiles/read.ts';
import { direction } from '../display-language/select.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import {
  indexedLabels,
  indexedNameMatch,
  labelIndexReady,
  fenceLabelIndex,
  type LabelAfter,
} from '../search/labels.ts';
import type { ResourceCard, ResourceCondition, ResourceListPlan } from './resource-contract.ts';
import type { ClassificationAudience } from '../discovery/audience.ts';
import { acceptedClassification, countDisclosure } from './classification.ts';

/** Ownership establishes the read path; descriptive rdf:type only filters it.
 * Public catalogue reads never use private grants, including a reader's own. */
export function publicResources() {
  return `{ { ${publicWork('?r', '?main')} BIND("work" AS ?kind) BIND(?r AS ?summary) BIND(?r AS ?nameResource) }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:Space ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?r rv:realmCapability ?realm }
      FILTER NOT EXISTS { ?r rv:zoneCapability ?zone } }
      BIND("space" AS ?kind) BIND(?r AS ?summary) BIND(?r AS ?nameResource) }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?r ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?r rv:visibility ?visibility . FILTER(?visibility != "public") } }
      BIND("realm" AS ?kind) BIND(?r AS ?summary) BIND(?space AS ?nameResource) }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:Zone ; rv:zoneState rv:Active ; rv:zoneHead ?zoneHead ; rv:disclosure rv:Public ; rv:space ?space .
      ?space a rv:Space ; rv:zoneCapability ?r ; rv:realmCapability ?summary ; rv:disclosure rv:Public .
      ?summary a rv:Realm ; rv:realmState rv:Active .
      FILTER NOT EXISTS { ?summary rv:visibility ?visibility . FILTER(?visibility != "public") } }
      GRAPH ${iri(GRAPHS.revisions)} { ?zoneHead a rv:ZoneRevision, rv:RevisionAnchor ; rv:component ?r .
        FILTER NOT EXISTS { ?zoneHead a rv:ErasedRevision } }
      BIND("site" AS ?kind) BIND(?space AS ?nameResource) }
    UNION { ${publicAgent('?r')} BIND("agent" AS ?kind) BIND(?r AS ?summary) BIND(?r AS ?nameResource) }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:Collection ; rv:collectionState rv:Active ; rv:collectionHead ?collectionHead ; rv:disclosure rv:Public }
      GRAPH ${iri(GRAPHS.revisions)} { ?collectionHead a rv:CollectionRevision, rv:RevisionAnchor ; rv:component ?r .
        FILTER NOT EXISTS { ?collectionHead a rv:ErasedRevision } }
      BIND("collection" AS ?kind) BIND(?r AS ?summary) BIND(?r AS ?nameResource) }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a skos:Concept ; rv:conceptState rv:Active .
      FILTER NOT EXISTS { ?r rv:conceptState rv:Retired }
      FILTER NOT EXISTS { ?r skos:inScheme ?scheme . ?scheme rv:schemeState rv:Retired }
      FILTER NOT EXISTS { ?r rv:conceptRealm ?conceptRealm .
        FILTER NOT EXISTS { ?conceptRealm a rv:Realm ; rv:realmState rv:Active ; rv:space ?conceptSpace .
          ?conceptSpace rv:realmCapability ?conceptRealm ; rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?conceptRealm rv:visibility ?visibility . FILTER(?visibility != "public") } } } }
      BIND("concept" AS ?kind) BIND(?r AS ?summary) BIND(?r AS ?nameResource) } }
    FILTER(STRSTARTS(STR(?r), "https://rezics.com/id/"))
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:protectionHead ?protection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:mergedInto ?merged } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?nameResource rv:protectionHead ?nameProtection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?summary rv:protectionHead ?summaryProtection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?nameResource rv:disclosure ?disclosure .
      FILTER(?disclosure != rv:Public) } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure ?disclosure . FILTER(?disclosure != rv:Public) } }`;
}

export function resourceConditions(
  conditions: readonly ResourceCondition[],
  realm?: string,
  audience: ClassificationAudience = { excluded: [], protection: [] },
) {
  return conditions
    .map((condition, index) => {
      const match = (value: string) => {
        if (condition.facet === 'type') {
          // Facet admission already checked the registry value; this term may be
          // an ontology class rather than a native resource identity.
          if (!/^https?:\/\/[A-Za-z0-9./_#-]+$/u.test(value))
            throw new WorkReadInvalid('Invalid type');
          return `GRAPH ${iri(GRAPHS.current)} { { ?r a <${value}> }
          UNION { ?r rv:space ?typedSpace . ?typedSpace a <${value}> } }`;
        }
        if (condition.facet === 'language')
          return `GRAPH ${iri(GRAPHS.current)} {
        ?nameResource ?nameProperty ?languageLabel . VALUES ?nameProperty { rdfs:label schema:name skos:prefLabel skos:altLabel }
        FILTER(LANGMATCHES(LANG(?languageLabel), ${lit(value)})) }`;
        // Both communities' explicit topics and accepted resource classifications
        // use Concepts; a Concept is never inferred from a label or rdf:type.
        return `{ GRAPH ${iri(GRAPHS.current)} { ?r rv:topic ${iri(value)} } }
        UNION { GRAPH ${iri(GRAPHS.current)} { ?r rv:mainVersion ?classifiedMain }
          ${acceptedClassification('?classifiedMain', iri(value), audience, realm, `filter${index}`)}
          ${countDisclosure('?r', audience, `filterCount${index}`)} }`;
      };
      const tests = condition.values.map((value) => `EXISTS { ${match(value)} }`);
      return `FILTER(${condition.operator === 'none' ? '!' : ''}(${tests.join(condition.operator === 'all' ? ' && ' : ' || ')}))`;
    })
    .join('\n');
}

interface Candidate {
  id: string;
  summary: string;
  kind: ResourceCard['kind'];
  order: string;
}
interface PageCursor {
  after?: LabelAfter;
  order?: string;
  seen: number;
  pending?: Candidate[];
  labelMore?: boolean;
}

/** Hydrate through the shared summary/Agent owners, then recheck disclosure at delivery. */
export async function resourceCards(session: WorkReadSession, candidates: readonly Candidate[]) {
  const agents = candidates.filter((row) => row.kind === 'agent').map((row) => row.id);
  if (agents.length && (!session.deps.personPreferences || !session.deps.profiles)) {
    throw new WorkReadUnavailable('Agent profile owner is unavailable');
  }
  const visibleAgents = async () =>
    new Set(
      (
        await Promise.all(
          agents.map(async (agent) =>
            (await session.deps.personPreferences!.profileVisible(agent, null)) ? agent : null,
          ),
        )
      ).filter((value) => value !== null),
    );
  const before = await visibleAgents();
  const cards = await readAgentCards(
    session,
    agents.filter((id) => before.has(id)),
  );
  const refs = [
    ...new Set(candidates.filter((row) => row.kind !== 'agent').map((row) => row.summary)),
  ];
  const readSummaries = () =>
    readResourceSummaries(
      session.deps.environment,
      session.deps.media?.store,
      { viewer: session.viewer },
      {
        resources: refs,
        context: DEFAULT_MEDIA_CONTEXT,
        language: null,
        languages: session.displayLanguages,
        includeCollections: true,
        channel: 'search',
      },
    );
  const summaries = refs.length ? await readSummaries() : null;
  const fenced = refs.length ? await readSummaries() : null;
  if (
    summaries &&
    (summaries.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}` ||
      fenced?.generation.graph !== summaries.generation.graph)
  )
    throw new WorkReadMoved('Resources changed');
  const currentAgents = await visibleAgents();
  const decisions = await session.disclosure(
    candidates.map((row) => ({
      owner: 'graph' as const,
      resource: row.id,
      component: 'name' as const,
    })),
    'search',
  );
  const byId = new Map((summaries?.summaries ?? []).map((summary) => [summary.reference, summary]));
  const final = new Map((fenced?.summaries ?? []).map((summary) => [summary.reference, summary]));
  const types = candidates.length
    ? await session.query(
        `SELECT DISTINCT ?r ?type WHERE {
    VALUES ?r { ${candidates.map((row) => iri(row.id)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { { ?r a ?type } UNION { ?r rv:space ?typedSpace . ?typedSpace a ?type } }
    } LIMIT ${candidates.length * 64 + 1}`,
        candidates.length * 64,
      )
    : [];
  return candidates.flatMap((row, index): ResourceCard[] => {
    if (decisions[index] !== 'visible') return [];
    const resourceTypes = [
      ...new Set(types.filter((type) => type.r?.value === row.id).map((type) => type.type!.value)),
    ];
    if (resourceTypes.length > 64) throw new WorkReadUnavailable('Resource has too many types');
    if (row.kind === 'agent') {
      const agent = currentAgents.has(row.id) ? cards.get(row.id) : null;
      return agent
        ? [
            {
              id: row.id,
              kind: row.kind,
              types: resourceTypes,
              name: agent.displayNameInfo ?? {
                value: agent.displayName,
                language: 'und',
                direction: direction('und', agent.displayName),
                basis: 'fallback',
              },
              icon: {
                kind: 'fallback',
                policy: 'avatar-fallback-v1',
                key: row.id,
                resourceType: 'agent',
              },
              href: agent.links.profile,
            },
          ]
        : [];
    }
    const summary = byId.get(row.summary),
      end = final.get(row.summary);
    if (
      summary?.status !== 'available' ||
      summary.disclosure !== 'public' ||
      end?.status !== 'available' ||
      end.disclosure !== 'public'
    )
      return [];
    return [
      {
        id: row.id,
        kind: row.kind,
        types: resourceTypes,
        name: summary.name,
        icon: summary.avatar,
        href:
          row.kind === 'work'
            ? `/w/${row.id.slice(-36)}`
            : row.kind === 'realm'
              ? `/r/${row.id.slice(-36)}`
              : row.kind === 'site'
                ? `/v1/zones/${row.id.slice(-36)}/presentation`
                : row.kind === 'concept'
                  ? `/concepts/${row.id.slice(-36)}`
                  : `/v1/${row.kind === 'collection' ? 'collections' : 'spaces'}/${row.id.slice(-36)}`,
      },
    ];
  });
}

export async function readResourceList(session: WorkReadSession, plan: ResourceListPlan) {
  const { input, conditions } = plan;
  const limit = input.limit ?? 20,
    q = input.q?.trim() ?? '';
  const index = q ? await labelIndexReady(session) : null;
  const realm = input.scope.kind === 'realm' ? input.scope.realm : undefined;
  if (realm && (await session.realm(realm)).visibility !== 'public')
    throw new WorkReadInvalid('Scope is not public');
  const audience = conditions.some((condition) => condition.facet === 'concept')
    ? await session.deps.discoveryAudience?.classificationAudience(session.viewer, realm)
    : undefined;
  if (conditions.some((condition) => condition.facet === 'concept') && !audience)
    throw new WorkReadUnavailable('Classification audience is unavailable');
  const binding = [
    'resource-list-v1',
    conditions,
    audience ?? null,
    realm ?? null,
    q,
    input.sort,
    limit,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: PageCursor = { seen: 0 };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.order);
    } catch {
      throw new WorkReadInvalid('Resource cursor is invalid');
    }
    if (!Number.isSafeInteger(prior.seen) || prior.seen < 0)
      throw new WorkReadInvalid('Resource cursor is invalid');
  }
  const population = `${publicResources()} ${resourceConditions(conditions, realm, audience)}
    ${
      realm
        ? `FILTER(?r = ${iri(realm)} || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:conceptRealm ${iri(realm)} } }
      || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?adoption a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
        rv:work ?r ; rv:selectionHead ?selectionHead } GRAPH ${iri(GRAPHS.revisions)} {
        ?selectionHead a rv:RevisionAnchor ; rv:component ?adoption .
        FILTER NOT EXISTS { ?selectionHead a rv:ErasedRevision } } })`
        : ''
    }`;
  let candidates: Candidate[], more: boolean, after: string, state: PageCursor;
  if (q && input.sort === 'relevance') {
    if (prior.pending?.length) {
      candidates = prior.pending;
      more = prior.labelMore ?? false;
      after = prior.after?.id ?? '';
      state = { after: prior.after, seen: prior.seen, labelMore: more };
    } else {
      // A Space label can yield two capabilities. For limit=1 the encrypted
      // cursor carries the second binding, so neither capability is lost.
      const labels = await indexedLabels(
        session,
        q,
        Math.max(1, Math.floor(limit / 2)),
        prior.after,
      );
      const rows = labels.ids.length
        ? await session.query(
            `SELECT DISTINCT ?r ?kind ?summary ?nameResource WHERE {
      VALUES ?nameResource { ${labels.ids.map(iri).join(' ')} } ${population}
    } ORDER BY STR(?r) LIMIT ${limit * 3 + 1}`,
            limit * 3,
          )
        : [];
      candidates = labels.ids.flatMap((id) =>
        rows
          .filter((row) => row.nameResource?.value === id)
          .map((row) => ({
            id: row.r!.value,
            summary: row.summary!.value,
            kind: row.kind!.value as Candidate['kind'],
            order: '',
          })),
      );
      if (candidates.length > Math.max(2, limit))
        throw new WorkReadUnavailable('Label bindings exceed their domain');
      const pending = candidates.slice(limit);
      candidates = candidates.slice(0, limit);
      more = labels.more || pending.length > 0;
      after = labels.after?.id ?? '';
      state = { after: labels.after, seen: prior.seen, pending, labelMore: labels.more };
    }
  } else {
    const lineage = await readEpochOrder(session);
    const rows = await session.query(
      `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?r ?kind ?summary ?order WHERE {
      { SELECT ?r ?kind ?summary (${input.sort === 'newest' ? 'MIN' : 'MAX'}(?fallbackRank) AS ?order) WHERE {
        ${population} ${q ? indexedNameMatch('?nameResource', q) : ''}
        OPTIONAL { ${lineage} GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ;
          rv:component ?r ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence }
          BIND((32 - ?epochOrder) * 1000000000000000000000000000000 + xsd:integer(?sequence) AS ?rank) }
        BIND(COALESCE(?rank, 0) AS ?fallbackRank)
      } GROUP BY ?r ?kind ?summary }
      ${
        cursor
          ? `FILTER(?order < ${lit(prior.order ?? '0')}^^xsd:integer ||
        (?order = ${lit(prior.order ?? '0')}^^xsd:integer && STR(?r) > ${lit(cursor.after)}))`
          : ''
      }
      } ORDER BY DESC(?order) STR(?r) LIMIT ${limit + 1}`,
      limit + 1,
    );
    candidates = rows.slice(0, limit).map((row) => ({
      id: row.r!.value,
      kind: row.kind!.value as Candidate['kind'],
      summary: row.summary!.value,
      order: row.order?.value ?? '0',
    }));
    more = rows.length > limit;
    after = candidates.at(-1)?.id ?? '';
    state = { order: candidates.at(-1)?.order ?? '0', seen: prior.seen };
  }
  if (new Set(candidates.map((row) => row.id)).size !== candidates.length)
    throw new WorkReadUnavailable('Resource population is ambiguous');
  const items = await resourceCards(session, candidates);
  if (
    audience &&
    JSON.stringify(
      await session.deps.discoveryAudience!.classificationAudience(session.viewer, realm),
    ) !== JSON.stringify(audience)
  ) {
    throw new WorkReadMoved('Classification audience changed');
  }
  if (index) await fenceLabelIndex(session, index);
  state.seen += items.length;
  const next = more
    ? encodeReadCursor(binding, session.position, after, JSON.stringify(state))
    : null;
  return {
    profile: 'resource-list-v1' as const,
    sourcePosition: session.position,
    ...listResult(items, next, prior.seen),
  };
}
