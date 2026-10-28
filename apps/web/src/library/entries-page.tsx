import { Exposure } from '../kernel/exposure';
import { ShelfEmpty } from '@rezics/ui/shelf-empty';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { shelfSectionOrder, type LibraryEntryStateWrite, type PersonalLibraryView } from './entries-read';
import { shelfHref, shelfLayouts, shelfSizes, type ShelfLayout, type ShelfSize } from './shelf-params';
import { ShelfEntries, stateLabel } from './shelf-view';

type Display = { layout: ShelfLayout; size: ShelfSize };
type SignedIn = Extract<PersonalLibraryView, { signedIn: true }>;

const tabClass =
  'shrink-0 border-b-2 border-transparent px-3 py-3 text-sm text-muted-foreground aria-[current=page]:border-primary aria-[current=page]:font-semibold aria-[current=page]:text-foreground';

function layoutLabel(layout: ShelfLayout): string {
  if (layout === 'grid') return m.library_layout_grid();
  if (layout === 'list') return m.library_layout_list();
  return m.library_layout_table();
}

function sizeLabel(size: ShelfSize): string {
  if (size === 's') return m.library_size_small();
  if (size === 'm') return m.library_size_medium();
  return m.library_size_large();
}

/** The status tabs. Each is a link, so they work without JavaScript, and each keeps the chosen layout and size. */
function Tabs({ state, locale, display }: { state: LibraryEntryStateWrite | null; locale: string; display: Display }) {
  const tabs: { state: LibraryEntryStateWrite | null; label: string }[] = [
    { state: null, label: m.library_state_all() },
    ...shelfSectionOrder.map((tab) => ({ state: tab, label: stateLabel(tab) })),
  ];
  return (
    <nav aria-label={m.library_states()} className="flex min-w-0 gap-1 overflow-x-auto border-b">
      <Exposure operation="library_entry.list">
        {tabs.map((tab) => (
          <a
            key={tab.state ?? 'all'}
            href={shelfHref(locale, { state: tab.state, ...display })}
            {...(state === tab.state ? { 'aria-current': 'page' as const } : {})}
            className={tabClass}
          >
            {tab.label}
          </a>
        ))}
      </Exposure>
      <Exposure operation="collection.list">
        <a href={`/${locale}/library/collections`} className={tabClass}>
          {m.library_nav_collections()}
        </a>
      </Exposure>
    </nav>
  );
}

/** Layout and grid size, as links that rewrite the address; the table is for wide screens only. */
function DisplayLinks({
  state,
  locale,
  display,
}: {
  state: LibraryEntryStateWrite | null;
  locale: string;
  display: Display;
}) {
  const link = (current: boolean) => buttonVariants({ variant: current ? 'secondary' : 'outline', size: 'sm' });
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav aria-label={m.library_layout()} className="flex gap-1">
        {shelfLayouts.map((layout) => (
          <a
            key={layout}
            href={shelfHref(locale, { state, ...display, layout })}
            {...(display.layout === layout ? { 'aria-current': 'true' as const } : {})}
            className={`${link(display.layout === layout)}${layout === 'table' ? ' max-sm:hidden' : ''}`}
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
              href={shelfHref(locale, { state, ...display, size })}
              {...(display.size === size ? { 'aria-current': 'true' as const } : {})}
              className={link(display.size === size)}
            >
              {sizeLabel(size)}
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

function Overview({
  page,
  locale,
  display,
}: {
  page: Extract<SignedIn, { state: null }>;
  locale: string;
  display: Display;
}) {
  return (
    <div className="space-y-10">
      {page.sections.map((section) => (
        <ShelfEntries
          key={section.state}
          entries={section.entries}
          shelf={section.state}
          locale={locale}
          {...display}
          section={{
            title: section.state === 'in_progress' ? m.library_continue() : stateLabel(section.state),
            href: shelfHref(locale, { state: section.state, ...display }),
          }}
        />
      ))}
    </div>
  );
}

function StatusTab({
  page,
  cursor,
  locale,
  display,
}: {
  page: Extract<SignedIn, { state: LibraryEntryStateWrite }>;
  cursor: string | undefined;
  locale: string;
  display: Display;
}) {
  return (
    <div className="space-y-6">
      {page.entries.length ? (
        <ShelfEntries
          key={`${page.state}:${cursor ?? ''}`}
          entries={page.entries}
          shelf={page.state}
          locale={locale}
          {...display}
        />
      ) : (
        <ShelfEmpty
          kind="tab"
          title={m.library_tab_empty_title({ status: stateLabel(page.state) })}
          description={m.library_tab_empty_description()}
          actions={
            <Exposure operation="library_entry.list">
              <a href={shelfHref(locale, display)} className={buttonVariants({ variant: 'outline' })}>
                {m.library_view_all()}
              </a>
            </Exposure>
          }
        />
      )}
      {page.next ? (
        <Exposure operation="library_entry.list">
          <a
            href={shelfHref(locale, { state: page.state, ...display, cursor: page.next })}
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            {m.library_more()}
          </a>
        </Exposure>
      ) : null}
    </div>
  );
}

function SignedInLibrary({
  page,
  cursor,
  locale,
  display,
}: {
  page: SignedIn;
  cursor: string | undefined;
  locale: string;
  display: Display;
}) {
  const empty = page.state === null && page.sections.length === 0;
  return (
    <>
      <Tabs state={page.state} locale={locale} display={display} />
      {empty ? (
        <ShelfEmpty
          kind="library"
          title={m.library_empty_title()}
          description={m.library_empty_description()}
          actions={
            <a href={`/${locale}/search`} className={buttonVariants()}>
              {m.library_browse()}
            </a>
          }
        />
      ) : (
        <>
          {page.state === null || page.entries.length ? (
            <Exposure operation="library_entry.list">
              <DisplayLinks state={page.state} locale={locale} display={display} />
            </Exposure>
          ) : null}
          {page.state === null ? (
            <Overview page={page} locale={locale} display={display} />
          ) : (
            <StatusTab page={page} cursor={cursor} locale={locale} display={display} />
          )}
        </>
      )}
    </>
  );
}

export function PersonalLibraryPage({
  page,
  locale,
  display,
  cursor,
}: {
  page: PersonalLibraryView;
  locale: string;
  display: Display;
  cursor?: string | undefined;
}) {
  return (
    <div className="max-w-6xl space-y-6 text-foreground">
      <PageHeading>{m.library_heading()}</PageHeading>
      <SignedInLibrary page={page as SignedIn} cursor={cursor} locale={locale} display={display} />
    </div>
  );
}
