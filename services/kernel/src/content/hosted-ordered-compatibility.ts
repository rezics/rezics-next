import type { AccessClient } from '../request/access.ts';
import { ContentNotFoundError } from './commands.ts';
import {
  HOSTED_PLACEMENT_LIMIT,
  InvalidHostedStructureError,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';
import {
  readHostedPublicationOrderedSourcePoints,
  resolveHostedPublicationOrderedSource,
} from './hosted-publication-ordered-source.ts';
import { commitHostedDraftPointWrite, type HostedDraftPointRevisionWrite } from './hosted-version-draft-write.ts';
import { resolveHostedVersionRevision } from './hosted-version-revision.ts';

/** Root append is a canonical path-local point write. Development data is maintained out of band. */
export async function appendHostedOrderedRootChapter(
  client: AccessClient,
  catalogueId: string,
  expectedRevisionId: string,
  revision: HostedDraftPointRevisionWrite,
  chapter: Extract<OrderedHostedPlacement, { kind: 'chapter' }>,
): Promise<void> {
  const resolved = await resolveHostedVersionRevision(client, catalogueId, expectedRevisionId);
  if (resolved.kind === 'missing') throw new ContentNotFoundError();
  if (resolved.revisionKind !== 'structure') throw new InvalidHostedStructureError();
  if (resolved.kind !== 'ordered')
    throw new InvalidHostedStructureError('The draft has no canonical ordered selection');
  if (resolved.snapshot.generationKind !== 'draft') throw new InvalidHostedStructureError();

  await commitHostedDraftPointWrite(client, catalogueId, revision, {
    operation: 'insert',
    expectedRevisionId,
    occurrenceId: chapter.occurrenceId,
    parentId: null,
    beforeOccurrenceId: null,
    title: chapter.title,
    placement: { kind: 'chapter', target: chapter.target },
  });
}

/** Resolve only the explicitly requested members from the canonical ordered draft. */
export async function hostedOrderedReleasePlacements(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
  occurrenceIds: readonly string[],
): Promise<readonly OrderedHostedPlacement[]> {
  if (!Array.isArray(occurrenceIds) || occurrenceIds.length > HOSTED_PLACEMENT_LIMIT)
    throw new InvalidHostedStructureError();
  if (!occurrenceIds.length) return [];

  const source = await resolveHostedPublicationOrderedSource(client, catalogueId, revisionId);
  if (!source) throw new InvalidHostedStructureError('The draft has no canonical ordered selection');
  const selected = await readHostedPublicationOrderedSourcePoints(client, source, occurrenceIds);
  return selected
    .filter((placement): placement is OrderedHostedPlacement => placement !== null)
    .sort((left, right) => left.ordinal - right.ordinal);
}
