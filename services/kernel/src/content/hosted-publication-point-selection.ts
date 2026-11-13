import { ContentNotFoundError, RevisionPreconditionError } from './commands.ts';
import {
  HOSTED_DEPTH_LIMIT,
  InvalidHostedStructureError,
  type HostedChapterTarget,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';

export type HostedPublishChapterInput = Readonly<{
  expectedRevisionId: string;
  expectedPublicationId: string;
  occurrenceId: string;
  target: HostedChapterTarget;
  parentId: string | null;
  beforeOccurrenceId: string | null;
  /** Every draft-only part in the source path, in root-to-leaf order, with its public sibling anchor. */
  selectedAncestors: readonly Readonly<{ occurrenceId: string; beforeOccurrenceId: string | null }>[];
}>;

export type HostedReplacePublishedChapterInput = Readonly<{
  expectedRevisionId: string;
  expectedPublicationId: string;
  occurrenceId: string;
  target: HostedChapterTarget;
}>;

export type HostedPublicationPointInput =
  | Readonly<{ kind: 'publishChapter'; input: HostedPublishChapterInput }>
  | Readonly<{ kind: 'replacePublishedChapter'; input: HostedReplacePublishedChapterInput }>;

/** Snapshot-bound point reads supplied by the Book adapter. Every call names the
 * expected immutable version; selection never receives a draft iterator. */
export type HostedPointSelectionReads = Readonly<{
  draftPoint(revisionId: string, occurrenceId: string): Promise<OrderedHostedPlacement | null>;
  publicationPoint(publicationId: string, occurrenceId: string): Promise<OrderedHostedPlacement | null>;
}>;

export type HostedPointSelectedAncestor = Readonly<{
  placement: OrderedHostedPlacement;
  before: OrderedHostedPlacement | null;
}>;

export type HostedPointInsertionSelection = Readonly<{
  kind: 'publishChapter';
  expectedRevisionId: string;
  expectedPublicationId: string;
  chapter: OrderedHostedPlacement;
  ancestors: readonly HostedPointSelectedAncestor[];
  parentId: string | null;
  beforeOccurrenceId: string | null;
  parent: OrderedHostedPlacement | null;
  before: OrderedHostedPlacement | null;
  /** Placement values whose exact targets need current native checks. */
  changedPlacements: readonly OrderedHostedPlacement[];
}>;

export type HostedPointReplacementSelection = Readonly<{
  kind: 'replacePublishedChapter';
  expectedRevisionId: string;
  expectedPublicationId: string;
  /** The current public value supplies the parent, order, title and all untouched fields. */
  publicChapter: OrderedHostedPlacement;
  /** The expected draft value supplies only the exact replacement target. */
  draftChapter: OrderedHostedPlacement;
  changedPlacements: readonly OrderedHostedPlacement[];
}>;

export type HostedPointSelection = HostedPointInsertionSelection | HostedPointReplacementSelection;

type PointReader = (occurrenceId: string) => Promise<OrderedHostedPlacement | null>;

function memoized(reader: PointReader): PointReader {
  const reads = new Map<string, Promise<OrderedHostedPlacement | null>>();
  return (occurrenceId) => {
    let result = reads.get(occurrenceId);
    if (!result) {
      result = reader(occurrenceId);
      reads.set(occurrenceId, result);
    }
    return result;
  };
}

function sameTarget(left: HostedChapterTarget, right: HostedChapterTarget): boolean {
  return (
    left.threadId === right.threadId &&
    left.postId === right.postId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256
  );
}

function samePost(left: HostedChapterTarget, right: HostedChapterTarget): boolean {
  return left.threadId === right.threadId && left.postId === right.postId;
}

function chapter(value: OrderedHostedPlacement | null): value is Extract<OrderedHostedPlacement, { kind: 'chapter' }> {
  return value?.kind === 'chapter';
}

function part(value: OrderedHostedPlacement | null): value is Extract<OrderedHostedPlacement, { kind: 'part' }> {
  return value?.kind === 'part';
}

function requireSelectedChapter(
  value: OrderedHostedPlacement | null,
  target: HostedChapterTarget,
): Extract<OrderedHostedPlacement, { kind: 'chapter' }> {
  if (!chapter(value)) throw new ContentNotFoundError();
  if (!sameTarget(value.target, target)) throw new RevisionPreconditionError();
  return value;
}

async function resolveReplacement(
  reads: HostedPointSelectionReads,
  input: HostedReplacePublishedChapterInput,
): Promise<HostedPointReplacementSelection> {
  const draftPoint = memoized((id) => reads.draftPoint(input.expectedRevisionId, id));
  const publicationPoint = memoized((id) => reads.publicationPoint(input.expectedPublicationId, id));
  const [draftValue, publicValue] = await Promise.all([
    draftPoint(input.occurrenceId),
    publicationPoint(input.occurrenceId),
  ]);
  const draftChapter = requireSelectedChapter(draftValue, input.target);
  if (!chapter(publicValue)) throw new ContentNotFoundError();
  if (!samePost(publicValue.target, draftChapter.target)) throw new RevisionPreconditionError();

  return {
    kind: 'replacePublishedChapter',
    expectedRevisionId: input.expectedRevisionId,
    expectedPublicationId: input.expectedPublicationId,
    publicChapter: publicValue,
    draftChapter,
    changedPlacements: [draftChapter],
  };
}

async function resolveInsertion(
  reads: HostedPointSelectionReads,
  input: HostedPublishChapterInput,
): Promise<HostedPointInsertionSelection> {
  const draftPoint = memoized((id) => reads.draftPoint(input.expectedRevisionId, id));
  const publicationPoint = memoized((id) => reads.publicationPoint(input.expectedPublicationId, id));
  const selected = requireSelectedChapter(await draftPoint(input.occurrenceId), input.target);
  if (await publicationPoint(input.occurrenceId))
    throw new InvalidHostedStructureError('The selected occurrence is already public');

  const leafFirst: OrderedHostedPlacement[] = [];
  const visited = new Set([selected.occurrenceId]);
  let parentId = selected.parentId;
  while (parentId !== null) {
    if (visited.has(parentId)) throw new Error('Hosted draft ancestry contains a cycle');
    visited.add(parentId);
    const ancestor = await draftPoint(parentId);
    if (!part(ancestor)) throw new ContentNotFoundError();
    leafFirst.push(ancestor);
    if (leafFirst.length + 1 > HOSTED_DEPTH_LIMIT)
      throw new InvalidHostedStructureError('The selected chapter exceeds the hosted depth limit');
    parentId = ancestor.parentId;
  }

  const ancestors = leafFirst.reverse();
  const publicAncestors = await Promise.all(ancestors.map((ancestor) => publicationPoint(ancestor.occurrenceId)));
  for (let index = 0; index < ancestors.length; index += 1) {
    const publicAncestor = publicAncestors[index]!;
    if (publicAncestor !== null && !part(publicAncestor))
      throw new Error('Hosted occurrence kind changed between retained versions');
  }

  const missingAncestors = ancestors.filter((_ancestor, index) => publicAncestors[index] === null);
  if (
    input.selectedAncestors.length !== missingAncestors.length ||
    input.selectedAncestors.some((selection, index) => selection.occurrenceId !== missingAncestors[index]?.occurrenceId)
  )
    throw new InvalidHostedStructureError('Every draft-only ancestor must be selected in root-to-leaf order');

  const missingById = new Map(missingAncestors.map((ancestor, index) => [ancestor.occurrenceId, index]));
  const selectedAncestors: HostedPointSelectedAncestor[] = [];
  for (let index = 0; index < missingAncestors.length; index += 1) {
    const placement = missingAncestors[index]!;
    const parent = placement.parentId === null ? null : ((await publicationPoint(placement.parentId)) ?? null);
    const selectedParentIndex = placement.parentId === null ? undefined : missingById.get(placement.parentId);
    const parentIsSelected = selectedParentIndex !== undefined && selectedParentIndex < index;
    if (placement.parentId !== null && !parentIsSelected && !part(parent))
      throw new InvalidHostedStructureError('A selected ancestor must attach to a public or selected part');

    const anchorId = input.selectedAncestors[index]!.beforeOccurrenceId;
    const before = anchorId === null ? null : await publicationPoint(anchorId);
    if (anchorId !== null && (!before || before.parentId !== placement.parentId))
      throw new InvalidHostedStructureError('An ancestor anchor must be a sibling in the expected public snapshot');
    if (parentIsSelected && before !== null)
      throw new InvalidHostedStructureError('A newly selected part has no public sibling anchor');
    selectedAncestors.push({ placement, before });
  }

  const parent = input.parentId === null ? null : ((await publicationPoint(input.parentId)) ?? null);
  const selectedParentIndex = input.parentId === null ? undefined : missingById.get(input.parentId);
  const parentIsSelected = selectedParentIndex !== undefined;
  if (input.parentId !== null && !parentIsSelected && !part(parent))
    throw new InvalidHostedStructureError('The insertion parent must be public or explicitly selected');

  const before = input.beforeOccurrenceId === null ? null : await publicationPoint(input.beforeOccurrenceId);
  if (input.beforeOccurrenceId !== null && (!before || before.parentId !== input.parentId))
    throw new InvalidHostedStructureError('The chapter anchor must be a sibling in the expected public snapshot');
  if (parentIsSelected && before !== null)
    throw new InvalidHostedStructureError('A newly selected parent has no public sibling anchor');

  return {
    kind: 'publishChapter',
    expectedRevisionId: input.expectedRevisionId,
    expectedPublicationId: input.expectedPublicationId,
    chapter: selected,
    ancestors: selectedAncestors,
    parentId: input.parentId,
    beforeOccurrenceId: input.beforeOccurrenceId,
    parent,
    before,
    changedPlacements: [selected],
  };
}

/** Resolve only the selected source, its bounded parent chain and the requested
 * public anchors. The callback contract pins each read to the supplied version
 * IDs, so a draft-only occurrence can never be reinterpreted as a public rank. */
export function selectHostedPublicationPoint(
  reads: HostedPointSelectionReads,
  input: HostedPublicationPointInput,
): Promise<HostedPointSelection> {
  return input.kind === 'publishChapter'
    ? resolveInsertion(reads, input.input)
    : resolveReplacement(reads, input.input);
}
