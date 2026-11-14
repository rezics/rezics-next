import type { ReactNode, Ref } from 'react';
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
  headingRef?: Ref<HTMLHeadingElement>;
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
        <dl
          data-slot="public-collection-discovery-applied-context"
          className="grid min-w-0 gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">
              {m.collection_discovery_kind_label({}, options)}
            </dt>
            <dd className="break-all text-sm font-medium">
              {selection.presentationKind ?? m.collection_discovery_kind_placeholder({}, options)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">
              {m.collection_discovery_order_label({}, options)}
            </dt>
            <dd className="text-sm font-medium">
              {selection.order === 'popular'
                ? m.collection_discovery_order_popular({}, options)
                : m.collection_discovery_order_recent({}, options)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">
              {m.collection_discovery_curator_label({}, options)}
            </dt>
            <dd className="break-all font-mono text-sm">{selection.curator ?? '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">
              {m.collection_discovery_subject_label({}, options)}
            </dt>
            <dd className="break-all font-mono text-sm">{selection.subject ?? '—'}</dd>
          </div>
        </dl>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <section
          aria-label={m.collection_discovery_heading({}, options)}
          data-slot="public-collection-discovery-result-region"
          className="min-w-0 space-y-5"
        >
          {results}
        </section>
        <div
          data-slot="public-collection-discovery-refine-region"
          className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
        >
          {refinement}
        </div>
      </div>
    </main>
  );
}
