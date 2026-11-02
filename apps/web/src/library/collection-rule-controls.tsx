import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

/** A confirmed create leaves the new-rule address through an explicit saved-resource link. */
export function CollectionRuleControls({
  creating,
  pending,
  conflict,
  hasFilter,
  savedId,
  collectionId,
  refresh,
}: {
  creating: boolean;
  pending: boolean;
  conflict: boolean;
  hasFilter: boolean;
  savedId: string | null;
  collectionId: string | null;
  refresh(): void;
}) {
  const id = savedId ?? collectionId;
  const href = id ? `/${getLocale()}/collections/${encodeURIComponent(id)}` : null;
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || conflict || !hasFilter || !!savedId}>
          {pending
            ? m.library_collection_save_pending()
            : creating
              ? m.library_collection_create()
              : m.library_collection_save()}
        </Button>
        {creating && savedId ? (
          <a href={`${href}/rule`}>{m.library_rule_edit()}</a>
        ) : (
          <Button type="button" variant="outline" disabled={pending} onClick={refresh}>
            {m.library_collection_reload()}
          </Button>
        )}
      </div>
      {href && <a href={href}>{m.library_rule_members()}</a>}
    </>
  );
}
