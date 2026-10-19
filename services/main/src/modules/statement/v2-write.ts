import type { RegisteredAdmission } from '../access/admission.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { activeDirectDefinitionsGuard } from '../context/definition-state.ts';
import { checkedCommandReceipt, commandReceiptIri, commitCommand, ContextCommandUnavailable,
  readCommandReceipt, sealCommandTerminal, term, type ContextCommandReceipt } from '../context/command.ts';
import type { InterpretationSpeaker } from '../context/interpretation.ts';
import { ensureModelGeneration, sealComponentState } from '../semantic/command.ts';
import { valueValidations } from '../semantic/change.ts';
import { modelGenerationHeadGuard } from '../semantic/generation-guard.ts';
import { semanticValueRdf, type SemanticValue } from '../semantic/value.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { Participant } from '../relation/schema.ts';
import type { ReferenceDisclosure } from '../target/disclosed-references.ts';
import { recordStatementRequest, speakerIri, statementInterpretation, type RecordStatementInput } from './graph.ts';
import { normalizeCoveredStatementApplicability, normalizeStatementSubject, type StatementTargetReader } from './projection.ts';
import { statementQualificationKeyTuple, statementQualificationTriples, validateStatementDefinitions,
  validateStatementInterpretationDefinition } from './qualification.ts';
import { STATEMENT_FAMILIES } from './receipt-family.ts';
import { STATEMENT_AUTHORITY } from './schema.ts';
import { resolveStatementCoverage } from './v2-coverage.ts';
import type { RelationAttributionVerifier } from '../relation/attribution.ts';
import { checkedStatementCoverage, checkedStatementMeaningV2, checkedStatementParticipant, statementCoverageRejected,
  statementMeaningKeyV2, statementNativeId, STATEMENT_V2_PROFILE, type StatementCoverage,
  type StatementMeaningV2 } from './v2-schema.ts';

export interface RecordStatementV2Input extends Omit<RecordStatementInput, 'subject' | 'value' | 'wikiPublicationWork'> {
  profile: 'statement-v2'; subject: Participant; value: SemanticValue; coverage: StatementCoverage;
}

/** The admitted request binds the full tagged values and exact coverage; it never reuses the V1 digest. */
export function checkedRecordStatementV2(input: RecordStatementV2Input): RecordStatementV2Input {
  const allowed = ['profile', 'speaker', 'subject', 'predicate', 'relationDefinition', 'value', 'applicability',
    'interpretation', 'expectedInterpretation', 'qualification', 'evidence', 'actingSubject', 'coverage'];
  if (!input || input.profile !== 'statement-v2' || Object.keys(input).some(key => !allowed.includes(key))
    || !statementNativeId(input.actingSubject) || !statementNativeId(input.relationDefinition)
    || !input.speaker || !['personal', 'realm'].includes(input.speaker.kind)
    || Object.keys(input.speaker).some(key => !['kind', 'realm'].includes(key))
    || input.speaker.kind === 'personal' && 'realm' in input.speaker
    || input.speaker.kind === 'realm' && !statementNativeId(input.speaker.realm)
    || !input.interpretation || !['selected', 'explicit', 'definition'].includes(input.interpretation.kind)
    || Object.keys(input.interpretation).some(key => !({ selected: ['kind'], explicit: ['kind', 'context', 'semanticRevision'],
      definition: ['kind', 'definition'] }[input.interpretation.kind]).includes(key))
    || !Array.isArray(input.evidence)) return statementCoverageRejected('invalid authored Statement request');
  // Reuse the established speaker, interpretation, evidence and reference bounds without translating a V2 value.
  recordStatementRequest({ ...input, subject: input.actingSubject, value: { kind: 'no-value' } });
  if (input.expectedInterpretation && (Object.keys(input.expectedInterpretation).some(key => !['semanticRevision', 'definition'].includes(key))
    || input.expectedInterpretation.semanticRevision !== null && !statementNativeId(input.expectedInterpretation.semanticRevision)
    || input.expectedInterpretation.definition !== null && !statementNativeId(input.expectedInterpretation.definition))) {
    return statementCoverageRejected('invalid exact interpretation expectation');
  }
  const meaning = checkedStatementMeaningV2({ ...input, interpretationDefinitions: [] });
  return { profile: 'statement-v2', speaker: input.speaker, subject: meaning.subject, value: meaning.value,
    predicate: meaning.predicate, relationDefinition: meaning.relationDefinition, coverage: meaning.coverage,
    applicability: meaning.applicability, interpretation: input.interpretation,
    ...(input.expectedInterpretation ? { expectedInterpretation: input.expectedInterpretation } : {}),
    ...(meaning.qualification ? { qualification: meaning.qualification } : {}),
    evidence: [...input.evidence].sort(), actingSubject: input.actingSubject };
}

