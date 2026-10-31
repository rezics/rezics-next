import type { Actor } from '../request/access.ts';
import type { WorkClient } from '../work/client.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import type { CollectionPreview, PreviewParent } from './collection-preview.ts';
type Parent = PreviewParent & {
    curatorAccountId: string | null;
};
export type PreviewPreparationDependencies = PresentationDependencies & {
    workClient?: () => Promise<WorkClient>;
};
/** The one common preparation owner supplies storage, intent atomicity and default continuation.
 * No result/read protocol is declared by MembersPreparation yet. Reservation is never read authority.
 */
export declare function createCollectionPreviewPreparation(deps: PreviewPreparationDependencies): (actor: Actor, parents: readonly Parent[], previews: ReadonlyMap<string, CollectionPreview>, deadline: number) => Promise<void>;
export {};
