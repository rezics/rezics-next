import type { ThreadPageObservation, ThreadPost } from './thread-page';

type Target = { kind: 'thread' | 'post'; id: string };

/** A source observation is advice for its exact viewer and reference, never command authorization. */
export function threadPageReference(page: ThreadPageObservation | undefined, target: Target, post?: ThreadPost) {
  if (page?.currentness.actions !== 'current' || page.actions.state !== 'current') return;
  return page.actions.references.find(
    (reference) =>
      reference.type === `content.${target.kind}` &&
      reference.id === target.id &&
      reference.state === 'current' &&
      (target.kind === 'thread' ||
        (post?.availability === 'available' && reference.sourceRevisionId === post.revisionId)),
  );
}

export function threadPageOperation(
  page: ThreadPageObservation | undefined,
  target: Target,
  operationId: string,
  post?: ThreadPost,
) {
  return threadPageReference(page, target, post)?.operations.find((operation) => operation.operationId === operationId)
    ?.state;
}

export function threadPageViewerMatches(page: ThreadPageObservation, viewerId: string | null | undefined) {
  return page.viewer.kind === 'account' ? page.viewer.id === viewerId : !viewerId;
}
