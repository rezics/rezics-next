import type { ReadContext } from './model.ts';
import { ContentNotFoundError, readPostMetadata, type NativePostMetadata, type RetainContentRead } from './reads.ts';
import type { HostedChapterTarget, HostedDependencies, OrderedHostedPlacement } from './hosted-chapters-model.ts';

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
async function validateTarget(deps: HostedDependencies, target: HostedChapterTarget, context: ReadContext) {
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
}

/** Process each distinct exact target to completion before starting the next.
 * Duplicate placements share admission, including its final native recheck. */
export async function validateHostedChapterAttachments(
  deps: HostedDependencies,
  placements: readonly OrderedHostedPlacement[],
  context: ReadContext,
): Promise<void> {
  const targets = new Map<string, HostedChapterTarget>();
  for (const placement of placements) {
    if (placement.kind !== 'chapter') continue;
    const target = placement.target;
    // A wrong-thread selection must not be shadowed by a later valid placement.
    const key = `${target.threadId}/${target.postId}/${target.revisionId}/${target.sha256}`;
    targets.set(key, target);
  }
  for (const target of targets.values()) await validateTarget(deps, target, context);
}
