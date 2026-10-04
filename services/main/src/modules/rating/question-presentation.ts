import { profileValidations } from '../../infrastructure/profile.ts';
import { term } from '../semantic/change.ts';
import {
  assertSemanticDispatchable,
  checkedSemanticTerminal,
  ensureModelGeneration,
  familyReceiptIri,
  readComponent,
  readSemanticTerminal,
  sealComponentState,
  sealSemanticRejection,
  sendSemanticWrite,
  SemanticChangeRejected,
  SemanticTargetUnavailable,
  type SemanticAdmission,
  type SemanticTerminal,
} from '../semantic/command.ts';
import { modelGenerationHeadGuard } from '../semantic/generation-guard.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import {
  DATASET,
  GRAPHS,
  ID,
  RV,
  iri,
  lit,
  IdempotencyConflict,
  PendingActivation,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import {
  readAuthoredRatingQuestion,
  questionContextPattern,
} from './question-presentation-context.ts';
import {
  checkedQuestionPresentation,
  QUESTION_PRESENTATION_FAMILY,
  QUESTION_PRESENTATION_PROFILE,
  QUESTION_PRESENTATION_PROFILE_IRI,
  QUESTION_PRESENTATION_COST,
  questionPresentationAction,
  questionPresentationDigest,
  questionPresentationScope,
  type QuestionPresentationState,
} from './question-presentation-schema.ts';
import { canonicalLanguage } from '../display-language/select.ts';

/** One indexed Context/language tuple, including a draft for an authorized
 * editor. A public display selection cannot recover an unreviewed head. */
export async function findQuestionPresentation(env: WorkActivationEnvironment, context: string, language: string) {
  checkedNativeIri(context);
  const normalized = canonicalLanguage(language);
  if (!normalized) throw new SemanticChangeRejected('invalid', 'Presentation language is invalid');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?component a rv:RatingQuestionPresentation ;
      rv:presentationContext ${iri(context)} ; rv:presentationLanguage ${lit(normalized)} ; rv:questionPresentationHead ?head .
      FILTER NOT EXISTS { ?component rv:protectionHead ?protection } }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RatingQuestionPresentationRevision, rv:RevisionAnchor ;
      rv:component ?component ; rv:presentationContext ${iri(context)} ; rv:presentationLanguage ${lit(normalized)} .
      FILTER NOT EXISTS { ?head a rv:ErasedRevision } }
  } LIMIT ${QUESTION_PRESENTATION_COST.lookupRows}`)).results?.bindings ?? [];
  if (rows.length > 1) throw new RevisionCorrupt('Rating question presentation tuple is ambiguous');
  return rows[0]?.component ? { component: rows[0].component.value, revision: rows[0].head!.value } : null;
}

export interface QuestionPresentationIntent {
  admission: SemanticAdmission;
  target?: string;
  expectedHead: string | null;
  state: QuestionPresentationState;
}
export interface QuestionPresentationResult {
  component: string;
  revision: string;
  predecessor: string | null;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}
export interface QuestionPresentationRead {
  component: string;
  revision: string;
  predecessor: string | null;
  state: QuestionPresentationState;
  modelGeneration: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

function dimensions(state: QuestionPresentationState) {
  return [
    `<${RV}presentationContext> ${iri(state.context)}`,
    `<${RV}presentationLanguage> ${lit(state.language)}^^<http://www.w3.org/2001/XMLSchema#string>`,
  ];
}
function currentTriples(state: QuestionPresentationState, head: string) {
  return [
    `<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}RatingQuestionPresentation>`,
    `<${RV}questionPresentationHead> ${iri(head)}`,
    ...dimensions(state),
  ];
}
function tuple(state: QuestionPresentationState, subject: string) {
  return `${subject} a rv:RatingQuestionPresentation ; rv:presentationContext ${iri(state.context)} ;
    rv:presentationLanguage ${lit(state.language)} .`;
}
export async function readQuestionPresentationRevision(
  env: WorkActivationEnvironment,
  component: string,
  revision: string,
): Promise<QuestionPresentationRead | null> {
  checkedNativeIri(component);
  checkedNativeIri(revision);
  const rows =
    (
      await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?manifest ?predecessor ?generation ?epoch ?sequence ?context ?language ?question ?source ?licence ?review WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RatingQuestionPresentationRevision, rv:RevisionAnchor ;
      rv:component ${iri(component)} ; rv:manifest ?manifest ; rv:modelGeneration ?generation ;
      rv:modelRevision ${iri(QUESTION_PRESENTATION_PROFILE_IRI)} ; rv:shapeRevision ${iri(QUESTION_PRESENTATION_PROFILE_IRI)} ;
      rv:dataEpoch ?epoch ; rv:sequence ?sequence ; rv:presentationContext ?context ; rv:presentationLanguage ?language ;
      rv:question ?question ; rv:source ?source ; rv:licence ?licence ; rv:reviewStatus ?review .
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
      FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } } } LIMIT 2`)
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1)
    throw new RevisionCorrupt('Rating question presentation revision is ambiguous');
  const row = rows[0]!;
  let state: QuestionPresentationState;
  try {
    state = checkedQuestionPresentation(
      await readComponent(env, row.manifest!.value, component, QUESTION_PRESENTATION_PROFILE_IRI),
    );
  } catch (error) {
    if (error instanceof SemanticChangeRejected)
      throw new RevisionCorrupt('Rating question presentation manifest is invalid');
    throw error;
  }
  if (
    row.context?.value !== state.context ||
    row.language?.value !== state.language ||
    row.question?.value !== state.question ||
    row.question['xml:lang']?.toLowerCase() !== state.language.toLowerCase() ||
    row.source?.value !== state.source ||
    row.licence?.value !== state.licence ||
    row.review?.value !== `${RV}${state.reviewStatus === 'reviewed' ? 'Reviewed' : 'Draft'}`
  ) {
    throw new RevisionCorrupt('Rating question presentation differs from its manifest');
  }
  return {
    component,
    revision,
    predecessor: row.predecessor?.value ?? null,
    state,
    modelGeneration: row.generation!.value,
    sourcePosition: {
      datasetId: 'product',
      dataEpoch: row.epoch!.value,
      sequence: row.sequence!.value,
    },
  };
}
export async function readQuestionPresentationCurrent(
  env: WorkActivationEnvironment,
  component: string,
) {
  checkedNativeIri(component);
  const rows =
    (
      await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(component)} a rv:RatingQuestionPresentation ; rv:questionPresentationHead ?head .
    FILTER NOT EXISTS { ${iri(component)} rv:protectionHead ?protection } } } LIMIT 2`)
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1)
    throw new RevisionCorrupt('Rating question presentation head is ambiguous');
  const read = await readQuestionPresentationRevision(env, component, rows[0]!.head!.value);
  if (!read) throw new RevisionCorrupt('Rating question presentation has no retained revision');
  const graph = await env.fuseki.query(`SELECT ?p ?o WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(component)} ?p ?o } } LIMIT 5`);
  const actual = new Set(
    (graph.results?.bindings ?? []).map((row) => `<${row.p!.value}> ${term(row.o!)}`),
  );
  const expected = new Set(currentTriples(read.state, read.revision));
  if (actual.size !== expected.size || [...expected].some((item) => !actual.has(item))) {
    throw new RevisionCorrupt(
      'Rating question presentation projection differs from its retained head',
    );
  }
  return read;
}
export const readQuestionPresentationTerminal = (env: WorkActivationEnvironment, id: string) =>
  readSemanticTerminal(env, familyReceiptIri(id, QUESTION_PRESENTATION_FAMILY));
