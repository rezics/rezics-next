import { type ResourceEligibility } from '../access/eligibility.ts';
import type { ResourceEligibilityVerifyContext } from '../access/public-eligibility.ts';
import type { ReadDecisionEligibility } from '../request/access.ts';
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
export declare function subjectReadEligibility(resource: {
    route: number;
    id: string;
}, action?: string): ResourceEligibility;
