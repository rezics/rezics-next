import { readVisibleOnboardingConcepts } from '../onboarding/classifications.ts';
import { readWorkClassificationBatch, WORK_CLASSIFICATION_BATCH_COST } from '../work/read-classifications.ts';
import { CLASSIFIED_AS } from '../statement/schema.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  pageResult,
  publicWork,
  WorkReadMissing,
  WorkReadUnavailable,
  type ReadRow,
  WorkReadSession,
} from '../work/read-session.ts';
import { readRealmBasis } from './read-realm.ts';
import { admittedPage } from '../disclosure/admitted-page.ts';
import { realmHistoryFilter, realmHistoryOriginFilter } from '../realm-admin/history.ts';

async function admittedDecisions(session: WorkReadSession, rows: ReadRow[], realm: string) {
  const decisions = await session.disclosure(
    rows.map((row) => ({
      owner: 'graph',
      resource: row.id!.value,
      revision: row.id!.value,
      component: 'record',
      context: realm,
      work: row.work?.value,
    })),
    'read',
  );
  const admitted = rows.filter((_, index) => decisions[index] === 'visible');
  const classified = admitted.filter(row => row.kind?.value === 'classification');
  const disclosed = new Set<string>();
  const targets = [...new Map(classified.map(row => [row.work!.value,
    { work: row.work!.value, mainVersion: row.main!.value }])).values()];
  const scoped = new WorkReadSession(session.deps, session.request,
    { ...session.options, scope: 'realm', realm, limit: WORK_CLASSIFICATION_BATCH_COST.senses },
    session.position);
  for (let start = 0; start < targets.length; start += WORK_CLASSIFICATION_BATCH_COST.works) {
    let pending = new Map<string | undefined, typeof targets>([[undefined,
      targets.slice(start, start + WORK_CLASSIFICATION_BATCH_COST.works)]]);
    while (pending.size) {
      const next = new Map<string | undefined, typeof targets>();
      for (const [after, own] of pending) {
        const batch = await readWorkClassificationBatch(scoped, own, undefined, after);
        const eligible = await readVisibleOnboardingConcepts(scoped,
          [...batch.values()].flatMap(page => page.items.map(item => item.concept)));
        for (const target of own) {
          const page = batch.get(target.work)!;
          for (const item of page.items.filter(item => eligible.has(item.concept))) disclosed.add(`${target.work}\0${item.sense}\0${item.decision}`);
          if (page.after) next.set(page.after, [...next.get(page.after) ?? [], target]);
        }
      }
      pending = next;
    }
  }
  return admitted.filter(row => row.kind?.value !== 'classification'
    || disclosed.has(`${row.work!.value}\0${row.subject!.value}\0${row.id!.value}`));
}

function decisionRelation(realm: string) {
  return `{
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:PublicationSelection, rv:RevisionAnchor ;
        rv:context ${iri(realm)} ; rv:work ?work ; rv:mainVersion ?main ;
        rv:contribution ?subject ; rv:publicationDecision ?decision ;
        rv:selectedDraft ?draft ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
        ?decision rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      ${publicWork('?work', '?main')}
      BIND("adoption" AS ?kind)
    } UNION {
      GRAPH ${iri(GRAPHS.current)} {
        ?context a rv:ClassificationContext ; rv:realm ${iri(realm)} .
        ?slot a rv:DecisionSlot ; rv:acceptanceContext ?context ; rv:decisionHead ?id .
        ?support rdf:subject ?main ; rdf:predicate <${CLASSIFIED_AS}> ;
          rv:interpretationDefinition ?definition .
        ?subject a rv:ClassificationSense ; rv:head ?definition .
        ?main rv:work ?work . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:StatementDecision, rv:RevisionAnchor ;
        rv:component ?slot ; rv:support ?support ; rv:outcome ?outcome ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
      ${publicWork('?work', '?main')}
      BIND("classification" AS ?kind)
    } UNION {
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:ContextRule ; rv:realm ${iri(realm)} ;
        rv:context ?subject .
        ?subject a rv:SemanticContext ; rv:contextState rv:Active ; rv:disclosure rv:Public . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:FiniteRuleRevision, rv:RevisionAnchor ;
        rv:component ?slot ; rv:realm ${iri(realm)} ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
      BIND("semantic-rule-change" AS ?kind)
    }`;
}

function decisionItem(row: ReadRow) {
  const kind = row.kind!.value;
  if (
    !['adoption', 'classification', 'semantic-rule-change'].includes(kind) ||
    (kind === 'classification' &&
      ![`${RV}Accepted`, `${RV}Rejected`].includes(row.outcome?.value ?? '')) ||
    (kind !== 'semantic-rule-change' && (!row.work || !row.subject))
  ) {
    throw new WorkReadUnavailable('Public decision index has invalid fields');
  }
  return {
    id: row.id!.value,
    kind,
    dataEpoch: row.revisionEpoch!.value,
    sequence: row.sequence!.value,
    work: row.work?.value ?? null,
    subject: row.subject?.value ?? null,
    outcome:
      row.outcome?.value === `${RV}Accepted`
        ? ('accepted' as const)
        : row.outcome?.value === `${RV}Rejected`
          ? ('rejected' as const)
          : null,
  };
}

