import type { ImportLibraryRead } from './read';

export type CurrentImportLibraryRead = Extract<ImportLibraryRead, { state: 'current' }>;
export type ImportLibraryFailure = Exclude<ImportLibraryRead, CurrentImportLibraryRead>;
export type ImportLibraryIntent = {
  cursor: string | null;
  kind: 'first' | 'next' | 'previous' | 'restart' | 'refresh';
  /** One previous address, rather than a history of private pages. Undefined means no previous address. */
  previous?: string | null;
};
export type ImportLibrarySnapshot = {
  visible: CurrentImportLibraryRead | null;
  cursor: string | null;
  previous?: string | null;
  pending: ImportLibraryIntent | null;
  failed: { intent: ImportLibraryIntent; result: ImportLibraryFailure } | null;
  revision: number;
  retired: boolean;
};

function emptyImportLibrary(retired = false, revision = 0): ImportLibrarySnapshot {
  return {
    visible: null,
    cursor: null,
    pending: null,
    failed: null,
    revision,
    retired,
  };
}

/** Local page navigation over the existing current-Library reader. It owns no commands or credentials. */
export function createImportLibraryBrowser(options: {
  current: () => boolean;
  read: (cursor: string | undefined) => Promise<ImportLibraryRead>;
}) {
  let value = emptyImportLibrary();
  let sequence = 0;
  let retired = false;
  const listeners = new Set<() => void>();

  function publish(next: ImportLibrarySnapshot) {
    value = next;
    listeners.forEach((listener) => listener());
  }

  function retire() {
    if (retired) return;
    retired = true;
    ++sequence;
    publish(emptyImportLibrary(true, value.revision + 1));
  }

  function current() {
    if (!retired && !options.current()) retire();
    return !retired;
  }

  async function request(intent: ImportLibraryIntent) {
    if (!current() || value.pending) return value;
    const owner = ++sequence;
    const original = value;
    // Starting a read never fabricates completion, clears a separately current page, or changes its address.
    publish({ ...value, pending: intent, failed: null });
    let result: ImportLibraryRead;
    try {
      result = await options.read(intent.cursor ?? undefined);
    } catch {
      result = { state: 'unavailable' };
    }
    if (!current() || owner !== sequence) return value;

    if (result.state === 'current') {
      publish({
        visible: result,
        cursor: intent.cursor,
        ...(intent.previous === undefined ? {} : { previous: intent.previous }),
        pending: null,
        failed: null,
        revision: value.revision + 1,
        retired: false,
      });
    } else {
      // Native loss of access closes the visible private read, even before browser admission catches up.
      const close = result.state === 'closed' || result.state === 'denied' || result.state === 'signed-out';
      publish({
        ...original,
        ...(close ? { visible: null, cursor: null, previous: undefined } : {}),
        pending: null,
        failed: { intent, result },
        revision: value.revision + 1,
      });
    }
    return value;
  }

  return {
    snapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current,
    retire,
    /** Discard pending work on departure without creating an import or repeating an uncertain command. */
    suspend: () => {
      ++sequence;
      if (value.pending) publish({ ...value, pending: null });
    },
    first: () => request({ cursor: null, kind: 'first' }),
    next: () => {
      if (!current() || !value.visible?.page.next || value.failed) return Promise.resolve(value);
      return request({ cursor: value.visible.page.next, kind: 'next', previous: value.cursor });
    },
    previous: () => {
      if (!current() || !value.visible || value.previous === undefined || value.failed) return Promise.resolve(value);
      return request({ cursor: value.previous, kind: 'previous' });
    },
    restart: () => request({ cursor: null, kind: 'restart' }),
    refresh: () =>
      request({
        cursor: value.visible ? value.cursor : null,
        kind: value.visible ? 'refresh' : 'first',
        ...(value.visible && value.previous !== undefined ? { previous: value.previous } : {}),
      }),
    /** Reuse the exact failed native page descriptor, even if another page remains visible. */
    retry: () => (value.failed ? request(value.failed.intent) : Promise.resolve(value)),
  };
}

export type ImportLibraryBrowser = ReturnType<typeof createImportLibraryBrowser>;
