import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { CopyItem } from '../copies-read';
import { displayLibraryTitle } from '../title';
import { subjectHref } from '../../subject/subject-href';
import { withSubjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { CopyReadingContextView } from '../copy-reading-context/view';
import { CopyInventoryHistory } from './history';
import { CopyTextReader, dateText } from './text-reader';
import type { CopyInventorySelection, RetiredCopy } from './selection';

const control =
  'inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center justify-center rounded-lg border border-border px-3 py-2 text-center text-sm whitespace-normal [overflow-wrap:anywhere] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60';

/** Differences describe these supplied observations only; they make no claim about other holdings. */
function Difference({ different, compared }: { different: boolean; compared: boolean }) {
  if (!compared) return null;
  return (
    <p className="mt-1 text-xs font-medium text-muted-foreground">
      {different ? m.library_copy_compare_different() : m.library_copy_compare_same()}
    </p>
  );
}

function Fact({
  label,
  children,
  different,
  compared,
}: {
  label: string;
  children: ReactNode;
  different: boolean;
  compared: boolean;
}) {
  return (
    <div className="min-w-0 border-t border-border py-3">
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="min-w-0 space-y-1 pt-1 text-sm [overflow-wrap:anywhere]">{children}</dd>
      <Difference different={different} compared={compared} />
    </div>
  );
}

function MissingObservation() {
  return <span className="text-muted-foreground">{m.library_copy_compare_not_recorded()}</span>;
}

function HistoricalLabel({ value, language }: { value: string | undefined; language: string | undefined }) {
  return value ? (
    <span lang={language}>{value}</span>
  ) : (
    <span className="text-muted-foreground">{m.library_copy_compare_label_missing()}</span>
  );
}

/** Each card is one exact native row, even when every readable title is equal. */
function ReceivedCopy({
  copy,
  position,
  selected,
  editorOpen,
  returnTo,
  onEdit,
  onRemove,
}: {
  copy: CopyItem;
  position: number;
  selected: CopyItem[];
  editorOpen: boolean;
  returnTo: string | undefined;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const heading = useId();
  const locale = getLocale();
  const title = copy.subject ? displayLibraryTitle(copy.subject.label, locale) : null;
  const href = copy.subject
    ? withSubjectVisitReturn(
        subjectHref({ id: copy.subject.id, label: title!.text }, locale).href,
        returnTo ?? '',
        locale,
      )
    : null;
  const compared = selected.length > 1;
  const different = (field: 'location' | 'source' | 'note' | 'acquiredOn' | 'disposedOn') =>
    selected.some((other) => other[field] !== copy[field]);
  // A missing historical label stays separate from the raw identifier and its historical meaning.
  const differentKind = selected.some(
    (other) =>
      other.kind !== copy.kind ||
      other.kindLabel !== copy.kindLabel ||
      other.kindLabelLanguage !== copy.kindLabelLanguage ||
      other.meaning !== copy.meaning,
  );
  const differentStatus = selected.some(
    (other) =>
      other.status !== copy.status ||
      other.statusLabel !== copy.statusLabel ||
      other.statusLabelLanguage !== copy.statusLabelLanguage ||
      other.meaning !== copy.meaning,
  );
  return (
    <article
      aria-labelledby={heading}
      data-copy-comparison-id={copy.id}
      className="grid min-w-0 content-start rounded-xl border border-border bg-background p-4 lg:row-span-3 lg:grid-rows-subgrid"
    >
      <header className="min-w-0 space-y-2 pb-3">
        <p className="text-sm font-medium text-muted-foreground">
          {m.library_copy_compare_page_position({ position })}
        </p>
        <h3 id={heading} lang={title?.lang} className="font-semibold [overflow-wrap:anywhere]">
          {title?.text ?? m.library_subject_unavailable()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.library_copy_compare_record_hint()}</p>
      </header>
      <dl className="min-w-0">
        <Fact label={m.library_copy_compare_edition()} different={false} compared={false}>
          {href ? (
            <a href={href} lang={title?.lang} className="text-primary underline underline-offset-4">
              {title!.text}
            </a>
          ) : (
            <span>{m.library_subject_unavailable()}</span>
          )}
          {copy.subject?.typeLabel ? <p>{copy.subject.typeLabel}</p> : null}
        </Fact>
        <Fact label={m.library_copy_compare_context()} different={false} compared={false}>
          <CopyReadingContextView context={copy.readingContext} returnTo={returnTo} locale={locale} />
        </Fact>
        <Fact label={m.library_copy_kind()} different={differentKind} compared={compared}>
          <HistoricalLabel value={copy.kindLabel} language={copy.kindLabelLanguage} />
        </Fact>
        <Fact label={m.library_copy_status()} different={differentStatus} compared={compared}>
          <HistoricalLabel value={copy.statusLabel} language={copy.statusLabelLanguage} />
          <CopyInventoryHistory copy={copy} />
        </Fact>
        <Fact label={m.library_copy_location()} different={different('location')} compared={compared}>
          {copy.location === null ? (
            <MissingObservation />
          ) : (
            <CopyTextReader
              label={m.library_copy_location()}
              value={copy.location}
              expandLabel={m.library_copy_note_reader_expand_location()}
              collapseLabel={m.library_copy_note_reader_collapse_location()}
            />
          )}
        </Fact>
        <Fact label={m.library_copy_source()} different={different('source')} compared={compared}>
          {copy.source === null ? (
            <MissingObservation />
          ) : (
            <CopyTextReader
              label={m.library_copy_source()}
              value={copy.source}
              expandLabel={m.library_copy_note_reader_expand_source()}
              collapseLabel={m.library_copy_note_reader_collapse_source()}
            />
          )}
        </Fact>
        <Fact label={m.library_copy_acquired()} different={different('acquiredOn')} compared={compared}>
          {copy.acquiredOn === null ? (
            <MissingObservation />
          ) : (
            <time dateTime={copy.acquiredOn}>{dateText(copy.acquiredOn)}</time>
          )}
        </Fact>
        <Fact label={m.library_copy_disposed()} different={different('disposedOn')} compared={compared}>
          {copy.disposedOn === null ? (
            <MissingObservation />
          ) : (
            <time dateTime={copy.disposedOn}>{dateText(copy.disposedOn)}</time>
          )}
        </Fact>
        <Fact label={m.library_copy_note()} different={different('note')} compared={compared}>
          {copy.note === null ? (
            <MissingObservation />
          ) : (
            <CopyTextReader
              label={m.library_copy_note()}
              value={copy.note}
              expandLabel={m.library_copy_note_reader_expand_note()}
              collapseLabel={m.library_copy_note_reader_collapse_note()}
            />
          )}
        </Fact>
        <div className="min-w-0 border-t border-border py-3">
          <dt className="sr-only">{m.library_copy_compare_identifiers()}</dt>
          <dd>
            <details>
              <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.library_copy_compare_identifiers()}
              </summary>
              <p className="py-2 text-xs text-muted-foreground">{m.library_copy_compare_identifiers_hint()}</p>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="font-medium">{m.library_copy_compare_id()}</dt>
                  <dd className="break-all">
                    <code>{copy.id}</code>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">{m.library_copy_compare_revision()}</dt>
                  <dd>
                    <code>{copy.revision}</code>
                  </dd>
                </div>
              </dl>
            </details>
          </dd>
        </div>
      </dl>
      <footer className="min-w-0 space-y-2 border-t border-border pt-3">
        <button
          type="button"
          className={`${control} w-full`}
          onClick={onEdit}
          disabled={editorOpen}
          aria-label={m.library_copy_compare_edit_named({
            position,
            title: title?.text ?? m.library_subject_unavailable(),
          })}
        >
          {m.library_copy_compare_edit()}
        </button>
        <button type="button" className={`${control} w-full`} onClick={onRemove}>
          {m.library_copy_compare_remove()}
        </button>
      </footer>
    </article>
  );
}

/** Retirement preserves identity and the observed revision, never an old private title or note. */
function RetiredObservation({
  observation,
  copies,
  selection,
  regionId,
}: {
  observation: RetiredCopy;
  copies: CopyItem[];
  selection: CopyInventorySelection;
  regionId: string;
}) {
  const current = copies.find((copy) => copy.id === observation.id);
  return (
    <div className="min-w-0 space-y-2 border-t border-border pt-3">
      <p className="font-medium">
        {current
          ? m.library_copy_compare_changed_position({ position: copies.indexOf(current) + 1 })
          : m.library_copy_compare_missing_record()}
      </p>
      <details>
        <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.library_copy_compare_previous_identity()}
        </summary>
        <dl className="space-y-2 py-2">
          <div>
            <dt className="font-medium">{m.library_copy_compare_id()}</dt>
            <dd className="break-all">
              <code>{observation.id}</code>
            </dd>
          </div>
          <div>
            <dt className="font-medium">{m.library_copy_compare_previous_revision()}</dt>
            <dd>
              <code>{observation.revision}</code>
            </dd>
          </div>
          {current ? (
            <div>
              <dt className="font-medium">{m.library_copy_compare_current_revision()}</dt>
              <dd>
                <code>{current.revision}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
      {current ? (
        <button
          type="button"
          className={control}
          onClick={() => selection.returnToRow(current, `${regionId}-select-${current.id}`)}
        >
          {m.library_copy_compare_find_row()}
        </button>
      ) : null}
    </div>
  );
}

/** A reading region, deliberately independent of the editor shell and all native writers. */
export function CopyInventoryReview({
  id,
  selection,
  copies,
  returnTo,
  editorOpen,
  onEdit,
  onReturnToEditor,
}: {
  id: string;
  selection: CopyInventorySelection;
  copies: CopyItem[];
  returnTo: string | undefined;
  editorOpen: boolean;
  onEdit: (row: CopyItem, trigger: HTMLButtonElement | null) => void;
  onReturnToEditor: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (selection.open && !wasOpen.current) heading.current?.focus();
    wasOpen.current = selection.open;
  }, [selection.open]);
  const focusHeading = () => heading.current?.focus();
  // Wide screens keep the cards side by side; narrow screens read one complete record at a time.
  const columns =
    selection.count === 4
      ? 'lg:grid-cols-4'
      : selection.count === 3
        ? 'lg:grid-cols-3'
        : selection.count === 2
          ? 'lg:grid-cols-2'
          : 'lg:grid-cols-1';
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h2
            id={`${id}-title`}
            ref={heading}
            tabIndex={-1}
            className="rounded-md text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.library_copy_compare_heading()}
          </h2>
          <p className="text-sm text-muted-foreground">{m.library_copy_compare_scope()}</p>
          <p role="status" aria-atomic="true" className="text-sm font-medium">
            {m.library_copy_compare_count({ count: selection.count })}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          {!selection.open ? (
            <button
              type="button"
              className={control}
              onClick={selection.show}
              aria-expanded={false}
              aria-controls={`${id}-body`}
            >
              {m.library_copy_compare_open()}
            </button>
          ) : (
            <button
              type="button"
              className={control}
              onClick={selection.close}
              aria-expanded={true}
              aria-controls={`${id}-body`}
            >
              {m.library_copy_compare_close()}
            </button>
          )}
          <button
            type="button"
            className={control}
            disabled={!selection.count && !selection.retired.length}
            onClick={() => {
              selection.reset();
              focusHeading();
            }}
          >
            {m.library_copy_compare_reset()}
          </button>
        </div>
      </div>
      {selection.retired.length ? (
        <div role="status" className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <p>{m.library_copy_compare_reselect()}</p>
          {selection.retired.some((item) => item.reason === 'changed') ? (
            <p>{m.library_copy_compare_changed()}</p>
          ) : null}
          {selection.retired.some((item) => item.reason === 'missing') ? (
            <p>{m.library_copy_compare_missing()}</p>
          ) : null}
          {selection.retired.map((observation) => (
            <RetiredObservation
              key={`${observation.id}:${observation.revision}`}
              observation={observation}
              copies={copies}
              selection={selection}
              regionId={id}
            />
          ))}
          <button type="button" className={control} onClick={selection.dismissRetired}>
            {m.library_copy_compare_dismiss()}
          </button>
        </div>
      ) : null}
      {selection.count === 4 ? <p className="text-sm">{m.library_copy_compare_limit()}</p> : null}
      <div id={`${id}-body`} hidden={!selection.open} className="min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{m.library_copy_compare_reading_hint()}</p>
        {editorOpen ? (
          <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p>{m.library_copy_compare_editor_open()}</p>
            <button type="button" className={control} onClick={onReturnToEditor}>
              {m.library_copy_compare_return_editor()}
            </button>
          </div>
        ) : null}
        {!selection.count ? (
          <p className="text-sm">{m.library_copy_compare_empty()}</p>
        ) : (
          <div className={`grid min-w-0 grid-cols-1 gap-4 ${columns}`}>
            {selection.copies.map((copy) => (
              <ReceivedCopy
                key={`${copy.id}:${copy.revision}`}
                copy={copy}
                position={copies.indexOf(copy) + 1}
                selected={selection.copies}
                editorOpen={editorOpen}
                returnTo={returnTo}
                onRemove={() => {
                  selection.remove(copy);
                  focusHeading();
                }}
                onEdit={() => {
                  if (!editorOpen) selection.handoff(copy, onEdit);
                }}
              />
            ))}
          </div>
        )}
        <p className="text-sm text-muted-foreground">{m.library_copy_compare_edit_hint()}</p>
      </div>
    </section>
  );
}
