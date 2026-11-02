import { ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';

/** Local full-text disclosure, following CollectionNoteReader; the page owns viewer retirement. */
export function LabelNameReader({ name, locale }: { name: string; locale: string }) {
  const textId = useId();
  const textRef = useRef<HTMLSpanElement>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return;
    const measure = () => {
      // A resize must not remove the control that currently holds keyboard focus.
      const focused = text.ownerDocument.activeElement === controlRef.current;
      setTruncated(text.scrollHeight > text.clientHeight || text.scrollWidth > text.clientWidth || focused);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(text);
    return () => observer?.disconnect();
  }, [name, expanded]);

  return (
    <div lang={locale} className="min-w-0 flex-1">
      <ContentItemHeading
        level={2}
        title={name}
        className="min-w-0 text-[17px] leading-snug font-semibold sm:text-lg md:text-xl"
      >
        <span
          ref={textRef}
          id={textId}
          className={`min-w-0 whitespace-break-spaces [overflow-wrap:anywhere] ${expanded ? 'block' : 'line-clamp-2 sm:line-clamp-1'}`}
        >
          {name}
        </span>
      </ContentItemHeading>
      {(truncated || expanded) && (
        <ListRowControl>
          <Button
            ref={controlRef}
            type="button"
            variant="link"
            aria-expanded={expanded}
            aria-controls={textId}
            className="h-auto min-h-11 max-w-full justify-start whitespace-normal px-0 py-2 text-left [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => setExpanded((value) => !value)}
            onBlur={() => {
              const text = textRef.current;
              if (text && !expanded)
                setTruncated(text.scrollHeight > text.clientHeight || text.scrollWidth > text.clientWidth);
            }}
          >
            {expanded ? m.library_label_name_reader_collapse() : m.library_label_name_reader_expand()}
          </Button>
        </ListRowControl>
      )}
    </div>
  );
}
