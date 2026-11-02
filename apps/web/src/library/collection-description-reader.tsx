import { Button } from '@rezics/ui/shadcn/button';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';

/** Presentation of an already disclosed description; never reads or edits the Collection. */
export function CollectionDescriptionReader({
  description,
  className = '',
}: {
  description: string | null | undefined;
  className?: string;
}) {
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Match the note reader: full access remains available before layout, including SSR.
  const [truncated, setTruncated] = useState(true);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return;
    const measure = () => setTruncated(text.scrollHeight > text.clientHeight);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(text);
    return () => observer?.disconnect();
  }, [description, expanded]);

  if (!description) return null;
  return (
    <div data-collection-description-reader className={`min-w-0 max-w-4xl ${className}`}>
      {(truncated || expanded) && (
        <Button
          type="button"
          variant="link"
          aria-expanded={expanded}
          aria-controls={textId}
          className="h-auto min-h-11 max-w-full justify-start whitespace-normal rounded-sm px-0 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? m.library_collection_description_reader_collapse()
            : m.library_collection_description_reader_expand()}
        </Button>
      )}
      <p
        ref={textRef}
        id={textId}
        className={`min-w-0 max-w-full whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere] ${expanded ? '' : 'line-clamp-4'}`}
      >
        {description}
      </p>
    </div>
  );
}
