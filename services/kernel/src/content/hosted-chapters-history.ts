import { AuthenticationError } from '../access/contract/authentication.ts';
import { routeOf } from '../route/route.ts';
import { accessCheck } from './access-port.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readPost, snapshot, type PostEntry, type RetainContentRead } from './reads.ts';
import {
  HOSTED_PAGE_LIMIT,
  InvalidHostedCursorError,
  InvalidHostedStructureError,
  type HostedDependencies,
} from './hosted-chapters-model.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import {
  hostedHistoryBinding,
  readHostedHistoryCursor,
  writeHostedHistoryCursor,
} from './hosted-chapters-history-cursor.ts';
import type { HostedHistoryInput, HostedHistoryPage, HostedHistoryRow } from './hosted-chapters-history-model.ts';
import pageSql from './hosted-chapters-history-page.sql';

export type { HostedHistoryInput, HostedHistoryItem, HostedHistoryPage } from './hosted-chapters-history-model.ts';

/** The anchor Post remains the owner. A public release or a valid continuation
 * cannot stand in for current authorship, disclosure and post:revise authority. */
async function historyAuthority(deps: HostedDependencies, catalogueId: string, context: ReadContext) {
  const actor = context.actor;
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(catalogueId);
  if (route === null) throw new InvalidHostedStructureError('Invalid catalogue selector');
  const initial = await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId));
  const catalogue = initial.value;
  if (!catalogue) throw new ContentNotFoundError();
  const observation: { current?: Parameters<RetainContentRead<PostEntry>>[0] } = {};
  const disclosed = await readPost(deps, catalogue.thread_id, catalogueId, context, undefined, (current) => {
    observation.current = current;
  });
  if (
    disclosed.value?.availability !== 'available' ||
    disclosed.value.authorId !== actor.accountId ||
    disclosed.anchor.epoch !== initial.anchor.epoch ||
    !observation.current
  )
    throw new ContentNotFoundError();
  const revise = await accessCheck(
    deps.access,
    actor,
    'post:revise',
    { route, id: catalogueId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const retained = observation.current;
  // Retain native checks and catalogue identity, never the disclosed Post body.
  const finish = async () => {
    const observation: { catalogue?: typeof catalogue } = {};
    const result = await retained(async (client) => {
      if (!(await revise(client))) throw new ContentNotFoundError();
      const current = await hostedCatalogue(client, catalogueId);
      if (!current || current.thread_id !== catalogue.thread_id) throw new ContentNotFoundError();
      observation.catalogue = current;
    });
    if (
      result.value?.availability !== 'available' ||
      result.value.authorId !== actor.accountId ||
      result.value.threadId !== catalogue.thread_id ||
      result.anchor.epoch !== initial.anchor.epoch ||
      !observation.catalogue
    )
      throw new ContentNotFoundError();
    return { catalogue: observation.catalogue, anchor: result.anchor };
  };
  const admitted = await finish();
  return { route, epoch: initial.anchor.epoch, anchor: admitted.anchor, finish };
}

/** Separate from owner inventory and command/checkpoint writers: this is one
 * catalogue's immutable revision index, with at most limit+1 small records read. */
export async function listHostedCatalogueHistory(
  deps: HostedDependencies,
  catalogueId: string,
  input: HostedHistoryInput,
  context: ReadContext,
): Promise<{ value: HostedHistoryPage; anchors: AnchoredPosition[] }> {
  // Admission precedes cursor use, including for a continuation minted before
  // permission revocation. Nothing retained inside a token grants access.
  const authority = await historyAuthority(deps, catalogueId, context);
  const limit = input.limit ?? HOSTED_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PAGE_LIMIT) throw new InvalidHostedStructureError();
  const binding = hostedHistoryBinding(catalogueId, context, limit);
  const cursor = readHostedHistoryCursor(deps, binding, catalogueId, authority.epoch, input.cursor);
  const issuedAt = cursor?.issuedAt ?? deps.clock().getTime();
  const selected = await snapshot(deps, catalogueId, context, async (client) =>
    pageSql.run(client, {
      route: authority.route,
      catalogue_id: catalogueId,
      before_created_at: cursor?.after.createdAt ?? 'infinity',
      before_revision_id: cursor?.after.revisionId ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      limit: limit + 1,
    }),
  );
  if (selected.anchor.epoch !== authority.epoch) {
    if (cursor) throw new InvalidHostedCursorError();
    throw new ContentNotFoundError();
  }
  const rows = (selected.value as HostedHistoryRow[]).slice(0, limit);
  // Current flags come from the same final native disclosure snapshot. A newer
  // draft or release never changes the exact selection IDs in earlier entries.
  const final = await authority.finish();
  const last = rows.at(-1);
  return {
    value: {
      catalogueId,
      items: rows.map((row) => ({
        catalogueId,
        revisionId: row.revision_id,
        kind: row.kind,
        sourceRevisionId: row.source_revision_id,
        createdAt: row.created_at,
        isCurrentDraft: row.revision_id === final.catalogue.head_revision_id,
        isCurrentRelease: row.revision_id === final.catalogue.publication_id,
      })),
      nextCursor:
        selected.value.length > limit && last
          ? writeHostedHistoryCursor(deps, binding, {
              after: { createdAt: last.created_at, revisionId: last.revision_id },
              epoch: authority.epoch,
              issuedAt,
            })
          : null,
    },
    anchors: [authority.anchor, selected.anchor, final.anchor],
  };
}
