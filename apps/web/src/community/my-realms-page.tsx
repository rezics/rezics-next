import { Link } from '@tanstack/react-router';
import { ListRow } from '@rezics/ui/list-row';
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
        <ul className="space-y-1">
          {page.realms.map((realm) => (
            <ListRow key={realm.realmId} className="flex items-start gap-4 rounded-xl px-4 py-3">
              <Link
                to="/realms/$id"
                params={{ id: realm.realmId }}
                data-slot="list-row-link"
                className="absolute inset-1 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="sr-only">{realm.name}</span>
              </Link>
              <div className="min-w-0 flex-1 space-y-1">
                <h2 aria-hidden="true" className="font-semibold">
                  {realm.name}
                </h2>
                {realm.description ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">{realm.description}</p>
                ) : null}
              </div>
            </ListRow>
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
