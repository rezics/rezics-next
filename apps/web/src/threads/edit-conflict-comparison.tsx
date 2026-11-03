import { useId, useMemo, useRef, useState } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import {
  conflictInspectionLimits,
  type ConflictProjection,
  type ConflictSection,
  type ConflictSectionKind,
} from './edit-conflict-inspection';

export const conflictActionClassName =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 text-start leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function kindLabel(kind: ConflictSectionKind): string {
  switch (kind) {
    case 'text':
      return m.thread_inspect_kind_text();
    case 'heading':
      return m.thread_inspect_kind_heading();
    case 'list':
      return m.thread_inspect_kind_list();
    case 'quote':
      return m.thread_inspect_kind_quote();
    case 'code':
      return m.thread_inspect_kind_code();
    case 'table':
      return m.thread_inspect_kind_table();
    case 'image':
      return m.thread_inspect_kind_image();
    case 'media':
      return m.thread_inspect_kind_media();
    case 'component':
      return m.thread_inspect_kind_component();
    case 'divider':
      return m.thread_inspect_kind_divider();
    case 'unsupported':
      return m.thread_inspect_kind_unsupported();
  }
}

/** Unavailable images stay inert even when a draft contains a usable-looking URL. */
const unavailableImage = ({ alt }: { alt: string }) => (
  <span
    role="img"
    aria-label={alt || m.content_edition_image_unavailable()}
    className="block min-w-0 rounded-xl bg-muted p-4 text-sm text-muted-foreground [overflow-wrap:anywhere]"
  >
    {m.content_edition_image_unavailable()}
    {alt ? ` — ${alt}` : ''}
  </span>
);

type Selection = 'full' | number | null;

