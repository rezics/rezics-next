import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readStatement } from '../statement/read.ts';
import { activeDirectDefinitionsGuard } from './definition-state.ts';
import { ContextCommandUnavailable, InvalidContextCommand, checkedCommandReceipt, commitCommand,
  readCommandReceipt, term, type ContextCommandReceipt } from './command.ts';
import { ContextNotFound, readContextRevision } from './read.ts';
import { GLOBAL_SEMANTIC_CONTEXT } from './schema.ts';

export const CONTEXT_EQUIVALENCE_FAMILY = 'context-definition-equivalence-v1';
export const CONTEXT_EQUIVALENCE_PROFILE = 'https://rezics.com/definition/context-definition-equivalence-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const mappingId = /^urn:rezics:context-equivalence:[0-9a-f]{64}$/;

export interface EquivalenceUse { target: string; definition: string }
export interface ReviewDefinitionEquivalenceInput {
  context: string;
  semanticRevision: string;
  relation: string;
  left: EquivalenceUse;
  right: EquivalenceUse;
  actingSubject: string;
}

/** Symmetric pair in one exact Context revision; no owl:sameAs or identity merge. */
export function equivalenceRequest(input: ReviewDefinitionEquivalenceInput) {
  if ((input.context !== GLOBAL_SEMANTIC_CONTEXT && !native.test(input.context))
    || !native.test(input.semanticRevision) || !native.test(input.actingSubject)) {
    throw new InvalidContextCommand('invalid Context equivalence target');
  }
  term(input.relation);
  term(input.left.target); term(input.left.definition);
  term(input.right.target); term(input.right.definition);
  if (input.left.target === input.right.target) throw new InvalidContextCommand('equivalence needs distinct targets');
  const [left, right] = [input.left, input.right].sort((a, b) =>
    a.target.localeCompare(b.target) || a.definition.localeCompare(b.definition));
  const mapping = `urn:rezics:context-equivalence:${hash(JSON.stringify([
    CONTEXT_EQUIVALENCE_FAMILY, input.context, input.semanticRevision, input.relation, left, right]))}`;
  return { action: 'context.equivalence.review', scope: `context:change:${input.context}`,
    mapping, left: left!, right: right!, digest: hash(JSON.stringify([mapping, input.actingSubject])) };
}

