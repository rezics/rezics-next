import { useCallback, useState } from 'react';
import { ShelfEmpty } from '@rezics/ui/shelf-empty';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { EntryRestoreFeedback, EntryUndoForm } from './entry-undo';
import { ContinueSection, useContinueRefresh } from './continue';
import { LibraryNavigation } from './library-nav';
import type { LibraryNavigationRead } from './pins-read';
import { useCurrentLibraryNavigation } from './pins-current';
import { readContinueEntries, type ContinueEntry, type ContinueView } from './continue-read';
import type { LibraryRestoreReceipt, LibraryRestoreResult, PersonalLibraryView } from './entries-read';
import { Exposure, useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { shelfHref, shelfSort, type ShelfDisplay } from './shelf-params';
import { ShelfEntries } from './shelf-view';
import { DisplayControls, SortControls, EntriesFirstPage } from './entries-current';
import { shelfMutationLease, type ShelfMutationLease } from './shelf-rows';
import { LabelShelfEntries } from './shelf-view';
import type { LabelShelfPageData } from './label-shelf-read';
import { SubjectLabelNotice } from './subject-labels.tsx';
import { ShelfTypes } from './shelf-types';
import { SaveQueryLink } from './saved-query-editor/link';

type Display = ShelfDisplay;

export function PersonalLibraryPage({
  page,
  locale,
  display,
  cursor,
  continueEntries,
  continueState,
  undo,
  restore,
  csrfToken,
  acceptedNavigation,
  originatingLease,
  continueRead,
  continueCurrent,
  continueScope,
  entriesAdmitted = true,
  continueAdmitted = true,
  isCurrent,
}: {
  page: PersonalLibraryView;
  locale: string;
  display: Display;
  cursor?: string;
  continueEntries?: ContinueEntry[];
  continueState?: ContinueView;
  undo?: LibraryRestoreReceipt;
  restore?: LibraryRestoreResult;
  csrfToken?: string | null;
  acceptedNavigation?: LibraryNavigationRead;
  originatingLease?: ShelfMutationLease;
  continueRead?: () => Promise<Exclude<ContinueView, { state: 'unknown' }>>;
  continueCurrent?: () => boolean;
  continueScope?: string;
  entriesAdmitted?: boolean;
  continueAdmitted?: boolean;
  isCurrent?: () => boolean;
}) {
  // Keep the write lease while a predicate replaces rows or temporarily shows no matches.
  const [fallbackLease] = useState(shelfMutationLease);
  const mutationLease = originatingLease ?? fallbackLease;
  const navigation = useCurrentLibraryNavigation(
    locale,
    8,
    JSON.stringify(page.signedIn ? [page.type, page.state, cursor, page.sort] : [cursor]),
    acceptedNavigation === undefined,
  );
  const currentNavigation = acceptedNavigation ?? navigation.data;
  const readContinue = useCallback(() => readContinueEntries({ data: {} }), []);
  const resume = useContinueRefresh(continueState, continueRead ?? readContinue, continueScope ?? locale);
  const currentContinue = continueState ? resume.result : undefined;
  // Only a successful exhausted source establishes absence; readiness and failed reads remain visible.
  const continueAbsent =
    currentContinue?.state === 'loaded' && currentContinue.entries.length === 0 && currentContinue.next === null;

  if (!page.signedIn)
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <p>{m.library_sign_in()}</p>
      </div>
    );
  const sort = page.sort ?? shelfSort(page);
  const filterSort = page.sortExplicit ? sort : undefined;
  const effectiveCursor = page.cursorReset ? undefined : cursor;
  const typeSearch = page.type ? { type: page.type } : {};
  const firstPage = { ...typeSearch, ...(page.state ? { state: page.state } : {}), ...sort, ...display };
  const clearTypeHref = shelfHref(locale, { ...(page.state ? { state: page.state } : {}), ...sort, ...display });
  const typeLabel = page.typeLabel ?? m.library_type_unnamed();
  const heading = page.state
    ? m.library_tracked_entries_state({ status: page.stateLabel ?? m.library_other() })
    : m.library_tracked_entries();
  return (
    <div className="w-full min-w-0 space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_heading()}</PageHeading>
        <Exposure operation="library_label.list">
          <a href={`/${locale}/library/labels`} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {m.library_nav_labels()}
          </a>
        </Exposure>
      </header>
      <LibraryNavigation
        current="tracked"
        locale={locale}
        pins={currentNavigation?.pins ?? { state: navigation.isError ? 'unavailable' : 'preparing' }}
        collections={currentNavigation?.collections ?? []}
        collectionsState={currentNavigation?.collectionsState ?? (navigation.isError ? 'unavailable' : 'preparing')}
      />
      {undo ? (
        <EntryUndoForm
          undo={undo}
          locale={locale}
          csrfToken={csrfToken ?? null}
          returnTo={shelfHref(locale, {
            ...typeSearch,
            ...display,
            ...sort,
            ...(page.state ? { state: page.state } : {}),
            ...(effectiveCursor ? { cursor: effectiveCursor } : {}),
          })}
        />
      ) : null}
      {restore ? <EntryRestoreFeedback restore={restore} locale={locale} /> : null}
      {continueAbsent ? null : (
        <div hidden={!continueAdmitted}>
          <ContinueSection
            {...(currentContinue ? { state: currentContinue } : continueEntries ? { entries: continueEntries } : {})}
            onRetry={() => {
              if (continueCurrent?.() ?? true) void resume.refresh();
            }}
            busy={resume.busy}
            locale={locale}
            density={display.size === 's' ? 'small' : display.size === 'l' ? 'large' : 'medium'}
          />
        </div>
      )}
      <section hidden={!entriesAdmitted} aria-labelledby="tracked-entries-heading" className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="tracked-entries-heading" className="text-2xl font-semibold">
            {heading}
          </h2>
          <Exposure operation="library_entry.list">
            <DisplayControls
              {...typeSearch}
              {...(page.state ? { state: page.state } : {})}
              locale={locale}
              display={display}
              {...(isCurrent ? { isCurrent } : {})}
              tableAvailable={!page.readState && page.entries.length > 0}
              sort={sort}
              {...(filterSort ? { filterSort } : {})}
              {...(effectiveCursor ? { cursor: effectiveCursor } : {})}
            />
          </Exposure>
        </div>
        <SortControls
          key={`${page.type ?? ''}:${page.state ?? ''}:${sort.orderBy}:${sort.direction}`}
          locale={locale}
          {...(page.state ? { state: page.state } : {})}
          display={display}
          sort={sort}
          {...(isCurrent ? { isCurrent } : {})}
          {...typeSearch}
        />
        <div className="flex flex-wrap items-center gap-2">
          <ShelfTypes
            key={`${locale}:${page.type ?? ''}`}
            locale={locale}
            view={{ ...typeSearch, ...(page.state ? { state: page.state } : {}), ...sort, ...display }}
            {...(page.typeLabel ? { typeLabel: page.typeLabel } : {})}
          />
          {page.type ? (
            <a href={clearTypeHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {m.library_type_clear()}
            </a>
          ) : null}
          {page.type || page.state ? (
            <Exposure operation="collection.create">
              <SaveQueryLink
                {...(page.type ? { type: page.type } : {})}
                {...(page.state ? { state: page.state } : {})}
                from={shelfHref(locale, {
                  ...typeSearch,
                  ...(page.state ? { state: page.state } : {}),
                  ...sort,
                  ...display,
                })}
              />
            </Exposure>
          ) : null}
        </div>
        {page.cursorReset ? <p role="status">{m.library_sort_restarted()}</p> : null}
        {page.type ? (
          <p className="text-sm text-muted-foreground">{m.library_type_filtered({ type: typeLabel })}</p>
        ) : null}
        {page.state ? (
          <p className="text-sm text-muted-foreground">
            {m.library_filtered_by({ status: page.stateLabel ?? m.library_other() })}
          </p>
        ) : null}
        {page.readState ? (
          <div className="flex flex-col items-start gap-3">
            <p role={page.readState === 'preparing' ? 'status' : 'alert'}>
              {page.readState === 'closed'
                ? m.platform_closed_message()
                : page.readState === 'denied'
                  ? m.library_sort_denied()
                  : page.readState === 'preparing'
                    ? m.library_sort_preparing()
                    : m.error_message()}
            </p>
            <EntriesFirstPage locale={locale} view={firstPage} />
          </div>
        ) : (
          <ShelfEntries
            key={`${page.type ?? ''}:${page.state ?? 'all'}:${sort.orderBy}:${sort.direction}:${effectiveCursor ?? ''}`}
            mutationLease={mutationLease}
            {...(isCurrent ? { isCurrent } : {})}
            {...typeSearch}
            sort={sort}
            {...(filterSort ? { filterSort } : {})}
            {...(page.state ? { state: page.state } : {})}
            entries={page.entries}
            {...(effectiveCursor ? { cursor: effectiveCursor } : {})}
            locale={locale}
            {...display}
            empty={
              effectiveCursor || page.next ? (
                <Empty role="status">
                  <EmptyHeader>
                    <EmptyTitle>{m.library_entries_page_empty()}</EmptyTitle>
                  </EmptyHeader>
                  <EntriesFirstPage locale={locale} view={firstPage} />
                </Empty>
              ) : (
                <ShelfEmpty
                  kind={page.type || page.state ? 'no-match' : 'library'}
                  title={
                    page.type
                      ? m.library_type_empty_title({ type: typeLabel })
                      : page.state
                        ? m.library_filter_empty_title({ status: page.stateLabel ?? m.library_other() })
                        : m.library_empty_title()
                  }
                  description={
                    page.type || page.state ? m.library_filter_empty_description() : m.library_empty_description()
                  }
                  actions={
                    page.type ? (
                      <a href={clearTypeHref} className={buttonVariants({ variant: 'outline' })}>
                        {m.library_type_clear()}
                      </a>
                    ) : (
                      <a href={`/${locale}/search`} className={buttonVariants({ variant: 'outline' })}>
                        {m.library_browse()}
                      </a>
                    )
                  }
                />
              )
            }
          />
        )}
        {page.next ? (
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={shelfHref(locale, {
              ...typeSearch,
              ...(page.state ? { state: page.state } : {}),
              ...sort,
              cursor: page.next,
              ...display,
            })}
          >
            {m.library_next_page()}
          </a>
        ) : null}
      </section>
    </div>
  );
}

/** One label's complete current page, with the same presentation controls and shelf tile primitives. */
export function LabelShelfPage({
  page,
  locale,
  display,
  isCurrent,
  canUnassign,
}: {
  page: LabelShelfPageData;
  locale: string;
  display: Display;
  isCurrent?: () => boolean;
  canUnassign?: () => boolean;
}) {
  if (page.state === 'unavailable' || page.state === 'denied' || page.state === 'preparing')
    return (
      <div className="max-w-6xl space-y-6 text-foreground">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p role={page.state === 'unavailable' ? 'alert' : 'status'}>
          {page.state === 'preparing'
            ? m.library_labels_preparing()
            : page.state === 'denied'
              ? m.library_labels_denied()
              : m.library_subject_label_unavailable()}
        </p>
        <a href={`/${encodeURIComponent(locale)}/library/labels`}>{m.library_labels_heading()}</a>
      </div>
    );
  if (page.state === 'closed')
    return (
      <div className="max-w-6xl space-y-6 text-foreground">
        <PageHeading>{m.library_heading()}</PageHeading>
        <p role="status">{m.library_label_shelf_closed()}</p>
      </div>
    );
  if (page.state === 'signed-out')
    return (
      <div className="max-w-6xl space-y-6 text-foreground">
        <PageHeading>{m.account_sign_in()}</PageHeading>
      </div>
    );
  return (
    <div className="max-w-6xl space-y-6 text-foreground">
      <PageHeading>{page.label.name}</PageHeading>
      <SubjectLabelNotice {...(page.labelResult !== undefined ? { result: page.labelResult } : {})} />
      <DisplayControls locale={locale} display={display} label={page.label.id} {...(isCurrent ? { isCurrent } : {})} />
      {page.entries.length ? (
        <LabelShelfEntries
          entries={page.entries}
          label={page.label}
          locale={locale}
          {...display}
          {...(canUnassign ? { isCurrent: canUnassign } : {})}
          csrfToken={page.csrfToken ?? null}
        />
      ) : (
        <Empty role="status" data-kind="library">
          <EmptyHeader>
            <EmptyTitle>{m.library_label_shelf_empty()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {page.next ? (
        <a
          onClick={(event) => {
            if (isCurrent && !isCurrent()) event.preventDefault();
          }}
          href={shelfHref(locale, { label: page.label.id, ...display, cursor: page.next })}
          className={buttonVariants({ variant: 'outline', size: 'lg' })}
        >
          {m.library_more()}
        </a>
      ) : null}
      {page.undo ? (
        <Exposure operation="library_label.unassign">
          <form
            data-label-undo
            method="post"
            action={shelfHref(locale, { label: page.label.id, ...display })}
            onSubmit={(event) => {
              if (canUnassign && !canUnassign()) event.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="restore" />
            <input type="hidden" name="subjectId" value={page.undo.subjectId} />
            <input type="hidden" name="labelId" value={page.undo.labelId} />
            <input type="hidden" name="assignmentId" value={page.undo.assignmentId} />
            <input type="hidden" name="idempotencyKey" value={page.undoKey} />
            <input type="hidden" name="revision" value={page.undo.revision} />
            <input type="hidden" name="csrf_token" value={page.csrfToken ?? ''} />
            <button type="submit" className={buttonVariants({ variant: 'outline' })}>
              {m.library_subject_label_undo()}
            </button>
          </form>
        </Exposure>
      ) : null}
    </div>
  );
}
