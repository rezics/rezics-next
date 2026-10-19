import { commandReceiptIri, ContextCommandUnavailable, term,
  type ContextCommandReceipt } from '../context/command.ts';
import { readComponent } from '../semantic/command.ts';
import { semanticValueExport, semanticValueRdf, type ValueRdf } from '../semantic/value.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { framePattern, readFrames } from '../projection/frame-read.ts';
import { targetSummaries } from '../target/resolve.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import type { Acceptance } from './graph.ts';
import { statementQualificationExport } from './qualification.ts';
import { MAX_PUBLIC_STATEMENT_BATCH, StatementNotFound, resolveStatementAcceptancesAt, type MeaningBasis, type StatementResolution } from './read.ts';
import { STATEMENT_FAMILIES } from './receipt-family.ts';
import { checkedStatementMeaningV2, statementMeaningKeyV2, statementNativeId, StatementV2Rejected,
  STATEMENT_V2_PROFILE, type StatementMeaningV2 } from './v2-schema.ts';
import { resolveStatementCoverage, StatementCoverageHidden } from './v2-coverage.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export interface StatementV2Snapshot {
  statement: string; revision: string; head: string; currentState: 'active' | 'withdrawn';
  meaning: StatementMeaningV2; meaningKey: string; speaker: string; semanticContextRevision: string | null;
  state: 'active' | 'withdrawn'; evidence: string[]; recordedBy: string; operation: string;
  receipt: ContextCommandReceipt; sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  modelGeneration: string; manifest: string; subjectRdf: ValueRdf; valueRdf: ValueRdf;
}

const unavailable = (message: string): never => { throw new ContextCommandUnavailable(message); };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);

