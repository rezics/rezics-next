import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import {
  CollectionMemberDetails as CollectionSubjectDetails,
  CollectionMemberViewerDetails,
} from './collection-member-row';
import { CollectionNoteReader } from './collection-note-reader';
import type { CollectionComparisonDefinitions } from './collection-comparison/model';
import type { CollectionListPresentations } from './collection-presentation';
import type { CollectionPositionScope } from './collection-public-reading/position';
import type { CollectionMember } from './reads';
import type { CollectionViewerProjection } from './collection-viewer/model';

export type CollectionReadMember = {
  id?: string;
  subjectId?: string;
  viewerRowKey?: string;
  subject: CollectionMember['subject'];
  facts?: CollectionMember['facts'];
  note?: string | null;
};

export function collectionPositionScopeMessage(scope: CollectionPositionScope): string {
  switch (scope) {
    case 'first':
      return m.library_collection_position_first();
    case 'continued':
      return m.library_collection_position_continued();
    case 'filtered-first':
      return m.library_collection_position_filtered_first();
    case 'filtered-continued':
      return m.library_collection_position_filtered_continued();
  }
}

export function CollectionMemberOccurrenceDetails<Member extends CollectionReadMember>({
  member,
  position,
  scope,
  pageKey,
  noteStateKey,
  noteExpanded,
  onNoteExpandedChange,
  currentHref,
  listPresentations,
  comparisonDefinitions,
  onReferenceNavigate,
  viewerProjection,
  actionHref,
}: {
  member: Member;
  position: number;
  scope: CollectionPositionScope;
  pageKey: string;
  noteStateKey: string;
  noteExpanded: boolean;
  onNoteExpandedChange: (expanded: boolean) => void;
  currentHref?: string;
  listPresentations?: CollectionListPresentations;
  comparisonDefinitions?: CollectionComparisonDefinitions;
  onReferenceNavigate?: (anchor: HTMLAnchorElement) => void;
  viewerProjection?: CollectionViewerProjection;
  actionHref?: string;
}) {
  const locale = getLocale();
  const subject = member.subject;
  const title = subject?.label
    ? pageText(libraryTitleValue(subject.label), locale).text || m.subject_value_unlabelled()
    : subject
      ? m.subject_value_unlabelled()
      : m.library_subject_unavailable();
  const occurrence = m.library_member_occurrence({ title, position });
  const pagePosition = m.library_collection_position_on_page({ position });
  const occurrenceId = member.id ? `collection-member-${member.id}` : undefined;

  return (
    <div
      id={occurrenceId}
      tabIndex={member.id ? -1 : undefined}
      role="group"
      aria-label={`${occurrence}. ${pagePosition}`}
      data-collection-member-id={member.id}
      data-collection-occurrence-availability={subject ? 'available' : 'unavailable'}
      data-collection-page-scope={scope}
      className="min-w-0 space-y-2 [overflow-wrap:anywhere]"
    >
      <p data-slot="collection-member-position" className="text-xs text-muted-foreground">
        {pagePosition}
      </p>
      {subject ? (
        <>
          <CollectionSubjectDetails
            member={member}
            listPresentations={listPresentations}
            comparisonDefinitions={comparisonDefinitions}
            currentHref={currentHref}
            onReferenceNavigate={onReferenceNavigate}
          />
          {!subject.typeLabel ? (
            <p data-collection-type-state="unavailable" className="text-sm text-muted-foreground">
              {m.library_collection_type_unavailable()}
            </p>
          ) : null}
          {viewerProjection ? (
            <CollectionMemberViewerDetails
              member={member}
              projection={viewerProjection}
              {...(actionHref ? { actionHref } : {})}
            />
          ) : null}
        </>
      ) : (
        <p data-collection-subject-state="unavailable" className="text-sm text-muted-foreground">
          {m.library_subject_unavailable()}
        </p>
      )}
      {member.note ? (
        <CollectionNoteReader
          key={`${pageKey}:${noteStateKey}`}
          note={member.note}
          previewLines={4}
          occurrence={occurrence}
          expanded={noteExpanded}
          onExpandedChange={onNoteExpandedChange}
        />
      ) : null}
    </div>
  );
}
