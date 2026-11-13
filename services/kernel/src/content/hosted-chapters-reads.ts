import { accessCheck } from './access-port.ts';
import { AuthenticationError } from '../access/contract/authentication.ts';
import { routeOf } from '../route/route.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  readPostMetadata,
  snapshot,
  type NativePostMetadata,
  type RetainContentRead,
} from './reads.ts';
import {
  discloseHostedTargetMetadata,
  hostedTargetKey,
  prepareHostedTarget,
  prepareHostedTargetMetadata,
} from './hosted-chapters-disclosure.ts';
import {
  hostedCatalogue,
  hostedRevision,
  hostedReadPlacement,
  hostedReadPlacementPage,
} from './hosted-chapters-store.ts';
import { hostedAppendDescriptor } from './hosted-chapters-append.ts';
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
  type HostedAppendDescriptor,
} from './hosted-chapters-model.ts';

function identity(catalogueId: string, revisionId?: string): number {
  const route = routeOf(catalogueId);
  if (route === null || (revisionId !== undefined && routeOf(revisionId) !== route))
    throw new InvalidHostedStructureError('Invalid catalogue selector');
  return route;
}

type HostedCatalogueReadSelection = HostedReadSelection & Readonly<{ includeTitle?: '1' }>;

async function selectCatalogue(
  deps: HostedDependencies,
  catalogueId: string,
  selection: HostedReadSelection,
  context: ReadContext,
  requireRevise = false,
) {
  const route = identity(catalogueId, selection.revisionId);
  if (selection.kind !== undefined && selection.kind !== 'structure' && selection.kind !== 'publication')
    throw new InvalidHostedStructureError('Invalid revision kind');
  const initial = await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId));
  if (!initial.value) throw new ContentNotFoundError();
  const catalogue = initial.value;
  const observation: { current?: Parameters<RetainContentRead<NativePostMetadata>>[0] } = {};
  const disclosed = await readPostMetadata(deps, catalogue.thread_id, catalogueId, context, undefined, (current) => {
    observation.current = current;
  });
  if (!disclosed.value || !observation.current) throw new ContentNotFoundError();
  const revisionId =
    selection.revisionId ?? (selection.kind === 'structure' ? catalogue.head_revision_id : catalogue.publication_id);
  if (!revisionId) throw new ContentNotFoundError();
  const selected = await snapshot(deps, catalogueId, context, async (client) => {
    const revision = await hostedRevision(client, catalogueId, revisionId);
    if (!revision) return null;
    // Publications remain immutable manifests. A structure optionally selects
    // one sealed base/prefix, in this same partition observation as its header.
    const descriptor =
      revision.kind === 'structure' ? await hostedAppendDescriptor(client, catalogueId, revisionId) : null;
    return { ...revision, descriptor };
  });
  if (!selected.value || selected.anchor.epoch !== initial.anchor.epoch) throw new ContentNotFoundError();
  if (selection.kind !== undefined && selected.value.kind !== selection.kind) throw new ContentNotFoundError();
  const revise =
    requireRevise || selected.value.kind === 'structure'
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
    if (!result.value || result.anchor.epoch !== initial.anchor.epoch) throw new ContentNotFoundError();
    return { anchor: result.anchor, post: result.value };
  };
  // A private structure cannot expose placement existence before edit authority is checked.
  await finish();
  const view: HostedRevisionView = {
    catalogueId,
    revisionId,
    kind: selected.value.kind,
    sourceRevisionId: selected.value.source_revision_id,
  };
  return { route, epoch: initial.anchor.epoch, view, descriptor: selected.value.descriptor, finish };
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
  selection: HostedCatalogueReadSelection,
  context: ReadContext,
) {
  const selected = await selectCatalogue(deps, catalogueId, selection, context);
  const final = await selected.finish();
  const title =
    selection.includeTitle === '1' &&
    selected.view.kind === 'publication' &&
    final.post.visibility === 'published' &&
    final.post.documentKind === 'opening'
      ? final.post.title
      : null;
  return {
    value: { ...selected.view, ...(title === null ? {} : { title }) },
    anchors: [final.anchor],
  };
}

async function placementAt(
  deps: HostedDependencies,
  catalogueId: string,
  revisionId: string,
  occurrenceId: string,
  context: ReadContext,
  descriptor: HostedAppendDescriptor | null,
) {
  if (routeOf(occurrenceId) !== routeOf(catalogueId)) throw new InvalidHostedStructureError('Invalid occurrence');
  return snapshot(deps, catalogueId, context, (client) =>
    hostedReadPlacement(client, catalogueId, revisionId, occurrenceId, descriptor),
  );
}

