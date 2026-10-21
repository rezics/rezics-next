import { Value } from 'typebox/value';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import type { VerifiedAccountAssertion } from '../account/verify-assertion.ts';
import { namePolicyPrincipal } from '../disclosure/viewer.ts';
import { problemDefinition } from '../problem.ts';
import { readActiveModelGeneration } from '../semantic/generation-guard.ts';
import { PROFILES } from '../semantic/schema.ts';
import { readAdoptedOccurrenceV2, readAdoptedStatementV2 } from '../statement/v2-read.ts';
import { StatementNotFound } from '../statement/read.ts';
import { statementNativeId } from '../statement/v2-schema.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { publicWorkRead, workRead, WorkReadInvalid, WorkReadLimit,
  WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readExactDefinition, type ExactDefinition } from './change.ts';
import { readAttributedOccurrence, validateAttributedOccurrence } from './v2-read.ts';
import { canonicalAttribution } from './v2-schema.ts';
import { relationAttributionVerifier } from './attribution.ts';
import { associationEvidenceQuery, ASSOCIATION_EVIDENCE_COST, ASSOCIATION_EVIDENCE_PROFILE,
  type AssociationCitation, type AssociationEvidenceQuery, type AssociationEvidenceSelection } from './evidence-contract.ts';
import { AssociationEvidenceChanged, AssociationEvidenceCursorInvalid,
  assertAssociationEvidenceCursorBinding, issueAssociationEvidenceCursor,
  readAssociationEvidenceCursor, type AssociationEvidenceBasis } from './evidence-cursor.ts';
import { isAssociationEvidenceCitation } from './evidence-citation.ts';
import { readRetainedAssociationEvidenceOccurrence, type RetainedAssociationEvidenceOccurrence } from './evidence-retained.ts';

export interface AssociationEvidenceClaim {
  occurrence: (Awaited<ReturnType<typeof readAttributedOccurrence>> & { kind: 'native-relation' })
    | RetainedAssociationEvidenceOccurrence;
  definition: ExactDefinition;
  assertion: Awaited<ReturnType<typeof readAdoptedOccurrenceV2>>;
  statement: Awaited<ReturnType<typeof readAdoptedStatementV2>> | null;
}
export interface AssociationEvidenceWindow {
  items: AssociationCitation[];
  /** Opaque physical support frontier, including withheld positions. */
  after: string | null;
  complete: boolean;
}
/** Composition of the existing evidence owners. The basis covers all support
 * inventories, current rights and disclosure, including an empty inventory.
 * A missing owner cannot certify that a claim has no more support. No caller
 * supplies this reader, its coverage, or a conversion/provenance certificate. */
export interface AssociationEvidenceSupportReader {
  basis(session: WorkReadSession, selection: AssociationEvidenceSelection, claim: AssociationEvidenceClaim): Promise<string>;
  window(session: WorkReadSession, selection: AssociationEvidenceSelection, claim: AssociationEvidenceClaim,
    after: string | null, limit: number): Promise<AssociationEvidenceWindow>;
}
declare module '../../routes/dependencies.ts' {
  interface MainWorkDependencies { relationEvidence?: AssociationEvidenceSupportReader }
}

export function selectAssociationEvidence(occurrence: string, revision: string,
  input: AssociationEvidenceQuery): AssociationEvidenceSelection {
  if (!statementNativeId(occurrence) || !statementNativeId(revision) || !Value.Check(associationEvidenceQuery, input)) {
    throw new WorkReadInvalid('Invalid association evidence selection');
  }
  const { cursor: _cursor, ...query } = input;
  return { ...query, occurrence, revision, frame: [...query.frame ?? []].sort(),
    limit: Number(query.limit ?? ASSOCIATION_EVIDENCE_COST.citations) };
}

/** Resolve actual sealed native heads and independently adopted coverage. A
 * subject-global trait is explicit coverage, not a join inferred from a name. */
