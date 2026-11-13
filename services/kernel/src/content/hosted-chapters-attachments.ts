import type { ReadContext } from './model.ts';
import { ContentNotFoundError, readPostMetadata, type NativePostMetadata, type RetainContentRead } from './reads.ts';
import type { ContentReadDependencies } from './reads.ts';
import type { HostedChapterTarget, OrderedHostedPlacement } from './hosted-chapters-model.ts';

type AttachmentReadDependencies = Pick<ContentReadDependencies, 'pool' | 'access' | 'clock' | 'disclosureBarrier'>;

function matches(value: NativePostMetadata | null, target: HostedChapterTarget): value is NativePostMetadata {
  return (
    value !== null &&
    value.id === target.postId &&
    value.threadId === target.threadId &&
    value.revisionId === target.revisionId &&
    value.sha256 === target.sha256
  );
}

/** Validate an attachment's stored identity under native disclosure. The retained
 * check binds the original source observation and prepared ancestry/Access checks;
 * reading the head again would lose that observation. Neither check selects bytes.
 * This is write admission only, not proof of bytes delivered to a reader. */
async function validateTarget(
  deps: AttachmentReadDependencies,
  target: HostedChapterTarget,
  context: ReadContext,
): Promise<NativePostMetadata> {
  const observation: { current?: Parameters<RetainContentRead<NativePostMetadata>>[0] } = {};
  const initial = await readPostMetadata(
    deps,
    target.threadId,
    target.postId,
    context,
    target.revisionId,
    (current) => {
      observation.current = current;
    },
  );
  if (!matches(initial.value, target) || !observation.current) throw new ContentNotFoundError();
  const original = initial.value;
  const final = await observation.current();
  if (
    !matches(final.value, target) ||
    final.value.authorId !== original.authorId ||
    final.value.licence !== original.licence
  )
    throw new ContentNotFoundError();
  return final.value;
}

export type HostedChapterAttachmentObservation = Readonly<{
  target: HostedChapterTarget;
  authorId: string;
  licence: string;
}>;

/** Process each distinct exact target to completion before starting the next.
 * The returned values are source observations only: they are not a retained
 * eligibility or activation proof. */
export async function observeHostedChapterAttachments(
  deps: AttachmentReadDependencies,
  placements: readonly OrderedHostedPlacement[],
  context: ReadContext,
): Promise<readonly HostedChapterAttachmentObservation[]> {
  const targets = new Map<string, HostedChapterTarget>();
  for (const placement of placements) {
    if (placement.kind !== 'chapter') continue;
    const target = placement.target;
    // A wrong-thread selection must not be shadowed by a later valid placement.
    const key = `${target.threadId}/${target.postId}/${target.revisionId}/${target.sha256}`;
    targets.set(key, target);
  }
  const observations: HostedChapterAttachmentObservation[] = [];
  for (const target of targets.values()) {
    const metadata = await validateTarget(deps, target, context);
    observations.push({ target, authorId: metadata.authorId, licence: metadata.licence });
  }
  return observations;
}

/** Validate an attachment's identity for existing write admission callers.
 * Neither this result nor a persisted observation selects bytes or grants access. */
export async function validateHostedChapterAttachments(
  deps: AttachmentReadDependencies,
  placements: readonly OrderedHostedPlacement[],
  context: ReadContext,
): Promise<void> {
  await observeHostedChapterAttachments(deps, placements, context);
}
