import { useEffect, useId, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { MyRealmsCurrentRowView } from './my-realms-current/states';
import type { MyRealmsCurrentController } from './my-realms-current/contract';
import type { MyRealmsPage } from './space';
import type { MyRealmsMovement, MyRealmsNavigation } from './my-realms-caller';

/** One admitted inventory window; membership alone supplies no current entry authority. */
export function MyRealmsPageView({
  page,
  navigation,
  onMove,
  focusContinuation,
  currentController,
}: {
  page: MyRealmsPage;
  navigation?: MyRealmsNavigation | undefined;
  onMove?: (kind: MyRealmsMovement, cursor: string | null, trigger?: HTMLElement) => boolean;
  focusContinuation?: (() => boolean) | undefined;
  currentController?: MyRealmsCurrentController | undefined;
}) {
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
    <article data-slot="my-realms-page" className="min-w-0 max-w-3xl text-foreground [overflow-wrap:anywhere]">
      <section aria-labelledby={headingId} className="space-y-8">
        <header>
          <PageHeading id={headingId} ref={heading} tabIndex={-1}>
            {m.realms_heading()}
          </PageHeading>
        </header>
        {page.realms.length ? (
          <ul aria-labelledby={headingId} className="space-y-1">
            {page.realms.map((realm) => (
              <li key={realm.realmId}>
                <MyRealmsCurrentRowView row={realm} controller={currentController} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            {page.next ? m.realm_list_details_sparse_page_empty() : m.realms_empty()}
          </p>
        )}
        {next || navigation?.previous !== undefined || navigation?.first ? (
          <nav aria-label={m.realms_heading()} className="flex flex-wrap gap-3">
            {[
              ...(navigation?.previous !== undefined
                ? [{ kind: 'previous' as const, cursor: navigation.previous, label: m.prq_previous() }]
                : []),
              ...(navigation?.first ? [{ kind: 'first' as const, cursor: null, label: m.realms_first_page() }] : []),
              ...(next ? [{ kind: 'next' as const, cursor: next, label: m.realms_more() }] : []),
            ].map(({ kind, cursor, label }) => (
              <Link
                key={kind}
                to="/realms"
                search={cursor === null ? {} : { cursor }}
                preload={false}
                onClick={(event) => {
                  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                    return;
                  if (onMove && !onMove(kind, cursor, event.detail === 0 ? event.currentTarget : undefined))
                    event.preventDefault();
                }}
                className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal rounded-lg border border-border px-4 py-2 text-start text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {label}
              </Link>
            ))}
          </nav>
        ) : null}
      </section>
    </article>
  );
}
