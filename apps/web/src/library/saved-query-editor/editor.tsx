import { CollectionRuleCurrent } from '../collection-rule-current';
import type { RulePage } from '../collection-rule-read';
import { SavedQueryCorrection } from './correction';
import { savedQuerySeed, type SavedQuerySelection } from './selection';

/** Review a carried selection, then the existing rule editor. Invalid selections never POST. */
export function SavedQueryEditor({
  page,
  collectionId,
  selection,
  originHref,
  navigate,
}: {
  page: RulePage;
  collectionId: string | null;
  selection: SavedQuerySelection;
  originHref?: string | null;
  navigate?: (id: string) => void;
}) {
  if (collectionId === null && selection.state === 'invalid')
    return <SavedQueryCorrection selection={selection} originHref={originHref ?? null} />;
  const seed = savedQuerySeed(collectionId, selection);
  return (
    <CollectionRuleCurrent
      page={page}
      collectionId={collectionId}
      {...(seed ? { seed } : {})}
      {...(navigate ? { navigate } : {})}
    />
  );
}
