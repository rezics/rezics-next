import { m } from '../../paraglide/messages.js';
import type { CollectionMember } from '../reads';
import { loadedCoverAvailability } from './model';

/** A bounded explanation of the existing selector, not a media inventory or permission check. */
export function CoverAvailability({ members }: { members: readonly CollectionMember[] }) {
  const availability = loadedCoverAvailability(members);
  return (
    <details className="min-w-0 rounded-lg border border-border p-3" data-cover-availability>
      <summary className="min-h-11 cursor-pointer py-2 font-medium">
        {m.collection_choice_cover_availability_heading()}
      </summary>
      <div className="space-y-4 pt-2">
        <p className="text-sm text-muted-foreground">{m.collection_choice_cover_availability_scope()}</p>
        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 space-y-1 rounded-lg bg-muted/40 p-3">
            <dt className="font-medium">{m.collection_choice_eligible_covers_label()}</dt>
            <dd>{m.collection_choice_eligible_covers_count({ count: availability.eligible })}</dd>
            <dd className="text-muted-foreground">{m.collection_choice_eligible_covers_help()}</dd>
          </div>
          {availability.missing ? (
            <div className="min-w-0 space-y-1 rounded-lg bg-muted/40 p-3">
              <dt className="font-medium">{m.collection_choice_missing_covers_label()}</dt>
              <dd>{m.collection_choice_cover_occurrences_count({ count: availability.missing })}</dd>
              <dd className="text-muted-foreground">{m.collection_choice_missing_covers_help()}</dd>
            </div>
          ) : null}
          {availability.withheld ? (
            <div className="min-w-0 space-y-1 rounded-lg bg-muted/40 p-3">
              <dt className="font-medium">{m.collection_choice_withheld_covers_label()}</dt>
              <dd>{m.collection_choice_cover_occurrences_count({ count: availability.withheld })}</dd>
              <dd className="text-muted-foreground">{m.collection_choice_withheld_covers_help()}</dd>
            </div>
          ) : null}
          {availability.unsupported ? (
            <div className="min-w-0 space-y-1 rounded-lg bg-muted/40 p-3">
              <dt className="font-medium">{m.collection_choice_unsupported_covers_label()}</dt>
              <dd>{m.collection_choice_cover_occurrences_count({ count: availability.unsupported })}</dd>
              <dd className="text-muted-foreground">{m.collection_choice_unsupported_covers_help()}</dd>
            </div>
          ) : null}
          {availability.unavailable ? (
            <div className="min-w-0 space-y-1 rounded-lg bg-muted/40 p-3">
              <dt className="font-medium">{m.library_subject_unavailable()}</dt>
              <dd>{m.collection_choice_cover_occurrences_count({ count: availability.unavailable })}</dd>
              <dd className="text-muted-foreground">{m.collection_choice_unavailable_member_help()}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-sm text-muted-foreground">{m.collection_choice_failed_cover_help()}</p>
        <p className="text-sm text-muted-foreground">{m.collection_choice_cover_selection_survives()}</p>
      </div>
    </details>
  );
}
