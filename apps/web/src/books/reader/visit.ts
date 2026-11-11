import type { HostedCatalogueApi, HostedFailure } from './native-api';
import { bookPublicationFromNative } from './native-mapper';
import type { HostedBookVisitInput } from './address';
import type { HostedBookViewer } from './native-read';
import type { NativeHostedBookAdmission } from './native-source';
import type { BookAddress, BookContentsAddress, BookSelection } from './source';

export type HostedBookVisit =
  | HostedFailure
  | Readonly<{
      state: 'ready';
      address: BookAddress;
      contentsReturn: BookContentsAddress | null;
      admission: Extract<NativeHostedBookAdmission, { state: 'current' }>;
    }>;

/**
 * The internal host trusts the prepared viewer and generated native observations. Route operands choose only
 * what to ask Content for; the current public release and every selected target still require native disclosure.
 */
export async function observeHostedBookVisit(
  api: HostedCatalogueApi,
  input: HostedBookVisitInput,
  viewer: HostedBookViewer,
  publicationTitle: string,
): Promise<HostedBookVisit> {
  const { catalogueId, search } = input;
  const current = await api.catalogue(catalogueId, { kind: 'publication' });
  if (current.state !== 'ready') return current;
  const currentPublication = bookPublicationFromNative(current.value);
  if (!currentPublication || currentPublication.id !== catalogueId) return { state: 'unavailable' };
  const frozen =
    search.release && search.release !== current.value.revisionId
      ? await api.catalogue(catalogueId, { kind: 'publication', revisionId: search.release })
      : current;
  if (frozen.state !== 'ready') return frozen;
  const publication = bookPublicationFromNative(frozen.value);
  if (
    !publication ||
    publication.id !== catalogueId ||
    (search.release && publication.releaseRevisionId !== search.release)
  )
    return { state: 'unavailable' };
  let selection: BookSelection | null = null;
  if (search.occurrence) {
    const resolved = await api.resolve(catalogueId, search.occurrence, {
      kind: 'publication',
      revisionId: frozen.value.revisionId,
    });
    if (resolved.state !== 'ready') return resolved;
    const row = resolved.value.occurrence;
    if (
      resolved.value.catalogueId !== catalogueId ||
      resolved.value.kind !== 'publication' ||
      resolved.value.revisionId !== frozen.value.revisionId ||
      resolved.value.sourceRevisionId !== frozen.value.sourceRevisionId ||
      row.occurrenceId !== search.occurrence
    )
      return { state: 'unavailable' };
    if (row.availability !== 'available') return { state: 'denied' };
    if (row.kind !== 'chapter') return { state: 'not-found' };
    selection = {
      occurrenceId: row.occurrenceId,
      body: {
        postId: row.target.postId,
        revisionId: row.target.revisionId,
        sha256: row.target.sha256,
      },
    };
  }
  const chapter = search.view === 'chapter' || (search.view === undefined && !!selection);
  if (chapter && !selection) return { state: 'not-found' };
  const contents: BookContentsAddress = {
    kind: 'contents',
    publication,
    selection,
    parentOccurrenceId: search.parent ?? null,
    cursor: search.cursor ?? null,
  };
  // Native disclosure selected the exact frozen target. The reader rechecks its current access on every read.
  const address: BookAddress = chapter && selection ? { kind: 'chapter', publication, selection } : contents;
  return {
    state: 'ready',
    address,
    contentsReturn: chapter
      ? {
          kind: 'contents',
          publication,
          selection,
          parentOccurrenceId: search.returnParent ?? null,
          cursor: search.returnCursor ?? null,
        }
      : null,
    admission: {
      state: 'current',
      publication,
      publicationTitle,
      viewer,
      currentReleaseRevisionId: current.value.revisionId,
      currentStructureRevisionId: currentPublication.structureRevisionId,
    },
  };
}
