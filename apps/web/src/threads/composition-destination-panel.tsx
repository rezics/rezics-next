import { useId, useLayoutEffect, useRef, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import {
  sameCompositionRulesIdentity,
  type CompositionDestinationProjection,
  type CompositionRulesIdentity,
} from './composition-destination';
import { CompositionRulesReader } from './composition-rules-reader';
import { CompositionRulesVersionNotice } from './composition-rules-version';

export function CompositionDestinationPanel({
  destination,
  isCurrent,
}: {
  destination: CompositionDestinationProjection;
  isCurrent: (destination: CompositionDestinationProjection) => boolean;
}) {
  const headingId = useId();
  const readerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [inspected, setInspected] = useState<CompositionRulesIdentity | null>(null);
  const community = destination.community;
  const rules = community.state === 'available' ? community.rules : undefined;
  const available = rules?.state === 'available' ? rules.value : undefined;
  const currentIdentity = available ? destination.rulesIdentity : undefined;
  const readerVisible = Boolean(open && available && sameCompositionRulesIdentity(inspected, currentIdentity ?? null));

  useLayoutEffect(() => {
    if (wasOpen.current && !readerVisible && isCurrent(destination)) triggerRef.current?.focus();
    wasOpen.current = readerVisible;
  }, [destination, isCurrent, readerVisible]);

  const inspectCurrent = () => {
    if (!available || !currentIdentity || !isCurrent(destination)) return;
    setInspected(currentIdentity);
    setOpen(true);
  };
  const closeReader = () => {
    if (!isCurrent(destination)) return;
    setOpen(false);
  };

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-4 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-5"
      data-slot="composition-destination"
    >
      <h2 id={headingId} className="break-words text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
        {m.composition_destination_heading()}
      </h2>
      <dl className="min-w-0 space-y-3 text-sm">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted-foreground">{m.composition_destination_board_label()}</dt>
          <dd className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
            <a
              href={`/${getLocale()}/boards/${destination.boardId}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {destination.boardTitle ?? m.threads_untitled()}
            </a>
          </dd>
        </div>
        {community.state === 'available' ? (
          <div className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">{m.composition_destination_community_label()}</dt>
            <dd className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
              <a
                href={`/${getLocale()}/realms/${community.realmId}`}
                className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {community.name}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      {community.state === 'global' ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{m.board_community_global()}</p>
      ) : community.state === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.board_community_source_unavailable()}
        </p>
      ) : rules?.state === 'none' ? (
        <p className="text-sm text-muted-foreground">{m.board_community_rules_none()}</p>
      ) : rules?.state === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.board_community_rules_unavailable()}
        </p>
      ) : null}

      {available && currentIdentity ? (
        <>
          <CompositionRulesVersionNotice
            previous={inspected}
            current={currentIdentity}
            triggerRef={triggerRef}
            onInspect={inspectCurrent}
          />
          {!readerVisible &&
          !(
            inspected &&
            currentIdentity.destinationKey === inspected.destinationKey &&
            !sameCompositionRulesIdentity(inspected, currentIdentity)
          ) ? (
            <button
              ref={triggerRef}
              type="button"
              aria-expanded={readerVisible}
              aria-controls={readerId}
              className="inline-flex min-h-11 max-w-full items-center justify-center rounded-md border border-border px-3 text-left text-sm font-medium text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={inspectCurrent}
            >
              {m.composition_destination_inspect_rules()}
            </button>
          ) : null}
          {readerVisible ? (
            <CompositionRulesReader
              id={readerId}
              destination={destination}
              rules={available}
              outline={destination.outline ?? { entries: [], omitted: 0, total: 0 }}
              isCurrent={isCurrent}
              onClose={closeReader}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
