import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLibraryWorkspaceAdmission } from '../library-workspace-admission';
import type { VndbVisit } from '../personal-list-import/visit';
import type { ImportLibraryRead } from './read';
import { readImportLibrary } from './server';
import { ImportLibraryView } from './view';

type Reader = (visit: VndbVisit) => Promise<ImportLibraryRead>;
export const ImportLibraryReaderContext = createContext<Reader | null>(null);
const operations = ['library_entry.list'] as const;

/** Lifetime is the source/results episode, rather than a cached preview of an earlier import. */
export function CurrentImportLibrary({ visit }: { visit: VndbVisit }) {
  const supplied = useContext(ImportLibraryReaderContext);
  const { store, value } = useLibraryWorkspaceAdmission(operations);
  const admitted = value.allowed[0];
  const version = value.dispatch[0];
  const [result, setResult] = useState<ImportLibraryRead | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    ++generation.current;
    setResult(null);
    setBusy(false);
    return () => {
      ++generation.current;
    };
  }, [visit, admitted, version]);

  async function read() {
    if (busy || !visit.current() || !admitted) return;
    const ticket = ++generation.current;
    setResult(null);
    setBusy(true);
    let next: ImportLibraryRead;
    try {
      next = await (supplied
        ? supplied(visit)
        : readImportLibrary({
            data: { expectedReader: visit.subject, expectedCredential: visit.csrfToken },
          }));
    } catch {
      next = { state: 'unavailable' };
    }
    if (
      ticket !== generation.current ||
      !visit.current() ||
      !store.allowed('library_entry.list') ||
      store.dispatchVersion('library_entry.list') !== version
    )
      return;
    setResult(next);
    setBusy(false);
  }
  return (
    <ImportLibraryView
      result={admitted && visit.current() ? result : null}
      busy={busy}
      available={!!admitted}
      onRead={() => void read()}
    />
  );
}
