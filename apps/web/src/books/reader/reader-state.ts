import {
  createBookContentsNavigation,
  type BookContentsNavigation,
  type BookContentsMovement,
} from './contents-navigation';
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
  previousContents?: BookContentsAddress | null;
  focus: Readonly<{ kind: 'heading' | 'occurrence'; occurrenceId?: string }> | null;
}>;

export type BookReaderFocus = BookReaderState['focus'];
export type BookReaderNavigation = (
  address: BookAddress,
  contentsReturn: BookContentsAddress | null,
  focus: BookReaderFocus,
) => void;

/** One center page and independent, explicitly revealed outline branches; no body cache or progress command. */
export function createBookReader(
  source: HostedBookSource,
  initialAddress: BookAddress,
  locale: string,
  guard: () => boolean = () => true,
  options: {
    contentsReturn?: BookContentsAddress | null;
    navigate?: BookReaderNavigation;
    reload?: (focus: BookReaderFocus) => void;
    contentsNavigation?: BookContentsNavigation;
    initialFocus?: BookReaderFocus;
  } = {},
) {
  const observation = source.getSnapshot();
  const contents = options.contentsNavigation ?? createBookContentsNavigation();
  const contentsGeneration = contents.generation();
  const outline = contents.outline;
  const branchRequests = new Map<string | null, { controller: AbortController; address: BookContentsAddress }>();
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
    for (const { controller, address } of branchRequests.values()) {
      controller.abort();
      outline.cancel(address);
    }
    branchRequests.clear();
    contentsReturn = null;
    if (!options.contentsNavigation) contents.retire();
    publish({ address: snapshot.address, state: 'retired', page: null, focus: null });
  };
  const current = () => {
    if (!active) return false;
    if (source.getSnapshot() !== observation) {
      if (contents.generation() === contentsGeneration) contents.retire();
      retire();
    }
    if (!guard()) {
      if (contents.generation() === contentsGeneration) contents.retire();
      retire();
    }
    if (contents.generation() !== contentsGeneration) retire();
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
    // A center read retires its former body. Branch reads never replace this page.
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
      if (result.state === 'ready' && result.page.kind === 'contents') {
        contents.observe(result.page.address);
        outline.accept(result.page);
        outline.root(result.page.address);
      }
      publish(
        result.state === 'ready'
          ? {
              address,
              state: 'ready',
              page: result.page,
              focus,
              previousContents: address.kind === 'contents' ? contents.previous(address) : null,
            }
          : { address, state: result.state, page: null, focus },
      );
    } catch {
      if (!current() || ownTicket !== ticket || ownConnection !== connection) return;
      request = undefined;
      publish({ address, state: 'unavailable', page: null, focus });
    }
  };
  const readBranch = async (address: BookContentsAddress) => {
    if (!current() || branchRequests.has(address.parentOccurrenceId)) return;
    if (!samePublication(initialAddress.publication, address.publication)) return;
    const controller = new AbortController();
    const attempt = { controller, address };
    const ownConnection = connection;
    branchRequests.set(address.parentOccurrenceId, attempt);
    outline.begin(address);
    const operands = { address, locale, limit: BOOK_CONTENTS_LIMIT, ancestorLimit: BOOK_ANCESTOR_LIMIT } as const;
    try {
      await Promise.resolve();
      if (!current() || ownConnection !== connection) return;
      const result = await source.read(operands, controller.signal);
      if (!current() || ownConnection !== connection || branchRequests.get(address.parentOccurrenceId) !== attempt)
        return;
      if (result.state === 'ready') {
        if (result.page.kind === 'contents' && bookPageMatches(operands, result.page)) outline.accept(result.page);
        else outline.fail(address, 'unavailable');
      } else outline.fail(address, result.state);
    } finally {
      if (branchRequests.get(address.parentOccurrenceId) === attempt) branchRequests.delete(address.parentOccurrenceId);
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
    outline,
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
        for (const { controller, address } of branchRequests.values()) {
          controller.abort();
          outline.cancel(address);
        }
        branchRequests.clear();
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
    retireBoundary() {
      if (contents.generation() === contentsGeneration) contents.retire();
      retire();
    },
    read,
    toggleBranch(address: BookContentsAddress) {
      if (!current()) return;
      const branch = outline.branch(address.parentOccurrenceId);
      if (branch?.expanded) {
        outline.collapse(address.parentOccurrenceId);
        return;
      }
      outline.expand(address);
      if (!branch?.page && branch?.state !== 'loading') void readBranch(branch?.attempt ?? address);
    },
    moreBranch(parent: string | null) {
      if (!current()) return;
      const branch = outline.branch(parent);
      if (branch?.state !== 'ready' || branch.page?.continuation.state !== 'more') return;
      void readBranch({
        ...branch.address,
        selection: snapshot.address.selection,
        cursor: branch.page.continuation.cursor,
      });
    },
    retryBranch(parent: string | null) {
      if (!current()) return;
      const branch = outline.branch(parent);
      if (branch?.state === 'loading') return;
      if (branch?.attempt) void readBranch(branch.attempt);
      else if (branch) void readBranch(branch.address);
    },
    resolveContents: contents.resolve,
    openChapter(address: BookChapterAddress, focus: BookReaderFocus = { kind: 'heading' }) {
      if (!current() || snapshot.state === 'loading') return;
      const origin = outline.origin(address.selection.occurrenceId);
      if (origin || snapshot.address.kind === 'contents')
        contentsReturn = { ...(origin ?? (snapshot.address as BookContentsAddress)), selection: address.selection };
      move(address, focus);
    },
    openContents(
      address?: BookContentsAddress,
      movement: BookContentsMovement = 'level',
      focus: BookReaderFocus = { kind: 'heading' },
    ) {
      if (!current() || snapshot.state === 'loading') return;
      const chapter = snapshot.page?.kind === 'chapter' ? snapshot.page : null;
      const target = address
        ? contents.resolve(address, movement)
        : (contentsReturn ??
          chapter?.contents ?? {
            kind: 'contents' as const,
            publication: initialAddress.publication,
            parentOccurrenceId: null,
            cursor: null,
            selection: snapshot.address.selection,
          });
      const selection = chapter?.address.selection ?? snapshot.address.selection;
      const selected = selection ? { ...target, selection } : target;
      contentsReturn = selected;
      contents.stage(selected, movement);
      move(
        selected,
        focus !== null && snapshot.address.kind === 'chapter' && selection
          ? { kind: 'occurrence', occurrenceId: selection.occurrenceId }
          : focus,
      );
    },
    retry(focus: BookReaderFocus = { kind: 'heading' }) {
      if (options.reload) {
        retire();
        options.reload(focus);
      } else void read(snapshot.address, focus);
    },
  };
}
export type BookReader = ReturnType<typeof createBookReader>;
