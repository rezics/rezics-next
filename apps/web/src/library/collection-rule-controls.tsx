import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { savedQueryRuleReturn } from './saved-query-results';

/** A confirmed create leaves the new-rule address through an explicit saved-resource link. */
export function CollectionRuleControls({
  creating,
  pending,
  conflict,
  hasFilter,
  savedId,
  collectionId,
  resultsHref,
  navigateAfterSave = false,
  refresh,
}: {
  creating: boolean;
  pending: boolean;
  conflict: boolean;
  hasFilter: boolean;
  savedId: string | null;
  collectionId: string | null;
  resultsHref?: string | undefined;
  navigateAfterSave?: boolean;
  refresh(): void;
}) {
  const id = savedId ?? collectionId;
  const href = id ? savedQueryRuleReturn(resultsHref, id, getLocale(), !!savedId) : null;
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || conflict || !hasFilter || !!savedId}>
          {pending
            ? m.library_collection_save_pending()
            : creating
              ? navigateAfterSave
                ? m.library_rule_create_and_view_results()
                : m.library_collection_create()
              : navigateAfterSave
                ? m.library_rule_save_and_view_results()
                : m.library_collection_save()}
        </Button>
        {creating && savedId ? (
          <a
            className="inline-flex min-h-11 items-center rounded-lg px-4 py-2 text-primary underline focus-visible:outline-2 focus-visible:outline-offset-2"
            href={`/${getLocale()}/collections/${encodeURIComponent(id!)}/rule`}
          >
            {m.library_rule_edit()}
          </a>
        ) : (
          <Button type="button" variant="outline" disabled={pending} onClick={refresh}>
            {conflict ? m.library_rule_review_current_read() : m.library_collection_reload()}
          </Button>
        )}
      </div>
      {href && (
        <a
          className="inline-flex min-h-11 items-center rounded-lg px-4 py-2 text-primary underline focus-visible:outline-2 focus-visible:outline-offset-2"
          href={href}
        >
          {m.library_rule_members()}
        </a>
      )}
    </>
  );
}
