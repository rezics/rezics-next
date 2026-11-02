import { useEffect, useId, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { ContentItem } from '@rezics/ui/content-item';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { MyRealmsPage } from './space';

/** The signed-in person's Realms, one page at a time, each linked to its home. */
export function MyRealmsPageView({
  page,
  onKeyboardNext,
  focusContinuation,
}: {
  page: MyRealmsPage;
  onKeyboardNext?: (cursor: string) => void;
  focusContinuation?: (() => boolean) | undefined;
}) {
  const locale = getLocale();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const attemptedFocus = useRef(false);
  const next = page.next;

  useEffect(() => {
    if (attemptedFocus.current || !focusContinuation) return;
    attemptedFocus.current = true;
    if (focusContinuation()) heading.current?.focus();
  }, [focusContinuation]);

  return (
    <article className="min-w-0 max-w-3xl text-foreground [overflow-wrap:anywhere]">
      <section aria-labelledby={headingId} className="space-y-8">
        <header>
          <PageHeading id={headingId} ref={heading} tabIndex={-1}>
            {m.realms_heading()}
          </PageHeading>
        </header>
        {page.realms.length ? (
          <ul aria-labelledby={headingId} className="space-y-1">
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
          <p className="text-muted-foreground">
            {page.next ? m.realm_list_details_sparse_page_empty() : m.realms_empty()}
          </p>
        )}
        {next ? (
          <nav aria-label={m.realms_heading()}>
            <Link
              to="/realms"
              search={{ cursor: next }}
              onClick={(event) => {
                if (event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
                  onKeyboardNext?.(next);
              }}
              className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal rounded-lg border border-border px-4 py-2 text-start text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.realms_more()}
            </Link>
          </nav>
        ) : null}
      </section>
    </article>
  );
}
