import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { CommunityRules } from '../community/community-presentation-parts';
import { m } from '../paraglide/messages.js';
import {
  type CompositionDestinationProjection,
  type CompositionRulesOutline,
  type CompositionRulesValue,
} from './composition-destination';

export function CompositionRulesReader({
  destination,
  rules,
  outline,
  isCurrent,
  onClose,
  id,
}: {
  destination: CompositionDestinationProjection;
  rules: CompositionRulesValue;
  outline: CompositionRulesOutline;
  isCurrent: (destination: CompositionDestinationProjection) => boolean;
  onClose: () => void;
  id: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useLayoutEffect(() => {
    if (isCurrent(destination)) headingRef.current?.focus();
  }, []);

  const navigateToHeading = (index: number) => {
    if (!isCurrent(destination)) return;
    const heading = documentRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6').item(index);
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.scrollIntoView?.({ block: 'start' });
    (heading as HTMLElement).focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <section
      role="region"
      id={id}
      aria-labelledby={headingId}
      onKeyDown={handleKeyDown}
      className="min-w-0 space-y-5 rounded-2xl border border-border bg-background p-4 shadow-sm sm:p-6 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:bg-card"
      data-slot="composition-rules-reader"
    >
      <header className="flex min-w-0 items-start justify-between gap-3">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 break-words text-lg leading-snug font-semibold [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.composition_rules_reader_heading()}
        </h3>
        <button
          type="button"
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={onClose}
        >
          {m.composition_rules_reader_close()}
        </button>
      </header>
      {outline.entries.length ? (
        <nav aria-label={m.composition_rules_reader_outline()} className="min-w-0 rounded-xl bg-muted/50 p-3">
          <p className="mb-2 text-sm font-medium">{m.composition_rules_reader_outline()}</p>
          <ol className="min-w-0 space-y-1">
            {outline.entries.map((entry) => (
              <li
                key={entry.index}
                className="min-w-0"
                style={{ paddingInlineStart: `${(entry.level - 1) * 0.75}rem` }}
              >
                <button
                  type="button"
                  data-outline-index={entry.index}
                  className="min-h-11 max-w-full break-words text-start text-sm text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={() => navigateToHeading(entry.index)}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ol>
          {outline.omitted ? (
            <p role="note" className="mt-2 text-xs text-muted-foreground">
              {m.composition_rules_reader_omitted({ count: outline.omitted })}
            </p>
          ) : null}
        </nav>
      ) : null}
      <div
        ref={documentRef}
        className="min-w-0 break-words text-sm [overflow-wrap:anywhere] [&_a]:break-all [&_a]:underline [&_a]:underline-offset-2 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_code]:whitespace-pre-wrap"
      >
        <CommunityRules rules={{ state: 'available', value: rules }} />
      </div>
    </section>
  );
}
