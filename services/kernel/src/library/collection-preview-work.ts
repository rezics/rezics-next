import type { Actor } from '../request/access.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import type { CollectionPreview, PreviewParent } from './collection-preview.ts';

type Parent = PreviewParent & { curatorAccountId: string | null };
export type PreviewPreparationDependencies = PresentationDependencies;

/** Collection list previews stay read-only; the common Members GET owns derived preparation. */
export function createCollectionPreviewPreparation(_deps: PreviewPreparationDependencies) {
  return async (
    _actor: Actor,
    _parents: readonly Parent[],
    _previews: ReadonlyMap<string, CollectionPreview>,
    _deadline: number,
  ): Promise<void> => undefined;
}
