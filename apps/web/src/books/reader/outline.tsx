import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { BookReader } from './reader-state';
import type { BookDestination } from './hosted-book-reader';
import { sameSelection, type BookContentsAddress, type BookPage, type BookSelection } from './source';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';
type OutlineProps = {
  reader: BookReader;
  locale: string;
  page: BookPage | null;
  selection: BookSelection | null;
  destination: BookDestination;
  registerRow: (id: string, element: HTMLElement | null) => void;
};
type BranchAction = (parent: string | null, action: () => void, keyboard: boolean) => void;

/** This content is placed in the existing main navigation by ShellContextNavigation. */
export function BookOutlineView({ reader, locale, page, selection, destination, registerRow }: OutlineProps) {
  const outline = reader.outline;
  const snapshot = useSyncExternalStore(outline.subscribe, outline.getSnapshot, outline.getSnapshot);
  const options = { locale: locale as never };
  const outlineId = useId();
  const regions = useRef(new Map<string | null, HTMLElement>());
  const intent = useMemo<{ current: { owner: Element | null; parent: string | null; before: number } | null }>(
    () => ({ current: null }),
    [reader],
  );
  useEffect(() => {
    const cancel = () => {
      intent.current = null;
    };
    const moved = (event: FocusEvent) => {
      const owner = intent.current?.owner;
      if (intent.current && event.target !== owner && !(event.target === document.body && !owner?.isConnected))
        cancel();
    };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', cancel, true);
      window.removeEventListener('blur', cancel);
    };
  }, [intent]);
  useLayoutEffect(() => {
    const pending = intent.current;
    if (!pending || outline.branch(pending.parent)?.state === 'loading') return;
    const frame = requestAnimationFrame(() => {
      if (intent.current !== pending || !reader.current()) return;
      const branch = outline.branch(pending.parent);
      const region = regions.current.get(pending.parent);
      if (!branch?.expanded || !region) {
        intent.current = null;
        return;
      }
      const active = document.activeElement;
      if (active !== pending.owner && !(active === document.body && !pending.owner?.isConnected)) return;
      const added = region.querySelectorAll<HTMLElement>(':scope > ol > li[data-occurrence]')[pending.before];
      const target =
        added?.querySelector<HTMLElement>('a, button') ?? region.querySelector<HTMLElement>('[data-branch-result]');
      intent.current = null;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot, reader, outline, intent]);
  const request: BranchAction = (parent, action, keyboard) => {
    if (!reader.current()) return;
    intent.current = keyboard
      ? { owner: document.activeElement, parent, before: outline.branch(parent)?.rows.length ?? 0 }
      : null;
    action();
  };
  if (!reader.current()) return null;
  return (
    <div id={outlineId} className="grid min-w-0 gap-3 [overflow-wrap:anywhere]" data-slot="book-outline">
      {page?.kind === 'chapter' ? (
        <p className="grid gap-1 px-2 text-sm" aria-live="polite">
          <span className="text-xs text-muted-foreground">{m.book_reader_selected({}, options)}</span>
          <bdi className="font-medium">{page.title}</bdi>
        </p>
      ) : null}
      {snapshot.opened ? (
        <nav aria-label={m.book_reader_contents({}, options)}>
          <OutlineBranch
            {...{ reader, locale, selection, destination, registerRow, request }}
            parent={snapshot.root}
            registerRegion={(parent, element) => {
              if (element) regions.current.set(parent, element);
              else regions.current.delete(parent);
            }}
          />
        </nav>
      ) : page?.kind === 'chapter' ? (
        <nav aria-label={m.book_reader_contents({}, options)} className="grid gap-1">
          {page.ancestors.map((ancestor) => (
            <div key={ancestor.occurrenceId}>
              {destination(ancestor.contents, <bdi>{ancestor.title}</bdi>, { appearance: 'breadcrumb' })}
            </div>
          ))}
          <Button
            variant="ghost"
            className={`${control} justify-start`}
            aria-expanded={false}
            aria-controls={outlineId}
            onClick={(event) =>
              request(
                null,
                () =>
                  reader.openOutline({
                    kind: 'contents',
                    publication: page.address.publication,
                    parentOccurrenceId: null,
                    cursor: null,
                    selection: page.address.selection,
                  }),
                event.detail === 0,
              )
            }
          >
            {m.book_reader_root({}, options)}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function OutlineBranch({
  reader,
  locale,
  parent,
  selection,
  destination,
  registerRow,
  request,
  registerRegion,
}: Omit<OutlineProps, 'page'> & {
  parent: string | null;
  request: BranchAction;
  registerRegion: (parent: string | null, element: HTMLElement | null) => void;
}) {
  const id = useId();
  const options = { locale: locale as never };
  const branch = reader.outline.branch(parent);
  if (!branch?.expanded) return null;
  const busy = branch.state === 'loading';
  const failed = branch.state !== 'ready' && branch.state !== 'idle' && !busy;
  const more = branch.page?.continuation;
  const retry = failed || more?.state === 'unavailable' || (branch.state === 'idle' && !!branch.attempt);
  const address = (value: BookContentsAddress): BookContentsAddress => ({ ...value, selection });
  return (
    <div
      ref={(element) => registerRegion(parent, element)}
      className="grid min-w-0 gap-2"
      aria-busy={busy}
      data-branch={parent ?? ''}
    >
      <ol className="grid min-w-0 divide-y">
        {branch.rows.map((row, index) => {
          const selected = 'chapter' in row && sameSelection(row.chapter.selection, selection);
          const nested = reader.outline.branch(row.occurrenceId);
          const expanded = nested?.expanded ?? false;
          const childId = `${id}-${index}`;
          return (
            <li key={row.occurrenceId} data-occurrence={row.occurrenceId} className="grid min-w-0 py-1">
              <div className="grid min-w-0 gap-0.5">
                {'chapter' in row
                  ? destination(
                      row.chapter,
                      <span className="min-w-0 leading-relaxed">
                        <span className="sr-only">{m.book_reader_open_chapter({}, options)} · </span>
                        <bdi>{row.title}</bdi>
                      </span>,
                      { selected, row: row.occurrenceId, appearance: 'row' },
                    )
                  : null}
                {'contents' in row ? (
                  <Button
                    ref={(element) => {
                      if (!('chapter' in row)) registerRow(row.occurrenceId, element);
                    }}
                    variant="ghost"
                    className={`${control} w-full justify-start gap-2 px-2 font-normal`}
                    aria-expanded={expanded}
                    aria-controls={childId}
                    onClick={() => reader.toggleBranch(address(row.contents))}
                    onKeyDown={(event) => {
                      const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
                      const open = rtl ? 'ArrowLeft' : 'ArrowRight';
                      const close = rtl ? 'ArrowRight' : 'ArrowLeft';
                      const isExpanded = reader.outline.branch(row.occurrenceId)?.expanded ?? false;
                      if ((event.key === open && !isExpanded) || (event.key === close && isExpanded)) {
                        event.preventDefault();
                        reader.toggleBranch(address(row.contents));
                      }
                    }}
                  >
                    {expanded ? (
                      <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                    ) : (
                      <ChevronRight aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
                    )}
                    <span className="min-w-0">
                      <span className={'chapter' in row ? '' : 'sr-only'}>
                        {m.book_reader_contents({}, options)} ·{' '}
                      </span>
                      <bdi>{row.title}</bdi>
                    </span>
                  </Button>
                ) : null}
                {row.kind === 'unavailable' ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground" aria-disabled="true">
                    <bdi>{row.title}</bdi> · {m.book_reader_selection_unavailable({}, options)}
                  </p>
                ) : null}
              </div>
              {'contents' in row ? (
                <div id={childId} hidden={!expanded} className="ms-3 min-w-0 border-s ps-2">
                  <OutlineBranch
                    {...{ reader, locale, selection, destination, registerRow, request, registerRegion }}
                    parent={row.occurrenceId}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {busy ? (
        <p role="status" className="px-2 text-sm text-muted-foreground">
          {m.book_reader_loading({}, options)}
        </p>
      ) : null}
      {retry ? (
        <div className="grid justify-items-start gap-1 px-2">
          <p role="status" className="text-sm text-muted-foreground">
            {branch.state === 'denied'
              ? m.book_reader_denied({}, options)
              : branch.state === 'changed'
                ? m.book_reader_changed({}, options)
                : branch.state === 'not-found'
                  ? m.book_reader_not_found({}, options)
                  : m.book_reader_unavailable({}, options)}
          </p>
          <Button
            variant="outline"
            className={control}
            data-branch-result
            onClick={(event) => request(parent, () => reader.retryBranch(parent), event.detail === 0)}
          >
            {m.book_reader_retry({}, options)}
          </Button>
        </div>
      ) : more?.state === 'more' ? (
        <Button
          variant="ghost"
          className={`${control} justify-self-start`}
          disabled={busy}
          data-branch-result
          onClick={(event) => request(parent, () => reader.moreBranch(parent), event.detail === 0)}
        >
          {m.book_reader_more({}, options)}
        </Button>
      ) : !busy && branch.page ? (
        <p
          tabIndex={-1}
          data-branch-result
          className="px-2 py-2 text-xs text-muted-foreground focus-visible:outline-ring"
        >
          {branch.rows.length ? m.book_reader_level_end({}, options) : m.book_reader_empty({}, options)}
        </p>
      ) : null}
    </div>
  );
}
