import { accessCheck } from './access-port.ts';
import { routeOf } from '../route/route.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readPost, snapshot, type PostEntry, type RetainContentRead } from './reads.ts';
import { prepareHostedTarget } from './hosted-chapters-disclosure.ts';
import {
  HOSTED_PLACEMENT_SELECT,
  hostedCatalogue,
  hostedRevision,
  hostedPlacement,
  type HostedPlacementRow,
} from './hosted-chapters-store.ts';
import { hostedCursorBinding, readHostedCursor, writeHostedCursor } from './hosted-chapters-cursor.ts';
import {
  HOSTED_PAGE_LIMIT,
  InvalidHostedStructureError,
  InvalidHostedCursorError,
  type HostedDependencies,
  type HostedReadSelection,
  type HostedChildrenInput,
  type HostedNavigationInput,
  type HostedRevisionView,
  type HostedOccurrenceView,
  type OrderedHostedPlacement,
  type HostedPageView,
  type HostedResolutionView,
} from './hosted-chapters-model.ts';

function identity(catalogueId: string, revisionId?: string): number {
  const route = routeOf(catalogueId);
  if (route === null || (revisionId !== undefined && routeOf(revisionId) !== route))
    throw new InvalidHostedStructureError('Invalid catalogue selector');
  return route;
}

async function selectCatalogue(
  deps: HostedDependencies,
  catalogueId: string,
  selection: HostedReadSelection,
  context: ReadContext,
) {
  const route = identity(catalogueId, selection.revisionId);
  if (selection.kind !== undefined && selection.kind !== 'structure' && selection.kind !== 'publication')
    throw new InvalidHostedStructureError('Invalid revision kind');
  const initial = await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId));
  if (!initial.value) throw new ContentNotFoundError();
  const catalogue = initial.value;
  const observation: { current?: Parameters<RetainContentRead<PostEntry>>[0] } = {};
  const disclosed = await readPost(deps, catalogue.thread_id, catalogueId, context, undefined, (current) => {
    observation.current = current;
  });
  if (disclosed.value?.availability !== 'available' || !observation.current) throw new ContentNotFoundError();
  const revisionId =
    selection.revisionId ?? (selection.kind === 'structure' ? catalogue.head_revision_id : catalogue.publication_id);
  if (!revisionId) throw new ContentNotFoundError();
  const selected = await snapshot(deps, catalogueId, context, (client) =>
    hostedRevision(client, catalogueId, revisionId),
  );
  if (!selected.value || selected.anchor.epoch !== initial.anchor.epoch) throw new ContentNotFoundError();
  if (selection.kind !== undefined && selected.value.kind !== selection.kind) throw new ContentNotFoundError();
  const revise =
    selected.value.kind === 'structure'
      ? await accessCheck(
          deps.access,
          context.actor,
          'post:revise',
          { route, id: catalogueId },
          { pool: deps.pool, deadline: context.deadline },
        )
      : null;
  const current = observation.current;
  const finish = async () => {
    const result = await current(async (client) => {
      if (revise && !(await revise(client))) throw new ContentNotFoundError();
      const row = await hostedCatalogue(client, catalogueId);
      if (!row || row.thread_id !== catalogue.thread_id) throw new ContentNotFoundError();
    });
    if (result.value?.availability !== 'available' || result.anchor.epoch !== initial.anchor.epoch)
      throw new ContentNotFoundError();
    return result.anchor;
  };
  // A private structure cannot expose placement existence before edit authority is checked.
  await finish();
  const view: HostedRevisionView = {
    catalogueId,
    revisionId,
    kind: selected.value.kind,
    sourceRevisionId: selected.value.source_revision_id,
  };
  return { route, epoch: initial.anchor.epoch, view, finish };
}