export async function reviewDefinitionEquivalence(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: ReviewDefinitionEquivalenceInput): Promise<ContextCommandReceipt> {
  const request = equivalenceRequest(input);
  const existing = await readCommandReceipt(env, admission.id, CONTEXT_EQUIVALENCE_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const manifest = prepareComponent(env.objectDirectory, request.mapping, {
    revision, context: input.context, semanticRevision: input.semanticRevision,
    relation: input.relation, left: request.left, right: request.right,
    reviewedBy: input.actingSubject }, CONTEXT_EQUIVALENCE_PROFILE);
  const validations = await profileValidations(env.fuseki, 'context-definition-equivalence-v1', [
    { shape: `${CONTEXT_EQUIVALENCE_PROFILE}/control-shape`, focus: [request.mapping],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${CONTEXT_EQUIVALENCE_PROFILE}/revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const committed = await commitCommand(env, admission, { family: CONTEXT_EQUIVALENCE_FAMILY,
    digest: request.digest, validations, operation, component: request.mapping, revision, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(request.mapping)} a rv:ContextDefinitionEquivalence ;
        rv:context ${iri(input.context)} ; rv:semanticRevision ${iri(input.semanticRevision)} ;
        rv:equivalenceHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ContextDefinitionEquivalenceRevision, rv:RevisionAnchor ;
        rv:component ${iri(request.mapping)} ; rv:context ${iri(input.context)} ;
        rv:semanticRevision ${iri(input.semanticRevision)} ; rv:entryRelation ${term(input.relation)} ;
        rv:leftTarget ${term(request.left.target)} ; rv:rightTarget ${term(request.right.target)} ;
        rv:leftDefinition ${term(request.left.definition)} ; rv:rightDefinition ${term(request.right.definition)} ;
        rv:reviewedBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:modelRevision ${iri(CONTEXT_EQUIVALENCE_PROFILE)} ;
        rv:shapeRevision ${iri(CONTEXT_EQUIVALENCE_PROFILE)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:semanticHead ${iri(input.semanticRevision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.semanticRevision)} a rv:ContextSemanticRevision ;
        rv:component ${iri(input.context)} ; rv:entry ?leftEntry, ?rightEntry .
        ?leftEntry rv:entryTarget ${term(request.left.target)} ; rv:entryRelation ${term(input.relation)} ;
          rv:interpretationDefinition ${term(request.left.definition)} .
        ?rightEntry rv:entryTarget ${term(request.right.target)} ; rv:entryRelation ${term(input.relation)} ;
          rv:interpretationDefinition ${term(request.right.definition)} . }
      ${activeDirectDefinitionsGuard([request.left.definition, request.right.definition])}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(request.mapping)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  throw new ContextCommandUnavailable('Context equivalence requires current reviewed exact entries');
}

export async function readDefinitionEquivalence(env: WorkActivationEnvironment, mapping: string,
  canReadPrivate: (context: string) => Promise<boolean>) {
  if (!mappingId.test(mapping)) throw new InvalidContextCommand('invalid Context equivalence IRI');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?semantic ?head ?manifest ?relation ?leftTarget ?rightTarget
      ?leftDefinition ?rightDefinition ?reviewedBy ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
    GRAPH ${iri(GRAPHS.current)} { ${iri(mapping)} a rv:ContextDefinitionEquivalence ;
      rv:context ?context ; rv:semanticRevision ?semantic ; rv:equivalenceHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ContextDefinitionEquivalenceRevision ;
      rv:component ${iri(mapping)} ; rv:manifest ?manifest ; rv:context ?context ;
      rv:semanticRevision ?semantic ; rv:entryRelation ?relation ; rv:leftTarget ?leftTarget ;
      rv:rightTarget ?rightTarget ; rv:leftDefinition ?leftDefinition ;
      rv:rightDefinition ?rightDefinition ; rv:reviewedBy ?reviewedBy . }
  }`)).results?.bindings ?? [];
  if (!rows.length) throw new ContextNotFound('equivalence is unavailable');
  const row = rows[0]!;
  if (rows.length !== 1 || !row.context || !row.semantic || !row.head || !row.manifest) {
    throw new ContextCommandUnavailable('equivalence read is incomplete');
  }
  await readContextRevision(env, row.context.value, row.semantic.value, canReadPrivate);
  const payload = readComponentState(env.objectDirectory, row.manifest.value, mapping, CONTEXT_EQUIVALENCE_PROFILE);
  const values = ['relation', 'leftTarget', 'rightTarget', 'leftDefinition', 'rightDefinition', 'reviewedBy'] as const;
  if (payload.revision !== row.head.value || payload.context !== row.context.value
    || payload.semanticRevision !== row.semantic.value || values.some(key => !row[key])
    || payload.relation !== row.relation?.value || payload.reviewedBy !== row.reviewedBy?.value
    || (payload.left as EquivalenceUse)?.target !== row.leftTarget?.value
    || (payload.right as EquivalenceUse)?.target !== row.rightTarget?.value
    || (payload.left as EquivalenceUse)?.definition !== row.leftDefinition?.value
    || (payload.right as EquivalenceUse)?.definition !== row.rightDefinition?.value) {
    throw new ContextCommandUnavailable('equivalence manifest differs from graph');
  }
  return { profile: 'context-definition-equivalence-v1' as const, mapping,
    revision: row.head.value, context: row.context.value, semanticRevision: row.semantic.value,
    relation: payload.relation as string, left: payload.left as EquivalenceUse,
    right: payload.right as EquivalenceUse, reviewedBy: payload.reviewedBy as string,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}

export async function compareStatementMeanings(env: WorkActivationEnvironment, left: string, right: string,
  mapping: string | null, canReadPrivate: (context: string) => Promise<boolean>) {
  if (!native.test(left) || !native.test(right)) throw new InvalidContextCommand('invalid Statement comparison');
  const [a, b] = await Promise.all([readStatement(env, left, canReadPrivate),
    readStatement(env, right, canReadPrivate)]);
  if (a.meaningBasis.state === 'unavailable' || b.meaningBasis.state === 'unavailable') {
    return { profile: 'context-meaning-comparison-v1' as const, state: 'unavailable' as const };
  }
  if (a.meaningKey === b.meaningKey) {
    return { profile: 'context-meaning-comparison-v1' as const, state: 'equivalent' as const,
      basis: 'exact' as const, left, right, mapping: null };
  }
  if (!mapping) return { profile: 'context-meaning-comparison-v1' as const,
    state: 'distinct' as const, left, right, mapping: null };
  const reviewed = await readDefinitionEquivalence(env, mapping, canReadPrivate);
  const sameUse = a.subject === b.subject && a.predicate === b.predicate
    && a.predicate === reviewed.relation && a.relationDefinition === b.relationDefinition
    && JSON.stringify(a.applicability) === JSON.stringify(b.applicability)
    && a.meaningBasis.state === 'readable' && b.meaningBasis.state === 'readable'
    && a.meaningBasis.context === reviewed.context && b.meaningBasis.context === reviewed.context
    && a.meaningBasis.semanticRevision === reviewed.semanticRevision
    && b.meaningBasis.semanticRevision === reviewed.semanticRevision
    && a.value.kind === 'resource' && b.value.kind === 'resource';
  const matches = sameUse && ([
    [a, b, reviewed.left, reviewed.right], [a, b, reviewed.right, reviewed.left],
  ] as const).some(([source, target, sourceUse, targetUse]) =>
    source.value.kind === 'resource' && target.value.kind === 'resource'
    && source.value.iri === sourceUse.target && target.value.iri === targetUse.target
    && source.meaningBasis.state === 'readable' && target.meaningBasis.state === 'readable'
    && source.meaningBasis.interpretationDefinitions.length === 1
    && target.meaningBasis.interpretationDefinitions.length === 1
    && source.meaningBasis.interpretationDefinitions[0] === sourceUse.definition
    && target.meaningBasis.interpretationDefinitions[0] === targetUse.definition);
  return { profile: 'context-meaning-comparison-v1' as const,
    state: matches ? 'equivalent' as const : 'distinct' as const,
    left, right, mapping: matches ? reviewed.mapping : null,
    ...(matches ? { basis: 'reviewed-mapping' as const } : {}) };
}
