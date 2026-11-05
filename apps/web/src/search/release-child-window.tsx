import { useLayoutEffect, useRef, useState } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { addressLease, readLease } from '../session';
import type { ReaderOrigin } from '../session/reader';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { discoveryMessage } from './discovery-results';
import { ReleaseResultRow } from './release-child-row';
import { localizedLabel } from './results';
import {
  readReleaseSearchChildren,
  type ReleaseSearchChildrenState,
  type ReleaseSearchGroup,
} from './release-search-query';
import type { ParsedReleaseSearch } from './release-search';

const cursorHistoryLimit = 12;
type ChildOwner = ReturnType<typeof useReleaseChildOwner>;

/** Search owns the address; Web owns reader replacement. Retired visits never revive on A/B/A. */
export function useReleaseChildOwner(key: string, reader?: ReaderOrigin) {
  const ref = useRef<{
    key: string;
    parent?: object;
    id: number;
    address: ReturnType<typeof addressLease>;
    read: ReturnType<typeof readLease>;
    requests: Set<AbortController>;
    mounted: boolean;
  } | null>(null);
  if (
    !ref.current ||
    ref.current.key !== key ||
    ref.current.parent !== reader?.lifetime ||
    !ref.current.address.current()
  ) {
    const previous = ref.current;
    previous?.address.retire();
    previous?.requests.forEach((request) => request.abort());
    const address = addressLease(() => !reader || reader.isCurrent());
    ref.current = {
      key,
      ...(reader ? { parent: reader.lifetime } : {}),
      id: (previous?.id ?? 0) + 1,
      address,
      read: readLease('release-search', address, () => true),
      requests: new Set(),
      mounted: false,
    };
  }
  const owner = ref.current;
  useLayoutEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.requests.forEach((request) => request.abort());
      owner.requests.clear();
    };
  }, [owner]);
  return owner;
}

type View = {
  status: 'idle' | 'loading' | ReleaseSearchChildrenState['status'];
  // null means the native preview; [] is a legitimate sparse accepted window.
  children: Extract<ReleaseSearchChildrenState, { status: 'ready' }>['page']['children'] | null;
  next: string | null;
  history: string[];
  halted?: 'cycle' | 'ceiling';
};

export function ReleaseChildWindow({
  owner,
  group,
  parsed,
  locale,
  restartHref,
}: {
  owner: ChildOwner;
  group: Extract<ReleaseSearchGroup, { kind: 'work' }>;
  parsed?: ParsedReleaseSearch;
  locale: string;
  restartHref: string;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ status: 'idle', children: null, next: group.next, history: [] });
  const pending = useRef<AbortController | null>(null);
  const region = useRef<HTMLDetailsElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const focus = useRef<HTMLElement | null>(null);
  const visible = owner.read.current();
  const children = visible ? (view.children ?? group.releases) : [];
  const blocked = ['restart', 'denied', 'invalid', 'unsupported'].includes(view.status);
  const canContinue = visible && parsed && !parsed.invalid.length && !blocked && !view.halted && view.next !== null;
  const current = (request: AbortController) => owner.mounted && owner.read.current() && !request.signal.aborted;

  useLayoutEffect(() => {
    // Keep dispatch captured until the settled view is committed, even for an immediately resolved transport.
    if (view.status !== 'loading') pending.current = null;
    if (!open || !visible) focus.current = null;
    if (view.status === 'loading' || !focus.current) return;
    const source = focus.current;
    focus.current = null;
    if (!owner.mounted || !owner.read.current() || !region.current?.open) return;
    const active = source.ownerDocument.activeElement;
    if (active !== source && !(active === source.ownerDocument.body && !source.isConnected)) return;
    if (action.current && !action.current.disabled) action.current.focus();
    else region.current.focus();
  }, [view, open, visible, owner]);

  const load = async (button: HTMLButtonElement) => {
    const token = view.next;
    // Capture before React can render: two activations in the same event batch send once.
    if (!canContinue || !token || pending.current || !owner.mounted || !owner.read.current()) return;
    const request = new AbortController();
    pending.current = request;
    owner.requests.add(request);
    focus.current = button.ownerDocument.activeElement === button ? button : null;
    setView({ ...view, status: 'loading' });
    let result: ReleaseSearchChildrenState;
    try {
      result = await readReleaseSearchChildren({
        data: { locale, rawJson: JSON.stringify(parsed.form), work: group.id, cursor: token },
        signal: request.signal,
      });
    } catch {
      result = { status: 'unavailable' };
    }
    owner.requests.delete(request);
    if (pending.current !== request) return;
    if (!current(request)) return;
    if (result.status === 'ready' || result.status === 'preparing') {
      const history = view.history.includes(token) ? view.history : [...view.history, token];
      const next = result.page.next;
      // A preparing response may lawfully retry its own token. A ready page must progress.
      const cycle = next !== null && history.includes(next) && !(result.status === 'preparing' && next === token);
      const halted = cycle ? 'cycle' : next !== null && history.length >= cursorHistoryLimit ? 'ceiling' : undefined;
      setView({
        status: result.status,
        children: result.status === 'ready' ? result.page.children : view.children,
        next,
        history,
        ...(halted ? { halted } : {}),
      });
    } else {
      const withhold = ['restart', 'denied', 'invalid', 'unsupported'].includes(result.status);
      setView({ ...view, status: result.status, ...(withhold ? { children: [] } : {}) });
    }
  };

  return (
    <li data-release-work={group.id} className="ml-6 list-none rounded-md border px-3 py-2">
      <details
        ref={region}
        tabIndex={-1}
        aria-label={`${m.release_search_related_releases({}, options)}: ${localizedLabel(group.work.labels, locale).text || group.id}`}
        open={open}
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
          if (!event.currentTarget.open) focus.current = null;
        }}
        onBlurCapture={(event) => {
          if (focus.current && event.relatedTarget !== null && event.relatedTarget !== focus.current)
            focus.current = null;
        }}
      >
        <summary className="cursor-pointer text-sm font-medium">
          {m.release_search_related_releases({}, options)}
        </summary>
        <p role="status" aria-live="polite" className="py-2 text-sm text-muted-foreground">
          {view.children === null
            ? m.release_search_child_preview({}, options)
            : m.release_search_child_window({ count: children.length }, options)}
        </p>
        <ul role="list" className="mt-2 divide-y">
          {children.map((child) => (
            <ReleaseResultRow key={child.id} card={child} locale={locale} />
          ))}
        </ul>
        {view.status !== 'idle' && view.status !== 'ready' && (
          <p
            role={blocked || view.status === 'unavailable' ? 'alert' : 'status'}
            aria-live="polite"
            className="py-2 text-sm text-muted-foreground"
          >
            {discoveryMessage(view.status, locale)}
          </p>
        )}
        {view.halted && <p role="status">{m.release_search_child_restart_needed({}, options)}</p>}
        {(view.status === 'idle' || view.status === 'ready') && view.next === null && (
          <p role="status">{m.release_search_terminal({}, options)}</p>
        )}
        {canContinue && (
          <button
            ref={action}
            type="button"
            className={buttonVariants({ variant: 'outline' })}
            disabled={view.status === 'loading'}
            onClick={(event) => void load(event.currentTarget)}
          >
            {view.status === 'loading'
              ? m.discovery_loading({}, options)
              : view.status !== 'idle' && view.status !== 'ready'
                ? m.search_facet_retry({}, options)
                : m.release_search_continue({}, options)}
          </button>
        )}
        <a href={restartHref} className="ml-3 underline">
          {m.release_search_child_first({}, options)}
        </a>
      </details>
    </li>
  );
}