function result(
  terminal: SemanticTerminal,
  intent: QuestionPresentationIntent,
  replayed: boolean,
): QuestionPresentationResult {
  const checked = checkedSemanticTerminal(
    terminal,
    intent.admission,
    intent.admission.requestDigest,
  );
  if (
    (intent.target !== undefined && checked.component !== intent.target) ||
    (checked.expectedHead ?? null) !== intent.expectedHead
  )
    throw new IdempotencyConflict('Rating question presentation receipt targets another intent');
  return {
    component: checked.component!,
    revision: checked.revision!,
    predecessor: checked.expectedHead ?? null,
    receipt: checked.receipt,
    dataEpoch: checked.dataEpoch,
    sequence: checked.sequence,
    replayed,
  };
}

/** One tuple and expected-head guarded command; Context and rating graphs are read-only dependencies. */
export async function changeQuestionPresentation(
  env: WorkActivationEnvironment,
  intent: QuestionPresentationIntent,
) {
  const state = checkedQuestionPresentation(intent.state);
  const digest = questionPresentationDigest(intent.target, intent.expectedHead, state);
  if (
    intent.admission.action !== questionPresentationAction(state) ||
    intent.admission.scope !== questionPresentationScope(state.context)
  ) {
    throw new IdempotencyConflict('Rating question presentation admission differs');
  }
  const receipt = familyReceiptIri(intent.admission.id, QUESTION_PRESENTATION_FAMILY);
  const existing = await assertSemanticDispatchable(env, intent.admission, receipt, digest);
  if (existing) return result(existing, intent, true);
  const authored = await readAuthoredRatingQuestion(env, state.context);
  if (state.language === authored.language)
    throw new SemanticChangeRejected(
      'invalid',
      'The authored question language cannot be overwritten',
    );
  const current = intent.target ? await readQuestionPresentationCurrent(env, intent.target) : null;
  if (intent.target && !current)
    throw new SemanticTargetUnavailable('Rating question presentation is unavailable');
  if (
    current &&
    (current.state.context !== state.context || current.state.language !== state.language)
  ) {
    throw new SemanticChangeRejected('invalid', 'A presentation keeps its Context and language');
  }
  const reject = async (reason: Parameters<typeof sealSemanticRejection>[4], condition: string) => {
    const terminal = await sealSemanticRejection(
      env,
      receipt,
      digest,
      intent.admission,
      reason,
      condition,
    );
    if (!terminal)
      throw new PendingActivation('Rating question presentation rejection is not sealed');
    return result(terminal, intent, false);
  };
  const stale = `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
    ${iri(intent.target ?? state.context)} rv:questionPresentationHead ${iri(intent.expectedHead ?? authored.revision)} } }`;
  if (current && current.revision !== intent.expectedHead) return reject('stale-head', stale);
  const generation = await ensureModelGeneration(env);
  const component = intent.target ?? `${ID}${Bun.randomUUIDv7()}`,
    revision = `${ID}${Bun.randomUUIDv7()}`,
    operation = `${ID}${Bun.randomUUIDv7()}`;
  const manifest = await sealComponentState(
    env,
    component,
    QUESTION_PRESENTATION_PROFILE_IRI,
    state,
  );
  const old = current ? currentTriples(current.state, current.revision) : [],
    next = currentTriples(state, revision);
  const validations = await profileValidations(
    env.fuseki,
    QUESTION_PRESENTATION_PROFILE,
    [
      {
        shape: `${QUESTION_PRESENTATION_PROFILE_IRI}/presentation-shape`,
        focus: [component],
        graphs: [GRAPHS.current, GRAPHS.revisions],
      },
      {
        shape: `${QUESTION_PRESENTATION_PROFILE_IRI}/revision-shape`,
        focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions],
      },
    ],
    { presentation: component, revision, context: state.context, language: state.language },
  );
  const contextGuard = `${questionContextPattern(state.context)}
    FILTER(?contextHead = ${iri(authored.revision)} && ?questionOwner = ${iri(authored.owner)}
      && ?authoredQuestion = ${lit(authored.question)}@${authored.language})`;
  await sendSemanticWrite(env, {
    receipt,
    digest,
    admission: intent.admission,
    validations,
    event: 'RatingQuestionPresentationChangedEvent',
    deletes: old.length
      ? `GRAPH ${iri(GRAPHS.current)} { ${old.map((triple) => `${iri(component)} ${triple} .`).join('\n')} }`
      : '',
    inserts: `GRAPH ${iri(GRAPHS.current)} { ${next.map((triple) => `${iri(component)} ${triple} .`).join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RatingQuestionPresentationRevision, rv:RevisionAnchor ;
        rv:component ${iri(component)} ; ${current ? `rv:predecessor ${iri(current.revision)} ;` : ''}
        ${dimensions(state).join(' ; ')} ; rv:question ${lit(state.question)}@${state.language} ;
        rv:source ${lit(state.source)} ; rv:licence ${lit(state.licence)} ;
        rv:reviewStatus rv:${state.reviewStatus === 'reviewed' ? 'Reviewed' : 'Draft'} ;
        rv:operation ${iri(operation)} ; rv:manifest ${iri(manifest)} ; rv:modelGeneration ${iri(generation)} ;
        rv:modelRevision ${iri(QUESTION_PRESENTATION_PROFILE_IRI)} ; rv:shapeRevision ${iri(QUESTION_PRESENTATION_PROFILE_IRI)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${modelGenerationHeadGuard(generation)} ${contextGuard}
      ${
        current
          ? `GRAPH ${iri(GRAPHS.current)} { ${old.map((triple) => `${iri(component)} ${triple} .`).join('\n')} }`
          : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${tuple(state, '?other')} } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(component)} ?anyP ?anyO } }`
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${tuple(state, '?duplicate')} FILTER(?duplicate != ${iri(component)}) } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }`,
    receiptFields: `rv:operation ${iri(operation)} ; rv:component ${iri(component)} ; rv:revision ${iri(revision)} ;
      ${current ? `rv:expectedHead ${iri(current.revision)} ;` : ''}`,
  });
  const committed = await readSemanticTerminal(env, receipt);
  if (committed) return result(committed, intent, committed.revision !== revision);
  const generationChanged = await sealSemanticRejection(
    env,
    receipt,
    digest,
    intent.admission,
    'generation-changed',
    `FILTER NOT EXISTS { ${modelGenerationHeadGuard(generation)} }`,
  );
  if (generationChanged) return result(generationChanged, intent, false);
  const unavailable = await sealSemanticRejection(
    env,
    receipt,
    digest,
    intent.admission,
    'unavailable-reference',
    `FILTER NOT EXISTS { ${contextGuard} }`,
  );
  if (unavailable) return result(unavailable, intent, false);
  return reject(
    'stale-head',
    current ? stale : `GRAPH ${iri(GRAPHS.current)} { ${tuple(state, '?other')} }`,
  );
}
