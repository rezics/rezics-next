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
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { resolveConcepts } from '../concept-page/read.ts';
import { QUERY_COST } from './compile.ts';
import { conceptCountBasis } from '../discovery/concepts.ts';
import {
  indexedLabels,
  indexedNameMatch,
  labelIndexReady,
  fenceLabelIndex,
  publicNamePage,
  type LabelAfter,
  type DirectoryAfter,
} from '../search/labels.ts';
import type { ResourceCard, ResourceCondition, ResourceListPlan } from './resource-contract.ts';
import { pageDiscoveryPolicy } from '../space/visibility.ts';
import type { DiscoveryReadGeneration } from '../discovery/store.ts';

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
      }
      BIND("realm" AS ?kind) BIND(?r AS ?summary) BIND(?space AS ?nameResource) }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?r a rv:Zone ; rv:zoneState rv:Active ; rv:zoneHead ?zoneHead ; rv:disclosure rv:Public ; rv:space ?space .
      ?space a rv:Space ; rv:zoneCapability ?r ; rv:realmCapability ?summary ; rv:disclosure rv:Public .
      ?summary a rv:Realm ; rv:realmState rv:Active .
      }
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
          FILTER NOT EXISTS { ?conceptSpace rv:listing ?listing . FILTER(?listing != "listed") } } } }
      BIND("concept" AS ?kind) BIND(?r AS ?summary) BIND(?r AS ?nameResource) } }
    FILTER(STRSTARTS(STR(?r), "https://rezics.com/id/"))
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:protectionHead ?protection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:mergedInto ?merged } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?nameResource rv:protectionHead ?nameProtection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?summary rv:protectionHead ?summaryProtection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?nameResource rv:disclosure ?disclosure .
      FILTER(?disclosure != rv:Public) } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure ?disclosure . FILTER(?disclosure != rv:Public) } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?summary rv:disclosure ?disclosure . FILTER(?disclosure != rv:Public) } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:profileDisclosure rv:Private } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      { ?nameResource rv:listing ?listing } UNION { ?r rv:listing ?listing } UNION { ?summary rv:listing ?listing }
      FILTER(?listing != "listed") } }
    BIND(IRI(CONCAT("urn:rezics:search:name:visibility:", STRAFTER(STR(?r), "https://rezics.com/id/"))) AS ?nameMarker)
    FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?nameMarker rv:nameVisibility "private" } }
    FILTER NOT EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?nameMarker rv:nameListing "unlisted" } }`;
}

export function resourceConditions(conditions: readonly ResourceCondition[], realm?: string) {
  return conditions
    .filter((condition) => condition.facet !== 'concept')
    .map((condition) => {
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
        return `GRAPH ${iri(GRAPHS.current)} { ?r rv:topic ${iri(value)} }`;
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
const compareBrowse = (a: Pick<Candidate, 'id' | 'order'>, b: Pick<Candidate, 'id' | 'order'>) =>
  BigInt(a.order) > BigInt(b.order)
    ? -1
    : BigInt(a.order) < BigInt(b.order)
      ? 1
      : a.id.localeCompare(b.id);
/** A descending merge can emit only the prefix reached by every unfinished
 * source. Otherwise a filtered window can expose a low row before an unseen
 * higher row in another kind. Identity breaks ties at the same frontier. */
export function knownBrowsePrefix<T extends Pick<Candidate, 'id' | 'order'>>(
  candidates: T[],
  unfinishedTails: readonly Pick<Candidate, 'id' | 'order'>[],
) {
  const frontier = [...unfinishedTails].sort(compareBrowse)[0];
  return candidates
    .sort(compareBrowse)
    .filter((row) => !frontier || compareBrowse(row, frontier) <= 0);
}
/** Realm directory uses an ascending signed seek key. Browse uses the positive
 * owner order shared with native name directories and Discovery Works. */
export const realmBrowseOrder = (rank: string) => (rank.startsWith('-') ? rank.slice(1) : rank);
interface PageCursor {
  after?: LabelAfter;
  seen: number;
  seeks?: Record<string, { id: string; key: string }>;
  done?: string[];
}
/** Hydrate through the shared summary/Agent owners, then recheck disclosure at delivery. */
export async function resourceCards(session: WorkReadSession, candidates: readonly Candidate[]) {
  const agents = candidates.filter((row) => row.kind === 'agent').map((row) => row.id);
  if (agents.length && (!session.deps.personPreferences || !session.deps.profiles)) {
    throw new WorkReadUnavailable('Agent profile owner is unavailable');
  }
  const visibleAgents = async () => {
    const listings = new Map<string, string>();
    for (let offset = 0; offset < agents.length; offset += 50)
      for (const [agent, listing] of await session.deps.profiles!.listing.readBatch(
        agents.slice(offset, offset + 50),
      ))
        listings.set(agent, listing);
    return new Set(
      (
        await Promise.all(
          agents.map(async (agent) =>
            pageDiscoveryPolicy('public', listings.get(agent) === 'listed' ? 'listed' : 'unlisted')
              .indexable && (await session.deps.personPreferences!.profileVisible(agent, null))
              ? agent
              : null,
          ),
        )
      ).filter((value) => value !== null),
    );
  };
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
  if (
    summaries &&
    summaries.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`
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
            },
          ]
        : [];
    }
    const summary = byId.get(row.summary);
    if (summary?.status !== 'available' || summary.disclosure !== 'public') return [];
    return [
      {
        id: row.id,
        kind: row.kind,
        types: resourceTypes,
        name: summary.name,
        icon: summary.avatar,
      },
    ];
  });
}