/** Decode only the requested profile and retained anchor. No current head or V1 literal substitutes for it. */
export async function readStatementV2Revision(env: WorkActivationEnvironment, statement: string,
  revision: string): Promise<StatementV2Snapshot> {
  if (!statementNativeId(statement) || !statementNativeId(revision)) throw new StatementV2Rejected('invalid_statement_coverage', 'invalid exact Statement identity');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?manifest ?model ?generation ?state ?operation ?recordedBy ?epoch ?sequence ?head ?currentState
      ?receipt ?family ?admission ?digest ?authority ?scope WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a rdf:Statement ; rv:head ?head ; rv:statementState ?currentState }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(statement)} ; rv:manifest ?manifest ; rv:statementState ?state ; rv:operation ?operation ;
        rv:recordedBy ?recordedBy ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:modelRevision ?model }
        OPTIONAL { ${iri(revision)} rv:modelGeneration ?generation }
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } }
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:component ${iri(statement)} ; rv:revision ${iri(revision)} ; rv:operation ?operation ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence ; rv:commandFamily ?family ; rv:admissionId ?admission ;
        rv:requestDigest ?digest ; rv:authorityEpoch ?authority ; rv:admittedScope ?scope } }
    } LIMIT 2`, 16_384)).results?.bindings ?? [];
  if (!rows.length) throw new StatementNotFound('Statement is unavailable');
  if (rows.length !== 1) return unavailable('Statement revision or command receipt is ambiguous');
  const row = rows[0]!;
  if (row.model?.value !== STATEMENT_V2_PROFILE) throw new StatementV2Rejected('unsupported_model_revision', 'this exact Statement revision requires its declared model profile');
  if (!row.generation || !row.receipt || !row.family || !row.admission || !row.digest || !row.authority || !row.scope
    || !row.manifest || !row.operation || !row.recordedBy || !row.epoch || !row.sequence || !row.head
    || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(row.generation.value)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(row.manifest.value)
    || !['Active', 'Withdrawn'].some(state => row.state?.value === RV + state)
    || !['Active', 'Withdrawn'].some(state => row.currentState?.value === RV + state)
    || ![STATEMENT_FAMILIES.record, STATEMENT_FAMILIES.withdraw].some(family => family === row.family!.value)
    || commandReceiptIri(row.admission.value, row.family.value) !== row.receipt.value) {
    return unavailable('Statement lacks its actual command receipt or exact model basis');
  }
  const stored = await readComponent(env, row.manifest.value, statement, STATEMENT_V2_PROFILE);
  let meaning: StatementMeaningV2;
  try { meaning = checkedStatementMeaningV2(stored.meaning as StatementMeaningV2); }
  catch { return unavailable('Statement authored meaning is unavailable'); }
  const state = row.state?.value === `${RV}Active` ? 'active' : 'withdrawn';
  const evidence = stored.evidence;
  if (stored.revision !== revision || stored.meaningKey !== statementMeaningKeyV2(meaning)
    || stored.state !== state || stored.recordedBy !== row.recordedBy.value
    || stored.modelGeneration !== row.generation.value || !statementNativeId(stored.speaker)
    || stored.semanticContextRevision !== null && !statementNativeId(stored.semanticContextRevision)
    || !Array.isArray(evidence) || evidence.length > 16 || new Set(evidence).size !== evidence.length
    || evidence.some(value => typeof value !== 'string') || !stored.subjectRdf || !stored.valueRdf) {
    return unavailable('Statement anchor differs from its exact manifest');
  }
  const subjectRdf = stored.subjectRdf as ValueRdf, valueRdf = stored.valueRdf as ValueRdf;
  try {
    if (!equal(subjectRdf, semanticValueRdf(meaning.subject, () => subjectRdf.node!.iri))
      || !equal(valueRdf, semanticValueRdf(meaning.value, () => valueRdf.node!.iri))) return unavailable('Statement value-node identity differs from its retained value');
  } catch { return unavailable('Statement exact value-node representation is unavailable'); }
  const receipt: ContextCommandReceipt = { outcome: 'succeeded', receipt: row.receipt.value,
    admissionId: row.admission.value, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
    operation: row.operation.value, component: statement, revision };
  return { statement, revision, head: row.head.value, currentState: row.currentState?.value === `${RV}Active` ? 'active' : 'withdrawn',
    meaning, meaningKey: stored.meaningKey as string, speaker: stored.speaker,
    semanticContextRevision: stored.semanticContextRevision as string | null, state, evidence: evidence as string[],
    recordedBy: row.recordedBy.value, operation: receipt.operation!, receipt,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value, sequence: row.sequence.value },
    modelGeneration: row.generation.value, manifest: row.manifest.value, subjectRdf, valueRdf };
}

/** Verify the current owner projection against its immutable bytes, including full qualifier and value-node identities. */
export async function verifyStatementV2Current(env: WorkActivationEnvironment, snapshot: StatementV2Snapshot): Promise<void> {
  if (snapshot.head !== snapshot.revision || snapshot.currentState !== snapshot.state) return unavailable('Statement head changed');
  const { meaning } = snapshot;
  const values: [string, string][] = [
    [RDF + 'type', term(RDF + 'Statement')], [RDF + 'subject', snapshot.subjectRdf.object],
    [RDF + 'predicate', term(meaning.predicate)], [RDF + 'object', snapshot.valueRdf.object],
    [RV + 'modelRevision', iri(STATEMENT_V2_PROFILE)], [RV + 'relationDefinition', iri(meaning.relationDefinition)],
    [RV + 'speaker', iri(snapshot.speaker)], [RV + 'head', iri(snapshot.head)],
    [RV + 'meaningKey', iri(snapshot.meaningKey)], [RV + 'statementState', term(RV + (snapshot.state === 'active' ? 'Active' : 'Withdrawn'))],
    [RV + 'statementCoverage', term(RV + ({ participation: 'ParticipationCoverage', occurrence: 'OccurrenceCoverage', 'subject-global': 'SubjectGlobalCoverage' }[meaning.coverage.kind]))],
    [RV + 'recordedBy', iri(snapshot.recordedBy)],
    ...meaning.applicability.map(ref => [RV + 'applicability', iri(ref)] as [string, string]),
    ...meaning.interpretationDefinitions.map(ref => [RV + 'interpretationDefinition', term(ref)] as [string, string]),
  ];
  if (snapshot.semanticContextRevision) values.push([RV + 'semanticContextRevision', iri(snapshot.semanticContextRevision)]);
  if (meaning.coverage.kind !== 'subject-global') {
    values.push([RV + 'coveredOccurrence', iri(meaning.coverage.occurrence)], [RV + 'coveredOccurrenceRevision', iri(meaning.coverage.occurrenceRevision)]);
    if (meaning.coverage.kind === 'participation') values.push([RV + 'coveredParticipation', iri(meaning.coverage.participation)]);
  }
  if (meaning.qualification) for (const [predicate, objects] of Object.entries(statementQualificationExport(meaning.qualification))) {
    for (const object of objects as ({ '@id': string } | { '@value': string; '@type': string })[]) {
      values.push([predicate, '@id' in object ? term(object['@id']) : `${lit(object['@value'])}^^${term(object['@type'])}`]);
    }
  }
  const predicates = [...new Set([...values.map(([predicate]) => predicate), ...[
    'applicability', 'interpretationDefinition', 'semanticContextRevision', 'coveredOccurrence', 'coveredOccurrenceRevision',
    'coveredParticipation', 'qualificationDefinition', 'interpretationContext', 'valuePrecision', 'valueQualifier', 'validFrom', 'validUntil', 'editionScope',
  ].map(local => RV + local)])];
  const bindings = values.map(([predicate, object]) => `(${term(predicate)} ${object})`).join(' ');
  const verified = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    FILTER NOT EXISTS { VALUES (?expectedP ?expectedO) { ${bindings} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(snapshot.statement)} ?expectedP ?expectedO } } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(snapshot.statement)} ?actualP ?actualO }
      FILTER(?actualP IN (${predicates.map(term).join(', ')}))
      FILTER NOT EXISTS { VALUES (?expectedP ?expectedO) { ${bindings} } FILTER(?actualP = ?expectedP && sameTerm(?actualO, ?expectedO)) } }
    GRAPH ${iri(GRAPHS.revisions)} { ${[snapshot.subjectRdf, snapshot.valueRdf].flatMap(value => value.node?.triples.map(triple => `${triple} .`) ?? []).join('\n')}
      ${snapshot.evidence.map(ref => `${iri(snapshot.revision)} rv:evidence ${term(ref)} .`).join('\n')} }
  }`);
  if (verified.boolean !== true) return unavailable('Statement current value or qualifiers differ from its exact revision');
}

