import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { PublicCollectionDiscoveryState } from './read';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function collectionListHref(locale: string, cursor?: string) {
  const path = `/${locale}/collections`;
  return cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`;
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
}: {
  state: PublicCollectionDiscoveryState;
  locale: string;
  cursor?: string;
  continuation?: boolean;
  retrying?: boolean;
  onRetry: () => void;
}) {
  const options = messageOptions(locale);
  return (
    <main className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.collection_discovery_heading({}, options)}</PageHeading>
      <p className="max-w-3xl text-muted-foreground">{m.collection_discovery_intro({}, options)}</p>
      {state.status === 'ready' ? (
        <section aria-label={m.collection_discovery_heading({}, options)} className="space-y-5">
          {state.collections.length > 0 ? (
            <ul role="list" data-slot="public-collection-discovery-results" className="space-y-3">
              {state.collections.map((collection) => (
                <li key={collection.id} className="rounded-lg border p-4">
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
          {state.next ? (
            <a href={collectionListHref(locale, state.next)} className={buttonVariants({ variant: 'outline' })}>
              {m.collection_discovery_more({}, options)}
            </a>
          ) : null}
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
            <Button type="button" variant="outline" disabled={retrying} onClick={onRetry}>
              {m.collection_discovery_retry({}, options)}
            </Button>
          )}
          {continuation ? (
            <a href={collectionListHref(locale)} className={buttonVariants({ variant: 'outline' })}>
              {m.collection_discovery_restart({}, options)}
            </a>
          ) : null}
        </section>
      )}
    </main>
  );
}
