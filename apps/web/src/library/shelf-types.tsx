import { useRef, useState } from 'react';
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
import { useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { shelfHref, type ShelfSearch } from './shelf-params';
import { readShelfTypes, type ShelfTypesView } from './shelf-types-read';
import { useHydrated } from './shelf-rows';
import { useSession } from '../session/query';

type Props = { locale: string; view: ShelfSearch; typeLabel?: string };

export function ShelfTypes(props: Props) {
  const session = useSession();
  return <OwnerShelfTypes key={`${session.subject ?? session.state}:${props.locale}`} {...props} />;
}

/** Local to this mounted owner view: one replaceable page, no automatic requests or cursor history. */
function OwnerShelfTypes({ locale, view, typeLabel }: Props) {
  const admitted = useOperation('library_entry.list');
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ShelfTypesView>();
  const [busy, setBusy] = useState(false);
  const currentCursor = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const selectionLabel = view.type ? (typeLabel ?? m.library_type_unnamed()) : m.library_types_all();
  const { type: _type, cursor: _cursor, ...retained } = view;
  const href = (type?: string) => shelfHref(locale, { ...retained, ...(type ? { type } : {}) });
  async function read(cursor?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    currentCursor.current = cursor;
    setBusy(true);
    // Release the previous choices immediately; failure is never represented as an empty successful page.
    setPage(undefined);
    try {
      setPage(await readShelfTypes({ data: cursor ? { cursor } : {} }));
    } catch {
      setPage({ state: 'unavailable' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  if (!admitted) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" className="h-auto max-w-full whitespace-normal break-words" />}
        disabled={!hydrated}
        onClick={() => {
          if (!page && !busy) void read();
        }}
      >
        {m.library_type_action({ type: selectionLabel })}
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{m.library_types_heading()}</DialogTitle>
          <DialogDescription>{m.library_types_description()}</DialogDescription>
        </DialogHeader>
        <p>{m.library_type_action({ type: selectionLabel })}</p>
        {view.type && !typeLabel ? (
          <p className="text-sm text-muted-foreground">{m.library_type_name_unavailable()}</p>
        ) : null}
        <a
          className={buttonVariants({ variant: 'outline' })}
          href={href()}
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
                    className={`${buttonVariants({ variant: choice.type === view.type ? 'secondary' : 'outline' })} h-auto whitespace-normal break-words`}
                    href={href(choice.type)}
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
              <Button variant="outline" onClick={() => void read(page.next!)}>
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
            <Button variant="outline" onClick={() => void read(currentCursor.current)}>
              {m.library_types_retry()}
            </Button>
          </div>
        ) : null}
        {currentCursor.current !== undefined && !busy ? (
          <Button variant="outline" onClick={() => void read()}>
            {m.library_types_first()}
          </Button>
        ) : null}
        <DialogClose render={<Button variant="outline" />}>{m.action_cancel()}</DialogClose>
      </DialogContent>
    </Dialog>
  );
}
