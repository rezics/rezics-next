import type { ResourceEligibility } from '../access/index.ts';
import type { AccessCheck, AccessClient, Actor, Resource } from '../request/access.ts';
import { type CommunityAmbient } from './ambient.ts';
import type { Space, SpaceDependencies } from './space.ts';
/** One routed point read joining only the current exact revision. No authorization is implied. */
export declare function readSpace(client: AccessClient, spaceId: string, time: string): Promise<(Space & {
    lifecycleVersion: string;
}) | null>;
/** Read the Space and its exact Realm slot together. Callers supply Space authorization;
 * the derived Realm id always uses the ordinary Realm reader and its own authorization.
 */
export declare function readSpaceForViewer(deps: Pick<SpaceDependencies, 'pool' | 'access'> & Partial<CommunityAmbient>, actor: Actor, spaceId: string, time: string, context: {
    deadline: number;
}, check?: AccessCheck): Promise<(Space & {
    realmId: string | null;
}) | null>;
export declare function spaceReadEligibility(identity: Resource, clock?: () => Date): ResourceEligibility;
/** The read route's exact identity/head eligibility, batched by supplied full keys. */
export declare const spaceViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource;
