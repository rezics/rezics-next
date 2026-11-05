import type { InboxSelection } from './inbox-read';

type ReturnLocation = { pathname: string; href?: string; state: unknown };
type ReturnRouter = {
  subscribe: (
    event: 'onBeforeNavigate',
    listener: (value: { fromLocation?: ReturnLocation | undefined; toLocation: ReturnLocation }) => void,
  ) => () => void;
};

export type InboxReturnOwner = {
  /** Called once at departure, while the supplying response and viewer are still mounted. */
  admitDeparture: () => boolean;
  /** Rechecks the original viewer episode, credential and locale on return. */
  isCurrent: () => boolean;
};

export type InboxReturnReceipt = Readonly<{
  id: string;
  historyKey: string;
  selection: InboxSelection;
  cursor: string | undefined;
  noticeId: string;
  phase: 'armed' | 'departed' | 'arrived';
  focusVersion: number;
  owner: InboxReturnOwner;
}>;

type ReturnSlot = {
  receipt: InboxReturnReceipt | null;
  focusVersion: number;
  stop: (() => void) | null;
  onFocus: (() => void) | null;
  listeners: Set<(receipt: InboxReturnReceipt | null) => void>;
};

const slots = new WeakMap<object, ReturnSlot>();
let sequence = 0;
const localePrefix = /^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/;

function slotFor(router: object): ReturnSlot {
  let slot = slots.get(router);
  if (!slot) {
    slot = { receipt: null, focusVersion: 0, stop: null, onFocus: null, listeners: new Set() };
    slots.set(router, slot);
  }
  return slot;
}

function routePath(pathname: string) {
  return pathname.replace(localePrefix, '').replace(/\/$/, '') || '/';
}

function historyKey(location: ReturnLocation | undefined): string | null {
  if (!location?.state || typeof location.state !== 'object') return null;
  const state = location.state as { key?: unknown; __TSR_key?: unknown };
  const key = typeof state.key === 'string' ? state.key : state.__TSR_key;
  if (typeof key === 'string' && key.length > 0) return key;
  return typeof location.href === 'string' && location.href.length > 0 ? location.href : null;
}

function publish(slot: ReturnSlot, receipt: InboxReturnReceipt | null) {
  slot.receipt = receipt;
  for (const listener of slot.listeners) listener(receipt);
}

function clear(slot: ReturnSlot, id?: string) {
  if (id !== undefined && slot.receipt?.id !== id) return;
  slot.stop?.();
  slot.stop = null;
  if (slot.onFocus && typeof document !== 'undefined') document.removeEventListener('focusin', slot.onFocus, true);
  slot.onFocus = null;
  if (slot.receipt) publish(slot, null);
}

/** Keep one private, same-tab return receipt; it never enters a URL or persistent browser store. */
export function armInboxReturn(
  routerObject: object,
  input: Omit<InboxReturnReceipt, 'id' | 'phase' | 'focusVersion'>,
) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const router = routerObject as ReturnRouter;
  const slot = slotFor(routerObject);
  clear(slot);
  const receipt: InboxReturnReceipt = Object.freeze({
    ...input,
    id: `inbox-return-${++sequence}`,
    phase: 'armed',
    focusVersion: slot.focusVersion,
  });
  publish(slot, receipt);
  slot.onFocus = () => {
    slot.focusVersion += 1;
  };
  document.addEventListener('focusin', slot.onFocus, true);
  slot.stop = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
    const current = slot.receipt;
    if (!current) return;
    if (current.phase === 'armed') {
      if (
        routePath(fromLocation?.pathname ?? '') === '/inbox' &&
        historyKey(fromLocation) === current.historyKey &&
        routePath(toLocation.pathname) !== '/inbox' &&
        current.owner.admitDeparture()
      ) {
        publish(slot, Object.freeze({ ...current, phase: 'departed' }));
      } else {
        clear(slot, current.id);
      }
      return;
    }
    if (current.phase === 'departed') {
      if (
        routePath(toLocation.pathname) === '/inbox' &&
        historyKey(toLocation) === current.historyKey &&
        current.owner.isCurrent()
      ) {
        publish(slot, Object.freeze({ ...current, phase: 'arrived', focusVersion: slot.focusVersion }));
      } else {
        clear(slot, current.id);
      }
      return;
    }
    clear(slot, current.id);
  });
}

export function subscribeInboxReturn(router: object, listener: (receipt: InboxReturnReceipt | null) => void) {
  const slot = slotFor(router);
  slot.listeners.add(listener);
  return () => slot.listeners.delete(listener);
}

/** Read only a matching arrival. A changed viewer episode never inherits the old address. */
export function inboxReturnFor(router: object, expectedHistoryKey: string): InboxReturnReceipt | null {
  const receipt = slotFor(router).receipt;
  return receipt?.phase === 'arrived' &&
    receipt.historyKey === expectedHistoryKey &&
    receipt.owner.isCurrent()
    ? receipt
    : null;
}

export function inboxReturnIsCurrent(receipt: InboxReturnReceipt) {
  return receipt.owner.isCurrent();
}

export function completeInboxReturn(router: object, id: string) {
  const slot = slotFor(router);
  const receipt = slot.receipt;
  if (receipt?.id !== id || receipt.phase !== 'arrived' || !receipt.owner.isCurrent()) return null;
  const restoreFocus = slot.focusVersion === receipt.focusVersion;
  clear(slot, id);
  return { receipt, restoreFocus };
}

export function retireInboxReturn(router: object, id?: string) {
  clear(slotFor(router), id);
}
