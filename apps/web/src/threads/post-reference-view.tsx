import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { Button } from '@rezics/ui/shadcn/button';
import { Dialog, DialogContent, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { useIsMobile } from '@rezics/ui/hooks/use-mobile';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { copyPostReferenceDestination } from './post-reference-copy';
import type { PostReferenceEntry, PostReferenceList } from './post-reference-list';
import type { PostReadingPosition } from './post-reading-position';

type CopyState = 'idle' | 'pending' | 'success' | 'denied' | 'unavailable';

// One References visit at a time in each document, even when several published posts are mounted.
const activeReferences = new WeakMap<Document, () => void>();
const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';

export function PostReferenceView({
  references,
  position,
  locale,
}: {
  references: PostReferenceList;
  position: PostReadingPosition;
  locale: string;
}) {
  const [enhanced, setEnhanced] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PostReferenceEntry | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [returning, setReturning] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const address = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef<PostReferenceEntry | null>(null);
  const copyAttempt = useRef(0);
  const activeDocument = useRef<Document | null>(null);
  const transferFocus = useRef(false);
  const mobile = useIsMobile();
  const id = `post-references-${useId().replaceAll(':', '')}`;
  const addressId = `${id}-destination`;
  const options = { locale: locale as never };
  const title = m.post_references_title({}, options);
  const closeLabel = m.post_references_close({}, options);

  const closeOther = useCallback(() => {
    transferFocus.current = true;
    position.cancel();
    copyAttempt.current++;
    setCopyState('idle');
    setOpen(false);
  }, [position]);

  useEffect(() => {
    setEnhanced(true);
    return () => {
      copyAttempt.current++;
      const document = activeDocument.current;
      if (document && activeReferences.get(document) === closeOther) activeReferences.delete(document);
      position.cancel();
    };
  }, [position, closeOther]);

  function retireCopy() {
    copyAttempt.current++;
    setCopyState('idle');
  }

  function changeOpen(next: boolean) {
    if (!position.isCurrent()) return;
    if (next) {
      if (!position.open()) return;
      const document = launcher.current?.ownerDocument;
      if (document) {
        const previous = activeReferences.get(document);
        if (previous && previous !== closeOther) previous();
        activeDocument.current = document;
        activeReferences.set(document, closeOther);
      }
      transferFocus.current = false;
      setUnavailable(false);
      retireCopy();
    } else {
      if (!transferFocus.current) position.cancel();
      retireCopy();
      const document = activeDocument.current;
      if (document && activeReferences.get(document) === closeOther) activeReferences.delete(document);
      activeDocument.current = null;
    }
    setOpen(next);
  }

  function complete(next: boolean) {
    if (next || !position.isCurrent()) return;
    const result = position.complete();
    if (!position.isCurrent()) return;
    setReturning(position.canReturn);
    setUnavailable(result === 'unavailable');
    transferFocus.current = false;
  }

  function choose(entry: PostReferenceEntry) {
    retireCopy();
    selectedRef.current = entry;
    setSelected(entry);
  }

  function backToList() {
    retireCopy();
    selectedRef.current = null;
    setSelected(null);
  }

  function returnToSource() {
    if (!selected || !position.chooseReference(selected.position)) return;
    retireCopy();
    selectedRef.current = null;
    setSelected(null);
    const document = activeDocument.current;
    if (document && activeReferences.get(document) === closeOther) activeReferences.delete(document);
    activeDocument.current = null;
    transferFocus.current = true;
    setOpen(false);
  }

  async function copyDestination() {
    const destination = selected;
    if (!destination || !position.isCurrent()) return;
    const attempt = ++copyAttempt.current;
    setCopyState('pending');
    const isLive = () =>
      copyAttempt.current === attempt && selectedRef.current === destination && position.isCurrent();
    let clipboard: Clipboard | undefined;
    try {
      clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    } catch {
      if (isLive()) setCopyState('unavailable');
      return;
    }
    const result = await copyPostReferenceDestination(destination.href, clipboard);
    if (isLive()) setCopyState(result);
  }

  function selectAddress() {
    const input = address.current;
    if (!input) return;
    input.focus();
    input.select();
  }

  function returnToPreviousPosition() {
    if (!position.requestReturn()) return;
    const result = position.complete();
    if (!position.isCurrent()) return;
    setReturning(position.canReturn);
    setUnavailable(result === 'unavailable');
  }

  const finalFocus = () => (launcher.current?.isConnected ? launcher.current : position.fallbackFocus());
  const list = (
    <div id={id} className="max-h-[min(70vh,32rem)] min-w-0 space-y-3 overflow-y-auto" lang={locale}>
      {selected ? (
        <section aria-labelledby={`${id}-selected`} className="min-w-0 space-y-3">
          <h3 id={`${id}-selected`} className="break-words text-base font-semibold">
            <bdi dir="auto">{selected.label || m.post_references_unlabeled({}, options)}</bdi>
          </h3>
          <p className="min-w-0 break-words text-sm text-muted-foreground">
            <span>{m.post_references_location({}, options)}: </span>
            {selected.destination === 'email' ? (
              <span>{m.post_references_email_destination({}, options)}</span>
            ) : (
              <bdi dir="ltr" className="[unicode-bidi:plaintext]">
                {selected.location}
              </bdi>
            )}
          </p>
          <label htmlFor={addressId} className="block text-sm font-medium">
            {m.post_references_destination({}, options)}
          </label>
          <textarea
            ref={address}
            id={addressId}
            aria-label={m.post_references_destination({}, options)}
            readOnly
            rows={4}
            wrap="soft"
            dir="ltr"
            className="block min-h-24 w-full min-w-0 max-w-full resize-y rounded-md border bg-background p-3 font-mono text-sm [overflow-wrap:anywhere] [unicode-bidi:plaintext] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={selected.href}
          />
          <div className="flex max-w-full flex-wrap gap-2">
            <a
              href={selected.href}
              rel="noopener noreferrer nofollow ugc"
              className={`${control} inline-flex items-center justify-center rounded-md border px-3 py-2 underline underline-offset-4`}
            >
              {m.post_references_follow({}, options)}
            </a>
            <Button type="button" variant="outline" className={control} onClick={() => void copyDestination()} disabled={copyState === 'pending'}>
              {copyState === 'pending'
                ? m.post_references_copy_pending({}, options)
                : m.post_references_copy({}, options)}
            </Button>
            {copyState === 'denied' || copyState === 'unavailable' ? (
              <Button type="button" variant="ghost" className={control} onClick={selectAddress}>
                {m.post_references_select({}, options)}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" className={control} onClick={returnToSource}>
              {m.post_references_return({}, options)}
            </Button>
            <Button type="button" variant="ghost" className={control} onClick={backToList}>
              {m.post_references_back({}, options)}
            </Button>
          </div>
          {copyState !== 'idle' ? (
            <p role="status" className="max-w-prose break-words text-sm" aria-live="polite">
              {copyState === 'pending'
                ? m.post_references_copy_pending({}, options)
                : copyState === 'success'
                  ? m.post_references_copy_success({}, options)
                  : copyState === 'denied'
                    ? m.post_references_copy_denied({}, options)
                    : m.post_references_copy_unavailable({}, options)}
            </p>
          ) : null}
        </section>
      ) : (
        <nav aria-label={title} className="min-w-0">
          <p className="mb-3 text-sm text-muted-foreground">
            {m.post_references_count({ count: references.entries.length }, options)}
          </p>
          <ol className="m-0 list-none space-y-1 p-0">
            {references.entries.map((entry, index) => (
              <li key={entry.position}>
                <Button
                  type="button"
                  variant="ghost"
                  className={`${control} w-full justify-start py-2`}
                  aria-label={m.post_references_entry(
                    { number: index + 1, label: entry.label || m.post_references_unlabeled({}, options) },
                    options,
                  )}
                  onClick={() => choose(entry)}
                >
                  <span className="grid min-w-0 gap-1">
                    <bdi dir="auto" className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                      {entry.label || m.post_references_unlabeled({}, options)}
                    </bdi>
                    <span className="min-w-0 text-xs text-muted-foreground">
                      <span>{m.post_references_location({}, options)}: </span>
                      {entry.destination === 'email' ? (
                        m.post_references_email_destination({}, options)
                      ) : (
                        <bdi dir="ltr" className="[unicode-bidi:plaintext]">
                          {entry.location}
                        </bdi>
                      )}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ol>
          {references.overflow ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {m.post_references_overflow({ count: references.overflow }, options)}
            </p>
          ) : null}
        </nav>
      )}
    </div>
  );

  if (!enhanced || !references.entries.length) return null;
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
        <Button type="button" variant="ghost" className={control} onClick={returnToPreviousPosition}>
          {m.post_references_return_previous({}, options)}
        </Button>
      ) : null}
      {unavailable ? (
        <p role="status" className="basis-full max-w-prose p-2 text-sm">
          {m.post_references_return_unavailable({}, options)}
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
          {list}
        </BottomSheet>
      ) : (
        <Dialog open={open} onOpenChange={changeOpen} onOpenChangeComplete={complete}>
          <DialogContent showCloseButton={false} finalFocus={finalFocus} className="gap-3 motion-reduce:animate-none">
            <div className="flex min-w-0 items-start gap-2">
              <DialogTitle className="min-w-0 flex-1 break-words">{title}</DialogTitle>
              <Button type="button" variant="ghost" className={control} onClick={() => changeOpen(false)}>
                {closeLabel}
              </Button>
            </div>
            {list}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
