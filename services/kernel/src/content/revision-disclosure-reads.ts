import type { AccessClient, Actor } from '../request/access.ts';
import { ContentNotFoundError } from './commands.ts';
import { snapshot } from './reads.ts';
import {
  revisionDisclosureRequiredFor,
  type RevisionDisclosureLookupInput,
  type RevisionDisclosureMembership,
  type RevisionDisclosureObservation,
  type RevisionDisclosureReadDependencies,
  type RevisionDisclosureReaderGate,
  type RevisionDisclosureReaderIntent,
} from './revision-disclosure-model.ts';
import {
  lookupIssuedRevisionDisclosure,
  observationOf,
  revisionDisclosureRow,
  revisionDisclosureSourceHome,
} from './revision-disclosure-store.ts';
import { observeRevisionDisclosureSource, revisionDisclosureSourceCurrent } from './revision-disclosure-source.ts';

export type RevisionDisclosureReadContext = Readonly<{ deadline: number; actor: Actor }>;

function deny(): never {
  throw new ContentNotFoundError();
}

/** Exact issued consent. Revoked rows are visible to the issuer only as revoked. */
export async function readRevisionDisclosure(
  deps: RevisionDisclosureReadDependencies,
  disclosureId: string,
  context: RevisionDisclosureReadContext,
): Promise<RevisionDisclosureObservation> {
  const row = (await snapshot(deps, disclosureId, context, (client) => revisionDisclosureRow(client, disclosureId)))
    .value;
  if (!row) deny();
  if (
    row.revoked_at !== null &&
    (context.actor.kind !== 'account' || context.actor.accountId !== row.issuer_account_id)
  )
    deny();
  return observationOf(row);
}

/** Indexed full-key lookup for the live issued consent. */
export async function lookupRevisionDisclosure(
  deps: RevisionDisclosureReadDependencies,
  input: RevisionDisclosureLookupInput,
  context: Pick<RevisionDisclosureReadContext, 'deadline'>,
): Promise<RevisionDisclosureObservation | null> {
  const route = revisionDisclosureSourceHome(input.target);
  if (route === null) return null;
  const row = (
    await snapshot(deps, input.target.postId, context, (client) =>
      lookupIssuedRevisionDisclosure(client, input.catalogueId, input.target),
    )
  ).value;
  return row ? observationOf(row) : null;
}

/**
 * Current source-home observation of an issued consent. Consent itself grants
 * no read. Catalogue mismatch, incarnation change, erasure, protected state
 * and digest mismatch fail closed.
 */
export async function observeIssuedRevisionDisclosure(
  deps: RevisionDisclosureReadDependencies,
  input: RevisionDisclosureLookupInput,
  context: Pick<RevisionDisclosureReadContext, 'deadline'>,
): Promise<RevisionDisclosureObservation | null> {
  const observation = await lookupRevisionDisclosure(deps, input, context);
  if (!observation || observation.state !== 'issued') return null;
  if (observation.catalogue.catalogueId !== input.catalogueId) return null;
  const live = (
    await snapshot(deps, input.target.postId, context, async (client) => {
      const source = await observeRevisionDisclosureSource(client, input.target);
      if (
        !source ||
        source.licence !== observation.licence ||
        source.creatorAccountId !== observation.issuerAccountId ||
        source.incarnation.postTransactionId !== observation.incarnation.postTransactionId ||
        source.incarnation.threadTransactionId !== observation.incarnation.threadTransactionId
      )
        return null;
      if (!(await revisionDisclosureSourceCurrent(client, source))) return null;
      return source;
    })
  ).value;
  return live ? observation : null;
}

/**
 * Public sources keep the installed eligibility path. This helper never issues
 * consent and never treats a consent row as public eligibility.
 */
export function publicRevisionDisclosureBaseline(
  visibility: string,
): 'public-eligibility' | 'consent-required' | 'denied' {
  if (visibility === 'published') return 'public-eligibility';
  if (revisionDisclosureRequiredFor(visibility)) return 'consent-required';
  return 'denied';
}

/**
 * Typed receiving seam for Book membership. The membership object is Book-owned
 * and is not a writable caller field. This function does not authorize bytes.
 */
export function revisionDisclosureReaderGate(
  observation: RevisionDisclosureObservation,
  membership: RevisionDisclosureMembership,
): RevisionDisclosureReaderGate | null {
  if (
    observation.state !== 'issued' ||
    observation.catalogue.catalogueId !== membership.catalogueId ||
    observation.target.revisionId !== membership.sourceRevisionId
  )
    return null;
  return { observation, membership };
}

/** Shape Book will pass after it proves publication membership internally. */
export function revisionDisclosureReaderIntent(
  observation: RevisionDisclosureObservation,
  membership: RevisionDisclosureMembership,
): RevisionDisclosureReaderIntent | null {
  const gate = revisionDisclosureReaderGate(observation, membership);
  if (!gate) return null;
  return {
    disclosureId: observation.disclosureId,
    target: observation.target,
    catalogueId: observation.catalogue.catalogueId,
    membership,
  };
}

export async function revisionDisclosureStillIssued(client: AccessClient, disclosureId: string): Promise<boolean> {
  const row = await revisionDisclosureRow(client, disclosureId);
  return row !== null && row.revoked_at === null;
}
