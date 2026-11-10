import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import {
  CollectionMemberDetails as CollectionSubjectDetails,
  CollectionMemberViewerDetails,
} from './collection-member-row';
import { isLikedCollection, LikedMemberScore } from './liked';
import {
  collectionComparisonFacts,
  collectionComparisonHref,
  type CollectionComparisonDefinitions,
} from './collection-comparison/model';
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

/** A short, supplied summary. Reference destinations and complete evidence live in the opened detail. */
export function CollectionMemberSummary({
  member,
  listPresentations,
  comparisonDefinitions,
}: {
  member: CollectionReadMember;
  listPresentations?: CollectionListPresentations | undefined;
  comparisonDefinitions?: CollectionComparisonDefinitions | undefined;
}) {
  if (!member.subject) return <p className="text-sm text-muted-foreground">{m.library_subject_unavailable()}</p>;
  const facts = collectionComparisonFacts(member, listPresentations, comparisonDefinitions, getLocale());
  const state =
    member.facts === undefined
      ? 'unknown'
      : facts.length
        ? 'supplied'
        : Object.values(member.facts).some((values) => values.length)
          ? 'unavailable'
          : 'empty';
  return (
    <div className="min-w-0 space-y-1 text-sm text-muted-foreground">
      <p data-collection-type-state={member.subject.typeLabel ? 'available' : 'unavailable'}>
        {member.subject.typeLabel || m.library_collection_type_unavailable()}
      </p>
      <div data-slot="member-list-row-facts" data-context-state={state}>
        {facts.length ? (
          <p className="line-clamp-2 [overflow-wrap:anywhere]">
            {facts.slice(0, 2).map((fact, index) => (
              <span key={`${fact.property}:${index}`} lang={fact.lang}>
                {index ? ' · ' : ''}
                {fact.text}
              </span>
            ))}
          </p>
        ) : (
          <p>
            {state === 'unknown'
              ? m.catalogue_context_unknown()
              : state === 'unavailable'
                ? m.catalogue_context_unavailable()
                : m.catalogue_context_absent()}
          </p>
        )}
        {facts.length && comparisonDefinitions === undefined ? <p>{m.catalogue_context_unavailable()}</p> : null}
      </div>
      {member.note ? <p data-collection-note-available>{m.collection_reading_note_available()}</p> : null}
    </div>
  );
}

/** Keep current personal permissions/outcomes beside the action, including outside a tile's action row. */
export function CollectionMemberActionEvidence({
  member,
  viewerProjection,
  actionHref,
  collection,
}: {
  member: CollectionReadMember;
  viewerProjection?: CollectionViewerProjection | undefined;
  actionHref?: string | undefined;
  collection?: { builtinKind?: string | null } | undefined;
}) {
  if (!viewerProjection) return null;
  return collection && isLikedCollection(collection) ? (
    <LikedMemberScore
      collection={collection}
      member={member}
      projection={viewerProjection}
      {...(actionHref ? { actionHref } : {})}
    />
  ) : (
    <CollectionMemberViewerDetails
      member={member}
      projection={viewerProjection}
      {...(actionHref ? { actionHref } : {})}
    />
  );
}

/** Clipboard is an external boundary: denied/unavailable writes keep an explicit outcome by their exact action. */
export function CollectionReferenceCopy({
  id,
  href,
  label,
  write,
}: {
  id: string;
  href: string;
  label: string;
  write?: (() => void | Promise<void>) | undefined;
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'copied' | 'unavailable'>('idle');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function copy() {
    setState('pending');
    try {
      if (write) await write();
      else await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      if (active.current) setState('copied');
    } catch {
      if (active.current) setState('unavailable');
    }
  }
  return (
    <div data-collection-reference-id={id} className="min-w-0 space-y-1 py-1">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{id}</p>
      <Button
        type="button"
        variant="link"
        disabled={state === 'pending'}
        data-copy-reference={id}
        aria-label={`${m.collection_reading_copy_reference()}: ${label} (${id})`}
        className="h-auto min-h-11 min-w-11 max-w-full justify-start whitespace-normal px-0 text-left"
        onClick={() => void copy()}
      >
        {m.collection_reading_copy_reference()}
      </Button>
      <p role="status" className="text-sm text-muted-foreground">
        {state === 'pending'
          ? m.collection_reading_copy_pending()
          : state === 'copied'
            ? m.collection_reading_copy_done()
            : state === 'unavailable'
              ? m.collection_reading_copy_unavailable()
              : null}
      </p>
    </div>
  );
}

/** Full evidence for exactly one opened occurrence; no additional reads or reconstructed identities. */
export function CollectionMemberOccurrenceDetails<Member extends CollectionReadMember>({
  member,
  currentHref,
  listPresentations,
  comparisonDefinitions,
  onReferenceNavigate,
  onCopy,
}: {
  member: Member;
  currentHref?: string | undefined;
  listPresentations?: CollectionListPresentations | undefined;
  comparisonDefinitions?: CollectionComparisonDefinitions | undefined;
  onReferenceNavigate?: ((anchor: HTMLAnchorElement) => void) | undefined;
  onCopy: (member: Member) => void | Promise<void>;
}) {
  const subject = member.subject;
  const title = subject?.label
    ? pageText(libraryTitleValue(subject.label), getLocale()).text
    : m.subject_value_unlabelled();
  return (
    <div data-collection-member-id={member.id} className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      {subject ? (
        <section className="space-y-3">
          <h4 className="font-medium">{m.collection_reading_metadata()}</h4>
          <CollectionSubjectDetails
            member={member}
            listPresentations={listPresentations}
            comparisonDefinitions={comparisonDefinitions}
            currentHref={currentHref}
            onReferenceNavigate={onReferenceNavigate}
            referenceActions={(reference) => <CollectionReferenceCopy key={reference.id} {...reference} />}
          />
          <div className="min-w-0 space-y-1 border-t border-border pt-3">
            <a
              href={collectionComparisonHref(subject.id, title, getLocale(), currentHref, member.id)}
              className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={(event) => onReferenceNavigate?.(event.currentTarget)}
            >
              {title}
            </a>
            <CollectionReferenceCopy id={subject.id} href="" label={title} write={() => onCopy(member)} />
          </div>
        </section>
      ) : (
        <p>{m.library_subject_unavailable()}</p>
      )}
      {member.note ? (
        <section className="min-w-0 space-y-2 border-t border-border pt-4">
          <h4 className="font-medium">{m.collection_reading_note()}</h4>
          <p
            data-slot="collection-member-note"
            className="min-w-0 max-w-full whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
          >
            {member.note}
          </p>
        </section>
      ) : null}
    </div>
  );
}
