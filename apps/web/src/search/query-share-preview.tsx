import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addressLease, browserObservation, type AddressLease } from '../session';
import { Button } from '@rezics/ui/shadcn/button';
import { locales } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { queryShareUrl, shareUnavailable, type QueryShare } from './query-share';

type PreviewProps = {
  locale: string;
  changed: boolean;
  prepare: (signal: AbortSignal) => Promise<QueryShare>;
};

/** Search retains its request/locale/session key; Web supplies the retiring reader incarnation. */
export function QuerySharePreview(props: PreviewProps) {
  const client = useQueryClient();
  const observer = useMemo(() => browserObservation(client), [client]);
  const snapshot = useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getServerSnapshot);
  const reader = useMemo(
    () =>
      addressLease(
        () =>
          (snapshot.state === 'signed-in' || snapshot.state === 'signed-out') && observer.getSnapshot() === snapshot,
      ),
    [observer, snapshot],
  );
  const incarnation = useRef({ reader, id: 0 });
  if (incarnation.current.reader !== reader) {
    incarnation.current.reader.retire();
    incarnation.current = { reader, id: incarnation.current.id + 1 };
  }
  return <ShareVisit key={JSON.stringify([props.locale, incarnation.current.id])} {...props} reader={reader} />;
}

type Visit = {
  share?: QueryShare;
  preparation?: AbortController;
  clipboard?: object;
};

function ShareVisit({ locale, changed, prepare, reader }: PreviewProps & { reader: AddressLease }) {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<QueryShare>();
  const [pending, setPending] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'pending' | 'copied' | 'refused'>('idle');
  const visit = useRef<Visit | undefined>(undefined);
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLTextAreaElement>(null);
  const focus = useRef<{ owner: Visit; from: Element | null } | undefined>(undefined);
  const owns = (owner: Visit) => alive.current && visit.current === owner && reader.current();
  const retire = () => {
    const old = visit.current;
    visit.current = undefined;
    focus.current = undefined;
    old?.preparation?.abort();
  };
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      retire();
    };
  }, []);
  useLayoutEffect(() => {
    const intent = focus.current;
    focus.current = undefined;
    if (open && intent && owns(intent.owner) && document.activeElement === intent.from) panel.current?.focus();
  }, [open]);
  const options = { locale: locales.find((entry) => entry === locale) ?? 'en' };
  const url = share && typeof window !== 'undefined' ? queryShareUrl(window.location.origin, locale, share) : null;
  const prepareVisit = async (owner: Visit) => {
    if (!owns(owner) || owner.preparation || owner.clipboard) return;
    const controller = new AbortController();
    owner.preparation = controller;
    setPending(true);
    let next: QueryShare;
    try {
      next = await prepare(controller.signal);
    } catch {
      next = shareUnavailable();
    }
    if (!owns(owner) || owner.preparation !== controller) return;
    owner.preparation = undefined;
    owner.share = next;
    setShare(next);
    setPending(false);
    setCopy('idle');
  };
  const openVisit = () => {
    if (!alive.current || !reader.current()) return;
    if (visit.current) return;
    const owner: Visit = {};
    visit.current = owner;
    focus.current = { owner, from: document.activeElement };
    setOpen(true);
    void prepareVisit(owner);
  };
  const copyLink = async () => {
    const owner = visit.current;
    if (!owner || !owns(owner) || owner.preparation || owner.clipboard || !owner.share) return;
    // Capture current native advice immediately before the external effect. Issued writes cannot be recalled.
    const currentUrl = queryShareUrl(window.location.origin, locale, owner.share);
    if (!currentUrl) return;
    const command = {};
    owner.clipboard = command;
    setCopy('pending');
    let result: 'copied' | 'refused';
    try {
      await navigator.clipboard.writeText(currentUrl);
      result = 'copied';
    } catch {
      result = 'refused';
    }
    if (!owns(owner) || owner.clipboard !== command) return;
    owner.clipboard = undefined;
    setCopy(result);
  };
  const close = () => {
    const owner = visit.current;
    const restore = owner && owns(owner) && panel.current?.contains(document.activeElement);
    retire();
    setOpen(false);
    setShare(undefined);
    setPending(false);
    setCopy('idle');
    if (restore && trigger.current?.isConnected) trigger.current.focus();
  };
  return (
    <div className="min-w-0 space-y-3">
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-disabled={pending || copy === 'pending'}
        onClick={openVisit}
      >
        {m.search_share_action({}, options)}
      </Button>
      {open && (
        <div
          ref={panel}
          role="region"
          aria-label={m.search_share_action({}, options)}
          tabIndex={-1}
          className="max-h-[80dvh] min-w-0 space-y-3 overflow-auto rounded-xl border p-4"
          aria-busy={pending || copy === 'pending'}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <p>{changed ? m.search_share_draft({}, options) : m.search_share_executed({}, options)}</p>
          {pending && <p role="status">{m.search_share_loading({}, options)}</p>}
          {share && (
            <>
              {share.document && (
                <>
                  <p className="whitespace-pre-wrap break-words">{share.document.text}</p>
                  <p>{share.document.languages.join(' → ')}</p>
                  {share.document.sort && <p>{share.document.sort}</p>}
                  <ul>
                    {share.selections.map((label, index) => (
                      <li key={index} lang={label.language}>
                        {label.value}
                      </li>
                    ))}
                  </ul>
                  {share.document.filter && (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{share.document.filter}</pre>
                  )}
                </>
              )}
              {url ? (
                <>
                  <Button type="button" disabled={pending || copy === 'pending'} onClick={() => void copyLink()}>
                    {m.search_share_copy({}, options)}
                  </Button>
                  {copy === 'pending' && <p role="status">{m.search_share_copying({}, options)}</p>}
                  {copy === 'copied' && <p role="status">{m.search_share_copied({}, options)}</p>}
                  {copy === 'refused' && (
                    <>
                      <p role="status">{m.search_share_refused({}, options)}</p>
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          const owner = visit.current;
                          if (!owner || !owns(owner) || owner.preparation || owner.clipboard) return;
                          link.current?.focus();
                          link.current?.select();
                        }}
                      >
                        {m.search_share_select({}, options)}
                      </Button>
                      <textarea
                        ref={link}
                        aria-label={m.search_share_copy({}, options)}
                        readOnly
                        value={url}
                        className="w-full"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </>
                  )}
                </>
              ) : (
                <p role="status">
                  {share.reason === 'oversized' || share.action === 'allowed'
                    ? m.search_share_oversized({}, options)
                    : share.reason === 'private_context'
                      ? m.search_share_private({}, options)
                      : share.reason === 'unsupported'
                        ? m.search_share_unsupported({}, options)
                        : m.search_share_unavailable({}, options)}
                </p>
              )}
            </>
          )}
          {share && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || copy === 'pending'}
              onClick={() => {
                if (visit.current) void prepareVisit(visit.current);
              }}
            >
              {m.search_share_retry({}, options)}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={close}>
            {m.search_share_close({}, options)}
          </Button>
        </div>
      )}
    </div>
  );
}
