import { useRef, useState, type MouseEvent, type Ref } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { vndbActionClass } from '../personal-list-import/controls';
import type { ShelfLayout, ShelfSize } from '../shelf-params';
import type { ImportLibraryRead } from './read';
import type { ImportLibrarySnapshot } from './browser';
import { importLibraryRows } from './presentation';
import { importLibraryAnchor, importLibraryShelfHref } from './navigation';
import { ImportLibraryPageControls, ImportLibraryDisplayControls, type ImportLibraryActions } from './controls';
import { ImportLibraryReadState, ImportLibraryEmptyState } from './states';
import { ImportLibraryRows } from './rows';
import { ImportLibraryInspection } from './inspection';
import type { CurrentImportLibraryRead } from './browser';

/** Native Library facts and import acknowledgements have separate headings, reads and controls. */
export function ImportLibraryView({
  result,
  busy,
  available = true,
  snapshot: suppliedSnapshot,
  returned = false,
  layout = 'list',
  size = 'm',
  headingRef,
  onLayout,
  onSize,
  onDepart,
  ...actions
}: ImportLibraryActions & {
  result: ImportLibraryRead | null;
  busy: boolean;
  available?: boolean;
  snapshot?: ImportLibrarySnapshot;
  returned?: boolean;
  layout?: ShelfLayout;
  size?: ShelfSize;
  headingRef?: Ref<HTMLHeadingElement>;
  onLayout?: (layout: ShelfLayout) => void;
  onSize?: (size: ShelfSize) => void;
  onDepart?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const locale = getLocale();
  const [inspection, setInspection] = useState<{
    generation: number;
    position: number;
    launcher: HTMLButtonElement;
  } | null>(null);
  const pageHeading = useRef<HTMLParagraphElement>(null);
  const pageIdentity = useRef<{ source: CurrentImportLibraryRead | null; generation: number }>({
    source: null,
    generation: 0,
  });
  const snapshot: ImportLibrarySnapshot = suppliedSnapshot ?? {
    visible: result?.state === 'current' ? result : null,
    cursor: null,
    pending: busy ? { cursor: null, kind: 'first' } : null,
    failed: result && result.state !== 'current' ? { intent: { cursor: null, kind: 'first' }, result } : null,
    revision: 0,
    retired: false,
  };
  const visible = available && !snapshot.retired ? snapshot.visible : null;
  const rows = visible ? importLibraryRows(visible.page, locale, visible.labels) : [];
  const href = importLibraryShelfHref(locale, layout, size);
  if (pageIdentity.current.source !== visible) {
    pageIdentity.current = { source: visible, generation: pageIdentity.current.generation + 1 };
  }
  const inspected =
    inspection && inspection.generation === pageIdentity.current.generation
      ? (rows[inspection.position] ?? null)
      : null;

  return (
    <section
      id={importLibraryAnchor}
      className="min-w-0 space-y-4 rounded-lg border p-4 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
      data-vndb-library-return
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('a');
        if (!anchor?.getAttribute('href')?.startsWith('/')) return;
        onDepart?.(event as unknown as MouseEvent<HTMLAnchorElement>);
      }}
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {m.library_vndb_library_title()}
      </h2>
      <p
        ref={pageHeading}
        tabIndex={-1}
        className="text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.library_vndb_library_help()}
      </p>
      <ImportLibraryReadState snapshot={snapshot} available={available} returned={returned} />
      <ImportLibraryPageControls snapshot={snapshot} available={available} actions={actions} />
      <div className="flex flex-wrap items-start gap-3">
        <Link to={href as never} className={vndbActionClass + ' inline-flex items-center rounded-md border'}>
          {m.library_vndb_library_open()}
        </Link>
      </div>
      {visible ? (
        <>
          <p className="text-sm text-muted-foreground">{m.library_vndb_browse_order()}</p>
          <ImportLibraryDisplayControls
            layout={layout}
            size={size}
            available={available}
            {...(onLayout ? { onLayout } : {})}
            {...(onSize ? { onSize } : {})}
          />
          <div aria-busy={!!snapshot.pending} data-vndb-browse-page={snapshot.revision}>
            <ImportLibraryEmptyState snapshot={snapshot} />
            <ImportLibraryRows
              rows={rows}
              locale={locale}
              layout={layout}
              size={size}
              onInspect={(position, launcher) => {
                if (available && !snapshot.pending)
                  setInspection({ generation: pageIdentity.current.generation, position, launcher });
              }}
            />
          </div>
          {!snapshot.pending && !snapshot.failed && rows.length > 0 && visible.page.next === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.library_vndb_browse_end()}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{m.library_vndb_browse_facts_help()}</p>
        </>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.library_vndb_browse_return_help()}</p>
      <ImportLibraryInspection
        row={inspected}
        locale={locale}
        layout={layout}
        size={size}
        onClose={() => setInspection(null)}
        finalFocus={() =>
          available && inspection?.generation === pageIdentity.current.generation
            ? inspection.launcher.isConnected
              ? inspection.launcher
              : (pageHeading.current ?? false)
            : false
        }
      />
    </section>
  );
}
