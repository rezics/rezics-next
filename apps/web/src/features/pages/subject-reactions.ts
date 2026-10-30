import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { subjectReactionKinds } from '../../threads/reaction-request';

export type SubjectReactionKind = (typeof subjectReactionKinds)[number];

export type SubjectReactions = {
  counts: Partial<Record<SubjectReactionKind, number>>;
  /** The reader's own reaction; always null for a signed-out reader. */
  value: SubjectReactionKind | null;
};

export async function readReactionCounts(client: KernelClient, id: string): Promise<SubjectReactions | null> {
  const counts = await client
    .subjects({ id })
    .reactions.get()
    .catch(() => null);
  if (counts?.status !== 200 || !counts.data) return null;
  const shown: SubjectReactions['counts'] = {};
  for (const { kind, count } of counts.data.counts) if (admitted.has(kind)) shown[kind as SubjectReactionKind] = count;
  return { counts: shown, value: null };
}

export async function readOwnReaction(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<SubjectReactionKind | null> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return null;
    const own = await (client.subjects({ id }) as unknown as OwnReactionRoute).reaction
      .get({ headers: { authorization } })
      .catch(() => null);
    const kind = own?.status === 200 ? own.data?.kind : null;
    return kind && admitted.has(kind) ? (kind as SubjectReactionKind) : null;
  } catch {
    return null;
  }
}

/** `GET /v1/subjects/{id}/reaction`, which the generated client declarations do not carry yet. */
type OwnReactionRoute = {
  reaction: {
    get(options: {
      headers: { authorization: string };
    }): Promise<{ status: number; data?: { kind: string | null } | null }>;
  };
};

const admitted = new Set<string>(subjectReactionKinds);

/**
 * The subject's reaction counts, and the reader's own reaction when they are signed in: one read each, so the cost
 * does not depend on how many people reacted. A failed count read is `null` and hides the cluster's numbers; a failed
 * read of the reader's own reaction leaves it unset.
 */
export async function loadSubjectReactions(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<SubjectReactions | null> {
  const [counts, own] = await Promise.all([
    readReactionCounts(client, id),
    readOwnReaction(client, request, sessionEnv, id),
  ]);
  return counts ? { ...counts, value: own } : null;
}