export async function resolveHostedOccurrence(
  deps: HostedDependencies,
  catalogueId: string,
  occurrenceId: string,
  selection: HostedReadSelection,
  context: ReadContext,
) {
  const selected = await selectCatalogue(deps, catalogueId, selection, context);
  const found = await placementAt(
    deps,
    catalogueId,
    selected.view.revisionId,
    occurrenceId,
    context,
    selected.descriptor,
  );
  if (!found.value || found.anchor.epoch !== selected.epoch) throw new ContentNotFoundError();
  const placement = found.value;
  const anchors: AnchoredPosition[] = [found.anchor];
  let occurrence = available(placement);
  let document: HostedResolutionView['document'] = null;
  if (placement.kind === 'chapter') {
    const guard = await prepareHostedTarget(deps, placement.target, context);
    const target = await guard?.final();
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
  anchors.push((await selected.finish()).anchor);
  const value: HostedResolutionView = { ...selected.view, occurrence, document };
  return { value, anchors };
}

/** Resolve the same historical occurrence and current Access as exact opening,
 * but disclose target metadata without selecting or serializing chapter bytes. */
export async function resolveHostedOccurrenceMetadata(
  deps: HostedDependencies,
  catalogueId: string,
  occurrenceId: string,
  selection: HostedReadSelection,
  context: ReadContext,
) {
  const selected = await selectCatalogue(deps, catalogueId, selection, context);
  const found = await placementAt(
    deps,
    catalogueId,
    selected.view.revisionId,
    occurrenceId,
    context,
    selected.descriptor,
  );
  if (!found.value || found.anchor.epoch !== selected.epoch) throw new ContentNotFoundError();
  const placement = found.value;
  const anchors: AnchoredPosition[] = [found.anchor];
  let occurrence = available(placement);
  if (placement.kind === 'chapter') {
    const disclosed = await discloseHostedTargetMetadata(deps, placement.target, context);
    if (!disclosed) occurrence = unavailable(placement);
    else anchors.push(disclosed.anchor);
  }
  anchors.push((await selected.finish()).anchor);
  return { value: { ...selected.view, occurrence }, anchors };
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

/** Author outline pages every placement in immutable preorder, including empty
 * parts. Keep sibling positions intact so a consumer can reconstruct the tree. */
export function listHostedAuthorOutline(
  deps: HostedDependencies,
  catalogueId: string,
  input: Omit<HostedChildrenInput, 'parentId'>,
  context: ReadContext,
) {
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return page(deps, catalogueId, input, context, {
    mode: 'outline',
    parentId: null,
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
  query: { mode: 'children' | 'previous' | 'next' | 'outline'; parentId: string | null; occurrenceId: string | null },
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
    query.mode === 'outline',
  );
  if (cursor && cursor.epoch !== selected.epoch) throw new InvalidHostedCursorError();
  let origin = -1;
  const referenceId = query.mode === 'children' ? query.parentId : query.occurrenceId;
  if (referenceId !== null) {
    const reference = await placementAt(
      deps,
      catalogueId,
      selected.view.revisionId,
      referenceId,
      context,
      selected.descriptor,
    );
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
  const raw = await snapshot(deps, catalogueId, context, (client) =>
    hostedReadPlacementPage(
      client,
      catalogueId,
      selected.view.revisionId,
      { mode: query.mode, parentId: query.parentId, after, limit: limit + 1 },
      selected.descriptor,
    ),
  );
  if (raw.anchor.epoch !== selected.epoch) throw new ContentNotFoundError();
  const placements = raw.value.slice(0, limit);
  const guards = new Map<string, Awaited<ReturnType<typeof prepareHostedTargetMetadata>>>();
  for (const placement of placements) {
    if (placement.kind !== 'chapter') continue;
    const key = hostedTargetKey(placement.target);
    if (!guards.has(key)) guards.set(key, await prepareHostedTargetMetadata(deps, placement.target, context));
  }
  const targets = new Map<
    string,
    Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof prepareHostedTargetMetadata>>>['final']>>
  >();
  for (const [key, guard] of guards) targets.set(key, (await guard?.final()) ?? null);
  const anchors: AnchoredPosition[] = [raw.anchor];
  const items = placements.map((placement) => {
    if (placement.kind === 'part') return available(placement);
    const target = targets.get(hostedTargetKey(placement.target));
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
  anchors.push((await selected.finish()).anchor);
  const value: HostedPageView = { ...selected.view, items, nextCursor };
  return { value, anchors };
}