/** Match accepted Concept interpretations through the existing Discovery owner. */
export async function conceptResourceMatches(
  session: WorkReadSession,
  candidates: readonly Candidate[],
  conditions: readonly ResourceCondition[],
  realm?: string,
  pinned?: DiscoveryReadGeneration,
) {
  const filters = conditions.filter((condition) => condition.facet === 'concept');
  if (!filters.length) return new Set(candidates.map((row) => row.id));
  const resolved = await resolveConcepts(session, [
    ...new Set(filters.flatMap((row) => row.values)),
  ]);
  const active = pinned ?? (await conceptCountBasis(session, realm)).active;
  const works = candidates.filter((row) => row.kind === 'work').map((row) => row.id);
  const terms = [...new Set([...resolved.values()].flatMap((row) => row.interpretations))];
  const membership = await session.deps.discovery!.termMembership(active, works, terms);
  const topics = candidates.length
    ? await session.query(
        `SELECT ?r ?concept WHERE {
    VALUES ?r { ${candidates.map((row) => iri(row.id)).join(' ')} }
    VALUES ?concept { ${[...resolved.keys()].map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?r rv:topic ?concept }
  } LIMIT ${candidates.length * Math.max(1, resolved.size) + 1}`,
        candidates.length * Math.max(1, resolved.size),
      )
    : [];
  const matched = new Set(
    candidates
      .filter((candidate) =>
        filters.every((condition) => {
          const flags = condition.values.map((concept) =>
            candidate.kind === 'work'
              ? membership.some(
                  (row) =>
                    row.work === candidate.id &&
                    resolved.get(concept)?.interpretations.includes(row.term),
                )
              : topics.some(
                  (row) => row.r!.value === candidate.id && row.concept!.value === concept,
                ),
          );
          return condition.operator === 'all'
            ? flags.every(Boolean)
            : condition.operator === 'none'
              ? !flags.some(Boolean)
              : flags.some(Boolean);
        }),
      )
      .map((row) => row.id),
  );
  return matched;
}

