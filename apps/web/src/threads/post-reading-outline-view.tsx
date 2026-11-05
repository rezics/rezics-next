import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { useIsMobile } from '@rezics/ui/hooks/use-mobile';
import { Button } from '@rezics/ui/shadcn/button';
import { Dialog, DialogContent, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { ReadingOutline } from './post-reading-outline';
import type { PostReadingPosition } from './post-reading-position';

// Per document, one active visit. The registration holds no document text and is removed on retirement.
const activeOutlines = new WeakMap<Document, () => void>();
const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';

export function PostReadingOutlineView({
  outline,
  position,
  locale,
}: {
  outline: ReadingOutline;
  position: PostReadingPosition;
  locale: string;
}) {
  const [enhanced, setEnhanced] = useState(false);
  const [open, setOpen] = useState(false);
  const [returning, setReturning] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const activeDocument = useRef<Document | null>(null);
  const transferFocus = useRef(false);
  const mobile = useIsMobile();
  const id = `post-sections-${useId().replaceAll(':', '')}`;
  const options = { locale: locale as never };
  const title = m.post_sections_title({}, options);
  const closeLabel = m.post_sections_close({}, options);

  const closeOther = useCallback(() => {
    transferFocus.current = true;
    position.cancel();
    setOpen(false);
  }, [position]);

  useEffect(() => {
    setEnhanced(true);
    return () => {
      const document = activeDocument.current;
      if (document && activeOutlines.get(document) === closeOther) activeOutlines.delete(document);
      position.cancel();
    };
  }, [position, closeOther]);

  function changeOpen(next: boolean) {
    if (!position.isCurrent()) return;
    if (next) {
      if (!position.open()) return;
      const document = launcher.current?.ownerDocument;
      if (document) {
        const previous = activeOutlines.get(document);
        if (previous && previous !== closeOther) previous();
        activeDocument.current = document;
        activeOutlines.set(document, closeOther);
      }
      transferFocus.current = false;
      setUnavailable(false);
    } else if (!transferFocus.current) position.cancel();
    setOpen(next);
  }
  function complete(next: boolean) {
    if (next || !position.isCurrent()) return;
    const result = position.complete();
    if (!position.isCurrent()) return;
    if (result) {
      setUnavailable(result === 'unavailable');
      setReturning(position.canReturn);
    }
    // Keep automatic focus restoration suppressed for this closed visit, including late cleanup.
    const document = launcher.current?.ownerDocument;
    if (document && activeOutlines.get(document) === closeOther) activeOutlines.delete(document);
  }
  function choose(target: number) {
    if (!position.choose(target)) return;
    transferFocus.current = true;
    setOpen(false);
  }
  // Base UI owns Escape, outside dismissal, focus trapping and sheet gestures. Local jumps never use Back.
  const finalFocus = () => (position.isCurrent() && !transferFocus.current ? (launcher.current ?? false) : false);
  const content = (
    <nav aria-label={title} id={id} className="min-w-0 space-y-3" lang={locale}>
      <p className="text-sm text-muted-foreground">
        {m.post_sections_count({ count: outline.entries.length }, options)}
      </p>
      <ol className="m-0 list-none space-y-1 p-0">
        {outline.entries.map((entry) => (
          <li key={entry.position} data-heading-level={entry.level} style={{ paddingInlineStart: `${entry.depth}rem` }}>
            <Button
              variant="ghost"
              className={`${control} w-full justify-start py-2`}
              aria-label={m.post_sections_entry({ level: entry.level, label: entry.label }, options)}
              onClick={() => choose(entry.position)}
            >
              <bdi dir="auto" className="min-w-0 whitespace-normal">
                {entry.label}
              </bdi>
            </Button>
          </li>
        ))}
      </ol>
      {outline.overflow ? (
        <p className="text-sm text-muted-foreground">
          {m.post_sections_overflow({ count: outline.overflow }, options)}
        </p>
      ) : null}
    </nav>
  );

  if (!enhanced || !outline.entries.length) return null;
  return (
    <>
      <Button
        ref={launcher}
        type="button"
        variant="outline"
        className={control}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => changeOpen(true)}
      >
        {title}
      </Button>
      {returning ? (
        <Button
          type="button"
          variant="ghost"
          className={control}
          onClick={() => {
            if (!position.requestReturn()) return;
            const result = position.complete();
            if (!position.isCurrent()) return;
            setReturning(position.canReturn);
            setUnavailable(result === 'unavailable');
          }}
        >
          {m.post_sections_return({}, options)}
        </Button>
      ) : null}
      {unavailable ? (
        <p role="status" className="max-w-prose basis-full p-2 text-sm">
          {m.post_sections_unavailable({}, options)}
        </p>
      ) : null}
      {mobile ? (
        <BottomSheet
          open={open}
          onOpenChange={changeOpen}
          onOpenChangeComplete={complete}
          finalFocus={finalFocus}
          title={title}
          closeLabel={closeLabel}
        >
          {content}
        </BottomSheet>
      ) : (
        <Dialog open={open} onOpenChange={changeOpen} onOpenChangeComplete={complete}>
          <DialogContent showCloseButton={false} finalFocus={finalFocus} className="gap-3 motion-reduce:animate-none">
            <div className="flex min-w-0 items-start gap-2">
              <DialogTitle className="min-w-0 flex-1 break-words">{title}</DialogTitle>
              <Button variant="ghost" className={control} onClick={() => changeOpen(false)}>
                {closeLabel}
              </Button>
            </div>
            {content}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
