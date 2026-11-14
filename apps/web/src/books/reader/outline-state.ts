import type { BookContentsAddress, BookContentsPage, BookOccurrence, BookReadResult } from './source';

export type BookOutlineBranch = Readonly<{
  address: BookContentsAddress;
  expanded: boolean;
  rows: readonly BookOccurrence[];
  page: BookContentsPage | null;
  state: 'idle' | 'loading' | BookReadResult['state'];
  /** The exact failed/in-flight operands, including their original selection. */
  attempt: BookContentsAddress | null;
}>;

/** Only explicitly opened branches and rows. Bodies and inferred descendants never enter this store. */
export function createBookOutline() {
  const branches = new Map<string | null, BookOutlineBranch>();
  const identities = new Map<string, Set<string>>();
  const origins = new Map<string, BookContentsAddress>();
  const listeners = new Set<() => void>();
  let snapshot = { root: null as string | null, opened: false, version: 0 };
  const key = (parent: string | null) => JSON.stringify(parent);
  const emit = () => {
    snapshot = { ...snapshot, version: snapshot.version + 1 };
    for (const listener of [...listeners]) listener();
  };
  const update = (parent: string | null, value: BookOutlineBranch) => {
    branches.set(parent, value);
    emit();
  };
  const ensure = (address: BookContentsAddress): BookOutlineBranch =>
    branches.get(address.parentOccurrenceId) ?? {
      address,
      expanded: true,
      rows: [],
      page: null,
      state: 'idle',
      attempt: null,
    };
  return {
    getSnapshot: () => snapshot,
    branch: (parent: string | null) => branches.get(parent),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    root(address: BookContentsAddress) {
      const parent = address.parentOccurrenceId;
      const root = !snapshot.opened || parent === null || !origins.has(parent) ? parent : snapshot.root;
      snapshot = { ...snapshot, root, opened: true };
      emit();
    },
    expand(address: BookContentsAddress) {
      const branch = ensure(address);
      update(address.parentOccurrenceId, { ...branch, expanded: true });
      return branch;
    },
    collapse(parent: string | null) {
      const branch = branches.get(parent);
      if (branch) update(parent, { ...branch, expanded: false });
    },
    begin(address: BookContentsAddress) {
      const branch = ensure(address);
      update(address.parentOccurrenceId, { ...branch, state: 'loading', attempt: address });
    },
    accept(page: BookContentsPage) {
      const parent = page.address.parentOccurrenceId;
      const branch = ensure(page.address);
      const seen = identities.get(key(parent)) ?? new Set<string>();
      const added: BookOccurrence[] = [];
      for (const row of page.rows) {
        if (seen.has(row.occurrenceId)) continue;
        seen.add(row.occurrenceId);
        origins.set(row.occurrenceId, page.address);
        added.push(row);
      }
      identities.set(key(parent), seen);
      // Keep the first revealed order. A repeated/sparse page can advance only its native continuation.
      update(parent, {
        ...branch,
        address: page.address,
        rows: added.length ? [...branch.rows, ...added] : branch.rows,
        page,
        state: 'ready',
        attempt: null,
      });
    },
    fail(address: BookContentsAddress, state: Exclude<BookReadResult['state'], 'ready'>) {
      update(address.parentOccurrenceId, { ...ensure(address), state, attempt: address });
    },
    cancel(address: BookContentsAddress) {
      const branch = branches.get(address.parentOccurrenceId);
      if (branch?.state === 'loading' && branch.attempt === address)
        update(address.parentOccurrenceId, { ...branch, state: branch.page ? 'ready' : 'idle', attempt: address });
    },
    origin(occurrenceId: string) {
      return origins.get(occurrenceId) ?? null;
    },
    retire() {
      branches.clear();
      identities.clear();
      origins.clear();
      snapshot = { root: null, opened: false, version: snapshot.version + 1 };
      for (const listener of [...listeners]) listener();
    },
  };
}
export type BookOutline = ReturnType<typeof createBookOutline>;
