import { profileValidations } from '../../infrastructure/profile.ts';
import { readExactDefinition } from '../relation/change.ts';
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
  IdempotencyConflict,
  PendingActivation,
  RV,
  iri,
  lit,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import {
  checkedPresentation,
  PRESENTATION_FAMILY,
  PRESENTATION_PROFILE,
  PRESENTATION_PROFILE_IRI,
  presentationDigest,
  presentationAction,
  type PresentationState,
} from './schema.ts';

export interface PresentationIntent {
  admission: SemanticAdmission;
  target?: string;
  expectedHead: string | null;
  state: PresentationState;
}
export interface PresentationResult {
  component: string;
  revision: string;
  predecessor: string | null;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}
export interface PresentationRead {
  component: string;
  revision: string;
  predecessor: string | null;
  state: PresentationState;
  modelGeneration: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
function dimensions(state: PresentationState): string[] {
  const string = (value: string) => `${lit(value)}^^<http://www.w3.org/2001/XMLSchema#string>`;
  return [
    `<${RV}presentationDefinition> ${iri(state.definition)}`,
    `<${RV}meaningRevision> ${iri(state.meaningRevision)}`,
    `<${RV}fromRole> ${string(state.fromRole)}`,
    `<${RV}toRole> ${string(state.toRole)}`,
    `<${RV}presentationLanguage> ${string(state.language)}`,
  ];
}
function currentTriples(state: PresentationState, head: string): string[] {
  return [
    `<${type}> <${RV}DefinitionPresentation>`,
    `<${RV}presentationHead> ${iri(head)}`,
    ...dimensions(state),
  ];
}
function tuple(state: PresentationState, subject: string): string {
  return `${subject} a rv:DefinitionPresentation ; rv:presentationDefinition ${iri(state.definition)} ;
    rv:meaningRevision ${iri(state.meaningRevision)} ;
    rv:fromRole ${lit(state.fromRole)} ; rv:toRole ${lit(state.toRole)} ; rv:presentationLanguage ${lit(state.language)} .`;
}

/** Exact history survives a meaning change and never substitutes a newer presentation. */
export async function readPresentationRevision(
  env: WorkActivationEnvironment,
  component: string,
  revision: string,
): Promise<PresentationRead | null> {
  checkedNativeIri(component);
  checkedNativeIri(revision);
  const result = await env.fuseki
    .query(`PREFIX rv: <${RV}> SELECT ?manifest ?predecessor ?generation ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:PresentationRevision ; rv:component ${iri(component)} ;
      rv:manifest ?manifest ; rv:modelGeneration ?generation ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor } } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('presentation revision is ambiguous');
  const row = rows[0]!;
  let state: PresentationState;
  try {
    state = checkedPresentation(
      await readComponent(env, row.manifest!.value, component, PRESENTATION_PROFILE_IRI),
    );
  } catch (error) {
    if (error instanceof SemanticChangeRejected)
      throw new RevisionCorrupt('presentation manifest is invalid');
    throw error;
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

export async function readPresentationCurrent(
  env: WorkActivationEnvironment,
  component: string,
): Promise<PresentationRead | null> {
  checkedNativeIri(component);
  const result = await env.fuseki
    .query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(component)} a rv:DefinitionPresentation ; rv:presentationHead ?head } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('presentation head is ambiguous');
  const read = await readPresentationRevision(env, component, rows[0]!.head!.value);
  if (!read) throw new RevisionCorrupt('presentation head has no retained revision');
  const graph = await env.fuseki.query(
    `SELECT ?p ?o WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(component)} ?p ?o } } LIMIT 9`,
  );
  const actual = new Set(
    (graph.results?.bindings ?? []).map((row) => `<${row.p!.value}> ${term(row.o!)}`),
  );
  const expected = new Set(currentTriples(read.state, read.revision));
  if (actual.size !== expected.size || [...expected].some((item) => !actual.has(item))) {
    throw new RevisionCorrupt('presentation projection differs from its retained head');
  }
  return read;
}

export const readPresentationTerminal = (env: WorkActivationEnvironment, admissionId: string) =>
  readSemanticTerminal(env, familyReceiptIri(admissionId, PRESENTATION_FAMILY));

function result(
  terminal: SemanticTerminal,
  intent: PresentationIntent,
  replayed: boolean,
): PresentationResult {
  const checked = checkedSemanticTerminal(
    terminal,
    intent.admission,
    intent.admission.requestDigest,
  );
  if (
    (intent.target !== undefined && checked.component !== intent.target) ||
    (checked.expectedHead ?? null) !== intent.expectedHead
  ) {
    throw new IdempotencyConflict('presentation receipt targets another intent');
  }
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

/** One expected-head guarded command; cost grows with this language row, never the other vocabulary. */
export async function changePresentation(
  env: WorkActivationEnvironment,
  intent: PresentationIntent,
): Promise<PresentationResult> {
  const state = checkedPresentation(intent.state);
  const digest = presentationDigest(intent.target, intent.expectedHead, state);
  if (
    intent.admission.action !== presentationAction(state) ||
    intent.admission.scope !== `semantic:edit:${state.definition}`
  )
    throw new IdempotencyConflict('presentation admission differs');
  const receipt = familyReceiptIri(intent.admission.id, PRESENTATION_FAMILY);
  const existing = await assertSemanticDispatchable(env, intent.admission, receipt, digest);
  if (existing) return result(existing, intent, true);
  const definition = await readExactDefinition(env, state.meaningRevision);
  if (!definition || definition.definition !== state.definition) {
    throw new SemanticChangeRejected(
      'unavailable-reference',
      'presentation meaning is unavailable',
    );
  }
  if (
    ![state.fromRole, state.toRole].every((key) => Object.values(definition.roleKeys).includes(key))
  ) {
    throw new SemanticChangeRejected(
      'invalid',
      'viewing direction is outside the declared meaning',
    );
  }
  const current = intent.target ? await readPresentationCurrent(env, intent.target) : null;
  if (intent.target && !current) throw new SemanticTargetUnavailable('presentation is unavailable');
  if (
    current &&
    ['definition', 'meaningRevision', 'fromRole', 'toRole', 'language'].some(
      (key) =>
        current.state[key as keyof PresentationState] !== state[key as keyof PresentationState],
    )
  ) {
    throw new SemanticChangeRejected(
      'invalid',
      'a presentation keeps its exact meaning, direction and language',
    );
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
    if (!terminal) throw new PendingActivation('presentation rejection is not sealed');
    return result(terminal, intent, false);
  };
  const stale = `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.target ?? state.definition)} rv:presentationHead ?now }
    FILTER(?now != ${iri(intent.expectedHead ?? state.meaningRevision)})`;
  if (current && current.revision !== intent.expectedHead) return reject('stale-head', stale);
  const generation = await ensureModelGeneration(env);
  const component = intent.target ?? `${ID}${Bun.randomUUIDv7()}`;
  const revision = `${ID}${Bun.randomUUIDv7()}`,
    operation = `${ID}${Bun.randomUUIDv7()}`;
  const manifest = await sealComponentState(env, component, PRESENTATION_PROFILE_IRI, state);
  const old = current ? currentTriples(current.state, current.revision) : [];
  const next = currentTriples(state, revision);
  const binding = {
    presentation: component,
    revision,
    definition: state.definition,
    meaningRevision: state.meaningRevision,
    fromRole: state.fromRole,
    toRole: state.toRole,
    language: state.language,
  };
  const validations = await profileValidations(
    env.fuseki,
    PRESENTATION_PROFILE,
    ['presentation', 'revision'].map((role) => ({
      shape: `${PRESENTATION_PROFILE_IRI}/${role}-shape`,
      focus: [binding[role as 'presentation' | 'revision']],
      graphs: [GRAPHS.current, GRAPHS.revisions],
    })),
    binding,
  );
  await sendSemanticWrite(env, {
    receipt,
    digest,
    admission: intent.admission,
    validations,
    event: 'LexiconPresentationChangedEvent',
    deletes: old.length
      ? `GRAPH ${iri(GRAPHS.current)} { ${old.map((triple) => `${iri(component)} ${triple} .`).join('\n')} }`
      : '',
    inserts: `GRAPH ${iri(GRAPHS.current)} { ${next.map((triple) => `${iri(component)} ${triple} .`).join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:PresentationRevision, rv:RevisionAnchor ;
        rv:component ${iri(component)} ; ${current ? `rv:predecessor ${iri(current.revision)} ;` : ''}
        ${dimensions(state).join(' ; ')} ; rv:noun ${lit(state.noun)} ; rv:heading ${lit(state.heading)} ;
        rv:pluralForms ${lit(JSON.stringify(state.plurals))} ; rv:grammaticalForms ${lit(JSON.stringify(state.grammaticalForms))} ;
        rv:source ${lit(state.source)} ; rv:licence ${lit(state.licence)} ;
        rv:reviewStatus rv:${state.reviewStatus === 'reviewed' ? 'Reviewed' : 'Draft'} ;
        rv:operation ${iri(operation)} ; rv:manifest ${iri(manifest)} ; rv:modelGeneration ${iri(generation)} ;
        rv:modelRevision ${iri(PRESENTATION_PROFILE_IRI)} ; rv:shapeRevision ${iri(PRESENTATION_PROFILE_IRI)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `      ${modelGenerationHeadGuard(generation)}
      GRAPH ${iri(GRAPHS.current)} { ${iri(state.definition)} rv:definitionHead ${iri(state.meaningRevision)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(state.meaningRevision)} rv:lifecycle rv:Active }
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
  const retired = await sealSemanticRejection(
    env,
    receipt,
    digest,
    intent.admission,
    'retired-definition',
    `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(state.definition)} rv:definitionHead ${iri(state.meaningRevision)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(state.meaningRevision)} rv:lifecycle rv:Active } }`,
  );
  if (retired) return result(retired, intent, false);
  return reject(
    'stale-head',
    current ? stale : `GRAPH ${iri(GRAPHS.current)} { ${tuple(state, '?other')} }`,
  );
}
