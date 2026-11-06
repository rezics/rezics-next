import type { SemanticDomainPorts } from '../contract/domain-ports.ts';
import { type IdentityCoordination } from './identity-coordination.ts';
import { type ItemApplication } from './item-application.ts';
import { type RatingReviewApplication } from './rating-review.ts';
import { type SubjectApplication } from './subject-application.ts';
export type SemanticDomain<Native, Tx = unknown> = Readonly<{
    version: 1;
    ports: SemanticDomainPorts<Native, Tx>;
    items: ItemApplication;
    subjects: SubjectApplication<Tx>;
    identity: IdentityCoordination<Native>;
    ratingReview: RatingReviewApplication;
}>;
/** Install the Semantic domain once. Only the named ports are kept; the installed object is frozen. */
export declare function createSemanticDomain<Native, Tx = unknown>(ports: SemanticDomainPorts<Native, Tx>): SemanticDomain<Native, Tx>;
