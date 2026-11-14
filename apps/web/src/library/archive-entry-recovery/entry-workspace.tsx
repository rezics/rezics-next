import type { ReactNode, Ref } from 'react';

type ArchiveEntryWorkspaceProps = {
  mainRef: Ref<HTMLElement>;
  header: ReactNode;
  areaNavigation: ReactNode;
  status: ReactNode;
  upload: ReactNode;
  scope: ReactNode;
  inventory: ReactNode;
  beforeBodyActions: ReactNode;
  windowNavigation: ReactNode;
  windowNavigationLabel: string;
  records: ReactNode;
  review: ReactNode;
  results: ReactNode;
  afterBodyActions: ReactNode;
  footer: ReactNode;
};

/** Presentation-only slots keep the mounted recovery journey and all of its children page-owned. */
export function ArchiveEntryWorkspace({
  mainRef,
  header,
  areaNavigation,
  status,
  upload,
  scope,
  inventory,
  beforeBodyActions,
  windowNavigation,
  windowNavigationLabel,
  records,
  review,
  results,
  afterBodyActions,
  footer,
}: ArchiveEntryWorkspaceProps) {
  return (
    <main ref={mainRef} className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 [overflow-wrap:anywhere]">
      <header className="space-y-3">{header}</header>
      {areaNavigation}
      {status}
      <div className="rounded-lg border p-4">{upload}</div>
      {scope}
      {inventory}
      {beforeBodyActions}
      {windowNavigation ? (
        <nav aria-label={windowNavigationLabel} className="flex flex-wrap gap-3">
          {windowNavigation}
        </nav>
      ) : null}
      <div className="min-w-0 space-y-6">
        {records}
        {review}
        {results}
      </div>
      {afterBodyActions}
      {footer}
    </main>
  );
}

/** Keeps a record's evidence before its controls on narrow screens and beside them on wide screens. */
export function ArchiveEntryRecordLayout({
  context,
  operation,
}: {
  context: ReactNode;
  operation: ReactNode;
}) {
  const hasContext = context !== null && context !== undefined && context !== false;
  return (
    <article
      className={
        'grid min-w-0 gap-4 rounded-lg border p-4 ' +
        (hasContext ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start' : '')
      }
    >
      {hasContext ? <div className="min-w-0 space-y-3">{context}</div> : null}
      <div
        className={
          'min-w-0 space-y-3 ' + (hasContext ? 'border-t pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0' : '')
        }
      >
        {operation}
      </div>
    </article>
  );
}
