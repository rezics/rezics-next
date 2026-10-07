import { createHash } from 'node:crypto';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { ContextCommandUnavailable, term } from '../context/command.ts';
import { resolveInterpretation } from '../context/interpretation.ts';
import type { AccessJudgments } from '../judgment/access.ts';
import { readExactDefinition } from '../relation/change.ts';
import { readPublicStatementsAt, resolveStatementAcceptancesAt, STATEMENT_ACCEPTANCE_BATCH_COST,
  MAX_STATEMENT_ACCEPTANCE_BATCH, StatementBatchBudgetExceeded,
  StatementBatchUnavailable,
  type PublicStatementBatchRow } from '../statement/read.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { MAX_GROUPED_ROWS, queryPublicGroupedRatedCore,
  type GroupedRating, type GroupedRatingInput }
  from './search-grouped-rated.ts';
import { InvalidPublicQuery, queryPublicRealmPhrase } from './search-public.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
import { SearchSnapshotMoved } from './search-readiness.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { REFERENCE_DISCLOSURE_COST } from '../access/semantic-disclosure.ts';

export const GROUPED_SEARCH_COST = {
  maxRelationRows: MAX_GROUPED_ROWS, maxStatements: MAX_STATEMENT_ACCEPTANCE_BATCH, maxConditions: 2,
  maxFacetBuckets: 20, maxHydratedSupports: 20,
  maxOwnerAdmissions: 40, maxAcceptanceReads: STATEMENT_ACCEPTANCE_BATCH_COST.graphReads, maxBadgeChecks: 20,
  disclosureGraphReads: REFERENCE_DISCLOSURE_COST.graphReads,
  acceptanceGraphReads: STATEMENT_ACCEPTANCE_BATCH_COST.graphReads,
} as const;

export type GroupCountGrain = 'work' | 'participant' | 'occurrence'
  | 'qualifiedFact' | 'supportingStatement';
export type GroupFacetMode = 'fully-filtered' | 'self-filter-excluding';

export interface GroupedStatementCondition {
  predicate: string;
  relationDefinition: string;
  value: string;
  interpretationDefinition: string;
  semanticRevision: string;
  /** Exact release, canon and valid-time references. No implicit broadening. */
  applicability: readonly string[];
}

export interface AdmittedGroupRow {
  work: string;
  mainVersion: string;
  matchUnit: string;
  score: number;
  occurrence: string;
  participant: string;
  applicability: readonly string[];
  statement: PublicStatementBatchRow;
  acceptanceContext: string;
  rating?: GroupedRating;
}

