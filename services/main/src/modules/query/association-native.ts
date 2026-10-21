import { Value } from 'typebox/value';
import { namePolicyPrincipal } from '../disclosure/viewer.ts';
import { visibleNames } from '../disclosure/name-policy.ts';
import type { VerifiedAccountAssertion } from '../account/verify-assertion.ts';
import { ReadingBoundary } from '../reading-position/boundary.ts';
import { readFrames } from '../projection/frame-read.ts';
import { readExactDefinition, type ExactDefinition, type OccurrenceState } from '../relation/change.ts';
import { relationAttributionVerifier } from '../relation/attribution.ts';
import { readAttributedOccurrence, validateAttributedOccurrence, validateAttributedOccurrenceIdentity } from '../relation/v2-read.ts';
import { RELATION_V2_PROFILE } from '../relation/v2-schema.ts';
import { PROFILES } from '../semantic/schema.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import { readActiveModelGeneration } from '../semantic/generation-guard.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { readAdoptedOccurrenceV2, readAdoptedStatementV2, statementV2Acceptance,
  type StatementV2ReadOwners } from '../statement/v2-read.ts';
import { StatementNotFound } from '../statement/read.ts';
import { StatementCoverageHidden, type RetainedStatementCoverage } from '../statement/v2-coverage.ts';
import { STATEMENT_V2_PROFILE } from '../statement/v2-schema.ts';
import { readWikiClaimEvidence, projectWikiEvidence } from '../wiki/evidence-read.ts';
import { GRAPHS, iri, lit, PendingActivation } from '../work/activate.ts';
import { creditNativeId } from '../work/credit-association-state.ts';
import { readNativeCreditAssociation, nativeCreditStatementCoverage, readNativeCreditAttribution } from '../work/native-association.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { ASSOCIATION_COST, associationWitness, type AssociationSelection, type AssociationWitness,
  type AssociationStatement } from './association-contract.ts';
import { associationOrderKey, type AssociationKey, type AssociationFrontier, type AssociationReadBasis,
  type AssociationSurface } from './association-cursor.ts';
import { readAssociationPage } from './association-page.ts';
import { associationCanonical, associationParticipantKey } from './association-selection.ts';

/** Physical windows share the HTTP session's call/byte/deadline allocation.
 * They bound one graph seek, never native catalogue population or completeness. */
export const NATIVE_ASSOCIATION_WINDOW = 2;
const STATEMENT_WINDOW = 16;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const unavailable = (message: string): never => { throw new WorkReadUnavailable(message); };
type Adopted = Awaited<ReturnType<typeof readAdoptedStatementV2>>;
type NativeCredit = NonNullable<Awaited<ReturnType<typeof readNativeCreditAssociation>>>;
interface Candidate extends AssociationKey { family: 'relation' | 'credit'; revision: string | null }

function seek(after: AssociationFrontier | null) {
  if (!after) return '';
  if (after.kind === 'work') return `FILTER(STR(?work) > ${lit(after.work)})`;
  const key = after.key;
  return `${after.kind === 'matches' ? `FILTER(?work = ${iri(key.work)})` : ''}
    FILTER(STR(?work) > ${lit(key.work)} || (STR(?work) = ${lit(key.work)} &&
      (STR(?occurrence) > ${lit(key.occurrence)} || (STR(?occurrence) = ${lit(key.occurrence)} &&
        BOUND(?subjectParticipation) && STR(?subjectParticipation) > ${lit(key.subjectParticipation ?? '')}))))`;
}

/** Enumerate admitted native participation heads, including existing V1 and V2
 * credit commands with their actual allocated association head. Scalar credit
 * tuples have no participation identities and belong to the scalar credit API.
 * Definitions decide roles during hydration: a co-participant
 * that happens to be a Work never acquires the authored Work authority role. */
