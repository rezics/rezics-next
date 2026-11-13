import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { RevisionPreconditionError } from './commands.ts';
import { InvalidHostedStructureError, type HostedChapterTarget } from './hosted-chapters-model.ts';
import type { HostedVersionPointValue } from './hosted-version-draft-write.ts';
import {
  HostedVersionHeadChangedError,
  InvalidHostedVersionIdentityError,
  type HostedVersionSnapshot,
} from './hosted-version-model.ts';
import {
  HostedVersionRevisionPointerChangedError,
  commitHostedVersionRevision,
  resolveHostedVersionRevision,
} from './hosted-version-revision.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
} from './hosted-version-store.ts';
import {
  rankVersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';

export type HostedVersionDraftUpdateWrite = Readonly<{
  revisionId: string;
  expectedRevisionId: string;
  occurrenceId: string;
  title: string;
  target: HostedChapterTarget | null;
  transactionId: string;
  recordedAt: string;
}>;

type HostedOccurrenceIdentity = Readonly<{
  kind: 'part' | 'chapter';
  thread_id: string | null;
  post_id: string | null;
}>;

function updateError(error: unknown): never {
  if (error instanceof HostedVersionHeadChangedError || error instanceof HostedVersionRevisionPointerChangedError)
    throw new RevisionPreconditionError();
  if (error instanceof InvalidHostedVersionIdentityError)
    throw new InvalidHostedStructureError('Invalid hosted version identity');
  throw error;
}

function nextPointValue(
  current: HostedVersionPointValue,
  identity: HostedOccurrenceIdentity,
  title: string,
  target: HostedChapterTarget | null,
): HostedVersionPointValue {
  if (identity.kind !== current.kind) throw new Error('Hosted draft update identity kind changed');
  if (current.kind === 'part') {
    if (current.target !== null || identity.thread_id !== null || identity.post_id !== null) {
      throw new Error('Hosted draft update part identity is inconsistent');
    }
    if (target !== null) {
      throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    }
    return { ...current, title };
  }
  if (
    current.target === null ||
    identity.thread_id === null ||
    identity.post_id === null ||
    current.target.threadId !== identity.thread_id ||
    current.target.postId !== identity.post_id
  ) {
    throw new Error('Hosted draft update chapter identity is inconsistent');
  }
  if (target === null) {
    throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  }
  if (identity.thread_id !== target.threadId || identity.post_id !== target.postId) {
    throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  }
  return { ...current, title, target };
}

async function replaceIndexValue(
  access: VersionedOutlineSequenceReadWriteSet<HostedVersionPointValue>,
  rootId: string | null,
  occurrenceId: string,
  value: HostedVersionPointValue,
): Promise<void> {
  const node = await access.readNode(occurrenceId);
  if (node === null) throw new Error('Hosted draft update occurrence is missing from an index');
  if ((await rankVersionedOutlineSequenceNode(access, rootId, occurrenceId)) === null) {
    throw new Error('Hosted draft update occurrence is outside its selected index root');
  }
  access.writeNode({ ...node, value });
}

/** Update one temporal occurrence value and its selected index payloads through one final-per-key overlay. */
export async function commitHostedVersionDraftUpdate(
  client: AccessClient,
  catalogueId: string,
  write: HostedVersionDraftUpdateWrite,
): Promise<HostedVersionSnapshot> {
  try {
    const descriptor = await resolveHostedVersionRevision(client, catalogueId, write.expectedRevisionId);
    if (
      descriptor.kind !== 'ordered' ||
      descriptor.revisionKind !== 'structure' ||
      descriptor.snapshot.generationKind !== 'draft'
    ) {
      throw new RevisionPreconditionError();
    }

    const snapshot = await readHostedVersionSnapshot(
      client,
      catalogueId,
      descriptor.snapshot.generationId,
      descriptor.snapshot.sequence,
    );
    if (!snapshot) throw new Error('Hosted draft update snapshot is missing');
    if (
      snapshot.route !== descriptor.snapshot.route ||
      snapshot.catalogueId !== descriptor.snapshot.catalogueId ||
      snapshot.generationId !== descriptor.snapshot.generationId ||
      snapshot.generationKind !== 'draft' ||
      snapshot.sequence !== descriptor.snapshot.sequence
    ) {
      throw new InvalidHostedVersionIdentityError();
    }

    const route = routeOf(catalogueId);
    if (route === null || routeOf(write.occurrenceId) !== route) {
      throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    }
    const occurrence = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, write.occurrenceId);
    if (!occurrence) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    const identity = (
      await client.query<HostedOccurrenceIdentity>(
        `SELECT kind,thread_id,post_id FROM content.hosted_occurrence
         WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3`,
        [route, catalogueId, write.occurrenceId],
      )
    ).rows[0];
    if (!identity) throw new Error('Hosted draft update occurrence has no permanent identity');
    const value = nextPointValue(occurrence.value, identity, write.title, write.target);

    const storeWrite = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
    const siblings = hostedVersionSequence(storeWrite, 'sibling');
    const preorder = hostedVersionSequence(storeWrite, 'preorder');
    const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, occurrence.parentOccurrenceId);
    await replaceIndexValue(siblings, siblingRoot?.rootNodeId ?? null, write.occurrenceId, value);
    await replaceIndexValue(preorder, snapshot.preorderRootId, write.occurrenceId, value);
    if (occurrence.value.kind === 'chapter') {
      await replaceIndexValue(
        hostedVersionSequence(storeWrite, 'chapter'),
        snapshot.chapterRootId,
        write.occurrenceId,
        value,
      );
    }

    stageHostedVersionOccurrence(storeWrite, write.occurrenceId, {
      parentOccurrenceId: occurrence.parentOccurrenceId,
      subtreeSize: occurrence.subtreeSize,
      value,
    });
    const committed = await commitHostedVersionWrite(client, storeWrite);
    await commitHostedVersionRevision(client, {
      revisionKind: 'structure',
      revisionId: write.revisionId,
      snapshot: {
        route: committed.route,
        catalogueId: committed.catalogueId,
        generationId: committed.generationId,
        generationKind: 'draft',
        sequence: committed.sequence,
      },
      expectedDraftRevisionId: write.expectedRevisionId,
      recordedTransactionId: write.transactionId,
      recordedAt: write.recordedAt,
    });
    return committed;
  } catch (error) {
    updateError(error);
  }
}
