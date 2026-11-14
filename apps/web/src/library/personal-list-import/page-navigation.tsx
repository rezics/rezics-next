import { useEffect, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

export type ImportPagePosition = {
  previous: number | null;
  canFirst: boolean;
  atRetainedEdge: boolean;
};

/** Coordinates only. The provider's page owner keeps the current body and review authority. */
export class ImportPageCoordinates {
  private current: number | null = null;
  private predecessors: number[] = [];

  constructor(readonly first: number) {}

  observe(coordinate: number): void {
    if (coordinate === this.current) return;
    const previousIndex = this.predecessors.lastIndexOf(coordinate);
    if (coordinate === this.first) {
      this.predecessors = [];
    } else if (previousIndex >= 0) {
      this.predecessors = this.predecessors.slice(0, previousIndex);
    } else if (this.current !== null) {
      this.predecessors = [...this.predecessors, this.current].slice(-8);
    }
    this.current = coordinate;
  }

  retire(): void {
    this.current = null;
    this.predecessors = [];
  }

  position(): ImportPagePosition {
    const previous = this.predecessors.at(-1) ?? null;
    const canFirst = this.current !== null && this.current !== this.first;
    return { previous, canFirst, atRetainedEdge: canFirst && previous === null };
  }
}

/** Move keyboard orientation only after an acknowledged coordinate change. */
export function useImportPageFocus(coordinate: number) {
  const status = useRef<HTMLParagraphElement>(null);
  const previous = useRef(coordinate);
  useEffect(() => {
    if (previous.current !== coordinate) status.current?.focus();
    previous.current = coordinate;
  }, [coordinate]);
  return status;
}

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export function ImportPageNavigation({
  position,
  hasNext,
  nextLabel,
  busy,
  onFirst,
  onPrevious,
  onNext,
}: {
  position: ImportPagePosition;
  hasNext: boolean;
  nextLabel: string;
  busy: boolean;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="space-y-2" aria-label={m.library_import_page_navigation()} aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{m.library_import_page_navigation_help()}</p>
      {position.atRetainedEdge ? <p role="status">{m.library_import_page_history_edge()}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" className={actionClass} disabled={busy || !position.canFirst} onClick={onFirst}>
          {m.library_import_first_page()}
        </Button>
        <Button type="button" variant="outline" className={actionClass} disabled={busy || position.previous === null} onClick={onPrevious}>
          {m.library_import_previous_page()}
        </Button>
        {hasNext ? (
          <Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={onNext}>
            {nextLabel}
          </Button>
        ) : null}
      </div>
    </nav>
  );
}

export function ImportPageReadRecovery({ busy, onRetry }: { busy: boolean; onRetry: () => void }) {
  return (
    <div className="space-y-2 rounded-md border p-3" role="group" aria-label={m.library_import_page_retry()}>
      <p role="status">{m.library_import_page_read_failed()}</p>
      <Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={onRetry}>
        {m.library_import_page_retry()}
      </Button>
    </div>
  );
}
