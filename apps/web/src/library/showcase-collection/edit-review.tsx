import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageText } from '../../features/pages/shared';
import { libraryTitleValue } from '../title';
import { buildCollectionMemberEditPlan } from '../collection-editor';
import type { CollectionMember, CollectionVisibility } from '../reads';
import type { CollectionTypeOption } from '../collection-presentation';
import { PresentationChangeSummary } from '../collection-presentation-review/choice-summary';
import { presentationTypeChoice } from '../collection-presentation-review/model';

/** Review is derived from the same loaded occurrence plan as Save; it never dispatches a command. */
export function CollectionEditReview({
  initial,
  desired,
  firstPage,
  title,
  description,
  kind,
  types,
  visibility,
  savedKind = kind,
  savedCoverMediaId = null,
  coverMediaId = savedCoverMediaId,
}: {
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  firstPage: boolean;
  title: string;
  description: string;
  kind: string | null;
  types?: readonly CollectionTypeOption[] | null | undefined;
  visibility: CollectionVisibility | null;
  savedKind?: string | null;
  savedCoverMediaId?: string | null;
  coverMediaId?: string | null;
}) {
  const operations = buildCollectionMemberEditPlan(initial, desired, firstPage);
  function occurrence(id: string) {
    const index = initial.findIndex((member) => member.id === id);
    const member = initial[index];
    const label = member?.subject
      ? pageText(libraryTitleValue(member.subject.label), getLocale()).text
      : m.library_subject_unavailable();
    return m.library_member_occurrence({ title: label, position: index + 1 });
  }
  return (
    <section
      className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-6"
      data-collection-edit-review
    >
      <h2 className="font-semibold">{m.collection_review_heading()}</h2>
      <p className="font-medium whitespace-pre-wrap">{title}</p>
      {description ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{description}</p> : null}
      <p className="text-sm">
        {visibility === 'public'
          ? m.library_visibility_public()
          : visibility === 'unlisted'
            ? m.library_visibility_unlisted()
            : m.library_visibility_private()}
      </p>
      <PresentationChangeSummary
        savedType={presentationTypeChoice(savedKind, savedKind, types, undefined)}
        draftType={presentationTypeChoice(savedKind, kind, types, undefined)}
        coverChanged={savedCoverMediaId !== coverMediaId}
        savedCoverLabel={
          savedCoverMediaId === null ? m.collection_choice_cover_automatic() : m.collection_choice_cover_explicit()
        }
        draftCoverLabel={
          coverMediaId === null ? m.collection_choice_cover_automatic() : m.collection_choice_cover_explicit()
        }
      />
      {operations.length ? (
        <ul className="space-y-2 text-sm">
          {operations.map((operation, index) => (
            <li key={`${operation.kind}:${operation.memberId}:${index}`} data-review-occurrence={operation.memberId}>
              {operation.kind === 'move'
                ? operation.after === null
                  ? m.collection_review_move_start({ title: occurrence(operation.memberId) })
                  : m.collection_review_move_after({
                      title: occurrence(operation.memberId),
                      anchor: occurrence(operation.after),
                    })
                : `${operation.kind === 'note' ? m.library_member_note() : m.library_member_remove()}: ${occurrence(operation.memberId)}`}
              {operation.kind === 'note' && operation.note ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{operation.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.collection_review_native_help()}</p>
    </section>
  );
}
