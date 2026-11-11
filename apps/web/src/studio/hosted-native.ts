import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioFailure, StudioResult } from './contract';
import { bookTocRows } from './book-toc';
import {
  hostedCommand, hostedCreate, hostedId, hostedKey, hostedPage, hostedPublish, hostedRevise,
  hostedRevision, hostedSelection,
  type HostedBook, type HostedBookNative, type HostedCreate, type HostedPlacement,
  type HostedPublish, type HostedRevise, type HostedSelection,
} from './hosted-contract';
import { hostedBookStructure } from './hosted-structure';

type Response = { status: number; data?: unknown; error?: unknown };
type Options = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  fetch: { signal: AbortSignal; cache: 'no-store'; redirect: 'manual' };
};
type Read = { get(options: Options): Promise<Response> };
type Write<T> = { post(body: T, options: Options): Promise<Response> };
// The runtime proxy already supports these paths. This adds no generated client or invented operation.
type HostedClient = {
  hostedCatalogues: Write<HostedCreate> & ((params: { id: string }) => Read & {
    children: Read; $revise: Write<HostedRevise>; $publish: Write<HostedPublish>;
  });
};
export const hostedFailure = (kind: StudioFailure['kind'], message: string): StudioResult<never> =>
  ({ ok: false, error: { kind, message } });
const unavailable = () => hostedFailure('unavailable', 'The complete book structure could not be read. Try again.');
const uncertain = () => hostedFailure('uncertain', 'The book command may have committed. Retry the same operation to recover its result.');

function failure(status: number, mutation: boolean): StudioResult<never> {
  if (status === 401 || status === 403) return hostedFailure('denied', 'Your current session cannot perform this book action.');
  if (status === 404) return hostedFailure('unavailable', 'This book or one of its exact chapter versions is unavailable.');
  if (status === 412) return hostedFailure('stale', 'The structure or publication changed. Reload before preparing another operation.');
  if (status === 400 || status === 413 || status === 422)
    return hostedFailure('invalid', 'The book command was rejected. Check the structure, selected versions, and operation key.');
  return mutation ? uncertain() : unavailable();
}

/** Uses the existing credential-bearing client and its read-your-writes session-token handling. */
export function createHostedBookNative(client: KernelClient): HostedBookNative {
  const native = client as unknown as HostedClient;
  const options = (signal: AbortSignal, query?: Record<string, string>, key?: string): Options => ({
    fetch: { signal, cache: 'no-store', redirect: 'manual' },
    ...(query ? { query } : {}),
    ...(key ? { headers: { 'idempotency-key': JSON.stringify(key) } } : {}),
  });
  async function read(input: HostedSelection, signal: AbortSignal): Promise<StudioResult<HostedBook>> {
    try {
      const selection = v.parse(hostedSelection, input);
      if (signal.aborted) return unavailable();
      const resource = native.hostedCatalogues({ id: selection.catalogueId });
      const query = { kind: selection.kind, ...(selection.revisionId ? { revisionId: selection.revisionId } : {}) };
      const response = await resource.get(options(signal, query));
      if (response.error || response.status !== 200) return failure(response.status, false);
      const revision = v.parse(hostedRevision, response.data);
      if (revision.catalogueId !== selection.catalogueId || revision.kind !== selection.kind ||
          (selection.revisionId && revision.revisionId !== selection.revisionId) ||
          (revision.kind === 'structure' ? revision.sourceRevisionId !== null : revision.sourceRevisionId === null))
        return unavailable();
      const placements: HostedPlacement[] = [];
      const parents: { id: string | null; depth: number }[] = [{ id: null, depth: 1 }];
      const ids = new Set<string>();
      for (let index = 0; index < parents.length; index++) {
        const parent = parents[index]!;
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let position = 0;
        do {
          if (signal.aborted) return unavailable();
          const pageResponse = await resource.children.get(options(signal, {
            kind: revision.kind, revisionId: revision.revisionId, limit: '20',
            ...(parent.id ? { parentId: parent.id } : {}), ...(cursor ? { cursor } : {}),
          }));
          if (pageResponse.error || pageResponse.status !== 200) return failure(pageResponse.status, false);
          const page = v.parse(hostedPage, pageResponse.data);
          if (page.catalogueId !== revision.catalogueId || page.revisionId !== revision.revisionId ||
              page.kind !== revision.kind || page.sourceRevisionId !== revision.sourceRevisionId) return unavailable();
          for (const item of page.items) {
            if (item.availability !== 'available')
              return hostedFailure('unavailable', 'A chapter is unavailable. The incomplete table of contents cannot be rewritten.');
            if (parent.depth > 16 || item.parentId !== parent.id || item.position !== position++ ||
                ids.has(item.occurrenceId) || placements.length >= 512) return unavailable();
            ids.add(item.occurrenceId);
            const address = { occurrenceId: item.occurrenceId, parentId: item.parentId, position: item.position, title: item.title };
            if (item.kind === 'chapter') placements.push({ ...address, kind: 'chapter', target: item.target });
            else {
              placements.push({ ...address, kind: 'part' });
              parents.push({ id: item.occurrenceId, depth: parent.depth + 1 });
            }
          }
          cursor = page.nextCursor;
          if (cursor) {
            if (!page.items.length || cursors.has(cursor)) return unavailable();
            cursors.add(cursor);
          }
        } while (cursor);
      }
      if (signal.aborted) return unavailable();
      const book = { revision, placements };
      bookTocRows(hostedBookStructure(book));
      return { ok: true, value: book };
    } catch { return unavailable(); }
  }
  async function command(catalogueId: string, kind: HostedSelection['kind'], sourceRevisionId: string | null,
    signal: AbortSignal, send: () => Promise<Response>): Promise<StudioResult<HostedBook>> {
    if (signal.aborted) return unavailable();
    try {
      const response = await send();
      if (response.error || (response.status !== 200 && response.status !== 201)) return failure(response.status, true);
      const result = v.parse(hostedCommand, response.data);
      if (result.catalogueId !== catalogueId) return uncertain();
      // Read the acknowledged revision with the same client's session token, never guess from submitted bytes.
      const admitted = await read({ catalogueId, revisionId: result.revisionId, kind }, signal);
      if (!admitted.ok || admitted.value.revision.sourceRevisionId !== sourceRevisionId) return uncertain();
      return admitted;
    } catch { return uncertain(); }
  }
  return {
    read,
    async create(input, key, signal) {
      const body = v.safeParse(hostedCreate, input);
      if (!body.success || !v.is(hostedKey, key)) return failure(400, true);
      return command(body.output.postId, 'structure', null, signal,
        () => native.hostedCatalogues.post(body.output, options(signal, undefined, key)));
    },
    async revise(catalogueId, input, key, signal) {
      const body = v.safeParse(hostedRevise, input);
      if (!body.success || !v.is(hostedId, catalogueId) || !v.is(hostedKey, key)) return failure(400, true);
      return command(catalogueId, 'structure', null, signal,
        () => native.hostedCatalogues({ id: catalogueId }).$revise.post(body.output, options(signal, undefined, key)));
    },
    async publish(catalogueId, input, key, signal) {
      const body = v.safeParse(hostedPublish, input);
      if (!body.success || !v.is(hostedId, catalogueId) || !v.is(hostedKey, key)) return failure(400, true);
      return command(catalogueId, 'publication', body.output.expectedRevisionId, signal,
        () => native.hostedCatalogues({ id: catalogueId }).$publish.post(body.output, options(signal, undefined, key)));
    },
  };
}
