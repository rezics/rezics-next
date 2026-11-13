import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioFailure, StudioResult } from './contract';
import {
  hostedCommand,
  hostedCreate,
  hostedId,
  hostedHistoryPage,
  hostedHistoryRequest,
  type HostedHistoryPage,
  hostedKey,
  hostedOwnerBookResponse,
  sameHostedViewer,
  type HostedOwnerBinding,
  type HostedOwnerViewer,
  hostedOwnerInventoryResponse,
  hostedPage,
  hostedOutlineWindowPage,
  hostedOutlineWindowRequest,
  type HostedOutlineWindowNative,
  type HostedOutlineWindowRequest,
  type HostedOutlineWindowPage,
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
export function createHostedBookNative(client: KernelClient): HostedBookNative & HostedOutlineWindowNative {
  const fetchOptions = (signal: AbortSignal) => ({ signal, cache: 'no-store' as const, redirect: 'manual' as const });
  const queryOptions = (signal: AbortSignal, query: Record<string, string>) => ({ query, fetch: fetchOptions(signal) });
  const commandOptions = (signal: AbortSignal, key: string) => ({
    headers: { 'idempotency-key': JSON.stringify(key) },
    fetch: fetchOptions(signal),
  });
  async function readOutlineWindow(
    input: HostedOutlineWindowRequest,
    signal: AbortSignal,
  ): Promise<StudioResult<HostedOutlineWindowPage>> {
    const missing = () =>
      hostedFailure('unavailable', 'This exact book outline page could not be read. Retry this page.');
    const parsed = v.safeParse(hostedOutlineWindowRequest, input);
    if (!parsed.success) return hostedFailure('invalid', 'The exact book outline address is invalid. Reopen the book.');
    if (signal.aborted) return missing();
    const { revision, cursor } = parsed.output;
    try {
      const response = await client.hostedCatalogues({ id: revision.catalogueId }).outline.get(
        queryOptions(signal, {
          kind: revision.kind,
          revisionId: revision.revisionId,
          limit: '20',
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      if (signal.aborted) return missing();
      if (response.status === 400 || response.status === 409)
        return hostedFailure('stale', 'This outline continuation is no longer valid. Reopen the exact book version.');
      if (response.error || response.status !== 200) return failure(response.status, false);
      const page = v.safeParse(hostedOutlineWindowPage, response.data);
      if (!page.success) return missing();
      if (
        page.output.catalogueId !== revision.catalogueId ||
        page.output.kind !== revision.kind ||
        page.output.revisionId !== revision.revisionId ||
        page.output.sourceRevisionId !== revision.sourceRevisionId
      )
        return missing();
      return { ok: true, value: page.output };
    } catch {
      return missing();
    }
  }
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
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (signal.aborted) return unavailable();
        // Select once, then bind every opaque continuation to that exact immutable revision.
        const pageResponse: Response = await resource.outline.get(
          queryOptions(signal, {
            kind: revision.kind,
            revisionId: revision.revisionId,
            limit: '20',
            ...(cursor === null ? {} : { cursor }),
          }),
        );
        if (signal.aborted) return unavailable();
        if (pageResponse.error || pageResponse.status !== 200) return failure(pageResponse.status, false);
        const page = v.parse(hostedPage, pageResponse.data);
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
          if (ids.has(item.occurrenceId) || placements.length >= 512) return unavailable();
          ids.add(item.occurrenceId);
          const address = {
            occurrenceId: item.occurrenceId,
            parentId: item.parentId,
            position: item.position,
            title: item.title,
          };
          placements.push(
            item.kind === 'chapter'
              ? { ...address, kind: 'chapter', target: item.target }
              : { ...address, kind: 'part' },
          );
        }
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (!page.items.length || cursors.has(cursor)) return unavailable();
          cursors.add(cursor);
        }
      } while (cursor !== null);
      if (signal.aborted) return unavailable();
      const book = { revision, placements };
      // The common tree model checks parents, dense sibling positions and depth. Comparing
      // its preorder also rejects a stream that reopens an already completed subtree.
      const structure = hostedBookStructure(book);
      if (structure.placements.some((item, index) => item.occurrenceId !== placements[index]!.occurrenceId))
        return unavailable();
      return { ok: true, value: book };
    } catch {
      return unavailable();
    }
  }
  async function listHistory(
    catalogueId: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<StudioResult<HostedHistoryPage>> {
    const unavailableHistory = () => hostedFailure('unavailable', 'Book history is unavailable. Retry this page.');
    const input = v.safeParse(hostedHistoryRequest, { catalogueId, cursor });
    if (!input.success) return hostedFailure('invalid', 'The book history address is invalid. Reopen the book.');
    if (signal.aborted) return unavailableHistory();
    try {
      const response = await client
        .hostedCatalogues({ id: catalogueId })
        .history.get(queryOptions(signal, { limit: '20', ...(cursor === null ? {} : { cursor }) }));
      if (signal.aborted) return unavailableHistory();
      if (response.status === 401 || response.status === 403)
        return hostedFailure('denied', 'Your current session cannot browse this book history. Reopen the book.');
      if (response.status === 400 || response.status === 409)
        return hostedFailure('stale', 'This history continuation is no longer valid. Restart history.');
      if (response.error || response.status !== 200) return unavailableHistory();
      const parsed = v.safeParse(hostedHistoryPage, response.data);
      if (!parsed.success || parsed.output.catalogueId !== catalogueId) return unavailableHistory();
      const page = parsed.output;
      const ids = new Set<string>();
      for (const entry of page.items) {
        // A mixed-catalogue or mislabelled response must never become a selectable exact version.
        if (
          entry.catalogueId !== catalogueId ||
          ids.has(entry.revisionId) ||
          (entry.kind === 'structure'
            ? entry.sourceRevisionId !== null || entry.isCurrentRelease
            : entry.sourceRevisionId === null || entry.isCurrentDraft)
        )
          return unavailableHistory();
        ids.add(entry.revisionId);
      }
      return { ok: true, value: page };
    } catch {
      return unavailableHistory();
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
    readOutlineWindow,
    read,
    listHistory,
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