export async function nativeAssociationCandidates(session: WorkReadSession, selection: AssociationSelection,
  after: AssociationFrontier | null, limit: number): Promise<{ items: Candidate[]; more: boolean }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > ASSOCIATION_COST.candidates) {
    return unavailable('Invalid native association candidate window');
  }
  const size = Math.min(limit, NATIVE_ASSOCIATION_WINDOW);
  const roots = selection.parameters.direction === 'work-to-subject' ? selection.parameters.roots : undefined;
  const subjects = selection.parameters.direction === 'subject-to-work' ? selection.parameters.roots : undefined;
  const relationSubjects = subjects?.map(root => root.kind === 'resource'
    ? `{ ?subjectParticipation rv:participant ${iri(root.ref)} }`
    : `{ ?subjectParticipation rv:participant ?externalSubject .
        ?externalSubject a rv:ExternalReference ; rv:externalProvider ${lit(root.provider)} ;
          rv:externalNamespace ${lit(root.namespace)} ; rv:externalKey ${lit(root.key)} }`).join(' UNION ');
  const creditSubjects = subjects?.map(root => root.kind === 'resource'
    ? `{ ?occurrence rv:agent ${iri(root.ref)} }`
    : `{ ?occurrence rv:externalProvider ${lit(root.provider)} ;
        rv:externalNamespace ${lit(root.namespace)} ; rv:externalKey ${lit(root.key)} }`).join(' UNION ');
  const rows = await session.query(`SELECT DISTINCT ?work ?occurrence ?revision ?subjectParticipation ?family WHERE {
    ${roots ? `VALUES ?work { ${roots.map(root => root.kind === 'resource' ? iri(root.ref) : unavailable('Invalid native Work root')).join(' ')} }` : ''}
    { GRAPH ${iri(GRAPHS.current)} { ?occurrence a rv:RelationOccurrence ; rv:modelRevision ${iri(RELATION_V2_PROFILE)} ;
        rv:occurrenceHead ?revision . ?work a <https://schema.org/CreativeWork> }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RelationOccurrenceRevision ; rv:component ?occurrence ;
        rv:modelRevision ${iri(RELATION_V2_PROFILE)} ; rv:lifecycle rv:Active ;
        rv:participation ?workParticipation, ?subjectParticipation .
        ?workParticipation rv:participant ?work .
        ${relationSubjects ? `{ ${relationSubjects} }` : ''} }
      FILTER(?workParticipation != ?subjectParticipation)
      BIND("relation" AS ?family) }
    ${selection.parameters.kind === 'credit' ? `UNION {
      GRAPH ${iri(GRAPHS.current)} { ?occurrence a ?nativeCreditKind ; rv:work ?work ; rv:creditRevision ?creditRevision ;
          rv:associationHead ?revision .
        VALUES ?nativeCreditKind { rv:AuthorCredit rv:NativeAgentCredit }
        ${creditSubjects ? `{ ${creditSubjects} }` : ''}
        FILTER NOT EXISTS { ?occurrence rv:retiredBy ?retired }
        FILTER NOT EXISTS { ?occurrence rv:protectionHead ?protected } }
      BIND("credit" AS ?family) }` : ''}
    ${seek(after)}
  } ORDER BY STR(?work) STR(?occurrence) STR(?subjectParticipation) LIMIT ${size + 1}`, size + 1);
  const items = rows.slice(0, size).map(row => {
    const work = row.work?.value, occurrence = row.occurrence?.value, revision = row.revision?.value ?? null;
    const subjectParticipation = row.subjectParticipation?.value ?? null, family = row.family?.value;
    if (!creditNativeId(work) || !creditNativeId(occurrence) || !creditNativeId(revision)
      || subjectParticipation !== null && !creditNativeId(subjectParticipation) || !['relation', 'credit'].includes(family ?? '')
      || family === 'relation' && (!revision || !subjectParticipation)) return unavailable('Native association candidate is unavailable');
    return { work, occurrence, revision, subjectParticipation, family: family as Candidate['family'] };
  });
  return { items, more: rows.length > size };
}

const contextOf = (selection: AssociationSelection) => selection.parameters.context === 'global'
  ? 'global' : selection.parameters.context.realm;
const qualification = (statement: Adopted): AssociationWitness['qualification'] => {
  const value = statement.qualification;
  return value?.valueQualifiers.includes('disputed-attribution') ? 'conflicting'
    : value && (value.valuePrecision !== 'exact' || value.valueQualifiers.includes('inferred')) ? 'uncertain' : 'asserted';
};
function participantPattern(participant: AssociationWitness['subject']) {
  return participant.kind === 'resource' ? `?statement <${RDF}subject> ${iri(participant.ref)} .`
    : `?statement <${RDF}subject> ?externalSubject .
      ?externalSubject a rv:ExternalReference ; rv:externalProvider ${lit(participant.provider)} ;
        rv:externalNamespace ${lit(participant.namespace)} ; rv:externalKey ${lit(participant.key)} .`;
}

