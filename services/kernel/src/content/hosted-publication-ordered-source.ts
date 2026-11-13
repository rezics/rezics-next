import type { AccessClient } from '../request/access.ts';
import type { OrderedHostedPlacement } from './hosted-chapters-model.ts';
import { pageVersionedHostedPlacements, readVersionedHostedPlacement } from './hosted-chapters-version-reads.ts';
import { resolveHostedVersionRevision } from './hosted-version-revision.ts';
import { readHostedVersionSnapshot } from './hosted-version-store.ts';
import type { HostedVersionSnapshot } from './hosted-version-model.ts';

/** The exact ordered descriptor captured from the current immutable Book revision. */
export type HostedPublicationOrderedSource = Readonly<{
  route: number;
  catalogueId: string;
  revisionId: string;
  generationId: string;
  sequence: bigint;
}>;

export type HostedPublicationOrderedSourcePage = Readonly<{
  placements: readonly OrderedHostedPlacement[];
  exhausted: boolean;
}>;

/** Compatibility revisions return null and continue through their existing readers. */
export async function resolveHostedPublicationOrderedSource(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedPublicationOrderedSource | null> {
  const resolved = await resolveHostedVersionRevision(client, catalogueId, revisionId);
  if (resolved.kind === 'missing') throw new Error('Pinned hosted source revision is missing');
  if (resolved.kind === 'compatibility') return null;
  if (resolved.revisionKind !== 'structure' || resolved.snapshot.generationKind !== 'draft')
    throw new Error('Pinned hosted source is not an ordered draft snapshot');
  return {
    route: resolved.snapshot.route,
    catalogueId: resolved.snapshot.catalogueId,
    revisionId: resolved.revisionId,
    generationId: resolved.snapshot.generationId,
    sequence: resolved.snapshot.sequence,
  };
}

async function readSnapshot(
  client: AccessClient,
  source: HostedPublicationOrderedSource,
): Promise<HostedVersionSnapshot> {
  const snapshot = await readHostedVersionSnapshot(client, source.catalogueId, source.generationId, source.sequence);
  if (!snapshot) throw new Error('Pinned hosted ordered snapshot is missing');
  if (
    snapshot.route !== source.route ||
    snapshot.catalogueId !== source.catalogueId ||
    snapshot.generationId !== source.generationId ||
    snapshot.sequence !== source.sequence ||
    snapshot.generationKind !== 'draft'
  )
    throw new Error('Pinned hosted ordered snapshot does not match its revision descriptor');
  return snapshot;
}

/** Read at most one staging step from the exact pinned preorder. */
export async function pageHostedPublicationOrderedSource(
  client: AccessClient,
  source: HostedPublicationOrderedSource,
  afterSourceOrder: string,
  limit: number,
): Promise<HostedPublicationOrderedSourcePage> {
  const after = BigInt(afterSourceOrder);
  if (after < -1n || after > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Pinned hosted source order exceeds the exact page cursor range');
  const snapshot = await readSnapshot(client, source);
  const page = await pageVersionedHostedPlacements(client, snapshot, {
    mode: 'outline',
    parentId: null,
    occurrenceId: null,
    cursorAfter: after < 0n ? null : Number(after),
    limit,
  });
  return { placements: page.placements, exhausted: !page.hasMore };
}

/** Point reads preserve sparse source ranks and never enumerate the surrounding tree. */
export async function readHostedPublicationOrderedSourcePoints(
  client: AccessClient,
  source: HostedPublicationOrderedSource,
  occurrenceIds: readonly string[],
): Promise<readonly (OrderedHostedPlacement | null)[]> {
  const snapshot = await readSnapshot(client, source);
  const placements: Array<OrderedHostedPlacement | null> = [];
  for (const occurrenceId of occurrenceIds)
    placements.push(await readVersionedHostedPlacement(client, snapshot, occurrenceId));
  return placements;
}
