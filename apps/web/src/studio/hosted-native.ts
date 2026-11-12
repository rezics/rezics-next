import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioFailure, StudioResult } from './contract';
import { bookTocRows } from './book-toc';
import {
  hostedCommand,
  hostedCreate,
  hostedId,
  hostedKey,
  hostedOwnerBookResponse,
  sameHostedViewer,
  type HostedOwnerBinding,
  type HostedOwnerViewer,
  hostedOwnerInventoryResponse,
  hostedPage,
  hostedPublish,
  hostedRevise,
  hostedRevision,
  hostedSelection,
  type HostedBook,
  type HostedBookNative,
  type HostedCreate,
  type HostedPlacement,
  type HostedPublish,
  type HostedRevise,
  type HostedSelection,
} from './hosted-contract';
import { hostedBookStructure } from './hosted-structure';

type Response = { status: number; data?: unknown; error?: unknown };
export const hostedFailure = (kind: StudioFailure['kind'], message: string): StudioResult<never> => ({
  ok: false,
  error: { kind, message },
});
const unavailable = () => hostedFailure('unavailable', 'The complete book structure could not be read. Try again.');
const uncertain = () =>
  hostedFailure('uncertain', 'The book command may have committed. Retry the same operation to recover its result.');

function failure(status: number, mutation: boolean): StudioResult<never> {
  if (status === 401 || status === 403)
    return hostedFailure('denied', 'Your current session cannot perform this book action.');
  if (status === 404)
    return hostedFailure('unavailable', 'This book or one of its exact chapter versions is unavailable.');
  if (status === 409)
    return hostedFailure('stale', 'The book inventory continuation is no longer valid. Reopen your books.');
  if (status === 412)
    return hostedFailure('stale', 'The structure or publication changed. Reload before preparing another operation.');
  if (status === 400 || status === 413 || status === 422)
    return hostedFailure(
      'invalid',
      'The book command was rejected. Check the structure, selected versions, and operation key.',
    );
  return mutation ? uncertain() : unavailable();
}

