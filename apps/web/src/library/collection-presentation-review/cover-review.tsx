import { Button } from '@rezics/ui/shadcn/button';
import { Cover, ReadingDisclosureScope, type CoverSummary } from '@rezics/ui/cover';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { coverSrc } from '../../media/cover-src';
import { pageText } from '../../features/pages/shared';
import { libraryTitleValue } from '../title';
import { collectionMemberRatio } from '../collection-presentation';
import type { CollectionListPresentations, CollectionPresentationData } from '../collection-presentation';
import type { CollectionMember } from '../reads';
import { CoverAvailability } from './cover-availability';
import type { DraftCoverPreview, LoadedCoverOption } from './model';

const coverLabels = () => ({
  withheld: m.thread_cover_withheld(),
  reveal: m.thread_cover_reveal(),
  credit: m.thread_cover_credit(),
  via: m.thread_cover_via(),
});

/** No media identity is synthesized for the placeholder or an automatic draft. */
function CollectionCoverFrame({
  cover,
  kind,
  listPresentations,
}: {
  cover: CoverSummary | null;
  kind: string | null;
  listPresentations: CollectionListPresentations | undefined;
}) {
  const presentation = kind ? listPresentations?.[kind] : undefined;
  return (
    <div className="w-24 shrink-0 self-start sm:w-32">
      <Cover
        subject={{ id: 'collection-presentation-review', title: m.subject_cover(), types: kind ? [kind] : [] }}
        cover={cover}
        size="fill"
        src={coverSrc}
        ratio={collectionMemberRatio(kind ? { type: kind } : null, undefined, listPresentations)}
        {...(presentation ? { listPresentation: presentation } : {})}
        labels={coverLabels()}
        decorative
      />
    </div>
  );
}

export function CoverComparison({
  savedCover,
  savedCoverMediaId,
  savedKind,
  draftKind,
  savedSource,
  preview,
  listPresentations,
  scope,
  disabled,
  onCorrect,
}: {
  savedCover: CoverSummary | null;
  savedCoverMediaId: string | null;
  savedKind: string | null;
  draftKind: string | null;
  savedSource: CollectionPresentationData['coverSource'];
  preview: DraftCoverPreview;
  listPresentations: CollectionListPresentations | undefined;
  scope: string;
  disabled: boolean;
  onCorrect: () => void;
}) {
  const draftCover =
    preview.kind === 'loaded' ? preview.option.cover : preview.kind === 'automatic' ? preview.nativeCover : null;
  return (
    <section className="min-w-0 space-y-4" aria-labelledby={`${scope}-cover-comparison`} data-cover-comparison>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h4 id={`${scope}-cover-comparison`} className="min-w-0 font-semibold">
          {m.collection_choice_cover_comparison()}
        </h4>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal text-start"
          disabled={disabled}
          onClick={onCorrect}
          data-correct-presentation="cover"
        >
          {m.collection_choice_correct_cover()}
        </Button>
      </div>
      <div className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
        <section
          className="grid min-w-0 gap-y-3 sm:row-span-4 sm:grid-rows-subgrid"
          aria-labelledby={`${scope}-saved-cover`}
          data-cover-reading="saved"
        >
          <h5 id={`${scope}-saved-cover`} className="font-medium text-muted-foreground">
            {m.collection_choice_saved_native()}
          </h5>
          <ReadingDisclosureScope value={`${scope}:saved`}>
            <CollectionCoverFrame cover={savedCover} kind={savedKind} listPresentations={listPresentations} />
          </ReadingDisclosureScope>
          <p className="text-sm">
            {savedCoverMediaId === null ? m.collection_choice_cover_automatic() : m.collection_choice_cover_explicit()}
          </p>
          <p className="text-sm text-muted-foreground">
            {savedCover
              ? m.collection_choice_native_cover_help()
              : savedSource === 'pending'
                ? m.library_collection_kind_pending()
                : m.collection_choice_saved_cover_missing()}
          </p>
        </section>
        <section
          className="grid min-w-0 gap-y-3 border-t border-border pt-4 sm:row-span-4 sm:grid-rows-subgrid sm:border-t-0 sm:border-s sm:pt-0 sm:ps-6"
          aria-labelledby={`${scope}-draft-cover`}
          data-cover-reading="draft"
        >
          <h5 id={`${scope}-draft-cover`} className="font-medium text-muted-foreground">
            {m.collection_choice_local_draft()}
          </h5>
          <ReadingDisclosureScope value={`${scope}:draft`}>
            <CollectionCoverFrame cover={draftCover} kind={draftKind} listPresentations={listPresentations} />
          </ReadingDisclosureScope>
          <p className="text-sm">
            {preview.kind === 'automatic'
              ? m.collection_choice_cover_automatic()
              : m.collection_choice_cover_explicit()}
          </p>
          <p className="text-sm text-muted-foreground" data-cover-preview-state={preview.kind}>
            {preview.kind === 'automatic'
              ? preview.nativeCover
                ? m.collection_choice_automatic_native_cover()
                : m.collection_choice_automatic_cover_help()
              : preview.kind === 'loaded'
                ? preview.state === 'retained'
                  ? m.collection_choice_retained_cover_loaded()
                  : m.collection_choice_replacement_cover_help()
                : preview.state === 'retained'
                  ? m.collection_choice_saved_cover_outside_page()
                  : m.collection_choice_draft_cover_outside_page()}
          </p>
        </section>
      </div>
      <p className="text-sm text-muted-foreground">{m.collection_choice_cover_native_authority()}</p>
    </section>
  );
}

