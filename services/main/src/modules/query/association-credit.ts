import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { namePolicyPrincipal } from '../disclosure/viewer.ts';
import {
  fenceRetainedCreditAssociationRead, openRetainedCreditAssociationRead,
  readRetainedCreditAssociationCandidates, readRetainedCreditAssociationView,
  RetainedCreditReadMoved, RetainedCreditReadUnavailable,
  type RetainedCreditAssociationReadBasis, type RetainedCreditAssociationReadDependencies,
  type RetainedCreditAssociationReadOwners, type RetainedCreditAssociationView,
} from '../work/credit-association-read.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { associationWitness, type AssociationSelection, type AssociationWitness,
  type AssociationCreditProjection } from './association-contract.ts';
import { AssociationStaleQuery, associationOrderKey, type AssociationFrontier,
  type AssociationKey, type AssociationReadBasis, type AssociationSurface } from './association-cursor.ts';
import { readAssociationPage, type AssociationPageSource } from './association-page.ts';
import { associationCanonical } from './association-selection.ts';

/** Two sealed views per window. Every view and its closing validation consume
 * the enclosing WorkReadSession's call/byte/deadline allocation. This is a
 * resumable physical window, never a catalogue population or public page cap. */
export const CREDIT_ASSOCIATION_WINDOW = 2;

/** Relation/Statement, frame and evidence owners supply the already disclosed,
 * adopted projection for this exact sealed view. Query constructs identity and
 * attribution only from the credit reader. A missing owner is unavailable.
 *
 * basis() must admit explicit roots/Context/frame/position and return a current
 * validation token covering adoption, evidence/support and disclosure, including
 * an empty inventory. It is re-read at completion and binds continuation. No
 * implementation or permissive proof fallback is installed by this adapter. */
export interface CreditAssociationProjectionOwner {
  basis(session: WorkReadSession, selection: AssociationSelection,
    credit: RetainedCreditAssociationReadBasis): Promise<string>;
  read(session: WorkReadSession, selection: AssociationSelection,
    view: RetainedCreditAssociationView): Promise<AssociationCreditProjection | null>;
}
export interface AssociationReadOwners {
  retainedCredits?: RetainedCreditAssociationReadOwners;
  creditProjection?: CreditAssociationProjectionOwner;
}
function unavailable(message: string): never { throw new WorkReadUnavailable(message); }
function readerFor(session: WorkReadSession): VerifiedPrincipal {
  const principal = session.principal ?? namePolicyPrincipal(session.viewer);
  // The published credit reader currently requires a verified Account. Public
  // anonymous support belongs to that owner; never manufacture a principal.
  if (!principal) return unavailable('Anonymous retained credit reader is unavailable');
  return { issuer: principal.issuer, subject: principal.subject,
    ...(principal.emailVerified === undefined ? {} : { emailVerified: principal.emailVerified }),
    ...(principal.contentEvidence === undefined ? {} : { contentEvidence: structuredClone(principal.contentEvidence) }) };
}
const equal = (a: unknown, b: unknown) => associationCanonical(a) === associationCanonical(b);
function validation(view: RetainedCreditAssociationView | null) {
  if (!view) return null;
  return { head: view.associationHead, currentHead: view.currentAssociationHead,
    receipt: view.compatibilityReceipt, mapping: view.mappingValidation,
    coverage: view.coverage, source: view.sourceValidation, attribution: view.attribution };
}
function participations(view: RetainedCreditAssociationView): AssociationWitness['participations'] {
  return view.state.participations.map(({ attributionSupports: _supports, creditedName, sourceIdentity, ...participation }) => {
    const fields = view.attribution.find(item => item.participation === participation.id)?.currentFields ?? [];
    return { ...participation,
      ...(creditedName && fields.includes('creditedName') ? { creditedName } : {}),
      // A withdrawn field cannot become a fabricated null. Keep the native or
      // external participant tuple; omit this optional attribution as a unit.
      ...(sourceIdentity && (['provider', 'namespace', 'key', 'alias', 'eid', 'note'] as const)
        .every(field => fields.includes(field)) ? { sourceIdentity } : {}) };
  });
}
function witness(view: RetainedCreditAssociationView, projection: AssociationCreditProjection): AssociationWitness {
  const state = view.state;
  const subject = state.participations.find(item => item.id === state.subjectParticipation);
  if (!subject) return unavailable('Retained credit subject participation is unavailable');
  const covered = view.coverage.statements;
  if (projection.statements.length !== covered.length || new Set(projection.statements.map(item => item.id)).size !== covered.length
    || projection.statements.some(statement => !covered.some(exact => exact.statement === statement.id
      && exact.revision === statement.revision && exact.decisionRevision === statement.decisionRevision))) {
    return unavailable('Retained credit exact Statement projection is unavailable');
  }
  const result: AssociationWitness = { ...projection, kind: 'credit', work: state.work,
    occurrence: view.occurrence, revision: view.associationHead, definition: state.mapping.definition,
    workParticipation: state.workParticipation, subjectParticipation: state.subjectParticipation,
    subject: subject.participant, role: subject.role, context: state.context,
    applicability: state.applicability, qualification: state.qualification, participations: participations(view) };
  if (!Value.Check(associationWitness, result)) return unavailable('Retained credit witness is unavailable');
  return result;
}

/** Shared compatibility witness page for POST and opt-in credits GET. All
 * supplied operations are server owner composition, never request witnesses. */
