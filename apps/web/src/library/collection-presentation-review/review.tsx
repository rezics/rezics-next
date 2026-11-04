import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { CoverSummary } from '@rezics/ui/cover';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageText } from '../../features/pages/shared';
import { libraryTitleValue } from '../title';
import type { CollectionMember } from '../reads';
import type { CollectionComparisonDefinitions } from '../collection-comparison/model';
import type {
  CollectionListPresentations,
  CollectionPresentationData,
  CollectionTypeOption,
} from '../collection-presentation';
import {
  draftCoverPreview,
  loadedCoverOptions,
  loadedCoverSubject,
  presentationChanges,
  presentationTypeChoice,
} from './model';
import { PresentationChangeSummary, TypeChoiceMeaning } from './choice-summary';
import { CoverComparison, LoadedCoverGallery } from './cover-review';
import { ReleasedTypeChoices } from './type-options';
import { LoadedOccurrencePreview } from './loaded-preview';

export type CollectionPresentationFieldsProps = {
  types: readonly CollectionTypeOption[] | null | undefined;
  kind: string | null;
  onKindChange: (kind: string | null) => void;
  coverMediaId: string | null;
  onCoverChange?: (id: string | null) => void;
  members?: readonly CollectionMember[];
  disabled?: boolean;
  savedKind?: string | null;
  savedCoverMediaId?: string | null;
  savedCover?: CoverSummary | null;
  savedCoverSource?: CollectionPresentationData['coverSource'];
  listPresentations?: CollectionListPresentations | undefined;
  comparisonDefinitions?: CollectionComparisonDefinitions | undefined;
  typeRatios?: Readonly<Record<string, string>> | undefined;
  firstPage?: boolean;
  saveConfirmed?: boolean;
};

const selectClass =
  'block min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60';

