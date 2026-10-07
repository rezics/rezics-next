import type { Static } from 'typebox';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { resolveClassifications } from '../classification/resolve.ts';
import { checkJudgmentProtection } from '../judgment/protection.ts';
import { CLASSIFIED_AS, statementMeaningKey } from '../statement/schema.ts';
import { GRAPHS, iri, lit } from './activate.ts';
import { classificationItem } from './read-contract.ts';
import { MAX_SUMMARY_BATCH } from '../media/summary.ts';
import { readSearchDecisionSupports } from './search-supports.ts';
import { readWorkBasis, fenceWorkBasis } from './read-header.ts';
import { readMetadataRelevance } from './metadata-read.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  pageResult,
  publicWork,
  WorkReadInvalid,
  WorkReadLimit,
  WorkReadUnavailable,
  type WorkReadSession,
} from './read-session.ts';

export const WORK_CLASSIFICATION_BATCH_COST = {
  works: 24,
  senses: 20,
  candidates: 504,
  candidateQueries: 1,
  resolutionQueries: 2,
  conceptSummaryBatches: 8,
  workSummaryBatches: 2,
} as const;
interface ClassificationTarget {
  work: string;
  mainVersion: string;
}
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
function checkSelection(selectedSenses?: readonly string[]) {
  if (
    selectedSenses &&
    (selectedSenses.length < 1 ||
      selectedSenses.length > 3 ||
      selectedSenses.some((sense) => !nativeId.test(sense)))
  ) {
    throw new WorkReadInvalid('Invalid classification selection');
  }
}

/** A bounded UNION of Work-keyed seeks gives each Work its own P+1 sentinel.
 * A single outer LIMIT could hide one Work's overflow behind another's rows. */
export async function readWorkClassificationBatch(
  session: WorkReadSession,
  targets: readonly ClassificationTarget[],
  selectedSenses?: readonly string[],
  after?: string,
) {
  checkSelection(selectedSenses);
  const limit = session.options.limit ?? 20;
  if (
    targets.length > WORK_CLASSIFICATION_BATCH_COST.works ||
    limit < 1 ||
    limit > WORK_CLASSIFICATION_BATCH_COST.senses ||
    new Set(targets.map((row) => row.work)).size !== targets.length ||
    targets.some((row) => !nativeId.test(row.work) || !nativeId.test(row.mainVersion))
  ) {
    throw new WorkReadLimit('Classification batch exceeds its bounded relation');
  }
  const scope = await session.scope();
  if (scope.kind === 'mine')
    throw new WorkReadInvalid('Personal classification decisions are not defined');
  if (!targets.length)
    return new Map<string, { items: Static<typeof classificationItem>[]; after: string | null }>();
  const rows = await session.query(
    `SELECT ?work ?sense ?revision ?concept ?realmContext WHERE {
    ${targets
      .map(
        (target) => `{ SELECT DISTINCT ?work ?sense ?revision ?concept ?realmContext WHERE {
      BIND(${iri(target.work)} AS ?work)
      ${selectedSenses ? `VALUES ?sense { ${selectedSenses.map(iri).join(' ')} }` : ''}
      ${
        scope.kind === 'realm'
          ? `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ${iri(scope.realm!)} rv:classificationContext ?realmContext } }`
          : ''
      }
      GRAPH ${iri(GRAPHS.current)} {
        ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:head ?revision ; rv:expression ?expression .
        ?expression rv:assertedConcept ?concept ; rv:expressionState rv:Active .
        { ?statement a rdf:Statement ; rdf:subject ${iri(target.mainVersion)} ;
            rdf:predicate <${CLASSIFIED_AS}> ; rv:statementState rv:Active ; rv:interpretationDefinition ?revision .
          FILTER NOT EXISTS { ?statement rv:semanticContextRevision ?pin .
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?pin rv:component ?ctx }
              ?ctx rv:disclosure rv:Public } }
          FILTER NOT EXISTS { ?statement rv:speaker ?speaker . ?speaker a rv:Realm ; rv:space ?space .
            FILTER NOT EXISTS { ?space rv:disclosure rv:Public } }
        }
      } ${after ? `FILTER(STR(?sense) > ${lit(after)})` : ''}
    } ORDER BY STR(?sense) LIMIT ${limit + 1} }`,
      )
      .join(' UNION ')}
  }`,
    targets.length * (limit + 1),
  );
  const grouped = new Map(targets.map((target) => [target.work, [] as typeof rows]));
  for (const row of rows) {
    const own = grouped.get(row.work?.value ?? '');
    if (
      !own ||
      !row.sense ||
      !row.revision ||
      !row.concept ||
      own.some((prior) => prior.sense!.value === row.sense!.value)
    ) {
      throw new WorkReadUnavailable('Classification candidates are ambiguous');
    }
    own.push(row);
  }
  const candidates = targets.flatMap((target) => {
    const own = grouped
      .get(target.work)!
      .sort((a, b) => a.sense!.value.localeCompare(b.sense!.value));
    if (own.length > limit + 1)
      throw new WorkReadLimit('Classification candidate fanout exceeds its bound');
    return own.slice(0, limit).map((row) => ({ target, row }));
  });
  const realmContext = scope.kind === 'realm' && rows.some((row) => row.realmContext);
  const resolved = await resolveClassifications(
    session.deps.environment,
    candidates.map(({ target, row }) => ({
      ...target,
      sense: row.sense!.value,
      context: realmContext
        ? { kind: 'realm-classification' as const, id: scope.realm! }
        : { kind: 'global' as const },
    })),
    session.position,
  );
  const accepted = candidates.flatMap(({ target, row }, index) => {
    const result = resolved[index]!;
    if (result.state !== 'accepted' || !result.decision || !result.sourceContext) return [];
    return [
      {
        ...target,
        sense: row.sense!.value,
        concept: row.concept!.value,
        decision: result.decision,
        source: result.source === 'local' ? ('local' as const) : ('global' as const),
        sourceContext: result.sourceContext,
        meaningKey: statementMeaningKey({
          subject: target.mainVersion,
          predicate: CLASSIFIED_AS,
          relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
          interpretationDefinitions: [row.revision!.value],
          value: { kind: 'resource', iri: row.concept!.value },
          applicability: [],
        }),
      },
    ];
  });
  const supports = await readSearchDecisionSupports(
    session.deps.environment,
    session.position,
    accepted.flatMap((item) =>
      item.meaningKey
        ? [
            {
              mainVersion: item.mainVersion,
              meaningKey: item.meaningKey,
              decision: item.decision,
              sourceContext: item.sourceContext,
            },
          ]
        : [],
    ),
  );
  const concepts = [...new Set(accepted.map((item) => item.concept))];
  const names = new Map<string, Awaited<ReturnType<WorkReadSession['summaries']>>[number]>();
  for (let start = 0; start < concepts.length; start += MAX_SUMMARY_BATCH) {
    for (const name of await session.summaries(concepts.slice(start, start + MAX_SUMMARY_BATCH))) {
      names.set(name.reference, name);
    }
  }
  const result = new Map(
    targets.map((target) => {
      const own = grouped.get(target.work)!;
      return [
        target.work,
        {
          items: [] as Static<typeof classificationItem>[],
          after: own.length > limit ? own[limit - 1]!.sense!.value : null,
        },
      ] as const;
    }),
  );
  for (const item of accepted) {
    if (item.meaningKey) {
      if (!session.deps.judgments)
        throw new WorkReadUnavailable('Judgment protection owner is unavailable');
      let visible = false;
      for (const support of supports.get(`${item.mainVersion}\0${item.decision}`) ?? []) {
        session.checkDeadline();
        const checked = await checkJudgmentProtection(
          session.deps.judgments,
          support,
          item.source === 'local' ? { kind: 'realm', realm: scope.realm! } : { kind: 'global' },
          item.concept,
        ).catch(() => {
          throw new WorkReadUnavailable('Judgment protection read is unavailable');
        });
        visible ||= checked.protection === 'show-all';
      }
      if (!visible) continue;
    }
    const name = names.get(item.concept);
    if (name?.status === 'available')
      result.get(item.work)!.items.push({
        sense: item.sense,
        concept: item.concept,
        name: name.name,
        relevance: null,
        relevanceRevision: null,
        relevanceStatus: 'unrecorded',
        source: item.source,
        decision: item.decision,
      });
  }
  return result;
}

