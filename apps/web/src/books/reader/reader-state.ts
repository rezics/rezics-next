import {
  BOOK_ANCESTOR_LIMIT,
  BOOK_CONTENTS_LIMIT,
  bookAddressWithinBounds,
  bookPageMatches,
  samePublication,
  type BookAddress,
  type BookChapterAddress,
  type BookContentsAddress,
  type BookPage,
  type BookReadResult,
  type HostedBookSource,
} from './source';

export type BookReaderState = Readonly<{
  address: BookAddress;
  state:
    | 'idle'
    | 'loading'
    | 'ready'
    | 'denied'
    | 'not-found'
    | 'unavailable'
    | 'changed'
    | 'retired'
    | 'not-installed';
  page: BookPage | null;
  focus: Readonly<{ kind: 'heading' | 'occurrence'; occurrenceId?: string }> | null;
}>;

export type BookReaderFocus = BookReaderState['focus'];
export type BookReaderNavigation = (
  address: BookAddress,
  contentsReturn: BookContentsAddress | null,
  focus: BookReaderFocus,
) => void;

/** A single bounded page and return address. No tree, body cache, progress conversion or command. */
export function createBookReader(
  source: HostedBookSource,
  initialAddress: BookAddress,
  locale: string,
  guard: () => boolean = () => true,
  options: {
    contentsReturn?: BookContentsAddress | null;
    navigate?: BookReaderNavigation;
    reload?: () => void;
    initialFocus?: BookReaderFocus;
  } = {},
) {
  const observation = source.getSnapshot();
  let active = true;
  let connected = false;
  let connection = 0;
  let stopSource: (() => void) | undefined;
  let request: AbortController | undefined;
  let ticket = 0;
  let contentsReturn: BookContentsAddress | null = options.contentsReturn ?? null;
  let snapshot: BookReaderState = { address: initialAddress, state: 'idle', page: null, focus: null };
  const listeners = new Set<() => void>();
  const publish = (value: BookReaderState) => {
    snapshot = value;
    for (const listener of [...listeners]) listener();
  };
  const retire = () => {
    if (!active) return;
    active = false;
    ticket += 1;
    request?.abort();
    request = undefined;
    contentsReturn = null;
    publish({ address: snapshot.address, state: 'retired', page: null, focus: null });
  };
  const current = () => {
    if (source.getSnapshot() !== observation || !guard()) retire();
    return active && connected;
  };
  const read = async (address: BookAddress, focus: BookReaderState['focus'] = { kind: 'heading' }) => {
    if (!current() || snapshot.state === 'loading') return;
    if (!samePublication(initialAddress.publication, address.publication)) return;
    if (!bookAddressWithinBounds(address)) {
      publish({ address, state: 'unavailable', page: null, focus: null });
      return;
    }
    if (observation.state !== 'current') {
      publish({
        address,
        state: observation.state === 'not-installed' ? 'not-installed' : 'unavailable',
        page: null,
        focus: null,
      });
      return;
    }
    const ownTicket = ++ticket;
    const ownConnection = connection;
    const controller = new AbortController();
    request = controller;
    // Retire the body/rows before dispatch, including on same-address refresh and failed continuation.
    publish({ address, state: 'loading', page: null, focus: null });
    const operands = { address, locale, limit: BOOK_CONTENTS_LIMIT, ancestorLimit: BOOK_ANCESTOR_LIMIT } as const;
    try {
      // Fence queued calls as well as their completions.
      await Promise.resolve();
      if (!current() || ownTicket !== ticket || ownConnection !== connection) return;
      let result: BookReadResult = await source.read(operands, controller.signal);
      if (!current() || ownTicket !== ticket || ownConnection !== connection) return;
      if (result.state === 'ready' && !bookPageMatches(operands, result.page)) result = { state: 'unavailable' };
      request = undefined;
      publish(
        result.state === 'ready'
          ? { address, state: 'ready', page: result.page, focus }
          : { address, state: result.state, page: null, focus },
      );
    } catch {
      if (!current() || ownTicket !== ticket || ownConnection !== connection) return;
      request = undefined;
      publish({ address, state: 'unavailable', page: null, focus });
    }
  };
  const move = (address: BookAddress, focus: BookReaderFocus = { kind: 'heading' }) => {
    if (!options.navigate) {
      void read(address, focus);
      return;
    }
    if (!current() || snapshot.state === 'loading') return;
    const origin = contentsReturn;
    retire();
    options.navigate(address, origin, focus);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      connected = true;
      const ownConnection = ++connection;
      stopSource = source.subscribe(() => {
        current();
      });
      if (current()) void read(snapshot.address, options.initialFocus ?? null);
      return () => {
        if (ownConnection !== connection) return;
        connected = false;
        ticket += 1;
        request?.abort();
        request = undefined;
        stopSource?.();
        stopSource = undefined;
        // Strict Mode can reconnect this same visit; its former queued requests stay retired.
        snapshot = { ...snapshot, state: 'idle', page: null, focus: null };
        queueMicrotask(() => {
          if (!connected) retire();
        });
      };
    },
    current,
    retire,
    read,
    openChapter(address: BookChapterAddress) {
      if (!current() || snapshot.state === 'loading') return;
      if (snapshot.address.kind === 'contents') contentsReturn = { ...snapshot.address, selection: address.selection };
      move(address);
    },
    openContents(address?: BookContentsAddress) {
      if (!current() || snapshot.state === 'loading') return;
      const chapter = snapshot.page?.kind === 'chapter' ? snapshot.page : null;
      const target = address ??
        contentsReturn ??
        chapter?.contents ?? {
          kind: 'contents' as const,
          publication: initialAddress.publication,
          parentOccurrenceId: null,
          cursor: null,
          selection: snapshot.address.selection,
        };
      const selection = chapter?.address.selection ?? snapshot.address.selection;
      const selected = selection ? { ...target, selection } : target;
      contentsReturn = selected;
      move(selected, selection ? { kind: 'occurrence', occurrenceId: selection.occurrenceId } : { kind: 'heading' });
    },
    retry() {
      if (options.reload) {
        retire();
        options.reload();
      } else void read(snapshot.address);
    },
  };
}
export type BookReader = ReturnType<typeof createBookReader>;