function slot(placement: OrderedHostedPlacement) {
  return {
    occurrenceId: placement.occurrenceId,
    parentId: placement.parentId,
    position: placement.position,
    kind: placement.kind,
  };
}
function available(placement: OrderedHostedPlacement): HostedOccurrenceView {
  return placement.kind === 'chapter'
    ? {
        ...slot(placement),
        kind: 'chapter',
        availability: 'available',
        title: placement.title,
        target: placement.target,
      }
    : { ...slot(placement), kind: 'part', availability: 'available', title: placement.title, target: null };
}
function unavailable(placement: OrderedHostedPlacement): HostedOccurrenceView {
  return { ...slot(placement), availability: 'unavailable' };
}

export async function readHostedCatalogue(
  deps: HostedDependencies,
  catalogueId: string,
  selection: HostedReadSelection,
  context: ReadContext,
) {
  const selected = await selectCatalogue(deps, catalogueId, selection, context);
  return { value: selected.view, anchors: [await selected.finish()] };
}

async function placementAt(
  deps: HostedDependencies,
  catalogueId: string,
  revisionId: string,
  occurrenceId: string,
  context: ReadContext,
) {
  if (routeOf(occurrenceId) !== routeOf(catalogueId)) throw new InvalidHostedStructureError('Invalid occurrence');
  return snapshot(deps, catalogueId, context, async (client) => {
    const row = (
      await client.query<HostedPlacementRow>(`${HOSTED_PLACEMENT_SELECT} AND p.occurrence_id=$4`, [
        routeOf(catalogueId),
        catalogueId,
        revisionId,
        occurrenceId,
      ])
    ).rows[0];
    return row ? hostedPlacement(row) : null;
  });
}

export async function resolveHostedOccurrence(
  deps: HostedDependencies,
  catalogueId: string,
  occurrenceId: string,
  selection: HostedReadSelection,
  context: ReadContext,
) {
  const selected = await selectCatalogue(deps, catalogueId, selection, context);
  const found = await placementAt(deps, catalogueId, selected.view.revisionId, occurrenceId, context);
  if (!found.value || found.anchor.epoch !== selected.epoch) throw new ContentNotFoundError();
  const placement = found.value;
  const anchors: AnchoredPosition[] = [found.anchor];
  let occurrence = available(placement);
  let document: HostedResolutionView['document'] = null;
  if (placement.kind === 'chapter') {
    const guard = await prepareHostedTarget(deps, placement.target, context);
    const target = await guard?.final(true);
    if (!target?.canonicalBytes) occurrence = unavailable(placement);
    else {
      anchors.push(target.anchor);
      document = {
        encoding: 'base64',
        canonicalBytes: target.canonicalBytes,
        sha256: placement.target.sha256,
        authorId: target.authorId,
        licence: target.licence,
      };
    }
  }
  anchors.push(await selected.finish());
  const value: HostedResolutionView = { ...selected.view, occurrence, document };
  return { value, anchors };
}

export function listHostedChildren(
  deps: HostedDependencies,
  catalogueId: string,
  input: HostedChildrenInput,
  context: ReadContext,
) {
  return page(deps, catalogueId, input, context, {
    mode: 'children',
    parentId: input.parentId ?? null,
    occurrenceId: null,
  });
}
export function navigateHostedChapters(
  deps: HostedDependencies,
  catalogueId: string,
  input: HostedNavigationInput,
  context: ReadContext,
) {
  if (input.direction !== 'previous' && input.direction !== 'next') throw new InvalidHostedStructureError();
  return page(deps, catalogueId, input, context, {
    mode: input.direction,
    parentId: null,
    occurrenceId: input.occurrenceId,
  });
}