/** Public page consumers admit and recheck every Work in two summary batches;
 * they need no metadata, language selection or serial hydration to match tags. */
export async function readPublicWorkClassifications(
  session: WorkReadSession,
  works: readonly string[],
  selectedSenses?: readonly string[],
) {
  const unique = [...new Set(works)];
  if (
    unique.length > WORK_CLASSIFICATION_BATCH_COST.works ||
    unique.some((work) => !nativeId.test(work))
  ) {
    throw new WorkReadLimit('Classification Work batch exceeds its bound');
  }
  if (!unique.length)
    return new Map<string, { items: Static<typeof classificationItem>[]; after: string | null }>();
  const rows = await session.query(
    `SELECT ?work ?main WHERE {
    ${unique.map((work) => `{ BIND(${iri(work)} AS ?work) ${publicWork(iri(work), '?main')} }`).join(' UNION ')}
  } LIMIT ${unique.length + 1}`,
    unique.length + 1,
  );
  if (
    new Set(rows.map((row) => row.work?.value)).size !== rows.length ||
    rows.some((row) => !row.work || !row.main || !unique.includes(row.work.value))
  ) {
    throw new WorkReadUnavailable('Classification Work bases are ambiguous');
  }
  const summaries = new Map((await session.summaries(unique)).map((row) => [row.reference, row]));
  const targets = rows
    .filter((row) => summaries.get(row.work!.value)?.status === 'available')
    .map((row) => ({ work: row.work!.value, mainVersion: row.main!.value }));
  const result = await readWorkClassificationBatch(session, targets, selectedSenses);
  const final = await session.summaries(targets.map((row) => row.work));
  final.forEach((row) => {
    if (row.status !== 'available') result.delete(row.reference);
  });
  return result;
}

/** Curated acceptance and separately recorded editor relevance retain distinct authority. */
export async function readWorkClassifications(
  session: WorkReadSession,
  work: string,
  selectedSenses?: readonly string[],
) {
  checkSelection(selectedSenses);
  const basis = await readWorkBasis(session, work),
    scope = await session.scope();
  const binding = [
    'classifications',
    work,
    scope,
    session.options.language ?? null,
    ...(selectedSenses ? [selectedSenses] : []),
  ];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const batch = await readWorkClassificationBatch(
    session,
    [{ work, mainVersion: basis.card.mainVersion }],
    selectedSenses,
    cursor?.after,
  );
  const { items, after } = batch.get(work)!;
  const relevance = await readMetadataRelevance(session, work, scope, items);
  for (const item of items) {
    const assessment = relevance.get(item.sense);
    item.relevance = assessment?.value ?? null;
    item.relevanceRevision = assessment?.revision ?? null;
    item.relevanceStatus = assessment?.status ?? 'unrecorded';
  }
  await fenceWorkBasis(session, basis);
  return {
    ...pageResult(
      session,
      items,
      after ? encodeReadCursor(binding, session.position, after) : null,
    ),
    scope,
  };
}
