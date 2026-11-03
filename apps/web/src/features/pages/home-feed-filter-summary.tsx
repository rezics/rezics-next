import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

/** Presentation and actions supplied by the selection owner; labels are never parsed as state. */
export type HomeFeedFilterSummary = {
  key: 'kind' | 'space' | 'question';
  label: string;
  value: string;
  lang?: string | undefined;
  description?: string | undefined;
  state?: string | undefined;
  onRemove: () => void;
};

export function HomeFeedFilterSummary({
  selections,
  locale,
  onClear,
  fallback,
}: {
  selections: readonly HomeFeedFilterSummary[];
  locale: string;
  onClear?: (() => void) | undefined;
  fallback: RefObject<HTMLButtonElement | null>;
}) {
  const options = { locale: locale as Locale };
  const container = useRef<HTMLDivElement>(null);
  const removing = useRef<number | null>(null);
  // Removing a focused chip keeps keyboard focus in this summary, or on its surface control.
  useLayoutEffect(() => {
    if (removing.current === null) return;
    const buttons = container.current?.querySelectorAll<HTMLButtonElement>('[data-home-filter-remove]');
    const next = buttons?.[Math.min(removing.current, (buttons?.length ?? 0) - 1)];
    removing.current = null;
    (next ?? fallback.current)?.focus();
  }, [selections, fallback]);
  return (
    <div ref={container} className="min-w-0 space-y-2" data-home-filter-summary>
      {selections.length ? (
        <>
          <ul aria-label={m.refinement_selected({}, options)} className="flex min-w-0 flex-wrap gap-2">
            {selections.map((selection, index) => (
              <li key={selection.key} className="max-w-full min-w-0 rounded-xl border border-border bg-muted/40">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-11 max-w-full items-start gap-2 rounded-xl px-3 py-2 text-start whitespace-normal"
                  aria-label={m.refinement_remove({ value: selection.value }, options)}
                  data-home-filter-remove={selection.key}
                  onClick={() => {
                    if (
                      container.current?.ownerDocument.activeElement ===
                      container.current?.querySelectorAll('[data-home-filter-remove]')[index]
                    )
                      removing.current = index;
                    selection.onRemove();
                  }}
                >
                  <span className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
                    <span className="block">
                      <span className="text-muted-foreground">{selection.label}: </span>
                      <bdi lang={selection.lang}>{selection.value}</bdi>
                    </span>
                    {selection.description ? (
                      <span className="block text-xs font-normal text-muted-foreground">{selection.description}</span>
                    ) : null}
                    {selection.state ? (
                      <span className="block text-xs font-normal text-muted-foreground">{selection.state}</span>
                    ) : null}
                  </span>
                  <span aria-hidden="true" className="shrink-0">
                    ×
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          {onClear ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 whitespace-normal"
              onClick={() => {
                removing.current = 0;
                onClear();
              }}
            >
              {m.refinement_clear({}, options)}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