/** Each visible choice is the exact media already accepted by the original selector. */
export function LoadedCoverGallery({
  options,
  members,
  selected,
  disabled,
  onChange,
  listPresentations,
  groupName,
  scope,
}: {
  options: readonly LoadedCoverOption[];
  members: readonly CollectionMember[];
  selected: string | null;
  disabled: boolean;
  onChange: (id: string | null) => void;
  listPresentations: CollectionListPresentations | undefined;
  groupName: string;
  scope: string;
}) {
  return (
    <fieldset className="min-w-0 space-y-3" disabled={disabled} data-loaded-cover-gallery>
      <legend className="font-semibold">{m.collection_choice_cover_options()}</legend>
      <p className="text-sm text-muted-foreground">{m.library_collection_cover_existing()}</p>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
        <input
          type="radio"
          name={groupName}
          value=""
          checked={selected === null}
          onChange={() => onChange(null)}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
          <span className="block font-medium">{m.library_collection_auto()}</span>
          <span className="block text-sm text-muted-foreground">{m.collection_choice_automatic_cover_help()}</span>
        </span>
      </label>
      {selected !== null && !options.some((option) => option.mediaId === selected) ? (
        <p role="status" className="rounded-lg border border-dashed border-border p-3 text-sm">
          {m.collection_choice_selected_cover_unavailable()}
        </p>
      ) : null}
      {options.length ? (
        <ReadingDisclosureScope value={`${scope}:gallery`}>
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2" data-cover-options>
            {options.map((option) => {
              const title = pageText(libraryTitleValue(option.subject.label), getLocale());
              return (
                <li
                  key={option.mediaId}
                  className="min-w-0 rounded-lg border border-border p-3 has-[:checked]:border-primary"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="w-[72px] shrink-0 sm:w-24">
                      <Cover
                        subject={{ id: option.subject.id, title: title.text, types: option.subject.types }}
                        cover={option.cover}
                        size="fill"
                        src={coverSrc}
                        ratio={collectionMemberRatio(option.subject, undefined, listPresentations)}
                        {...(listPresentations?.[option.subject.type]
                          ? { listPresentation: listPresentations[option.subject.type] }
                          : {})}
                        labels={coverLabels()}
                        decorative
                      />
                    </div>
                    <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-sm p-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                      <input
                        type="radio"
                        name={groupName}
                        value={option.mediaId}
                        checked={selected === option.mediaId}
                        onChange={() => onChange(option.mediaId)}
                        className="mt-1 size-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
                        <span className="block font-medium" lang={title.lang}>
                          {title.text}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {option.occurrences.length > 1
                            ? m.collection_choice_shared_cover({ count: option.occurrences.length })
                            : m.collection_choice_cover_from_member()}
                        </span>
                        {selected === option.mediaId ? (
                          <span className="block text-sm">{m.collection_choice_selected_cover()}</span>
                        ) : null}
                      </span>
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        </ReadingDisclosureScope>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {m.collection_choice_no_cover_options()}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{m.collection_choice_cover_options_scope()}</p>
      <CoverAvailability members={members} />
    </fieldset>
  );
}