/** Complete the selected subject's actual current trait inventory with ordered
 * physical seeks. Empty/withheld windows are still fenced. Every candidate is
 * independently resolved by the existing exact Statement/adoption owner. */
async function traits(session: WorkReadSession, selection: AssociationSelection, occurrence: string, revision: string,
  subject: AssociationWitness['subject'], participation: string, read: (statement: string, revision: string) => Promise<Adopted>) {
  const adopted: Adopted[] = [];
  let after: string | null = null;
  while (true) {
    const rows = await session.query(`SELECT DISTINCT ?statement ?revision WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement a <${RDF}Statement> ; rv:modelRevision ${iri(STATEMENT_V2_PROFILE)} ;
        rv:statementState rv:Active ; rv:head ?revision .
        { ?statement rv:statementCoverage rv:ParticipationCoverage ; rv:coveredOccurrence ${iri(occurrence)} ;
            rv:coveredOccurrenceRevision ${iri(revision)} ; rv:coveredParticipation ${iri(participation)} }
        UNION { ?statement rv:statementCoverage rv:SubjectGlobalCoverage }
        ${participantPattern(subject)} }
      ${after ? `FILTER(STR(?statement) > ${lit(after)})` : ''}
    } ORDER BY STR(?statement) LIMIT ${STATEMENT_WINDOW + 1}`, STATEMENT_WINDOW + 1);
    for (const row of rows.slice(0, STATEMENT_WINDOW)) {
      const statement = row.statement?.value, head = row.revision?.value;
      if (!creditNativeId(statement) || !creditNativeId(head) || after !== null && statement <= after) {
        return unavailable('Native association Statement inventory is unavailable');
      }
      after = statement;
      try {
        const value = await read(statement, head), coverage = value.coverage;
        if (associationParticipantKey(value.subject) !== associationParticipantKey(subject)
          || coverage.kind === 'occurrence' || coverage.kind === 'participation'
            && (coverage.occurrence !== occurrence || coverage.occurrenceRevision !== revision)) {
          return unavailable('Native association Statement differs from its exact coverage');
        }
        adopted.push(value);
        if (adopted.length > 512) return unavailable('Native association Statement response exceeds its bound');
      } catch (error) {
        if (!(error instanceof StatementNotFound || error instanceof StatementCoverageHidden)) throw error;
      }
    }
    if (rows.length <= STATEMENT_WINDOW) return adopted;
    if (!after) return unavailable('Native association Statement frontier is unavailable');
    session.checkDeadline();
  }
}

async function citations(session: WorkReadSession, boundary: ReadingBoundary, claim: string,
  evidence: readonly string[], kind: 'statement' | 'relation') {
  if (!session.deps.wikiEvidence) return unavailable('Native association citation owner is unavailable');
  const read = async () => {
    const rows = await readWikiClaimEvidence(session, [claim], kind, boundary);
    return (await projectWikiEvidence(session, (rows.get(claim) ?? []).filter(row => evidence.includes(row.id))))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  };
  const value = await read();
  session.observeDependency(`native-association-evidence:${kind}:${claim}`, value, read);
  return value;
}

async function projectedStatement(session: WorkReadSession, selection: AssociationSelection, boundary: ReadingBoundary,
  value: Adopted): Promise<AssociationStatement | null> {
  const evidence = await citations(session, boundary, value.statement, value.evidence, 'statement');
  if (!evidence.length) return unavailable('Native association exact Statement citation support is unavailable');
  const acceptance = contextOf(selection) === 'global' ? { kind: 'global' as const }
    : { kind: 'realm' as const, realm: contextOf(selection) };
  const adoption = await statementV2Acceptance(session.deps.environment, value, acceptance, session.position);
  if (adoption.result.state !== 'accepted') throw new StatementNotFound('Statement is unavailable');
  session.observeDependency(`native-association-decision:${value.statement}:${contextOf(selection)}`, adoption,
    () => statementV2Acceptance(session.deps.environment, value, acceptance, session.position));
  return { id: value.statement, revision: value.revision, subject: value.subject, predicate: value.predicate,
    value: value.value, occurrence: value.coverage.kind === 'subject-global' ? null : value.coverage.occurrence,
    context: selection.parameters.context, applicability: value.applicability, qualification: qualification(value),
    decisionRevision: adoption.result.decision, citations: evidence };
}

