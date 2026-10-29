import { useCallback, useEffect, useState } from 'react';
import { csrfHeaders } from '../threads/composer';
import { deletePersonalLibraryEntry, savePersonalLibraryEntry } from './entries-actions';
import { libraryEntryStateWrite, type PersonalLibraryEntry } from './entries-read';

export type ShelfFailure = 'closed' | 'unavailable' | 'signed-out';
/** One entry as the shelf holds it: what the kernel last said, and what happened to the last write. */
export type ShelfRow = { entry: PersonalLibraryEntry; conflict: boolean; failure: ShelfFailure | null };

function failureOf(reason: string): ShelfFailure {
  return reason === 'closed' || reason === 'signed-out' ? reason : 'unavailable';
}

/** True once the page has hydrated; writes need JavaScript, so their controls stay disabled until then. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * The entries of one shelf, with the writes that change them. A status change keeps the entry where it is and shows
 * its new status; a conflict replaces it with the entry as it now is; a removal drops it. Each write carries the
 * revision, incarnation and idempotency key the entry holds, and takes a fresh key once it has been answered.
 */
export function useShelfRows(initial: PersonalLibraryEntry[]) {
  const [rows, setRows] = useState<ShelfRow[]>(() =>
    initial.map((entry) => ({ entry, conflict: false, failure: null })),
  );
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const patch = useCallback(
    (subjectId: string, change: (row: ShelfRow) => ShelfRow | null) =>
      setRows((current) =>
        current.flatMap((row) => {
          if (row.entry.subjectId !== subjectId) return [row];
          const next = change(row);
          return next ? [next] : [];
        }),
      ),
    [],
  );

  const changeState = useCallback(
    async (subjectId: string, value: string) => {
      const row = rows.find((item) => item.entry.subjectId === subjectId);
      const state = libraryEntryStateWrite(value);
      if (!row || !state || state === row.entry.state || pending) return;
      setPending(true);
      try {
        const { entry } = row;
        const result = await savePersonalLibraryEntry({
          data: {
            subjectId,
            state,
            revision: entry.revision,
            ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
            idempotencyKey: entry.changeKey,
          },
          headers: csrfHeaders(),
        });
        if (result.ok && result.entry) {
          const saved = result.entry;
          patch(subjectId, (current) => ({
            entry: {
              ...current.entry,
              state: saved.state,
              revision: saved.revision,
              ...(saved.incarnationId === undefined ? {} : { incarnationId: saved.incarnationId }),
              updatedAt: saved.updatedAt,
              changeKey: crypto.randomUUID(),
            },
            conflict: false,
            failure: null,
          }));
        } else if (!result.ok && result.reason === 'conflict') {
          patch(subjectId, (current) => ({
            entry: { ...current.entry, ...result.entry, changeKey: crypto.randomUUID() },
            conflict: true,
            failure: null,
          }));
        } else if (!result.ok && result.reason === 'missing') {
          patch(subjectId, () => null);
        } else if (!result.ok) {
          patch(subjectId, (current) => ({ ...current, failure: failureOf(result.reason) }));
        }
      } catch {
        patch(subjectId, (current) => ({ ...current, failure: 'unavailable' }));
      } finally {
        setPending(false);
      }
    },
    [rows, pending, patch],
  );

  const remove = useCallback(async () => {
    const subjectId = removing;
    const row = rows.find((item) => item.entry.subjectId === subjectId);
    if (!subjectId || !row || pending) return;
    setPending(true);
    try {
      const { entry } = row;
      const result = await deletePersonalLibraryEntry({
        data: {
          subjectId,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
          idempotencyKey: entry.removeKey,
        },
        headers: csrfHeaders(),
      });
      if (result.ok || result.reason === 'missing') {
        patch(subjectId, () => null);
      } else if (result.reason === 'conflict') {
        patch(subjectId, (current) => ({
          entry: { ...current.entry, ...result.entry, removeKey: crypto.randomUUID() },
          conflict: true,
          failure: null,
        }));
      } else {
        patch(subjectId, (current) => ({ ...current, failure: failureOf(result.reason) }));
      }
    } catch {
      patch(subjectId, (current) => ({ ...current, failure: 'unavailable' }));
    } finally {
      setPending(false);
      setRemoving(null);
    }
  }, [removing, rows, pending, patch]);

  return {
    rows,
    pending,
    removing,
    askRemove: setRemoving,
    cancelRemove: () => setRemoving(null),
    changeState,
    remove,
  };
}
