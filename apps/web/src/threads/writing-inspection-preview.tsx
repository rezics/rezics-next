import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { InspectionOutlineEntry, InspectionProjection, InspectionSummary } from './writing-inspection';
import { writingInspectionLimits } from './writing-inspection';

export function WritingInspectionSize({ summary }: { summary: InspectionSummary }) {
  return (
    <section aria-label={m.thread_inspection_size()} className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3">
      <h3 className="font-medium">{m.thread_inspection_size()}</h3>
      <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt>{m.thread_inspection_text_unit()}</dt>
          <dd>{summary.textCodePoints}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_json_unit()}</dt>
          <dd>{summary.jsonBytes}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_canonical_unit()}</dt>
          <dd>{summary.canonicalBytes}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_snapshot_unit()}</dt>
          <dd>{writingInspectionLimits.bytes - summary.jsonBytes}</dd>
        </div>
        {summary.titleCodeUnits !== null ? (
          <div>
            <dt>{m.thread_inspection_title_unit()}</dt>
            <dd>{summary.titleCodeUnits}</dd>
          </div>
        ) : null}
        {summary.titleRemaining !== null ? (
          <div>
            <dt>{m.thread_inspection_title_remaining()}</dt>
            <dd>{summary.titleRemaining}</dd>
          </div>
        ) : null}
        <div>
          <dt>{m.thread_inspection_images_unit()}</dt>
          <dd>{summary.images}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_images_remaining()}</dt>
          <dd>{summary.imageRemaining}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_media_unit()}</dt>
          <dd>{summary.media}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_mentions_unit()}</dt>
          <dd>{summary.mentions}</dd>
        </div>
        <div>
          <dt>{m.thread_inspection_links_unit()}</dt>
          <dd>{summary.links}</dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{m.thread_inspection_units()}</p>
      <p className="text-sm text-muted-foreground">{m.thread_inspection_request_unknown()}</p>
    </section>
  );
}

/** Reader-only rendering: no account resolver, metadata fetch or media capability. */
export const WritingInspectionPreview = memo(function WritingInspectionPreview({
  projection,
  prefix,
  context,
  navigation,
}: {
  projection: InspectionProjection;
  prefix: string;
  context?: ReactNode;
  navigation: { current: Map<number, HTMLElement> };
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const nodes = new Map<string, HTMLElement>();
    for (const node of host.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []) {
      const id = node.getAttribute('data-block-id');
      if (id) nodes.set(id, node);
    }
    navigation.current.clear();
    for (const entry of projection.outline) {
      const node = entry.id ? nodes.get(entry.id) : undefined;
      if (!node) continue;
      node.id = `${prefix}-block-${entry.ordinal}`;
      node.tabIndex = -1;
      navigation.current.set(entry.ordinal, node);
    }
    return () => {
      navigation.current.clear();
    };
  }, [projection, prefix, navigation]);
  return (
    <section aria-label={m.thread_inspection_reader()} className="min-w-0 space-y-3">
      <h3 className="font-medium">{m.thread_inspection_reader()}</h3>
      {context ? (
        <aside className="min-w-0 rounded-lg border p-3" aria-label={m.thread_inspection_context()}>
          <p className="mb-1 text-sm font-medium">{m.thread_inspection_context()}</p>
          {context}
        </aside>
      ) : null}
      {projection.title !== null ? (
        <div className="min-w-0 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">{m.thread_inspection_draft_title()}</p>
          <p className="font-heading text-xl">{projection.title || m.thread_inspection_title_empty()}</p>
        </div>
      ) : null}
      <div ref={host} className="max-h-[65dvh] min-w-0 overflow-auto rounded-xl border bg-background p-3 sm:p-5">
        <DocumentBody
          document={projection.body}
          locale={getLocale()}
          className="mx-0! w-full [overflow-wrap:anywhere]"
          labels={{ imageUnavailable: m.thread_inspection_image_unavailable() }}
        />
      </div>
      <p className="text-sm text-muted-foreground">{m.thread_inspection_draft_notice()}</p>
    </section>
  );
});

export function navigateInspection(entry: InspectionOutlineEntry, navigation: Map<number, HTMLElement>): boolean {
  const node = navigation.get(entry.ordinal);
  if (!node?.isConnected) return false;
  node.focus({ preventScroll: true });
  node.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  return true;
}