interface QualifiedGroup {
  work: string;
  mainVersion: string;
  matchUnit: string;
  score: number;
  occurrence: string;
  participant: string;
  facts: Array<{ meaningKey: string; acceptanceContext: string; predicate: string;
    value: string; supportingStatements: string[] }>;
  rating?: GroupedRating;
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

function matches(row: AdmittedGroupRow, condition: GroupedStatementCondition): boolean {
  const fact = row.statement;
  return fact.subject === row.participant && fact.predicate === condition.predicate
    && fact.relationDefinition === condition.relationDefinition
    && fact.value.kind === 'resource' && fact.value.iri === condition.value
    && fact.meaningBasis.state === 'readable'
    && fact.meaningBasis.interpretationDefinitions.includes(condition.interpretationDefinition)
    && JSON.stringify(sorted(fact.applicability)) === JSON.stringify(sorted(condition.applicability))
    && JSON.stringify(sorted(row.applicability)) === JSON.stringify(sorted(condition.applicability));
}

function grainIds(group: QualifiedGroup, grain: GroupCountGrain): string[] {
  if (grain === 'work') return [group.work];
  if (grain === 'participant') return [group.participant];
  if (grain === 'occurrence') return [group.occurrence];
  if (grain === 'qualifiedFact') return group.facts.map(fact =>
    JSON.stringify([fact.meaningKey, fact.acceptanceContext]));
  return group.facts.flatMap(fact => fact.supportingStatements);
}

function candidateGrainId(row: AdmittedGroupRow, grain: GroupCountGrain): string {
  if (grain === 'work') return row.work;
  if (grain === 'participant') return row.participant;
  if (grain === 'occurrence') return row.occurrence;
  if (grain === 'qualifiedFact') return JSON.stringify([row.statement.meaningKey, row.acceptanceContext]);
  return row.statement.statement;
}

function qualify(rows: readonly AdmittedGroupRow[], conditions: readonly GroupedStatementCondition[],
  excluded: number | null): QualifiedGroup[] {
  const byOccurrence = new Map<string, AdmittedGroupRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.work, row.mainVersion, row.occurrence, row.participant]);
    const bucket = byOccurrence.get(key) ?? [];
    bucket.push(row);
    byOccurrence.set(key, bucket);
  }
  const groups: QualifiedGroup[] = [];
  for (const bucket of byOccurrence.values()) {
    const selected = conditions.map((condition, index) =>
      index === excluded ? [] : bucket.filter(row => matches(row, condition)));
    if (selected.some((match, index) => index !== excluded && match.length === 0)) continue;
    const facts = new Map<string, QualifiedGroup['facts'][number]>();
    for (const row of selected.flat()) {
      const statement = row.statement;
      const key = JSON.stringify([statement.meaningKey, row.acceptanceContext]);
      const fact = facts.get(key) ?? { meaningKey: statement.meaningKey,
        acceptanceContext: row.acceptanceContext, predicate: statement.predicate,
        value: statement.value.kind === 'resource' ? statement.value.iri : '',
        supportingStatements: [] };
      fact.supportingStatements.push(statement.statement);
      facts.set(key, fact);
    }
    const first = [...bucket].sort((a, b) => b.score - a.score
      || a.matchUnit.localeCompare(b.matchUnit))[0]!;
    groups.push({ work: first.work, mainVersion: first.mainVersion,
      matchUnit: first.matchUnit, score: first.score, occurrence: first.occurrence,
      participant: first.participant,
      facts: [...facts.values()].map(fact => ({ ...fact,
        supportingStatements: sorted(fact.supportingStatements) }))
        .sort((a, b) => a.meaningKey.localeCompare(b.meaningKey)),
      ...(first.rating ? { rating: first.rating } : {}) });
  }
  return groups.sort((a, b) => b.score - a.score || a.work.localeCompare(b.work)
    || a.participant.localeCompare(b.participant) || a.occurrence.localeCompare(b.occurrence));
}

/** Aggregate only admitted, exact owner rows. Every count is a distinct identity
 * at the requested grain. Self-filter facets keep all other conditions and
 * never drop the mandatory Work/occurrence/disclosure relation. */
