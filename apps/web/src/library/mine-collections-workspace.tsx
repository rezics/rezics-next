import { ContentItem } from '@rezics/ui/content-item';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { browseCollectionTitle } from './collection-browser';
import { PinControl } from './pin-control';
import type { AcceptedPinsOrigin } from './pins-current';
import type { LibraryPinsRead } from './pins-read';

export function MineCollectionsWorkspace({
  directory,
  savedQueries,
  pins,
  pinsOrigin,
  signedIn,
}: {
  directory: ReactNode;
  savedQueries?: ReactNode;
  pins: LibraryPinsRead;
  pinsOrigin?: AcceptedPinsOrigin | undefined;
  signedIn: boolean;
}) {
  const showPins = signedIn && pins.state === 'loaded' && pins.pins.length > 0;
  return (
    <div className="w-full min-w-0 max-w-none text-foreground" data-mine-collections-workspace>
      <div className="min-w-0 space-y-6">
        {directory}
        {savedQueries}
        <MineCollectionsPinManagement pins={pins} pinsOrigin={pinsOrigin} visible={showPins} />
      </div>
    </div>
  );
}

function MineCollectionsPinManagement({
  pins,
  pinsOrigin,
  visible,
}: {
  pins: LibraryPinsRead;
  pinsOrigin: AcceptedPinsOrigin | undefined;
  visible: boolean;
}) {
  const openerRef = useRef<HTMLElement>(null);
  const fallbackHeadingRef = useRef<HTMLHeadingElement>(null);
  const managerRef = useRef<HTMLElement>(null);
  const focusWithin = useRef(false);
  const previousVisible = useRef(visible);
  const visibleNow = useRef(visible);
  const [showFallbackHeading, setShowFallbackHeading] = useState(false);
  visibleNow.current = visible;

  useLayoutEffect(() => {
    if (previousVisible.current && !visible && focusWithin.current) {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      else setShowFallbackHeading(true);
    }
    if (visible) {
      if (document.activeElement === fallbackHeadingRef.current && openerRef.current?.isConnected)
        openerRef.current.focus();
      setShowFallbackHeading(false);
    }
    previousVisible.current = visible;
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible && showFallbackHeading) fallbackHeadingRef.current?.focus();
  }, [visible, showFallbackHeading]);

  if (!visible && !showFallbackHeading) return null;
  const availablePins = pins.state === 'loaded' ? pins.pins : [];

  return (
    <section
      ref={managerRef}
      aria-label={m.library_pin_pinned_section()}
      data-library-pin-manager
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        if (previousVisible.current && !visibleNow.current) return;
        const next = event.relatedTarget;
        if (next instanceof Node) {
          if (!managerRef.current?.contains(next)) {
            focusWithin.current = false;
            if (!visible) setShowFallbackHeading(false);
          }
        } else {
          queueMicrotask(() => {
            if (!managerRef.current?.contains(document.activeElement)) {
              focusWithin.current = false;
              if (!visible) setShowFallbackHeading(false);
            }
          });
        }
      }}
    >
      {showFallbackHeading ? (
        <h2 ref={fallbackHeadingRef} tabIndex={-1} className="text-sm font-semibold">
          {m.library_pin_pinned_section()}
        </h2>
      ) : null}
      {visible ? (
        <details className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <summary
            ref={openerRef}
            className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            {m.library_pin_pinned_section()}
          </summary>
          <section aria-label={m.library_pin_pinned_section()} className="mt-3">
            <ul className="space-y-1">
              {availablePins.map((pin) => (
                <ContentItem
                  key={pin.collectionId}
                  title={
                    pin.target
                      ? browseCollectionTitle({ ...pin.target, title: pin.target.title ?? null })
                      : m.library_pin_unavailable()
                  }
                  headingLevel={3}
                  {...(pin.target
                    ? { href: `/${getLocale()}/collections/${encodeURIComponent(pin.collectionId)}` }
                    : {})}
                  actions={<PinControl collectionId={pin.collectionId} pins={pins} mode="list" origin={pinsOrigin} />}
                />
              ))}
            </ul>
          </section>
        </details>
      ) : null}
    </section>
  );
}