export async function readAssociationEvidenceClaim(session: WorkReadSession,
  selection: AssociationEvidenceSelection): Promise<AssociationEvidenceClaim> {
  if (selection.context !== 'global') await session.realm(selection.context);
  const { occurrence, revision } = selection, env = session.deps.environment;
  let owned: AssociationEvidenceClaim['occurrence'];
  const retained = await readRetainedAssociationEvidenceOccurrence(session, occurrence, revision);
  if (retained) owned = retained;
  else {
    const heads = await session.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(occurrence)} a rv:RelationOccurrence ; rv:occurrenceHead ?head .
    } } LIMIT 2`, 2);
    if (heads.length !== 1 || heads[0]?.head?.value !== revision) {
      if (heads.length === 1 && session.options.cursor) throw new WorkReadMoved('Association head changed');
      throw new WorkReadMissing('Association is unavailable');
    }
    const native = await readAttributedOccurrence(env, occurrence, revision);
    if (native.state.lifecycle !== 'active') throw new WorkReadMissing('Association is unavailable');
    owned = { ...native, kind: 'native-relation' };
  }
  const canReadPrivate = async (context: string) => !!session.principal && !!session.options.actingSubject
    && !!session.deps.contextSelections && session.deps.contextSelections.canReadPrivate(session.principal, session.options.actingSubject, context);
  const assertion = await readAdoptedOccurrenceV2(session, occurrence, revision, selection.context, selection.frame, canReadPrivate);
  const definition = owned.kind === 'retained-credit' ? owned.definition
    : await readExactDefinition(env, owned.state.definition, systemDisclosure);
  if (!definition?.association || definition.modelRevision !== PROFILES.definitionV2 || definition.lifecycle !== 'active') {
    throw new WorkReadUnavailable('Exact authored association definition is unavailable');
  }
  if (owned.kind === 'native-relation') {
    const native = owned;
    const revalidate = () => validateAttributedOccurrence(env, native, definition,
      relationAttributionVerifier(session.deps.relationAttribution, session.principal, session.options.actingSubject));
    const attribution = await revalidate();
    session.observeDependency(`association-evidence-attribution:${occurrence}:${revision}`, attribution, revalidate);
  }
  const participations = owned.kind === 'retained-credit'
    ? owned.state.participations.map(({ id: iri, ...part }) => ({ ...part, iri })) : owned.state.participations;
  let statement: AssociationEvidenceClaim['statement'] = null;
  if (selection.claim === occurrence) {
    if (selection.claimRevision !== revision) throw new WorkReadMissing('Association claim is unavailable');
  } else {
    statement = await readAdoptedStatementV2(session, selection.claim, selection.claimRevision,
      selection.context, selection.frame, canReadPrivate);
    const coverage = statement.coverage;
    if (coverage.kind === 'subject-global') {
      const subjectRoles = definition.association.subjectRoles.map(key => `${definition.definition}/role/${key}`);
      if (!participations.some(part => subjectRoles.includes(part.role)
        && canonicalAttribution(part.participant) === canonicalAttribution(statement!.subject))) {
        throw new WorkReadMissing('Association claim is unavailable');
      }
    } else if (coverage.occurrence !== occurrence || coverage.occurrenceRevision !== revision
      || coverage.kind === 'participation' && !participations.some(part => part.iri === coverage.participation)) {
      throw new WorkReadMissing('Association claim is unavailable');
    }
  }
  return { occurrence: owned, definition, assertion, statement };
}

function checkedWindow(window: AssociationEvidenceWindow, after: string | null, lastEvidence: string | null,
  limit: number): AssociationEvidenceWindow {
  if (!window || !Array.isArray(window.items) || window.items.length > limit
    || typeof window.complete !== 'boolean' || (window.complete ? window.after !== null
      : typeof window.after !== 'string' || !window.after || window.after === after)) {
    throw new WorkReadUnavailable('Association evidence owner frontier is unavailable');
  }
  const ids = window.items.map(item => item.id);
  if (window.items.some(item => !isAssociationEvidenceCitation(item)) || new Set(ids).size !== ids.length
    || ids.some((id, index) => index === 0 ? lastEvidence !== null && id <= lastEvidence : id <= ids[index - 1]!)) {
    throw new WorkReadUnavailable('Association evidence owner order is unavailable');
  }
  return window;
}

const evidenceReader = (session: WorkReadSession) => {
  const principal = namePolicyPrincipal(session.viewer);
  const { accountExpiresAt: _expiry, currentAssertion: _assertion, ...identity } = principal as VerifiedAccountAssertion ?? {};
  return { principal: principal ? identity : null, viewer: session.viewer,
    actingSubject: session.options.actingSubject ?? null, languages: session.displayLanguages };
};

/** One physical owner window per page. Hidden-only windows retain a cursor;
 * missing coverage and unfinished hydration never become complete empty pages. */
export async function readAssociationEvidencePage(session: WorkReadSession, selection: AssociationEvidenceSelection,
  claim: AssociationEvidenceClaim, owner: AssociationEvidenceSupportReader | undefined, cursor?: string) {
  if (!owner) throw new WorkReadUnavailable('Association evidence support coverage is unavailable');
  const model = await readActiveModelGeneration(session.deps.environment.fuseki);
  session.observeDependency('association-evidence-model', model, () => readActiveModelGeneration(session.deps.environment.fuseki));
  const support = await owner.basis(session, selection, claim);
  if (!/^[0-9a-f]{64}$/.test(support)) throw new WorkReadUnavailable('Association evidence support basis is unavailable');
  session.observeDependency(`association-evidence-supports:${selection.claim}:${selection.claimRevision}`, support,
    () => owner.basis(session, selection, claim));
  const basis: AssociationEvidenceBasis = { sourcePosition: { ...session.position }, modelGeneration: model.generation,
    reader: evidenceReader(session),
    dependencies: { support, model, occurrence: { receipt: claim.occurrence.receipt, manifest: claim.occurrence.manifest,
      ...(claim.occurrence.kind === 'retained-credit' ? { retained: { publicView: claim.occurrence.publicView,
        sourceValidation: claim.occurrence.sourceValidation, attribution: claim.occurrence.attribution } } : {}) },
      assertion: claim.assertion, statement: claim.statement } };
  const { after, lastEvidence, expiresAt } = readAssociationEvidenceCursor(cursor, selection, basis);
  const read = async () => checkedWindow(await owner.window(session, selection, claim, after, selection.limit),
    after, lastEvidence, selection.limit);
  const page = await read();
  session.observeDependency(`association-evidence-window:${selection.claim}:${after ?? ''}`, page, read);
  const result = { profile: ASSOCIATION_EVIDENCE_PROFILE, occurrence: selection.occurrence, revision: selection.revision,
    claim: selection.claim, claimRevision: selection.claimRevision,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: session.position.dataEpoch,
      sequence: session.position.sequence }, modelGeneration: model.generation,
    items: page.items, nextCursor: page.complete ? null : issueAssociationEvidenceCursor(selection, basis, page.after!, expiresAt,
      page.items.at(-1)?.id ?? lastEvidence),
    complete: page.complete, count: { value: page.items.length, kind: 'exact-page' as const, total: null } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > ASSOCIATION_EVIDENCE_COST.bytes) {
    throw new WorkReadLimit('Association evidence response exceeds its bound');
  }
  return result;
}

export async function executeAssociationEvidence(deps: MainWorkDependencies, request: Request, occurrence: string,
  revision: string, input: AssociationEvidenceQuery): Promise<Response> {
  const selection = selectAssociationEvidence(occurrence, revision, input);
  const operation = async (session: WorkReadSession) => {
    if (selection.actingSubject && !session.principal) throw new AccountAssertionDenied('Authentication is required');
    assertAssociationEvidenceCursorBinding(input.cursor, selection, evidenceReader(session), session.position);
    const claim = await readAssociationEvidenceClaim(session, selection);
    return readAssociationEvidencePage(session, selection, claim, deps.relationEvidence, input.cursor);
  };
  const options = { actingSubject: selection.actingSubject, cursor: input.cursor, limit: selection.limit };
  try {
    const result = selection.context === 'global' && !selection.actingSubject
      ? await publicWorkRead(deps, request, { cursor: input.cursor, limit: selection.limit }, operation)
      : await workRead(deps, request, options, operation);
    return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof WorkReadMoved) throw new AssociationEvidenceChanged(selection);
    throw error;
  }
}

export function associationEvidenceFailure(error: unknown): Response | undefined {
  const failure = error instanceof AssociationEvidenceCursorInvalid
    ? problemDefinition(400, 'invalid_cursor', 'Association evidence cursor is invalid')
    : error instanceof AssociationEvidenceChanged
      ? problemDefinition(409, 'stale_query_result', 'Association evidence changed; restart the selection')
      : error instanceof WorkReadMissing || error instanceof StatementNotFound
        ? problemDefinition(404, 'relation_unavailable', 'Association evidence is unavailable')
        : error instanceof WorkReadInvalid
          ? problemDefinition(422, 'invalid_relation_read', 'Association evidence selection is invalid')
          : error instanceof WorkReadLimit || error instanceof WorkReadUnavailable
            ? problemDefinition(503, 'query_budget_exceeded', 'Association evidence is unavailable') : null;
  if (!failure) return undefined;
  return Response.json({ ...failure.body, ...(error instanceof AssociationEvidenceChanged ? { restart: error.restart } : {}) },
    { status: failure.body.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}
