import { nativeBookPreference, nativeBookSelection, type BookLanguagePreference } from './languages';
import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import {
  BOOK_ANCESTOR_LIMIT,
  BOOK_CONTENTS_LIMIT,
  bookAddressWithinBounds,
  bookPageMatches,
  sameSelection,
  type BookAncestor,
  type BookChapterAddress,
  type BookContentsAddress,
  type BookContentsPage,
  type BookNavigation,
  type BookOccurrence,
  type BookPublication,
  type BookReadRequest,
  type BookReadResult,
  type BookSelection,
} from './source';
import type {
  HostedCatalogueApi,
  HostedFailure,
  HostedMetadata,
  HostedOccurrence,
  HostedPage,
  HostedQuery,
  HostedRead,
  HostedResolution,
  HostedRevision,
} from './native-api';

export const HOSTED_BOOK_PAGE_LIMIT = 20;
export const HOSTED_BOOK_CURSOR_LIMIT = 4096;

/** Publication revision IDs are release selectors, never substitutes for source structure IDs. */
export function bookPublicationFromNative(revision: HostedRevision): BookPublication | null {
  return revision.kind === 'publication' && revision.sourceRevisionId !== null
    ? {
        id: revision.catalogueId,
        releaseRevisionId: revision.revisionId,
        structureRevisionId: revision.sourceRevisionId,
      }
    : null;
}

export function nativeBookRequestWithinBounds(request: BookReadRequest): boolean {
  const address = request.address;
  return (
    bookAddressWithinBounds(address) &&
    !!address.publication.releaseRevisionId &&
    request.limit === BOOK_CONTENTS_LIMIT &&
    request.ancestorLimit === BOOK_ANCESTOR_LIMIT &&
    request.locale.length > 0 &&
    request.locale.length <= 64 &&
    (address.kind !== 'contents' || address.cursor === null || address.cursor.length <= HOSTED_BOOK_CURSOR_LIMIT)
  );
}

class FailedRead extends Error {
  constructor(readonly result: HostedFailure) {
    super(result.state);
  }
}
function requireValue<T>(result: HostedRead<T>): T {
  if (result.state !== 'ready') throw new FailedRead(result);
  return result.value;
}
function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new FailedRead({ state: 'unavailable' });
}
function sameRevision(a: HostedRevision, b: HostedRevision) {
  return (
    a.catalogueId === b.catalogueId &&
    a.revisionId === b.revisionId &&
    a.kind === b.kind &&
    a.sourceRevisionId === b.sourceRevisionId
  );
}
export function bookSelectionFromNative(row: HostedOccurrence): BookSelection | null {
  return row.availability === 'available' && row.kind === 'chapter'
    ? {
        occurrenceId: row.occurrenceId,
        ...(row.selectedLanguage ? { bodyLanguage: row.selectedLanguage } : {}),
        body: {
          postId: row.target.postId,
          revisionId: row.target.revisionId,
          sha256: row.target.sha256,
        },
      }
    : null;
}
function contents(
  publication: BookPublication,
  parentOccurrenceId: string | null,
  selection: BookSelection | null,
  languagePreference?: BookLanguagePreference,
): BookContentsAddress {
  return {
    kind: 'contents',
    publication,
    parentOccurrenceId,
    selection,
    cursor: null,
    ...(languagePreference ? { languagePreference } : {}),
  };
}
function chapter(
  publication: BookPublication,
  selection: BookSelection,
  languagePreference?: BookLanguagePreference,
): BookChapterAddress {
  return { kind: 'chapter', publication, selection, ...(languagePreference ? { languagePreference } : {}) };
}

/** Preserve unavailable slots without supplying a title or a target that Content withheld. */
export function mapHostedBookOccurrence(
  row: HostedOccurrence,
  publication: BookPublication,
  selected: BookSelection | null,
  languagePreference?: BookLanguagePreference,
): BookOccurrence {
  const base = { occurrenceId: row.occurrenceId, parentOccurrenceId: row.parentId };
  if (row.availability === 'unavailable') return { ...base, kind: 'unavailable', title: '' };
  if (row.kind === 'part')
    return {
      ...base,
      title: row.title,
      kind: 'container',
      contents: contents(publication, row.occurrenceId, selected, languagePreference),
    };
  const selection = bookSelectionFromNative(row);
  requireCondition(selection);
  return { ...base, title: row.title, kind: 'chapter', chapter: chapter(publication, selection, languagePreference) };
}

