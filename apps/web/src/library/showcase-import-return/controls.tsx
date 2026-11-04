import { m } from '../../paraglide/messages.js';
import { VndbAction } from '../personal-list-import/controls';
import type { ShelfLayout, ShelfSize } from '../shelf-params';
import type { ImportLibrarySnapshot } from './browser';

export type ImportLibraryActions = {
  onRead: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onRetry?: () => void;
  onRestart?: () => void;
  onRefresh?: () => void;
};

/** Read navigation is deliberately separate from import review, retry and apply controls. */
export function ImportLibraryPageControls({
  snapshot,
  available,
  actions,
}: {
  snapshot: ImportLibrarySnapshot;
  available: boolean;
  actions: ImportLibraryActions;
}) {
  const busy = !!snapshot.pending;
  const disabled = !available || busy;
  const { visible, failed } = snapshot;
  return (
    <nav aria-label={m.library_vndb_browse_navigation()} className="flex flex-wrap gap-3">
      {!visible && !failed ? (
        <VndbAction type="button" variant="outline" disabled={disabled} aria-busy={busy} onClick={actions.onRead}>
          {busy ? m.library_vndb_library_loading() : m.library_vndb_library_refresh()}
        </VndbAction>
      ) : null}
      {failed ? (
        <VndbAction type="button" disabled={disabled} onClick={actions.onRetry ?? actions.onRead}>
          {m.library_vndb_browse_retry()}
        </VndbAction>
      ) : null}
      {visible ? (
        <>
          {snapshot.previous !== undefined ? (
            <VndbAction type="button" variant="outline" disabled={disabled || !!failed} onClick={actions.onPrevious}>
              {m.library_vndb_browse_previous()}
            </VndbAction>
          ) : null}
          {visible.page.next !== null ? (
            <VndbAction type="button" disabled={disabled || !!failed} onClick={actions.onNext}>
              {m.library_vndb_browse_next()}
            </VndbAction>
          ) : null}
          <VndbAction type="button" variant="outline" disabled={disabled} onClick={actions.onRefresh ?? actions.onRead}>
            {m.library_vndb_browse_refresh()}
          </VndbAction>
        </>
      ) : null}
      {visible || failed ? (
        <VndbAction type="button" variant="outline" disabled={disabled} onClick={actions.onRestart ?? actions.onRead}>
          {m.library_vndb_browse_restart()}
        </VndbAction>
      ) : null}
    </nav>
  );
}

/** Local presentation uses the shelf's supported vocabulary and travels with Open Library. It issues no reads. */
export function ImportLibraryDisplayControls({
  layout,
  size,
  available,
  onLayout,
  onSize,
}: {
  layout: ShelfLayout;
  size: ShelfSize;
  available: boolean;
  onLayout?: (layout: ShelfLayout) => void;
  onSize?: (size: ShelfSize) => void;
}) {
  if (!onLayout) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-4">
      <fieldset className="min-w-0 space-y-2" disabled={!available}>
        <legend className="text-sm font-medium">{m.library_layout()}</legend>
        <div className="flex flex-wrap gap-2">
          {(['list', 'grid', 'table'] as const).map((choice) => (
            <VndbAction
              key={choice}
              type="button"
              variant={layout === choice ? 'default' : 'outline'}
              aria-pressed={layout === choice}
              onClick={() => onLayout(choice)}
            >
              {choice === 'list'
                ? m.library_layout_list()
                : choice === 'grid'
                  ? m.library_layout_grid()
                  : m.library_layout_table()}
            </VndbAction>
          ))}
        </div>
      </fieldset>
      {layout === 'grid' && onSize ? (
        <fieldset className="min-w-0 space-y-2" disabled={!available}>
          <legend className="text-sm font-medium">{m.library_size()}</legend>
          <div className="flex flex-wrap gap-2">
            {(['s', 'm', 'l'] as const).map((choice) => (
              <VndbAction
                key={choice}
                type="button"
                variant={size === choice ? 'default' : 'outline'}
                aria-pressed={size === choice}
                onClick={() => onSize(choice)}
              >
                {choice === 's'
                  ? m.library_size_small()
                  : choice === 'm'
                    ? m.library_size_medium()
                    : m.library_size_large()}
              </VndbAction>
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
