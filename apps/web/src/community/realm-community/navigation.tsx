import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

/** Local section movement leaves the admitted route and its shelf cursors untouched. */
export function CommunitySectionNavigation({ catalogueId, current }: { catalogueId: string; current: () => boolean }) {
  const headingId = useId();
  const sections = [
    { id: catalogueId, label: m.realm_catalogue_heading() },
    { id: 'realm-boards-heading', label: m.realm_boards_heading() },
    { id: 'realm-published-heading', label: m.realm_published_heading() },
  ];
  return (
    <nav
      aria-labelledby={headingId}
      data-slot="community-section-navigation"
      className="grid min-w-0 gap-2 rounded-xl border border-border bg-muted/30 p-3 [overflow-wrap:anywhere] sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)] sm:items-start sm:gap-4 sm:p-4"
    >
      <p id={headingId} className="min-w-0 text-xs font-semibold text-muted-foreground">
        {m.community_page_navigation()}
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {sections.map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            size="sm"
            aria-controls={id}
            className="h-auto min-h-6 max-w-full whitespace-normal text-start"
            onClick={() => {
              if (!current()) return;
              const region = document.getElementById(id);
              region?.focus({ preventScroll: true });
              region?.scrollIntoView({ block: 'start' });
            }}
          >
            {label}
          </Button>
        ))}
      </div>
    </nav>
  );
}
