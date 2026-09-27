import type { Static } from 'typebox';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { resolveClassification } from '../classification/resolve.ts';
import { checkJudgmentProtection } from '../judgment/protection.ts';
import { CLASSIFIED_AS, statementMeaningKey } from '../statement/schema.ts';
import { GRAPHS, iri, lit } from './activate.ts';
import { classificationItem } from './read-contract.ts';
import { readSearchDecisionSupports } from './search-supports.ts';
import { readWorkBasis, fenceWorkBasis } from './read-header.ts';
import { readMetadataRelevance } from './metadata-read.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid,
  WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

/** Curated acceptance and separately recorded editor relevance retain distinct authority. */
export async function readWorkClassifications(session: WorkReadSession, work: string, selectedSenses?: readonly string[]) {
  if (selectedSenses && (selectedSenses.length < 1 || selectedSenses.length > 3
    || selectedSenses.some(sense => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(sense)))) {
    throw new WorkReadInvalid('Invalid classification selection');
  }
  const basis = await readWorkBasis(session, work);
  const scope = await session.scope();
  if (scope.kind === 'mine') throw new WorkReadInvalid('Personal classification decisions are not defined');
  const limit = session.options.limit ?? 20;
  const binding = ['classifications', work, scope, session.options.language ?? null, ...(selectedSenses ? [selectedSenses] : [])];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT DISTINCT ?sense ?revision ?concept WHERE {
    ${selectedSenses ? `VALUES ?sense { ${selectedSenses.map(iri).join(' ')} }` : ''}
    GRAPH ${iri(GRAPHS.current)} {
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:head ?revision ; rv:expression ?expression .
      ?expression rv:assertedConcept ?concept ; rv:expressionState rv:Active .
      { ?statement a rdf:Statement ; rdf:subject ${iri(basis.card.mainVersion)} ;
          rdf:predicate <${CLASSIFIED_AS}> ; rv:statementState rv:Active ; rv:interpretationDefinition ?revision .
        FILTER NOT EXISTS { ?statement rv:semanticContextRevision ?pin .
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?pin rv:component ?ctx }
            ?ctx rv:disclosure rv:Public } }
        FILTER NOT EXISTS { ?statement rv:speaker ?speaker . ?speaker a rv:Realm ; rv:space ?space .
          FILTER NOT EXISTS { ?space rv:disclosure rv:Public } }
      } UNION {
        ?application a rv:ClassificationApplication ; rv:targetMainVersion ${iri(basis.card.mainVersion)} ;
          rv:sense ?sense ; rv:classificationContext ?context ; rv:applicationState rv:Active .
        ${scope.kind === 'realm' ? `{ ${iri(scope.realm!)} rv:classificationContext ?context }
          UNION { BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context) }`
      : `VALUES ?context { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} }`}
      }
    } ${cursor ? `FILTER(STR(?sense) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?sense) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.sense || !row.revision || !row.concept)
    || new Set(rows.map(row => row.sense!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Classification candidates are ambiguous');
  }
  const page = rows.slice(0, limit);
  const accepted: { sense: string; concept: string; decision: string; source: 'local' | 'global';
    sourceContext: string; meaningKey: string | null }[] = [];
  for (const row of page) {
    session.checkDeadline();
    const result = await resolveClassification(session.deps.environment, { work, mainVersion: basis.card.mainVersion,
      sense: row.sense!.value, context: scope.kind === 'realm'
        ? { kind: 'realm-classification', id: scope.realm! } : { kind: 'global' } });
    if (result.state !== 'accepted' || !result.decision || !result.sourceContext) continue;
    accepted.push({ sense: row.sense!.value, concept: row.concept!.value, decision: result.decision,
      source: result.source === 'local' ? 'local' : 'global', sourceContext: result.sourceContext,
      meaningKey: result.application ? null : statementMeaningKey({ subject: basis.card.mainVersion,
        predicate: CLASSIFIED_AS, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
        interpretationDefinitions: [row.revision!.value], value: { kind: 'resource', iri: row.concept!.value },
        applicability: [] }) });
  }
  const supports = await readSearchDecisionSupports(session.deps.environment, session.position,
    accepted.flatMap(item => item.meaningKey ? [{ mainVersion: basis.card.mainVersion,
      meaningKey: item.meaningKey, decision: item.decision, sourceContext: item.sourceContext }] : []));
  const names = await session.summaries(accepted.map(item => item.concept));
  const items: Static<typeof classificationItem>[] = [];
  for (const [index, item] of accepted.entries()) {
    if (item.meaningKey) {
      if (!session.deps.judgments) throw new WorkReadUnavailable('Judgment protection owner is unavailable');
      let visible = false;
      for (const support of supports.get(`${basis.card.mainVersion}\0${item.decision}`) ?? []) {
        session.checkDeadline();
        const checked = await checkJudgmentProtection(session.deps.judgments, support,
          item.source === 'local' ? { kind: 'realm', realm: scope.realm! } : { kind: 'global' }, item.concept)
          .catch(() => { throw new WorkReadUnavailable('Judgment protection read is unavailable'); });
        visible ||= checked.protection === 'show-all';
      }
      if (!visible) continue;
    }
    const name = names[index];
    if (name?.status === 'available') items.push({ sense: item.sense, concept: item.concept,
      name: name.name, relevance: null, relevanceRevision: null, relevanceStatus: 'unrecorded',
      source: item.source, decision: item.decision });
  }
  const relevance = await readMetadataRelevance(session, work, scope, items);
  for (const item of items) {
    const assessment = relevance.get(item.sense);
    item.relevance = assessment?.value ?? null;
    item.relevanceRevision = assessment?.revision ?? null;
    item.relevanceStatus = assessment?.status ?? 'unrecorded';
  }
  await fenceWorkBasis(session, basis);
  return { ...pageResult(session, items, rows.length > limit
    ? encodeReadCursor(binding, session.position, page.at(-1)!.sense!.value) : null), scope };
}
