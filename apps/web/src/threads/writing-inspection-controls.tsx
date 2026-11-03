import { useId, useLayoutEffect, useState, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { m } from '../paraglide/messages.js';
import { WritingInspection, type InspectionSource, type InspectionView } from './writing-inspection';
import { inspectionActionClass, WritingInspectionOutline } from './writing-inspection-outline';
import { navigateInspection, WritingInspectionPreview, WritingInspectionSize } from './writing-inspection-preview';

/** The optional consumer of the existing editor port owns neither editing nor transport. */
export function useWritingInspection(source: InspectionSource) {
  const latest = useRef(source);
  latest.current = source;
  const [inspection, setInspection] = useState<WritingInspection | null>(null);
  useLayoutEffect(() => {
    const binding = source.binding;
    const signal = source.signal;
    const visit = new WritingInspection({
      binding,
      signal,
      current: () => latest.current.binding === binding && latest.current.signal === signal && latest.current.current(),
      revision: () => latest.current.revision(),
      snapshot: () => latest.current.snapshot(),
      title: () => latest.current.title(),
      facts: () => latest.current.facts(),
      editor: () => latest.current.editor(),
      titleEditor: () => latest.current.titleEditor?.() ?? null,
    });
    setInspection(visit);
    return () => visit.retire();
  }, [source.binding, source.signal]);
  useLayoutEffect(() => {
    inspection?.sync();
  });
  return inspection;
}

export function WritingInspectionToolbar({ inspection }: { inspection: WritingInspection }) {
  const state = useSyncExternalStore(inspection.subscribe, inspection.snapshot, inspection.snapshot);
  return (
    <Button
      type="button"
      variant="outline"
      className={inspectionActionClass}
      disabled={state.phase === 'retired'}
      aria-haspopup="dialog"
      aria-expanded={state.open}
      onPointerDown={inspection.rememberSelection}
      onClick={inspection.open}
    >
      {m.thread_inspection_open()}
    </Button>
  );
}

function unavailableText(state: InspectionView): string {
  if (state.phase === 'stale') return m.thread_inspection_stale();
  switch (state.problem) {
    case 'pending':
      return m.thread_inspection_pending();
    case 'recovery':
      return m.thread_inspection_recovery();
    case 'depth':
      return m.thread_inspection_depth();
    case 'size':
      return m.thread_inspection_too_large();
    case 'profile':
      return m.thread_inspection_profile();
    default:
      return m.thread_inspection_invalid();
  }
}

export function WritingInspectionControls({
  inspection,
  context,
}: {
  inspection: WritingInspection;
  context?: ReactNode;
}) {
  const state = useSyncExternalStore(inspection.subscribe, inspection.snapshot, inspection.snapshot);
  const prefix = useId();
  const host = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef(new Map<number, HTMLElement>());
  // Abort subscribers run synchronously, before React commits account replacement.
  // Redaction also covers stale/changed draft DOM retained by a closing dialog animation.
  useLayoutEffect(
    () =>
      inspection.subscribe(() => {
        const current = inspection.snapshot();
        if (!current.projection) {
          const node = host.current;
          if (node) {
            node.hidden = true;
            node.textContent = '';
          }
        }
      }),
    [inspection],
  );
  useLayoutEffect(() => {
    if (host.current) host.current.hidden = false;
  }, [state]);
  if (state.phase === 'retired') return null;
  return (
    <>
      <p className="mt-2 min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" role="status">
        {state.phase === 'ready' && state.projection
          ? m.thread_inspection_compact({
              points: state.projection.summary.textCodePoints,
              bytes: state.projection.summary.jsonBytes,
            })
          : state.phase === 'pending'
            ? m.thread_inspection_measuring()
            : m.thread_inspection_unmeasured()}
      </p>
      {state.focusMissing ? <p role="status">{m.thread_inspection_focus_missing()}</p> : null}
      <Dialog
        open={state.open}
        onOpenChange={(open) => {
          if (!open) inspection.close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          initialFocus={closeButton}
          finalFocus={inspection.returnFocus}
          className="min-w-0 grid-cols-[minmax(0,1fr)] text-start sm:max-w-3xl motion-reduce:animate-none motion-reduce:transition-none"
          onKeyDown={(event) => {
            // An inline editor's Escape belongs to this dialog while inspection is open.
            if (event.key === 'Escape') event.stopPropagation();
          }}
        >
          <DialogTitle>{m.thread_inspection_open()}</DialogTitle>
          <DialogDescription>{m.thread_inspection_description()}</DialogDescription>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button ref={closeButton} type="button" className={inspectionActionClass} onClick={inspection.close}>
              {m.thread_inspection_return()}
            </Button>
            {state.phase !== 'ready' ? (
              <Button type="button" variant="outline" className={inspectionActionClass} onClick={inspection.refresh}>
                {m.thread_inspection_refresh()}
              </Button>
            ) : null}
          </div>
          {state.projection ? (
            <div
              key={state.projection.summary.jsonBytes + ':' + state.projection.title}
              ref={host}
              className="min-w-0 space-y-5"
              data-private-writing-inspection
            >
              <WritingInspectionSize summary={state.projection.summary} />
              <WritingInspectionOutline
                projection={state.projection}
                inspection={inspection}
                prefix={prefix}
                navigate={(entry) => navigateInspection(entry, navigation.current)}
              />
              <WritingInspectionPreview
                projection={state.projection}
                prefix={prefix}
                context={context}
                navigation={navigation}
              />
            </div>
          ) : (
            <p role="status" className="min-w-0 rounded-lg border p-3">
              {unavailableText(state)}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