export function recordStatementV2Request(raw: RecordStatementV2Input) {
  const input = checkedRecordStatementV2(raw);
  return { ...STATEMENT_AUTHORITY.speak(speakerIri(input)), digest: hash(JSON.stringify([
    'statement-record-v2', input.speaker, input.subject, input.predicate, input.relationDefinition, input.value,
    input.coverage, input.applicability, input.interpretation, input.expectedInterpretation ?? null,
    input.qualification ? statementQualificationKeyTuple(input.qualification) : null, input.evidence, input.actingSubject,
  ])) };
}

export function statementCoverageTriples(coverage: StatementCoverage): string {
  return coverage.kind === 'subject-global' ? 'rv:statementCoverage rv:SubjectGlobalCoverage ;'
    : `rv:statementCoverage rv:${coverage.kind === 'participation' ? 'ParticipationCoverage' : 'OccurrenceCoverage'} ;
      rv:coveredOccurrence ${iri(coverage.occurrence)} ; rv:coveredOccurrenceRevision ${iri(coverage.occurrenceRevision)} ;
      ${coverage.kind === 'participation' ? `rv:coveredParticipation ${iri(coverage.participation)} ;` : ''}`;
}

/** Real graph-owner command: immutable manifests, existing Access admission, receipts, decisions and outbox family. */
export async function recordStatementV2(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  raw: RecordStatementV2Input, speaker: InterpretationSpeaker,
  canRead: (reference: string) => Promise<boolean>, readTargets?: StatementTargetReader,
  canReadDefinition?: (definition: string) => Promise<boolean>,
  beforeCommit?: (statement: string, receipt: string) => Promise<void>,
  discloseOwned?: ReferenceDisclosure,
  readReferences?: ReferenceDisclosure,
  attribution?: RelationAttributionVerifier,
): Promise<ContextCommandReceipt> {
  const input = checkedRecordStatementV2(raw), request = recordStatementV2Request(input);
  const existing = await readCommandReceipt(env, admission.id, STATEMENT_FAMILIES.record);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const normalized = input.subject.kind === 'resource'
    ? await normalizeStatementSubject(env, { subject: input.subject.ref, applicability: input.applicability }, canRead, readTargets)
    : { subject: null, applicability: input.applicability };
  const subject = normalized.subject ? checkedStatementParticipant({ kind: 'resource', ref: normalized.subject }) : input.subject;
  const definitions = await validateStatementDefinitions(env, { ...input, value: undefined }, canReadDefinition, 'statement-v2');
  const interpretation = await statementInterpretation(env, input, speaker, canReadDefinition);
  if (interpretation.state !== 'resolved') throw new ContextCommandUnavailable('Statement interpretation is unavailable');
  if (input.expectedInterpretation && (input.expectedInterpretation.semanticRevision !== interpretation.semanticRevision
    || input.expectedInterpretation.definition !== interpretation.definition)) {
    return checkedCommandReceipt((await sealCommandTerminal(env, admission, STATEMENT_FAMILIES.record, 'stale-head'))!, admission, request.digest);
  }
  const initial: StatementMeaningV2 = { subject, predicate: definitions.graphPredicate,
    relationDefinition: input.relationDefinition, value: input.value, applicability: normalized.applicability,
    coverage: checkedStatementCoverage(input.coverage), interpretationDefinitions: interpretation.definition ? [interpretation.definition] : [],
    ...(input.qualification ? { qualification: input.qualification } : {}) };
  const coverage = await resolveStatementCoverage(env, initial, canRead, canReadDefinition, discloseOwned, readReferences, attribution);
  const meaning = checkedStatementMeaningV2({ ...initial, applicability:
    await normalizeCoveredStatementApplicability(env, coverage.applicability, initial.applicability, readTargets) });
  const nativeReferences = [subject, input.value].flatMap(value => value.kind === 'resource' ? [value.ref] : []);
  const ownerReferences = initial.coverage.kind === 'occurrence'
    ? [initial.coverage.occurrence, initial.coverage.occurrenceRevision] : [];
  if ((await Promise.all(nativeReferences.filter(ref => !ownerReferences.includes(ref)).map(canRead))).some(readable => !readable)) {
    throw new ContextCommandUnavailable('Statement reference is unavailable');
  }
  const generation = await ensureModelGeneration(env);
  const statement = ID + Bun.randomUUIDv7(), revision = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  const meaningKey = statementMeaningKeyV2(meaning), speakerId = speakerIri(input);
  const subjectRdf = semanticValueRdf(subject, () => ID + Bun.randomUUIDv7());
  const valueRdf = semanticValueRdf(input.value, () => ID + Bun.randomUUIDv7());
  const manifest = await sealComponentState(env, statement, STATEMENT_V2_PROFILE, {
    revision, meaning, meaningKey, speaker: speakerId, semanticContextRevision: interpretation.semanticRevision,
    state: 'active', evidence: input.evidence, recordedBy: input.actingSubject, modelGeneration: generation,
    subjectRdf, valueRdf,
  });
  const validations = [...await profileValidations(env.fuseki, 'statement-v2', [
    { shape: `${STATEMENT_V2_PROFILE}/statement-shape`, focus: [statement], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_V2_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]), ...await valueValidations(env, [subjectRdf, valueRdf])];
  const selectionGuard = input.speaker.kind === 'realm' && interpretation.selectionRevision
    ? `GRAPH ${iri(GRAPHS.current)} { ?usedSelection rv:consumer ${iri(input.speaker.realm)} ;
        rv:contextSelectionHead ${iri(interpretation.selectionRevision)} }` : '';
  const explicitGuard = input.interpretation.kind === 'explicit'
    ? `GRAPH ${iri(GRAPHS.current)} { ${term(input.interpretation.context)} a rv:SemanticContext ; rv:contextState rv:Active }` : '';
  const realmGuard = input.speaker.kind === 'realm'
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.speaker.realm)} a rv:Realm ; rv:realmState rv:Active }` : '';
  const pinGuard = interpretation.semanticRevision
    ? `GRAPH ${iri(GRAPHS.revisions)} { ${iri(interpretation.semanticRevision)} a rv:ContextSemanticRevision }` : '';
  const interpretationGuard = input.interpretation.kind === 'definition'
    ? (await validateStatementInterpretationDefinition(env, input.interpretation.definition, canReadDefinition)).guard : '';
  const subjectGuard = subject.kind === 'resource'
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(subject.ref)} a ?subjectType }
       ${normalized.subject !== null && normalized.subject !== (input.subject.kind === 'resource' ? input.subject.ref : null)
        ? `GRAPH ${iri(GRAPHS.current)} { ${iri((input.subject as Extract<Participant, { kind: 'resource' }>).ref)} a rv:Projection ; rv:projectionOf ${iri(subject.ref)} }` : ''}` : '';
  await beforeCommit?.(statement, commandReceiptIri(admission.id, STATEMENT_FAMILIES.record));
  const committed = await commitCommand(env, admission, { family: STATEMENT_FAMILIES.record, digest: request.digest,
    validations, operation, component: statement, revision, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a rdf:Statement ;
      rdf:subject ${subjectRdf.object} ; rdf:predicate ${term(meaning.predicate)} ; rdf:object ${valueRdf.object} ;
      rv:relationDefinition ${iri(meaning.relationDefinition)} ; rv:modelRevision ${iri(STATEMENT_V2_PROFILE)} ;
      rv:speaker ${iri(speakerId)} ; rv:meaningKey ${iri(meaningKey)} ; rv:statementState rv:Active ; rv:head ${iri(revision)} ;
      ${statementCoverageTriples(meaning.coverage)}
      ${meaning.interpretationDefinitions.map(ref => `rv:interpretationDefinition ${term(ref)} ;`).join(' ')}
      ${meaning.applicability.map(ref => `rv:applicability ${term(ref)} ;`).join(' ')}
      ${interpretation.semanticRevision ? `rv:semanticContextRevision ${iri(interpretation.semanticRevision)} ;` : ''}
      ${meaning.qualification ? statementQualificationTriples(meaning.qualification) : ''}
      rv:recordedBy ${iri(input.actingSubject)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ;
      rv:component ${iri(statement)} ; rv:statementState rv:Active ; rv:recordedBy ${iri(input.actingSubject)} ;
      rv:operation ${iri(operation)} ; rv:modelRevision ${iri(STATEMENT_V2_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_V2_PROFILE)} ;
      rv:modelGeneration ${iri(generation)} ; rv:manifest ${iri(manifest)} ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      ${input.evidence.map(ref => `${iri(revision)} rv:evidence ${term(ref)} .`).join('\n')}
      ${[subjectRdf, valueRdf].flatMap(value => value.node?.triples.map(triple => `${triple} .`) ?? []).join('\n')} }`,
    where: `${subjectGuard} ${coverage.guard} ${definitions.guard} ${selectionGuard} ${explicitGuard} ${realmGuard}
      ${pinGuard} ${interpretationGuard} ${modelGenerationHeadGuard(generation)}
      ${activeDirectDefinitionsGuard([input.relationDefinition, ...meaning.interpretationDefinitions])}
      ${nativeReferences.map(ref => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} rv:conceptState rv:Retired } }`).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} ?p ?o } }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} }`,
  });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  if (selectionGuard && (await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${selectionGuard} }`)).boolean !== true) {
    return checkedCommandReceipt((await sealCommandTerminal(env, admission, STATEMENT_FAMILIES.record, 'stale-head'))!, admission, request.digest);
  }
  throw new ContextCommandUnavailable('Statement coverage, interpretation or model generation changed');
}
