import type { ReactNode, Ref } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { PublicCollectionDirectorySelection } from '../../search/contracts/collection-directory';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

export function PublicCollectionDiscoveryWorkspace({
  locale,
  selection,
  headingRef,
  results,
  refinement,
}: {
  locale: string;
  selection: PublicCollectionDirectorySelection;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  results: ReactNode;
  refinement: ReactNode;
}) {
  const options = messageOptions(locale);
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 [overflow-wrap:anywhere]">
      <header className="space-y-4">
        <div className="space-y-2">
          <PageHeading ref={headingRef} tabIndex={-1}>
            {m.collection_discovery_heading({}, options)}
          </PageHeading>
          <p className="max-w-3xl text-muted-foreground">{m.collection_discovery_intro({}, options)}</p>
        </div>
      </header>
      <details className="group border-y border-border" data-slot="public-collection-discovery-refine-region">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          <SlidersHorizontal aria-hidden="true" className="size-4 text-muted-foreground" />
          {m.collection_filters({}, options)}
          <span className="ms-auto min-w-0 text-end font-normal text-muted-foreground">
            {selection.order === 'popular'
              ? m.collection_discovery_order_popular({}, options)
              : m.collection_discovery_order_recent({}, options)}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
        </summary>
        <div className="min-w-0 max-w-3xl border-t border-border/60 py-4">{refinement}</div>
      </details>
      {selection.presentationKind || selection.curator || selection.subject ? (
        <dl
          data-slot="public-collection-discovery-applied-context"
          className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-sm"
        >
          {[
            [m.collection_discovery_kind_label({}, options), selection.presentationKind],
            [m.collection_discovery_curator_label({}, options), selection.curator],
            [m.collection_discovery_subject_label({}, options), selection.subject],
          ].map(([label, value]) =>
            value ? (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-medium">
                  <bdi>{value}</bdi>
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}
      <section
        aria-label={m.collection_discovery_heading({}, options)}
        data-slot="public-collection-discovery-result-region"
        className="min-w-0 space-y-5"
      >
        {results}
      </section>
    </main>
  );
}
