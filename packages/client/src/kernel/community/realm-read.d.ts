import type { ResourceEligibility } from '../access/index.ts';
import type { AccessCheck, AccessClient, Actor, Resource } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { type CommunityAmbient } from './ambient.ts';
import type { RealmDependencies, RealmView } from './realm.ts';
import read from './realm-read.sql.d.ts';
/** Exact current source for a composed management read. The caller owns disclosure,
 * management, partition and lifecycle checks on this same snapshot. */
export declare function readRealmSettingsHead(client: Parameters<typeof read.run>[0], realmId: string, at: string): Promise<RealmView | null>;
/** One head seek at Access's authoritative T, with the native grant branch
 * and no current ban required for protected Realms. Missing and denied resources both return null.
 */
export declare function readRealm(deps: Pick<RealmDependencies, 'pool' | 'access'> & Partial<CommunityAmbient>, actor: Actor, realmId: string, context: {
    deadline: number;
}): Promise<RealmView | null>;
/** Boolean Realm-read checks conceal eligibility not_found as a closed miss. */
export declare function allowRealmRead(check: AccessCheck, client: AccessClient, time?: AuthoritativeTime): Promise<boolean>;
export declare function realmReadEligibility(identity: Resource): ResourceEligibility;
export declare const realmViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource;
