import { m } from '../../paraglide/messages.js';

/** Local section movement leaves the admitted route and its shelf cursors untouched. */
export function CommunitySectionNavigation({ catalogueId, current }: { catalogueId: string; current: () => boolean }) {
  const sections = [
    { id: catalogueId, label: m.realm_catalogue_heading() },
    { id: 'realm-boards-heading', label: m.realm_boards_heading() },
    { id: 'realm-published-heading', label: m.realm_published_heading() },
  ];
  return (
    <nav
      aria-label={m.community_page_navigation()}
      data-slot="community-section-navigation"
      className="grid min-w-0 gap-2 rounded-xl border border-border bg-muted/30 p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-4 sm:p-4"
    >
      <p aria-hidden="true" className="text-xs font-semibold text-muted-foreground">
        {m.community_page_navigation()}
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {sections.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-lg border border-border bg-background px-3 py-2 text-start text-sm font-medium whitespace-normal text-primary underline-offset-4 hover:bg-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => {
              if (!current()) return;
              const region = document.getElementById(id);
              region?.focus({ preventScroll: true });
              region?.scrollIntoView({ block: 'start' });
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