/** This region edits the existing metadata draft. Opening, closing and reviewing never submit the form. */
export function CollectionPresentationFields({
  types,
  kind,
  onKindChange,
  coverMediaId,
  onCoverChange,
  members = [],
  disabled = false,
  savedKind = kind,
  savedCoverMediaId = coverMediaId,
  savedCover = null,
  savedCoverSource,
  listPresentations,
  comparisonDefinitions,
  typeRatios,
  firstPage = true,
  saveConfirmed = false,
}: CollectionPresentationFieldsProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [handoffUnavailable, setHandoffUnavailable] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const kindControl = useRef<HTMLSelectElement>(null);
  const coverControl = useRef<HTMLSelectElement>(null);
  const focusAfterRender = useRef<'heading' | 'trigger' | 'kind' | 'cover' | null>(null);
  const coverOptions = loadedCoverOptions(members);
  const savedType = presentationTypeChoice(savedKind, savedKind, types, listPresentations);
  const draftType = presentationTypeChoice(savedKind, kind, types, listPresentations);
  const changes = presentationChanges({ kind: savedKind, coverMediaId: savedCoverMediaId }, { kind, coverMediaId });
  const coverPreview = draftCoverPreview({
    saved: savedCoverMediaId,
    selected: coverMediaId,
    nativeCover: savedCover,
    nativeSource: savedCoverSource,
    options: coverOptions,
  });

  useLayoutEffect(() => {
    const next = focusAfterRender.current;
    focusAfterRender.current = null;
    if (next === 'heading') heading.current?.focus();
    if (next === 'trigger') trigger.current?.focus();
    if (next === 'kind') kindControl.current?.focus();
    if (next === 'cover') coverControl.current?.focus();
  });

  function review() {
    focusAfterRender.current = 'heading';
    setHandoffUnavailable(false);
    setOpen(true);
  }
  function close(target: 'trigger' | 'kind' | 'cover' = 'trigger') {
    focusAfterRender.current = target;
    setHandoffUnavailable(false);
    setOpen(false);
  }
  function returnToSave() {
    // The page owns admission, validation, capture and dispatch; this action only moves focus.
    const form = trigger.current?.closest('form');
    const save = form?.ownerDocument.querySelector<HTMLButtonElement>(
      'button[type="submit"][form="collection-edit-form"]',
    );
    if (!save || save.disabled || saveConfirmed) {
      setHandoffUnavailable(true);
      return;
    }
    setOpen(false);
    setHandoffUnavailable(false);
    save.focus();
  }
  function changeKind(value: string | null) {
    if (!disabled) onKindChange(value);
  }
  function changeCover(value: string | null) {
    if (!disabled) onCoverChange?.(value);
  }

  function coverLabel(id: string | null) {
    if (id === null) return m.collection_choice_cover_automatic();
    const subject = loadedCoverSubject(id, coverOptions);
    return subject
      ? pageText(libraryTitleValue(subject.label), getLocale()).text
      : m.collection_choice_selected_cover_unavailable();
  }

  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" data-collection-presentation-fields>
      <div className="space-y-2">
        <h3 className="font-semibold">{m.collection_choice_heading()}</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {saveConfirmed ? m.collection_choice_confirmed_read_pending() : m.collection_choice_draft_help()}
        </p>
      </div>
      <div className="grid max-w-3xl min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-type`} className="block font-medium">
            {m.library_collection_kind()}
          </label>
          <select
            ref={kindControl}
            id={`${id}-type`}
            className={selectClass}
            value={kind ?? ''}
            disabled={disabled}
            aria-describedby={`${id}-type-help`}
            onChange={(event) => changeKind(event.target.value || null)}
          >
            <option value="">{m.library_collection_mixed_label()}</option>
            {kind && !types?.some((type) => type.id === kind) ? (
              <option value={kind}>{m.collection_choice_type_unavailable()}</option>
            ) : null}
            {types?.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label || m.collection_choice_type_unavailable()}
              </option>
            ))}
          </select>
          <div id={`${id}-type-help`} className="space-y-2 text-sm text-muted-foreground">
            <p>
              {kind === null ? m.collection_choice_automatic_type_help() : m.collection_choice_explicit_type_help()}
            </p>
            {types == null ? (
              <p role="status">{m.library_collection_types_unavailable()}</p>
            ) : types.length === 0 ? (
              <p>{m.collection_choice_no_released_types()}</p>
            ) : null}
            {draftType.availability === 'unavailable' ? <p>{m.collection_choice_retained_type_help()}</p> : null}
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 max-w-full whitespace-normal text-start"
              disabled={disabled || kind === null}
              onClick={() => changeKind(null)}
            >
              {m.collection_choice_reset_type()}
            </Button>
            {changes.type ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 max-w-full whitespace-normal text-start"
                disabled={disabled}
                onClick={() => changeKind(savedKind)}
              >
                {m.collection_choice_restore_type()}
              </Button>
            ) : null}
          </div>
        </div>
        {onCoverChange ? (
          <div className="min-w-0 space-y-2">
            <label htmlFor={`${id}-cover`} className="block font-medium">
              {m.subject_cover()}
            </label>
            <select
              ref={coverControl}
              id={`${id}-cover`}
              className={selectClass}
              value={coverMediaId ?? ''}
              disabled={disabled}
              aria-describedby={`${id}-cover-help`}
              onChange={(event) => changeCover(event.target.value || null)}
            >
              <option value="">{m.library_collection_auto()}</option>
              {coverMediaId && !coverOptions.some((option) => option.mediaId === coverMediaId) ? (
                <option value={coverMediaId}>{m.collection_choice_selected_cover_unavailable()}</option>
              ) : null}
              {coverOptions.map((option) => (
                <option key={option.mediaId} value={option.mediaId}>
                  {pageText(libraryTitleValue(option.subject.label), getLocale()).text}
                </option>
              ))}
            </select>
            <div id={`${id}-cover-help`} className="space-y-2 text-sm text-muted-foreground">
              <p>{m.library_collection_cover_existing()}</p>
              {coverPreview.kind === 'unavailable' ? (
                <p role="status">
                  {coverPreview.state === 'retained'
                    ? m.collection_choice_saved_cover_outside_page()
                    : m.collection_choice_draft_cover_outside_page()}
                </p>
              ) : null}
              {coverMediaId === null ? <p>{m.collection_choice_automatic_cover_help()}</p> : null}
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 max-w-full whitespace-normal text-start"
                disabled={disabled || coverMediaId === null}
                onClick={() => changeCover(null)}
              >
                {m.collection_choice_reset_cover()}
              </Button>
              {changes.cover ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 max-w-full whitespace-normal text-start"
                  disabled={disabled}
                  onClick={() => changeCover(savedCoverMediaId)}
                >
                  {m.collection_choice_restore_cover()}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <PresentationChangeSummary
        savedType={savedType}
        draftType={draftType}
        coverChanged={changes.cover}
        savedCoverLabel={coverLabel(savedCoverMediaId)}
        draftCoverLabel={coverLabel(coverMediaId)}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal text-start"
          aria-expanded={open}
          aria-controls={`${id}-review`}
          onClick={() => (open ? close() : review())}
          data-presentation-review-trigger
        >
          {open ? m.collection_choice_close_review() : m.collection_choice_review()}
        </Button>
        <span className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {saveConfirmed
            ? m.collection_choice_review_after_save()
            : changes.type || changes.cover
              ? m.collection_choice_unsaved_changes()
              : m.collection_choice_no_presentation_changes()}
        </span>
      </div>
      {disabled ? <p className="text-sm text-muted-foreground">{m.collection_choice_locked_help()}</p> : null}
      {open ? (
        <section
          id={`${id}-review`}
          aria-labelledby={`${id}-review-heading`}
          className="min-w-0 space-y-6 rounded-xl border border-border bg-muted/20 p-3 sm:p-5"
          data-presentation-review
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="space-y-2">
            <h3 ref={heading} id={`${id}-review-heading`} tabIndex={-1} className="font-semibold outline-none">
              {m.collection_choice_review_heading()}
            </h3>
            <p className="text-sm text-muted-foreground">{m.collection_choice_preview_limits()}</p>
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <section className="min-w-0 space-y-3 rounded-lg border border-border p-3" data-type-reading="saved">
              <h4 className="font-semibold">{m.collection_choice_saved_type()}</h4>
              <TypeChoiceMeaning choice={savedType} />
            </section>
            <section className="min-w-0 space-y-3 rounded-lg border border-border p-3" data-type-reading="draft">
              <h4 className="font-semibold">{m.collection_choice_draft_type()}</h4>
              <TypeChoiceMeaning choice={draftType} />
            </section>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 whitespace-normal"
              disabled={disabled}
              onClick={() => close('kind')}
            >
              {m.collection_choice_correct_type()}
            </Button>
            {onCoverChange ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 whitespace-normal"
                disabled={disabled}
                onClick={() => close('cover')}
              >
                {m.collection_choice_correct_cover()}
              </Button>
            ) : null}
          </div>
          <ReleasedTypeChoices
            types={types}
            kind={kind}
            savedKind={savedKind}
            members={members}
            listPresentations={listPresentations}
            disabled={disabled}
            onChange={changeKind}
            name={`${id}-type-gallery`}
          />
          {onCoverChange ? (
            <>
              <CoverComparison
                savedCover={savedCover}
                savedCoverMediaId={savedCoverMediaId}
                savedKind={savedKind}
                draftKind={kind}
                savedSource={savedCoverSource}
                preview={coverPreview}
                listPresentations={listPresentations}
                scope={id}
              />
              <LoadedCoverGallery
                options={coverOptions}
                members={members}
                selected={coverMediaId}
                disabled={disabled}
                onChange={changeCover}
                listPresentations={listPresentations}
                groupName={`${id}-cover-gallery`}
                scope={id}
              />
            </>
          ) : null}
          <LoadedOccurrencePreview
            members={members}
            types={types}
            listPresentations={listPresentations}
            comparisonDefinitions={comparisonDefinitions}
            typeRatios={typeRatios}
            scope={`${id}:occurrences`}
            firstPage={firstPage}
          />
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">{m.collection_choice_save_handoff_help()}</p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 max-w-full whitespace-normal"
                onClick={() => close()}
              >
                {m.collection_choice_return_editor()}
              </Button>
              <Button
                type="button"
                className="min-h-11 max-w-full whitespace-normal"
                disabled={disabled || saveConfirmed}
                onClick={returnToSave}
                data-review-return-save
              >
                {m.collection_choice_return_save()}
              </Button>
            </div>
            {handoffUnavailable ? (
              <p role="status" className="text-sm">
                {m.collection_choice_save_unavailable()}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}