/** Each side has its own local index, selected reading and spoiler disclosure visit. */
function ConflictDocumentReading({
  title,
  description,
  projection,
  licence,
  createdAt,
  revisedAt,
  allowed,
}: {
  title: string;
  description: string;
  projection: ConflictProjection;
  licence?: string;
  createdAt?: string;
  revisedAt?: string | null;
  allowed: () => boolean;
}) {
  const id = useId();
  const [page, setPage] = useState(0);
  // Opening Review is an explicit request to read both complete documents.
  const [selection, setSelection] = useState<Selection>('full');
  const reader = useRef<HTMLElement>(null);
  const [focusReader, setFocusReader] = useState(false);
  const sections = projection.state === 'ready' ? projection.sections : [];
  const pageCount = Math.max(1, Math.ceil(sections.length / conflictInspectionLimits.page));
  const visible = sections.slice(page * conflictInspectionLimits.page, (page + 1) * conflictInspectionLimits.page);
  const selectedSection = typeof selection === 'number' ? sections[selection] : undefined;
  const selected = useMemo(() => {
    if (projection.state !== 'ready' || selection === null) return null;
    if (selection === 'full') return projection.body;
    const block = projection.body.doc.content?.[selection];
    if (!block) return null;
    // A constant-size reader view references the original complete block. No nodes are copied.
    return { ...projection.body, doc: { type: 'doc', content: [block] } } satisfies DocumentSnapshot;
  }, [projection, selection]);

  function read(next: Selection) {
    if (!allowed()) return;
    setSelection(next);
    setFocusReader(next !== null);
  }

  const focusSelected = (element: HTMLElement | null) => {
    reader.current = element;
    if (!element || !focusReader || !allowed()) return;
    // Synchronous commit focus, never a queued timeout that could outlive this visit.
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: 'nearest' });
    setFocusReader(false);
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="min-w-0 max-w-full space-y-4 md:max-h-[55dvh] md:overflow-y-auto md:overscroll-contain rounded-xl border border-border p-3 sm:p-4 [overflow-wrap:anywhere]"
      data-conflict-reading=""
    >
      <header className="min-w-0 space-y-2">
        <h2 id={`${id}-title`} className="font-heading text-lg font-semibold">
          {title}
        </h2>
        <p id={`${id}-description`} className="text-sm text-muted-foreground">
          {description}
        </p>
        {licence ? (
          <p className="text-sm">
            {m.thread_history_licence()}: {licence}
          </p>
        ) : null}
        {createdAt ? (
          <p className="text-sm">
            {m.thread_inspect_created()}: <time dateTime={createdAt}>{createdAt}</time>
          </p>
        ) : null}
        {revisedAt ? (
          <p className="text-sm">
            {m.thread_inspect_revised()}: <time dateTime={revisedAt}>{revisedAt}</time>
          </p>
        ) : null}
      </header>
      {projection.state !== 'ready' ? (
        <p role="status">
          {projection.state === 'too-large'
            ? m.thread_inspect_too_large({ bytes: conflictInspectionLimits.bytes })
            : m.thread_inspect_unsupported()}
        </p>
      ) : (
        <>
          <nav aria-label={m.thread_inspect_sections_for({ title })} className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">{m.thread_inspect_sections()}</h3>
            <p className="text-sm text-muted-foreground">{m.thread_inspect_index_description()}</p>
            <ol start={page * conflictInspectionLimits.page + 1} className="min-w-0 space-y-1">
              {visible.map((section) => (
                <li key={section.offset} className="min-w-0">
                  <SectionControl
                    section={section}
                    selected={selection === section.offset}
                    readerId={`${id}-reader`}
                    onSelect={() => read(section.offset)}
                  />
                </li>
              ))}
            </ol>
            <IndexPaging
              page={page}
              pages={pageCount}
              onPage={(next) => {
                if (allowed()) setPage(next);
              }}
            />
          </nav>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className={conflictActionClassName}
              aria-controls={`${id}-reader`}
              aria-pressed={selection === 'full'}
              onClick={() => read('full')}
            >
              {m.thread_inspect_full_document()}
            </Button>
            {selection !== null ? (
              <Button
                type="button"
                variant="ghost"
                className={conflictActionClassName}
                aria-controls={`${id}-reader`}
                onClick={() => read(null)}
              >
                {m.thread_inspect_hide_reading()}
              </Button>
            ) : null}
          </div>
          {selected ? (
            <section
              id={`${id}-reader`}
              aria-labelledby={`${id}-selected`}
              tabIndex={-1}
              ref={focusSelected}
              className="min-w-0 max-w-full space-y-3 rounded-lg bg-background p-3 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <h3 id={`${id}-selected`} className="text-sm font-semibold">
                {selectedSection
                  ? m.thread_inspect_selected_section({ number: selectedSection.offset + 1 })
                  : m.thread_inspect_complete_reading()}
              </h3>
              <DocumentBody
                key={selection === 'full' ? 'full' : `section-${selection}`}
                document={selected}
                renderImage={unavailableImage}
                className="mx-0! w-full min-w-0 max-w-full overflow-x-auto [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_a]:break-all [&_img]:max-w-full"
              />
            </section>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {m.thread_inspect_reading_hidden()}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function SectionControl({
  section,
  selected,
  readerId,
  onSelect,
}: {
  section: ConflictSection;
  selected: boolean;
  readerId: string;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant={selected ? 'secondary' : 'ghost'}
      className={`${conflictActionClassName} w-full flex-col items-start gap-1 px-3 py-2`}
      aria-controls={readerId}
      aria-pressed={selected}
      onClick={onSelect}
      data-conflict-section={section.offset}
    >
      <span className="text-sm font-medium">
        {m.thread_inspect_section_label({ number: section.offset + 1, kind: kindLabel(section.kind) })}
      </span>
      {section.label ? (
        <span className="min-w-0 text-sm font-normal text-muted-foreground">{section.label}</span>
      ) : null}
      {section.concealed ? <span className="text-sm font-normal">{m.thread_inspect_concealed()}</span> : null}
    </Button>
  );
}

function IndexPaging({ page, pages, onPage }: { page: number; pages: number; onPage: (next: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        className={conflictActionClassName}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        {m.thread_inspect_previous_sections()}
      </Button>
      <p className="text-sm" role="status">
        {m.thread_inspect_page({ page: page + 1, pages })}
      </p>
      <Button
        type="button"
        variant="outline"
        className={conflictActionClassName}
        disabled={page + 1 >= pages}
        onClick={() => onPage(page + 1)}
      >
        {m.thread_inspect_next_sections()}
      </Button>
    </div>
  );
}

export function EditConflictComparison({
  draft,
  current,
  licence,
  createdAt,
  revisedAt,
  erased,
  allowed,
}: {
  draft: ConflictProjection;
  current: ConflictProjection | undefined;
  licence: string | undefined;
  createdAt?: string;
  revisedAt?: string | null;
  erased?: boolean;
  allowed: () => boolean;
}) {
  return (
    <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] items-start gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <ConflictDocumentReading
        title={m.thread_inspect_draft_title()}
        description={m.thread_inspect_draft_description()}
        projection={draft}
        allowed={allowed}
      />
      {current ? (
        <ConflictDocumentReading
          title={m.thread_edit_current_title()}
          description={m.thread_inspect_current_description()}
          projection={current}
          licence={licence}
          createdAt={createdAt}
          revisedAt={revisedAt}
          allowed={allowed}
        />
      ) : (
        <section
          aria-label={m.thread_edit_current_title()}
          className="min-w-0 space-y-3 rounded-xl border border-border p-4"
        >
          <h2 className="font-heading text-lg font-semibold">{m.thread_edit_current_title()}</h2>
          <p role="status">{erased ? m.thread_inspect_current_erased() : m.thread_edit_current_unavailable()}</p>
        </section>
      )}
    </div>
  );
}

/** Legacy opt-out callers retain their original, single current-document reader. */
export function CurrentConflictReading({ body, licence }: { body: DocumentSnapshot; licence: string }) {
  return (
    <section className="min-w-0 space-y-3" aria-label={m.thread_edit_current_title()}>
      <DocumentBody document={body} className="mx-0! w-full overflow-x-auto [overflow-wrap:anywhere]" />
      <p className="text-sm text-muted-foreground">
        {m.thread_history_licence()}: {licence}
      </p>
    </section>
  );
}
