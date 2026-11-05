import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@rezics/ui/shadcn/dialog';
import { m } from '../paraglide/messages.js';
import { shelfHref, type ShelfPresentationIntent } from './shelf-params';
import { readShelfTypesCurrent, SHELF_TYPES_LIMIT, type ShelfTypesView } from './shelf-types-read';
import { useShelfTypesLifetime } from './shelf-types-current';

import { ShelfTypeWindowNavigation } from './shelf-type-window-navigation';

type Props = { locale: string; view: ShelfPresentationIntent; typeLabel?: string };

export function ShelfTypes(props: Props) {
  // Standalone/pure previews have no observed viewer and cannot make private requests.
  const client = useContext(QueryClientContext);
  return client ? <CurrentShelfTypes {...props} /> : null;
}

function CurrentShelfTypes(props: Props) {
  const lifetime = useShelfTypesLifetime(props.locale, props.view);
  if (!lifetime.subject || !lifetime.admitted) return null;
  return (
    <OwnerShelfTypes
      key={lifetime.key}
      {...props}
      subject={lifetime.subject}
      hydrated={lifetime.hydrated}
      isCurrent={lifetime.isCurrent}
    />
  );
}

/** Local to this mounted owner view: one replaceable page and bounded coordinate history. */
function OwnerShelfTypes({
  locale,
  view,
  typeLabel,
  subject,
  hydrated,
  isCurrent,
}: Props & { subject: string; hydrated: boolean; isCurrent: () => boolean }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ShelfTypesView>();
  const [busy, setBusy] = useState(false);
  const navigation = useRef(new ShelfTypeWindowNavigation());
  const heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef(false);
  const opened = useRef(false);
  const focusEpoch = useRef(0);
  useLayoutEffect(() => {
    if (focus.current && page?.state === 'loaded' && opened.current && isCurrent()) heading.current?.focus();
    focus.current = false;
  }, [page, isCurrent]);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const renderedRevision = revision.current;
  const currentChoice = () => isCurrent() && renderedRevision === revision.current;
  const selectionLabel = view.type ? (typeLabel ?? m.library_type_unnamed()) : m.library_types_all();
  const { type: _type, cursor: _cursor, layout, ...rest } = view;
  const retained = { ...rest, ...(view.layoutExplicit !== false && layout ? { layout } : {}) };
  const href = (type?: string) => shelfHref(locale, { ...retained, ...(type ? { type } : {}) });
  async function read(movement: 'read' | 'next' | 'previous' | 'first' | 'retry' = 'read', next?: string) {
    if (!currentChoice() || inFlight.current) return;
    const target = navigation.current.stage(movement, next);
    if (!target) return;
    const { cursor } = target;
    const handoff = focusEpoch.current;
    const attempt = ++revision.current;
    const currentRequest = () => isCurrent() && revision.current === attempt;
    inFlight.current = true;
    focus.current = false;
    setBusy(true);
    // Release the previous choices immediately; failure is never represented as an empty successful page.
    setPage(undefined);
    try {
      if (!currentRequest()) return;
      const result = await readShelfTypesCurrent({ data: cursor ? { cursor } : {} });
      if (!currentRequest()) return;
      const requested = result.requested;
      const matches =
        requested.cursor === (cursor ?? null) && requested.limit === SHELF_TYPES_LIMIT && requested.locale === locale;
      const admitted =
        matches && result.sessionSubject === subject && result.authorizationAgrees && result.page.state === 'loaded';
      navigation.current.settle(admitted);
      focus.current = admitted && movement !== 'read' && handoff === focusEpoch.current;
      setPage(
        matches && result.sessionSubject === subject && result.authorizationAgrees
          ? result.page
          : matches && result.sessionSubject === null && result.page.state === 'signed-out'
            ? { state: 'signed-out' }
            : { state: 'unavailable' },
      );
    } catch {
      if (currentRequest()) {
        navigation.current.settle(false);
        setPage({ state: 'unavailable' });
      }
    } finally {
      if (currentRequest()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (isCurrent()) {
          if (opened.current !== value) focusEpoch.current++;
          opened.current = value;
          if (!value) focus.current = false;
          setOpen(value);
        }
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal break-words" />}
        disabled={!hydrated}
        onClick={() => {
          if (currentChoice() && !page && !busy) void read();
        }}
      >
        {m.library_type_action({ type: selectionLabel })}
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle ref={heading} tabIndex={-1}>
            {m.library_types_heading()}
          </DialogTitle>
          <DialogDescription>{m.library_types_description()}</DialogDescription>
        </DialogHeader>
        <p>{m.library_type_action({ type: selectionLabel })}</p>
        {view.type && !typeLabel ? (
          <p className="text-sm text-muted-foreground">{m.library_type_name_unavailable()}</p>
        ) : null}
        <a
          className={`${buttonVariants({ variant: 'outline' })} min-h-11`}
          href={href()}
          onClick={(event) => {
            if (!currentChoice()) event.preventDefault();
          }}
          aria-current={!view.type ? 'page' : undefined}
        >
          {m.library_types_all()}
        </a>
        {busy ? <p role="status">{m.library_types_loading()}</p> : null}
        {page?.state === 'loaded' ? (
          <>
            {page.types.length ? (
              <nav aria-label={m.library_types_heading()} className="grid gap-2">
                {page.types.map((choice, index) => (
                  <a
                    key={choice.type}
                    className={`${buttonVariants({ variant: choice.type === view.type ? 'secondary' : 'outline' })} min-h-11 h-auto whitespace-normal break-words`}
                    href={href(choice.type)}
                    onClick={(event) => {
                      if (!currentChoice()) event.preventDefault();
                    }}
                    aria-current={choice.type === view.type ? 'page' : undefined}
                  >
                    {choice.label ?? m.library_type_unnamed_option({ position: index + 1 })}
                  </a>
                ))}
              </nav>
            ) : (
              <p role="status">{m.library_types_empty()}</p>
            )}
            {page.types.some((choice) => !choice.label) ? (
              <p className="text-sm">{m.library_type_name_unavailable()}</p>
            ) : null}
            {page.next ? (
              <Button variant="outline" className="min-h-11" onClick={() => void read('next', page.next!)}>
                {m.library_types_next()}
              </Button>
            ) : null}
          </>
        ) : page ? (
          <div className="space-y-2">
            <p role={page.state === 'preparing' ? 'status' : 'alert'}>
              {page.state === 'signed-out'
                ? m.library_sign_in()
                : page.state === 'closed'
                  ? m.platform_closed_message()
                  : page.state === 'denied'
                    ? m.library_types_denied()
                    : page.state === 'preparing'
                      ? m.library_types_preparing()
                      : m.library_types_unavailable()}
            </p>
            <Button variant="outline" className="min-h-11" onClick={() => void read('retry')}>
              {m.library_types_retry()}
            </Button>
          </div>
        ) : null}
        {navigation.current.hasPrevious && !busy ? (
          <Button variant="outline" className="min-h-11" onClick={() => void read('previous')}>
            {m.library_collections_previous()}
          </Button>
        ) : null}
        {navigation.current.hasFirst && !busy ? (
          <Button variant="outline" className="min-h-11" onClick={() => void read('first')}>
            {m.library_types_first()}
          </Button>
        ) : null}
        <DialogClose render={<Button variant="outline" />}>{m.action_cancel()}</DialogClose>
      </DialogContent>
    </Dialog>
  );
}