async function nativeWitness(session: WorkReadSession, selection: AssociationSelection, candidate: Candidate,
  boundary: ReadingBoundary, credit: NativeCredit | null): Promise<AssociationWitness | null> {
  let definition: ExactDefinition, state: Pick<OccurrenceState, 'participations' | 'applicability'>,
    revision: string, nativeEvidence: string[];
  let nativeRelation: Awaited<ReturnType<typeof readAttributedOccurrence>> | null = null, relationFields = true;
  if (candidate.family === 'credit') {
    if (!credit) return unavailable('Native credit exact owner is unavailable');
    definition = credit.definition; revision = credit.revision;
    state = { applicability: credit.state.applicability,
      participations: credit.state.participations.map(({ id: iri, ...part }) => ({ ...part, iri })) };
    nativeEvidence = [];
  } else {
    revision = candidate.revision!;
    const read = async () => {
      const owned = await readAttributedOccurrence(session.deps.environment, candidate.occurrence, revision);
      const exact = await readExactDefinition(session.deps.environment, owned.state.definition, systemDisclosure);
      if (!exact || exact.modelRevision !== PROFILES.definitionV2 || exact.lifecycle !== 'active') {
        return unavailable('Native association exact Definition is unavailable');
      }
      if (owned.state.lifecycle !== 'active') throw new StatementNotFound('Association is unavailable');
      validateAttributedOccurrenceIdentity(owned, exact);
      const supported = owned.state.participations.some(part => part.attributionSupports?.length);
      const principal = session.principal ?? namePolicyPrincipal(session.viewer);
      const actor = session.options.actingSubject ?? selection.presentation.actingSubject;
      if (supported && (!session.deps.relationAttribution || !principal || !actor)) {
        return { owned, exact, attribution: null, fields: false };
      }
      try {
        const attribution = await validateAttributedOccurrence(session.deps.environment, owned, exact,
          relationAttributionVerifier(session.deps.relationAttribution, principal, actor));
        return { owned, exact, attribution, fields: true };
      } catch (error) {
        if (!(error instanceof PendingActivation || error instanceof SemanticChangeRejected)) throw error;
        // An unavailable optional annotation cannot erase independently proved
        // native identity. No Source field is emitted without its current proof.
        return { owned, exact, attribution: null, fields: false };
      }
    };
    const current = await read();
    session.observeDependency(`native-association-owner:${candidate.occurrence}:${revision}`, current, read);
    definition = current.exact; state = current.owned.state;
    nativeRelation = current.owned; relationFields = current.fields;
    nativeEvidence = current.owned.state.evidence ? [current.owned.state.evidence] : [];
  }
  const binding = definition.association;
  if (!binding || binding.kind !== selection.parameters.kind) return null;
  const work = state.participations.filter(part => part.role === `${definition.definition}/role/${binding.workRole}`);
  const subject = state.participations.find(part => part.iri === candidate.subjectParticipation);
  if (work.length !== 1 || work[0]!.participant.kind !== 'resource') return unavailable('Native association Work role is unavailable');
  if (work[0]!.participant.ref !== candidate.work || !subject
    || !binding.subjectRoles.some(role => subject.role === `${definition.definition}/role/${role}`)) return null;
  const relationCoverage: RetainedStatementCoverage | null = nativeRelation ? {
    occurrence: candidate.occurrence, revision, definition, state: nativeRelation.state,
    guard: `GRAPH ${iri(GRAPHS.current)} { ${iri(candidate.occurrence)} a rv:RelationOccurrence ; rv:occurrenceHead ${iri(revision)} .
        ${iri(candidate.work)} a <https://schema.org/CreativeWork> }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RelationOccurrenceRevision ; rv:component ${iri(candidate.occurrence)} ;
        rv:manifest ${iri(nativeRelation.manifest)} ; rv:operation ${iri(nativeRelation.operation)} ; rv:lifecycle rv:Active }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(nativeRelation.receipt)} rv:outcome rv:Succeeded ;
        rv:component ${iri(candidate.occurrence)} ; rv:revision ${iri(revision)} }`,
    native: { receipt: nativeRelation.receipt, manifest: nativeRelation.manifest,
      modelGeneration: nativeRelation.modelGeneration, attribution: { scope: 'native-identity' } },
  } : null;
  const owners: StatementV2ReadOwners = { boundary, nativeCoverage: (occurrence, head) =>
    relationCoverage && occurrence === candidate.occurrence && head === revision ? Promise.resolve(relationCoverage)
      : nativeCreditStatementCoverage(session, occurrence, head) };
  const privateRead = async (context: string) => !!session.principal && !!session.options.actingSubject
    && !!session.deps.contextSelections && session.deps.contextSelections.canReadPrivate(session.principal, session.options.actingSubject, context);
  const readStatement = (statement: string, head: string) => readAdoptedStatementV2(session, statement, head,
    contextOf(selection), selection.parameters.frame, privateRead, owners);
  const assertion = await readAdoptedOccurrenceV2(session, candidate.occurrence, revision,
    contextOf(selection), selection.parameters.frame, privateRead, owners);
  const exactTraits = await traits(session, selection, candidate.occurrence, revision, subject.participant, subject.iri, readStatement);
  const statements: AssociationStatement[] = [];
  for (const value of exactTraits) {
    // An occurrence can have several subject-role allocations for one subject.
    // A trait belonging to the other allocation must not merge their witnesses.
    if (value.coverage.kind === 'participation' && value.coverage.participation !== subject.iri) continue;
    const projected = await projectedStatement(session, selection, boundary, value);
    if (projected) statements.push(projected);
  }
  const evidence = [...await citations(session, boundary, candidate.occurrence, nativeEvidence, 'relation'),
    ...await citations(session, boundary, assertion.statement, assertion.evidence, 'statement')];
  const byId = new Map(evidence.map(item => [item.id, item]));
  if (!byId.size) return unavailable('Native association exact citation support is unavailable');
  if (byId.size > ASSOCIATION_COST.citations) return unavailable('Native association citation response exceeds its bound');
  const readAttribution = async () => {
    if (!credit) return null;
    try { return { state: 'verified' as const, fields: await readNativeCreditAttribution(session, credit, selection.presentation.actingSubject) }; }
    catch (error) {
      if (!(error instanceof WorkReadUnavailable)) throw error;
      return { state: 'unsupported' as const, fields: credit.state.participations.map(part => ({ participation: part.id, currentFields: [] })) };
    }
  };
  const attribution = await readAttribution(), attributed = attribution?.fields;
  if (credit) session.observeDependency(`native-association-attribution-disposition:${candidate.occurrence}`, attribution, readAttribution);
  const nameOwners = state.participations.filter(part => part.creditedName && part.participant.kind === 'resource')
    .map(part => part.participant.kind === 'resource' ? part.participant.ref : '');
  const readNames = async () => [...await visibleNames(session.deps.personPreferences, nameOwners, session.viewer)].sort();
  const names = await readNames();
  if (nameOwners.length) session.observeDependency(`native-association-names:${candidate.occurrence}`, names, readNames);
  const participation = state.participations.map(({ iri: id, role, participant, position, creditedName, sourceIdentity }) => ({
    id, role, participant, ...(position === undefined ? {} : { position }),
    ...(relationFields && creditedName && (participant.kind !== 'resource' || names.includes(participant.ref))
      && (!attributed || attributed.find(part => part.participation === id)?.currentFields.includes('creditedName'))
      ? { creditedName } : {}),
    ...(relationFields && sourceIdentity && (!attributed || (['provider', 'namespace', 'key', 'alias', 'eid', 'note'] as const)
      .every(field => attributed.find(part => part.participation === id)?.currentFields.includes(field)))
      ? { sourceIdentity } : {}),
  }));
  const resources = [...new Set([candidate.work, ...(subject.participant.kind === 'resource' ? [subject.participant.ref] : [])])];
  const summaries = await session.summaries(resources);
  const label = (ref: string) => {
    const summary = summaries.find(item => item.reference === ref);
    return summary?.status === 'available' ? summary.name.value : null;
  };
  const body: AssociationWitness = { kind: binding.kind, work: candidate.work, occurrence: candidate.occurrence,
    revision, definition: definition.definition, workParticipation: work[0]!.iri, subjectParticipation: subject.iri,
    subject: subject.participant, role: subject.role, context: selection.parameters.context,
    applicability: [...state.applicability], qualification: qualification(assertion), participations: participation,
    statements, citations: [...byId.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    sourceVersionStatus: 'exact', labels: { work: label(candidate.work),
      subject: subject.participant.kind === 'resource' ? label(subject.participant.ref) : null, role: null },
    snippets: [], links: [{ rel: 'association', method: 'GET',
      href: `/v1/relations/${candidate.occurrence.slice(candidate.occurrence.lastIndexOf('/') + 1)}/revisions/${revision.slice(revision.lastIndexOf('/') + 1)}` }] };
  if (!Value.Check(associationWitness, body)) return unavailable('Native association witness projection is unavailable');
  return body;
}

/** Native primary API composition. No external library activation or imported
 * corpus attestation is used to serve a separately authored native occurrence. */
export async function readNativeAssociationPage(session: WorkReadSession, selection: AssociationSelection,
  surface: AssociationSurface, token?: string) {
  const model = await readActiveModelGeneration(session.deps.environment.fuseki);
  session.observeDependency('native-association-model', model, () => readActiveModelGeneration(session.deps.environment.fuseki));
  const boundary = new ReadingBoundary(session, selection.parameters.position);
  if (selection.parameters.frame.length) await readFrames(session, selection.parameters.frame);
  const nativeRoots = selection.parameters.roots?.flatMap(root => root.kind === 'resource' ? [root.ref] : []) ?? [];
  if (nativeRoots.length) {
    const roots = await session.summaries(nativeRoots);
    if (roots.length !== nativeRoots.length || roots.some(row => row.status !== 'available')) throw new WorkReadMissing('Association root is unavailable');
  }
  const { currentAssertion: _assertion, accountExpiresAt: _expiry, ...principal } =
    (namePolicyPrincipal(session.viewer) as VerifiedAccountAssertion | null) ?? {};
  const basis: AssociationReadBasis = { snapshot: { sourcePosition: { datasetId: 'product', ...session.position },
    modelGeneration: model.generation }, reader: { principal, viewer: session.viewer,
      actor: selection.presentation.actingSubject ?? null, languages: session.displayLanguages },
    dependencies: { nativeProfiles: ['relation-occurrence-v2', 'native-agent-credit-v1', 'native-agent-credit-v2',
      'work-author-credit-v1', 'work-author-credit-v2'], model } };
  const selected = new Map<string, { candidate: Candidate; credit: NativeCredit | null; readable: boolean }>();
  return readAssociationPage({
    async candidates(after, limit) {
      const page = await nativeAssociationCandidates(session, selection, after, limit), items: AssociationKey[] = [];
      for (const candidate of page.items) {
        const summaries = await session.summaries([candidate.work]);
        const readable = summaries.length === 1 && summaries[0]?.status === 'available';
        const credit = readable && candidate.family === 'credit'
          ? await readNativeCreditAssociation(session, candidate.occurrence, candidate.revision ?? undefined) : null;
        if (credit) candidate.subjectParticipation = credit.state.subjectParticipation;
        if (!readable && candidate.family === 'credit') candidate.subjectParticipation = null;
        selected.set(associationOrderKey(candidate), { candidate, credit, readable });
        items.push({ work: candidate.work, occurrence: candidate.occurrence, subjectParticipation: candidate.subjectParticipation });
      }
      return { items, more: page.more };
    },
    async witness(key) {
      const item = selected.get(associationOrderKey(key));
      if (!item) return unavailable('Native association candidate owner is unavailable');
      if (!item.readable) return null;
      try { return await nativeWitness(session, selection, item.candidate, boundary, item.credit); }
      catch (error) { if (error instanceof StatementNotFound || error instanceof StatementCoverageHidden) return null; throw error; }
    },
    async fence() {
      for (const item of selected.values()) if (item.credit) {
        const current = await readNativeCreditAssociation(session, item.candidate.occurrence, item.credit.revision);
        if (associationCanonical(current) !== associationCanonical(item.credit)) throw new WorkReadMoved('Native credit association changed');
      }
      await boundary.fence();
    },
  }, selection, basis, surface, token);
}
