import type { AccessClient, Actor } from '../request/access.ts';
import { type RevisionDisclosureLookupInput, type RevisionDisclosureMembership, type RevisionDisclosureObservation, type RevisionDisclosureReadDependencies, type RevisionDisclosureReaderGate, type RevisionDisclosureReaderIntent } from './revision-disclosure-model.ts';
export type RevisionDisclosureReadContext = Readonly<{
    deadline: number;
    actor: Actor;
}>;
/** Exact issued consent. Revoked rows are visible to the issuer only as revoked. */
export declare function readRevisionDisclosure(deps: RevisionDisclosureReadDependencies, disclosureId: string, context: RevisionDisclosureReadContext): Promise<RevisionDisclosureObservation>;
/** Indexed full-key lookup for the live issued consent. */
export declare function lookupRevisionDisclosure(deps: RevisionDisclosureReadDependencies, input: RevisionDisclosureLookupInput, context: Pick<RevisionDisclosureReadContext, 'deadline'>): Promise<RevisionDisclosureObservation | null>;
/**
 * Current source-home observation of an issued consent. Consent itself grants
 * no read. Catalogue mismatch, incarnation change, erasure, protected state
 * and digest mismatch fail closed.
 */
export declare function observeIssuedRevisionDisclosure(deps: RevisionDisclosureReadDependencies, input: RevisionDisclosureLookupInput, context: Pick<RevisionDisclosureReadContext, 'deadline'>): Promise<RevisionDisclosureObservation | null>;
/**
 * Public sources keep the installed eligibility path. This helper never issues
 * consent and never treats a consent row as public eligibility.
 */
export declare function publicRevisionDisclosureBaseline(visibility: string): 'public-eligibility' | 'consent-required' | 'denied';
/**
 * Typed receiving seam for Book membership. The membership object is Book-owned
 * and is not a writable caller field. This function does not authorize bytes.
 */
export declare function revisionDisclosureReaderGate(observation: RevisionDisclosureObservation, membership: RevisionDisclosureMembership): RevisionDisclosureReaderGate | null;
/** Shape Book will pass after it proves publication membership internally. */
export declare function revisionDisclosureReaderIntent(observation: RevisionDisclosureObservation, membership: RevisionDisclosureMembership): RevisionDisclosureReaderIntent | null;
export declare function revisionDisclosureStillIssued(client: AccessClient, disclosureId: string): Promise<boolean>;