/** Uses the existing credential-bearing client and its read-your-writes session-token handling. */
export function createHostedBookNative(client: KernelClient): HostedBookNative {
  const fetchOptions = (signal: AbortSignal) => ({ signal, cache: 'no-store' as const, redirect: 'manual' as const });
  const queryOptions = (signal: AbortSignal, query: Record<string, string>) => ({ query, fetch: fetchOptions(signal) });
  const commandOptions = (signal: AbortSignal, key: string) => ({
    headers: { 'idempotency-key': JSON.stringify(key) },
    fetch: fetchOptions(signal),
  });
  async function read(input: HostedSelection, signal: AbortSignal): Promise<StudioResult<HostedBook>> {
    try {
      const selection = v.parse(hostedSelection, input);
      if (signal.aborted) return unavailable();
      const resource = client.hostedCatalogues({ id: selection.catalogueId });
      const query = { kind: selection.kind, ...(selection.revisionId ? { revisionId: selection.revisionId } : {}) };
      const response = await resource.get(queryOptions(signal, query));
      if (response.error || response.status !== 200) return failure(response.status, false);
      const revision = v.parse(hostedRevision, response.data);
      if (
        revision.catalogueId !== selection.catalogueId ||
        revision.kind !== selection.kind ||
        (selection.revisionId && revision.revisionId !== selection.revisionId) ||
        (revision.kind === 'structure' ? revision.sourceRevisionId !== null : revision.sourceRevisionId === null)
      )
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
          const pageResponse: Response = await resource.children.get(
            queryOptions(signal, {
              kind: revision.kind,
              revisionId: revision.revisionId,
              limit: '20',
              ...(parent.id ? { parentId: parent.id } : {}),
              ...(cursor ? { cursor } : {}),
            }),
          );
          if (pageResponse.error || pageResponse.status !== 200) return failure(pageResponse.status, false);
          const page: v.InferOutput<typeof hostedPage> = v.parse(hostedPage, pageResponse.data);
          if (
            page.catalogueId !== revision.catalogueId ||
            page.revisionId !== revision.revisionId ||
            page.kind !== revision.kind ||
            page.sourceRevisionId !== revision.sourceRevisionId
          )
            return unavailable();
          for (const item of page.items) {
            if (item.availability !== 'available')
              return hostedFailure(
                'unavailable',
                'A chapter is unavailable. The incomplete table of contents cannot be rewritten.',
              );
            if (
              parent.depth > 16 ||
              item.parentId !== parent.id ||
              item.position !== position++ ||
              ids.has(item.occurrenceId) ||
              placements.length >= 512
            )
              return unavailable();
            ids.add(item.occurrenceId);
            const address = {
              occurrenceId: item.occurrenceId,
              parentId: item.parentId,
              position: item.position,
              title: item.title,
            };
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
    } catch {
      return unavailable();
    }
  }
  async function listOwn(accountId: string, cursor: string | null, signal: AbortSignal, expected?: HostedOwnerBinding) {
    if (signal.aborted) return unavailable();
    try {
      const response = await client.accounts({ accountId }).hostedCatalogues.get(
        queryOptions(signal, {
          scope: expected?.scope.kind ?? 'all-homes',
          limit: '20',
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      if (signal.aborted) return unavailable();
      if (response.status === 400)
        return hostedFailure('stale', 'This book page is no longer available. Reopen your books.');
      if (response.error || response.status !== 200) return failure(response.status, false);
      const parsed = v.safeParse(hostedOwnerInventoryResponse, response.data);
      if (!parsed.success) return unavailable();
      const page = parsed.output;
      if (page.viewer.accountId !== accountId || (expected && !sameHostedViewer(page.viewer, expected.viewer)))
        return hostedFailure('denied', 'The author session changed. Reopen your books.');
      if (expected && (page.scope.kind !== expected.scope.kind || page.scope.route !== expected.scope.route))
        return hostedFailure('stale', 'The inventory scope changed. Reopen your books.');
      return { ok: true as const, value: page };
    } catch {
      return unavailable();
    }
  }
  async function readOwn(
    accountId: string,
    catalogueId: string,
    signal: AbortSignal,
    expectedViewer?: HostedOwnerViewer,
  ) {
    if (signal.aborted) return unavailable();
    try {
      const response = await client
        .accounts({ accountId })
        .hostedCatalogues({ id: catalogueId })
        .get({ fetch: fetchOptions(signal) });
      if (signal.aborted) return unavailable();
      if (response.error || response.status !== 200) return failure(response.status, false);
      const parsed = v.safeParse(hostedOwnerBookResponse, response.data);
      if (!parsed.success || parsed.output.item.catalogueId !== catalogueId) return unavailable();
      const owned = parsed.output;
      if (owned.viewer.accountId !== accountId || (expectedViewer && !sameHostedViewer(owned.viewer, expectedViewer)))
        return hostedFailure('denied', 'The author session changed. Reopen the book.');
      return { ok: true as const, value: owned };
    } catch {
      return unavailable();
    }
  }
  async function command(
    catalogueId: string,
    kind: HostedSelection['kind'],
    sourceRevisionId: string | null,
    signal: AbortSignal,
    send: () => Promise<Response>,
  ): Promise<StudioResult<HostedBook>> {
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
    } catch {
      return uncertain();
    }
  }
  return {
    read,
    listOwn,
    readOwn,
    async create(input, key, signal) {
      const body = v.safeParse(hostedCreate, input);
      if (!body.success || !v.is(hostedKey, key)) return failure(400, true);
      return command(body.output.postId, 'structure', null, signal, () =>
        client.hostedCatalogues.post(body.output, commandOptions(signal, key)),
      );
    },
    async revise(catalogueId, input, key, signal) {
      const body = v.safeParse(hostedRevise, input);
      if (!body.success || !v.is(hostedId, catalogueId) || !v.is(hostedKey, key)) return failure(400, true);
      return command(catalogueId, 'structure', null, signal, () =>
        client.hostedCatalogues({ id: catalogueId }).$revise.post(body.output, commandOptions(signal, key)),
      );
    },
    async publish(catalogueId, input, key, signal) {
      const body = v.safeParse(hostedPublish, input);
      if (!body.success || !v.is(hostedId, catalogueId) || !v.is(hostedKey, key)) return failure(400, true);
      return command(catalogueId, 'publication', body.output.expectedRevisionId, signal, () =>
        client.hostedCatalogues({ id: catalogueId }).$publish.post(body.output, commandOptions(signal, key)),
      );
    },
  };
}