export async function statementV2Acceptance(env: WorkActivationEnvironment, snapshot: Pick<StatementV2Snapshot, 'statement' | 'meaningKey'>,
  acceptance: Acceptance, position: { dataEpoch: string; sequence: string }): Promise<StatementResolution> {
  const decisions = await resolveStatementAcceptancesAt(env, [{ kind: 'statement', statement: snapshot.statement },
    { kind: 'qualified-fact', meaningKey: snapshot.meaningKey }], acceptance, position);
  const direct = decisions.get(snapshot.statement), fact = decisions.get(snapshot.meaningKey);
  if (!direct || direct.result.state === 'unavailable') {
    throw new WorkReadUnavailable('Statement adoption is unavailable');
  }
  if (direct.result.state !== 'absent') return direct;
  if (!fact || fact.result.state === 'unavailable') throw new WorkReadUnavailable('Statement meaning adoption is unavailable');
  return direct.result.state === 'absent' ? fact : direct;
}

/** Use the existing target and semantic owners inside this HTTP session, including its completion fences. */
async function readableReferences(session: WorkReadSession, references: readonly string[]): Promise<ReadonlySet<string>> {
  const unique = [...new Set(references)];
  const allowed = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 64) {
    const page = unique.slice(offset, offset + 64);
    const summaries = await targetSummaries(session, page);
    for (const row of summaries.summaries) if (row.status === 'available') allowed.add(row.reference);
    const remaining = page.filter(ref => !allowed.has(ref));
    if (!remaining.length) continue;
    const read = async () => {
      const access = session.deps.access;
      if (access.canReadSemanticResources) return [...await access.canReadSemanticResources(session.principal,
        session.options.actingSubject ?? null, remaining)].sort();
      return (await Promise.all(remaining.map(async ref => access.canReadSemanticResource
        && await access.canReadSemanticResource(session.principal, session.options.actingSubject ?? null, ref) ? ref : null)))
        .filter((ref): ref is string => ref !== null).sort();
    };
    const semantic = await read();
    session.observeDependency(`statement-reference-authority:${JSON.stringify(remaining)}`, semantic, read);
    const names = await session.disclosure(semantic.map(resource => ({ owner: 'graph', resource, component: 'name' })));
    semantic.forEach((ref, index) => { if (names[index] === 'visible') allowed.add(ref); });
  }
  return allowed;
}