export async function readRetainedCreditAssociationPage(session: WorkReadSession, selection: AssociationSelection,
  owners: AssociationReadOwners, surface: AssociationSurface, token?: string) {
  if (selection.parameters.kind !== 'credit') return unavailable('Native association reader is unavailable');
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    session.checkDeadline();
    try { const result = await operation(); session.checkDeadline(); return result; }
    catch (error) {
      if (error instanceof RetainedCreditReadMoved || error instanceof WorkReadMoved) throw new AssociationStaleQuery(selection);
      if (error instanceof RetainedCreditReadUnavailable) throw new WorkReadUnavailable(error.message, { cause: error });
      throw error;
    }
  };
  return guard(async () => {
    const deps: RetainedCreditAssociationReadDependencies = {
      environment: session.deps.environment, owners: owners.retainedCredits ?? {},
      canReadWork: async (_principal, work) => {
        session.checkDeadline();
        const summaries = await session.summaries([work]);
        return summaries.length === 1 && summaries[0]?.status === 'available';
      },
    };
    const credit = await openRetainedCreditAssociationRead(deps, readerFor(session));
    if (!deps.owners.mapping || !deps.owners.coverage || !deps.owners.origin || !deps.owners.attribution) {
      return unavailable('Credit mapping, adoption, origin or attribution owner is unavailable');
    }
    if (credit.sourcePosition.dataEpoch !== session.position.dataEpoch || credit.sourcePosition.sequence !== session.position.sequence) {
      throw new AssociationStaleQuery(selection);
    }
    const projection = owners.creditProjection;
    if (!projection) return unavailable('Credit Statement, frame and evidence projection is unavailable');
    const readBasis = async () => {
      const value = await projection.basis(session, structuredClone(selection), structuredClone(credit));
      if (!/^[0-9a-f]{64}$/.test(value)) return unavailable('Credit projection validation is unavailable');
      return value;
    };
    const projectionBasis = await readBasis();
    const basis: AssociationReadBasis = { snapshot: { sourcePosition: credit.sourcePosition,
      modelGeneration: credit.generation.generation }, reader: { principal: credit.reader,
      actor: selection.presentation.actingSubject ?? null, viewer: session.viewer, languages: session.displayLanguages },
      dependencies: { generation: credit.generation, activation: credit.activation, projection: projectionBasis } };
    const fenceBasis = async () => {
      await fenceRetainedCreditAssociationRead(deps, credit);
      if (await readBasis() !== projectionBasis) throw new AssociationStaleQuery(selection);
      return projectionBasis;
    };
    // Common completion also fences after graph and authority validation. No
    // nested workRead allocation or private authority is introduced here.
    session.observeDependency('credit-association-basis', projectionBasis, () => guard(fenceBasis));
    const selected = new Map<string, { view: RetainedCreditAssociationView | null;
      work: string; credit: string; associationHead: string }>();
    const source: AssociationPageSource = {
      async candidates(after, limit) {
        const roots = selection.parameters.direction === 'work-to-subject' ? selection.parameters.roots : undefined;
        let works = roots?.map(root => root.kind === 'resource' ? root.ref : unavailable('Invalid Work root'));
        if (after?.kind === 'matches') works = [after.key.work];
        if (after?.kind === 'work' && works) works = works.filter(work => work > after.work);
        if (works?.length === 0) return { items: [], more: false };
        const window = await readRetainedCreditAssociationCandidates(deps, { basis: credit, works,
          after: after ? seekAfter(after) : undefined, limit: Math.min(limit, CREDIT_ASSOCIATION_WINDOW,
            selection.parameters.projection === 'occurrence' ? selection.limit : CREDIT_ASSOCIATION_WINDOW) });
        const items: AssociationKey[] = [];
        for (const candidate of window.items) {
          session.checkDeadline();
          const view = await readRetainedCreditAssociationView(deps, { basis: credit, ...candidate });
          if (view && view.currentAssociationHead !== candidate.associationHead) throw new AssociationStaleQuery(selection);
          const key = { work: candidate.work, occurrence: candidate.credit,
            subjectParticipation: view?.state.subjectParticipation ?? null };
          selected.set(associationOrderKey(key), { view, ...candidate }); items.push(key);
        }
        return { items, more: window.more };
      },
      async witness(key) {
        const selectedView = selected.get(associationOrderKey(key));
        if (!selectedView) return unavailable('Credit candidate view is unavailable');
        if (!selectedView.view) return null;
        const projected = await projection.read(session, structuredClone(selection), structuredClone(selectedView.view));
        return projected ? witness(selectedView.view, projected) : null;
      },
      async fence() {
        for (const previous of selected.values()) {
          session.checkDeadline();
          const current = await readRetainedCreditAssociationView(deps, { basis: credit, work: previous.work,
            credit: previous.credit, associationHead: previous.associationHead });
          if (!equal(validation(previous.view), validation(current))) throw new AssociationStaleQuery(selection);
        }
        await fenceBasis();
      },
    };
    return readAssociationPage(source, selection, basis, surface, token);
  });
}
function seekAfter(frontier: AssociationFrontier) {
  return frontier.kind === 'work'
    // The owner orders native credit IDs. This is an upper seek bound, never a
    // participation/credit allocation or a displayed resource.
    ? { work: frontier.work, credit: 'https://rezics.com/id/ffffffff-ffff-ffff-ffff-ffffffffffff' }
    : { work: frontier.key.work, credit: frontier.key.occurrence };
}
