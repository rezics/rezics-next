import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ToggleGroup, ToggleGroupItem } from '@rezics/ui/shadcn/toggle-group';
import { Toaster } from '@rezics/ui/shadcn/toast';
import { ShelfEmpty } from '@rezics/ui/shelf-empty';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { EntryRestoreFeedback, EntryUndoForm } from './entry-undo';
import { ContinueSection } from './continue';
import { LibraryNavigation } from './library-nav';
import { libraryNavigationQuery } from './pins-read';
import type { ContinueEntry } from './continue-read';
import type {
  LibraryEntryStateWrite,
  LibraryRestoreInput,
  LibraryRestoreResult,
  PersonalLibraryView,
} from './entries-read';
import { Exposure } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { shelfHref, shelfLayouts, shelfSizes, type ShelfLayout, type ShelfSize } from './shelf-params';
import { ShelfEntries } from './shelf-view';
import { useHydrated } from './shelf-rows';
import { LabelShelfEntries } from './shelf-view';
import type { LabelShelfPageData } from './label-shelf-read';
import { SubjectLabelNotice } from './subject-labels.tsx';

type Display = { layout: ShelfLayout; size: ShelfSize };
function layoutLabel(layout: ShelfLayout): string {
  return layout === 'grid'
    ? m.library_layout_grid()
    : layout === 'list'
      ? m.library_layout_list()
      : m.library_layout_table();
}
function sizeLabel(size: ShelfSize): string {
  return size === 's' ? m.library_size_small() : size === 'm' ? m.library_size_medium() : m.library_size_large();
}
function DisplayControls({
  state,
  locale,
  display,
  label,
}: {
  state?: LibraryEntryStateWrite;
  locale: string;
  display: Display;
  label?: string;
}) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const stateSearch = state ? { state } : {};
  const labelSearch = label ? { label } : {};
  if (!hydrated) {
    const selected = (current: boolean) => buttonVariants({ variant: current ? 'secondary' : 'outline', size: 'sm' });
    return (
      <div className="flex flex-wrap items-center gap-4">
        <nav aria-label={m.library_layout()} className="flex gap-1">
          {shelfLayouts.map((layout) => (
            <a
              key={layout}
              href={shelfHref(locale, { ...stateSearch, ...display, layout, ...labelSearch })}
              aria-current={display.layout === layout ? 'page' : undefined}
              className={`${selected(display.layout === layout)}${layout === 'table' ? ' max-sm:hidden' : ''}`}
            >
              {layoutLabel(layout)}
            </a>
          ))}
        </nav>
        {display.layout === 'grid' ? (
          <nav aria-label={m.library_size()} className="flex gap-1">
            {shelfSizes.map((size) => (
              <a
                key={size}
                href={shelfHref(locale, { ...stateSearch, ...display, size, ...labelSearch })}
                aria-current={display.size === size ? 'page' : undefined}
                className={selected(display.size === size)}
              >
                {sizeLabel(size)}
              </a>
            ))}
          </nav>
        ) : null}
        {state ? (
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href={shelfHref(locale, { layout: display.layout, size: display.size, ...labelSearch })}
          >
            {m.library_clear_state()}
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4">
      <ToggleGroup
        aria-label={m.library_layout()}
        value={[display.layout]}
        onValueChange={(values) => {
          const layout = values[0] as ShelfLayout | undefined;
          if (layout)
            void navigate({ to: '/library', search: { ...stateSearch, ...labelSearch, layout, size: display.size } });
        }}
        variant="outline"
      >
        {shelfLayouts.map((layout) => (
          <ToggleGroupItem key={layout} value={layout} className={layout === 'table' ? 'max-sm:hidden' : undefined}>
            {layoutLabel(layout)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {display.layout === 'grid' ? (
        <ToggleGroup
          aria-label={m.library_size()}
          value={[display.size]}
          onValueChange={(values) => {
            const size = values[0] as ShelfSize | undefined;
            if (size)
              void navigate({
                to: '/library',
                search: { ...stateSearch, ...labelSearch, layout: display.layout, size },
              });
          }}
          variant="outline"
        >
          {shelfSizes.map((size) => (
            <ToggleGroupItem key={size} value={size}>
              {sizeLabel(size)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {state ? (
        <a
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          href={shelfHref(locale, { layout: display.layout, size: display.size, ...labelSearch })}
        >
          {m.library_clear_state()}
        </a>
      ) : null}
    </div>
  );
}

export function PersonalLibraryPage({
  page,
  locale,
  display,
  cursor,
  continueEntries = [],
  undo,
  restore,
  csrfToken,
}: {
  page: PersonalLibraryView;
  locale: string;
  display: Display;
  cursor?: string;
  continueEntries?: ContinueEntry[];
  undo?: LibraryRestoreInput;
  restore?: LibraryRestoreResult;
  csrfToken?: string | null;
}) {
  const navigation = useQuery(libraryNavigationQuery(locale));
  if (!page.signedIn)
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <p>{m.library_sign_in()}</p>
      </div>
    );
  const heading = page.state
    ? m.library_tracked_entries_state({ status: page.stateLabel ?? m.library_other() })
    : m.library_tracked_entries();
  return (
    <Toaster>
      <div className="container mx-auto max-w-7xl space-y-8 px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <PageHeading>{m.library_heading()}</PageHeading>
          <Exposure operation="library_label.list">
            <a href={`/${locale}/library/labels`} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {m.library_nav_labels()}
            </a>
          </Exposure>
        </header>
        {undo ? <EntryUndoForm undo={undo} locale={locale} csrfToken={csrfToken ?? null} /> : null}
        {restore ? <EntryRestoreFeedback restore={restore} locale={locale} /> : null}
        <ContinueSection
          entries={continueEntries}
          locale={locale}
          density={display.size === 's' ? 'small' : display.size === 'l' ? 'large' : 'medium'}
        />
        <LibraryNavigation
          current="tracked"
          pins={navigation.data?.pins ?? { state: 'closed' }}
          collections={navigation.data?.collections ?? []}
        />
        <section aria-labelledby="tracked-entries-heading" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="tracked-entries-heading" className="text-2xl font-semibold">
              {heading}
            </h2>
            <Exposure operation="library_entry.list">
              <DisplayControls {...(page.state ? { state: page.state } : {})} locale={locale} display={display} />
            </Exposure>
          </div>
          {page.state ? (
            <p className="text-sm text-muted-foreground">
              {m.library_filtered_by({ status: page.stateLabel ?? m.library_other() })}
            </p>
          ) : null}
          {page.entries.length ? (
            <ShelfEntries
              key={`${page.state ?? 'all'}:${cursor ?? ''}`}
              entries={page.entries}
              locale={locale}
              {...display}
            />
          ) : (
            <ShelfEmpty
              kind={page.state ? 'no-match' : 'library'}
              title={
                page.state
                  ? m.library_filter_empty_title({ status: page.stateLabel ?? m.library_other() })
                  : m.library_empty_title()
              }
              description={page.state ? m.library_filter_empty_description() : m.library_empty_description()}
              actions={
                <a href={`/${locale}/search`} className={buttonVariants({ variant: 'outline' })}>
                  {m.library_browse()}
                </a>
              }
            />
          )}
          {page.next ? (
            <a
              className={buttonVariants({ variant: 'outline' })}
              href={shelfHref(locale, {
                ...(page.state ? { state: page.state } : {}),
                cursor: page.next,
                layout: display.layout,
                size: display.size,
              })}
            >
              {m.library_next_page()}
            </a>
          ) : null}
        </section>
      </div>
    </Toaster>
  );
}

/** One label's complete current page, with the same presentation controls and shelf tile primitives. */
export function LabelShelfPage({
  page,
  locale,
  display,
}: {
  page: LabelShelfPageData;
  locale: string;
  display: Display;
}) {
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
      <DisplayControls locale={locale} display={display} label={page.label.id} />
      {page.entries.length ? (
        <LabelShelfEntries
          entries={page.entries}
          label={page.label}
          locale={locale}
          {...display}
          csrfToken={page.csrfToken ?? null}
        />
      ) : (
        <ShelfEmpty
          kind="library"
          title={m.library_label_shelf_empty()}
          description={m.library_label_shelf_empty()}
          actions={<span />}
        />
      )}
      {page.next ? (
        <a
          href={shelfHref(locale, { label: page.label.id, ...display, cursor: page.next })}
          className={buttonVariants({ variant: 'outline', size: 'lg' })}
        >
          {m.library_more()}
        </a>
      ) : null}
      {page.undo ? (
        <form
          data-label-undo
          method="post"
          action={`/${encodeURIComponent(locale)}/library?label=${encodeURIComponent(page.label.id)}`}
        >
          <input type="hidden" name="intent" value="restore" />
          <input type="hidden" name="subjectId" value={page.undo.subjectId} />
          <input type="hidden" name="labelId" value={page.undo.labelId} />
          <input type="hidden" name="assignmentId" value={page.undo.assignmentId} />
          <input type="hidden" name="revision" value={page.undo.revision} />
          <input type="hidden" name="csrf_token" value={page.csrfToken ?? ''} />
          <button type="submit" className={buttonVariants({ variant: 'outline' })}>
            {m.library_subject_label_undo()}
          </button>
        </form>
      ) : null}
    </div>
  );
}