/** A trait's decision cannot adopt its occurrence. Find an independently adopted exact assertion. */
async function requireOccurrenceAssertion(session: WorkReadSession, snapshot: StatementV2Snapshot,
  context: string, frames: readonly string[], canReadPrivate: (context: string) => Promise<boolean>): Promise<void> {
  const coverage = snapshot.meaning.coverage;
  if (coverage.kind !== 'participation') return;
  const candidates = await session.query(`SELECT DISTINCT ?statement ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?statement a <${RDF}Statement> ; rv:modelRevision ${iri(STATEMENT_V2_PROFILE)} ;
      rv:statementState rv:Active ; rv:head ?revision ; rv:statementCoverage rv:OccurrenceCoverage ;
      rv:coveredOccurrence ${iri(coverage.occurrence)} ; rv:coveredOccurrenceRevision ${iri(coverage.occurrenceRevision)} ;
      <${RDF}subject> ${iri(coverage.occurrence)} ; <${RDF}object> ${iri(coverage.occurrenceRevision)} }
  } ORDER BY STR(?statement) LIMIT ${MAX_PUBLIC_STATEMENT_BATCH + 1}`, MAX_PUBLIC_STATEMENT_BATCH + 1);
  if (candidates.length > MAX_PUBLIC_STATEMENT_BATCH) throw new WorkReadUnavailable('Occurrence assertion support bound exceeded');
  for (const candidate of candidates) {
    if (!candidate.statement || !candidate.revision) throw new WorkReadUnavailable('Occurrence assertion coverage is unavailable');
    try {
      // This resolves that assertion's own exact receipt, meaning, DecisionSlots,
      // frame, authority and final disclosure. Occurrence coverage cannot recurse.
      await readAdoptedStatementV2(session, candidate.statement.value, candidate.revision.value, context, frames, canReadPrivate);
      return;
    } catch (error) {
      if (!(error instanceof StatementNotFound || error instanceof StatementCoverageHidden)) throw error;
    }
  }
  throw new StatementNotFound('Statement is unavailable');
}

