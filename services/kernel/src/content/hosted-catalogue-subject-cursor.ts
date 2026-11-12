import { createHash } from 'node:crypto';
import type { CursorBinding } from '../tokens/cursor.ts';
import type { ReadContext } from './model.ts';

function viewerKey(context: ReadContext): string {
  const actor = context.actor;
  if (actor.kind === 'anonymous') return 'anonymous';
  return createHash('sha256')
    .update(
      JSON.stringify([actor.accountId, actor.clientId, actor.requestedBy, actor.authnEpoch, [...actor.scopes].sort()]),
    )
    .digest('hex');
}

export function hostedSubjectCursorBinding(subjectId: string, context: ReadContext, limit: number): CursorBinding {
  return {
    operation: 'content.hosted-catalogue.for-subject',
    parameters: {
      subjectId,
      limit,
      viewer: viewerKey(context),
    },
  };
}
