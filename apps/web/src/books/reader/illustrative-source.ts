import { fromMarkdown, serializeDocument } from '@rezics/document';
import type { HostedCatalogueApi, HostedOccurrence, HostedResolution, HostedRevision } from './native-api';
import { readHostedBook } from './native-mapper';
import type {
  BookChapterAddress,
  BookContentsAddress,
  BookReadResult,
  BookSourceObservation,
  HostedBookSource,
} from './source';

/** Illustrative native-format responses, never a production transport or native acceptance evidence. */
export const illustrativeBookIds = {
  catalogue: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  structure: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  release: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  part: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  nested: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
  first: '0192f3a0-6c1e-7b2a-9d4e-000000000006',
  reused: '0192f3a0-6c1e-7b2a-9d4e-000000000007',
  post: '0192f3a0-6c1e-7b2a-9d4e-000000000008',
  revision: '0192f3a0-6c1e-7b2a-9d4e-000000000009',
  thread: '0192f3a0-6c1e-7b2a-9d4e-00000000000a',
  author: '0192f3a0-6c1e-7b2a-9d4e-00000000000b',
  currentRelease: '0192f3a0-6c1e-7b2a-9d4e-00000000000c',
  currentStructure: '0192f3a0-6c1e-7b2a-9d4e-00000000000d',
} as const;
export type IllustrativeBookState = 'nested' | 'sparse' | 'failed-page' | 'moved' | 'unavailable-navigation';
export const illustrativeBookCursor = 'illustrative:opaque/+page=2';
export const illustrativePublication = {
  id: illustrativeBookIds.catalogue,
  structureRevisionId: illustrativeBookIds.structure,
  releaseRevisionId: illustrativeBookIds.release,
};

export function createIllustrativeHostedBook(state: IllustrativeBookState = 'nested') {
  const ids = illustrativeBookIds;
  const document = fromMarkdown(
    [
      '## At the observatory / 観測所',
      'The keeper opened the eastern shutters. 星を読む。 The same exact text is placed twice in this publication.',
      'A concealed detail: >!the lamp was already burning!<. The existing document renderer owns this disclosure.',
      '## The path home',
      'Read the [field notes](https://example.org/field-notes), then return to the selected occurrence in Contents.',
    ].join('\n\n'),
    'blocks',
  );
  const bytes = new TextEncoder().encode(serializeDocument(document));
  const body = crypto.subtle.digest('SHA-256', bytes).then((hash) => {
    const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { postId: ids.post, revisionId: ids.revision, sha256 };
  });
  const release: HostedRevision = {
    catalogueId: ids.catalogue,
    revisionId: ids.release,
    kind: 'publication',
    sourceRevisionId: ids.structure,
  };
  const current: HostedRevision =
    state === 'moved'
      ? { ...release, revisionId: ids.currentRelease, sourceRevisionId: ids.currentStructure }
      : release;
  let observation: BookSourceObservation = { state: 'current' };
  const listeners = new Set<() => void>();
  let failed = false;
  const part: HostedOccurrence = {
    occurrenceId: ids.part,
    parentId: null,
    position: 0,
    kind: 'part',
    availability: 'available',
    title: 'Part I · The journey',
    target: null,
  };
  const nested: HostedOccurrence = {
    occurrenceId: ids.nested,
    parentId: ids.part,
    position: 0,
    kind: 'part',
    availability: 'available',
    title: 'The observatory',
    target: null,
  };
  const ready = body.then((exact) => {
    const target = { ...exact, threadId: ids.thread };
    const first: HostedOccurrence = {
      occurrenceId: ids.first,
      parentId: ids.nested,
      position: 0,
      kind: 'chapter',
      availability: 'available',
      title: 'Dawn / 黎明',
      target,
    };
    const reused: HostedOccurrence = { ...first, occurrenceId: ids.reused, position: 1, title: 'Dawn, an echo / 再読' };
    const exactDocument: HostedResolution['document'] = {
      encoding: 'base64',
      canonicalBytes: btoa(String.fromCharCode(...bytes)),
      sha256: exact.sha256,
      authorId: ids.author,
      licence: 'CC-BY-4.0',
    };
    const api: HostedCatalogueApi = {
      async catalogue(_id, query) {
        return { state: 'ready', value: query.revisionId === ids.release ? release : current };
      },
      async children(_id, query) {
        if (query.cursor === illustrativeBookCursor && state === 'failed-page' && !failed) {
          failed = true;
          return { state: 'unavailable' };
        }
        const items =
          query.cursor === illustrativeBookCursor
            ? [reused]
            : query.parentId === ids.nested
              ? state === 'sparse' || state === 'failed-page'
                ? []
                : [first, reused]
              : query.parentId === ids.part
                ? [nested]
                : [part];
        const nextCursor =
          query.parentId === ids.nested && !query.cursor && (state === 'sparse' || state === 'failed-page')
            ? illustrativeBookCursor
            : null;
        return { state: 'ready', value: { ...release, items, nextCursor } };
      },
      async resolve(_id, occurrenceId, query) {
        const row = [part, nested, first, reused].find((item) => item.occurrenceId === occurrenceId);
        if (!row) return { state: 'not-found' };
        const revision = query.revisionId === ids.release ? release : current;
        const occurrence =
          state === 'moved' && revision === current && occurrenceId === ids.first
            ? { ...first, parentId: ids.part, position: 1 }
            : row;
        return {
          state: 'ready',
          value: { ...revision, occurrence, document: row.kind === 'chapter' ? exactDocument : null },
        };
      },
      async navigate(_id, occurrenceId, query) {
        if (state === 'unavailable-navigation' && query.direction === 'next') return { state: 'unavailable' };
        const items =
          occurrenceId === ids.first && query.direction === 'next'
            ? [reused]
            : occurrenceId === ids.reused && query.direction === 'previous'
              ? [first]
              : [];
        return { state: 'ready', value: { ...release, items, nextCursor: null } };
      },
    };
    return { api, first, reused, exactDocument, exact };
  });
  const source: HostedBookSource = {
    getSnapshot: () => observation,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async read(request, signal): Promise<BookReadResult> {
      const ownObservation = observation;
      const { api } = await ready;
      return readHostedBook(
        api,
        request,
        'The keeper of the eastern sky',
        signal,
        () => observation === ownObservation && observation.state === 'current',
      );
    },
  };
  const contents = (parentOccurrenceId: string | null = null, cursor: string | null = null): BookContentsAddress => ({
    kind: 'contents',
    publication: illustrativePublication,
    parentOccurrenceId,
    cursor,
    selection: null,
  });
  return {
    source,
    ready,
    contents,
    async chapter(reused = false): Promise<BookChapterAddress> {
      return {
        kind: 'chapter',
        publication: illustrativePublication,
        selection: { occurrenceId: reused ? ids.reused : ids.first, body: await body },
      };
    },
    replace(state: BookSourceObservation['state'] = 'current') {
      observation = { state };
      for (const listener of [...listeners]) listener();
    },
  };
}