/** A single nearest slot. An inaccessible slot never becomes a skip or a known publication end. */
export function mapHostedBookNavigation(
  page: HostedPage,
  publication: BookPublication,
  occurrenceId: string,
  languagePreference?: BookLanguagePreference,
): BookNavigation {
  requireCondition(page.items.length <= 1);
  const row = page.items[0];
  if (!row) return { state: page.nextCursor === null ? 'end' : 'unavailable' };
  requireCondition(row.kind === 'chapter' && row.occurrenceId !== occurrenceId);
  const selection = bookSelectionFromNative(row);
  return selection && row.availability === 'available'
    ? { state: 'available', title: row.title, address: chapter(publication, selection, languagePreference) }
    : { state: 'unavailable' };
}

/** Decode only the exact, admitted canonical bytes. No current Post head or JSON reserialization fallback. */
export async function decodeHostedBookDocument(
  resolution: HostedResolution,
  selection: BookSelection,
): Promise<DocumentSnapshot | null> {
  const body = resolution.document;
  if (
    !body ||
    ('selectedLanguage' in resolution && resolution.selectedLanguage !== (selection.bodyLanguage ?? null)) ||
    body.encoding !== 'base64' ||
    body.sha256 !== selection.body.sha256 ||
    !sameSelection(bookSelectionFromNative(resolution.occurrence), selection) ||
    body.canonicalBytes.length > Math.ceil(2097152 / 3) * 4
  )
    return null;
  try {
    const binary = atob(body.canonicalBytes);
    if (binary.length > 2097152 || btoa(binary) !== body.canonicalBytes) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== selection.body.sha256) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(text);
    return checkDocument(document) ? document : null;
  } catch {
    return null;
  }
}

/**
 * One bounded reader observation over admitted native reads. No descendant expansion, row hydration,
 * neighbour search, refill or body/head substitution. The host owns the title and admission lifetime.
 */
