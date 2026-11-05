import type { MouseEvent, Ref } from 'react';
import { CollectionDiscoveryCard } from '../showcase-collection/discovery-card';
import { Button } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { PublicCollectionDiscoveryState } from './read';
import type { Coordinate, Movement } from './window-navigation';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function collectionListHref(locale: string, cursor: Coordinate) {
  const path = `/${locale}/collections`;
  return cursor === null ? path : `${path}?cursor=${encodeURIComponent(cursor)}`;
}

function collectionHref(locale: string, id: string) {
  return `/${locale}/collections/${encodeURIComponent(id)}`;
}

export function PublicCollectionDiscoveryPage({
  state,
  locale,
  cursor,
  continuation = cursor !== undefined,
  retrying = false,
  onRetry,
  headingRef,
  navigation,
}: {
  state: PublicCollectionDiscoveryState;
  locale: string;
  cursor?: string;
  continuation?: boolean;
  retrying?: boolean;
  onRetry: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  navigation?: {
    previous?: Coordinate;
    hasPrevious: boolean;
    pending: boolean;
    href: (coordinate: Coordinate) => string;
    move: (event: MouseEvent<HTMLAnchorElement>, movement: Movement, coordinate: Coordinate) => void;
  };
}) {
  const options = messageOptions(locale);
  const controlClass =
    'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-center text-sm font-medium text-primary underline-offset-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring whitespace-normal';
  const hrefFor = (coordinate: Coordinate) => navigation?.href(coordinate) ?? collectionListHref(locale, coordinate);
  const control = (label: string, movement: Movement, coordinate: Coordinate, slot: string) => (
    <a
      data-slot={slot}
      href={hrefFor(coordinate)}
      aria-disabled={navigation?.pending || retrying || undefined}
      onClick={navigation ? (event) => navigation.move(event, movement, coordinate) : undefined}
      className={controlClass}
    >
      {label}
    </a>
  );
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 [overflow-wrap:anywhere]">
      <PageHeading ref={headingRef} tabIndex={-1}>
        {m.collection_discovery_heading({}, options)}
      </PageHeading>
      <p className="max-w-3xl text-muted-foreground">{m.collection_discovery_intro({}, options)}</p>
      {state.status === 'ready' ? (
        <section aria-label={m.collection_discovery_heading({}, options)} className="space-y-5">
          {state.collections.length > 0 ? (
            <ul role="list" data-slot="public-collection-discovery-results" className="space-y-3">
              {state.collections.map((collection) => (
                <li key={collection.id} className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6">
                  {collection.card ? (
                    <CollectionDiscoveryCard card={collection.card} locale={locale} />
                  ) : (
                    <>
                      <a
                        href={collectionHref(locale, collection.id)}
                        lang={collection.titleLanguage}
                        className="block min-h-11 rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {collection.title || m.subject_value_unlabelled({}, options)}
                      </a>
                      {collection.description ? (
                        <p
                          lang={collection.descriptionLanguage}
                          className="mt-2 text-sm leading-relaxed text-muted-foreground"
                        >
                          {collection.description}
                        </p>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="rounded-lg border p-4 text-muted-foreground">
              {cursor || state.next
                ? m.collection_discovery_page_empty({}, options)
                : m.collection_discovery_empty({}, options)}
            </p>
          )}
          <nav aria-label={m.collection_discovery_heading({}, options)} className="flex flex-wrap gap-2">
            {navigation?.hasPrevious
              ? control(m.collection_discovery_previous({}, options), 'previous', navigation.previous!, 'previous')
              : null}
            {cursor !== undefined ? control(m.collection_discovery_first({}, options), 'first', null, 'first') : null}
            {state.next ? control(m.collection_discovery_more({}, options), 'next', state.next, 'continuation') : null}
          </nav>
        </section>
      ) : (
        <section
          role={state.status === 'denied' ? 'alert' : 'status'}
          aria-live={state.status === 'denied' ? 'assertive' : 'polite'}
          className="space-y-4 rounded-lg border p-4"
          data-state={state.status}
        >
          <p>
            {state.status === 'loading'
              ? m.collection_discovery_loading({}, options)
              : state.status === 'preparing' || state.status === 'not-ready'
                ? m.collection_discovery_preparing({}, options)
                : state.status === 'restart'
                  ? m.collection_discovery_restart_required({}, options)
                  : state.status === 'denied'
                    ? continuation
                      ? m.collection_discovery_continuation_refused({}, options)
                      : m.collection_discovery_denied({}, options)
                    : m.collection_discovery_unavailable({}, options)}
          </p>
          {(state.status === 'preparing' ||
            state.status === 'not-ready' ||
            state.status === 'unavailable' ||
            state.status === 'closed') && (
            <Button
              data-slot="retry"
              type="button"
              variant="outline"
              className="min-h-11 min-w-11"
              disabled={retrying}
              onClick={onRetry}
            >
              {m.collection_discovery_retry({}, options)}
            </Button>
          )}
          {continuation ? (
            control(m.collection_discovery_restart({}, options), 'first', null, 'restart')
          ) : null}
        </section>
      )}
    </main>
  );
}