/** Public graph revision index: no receipts, private actors or Access roster rows enter this relation.
 * One keyset page is chosen across all event families before any response mapping.
 * One lineage read, at most 64 admission batches with Work-keyed classification
 * continuations, two basis probes and two position fences bound graph round trips. Jena can scan/sort D eligible revisions (O(D log D));
 * a materialized seek index needs its own writer/retention owner before large-scale use. */
export async function readRealmDecisions(session: WorkReadSession, realm: string) {
  await readRealmBasis(session, realm);
  const history = await realmHistoryFilter(session, realm);
  // An empty cut already read this Realm's policy. Asking again would repeat that
  // one probe and still return no origin filter.
  const origin = history ? await realmHistoryOriginFilter(session, realm, 'selection', '?work') : '';
  const limit = session.options.limit ?? 20;
  const binding = ['realm-decisions-v1', realm];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const order = cursor?.order.split(':');
  if (order && (order.length !== 2 || !order.every((value) => /^\d+$/.test(value)))) {
    throw new WorkReadUnavailable('Decision cursor ordering is unavailable');
  }
  const epochs = await readEpochOrder(session);
  const selected = await admittedPage<ReadRow>({
    limit,
    after:
      cursor && order
        ? {
            id: { type: 'uri', value: cursor.after },
            epochOrder: { type: 'literal', value: order[0]! },
            sequence: { type: 'literal', value: order[1]! },
          }
        : undefined,
    key: (row) => row.id!.value,
    fetch: async (after, size) => {
      const rows = await session.query(
        `SELECT DISTINCT ?id ?kind ?work ?main ?subject ?outcome
    ?revisionEpoch ?sequence ?epochOrder WHERE {
    ${epochs}
    ${decisionRelation(realm)}
    ${history}
    ${origin ? `FILTER(!BOUND(?work) || EXISTS { ${origin} })` : ''}
    ${
      after
        ? `FILTER(?epochOrder > ${after.epochOrder!.value} || (?epochOrder = ${after.epochOrder!.value}
      && (?sequence < ${after.sequence!.value} || (?sequence = ${after.sequence!.value} && STR(?id) > ${lit(after.id!.value)}))))`
        : ''
    }
  } ORDER BY ?epochOrder DESC(?sequence) STR(?id) LIMIT ${size}`,
        size,
      );
      if (
        rows.some(
          (row) =>
            !row.id ||
            !row.kind ||
            !row.revisionEpoch ||
            !row.sequence ||
            !row.epochOrder ||
            !/^\d+$/.test(row.sequence.value),
        ) ||
        new Set(rows.map((row) => row.id!.value)).size !== rows.length
      ) {
        throw new WorkReadUnavailable('Public decision index is incomplete');
      }
      return rows;
    },
    admit: (rows) => admittedDecisions(session, rows, realm),
  });
  const page = selected.page;
  const items = page.map(decisionItem);
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return {
    profile: 'realm-decisions-v1' as const,
    ...pageResult(
      session,
      items,
      selected.lookahead && last
        ? encodeReadCursor(
            binding,
            session.position,
            last.id!.value,
            `${last.epochOrder!.value}:${last.sequence!.value}`,
          )
        : null,
    ),
  };
}

/** Exact public Decision, using the same disclosure relation as the paged log. */
export async function readRealmDecision(session: WorkReadSession, realm: string, decision: string) {
  await readRealmBasis(session, realm);
  const history = await realmHistoryFilter(session, realm);
  // Same policy probe as the page: no cut means there is no older publication to exclude.
  const origin = history ? await realmHistoryOriginFilter(session, realm, 'selection', '?work') : '';
  const rows = await session.query(
    `SELECT DISTINCT ?id ?kind ?work ?main ?subject ?outcome
    ?revisionEpoch ?sequence WHERE {
    ${decisionRelation(realm)}
    ${history}
    ${origin ? `FILTER(!BOUND(?work) || EXISTS { ${origin} })` : ''}
    FILTER(?id = ${iri(decision)})
  } LIMIT 2`,
    2,
  );
  if (!rows.length) throw new WorkReadMissing('Decision is unavailable');
  if (
    rows.length !== 1 ||
    !rows[0]?.id ||
    !rows[0].kind ||
    !rows[0].revisionEpoch ||
    !/^\d+$/.test(rows[0].sequence?.value ?? '')
  ) {
    throw new WorkReadUnavailable('Public Decision is ambiguous');
  }
  if (!(await admittedDecisions(session, rows, realm)).length)
    throw new WorkReadMissing('Decision is unavailable');
  await readRealmBasis(session, realm);
  return {
    profile: 'realm-decision-v1' as const,
    ...decisionItem(rows[0]),
    sourcePosition: session.position,
  };
}
