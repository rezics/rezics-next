import { ListRowControl } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';

/** Reads only the supplied occurrence note; the caller owns disclosure and occurrence identity. */
export function CollectionNoteReader({
  note,
  occurrence,
  className = '',
  previewLines = 2,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  note: string | null | undefined;
  occurrence: string;
  className?: string;
  previewLines?: 2 | 4;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const changeExpanded = (next: boolean) => {
    onExpandedChange?.(next);
    if (controlledExpanded === undefined) setLocalExpanded(next);
  };
  // Keep full access available before layout, including server-rendered previews.
  const [truncated, setTruncated] = useState(true);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return;
    const measure = () => {
      // Keep the focused disclosure available until deliberate blur.
      const focused = text.ownerDocument.activeElement === controlRef.current;
      setTruncated(text.scrollHeight > text.clientHeight || focused);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(text);
    return () => observer?.disconnect();
  }, [note, expanded, previewLines]);

  if (note === null || note === undefined || note === '') return null;
  const action = expanded ? m.library_collection_note_reader_collapse() : m.library_collection_note_reader_expand();

  return (
    <ListRowControl
      data-content-item-slot="preview"
      data-collection-note-reader
      className={`min-w-0 max-w-full text-left ${className}`}
    >
      {(truncated || expanded) && (
        <Button
          ref={controlRef}
          type="button"
          variant="link"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={`${action}: ${occurrence}`}
          className="h-auto min-h-11 max-w-full justify-start whitespace-normal rounded-sm px-0 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => changeExpanded(!expanded)}
          onBlur={() => {
            const text = textRef.current;
            if (text && !expanded) setTruncated(text.scrollHeight > text.clientHeight);
          }}
        >
          {action}
        </Button>
      )}
      <p
        ref={textRef}
        id={textId}
        data-slot="collection-member-note"
        className={`min-w-0 max-w-full whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere] ${expanded ? '' : previewLines === 4 ? 'line-clamp-4' : 'line-clamp-2'}`}
      >
        {note}
      </p>
    </ListRowControl>
  );
}
