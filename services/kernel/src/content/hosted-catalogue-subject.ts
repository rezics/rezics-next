import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readPost, snapshot, type PostEntry, type RetainContentRead } from './reads.ts';
import { hostedCatalogue, hostedRevision } from './hosted-chapters-store.ts';
import {
  InvalidHostedCursorError,
  InvalidHostedStructureError,
  type HostedDependencies,
} from './hosted-chapters-model.ts';
import pageSql from './hosted-catalogue-subject-page.sql';
import { hostedSubjectCursorBinding } from './hosted-catalogue-subject-cursor.ts';
import {
  HOSTED_PAGE_LIMIT,
  hostedSubjectPageLimit,
  isCurrentPublicCatalogueCandidate,
  type HostedSubjectCatalogueItem,
  type HostedSubjectCataloguePage,
  type HostedSubjectCatalogueQuery,
  type HostedSubjectCatalogueRow,
} from './hosted-catalogue-subject-model.ts';

export type {
  HostedSubjectCatalogueItem,
  HostedSubjectCataloguePage,
  HostedSubjectCatalogueQuery,
  HostedSubjectCatalogueRow,
} from './hosted-catalogue-subject-model.ts';
export { hostedSubjectPageLimit, isCurrentPublicCatalogueCandidate } from './hosted-catalogue-subject-model.ts';
export { hostedSubjectCursorBinding } from './hosted-catalogue-subject-cursor.ts';

function readSubjectCursor(
  deps: HostedDependencies,
  binding: CursorBinding,
  subjectId: string,
  token: string | undefined,
): Readonly<{ afterId: string; issuedAt: number; epoch: number }> | null {
  if (token === undefined) return null;
  const decoded = decodeCursor(deps.tokens, binding, token, deps.clock().getTime());
  if (!decoded.ok || decoded.after.length !== 2) throw new InvalidHostedCursorError();
  const [afterId, issuedAt] = decoded.after;
  if (
    typeof afterId !== 'string' ||
    routeOf(afterId) === null ||
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > deps.clock().getTime() + 60_000 ||
    deps.clock().getTime() - issuedAt > 15 * 60_000
  )
    throw new InvalidHostedCursorError();
  return { afterId, issuedAt, epoch: decoded.epoch };
}

function writeSubjectCursor(
  deps: HostedDependencies,
  binding: CursorBinding,
  state: Readonly<{ afterId: string; issuedAt: number; epoch: number }>,
): string {
  return encodeCursor(
    deps.tokens,
    binding,
    { epoch: state.epoch, after: [state.afterId, state.issuedAt] },
    state.issuedAt,
  );
}

async function discloseCatalogue(
  deps: HostedDependencies,
  row: HostedSubjectCatalogueRow,
  context: ReadContext,
  epoch: number,
): Promise<{ item: HostedSubjectCatalogueItem; anchor: AnchoredPosition } | null> {
  if (!isCurrentPublicCatalogueCandidate(row) || routeOf(row.catalogue_id) !== row.route) return null;
  const observation: { current?: Parameters<RetainContentRead<PostEntry>>[0] } = {};
  try {
    const initial = await readPost(deps, row.thread_id, row.catalogue_id, context, undefined, (current) => {
      observation.current = current;
    });
    if (
      initial.value?.availability !== 'available' ||
      initial.value.visibility !== 'published' ||
      initial.anchor.epoch !== epoch ||
      !observation.current
    )
      return null;
  } catch (error) {
    if (error instanceof ContentNotFoundError) return null;
    throw error;
  }
  const retained = observation.current;
  if (!retained) return null;
  const selected = await snapshot(deps, row.catalogue_id, context, (client) =>
    hostedRevision(client, row.catalogue_id, row.publication_id),
  );
  if (!selected.value || selected.value.kind !== 'publication' || selected.anchor.epoch !== epoch) return null;
  try {
    const final = await retained(async (client) => {
      const catalogue = await hostedCatalogue(client, row.catalogue_id);
      if (!catalogue || catalogue.thread_id !== row.thread_id || catalogue.publication_id !== row.publication_id)
        throw new ContentNotFoundError();
    });
    if (
      final.value?.availability !== 'available' ||
      final.value.visibility !== 'published' ||
      final.anchor.epoch !== epoch
    )
      return null;
    return {
      item: {
        catalogueId: row.catalogue_id,
        revisionId: row.publication_id,
        kind: 'publication',
        sourceRevisionId: selected.value.source_revision_id,
        threadId: row.thread_id,
      },
      anchor: final.anchor,
    };
  } catch (error) {
    if (error instanceof ContentNotFoundError) return null;
    throw error;
  }
}

/** Bounded current public hosted catalogues associated with an existing Subject.
 * Candidates come from indexed subject_thread rows and same-route published catalogue-post
 * subject references. TOC withdrawal (empty publication) removes a catalogue from this page.
 * Concealed rows consume a slot and are not refilled. */
export async function listHostedCataloguesForSubject(
  deps: HostedDependencies,
  subjectId: string,
  query: HostedSubjectCatalogueQuery,
  context: ReadContext,
): Promise<{ value: HostedSubjectCataloguePage; anchors: AnchoredPosition[] }> {
  const route = routeOf(subjectId);
  if (route === null) throw new InvalidHostedStructureError('Invalid subject selector');
  const limit = hostedSubjectPageLimit(query.limit);
  if (limit < 0) throw new InvalidHostedStructureError();
  const binding = hostedSubjectCursorBinding(subjectId, context, limit);
  const cursor = readSubjectCursor(deps, binding, subjectId, query.cursor);
  const issuedAt = cursor?.issuedAt ?? deps.clock().getTime();
  const selected = await snapshot(deps, subjectId, context, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition) throw new ContentNotFoundError();
    if (cursor && cursor.epoch !== partition.epoch) throw new InvalidHostedCursorError();
    const rows = await pageSql.run(client, {
      route,
      subject_id: subjectId,
      has_after: cursor !== null,
      after_id: cursor?.afterId ?? '00000000-0000-0000-0000-000000000000',
      limit: limit + 1,
    });
    return { rows: rows as HostedSubjectCatalogueRow[], epoch: partition.epoch, partition };
  });
  const anchors: AnchoredPosition[] = [selected.anchor];
  const raw = selected.value.rows.slice(0, limit);
  const items: HostedSubjectCatalogueItem[] = [];
  for (const row of raw) {
    const disclosed = await discloseCatalogue(deps, row, context, selected.value.epoch);
    if (!disclosed) continue;
    items.push(disclosed.item);
    anchors.push(disclosed.anchor);
  }
  const last = raw.at(-1);
  const nextCursor =
    selected.value.rows.length > limit && last
      ? writeSubjectCursor(deps, binding, {
          afterId: last.catalogue_id,
          issuedAt,
          epoch: selected.value.epoch,
        })
      : null;
  return {
    value: { subjectId, items, nextCursor },
    anchors,
  };
}

export const HOSTED_SUBJECT_PAGE_LIMIT = HOSTED_PAGE_LIMIT;