async function page(
  deps: HostedDependencies,
  catalogueId: string,
  input: HostedChildrenInput | HostedNavigationInput,
  context: ReadContext,
  query: { mode: 'children' | 'previous' | 'next'; parentId: string | null; occurrenceId: string | null },
) {
  const route = identity(catalogueId, input.revisionId);
  if (
    (query.parentId !== null && routeOf(query.parentId) !== route) ||
    (query.occurrenceId !== null && routeOf(query.occurrenceId) !== route)
  )
    throw new InvalidHostedStructureError();
  const limit = input.limit ?? HOSTED_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PAGE_LIMIT) throw new InvalidHostedStructureError();
  const binding = hostedCursorBinding(catalogueId, input, context, { ...query, limit });
  const cursor = readHostedCursor(deps, binding, catalogueId, input.cursor);
  if (cursor && input.revisionId !== undefined && cursor.revisionId !== input.revisionId)
    throw new InvalidHostedCursorError();
  const selected = await selectCatalogue(
    deps,
    catalogueId,
    cursor ? { ...input, revisionId: cursor.revisionId } : input,
    context,
  );
  if (cursor && cursor.epoch !== selected.epoch) throw new InvalidHostedCursorError();
  let origin = -1;
  const referenceId = query.mode === 'children' ? query.parentId : query.occurrenceId;
  if (referenceId !== null) {
    const reference = await placementAt(deps, catalogueId, selected.view.revisionId, referenceId, context);
    if (
      !reference.value ||
      reference.anchor.epoch !== selected.epoch ||
      (query.mode === 'children' && reference.value.kind !== 'part')
    )
      throw new ContentNotFoundError();
    origin = query.mode === 'children' ? -1 : reference.value.ordinal;
  }
  if (
    cursor &&
    (cursor.origin !== origin || (query.mode === 'previous' ? cursor.after >= origin : cursor.after <= origin))
  )
    throw new InvalidHostedCursorError();
  const after = cursor?.after ?? origin;
  const issuedAt = cursor?.issuedAt ?? deps.clock().getTime();
  const raw = await snapshot(deps, catalogueId, context, async (client) => {
    const values: unknown[] = [route, catalogueId, selected.view.revisionId, after, limit + 1];
    let condition: string;
    if (query.mode === 'children') {
      condition = ' AND p.position>$4 AND ';
      if (query.parentId === null) condition += 'p.parent_id IS NULL';
      else {
        condition += 'p.parent_id=$6';
        values.push(query.parentId);
      }
    } else {
      condition = ` AND p.target_revision_id IS NOT NULL AND p.ordinal${query.mode === 'previous' ? '<' : '>'}$4`;
    }
    const order = query.mode === 'children' ? 'p.position' : `p.ordinal ${query.mode === 'previous' ? 'DESC' : 'ASC'}`;
    return (
      await client.query<HostedPlacementRow>(
        `${HOSTED_PLACEMENT_SELECT}${condition} ORDER BY ${order} LIMIT $5`,
        values,
      )
    ).rows;
  });
  if (raw.anchor.epoch !== selected.epoch) throw new ContentNotFoundError();
  const placements = raw.value.slice(0, limit).map(hostedPlacement);
  const guards = new Map<string, Awaited<ReturnType<typeof prepareHostedTarget>>>();
  for (const placement of placements) {
    if (placement.kind !== 'chapter') continue;
    const key = `${placement.target.postId}/${placement.target.revisionId}/${placement.target.sha256}`;
    if (!guards.has(key)) guards.set(key, await prepareHostedTarget(deps, placement.target, context));
  }
  const targets = new Map<
    string,
    Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof prepareHostedTarget>>>['final']>>
  >();
  for (const [key, guard] of guards) targets.set(key, (await guard?.final()) ?? null);
  const anchors: AnchoredPosition[] = [raw.anchor];
  const items = placements.map((placement) => {
    if (placement.kind === 'part') return available(placement);
    const target = targets.get(`${placement.target.postId}/${placement.target.revisionId}/${placement.target.sha256}`);
    if (!target) return unavailable(placement);
    anchors.push(target.anchor);
    return available(placement);
  });
  const last = placements.at(-1);
  const nextCursor =
    raw.value.length > limit && last
      ? writeHostedCursor(deps, binding, {
          revisionId: selected.view.revisionId,
          after: query.mode === 'children' ? last.position : last.ordinal,
          origin,
          issuedAt,
          epoch: selected.epoch,
        })
      : null;
  anchors.push(await selected.finish());
  const value: HostedPageView = { ...selected.view, items, nextCursor };
  return { value, anchors };
}
