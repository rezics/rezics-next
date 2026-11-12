import type { LibraryActor } from './actors.ts';
import type { CurrentObservation, FollowingSpaceDestination, LibraryTargetSummary } from './presentation.ts';
/** Original identities stay native; destinations are disclosed only by their current owner. */
export type FollowTargetType = 'subject' | 'collection' | 'space' | 'zone';
export type FollowDestination = FollowingSpaceDestination | Readonly<{
    kind: 'zone';
    zoneId: string;
}>;
export type NativeFollowProjection = Readonly<{
    target: LibraryTargetSummary;
    destination: FollowDestination;
}>;
/** Composition installs foreign native owners without making Library depend on their storage. */
export interface NativeFollowTargetAdapter {
    readonly targetType: 'zone';
    observe(actor: LibraryActor, id: string, deadline: number): Promise<CurrentObservation<NativeFollowProjection | null>>;
}