export function groupAdmittedStatements(rows: readonly AdmittedGroupRow[],
  conditions: readonly GroupedStatementCondition[], countGrain: GroupCountGrain,
  facetMode: GroupFacetMode) {
  const position = rows[0]?.statement.sourcePosition;
  if (rows.length > GROUPED_SEARCH_COST.maxRelationRows
    || new Set(rows.map(row => row.statement.statement)).size > GROUPED_SEARCH_COST.maxStatements
    || conditions.length < 1 || conditions.length > GROUPED_SEARCH_COST.maxConditions) {
    throw new PublicQueryBudgetExceeded('grouped Statement relation exceeds its admitted bound');
  }
  if (rows.some(row => !Number.isFinite(row.score) || row.score < 0
    || row.statement.sourcePosition.datasetId !== 'product'
    || row.statement.sourcePosition.dataEpoch !== position?.dataEpoch
    || row.statement.sourcePosition.sequence !== position?.sequence
    || row.statement.subject !== row.participant
    || !row.acceptanceContext)) {
    throw new PublicQueryUnavailable('grouped Statement owner rows are inconsistent');
  }
  const groups = qualify(rows, conditions, null);
  const identities = new Set(groups.flatMap(group => grainIds(group, countGrain)));
  const facets = conditions.map((condition, index) => {
    const population = facetMode === 'fully-filtered' ? groups : qualify(rows, conditions, index);
    const values = new Map<string, Set<string>>();
    for (const group of population) {
      const matching = rows.filter(row => row.work === group.work
        && row.occurrence === group.occurrence && row.participant === group.participant
        && row.statement.predicate === condition.predicate
        && row.statement.relationDefinition === condition.relationDefinition
        && row.statement.meaningBasis.state === 'readable'
        && (facetMode === 'self-filter-excluding'
          || row.statement.meaningBasis.interpretationDefinitions.includes(condition.interpretationDefinition))
        && row.statement.value.kind === 'resource'
        && (facetMode === 'self-filter-excluding' || row.statement.value.iri === condition.value)
        && JSON.stringify(sorted(row.applicability)) === JSON.stringify(sorted(condition.applicability))
        && JSON.stringify(sorted(row.statement.applicability)) === JSON.stringify(sorted(condition.applicability)));
      for (const row of matching) {
        if (row.statement.value.kind !== 'resource') continue;
        const set = values.get(row.statement.value.iri) ?? new Set<string>();
        set.add(candidateGrainId(row, countGrain));
        values.set(row.statement.value.iri, set);
      }
    }
    if (values.size > GROUPED_SEARCH_COST.maxFacetBuckets) {
      throw new PublicQueryBudgetExceeded('grouped Statement facets exceed their bucket bound');
    }
    return { predicate: condition.predicate, mode: facetMode,
      populationBasis: facetMode === 'fully-filtered' ? 'all-filters' : `all-except-${index}`,
      values: [...values].map(([value, set]) => ({ value, count: set.size }))
        .sort((a, b) => a.value.localeCompare(b.value)) };
  });
  return { complete: true as const, countPrecision: 'exact' as const,
    facetPrecision: 'exact' as const, resultGrain: countGrain,
    total: identities.size, groups, facets };
}

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u;
const reference = /^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/u;
const roleKey = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;

export interface PublicGroupedStatementPhraseQuery {
  profile: 'public-grouped-statement-phrase-v1';
  actingSubject: string;
  context: { kind: 'realm-local'; id: string };
  phrase: string;
  language: string;
  relation: { definition: string; workRole: string; participantRole: string };
  conditions: Array<{ predicate: string; relationDefinition: string; value: string;
    context: string; semanticRevision: string; applicability: string[] }>;
  countGrain: GroupCountGrain;
  facetMode?: GroupFacetMode;
  rating?: GroupedRatingInput;
}

interface CandidateBinding { epoch?: { value: string }; sequence?: { value: string };
  work?: { value: string }; main?: { value: string }; occurrence?: { value: string };
  participant?: { value: string }; statement?: { value: string }; applicability?: { value: string } }

function checkedGroupedInput(input: PublicGroupedStatementPhraseQuery): void {
  if (!native.test(input.actingSubject) || input.context?.kind !== 'realm-local'
    || !native.test(input.context.id) || !native.test(input.relation?.definition)
    || !roleKey.test(input.relation.workRole) || !roleKey.test(input.relation.participantRole)
    || input.relation.workRole === input.relation.participantRole
    || !Array.isArray(input.conditions) || input.conditions.length < 1
    || input.conditions.length > GROUPED_SEARCH_COST.maxConditions
    || input.conditions.some(condition => !reference.test(condition.predicate)
      || !reference.test(condition.relationDefinition) || !native.test(condition.value)
      || !native.test(condition.context) || !native.test(condition.semanticRevision)
      || !Array.isArray(condition.applicability) || condition.applicability.length > 8
      || condition.applicability.some(value => !native.test(value))
      || new Set(condition.applicability).size !== condition.applicability.length)
    || !['work', 'participant', 'occurrence', 'qualifiedFact', 'supportingStatement'].includes(input.countGrain)
    || (input.facetMode !== undefined
      && !['fully-filtered', 'self-filter-excluding'].includes(input.facetMode))
    || (input.rating !== undefined && (!native.test(input.rating.context)
      || !Number.isInteger(input.rating.minimumMeanTimes10)
      || input.rating.minimumMeanTimes10 < 10 || input.rating.minimumMeanTimes10 > 100))
    || input.language.length < 2) {
    throw new InvalidPublicQuery('invalid grouped Statement query');
  }
}

