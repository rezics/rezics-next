import { type ResourceEligibility } from '../access/eligibility.ts';
import type { ResourceEligibilityVerifyContext } from '../access/public-eligibility.ts';
import type { Pool, PoolClient } from 'pg';
import type { AccessCheck, ReadDecisionEligibility, Resource } from '../request/access.ts';
type Identity = {
    route: number;
    id: string;
};
export type GlobalReadAction = 'subject:read' | 'definitions:read' | 'presentation:read';
export declare function globalReadEligibility(action: GlobalReadAction): ResourceEligibility;
/** Related-read floor for a bounded summary page: visibility alone, one exact subject point each. */
export declare function relatedReadVisibility(client: ResourceEligibilityVerifyContext<unknown>['client'], ids: readonly string[]): Promise<Readonly<Record<string, boolean>>>;
/** One ReadDecisions eligibility handle: the same points as related-read verify, declared once for the page. */
export declare function relatedReadDecisionEligibility(): ReadDecisionEligibility;
/** Related eligibility needs visibility alone; it never hydrates labels/history. */
export declare function relatedReadEligibility(resource: {
    route: number;
    id: string;
}, ids: readonly string[]): ResourceEligibility;
/** The detail reader owns this repeatable-read snapshot. Its identity row supplies the
 * same visibility and security revision as the public-floor point on this client. */
export declare function readAuthorizedSubjectIdentity(pool: Pool, client: PoolClient, route: number, subject: string, authorize: (client: PoolClient) => Promise<boolean>): Promise<{
    visibility: "visible" | "hidden" | "taken_down";
    securityRevision: string;
    redirect: string | null;
    partitionNo: number;
    epoch: number;
    position: string;
    revision: number | null;
} | null>;
export type SubjectDetailCheck = AccessCheck & {
    readonly termCandidate?: boolean;
};
/** Planning a signed Global detail can share its visibility preparation with the statement-presence probe.
 * The resource snapshot checks the hint before any statement audience is used. */
export declare function prepareSubjectDetailCheck(resource: Identity, planTerms: boolean, prepare: (resource: Resource) => Promise<AccessCheck>): Promise<SubjectDetailCheck>;
export declare function subjectReadEligibility(resource: {
    route: number;
    id: string;
}, action?: string, observeTermCandidate?: (candidate: boolean) => void): ResourceEligibility;
export {};
