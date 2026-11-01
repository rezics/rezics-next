import { Link } from '@tanstack/react-router';
import { ContentItem } from '@rezics/ui/content-item';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { MyRealmsPage } from './space';

/** The signed-in person's Realms, one page at a time, each linked to its home. */
export function MyRealmsPageView({ page }: { page: MyRealmsPage }) {
  const locale = getLocale();

  return (
    <article className="max-w-3xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.realms_heading()}</PageHeading>
      </header>
      {page.realms.length ? (
        <ul className="space-y-1">
          {page.realms.map((realm) => (
            <ContentItem
              key={realm.realmId}
              title={realm.name}
              headingLevel={2}
              href={`/${locale}/realms/${encodeURIComponent(realm.realmId)}`}
              className="flex items-start gap-4 rounded-xl px-4 py-3"
              preview={
                realm.description ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">{realm.description}</p>
                ) : undefined
              }
            />
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
