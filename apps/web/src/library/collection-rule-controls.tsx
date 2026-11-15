import { cn } from '@rezics/ui/utils';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { savedQueryRuleReturn } from './saved-query-results';

/** A confirmed create leaves the new-rule address through an explicit saved-resource link. */
export function CollectionRuleControls({
  creating,
  pending,
  conflict,
  uncertain = false,
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
  uncertain?: boolean;
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
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          className="h-auto min-h-7 max-w-full whitespace-normal"
          aria-busy={pending}
          disabled={pending || conflict || !hasFilter || !!savedId}
        >
          {pending
            ? m.library_collection_save_pending()
            : savedId
              ? m.library_rule_confirmed_action()
              : uncertain
                ? creating
                  ? m.library_rule_retry_create_original()
                  : m.library_rule_retry_save_original()
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
            className={cn(buttonVariants({ variant: 'link' }), 'h-auto min-h-7 max-w-full whitespace-normal')}
            href={`/${getLocale()}/collections/${encodeURIComponent(id!)}/rule`}
          >
            {m.library_rule_edit()}
          </a>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-7 max-w-full whitespace-normal"
            disabled={pending}
            onClick={refresh}
          >
            {conflict ? m.library_rule_review_current_read() : m.library_collection_reload()}
          </Button>
        )}
      </div>
      {href && (
        <a
          className={cn(
            buttonVariants({ variant: savedId ? 'default' : 'link' }),
            'h-auto min-h-7 max-w-full whitespace-normal',
          )}
          href={href}
        >
          {m.library_rule_members()}
        </a>
      )}
    </>
  );
}