function parseApplicability(value: string | undefined): string[] {
  if (!value) return [];
  const entries = sorted(value.split('|'));
  if (entries.length > 8 || entries.some(entry => !native.test(entry))) {
    throw new PublicQueryUnavailable('grouped occurrence applicability is incomplete');
  }
  return entries;
}

async function assertGroupedPosition(env: WorkActivationEnvironment,
  position: { dataEpoch: string; sequence: string }): Promise<void> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0]?.sequence) {
    throw new PublicQueryUnavailable('grouped graph position is unavailable');
  }
  if (rows[0].epoch.value !== position.dataEpoch || rows[0].sequence.value !== position.sequence) {
    throw new SearchSnapshotMoved('grouped search crossed graph generations');
  }
}

/** One bounded public phrase relation, one structural Statement/occurrence
 * discovery read, page disclosure, one owner batch, then page acceptance and
 * exact protection proofs. The observed unrated plan needs 13 setup reads +
 * at most 5 disclosure + 2 hydration + 3 acceptance + 1 final fence = 24;
 * its ordinary grant path needs 20. Both retain the route's 72-call budget.
 * Discovered IDs are admitted before they enter any grouped count or facet. */
export async function queryPublicGroupedStatementPhrase(env: WorkActivationEnvironment,
  judgments: Pick<AccessJudgments, 'protectionChecks'>,
  canReadResources: (resources: readonly string[]) => Promise<ReadonlySet<string>>,
  input: PublicGroupedStatementPhraseQuery,
  admitPhrase?: (relation: Awaited<ReturnType<typeof queryPublicRealmPhrase>>) =>
    Promise<Awaited<ReturnType<typeof queryPublicRealmPhrase>>>) {
  checkedGroupedInput(input);
  const facetMode = input.facetMode ?? 'fully-filtered';
  // System reader: only the role keys are used; no member list reaches a result.
  const relation = await readExactDefinition(env, input.relation.definition, systemDisclosure);
  if (!relation || relation.lifecycle !== 'active'
    || !relation.roleKeys || !Object.values(relation.roleKeys).includes(input.relation.workRole)
    || !Object.values(relation.roleKeys).includes(input.relation.participantRole)) {
    throw new PublicQueryUnavailable('grouped relation definition is unavailable');
  }
  const role = (key: string) => Object.entries(relation.roleKeys).find(([, value]) => value === key)?.[0]!;
  const resolved: GroupedStatementCondition[] = [];
  const interpretations: Array<{ basis: string; context: string; semanticRevision: string;
    definition: string; entryRevision: string | null; selectionRevision: string | null;
    sourcePosition: { dataEpoch: string; sequence: string } }> = [];
  for (const condition of input.conditions) {
    const interpretation = await resolveInterpretation(env, { object: condition.value,
      relation: condition.predicate,
      explicit: { context: condition.context, semanticRevision: condition.semanticRevision },
      speaker: { kind: 'realm', realm: input.context.id } });
    if (interpretation.state !== 'resolved' || !interpretation.definition
      || !interpretation.sourcePosition) {
      throw new PublicQueryUnavailable('grouped interpretation is unresolved');
    }
    interpretations.push({ basis: interpretation.basis, context: interpretation.context!,
      semanticRevision: interpretation.semanticRevision!, definition: interpretation.definition,
      entryRevision: interpretation.entryRevision, selectionRevision: interpretation.selectionRevision,
      sourcePosition: interpretation.sourcePosition });
    resolved.push({ predicate: condition.predicate, relationDefinition: condition.relationDefinition,
      value: condition.value, interpretationDefinition: interpretation.definition,
      semanticRevision: condition.semanticRevision, applicability: sorted(condition.applicability) });
  }
  const rated = input.rating ? await queryPublicGroupedRatedCore(env, {
    realm: input.context.id, phrase: input.phrase, language: input.language,
    rating: input.rating, relationDefinition: input.relation.definition,
    workRole: role(input.relation.workRole), participantRole: role(input.relation.participantRole),
    predicates: sorted(resolved.map(condition => condition.predicate)),
  }) : null;
  const phraseRelation = rated?.phrase ?? await queryPublicRealmPhrase(env, { context: input.context,
    phrase: input.phrase, language: input.language });
  const phrase = admitPhrase ? await admitPhrase(phraseRelation) : phraseRelation;
  if (interpretations.some(item => item.sourcePosition.dataEpoch !== phrase.sourcePosition.dataEpoch
    || item.sourcePosition.sequence !== phrase.sourcePosition.sequence)) {
    throw new SearchSnapshotMoved('grouped interpretation moved before text selection');
  }
  if (phrase.results.length === 0) {
    await assertGroupedPosition(env, phrase.sourcePosition);
    const { groups, ...empty } = groupAdmittedStatements([], resolved, input.countGrain, facetMode);
    return { contractVersion: '1' as const, profile: input.profile, ...empty, results: groups,
      sourcePosition: phrase.sourcePosition, interpretations,
      indexGeneration: phrase.indexGeneration,
      ...(rated ? { ratingCriterion: { context: input.rating!.context,
        minimumMeanTimes10: input.rating!.minimumMeanTimes10,
        policy: 'latest-per-rater-mean' as const }, ratingPopulation: rated.ratingPopulation } : {}),
      groupGeneration: createHash('sha256').update(JSON.stringify([resolved,
        interpretations.map(({ sourcePosition: _, ...basis }) => basis)])).digest('hex') };
  }
  let bindings: CandidateBinding[];
  if (rated) {
    const admittedPairs = new Set(phrase.results.map(result =>
      JSON.stringify([result.work, result.mainVersion])));
    bindings = rated.bindings.filter(row => !row.statement || admittedPairs.has(
      JSON.stringify([row.work?.value, row.main?.value])));
  } else {
    const pairs = phrase.results.map(result => `(${iri(result.work)} ${iri(result.mainVersion)})`).join(' ');
    const predicates = sorted(resolved.map(condition => condition.predicate)).map(term).join(' ');
    const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?epoch ?sequence ?work ?main ?occurrence ?participant ?statement
      (GROUP_CONCAT(DISTINCT STR(?app); separator="|") AS ?applicability) WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(phrase.sourcePosition.dataEpoch)}
        && ?sequence = ${phrase.sourcePosition.sequence})
      OPTIONAL { { SELECT DISTINCT ?work ?main ?occurrence ?participant ?statement WHERE {
        VALUES (?work ?main) { ${pairs} }
        VALUES ?predicate { ${predicates} }
        GRAPH ${iri(GRAPHS.current)} {
          ?occurrence a rv:RelationOccurrence ; rv:relationDefinition ${iri(input.relation.definition)} ;
            rv:occurrenceHead ?revision .
          ?statement a rdf:Statement ; rdf:subject ?participant ; rdf:predicate ?predicate ;
            rv:statementState rv:Active .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:RelationOccurrenceRevision ; rv:component ?occurrence ;
            rv:lifecycle rv:Active ; rv:participation ?workPart, ?participantPart .
          ?workPart rv:role ${iri(role(input.relation.workRole))} ; rv:participant ?workEndpoint .
          ?participantPart rv:role ${iri(role(input.relation.participantRole))} ;
            rv:participant ?participant .
        }
        FILTER(?workEndpoint = ?work || ?workEndpoint = ?main)
      } ORDER BY STR(?work) STR(?occurrence) STR(?participant) STR(?statement)
        LIMIT ${GROUPED_SEARCH_COST.maxRelationRows + 1} }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?occurrence rv:applicability ?app } }
      }
    } GROUP BY ?epoch ?sequence ?work ?main ?occurrence ?participant ?statement`,
    1_048_576);
    bindings = (result.results?.bindings ?? []) as CandidateBinding[];
  }
  if (!bindings.length || bindings.some(row => row.epoch?.value !== phrase.sourcePosition.dataEpoch
    || row.sequence?.value !== phrase.sourcePosition.sequence)) {
    throw new SearchSnapshotMoved('grouped discovery moved or is unavailable');
  }
  const candidates = bindings.filter(row => row.statement);
  if (candidates.length > GROUPED_SEARCH_COST.maxRelationRows) {
    throw new PublicQueryBudgetExceeded('grouped relation candidate population exceeds its bound');
  }
  const admitted: Array<{ work: string; main: string; occurrence: string; participant: string;
    statement: string; applicability: string[] }> = [];
  if (candidates.some(row => !row.work || !row.main || !row.occurrence || !row.participant || !row.statement)) {
    throw new PublicQueryUnavailable('grouped discovery binding is incomplete');
  }
  const references = sorted(candidates.flatMap(row => [row.occurrence!.value, row.participant!.value]));
  const readable = references.length ? await canReadResources(references) : new Set<string>();
  if ([...readable].some(ref => !references.includes(ref))) {
    throw new PublicQueryUnavailable('grouped disclosure returned an unrelated reference');
  }
  for (const row of candidates) {
    const occurrence = row.occurrence!.value, participant = row.participant!.value;
    if (!readable.has(occurrence) || !readable.has(participant)) continue;
    admitted.push({ work: row.work!.value, main: row.main!.value, occurrence, participant,
      statement: row.statement!.value, applicability: parseApplicability(row.applicability?.value) });
  }
  const statementIds = sorted(admitted.map(row => row.statement));
  if (statementIds.length > GROUPED_SEARCH_COST.maxStatements) {
    throw new PublicQueryBudgetExceeded('grouped Statement hydration exceeds its bound');
  }
  let statements: Awaited<ReturnType<typeof readPublicStatementsAt>>;
  try { statements = await readPublicStatementsAt(env, statementIds, phrase.sourcePosition); }
  catch (error) {
    if (error instanceof StatementBatchBudgetExceeded) {
      throw new PublicQueryBudgetExceeded('grouped Statement owner batch exceeds its bound');
    }
    if (error instanceof StatementBatchUnavailable) {
      throw new PublicQueryUnavailable('grouped Statement owner batch is unavailable');
    }
    throw error;
  }
  let acceptances: Awaited<ReturnType<typeof resolveStatementAcceptancesAt>>;
  try { acceptances = await resolveStatementAcceptancesAt(env, statementIds,
    { kind: 'realm', realm: input.context.id }, phrase.sourcePosition); }
  catch (error) {
    if (error instanceof StatementBatchBudgetExceeded) throw new PublicQueryBudgetExceeded('grouped acceptance exceeds its bound');
    if (error instanceof StatementBatchUnavailable || error instanceof ContextCommandUnavailable) {
      throw new PublicQueryUnavailable('grouped Statement acceptance is unavailable');
    }
    throw error;
  }
  const visible = new Map<string, { acceptanceContext: string; generation: string }>();
  const badgeTargets: Array<{ statement: string;
    context: { kind: 'global' } | { kind: 'realm'; realm: string }; concept: null;
    acceptanceContext: string; generationBasis: string[] }> = [];
  for (const statement of statementIds) {
    const read = statements.get(statement);
    if (!read) throw new PublicQueryUnavailable('grouped Statement owner read is missing');
    const acceptance = acceptances.get(statement);
    if (!acceptance) throw new PublicQueryUnavailable('grouped Statement acceptance is missing');
    if (acceptance.sourcePosition.sequence !== phrase.sourcePosition.sequence
      || acceptance.sourcePosition.dataEpoch !== phrase.sourcePosition.dataEpoch) {
      throw new SearchSnapshotMoved('grouped Statement acceptance moved');
    }
    if (acceptance.result.state === 'unavailable') {
      throw new PublicQueryUnavailable('grouped Statement acceptance is unavailable');
    }
    if (acceptance.result.state !== 'accepted') continue;
    const inherited = acceptance.result.source !== 'local';
    badgeTargets.push({ statement,
      context: inherited ? { kind: 'global' } : { kind: 'realm', realm: input.context.id }, concept: null,
      acceptanceContext: inherited ? GLOBAL_CLASSIFICATION_CONTEXT : acceptance.acceptanceContext,
      generationBasis: [read.revision, acceptance.result.decision, acceptance.policy] });
  }
  const badges = badgeTargets.length ? await judgments.protectionChecks(
    badgeTargets.map(({ statement, context, concept }) => ({ statement, context, concept }))) : [];
  if (badges.length !== badgeTargets.length) {
    throw new PublicQueryUnavailable('grouped judgment protection page is incomplete');
  }
  for (const [index, target] of badgeTargets.entries()) {
    const badge = badges[index]!;
    const { statement, context } = target;
    if (badge.statement !== statement || badge.context.kind !== context.kind
      || (badge.context.kind === 'realm' && context.kind === 'realm' && badge.context.realm !== context.realm)) {
      throw new PublicQueryUnavailable('grouped judgment protection target differs');
    }
    if (badge.protection !== 'show-all') continue;
    visible.set(statement, { acceptanceContext: target.acceptanceContext,
      generation: JSON.stringify([...target.generationBasis,
        badge.generation, badge.conceptHintGeneration]) });
  }
  const textByMain = new Map(phrase.results.map(row => [row.mainVersion, row]));
  const ratingByMain = new Map(rated?.phrase.results.map(row => [row.mainVersion, row.rating]) ?? []);
  const groupRows: AdmittedGroupRow[] = admitted.flatMap(row => {
    const read = statements.get(row.statement), badge = visible.get(row.statement);
    const text = textByMain.get(row.main);
    if (!read || !badge || !text || text.work !== row.work) return [];
    return [{ work: row.work, mainVersion: row.main, matchUnit: text.matchUnit,
      score: text.score, occurrence: row.occurrence, participant: row.participant,
      applicability: row.applicability, statement: read,
      acceptanceContext: badge.acceptanceContext,
      ...(ratingByMain.has(row.main) ? { rating: ratingByMain.get(row.main)! } : {}) }];
  });
  const grouped = groupAdmittedStatements(groupRows, resolved, input.countGrain, facetMode);
  const { groups, ...summary } = grouped;
  await assertGroupedPosition(env, phrase.sourcePosition);
  const generation = createHash('sha256').update(JSON.stringify([phrase.results, resolved,
    interpretations.map(({ sourcePosition: _, ...basis }) => basis),
    groupRows.map(row => JSON.stringify([row.work, row.mainVersion, row.occurrence, row.participant,
      row.applicability, row.statement.statement,
      visible.get(row.statement.statement)?.generation])).sort()])).digest('hex');
  return { contractVersion: '1' as const, profile: input.profile, ...summary, results: groups,
    sourcePosition: phrase.sourcePosition, interpretations,
    ...(rated ? { ratingCriterion: { context: input.rating!.context,
      minimumMeanTimes10: input.rating!.minimumMeanTimes10,
      policy: 'latest-per-rater-mean' as const }, ratingPopulation: rated.ratingPopulation } : {}),
    indexGeneration: phrase.indexGeneration, groupGeneration: generation };
}