export async function readResourceList(session: WorkReadSession, plan: ResourceListPlan) {
  const { input, conditions } = plan;
  const limit = input.limit ?? 20,
    q = input.q?.trim() ?? '';
  const realm = input.scope.kind === 'realm' ? input.scope.realm : undefined;
  if (realm && (await session.realm(realm)).visibility !== 'public')
    throw new WorkReadInvalid('Scope is not public');
  const binding = [
    'resource-list-v2',
    conditions,
    realm ?? null,
    q,
    input.sort,
    limit,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: PageCursor = { seen: 0, seeks: {}, done: [] };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.order);
    } catch {
      throw new WorkReadInvalid('Resource cursor is invalid');
    }
    if (!Number.isSafeInteger(prior.seen) || prior.seen < 0)
      throw new WorkReadInvalid('Resource cursor is invalid');
  }
  const state = { ...prior, seeks: { ...prior.seeks }, done: [...(prior.done ?? [])] };
  const items: ResourceCard[] = [];
  let scanned = 0,
    more = false;
  const population = `${publicResources()} ${resourceConditions(conditions, realm)}
    ${
      realm
        ? `FILTER(?r=${iri(realm)} || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:conceptRealm ${iri(realm)} } }
      || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ?r ; rv:selectionHead ?h } })`
        : ''
    }`;
  let kinds: Candidate['kind'][] = [
    'work',
    'realm',
    'concept',
    'space',
    'site',
    'agent',
    'collection',
  ];
  const ownedTypes: Record<string, Candidate['kind'][]> = {
    'https://schema.org/CreativeWork': ['work'],
    'http://www.w3.org/2004/02/skos/core#Concept': ['concept'],
    'https://rezics.com/vocab/Realm': ['realm'],
    'https://rezics.com/vocab/Zone': ['site'],
    'https://rezics.com/vocab/Space': ['space', 'realm', 'site'],
    'https://rezics.com/vocab/Agent': ['agent'],
    'https://rezics.com/vocab/Collection': ['collection'],
  };
  for (const condition of conditions.filter(
    (row) => row.facet === 'type' && row.operator === 'any',
  )) {
    if (condition.values.every((type) => ownedTypes[type]))
      kinds = kinds.filter((kind) =>
        condition.values.some((type) => ownedTypes[type]!.includes(kind)),
      );
  }
  const { basis, active } = await conceptCountBasis(session, realm);
  const index = q ? await labelIndexReady(session) : null;
  let cache: (Candidate & { source: string; key: string })[] = [];
  const tails = new Map<string, Candidate>();
  let fetched = 0;
  while (items.length < limit && scanned < QUERY_COST.candidateRows) {
    let candidates: (Candidate & { source: string; key: string })[] = [];
    if (q && input.sort === 'relevance') {
      const page = await indexedLabels(
        session,
        q,
        Math.min(64, QUERY_COST.candidateRows - scanned),
        state.after,
      );
      const rows = page.ids.length
        ? await session.query(
            `SELECT DISTINCT ?r ?kind ?summary WHERE {
        VALUES ?r { ${page.ids.map(iri).join(' ')} } ${population}
      } LIMIT ${page.ids.length + 1}`,
            page.ids.length,
          )
        : [];
      candidates = page.hits.map((hit) => {
        const id = 'https://rezics.com/id/' + hit.id.split(':').at(-1);
        const row = hit.key ? rows.find((row) => row.r!.value === id) : null;
        return {
          id,
          kind: row?.kind?.value as Candidate['kind'],
          summary: row?.summary?.value ?? '',
          order: '',
          source: 'rank',
          key: JSON.stringify({
            id: hit.id,
            score: hit.score,
            commit: page.commit,
            document: hit.document,
          }),
        };
      });
      more = page.more;
    } else if (cache.length) {
      candidates = cache;
      cache = [];
      more = true;
    } else {
      // Refill the frontier's kind first when only one bounded seek remains.
      for (const kind of kinds
        .filter((kind) => !state.done.includes(kind))
        .sort((a, b) =>
          tails.has(a) && tails.has(b)
            ? compareBrowse(tails.get(a)!, tails.get(b)!)
            : tails.has(a)
              ? -1
              : tails.has(b)
                ? 1
                : 0,
        )) {
        if (fetched >= QUERY_COST.candidateRows) break;
        const sourceLimit = Math.min(64, QUERY_COST.candidateRows - fetched);
        const seek = state.seeks[kind];
        const start = candidates.length;
        let complete = false;
        if (kind === 'work') {
          const rows = await session.deps.discovery!.resourcePage(
            active,
            sourceLimit,
            seek ? { key: seek.key, work: seek.id } : undefined,
          );
          const window = rows.slice(0, sourceLimit);
          complete = rows.length <= sourceLimit;
          candidates.push(
            ...window.map((row) => ({
              id: row.work,
              kind,
              summary: row.work,
              order: String(
                (32n - BigInt(row.order_key) / (1n << 63n)) * 10n ** 30n +
                  ((1n << 63n) - 1n - (BigInt(row.order_key) % (1n << 63n))),
              ),
              source: kind,
              key: row.order_key,
            })),
          );
          if (!window.length) state.done.push(kind);
        } else if (kind === 'concept') {
          // The Concept owner orders used definitions from immutable term
          // counts. Its zero-use tail seeks public definition names by identity.
          let position: { phase: 'used' | 'unused'; count?: string; after?: DirectoryAfter } = {
            phase: 'used',
          };
          if (seek) {
            try {
              position = JSON.parse(seek.key);
            } catch {
              throw new WorkReadInvalid('Concept resource cursor is invalid');
            }
            if (!['used', 'unused'].includes(position.phase))
              throw new WorkReadInvalid('Concept resource cursor is invalid');
          }
          const used =
            position.phase === 'used'
              ? await session.deps.discovery!.conceptPage(
                  active,
                  sourceLimit,
                  seek ? { count: position.count ?? '0', concept: seek.id } : undefined,
                )
              : [];
          if (used.length) {
            candidates.push(
              ...used.slice(0, sourceLimit).map((row) => ({
                id: row.concept,
                kind,
                summary: row.concept,
                order: String(32n * 10n ** 30n + BigInt(row.work_count)),
                source: kind,
                key: JSON.stringify({ phase: 'used', count: row.work_count }),
              })),
            );
          } else {
            const page = await publicNamePage(
              session,
              kind,
              'identity',
              sourceLimit,
              position.after,
            );
            complete = !page.more;
            candidates.push(
              ...page.rows.map((row) => ({
                id: row.id,
                kind,
                summary: row.available ? row.id : '',
                order: String(32n * 10n ** 30n),
                source: kind,
                key: JSON.stringify({ phase: 'unused', after: row.after }),
              })),
            );
            if (!page.rows.length) state.done.push(kind);
          }
        } else if (kind === 'realm') {
          const directory = session.deps.access.realmDirectory;
          if (!directory) throw new WorkReadUnavailable('Realm directory is unavailable');
          const page = await directory.page(session, {
            sort: input.sort === 'updated' ? 'activity' : 'newest',
            q: '',
            limit: sourceLimit,
            cursor: '',
            seek,
          });
          complete = !page.next;
          candidates.push(
            ...page.rows.map((row) => ({
              id: row.realm,
              kind,
              summary: row.realm,
              order: realmBrowseOrder(row.rank),
              source: kind,
              key: `${page.position}:${row.rank}`,
            })),
          );
          if (!page.rows.length) state.done.push(kind);
        } else {
          const page = await publicNamePage(
            session,
            kind,
            input.sort === 'updated' ? 'updated' : 'newest',
            sourceLimit,
            seek ? (JSON.parse(seek.key) as DirectoryAfter) : undefined,
          );
          complete = !page.more;
          candidates.push(
            ...page.rows.map((row) => ({
              id: row.id,
              kind,
              summary: row.available ? row.id : '',
              order: row.order,
              source: kind,
              key: JSON.stringify(row.after),
            })),
          );
          if (!page.rows.length) state.done.push(kind);
        }
        const last = candidates.length > start ? candidates.at(-1)! : undefined;
        if (last && !complete) tails.set(kind, last);
        else tails.delete(kind);
        fetched += sourceLimit;
      }
      candidates = knownBrowsePrefix(
        candidates,
        [...tails].filter(([kind]) => !state.done.includes(kind)).map(([, tail]) => tail),
      );
      more = state.done.length < kinds.length;
    }
    if (!candidates.length) {
      break;
    }
    const window = candidates.slice(0, Math.min(64, QUERY_COST.candidateRows - scanned));
    if (!(q && input.sort === 'relevance')) cache = candidates.slice(window.length);
    const rows = window.length
      ? await session.query(
          `SELECT DISTINCT ?r ?kind ?summary WHERE {
      VALUES ?r { ${window
        .filter((row) => row.summary)
        .map((row) => iri(row.id))
        .join(' ')} } ${population}
      ${q ? indexedNameMatch('?r', q) : ''}
    } LIMIT ${window.length + 1}`,
          window.length,
        )
      : [];
    const admitted = window.flatMap((candidate) => {
      const row = rows.find((row) => row.r!.value === candidate.id);
      return candidate.summary && row
        ? [
            {
              ...candidate,
              kind: row.kind!.value as Candidate['kind'],
              summary: row.summary!.value,
            },
          ]
        : [];
    });
    const projectedWorks = await session.deps.discovery!.resourceMembership(
      active,
      admitted.filter((row) => row.kind === 'work').map((row) => row.id),
    );
    let projected = admitted.filter((row) => row.kind !== 'work' || projectedWorks.has(row.id));
    const concepts = projected.filter((row) => row.kind === 'concept');
    if (concepts.length) {
      const counts = new Map(
        (
          await session.deps.discovery!.conceptCounts(
            active,
            concepts.map((row) => row.id),
          )
        ).map((row) => [row.concept, Number(row.work_count)]),
      );
      projected = projected.filter(
        (row) =>
          row.kind !== 'concept' ||
          row.source !== 'concept' ||
          JSON.parse(row.key).phase !== 'unused' ||
          (counts.get(row.id) ?? 0) === 0,
      );
    }
    const matched = await conceptResourceMatches(session, projected, conditions, realm, active);
    const cards = new Map(
      (
        await resourceCards(
          session,
          projected.filter((row) => matched.has(row.id)),
        )
      ).map((card) => [card.id, card]),
    );
    let examined = 0;
    for (const candidate of window) {
      if (items.length === limit) break;
      scanned++;
      examined++;
      if (candidate.source === 'rank') state.after = JSON.parse(candidate.key);
      else state.seeks[candidate.source] = { id: candidate.id, key: candidate.key };
      const card = cards.get(candidate.id);
      if (card && candidate.summary) items.push(card);
    }
    more ||= examined < window.length || window.length < candidates.length;
    if (!more || (!cache.length && fetched >= QUERY_COST.candidateRows)) break;
  }
  const final = await session.deps.discovery!.active(basis, session.position, active.generation_id);
  if (index) await fenceLabelIndex(session, index);
  state.seen += items.length;
  const next = more
    ? encodeReadCursor(binding, session.position, items.at(-1)?.id ?? '', JSON.stringify(state))
    : null;
  return {
    profile: 'resource-list-v1' as const,
    sourcePosition: session.position,
    stale: active.stale || final.stale,
    ...listResult(items, next, prior.seen),
  };
}