/** Public exact reads require current adoption. The writer uses the receipt-bound snapshot above for its draft result. */
export async function readAdoptedStatementV2(session: WorkReadSession, statement: string, revision: string,
  context: string, frames: readonly string[], canReadPrivate: (context: string) => Promise<boolean>,
) {
  const env = session.deps.environment;
  if (context !== 'global') {
    if (!session.principal || !session.options.actingSubject) throw new StatementNotFound('Statement is unavailable');
    await session.realm(context);
  }
  const snapshot = await readStatementV2Revision(env, statement, revision);
  if (snapshot.head !== revision || snapshot.currentState !== 'active' || snapshot.state !== 'active') throw new StatementNotFound('Statement is unavailable');
  const initialDisclosure = await session.disclosure([statement, revision].map(resource =>
    ({ owner: 'graph' as const, resource, component: 'record' as const })));
  if (initialDisclosure.some(state => state !== 'visible')) throw new StatementNotFound('Statement is unavailable');
  await verifyStatementV2Current(env, snapshot);
  session.observeDependency(`statement-current:${statement}:${revision}`, snapshot,
    async () => { const current = await readStatementV2Revision(env, statement, revision); await verifyStatementV2Current(env, current); return current; });
  const acceptance: Acceptance = context === 'global' ? { kind: 'global' } : { kind: 'realm', realm: context };
  const adopted = await statementV2Acceptance(env, snapshot, acceptance, session.position);
  if (adopted.result.state !== 'accepted') throw new StatementNotFound('Statement is unavailable');
  session.observeDependency(`statement-adoption:${statement}:${context}`, adopted,
    () => statementV2Acceptance(env, snapshot, acceptance, session.position));
  const disclose = async (references: readonly string[]) => {
    const decisions = await session.disclosure(references.map(resource => ({ owner: 'graph' as const, resource, component: 'record' as const })));
    return new Set(references.filter((_, index) => decisions[index] === 'visible'));
  };
  const referenceCache = new Map<string, boolean>();
  const canRead = async (ref: string) => {
    if (!referenceCache.has(ref)) referenceCache.set(ref, (await readableReferences(session, [ref])).has(ref));
    return referenceCache.get(ref)!;
  };
  if (statementNativeId(snapshot.meaning.predicate) && !await canRead(snapshot.meaning.predicate)) {
    throw new StatementNotFound('Statement is unavailable');
  }
  if (snapshot.meaning.subject.kind === 'resource' && snapshot.meaning.coverage.kind !== 'occurrence') {
    if (!await canRead(snapshot.meaning.subject.ref)) throw new StatementNotFound('Statement is unavailable');
  }
  let coverage;
  try { coverage = await resolveStatementCoverage(env, snapshot.meaning, canRead, canRead, disclose,
    refs => readableReferences(session, refs)); }
  catch (error) { if (error instanceof StatementCoverageHidden) throw new StatementNotFound('Statement is unavailable'); throw error; }
  session.observeDependency(`statement-coverage:${statement}:${revision}`, coverage,
    () => resolveStatementCoverage(env, snapshot.meaning, async ref => (await readableReferences(session, [ref])).has(ref),
      async ref => (await readableReferences(session, [ref])).has(ref), disclose, refs => readableReferences(session, refs)));
  let meaningBasis: MeaningBasis = snapshot.meaning.interpretationDefinitions.length
    ? { state: 'defined', interpretationDefinitions: snapshot.meaning.interpretationDefinitions } : { state: 'none' };
  if (snapshot.semanticContextRevision) {
    const pins = await session.query(`SELECT ?context ?disclosure WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(snapshot.semanticContextRevision)} a rv:ContextSemanticRevision ; rv:component ?context }
      GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure }
    } LIMIT 2`, 2);
    if (pins.length !== 1 || !pins[0]?.context || (pins[0].disclosure?.value !== `${RV}Public`
      && !await canReadPrivate(pins[0].context.value))) throw new StatementNotFound('Statement is unavailable');
    meaningBasis = { state: 'readable', context: pins[0].context.value, semanticRevision: snapshot.semanticContextRevision,
      interpretationDefinitions: snapshot.meaning.interpretationDefinitions };
  }
  const selectedFrames = frames.length ? await readFrames(session, frames) : [];
  const matched = await session.query(`SELECT ?statement WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a <${RDF}Statement> ; rv:head ${iri(revision)} }
    BIND(${iri(statement)} AS ?statement)
    ${framePattern(selectedFrames, iri(statement), GRAPHS.current).filter}
  } LIMIT 1`, 1);
  // A SELECT needs a bound result even when the owner only supplies FILTER clauses.
  if (!matched.length) throw new StatementNotFound('Statement is unavailable');
  const records = [...new Set([statement, revision, snapshot.meaning.predicate, snapshot.meaning.relationDefinition,
    ...snapshot.meaning.interpretationDefinitions, ...snapshot.meaning.applicability, ...snapshot.evidence, ...coverage.references,
    ...[snapshot.meaning.subject, snapshot.meaning.value].flatMap(value => value.kind === 'resource' ? [value.ref] : []),
    ...(snapshot.meaning.qualification ? [snapshot.meaning.qualification.definition, snapshot.meaning.qualification.interpretationContext,
      ...(snapshot.meaning.qualification.editionScope ? [snapshot.meaning.qualification.editionScope] : [])] : [])])].filter(statementNativeId);
  const disclosed = await disclose(records), visible = await readingBoundary(session).visible(records);
  if (records.some(ref => !disclosed.has(ref) || !visible.has(ref))) throw new StatementNotFound('Statement is unavailable');
  const value = snapshot.meaning.value;
  if (value.kind === 'resource' && snapshot.meaning.coverage.kind !== 'occurrence' && !await canRead(value.ref)) {
    throw new StatementNotFound('Statement is unavailable');
  }
  await requireOccurrenceAssertion(session, snapshot, context, frames, canReadPrivate);
  const current = await session.query(`SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  } LIMIT 2`, 2);
  if (current.length !== 1 || current[0]?.epoch?.value !== session.position.dataEpoch
    || current[0]?.sequence?.value !== session.position.sequence) throw new WorkReadMoved('Statement read position changed');
  const meaning = snapshot.meaning;
  return { profile: 'statement-v2' as const, statement, revision, ...meaning, speaker: snapshot.speaker,
    meaningKey: snapshot.meaningKey, meaningBasis, state: snapshot.state, evidence: snapshot.evidence,
    export: { '@id': statement, '@type': [RDF + 'Statement'], [RDF + 'subject']: [semanticValueExport(meaning.subject)],
      [RDF + 'predicate']: [{ '@id': meaning.predicate }], [RDF + 'object']: [semanticValueExport(meaning.value)],
      ...(meaning.qualification ? statementQualificationExport(meaning.qualification) : {}) },
    sourcePosition: { datasetId: 'product' as const, ...session.position }, modelGeneration: snapshot.modelGeneration,
    manifest: snapshot.manifest, coverageReferences: coverage.references };
}
