import { Link } from '@tanstack/react-router';
import { placeholderColors } from '@rezics/ui/cover';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { MyRealmsPage } from './space';

/** The signed-in person's Realms, one page at a time, each linked to its home. */
export function MyRealmsPageView({ page }: { page: MyRealmsPage }) {
  return (
    <article className="max-w-3xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.realms_heading()}</PageHeading>
      </header>
      {page.realms.length ? (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card">
          {page.realms.map((realm) => (
            <li key={realm.realmId}>
              <Link
                to="/realms/$id"
                params={{ id: realm.realmId }}
                className="flex min-h-14 items-center gap-4 px-4 py-3 font-medium text-primary underline-offset-4 hover:bg-muted/60 hover:underline"
              >
                <span
                  aria-hidden
                  className="h-8 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: placeholderColors({ id: realm.realmId, types: [] }).background }}
                />
                {realm.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{m.realms_empty()}</p>
      )}
      {page.next ? (
        <nav aria-label={m.realms_heading()}>
          <Link
            to="/realms"
            search={{ cursor: page.next }}
            className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
          >
            {m.realms_more()}
          </Link>
        </nav>
      ) : null}
    </article>
  );
}