export async function readHostedBook(
  api: HostedCatalogueApi,
  request: BookReadRequest,
  publicationTitle: string,
  signal: AbortSignal,
  current: () => boolean = () => true,
  expectedCurrent?: Readonly<{ releaseRevisionId: string; structureRevisionId: string }>,
): Promise<BookReadResult> {
  try {
    requireCondition(
      nativeBookRequestWithinBounds(request) && publicationTitle.length > 0 && publicationTitle.length <= 256,
    );
    const address = request.address;
    const publication = address.publication;
    const selectedQuery = { kind: 'publication', revisionId: publication.releaseRevisionId! } as const;
    const live = () => {
      signal.throwIfAborted();
      requireCondition(current());
    };
    async function read<T>(operation: () => Promise<HostedRead<T>>) {
      live();
      const value = requireValue(await operation());
      live();
      return value;
    }
    const frozen = await read(() => api.catalogue(publication.id, selectedQuery));
    requireCondition(
      frozen.kind === 'publication' &&
        frozen.catalogueId === publication.id &&
        frozen.revisionId === publication.releaseRevisionId &&
        frozen.sourceRevisionId === publication.structureRevisionId,
    );
    const now = await read(() => api.catalogue(publication.id, { kind: 'publication' }));
    requireCondition(now.kind === 'publication' && now.catalogueId === publication.id && now.sourceRevisionId !== null);
    if (
      expectedCurrent &&
      (now.revisionId !== expectedCurrent.releaseRevisionId ||
        now.sourceRevisionId !== expectedCurrent.structureRevisionId)
    )
      return { state: 'changed' };
    const currentQuery = { kind: 'publication', revisionId: now.revisionId } as const;
    // Metadata and body observations use the same occurrence identity and release authority fence.
    async function occurrence<T extends HostedMetadata>(
      occurrenceId: string,
      revision: HostedRevision,
      operation: () => Promise<HostedRead<T>>,
    ): Promise<T> {
      const value = await read(operation);
      requireCondition(sameRevision(value, revision) && value.occurrence.occurrenceId === occurrenceId);
      return value;
    }
    async function metadata(occurrenceId: string, revision: HostedRevision, query: HostedQuery) {
      return occurrence(occurrenceId, revision, () => api.metadata(publication.id, occurrenceId, query));
    }
    async function ancestors(
      parentId: string | null,
      revision: HostedRevision = now,
      query: HostedQuery = currentQuery,
    ): Promise<BookAncestor[]> {
      const path: BookAncestor[] = [];
      const seen = new Set<string>();
      while (parentId !== null) {
        requireCondition(path.length < request.ancestorLimit && !seen.has(parentId));
        seen.add(parentId);
        const value = await metadata(parentId, revision, query);
        const row = value.occurrence;
        requireCondition(row.availability === 'available' && row.kind === 'part');
        path.push({
          occurrenceId: row.occurrenceId,
          title: row.title,
          contents: contents(publication, row.occurrenceId, address.selection, address.languagePreference),
        });
        parentId = row.parentId;
      }
      return path.reverse();
    }
    async function selectedOccurrence(selection: BookSelection, exact: HostedMetadata) {
      requireCondition(sameSelection(bookSelectionFromNative(exact.occurrence), selection));
      const currentOccurrence = sameRevision(now, frozen)
        ? exact
        : await metadata(selection.occurrenceId, now, {
            ...currentQuery,
            ...(selection.bodyLanguage ? { language: selection.bodyLanguage } : {}),
          });
      requireCondition(
        currentOccurrence.occurrence.kind === 'chapter' && currentOccurrence.occurrence.availability === 'available',
      );
      return currentOccurrence.occurrence;
    }
    let result: BookReadResult;
    if (address.kind === 'chapter') {
      const selection = address.selection;
      const exact = await occurrence(selection.occurrenceId, frozen, () =>
        api.body
          ? api.body(publication.id, selection.occurrenceId, { ...selectedQuery, ...nativeBookSelection(selection) })
          : api.resolve(publication.id, selection.occurrenceId, selectedQuery),
      );
      const document = await decodeHostedBookDocument(exact, selection);
      live();
      requireCondition(document && exact.occurrence.availability === 'available');
      let row = exact.occurrence;
      let currentLocationUnavailable = false;
      try {
        row = await selectedOccurrence(selection, exact);
      } catch (error) {
        if (!(error instanceof FailedRead) || error.result.state === 'changed') throw error;
        // Frozen bytes already passed their own current target gate. Current placement is independent context.
        currentLocationUnavailable = true;
      }
      requireCondition(row.availability === 'available');
      const path = currentLocationUnavailable
        ? await ancestors(row.parentId, frozen, selectedQuery)
        : await ancestors(row.parentId);
      async function navigation(direction: 'previous' | 'next'): Promise<BookNavigation> {
        try {
          const response = await read(() =>
            api.navigate(publication.id, selection.occurrenceId, {
              ...selectedQuery,
              ...nativeBookPreference(address.languagePreference),
              direction,
              limit: '1',
            }),
          );
          requireCondition(sameRevision(response, frozen));
          return mapHostedBookNavigation(response, publication, selection.occurrenceId, address.languagePreference);
        } catch (error) {
          if (!(error instanceof FailedRead) || error.result.state === 'denied' || error.result.state === 'changed')
            throw error;
          return { state: 'unavailable' };
        }
      }
      const previous = await navigation('previous');
      const next = await navigation('next');
      requireCondition(
        previous.state !== 'available' ||
          next.state !== 'available' ||
          previous.address.selection.occurrenceId !== next.address.selection.occurrenceId,
      );
      result = {
        state: 'ready',
        page: {
          kind: 'chapter',
          address,
          publicationTitle,
          currentStructureRevisionId: now.sourceRevisionId!,
          currentReleaseRevisionId: now.revisionId,
          title: exact.occurrence.availability === 'available' ? exact.occurrence.title : row.title,
          ancestors: path,
          language: selection.bodyLanguage ?? null,
          ...(currentLocationUnavailable ? { currentLocationUnavailable: true as const } : {}),
          direction: 'auto',
          body: { document },
          contents: contents(publication, row.parentId, address.selection, address.languagePreference),
          previous,
          next,
        },
      };
    } else {
      const response = await read(() =>
        api.children(publication.id, {
          ...selectedQuery,
          ...nativeBookPreference(address.languagePreference),
          limit: String(HOSTED_BOOK_PAGE_LIMIT),
          ...(address.parentOccurrenceId === null ? {} : { parentId: address.parentOccurrenceId }),
          ...(address.cursor === null ? {} : { cursor: address.cursor }),
        }),
      );
      requireCondition(sameRevision(response, frozen) && response.items.length <= HOSTED_BOOK_PAGE_LIMIT);
      requireCondition(response.items.every((row) => row.parentId === address.parentOccurrenceId));
      requireCondition(new Set(response.items.map((row) => row.occurrenceId)).size === response.items.length);
      requireCondition(
        response.items.every((row, index) => index === 0 || row.position > response.items[index - 1]!.position),
      );
      let title = publicationTitle;
      let parentId: string | null = null;
      if (address.parentOccurrenceId !== null) {
        const parent = await metadata(address.parentOccurrenceId, now, currentQuery);
        requireCondition(parent.occurrence.availability === 'available' && parent.occurrence.kind === 'part');
        title = parent.occurrence.title;
        parentId = parent.occurrence.parentId;
      }
      const path = await ancestors(parentId);
      const rows = response.items.map((row) =>
        mapHostedBookOccurrence(row, publication, address.selection, address.languagePreference),
      );
      let selected: BookContentsPage['selected'] = null;
      if (address.selection !== null) {
        try {
          const exact = await metadata(address.selection.occurrenceId, frozen, {
            ...selectedQuery,
            ...nativeBookSelection(address.selection),
          });
          const row = await selectedOccurrence(address.selection, exact);
          requireCondition(row.availability === 'available');
          selected = {
            state:
              row.parentId === address.parentOccurrenceId &&
              rows.some((item) => 'chapter' in item && sameSelection(item.chapter.selection, address.selection))
                ? 'here'
                : 'moved',
            chapter: chapter(publication, address.selection, address.languagePreference),
            contents: contents(publication, row.parentId, address.selection, address.languagePreference),
          };
        } catch (error) {
          if (!(error instanceof FailedRead) || error.result.state === 'denied' || error.result.state === 'changed')
            throw error;
          selected = { state: 'unavailable' };
        }
      }
      requireCondition(
        response.nextCursor === null ||
          (response.nextCursor.length > 0 &&
            response.nextCursor.length <= HOSTED_BOOK_CURSOR_LIMIT &&
            response.nextCursor !== address.cursor),
      );
      result = {
        state: 'ready',
        page: {
          kind: 'contents',
          address,
          publicationTitle,
          currentStructureRevisionId: now.sourceRevisionId!,
          currentReleaseRevisionId: now.revisionId,
          title,
          ancestors: path,
          rows,
          selected,
          continuation:
            response.nextCursor === null ? { state: 'end' } : { state: 'more', cursor: response.nextCursor },
        },
      };
    }
    // Each operation carries native admission. Reobserve both release access and current context before disclosure.
    const retained = await read(() => api.catalogue(publication.id, selectedQuery));
    if (!sameRevision(retained, frozen)) return { state: 'changed' };
    const latest = await read(() => api.catalogue(publication.id, { kind: 'publication' }));
    if (!sameRevision(latest, now)) return { state: 'changed' };
    live();
    return result.state === 'ready' && bookPageMatches(request, result.page) ? result : { state: 'unavailable' };
  } catch (error) {
    return error instanceof FailedRead ? error.result : { state: 'unavailable' };
  }
}
