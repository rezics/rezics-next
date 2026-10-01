import type { ReaderLibraryImportStore } from './reader-import.ts';
import { importDigest } from './file-store.ts';
import { mainCall } from './match.ts';
import type { CanonicalRow, LibraryFileFormat } from './formats/contract.ts';
import type { SessionState } from '../session/contract.ts';

export class ImportSessionFailed extends Error {}
type Desired = NonNullable<CanonicalRow['session']>;
export async function readSessionImportState<T>(store: ReaderLibraryImportStore, request: Request, path: string): Promise<T | null> {
  const response = await mainCall(store,request,'GET',path);
  if (response.status >= 500 || response.status === 202 || response.status === 429) return null;
  if (!response.ok) throw new ImportSessionFailed('Session owner read was refused');
  return response.json() as Promise<T>;
}
const sameDates = (a: SessionState,b: Desired) => a.state===b.state && a.startedOn===b.startedOn && a.finishedOn===b.finishedOn;
const sameAttempt = (a: SessionState, b: Desired) => sameDates(a,b)
  && (a.target.resource===b.target || a.target.work===b.target || a.selections.some(selection => selection.target.resource===b.target));

/** Exhaustive ordinary owner read: never decide that an attempt is missing
 * from a sampled first page. Import apply serializes by reader across files. */
export async function findImportSession(store: ReaderLibraryImportStore, request: Request, agent: string,
  source: CanonicalRow, format: LibraryFileFormat, desired: Desired): Promise<{ identity: string; session: SessionState | null; replay: boolean } | null> {
  const identity = importDigest([format,source.kind,source.sourceId,source.work ?? desired.target]);
  const bound = (await store.pool.query<{ session_id: string; desired_digest: string }>(`SELECT session_id,desired_digest FROM reader.library_import_session_effect
    WHERE agent=$1 AND source_identity=$2`,[agent,identity])).rows[0];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ actingSubject: agent,target: source.work ?? desired.target,limit: '20',...(cursor ? { cursor } : {}) });
    const response = await mainCall(store,request,'GET',`/v1/me/sessions?${query}`);
    if (response.status >= 500 || response.status === 202 || response.status === 429) return null;
    if (!response.ok) throw new ImportSessionFailed('Session owner read was refused');
    const page = await response.json() as { items: SessionState[]; nextCursor: string | null };
    const own = page.items.find(session => session.id === bound?.session_id || source.kind === 'session' && session.id === source.sourceId);
    if (own) return { identity,session: own,replay: bound?.desired_digest === importDigest(desired) };
    const candidates = page.items.filter(session => sameDates(session,desired) && session.target.work===source.work);
    for (const candidate of candidates) {
      // Portable files can contain two real attempts with identical dates.
      // Distinct native source IDs must preserve those actual attempts; a
      // previously restored attempt is already reserved for its source ID.
      const claimed = source.kind === 'session' && (await store.pool.query(`SELECT 1 FROM reader.library_import_session_effect
        WHERE agent=$1 AND session_id=$2 AND source_identity<>$3 LIMIT 1`,[agent,candidate.id,identity])).rowCount;
      if (!claimed) return { identity,session: candidate,replay: false };
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { identity,session: null,replay: false };
}

export async function bindImportSession(store: ReaderLibraryImportStore, agent: string, identity: string, session: SessionState, desired: Desired) {
  await store.pool.query(`INSERT INTO reader.library_import_session_effect(agent,source_identity,session_id,desired_digest)
    VALUES ($1,$2,$3,$4) ON CONFLICT (agent,source_identity) DO UPDATE SET session_id=EXCLUDED.session_id,desired_digest=EXCLUDED.desired_digest`,
  [agent,identity,session.id,importDigest(desired)]);
}

export const importSessionMatches = (session: SessionState,desired: Desired) => sameAttempt(session,desired)
  && desired.selections.every(wanted => session.selections.some(actual => actual.target.resource===wanted.target
    && actual.language===(wanted.language ?? null) && actual.format===(wanted.format ?? null)));
