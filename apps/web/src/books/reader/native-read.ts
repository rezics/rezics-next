import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { hasKernelOrigin, kernelClient } from '../../kernel/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { recordPageReadCacheControl } from '../../security/page-cache';
import type { SessionEnv } from '../../session/client';
import { carriesSession } from '../../session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { createHostedCatalogueApi, hostedId } from './native-api';
import { nativeBookRequestWithinBounds, readHostedBook } from './native-mapper';
import {
  BOOK_ANCESTOR_LIMIT, BOOK_CONTENTS_LIMIT,
  type BookChapterPage, type BookContentsPage, type BookDocument, type BookReadRequest, type BookReadResult,
} from './source';

const selection = v.strictObject({ occurrenceId: hostedId, body: v.strictObject({
  postId: hostedId, revisionId: hostedId, sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
}) });
const publication = v.strictObject({ id: hostedId, structureRevisionId: hostedId, releaseRevisionId: hostedId });
const request = v.strictObject({
  address: v.variant('kind', [
    v.strictObject({ kind: v.literal('chapter'), publication, selection }),
    v.strictObject({ kind: v.literal('contents'), publication, selection: v.nullable(selection),
      parentOccurrenceId: v.nullable(hostedId),
      cursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
    }),
  ]),
  locale: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  limit: v.literal(BOOK_CONTENTS_LIMIT), ancestorLimit: v.literal(BOOK_ANCESTOR_LIMIT),
});
const viewer = v.variant('kind', [
  v.strictObject({ kind: v.literal('anonymous') }),
  v.strictObject({ kind: v.literal('session'), subject: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)) }),
]);
export type HostedBookViewer = v.InferOutput<typeof viewer>;
const input = v.strictObject({ request, viewer,
  publicationTitle: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  currentReleaseRevisionId: hostedId, currentStructureRevisionId: hostedId,
});
type HostedBookReadInput = {
  request: BookReadRequest;
  viewer: HostedBookViewer;
  publicationTitle: string;
  currentReleaseRevisionId: string;
  currentStructureRevisionId: string;
};
/** Renderer callbacks stay in the mounted reader; only the exact document crosses the BFF boundary. */
type HostedBookWireResult = Exclude<BookReadResult, { state: 'ready' }> | {
  state: 'ready';
  page: BookContentsPage | (Omit<BookChapterPage, 'body'> & { body: Pick<BookDocument, 'document'> });
};

/** A private BFF observation. Expected browser identity can only narrow the actually prepared viewer. */
export const readNativeHostedBook = createServerFn({ method: 'GET' })
  .validator((value: unknown): HostedBookReadInput => v.parse(input, value))
  .handler(async ({ data }): Promise<HostedBookWireResult> => {
    const incoming = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(incoming, 'private, no-store');
    try {
      if (!nativeBookRequestWithinBounds(data.request)) return { state: 'unavailable' };
      if (await prepareSession(incoming, env as Partial<SessionEnv>)) return { state: 'denied' };
      const authorization = viewerCredential(incoming);
      const subject = sessionSubject(incoming);
      if (carriesSession(incoming) && !authorization) return { state: 'unavailable' };
      if (data.viewer.kind === 'session') {
        if (!authorization || subject !== data.viewer.subject) return { state: 'denied' };
      } else if (authorization || subject !== undefined) return { state: 'denied' };
      // Hosted reading never enters kernelClient's development fixture transport.
      if (!hasKernelOrigin()) return { state: 'unavailable' };
      const client = kernelClient(data.request.locale, authorization ?? undefined);
      const result = await readHostedBook(createHostedCatalogueApi(client, authorization, incoming.signal),
        data.request, data.publicationTitle, incoming.signal, () => !incoming.signal.aborted, {
          releaseRevisionId: data.currentReleaseRevisionId, structureRevisionId: data.currentStructureRevisionId,
        });
      if (result.state === 'ready' && (result.page.currentReleaseRevisionId !== data.currentReleaseRevisionId ||
        result.page.currentStructureRevisionId !== data.currentStructureRevisionId)) return { state: 'changed' };
      if (result.state === 'ready') {
        if (result.page.kind === 'chapter') return {
          state: 'ready', page: { ...result.page, body: { document: result.page.body.document } },
        };
        return { state: 'ready', page: result.page };
      }
      return result;
    } catch (error) {
      return { state: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
    }
  });
