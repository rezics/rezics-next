import type { HostedDiscoveryPage } from './discovery';
import type { HostedCatalogueApi, HostedFailure } from './native-api';
import { bookPublicationFromNative, bookSelectionFromNative } from './native-mapper';
import { nativeBookPreference } from './languages';
import { bookPreferenceFromSearch, type HostedBookVisitInput } from './address';
import type { HostedBookViewer } from './native-read';
import type { NativeHostedBookAdmission } from './native-source';
import type { BookAddress, BookContentsAddress, BookSelection } from './source';

export type HostedBookVisit =
  | HostedFailure
  | Readonly<{ state: 'catalogues'; page: HostedDiscoveryPage }>
  | Readonly<{
      state: 'ready';
      subjectId?: string;
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
  fallbackTitle: string,
): Promise<HostedBookVisit> {
  const { catalogueId, search } = input;
  const preference = bookPreferenceFromSearch(search);
  const preferenceAddress = preference ? { languagePreference: preference } : {};
  const current = await api.catalogue(catalogueId, { kind: 'publication', includeTitle: '1' });
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
    const resolved = await api.metadata(catalogueId, search.occurrence, {
      kind: 'publication',
      revisionId: frozen.value.revisionId,
      ...(search.bodyPost
        ? {
            ...(search.bodyLanguage ? { language: search.bodyLanguage } : {}),
            targetPostId: search.bodyPost,
            targetRevisionId: search.bodyRevision!,
            targetSha256: search.bodySha256!,
          }
        : nativeBookPreference(preference)),
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
    selection = bookSelectionFromNative(row);
    if (!selection) return { state: 'unavailable' };
    if (
      search.bodyPost &&
      (search.bodyPost !== selection.body.postId ||
        search.bodyRevision !== selection.body.revisionId ||
        search.bodySha256 !== selection.body.sha256 ||
        (search.bodyLanguage !== undefined && search.bodyLanguage !== selection.bodyLanguage))
    )
      return { state: 'changed' };
  }
  const chapter = search.view === 'chapter' || (search.view === undefined && !!selection);
  if (chapter && !selection) return { state: 'not-found' };
  const contents: BookContentsAddress = {
    kind: 'contents',
    publication,
    selection,
    ...preferenceAddress,
    parentOccurrenceId: search.parent ?? null,
    cursor: search.cursor ?? null,
  };
  // Native disclosure selected the exact frozen target. The reader rechecks its current access on every read.
  const address: BookAddress =
    chapter && selection ? { kind: 'chapter', publication, selection, ...preferenceAddress } : contents;
  return {
    state: 'ready',
    ...(search.subject ? { subjectId: search.subject } : {}),
    address,
    contentsReturn: chapter
      ? {
          kind: 'contents',
          publication,
          selection,
          ...preferenceAddress,
          parentOccurrenceId: search.returnParent ?? null,
          cursor: search.returnCursor ?? null,
        }
      : null,
    admission: {
      state: 'current',
      publication,
      publicationTitle: current.value.title || fallbackTitle,
      viewer,
      currentReleaseRevisionId: current.value.revisionId,
      currentStructureRevisionId: currentPublication.structureRevisionId,
    },
  };
}
