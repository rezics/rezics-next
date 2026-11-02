import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { subjectReactionKinds } from '../../threads/reaction-request';

export type SubjectReactionKind = (typeof subjectReactionKinds)[number];

export type SubjectReactions = {
  counts: Partial<Record<SubjectReactionKind, number>>;
  /** The reader's own reaction; null while private data is unavailable or for a signed-out reader. */
  value: SubjectReactionKind | null;
  /** Present only when this value came from a private read prepared for this actual reader. */
  reader?: string;
};

export type SubjectOwnReaction = { reader: string; value: SubjectReactionKind | null };

export async function readReactionCounts(client: KernelClient, id: string): Promise<SubjectReactions | null> {
  const counts = await client
    .subjects({ id })
    .reactions.get()
    .catch(() => null);
  if (counts?.status !== 200 || !isNativeReactionCountPage(counts.data)) return null;
  const shown: SubjectReactions['counts'] = {};
  for (const { kind, count } of counts.data.counts) if (admitted.has(kind)) shown[kind as SubjectReactionKind] = count;
  return { counts: shown, value: null };
}

export async function readOwnReaction(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
  expectedReader?: string | null,
): Promise<SubjectOwnReaction | null> {
  if (!expectedReader) return null;
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const reader = sessionSubject(request);
    if (!authorization || !reader || reader !== expectedReader) return null;
    // Capture the identity from the same preparation that supplied this request's credential.
    const preparedReader = reader;
    const own = await (client.subjects({ id }) as unknown as OwnReactionRoute).reaction.get({
      headers: { authorization },
    });
    if (own.status !== 200 || !isOwnReactionResponse(own.data)) return null;
    if (own.data.kind === null) return { reader: preparedReader, value: null };
    if (typeof own.data.kind !== 'string' || !admitted.has(own.data.kind)) return null;
    return { reader: preparedReader, value: own.data.kind as SubjectReactionKind };
  } catch {
    return null;
  }
}

/** `GET /v1/subjects/{id}/reaction`, which the generated client declarations do not carry yet. */
type OwnReactionRoute = {
  reaction: {
    get(options: { headers: { authorization: string } }): Promise<{ status: number; data?: unknown }>;
  };
};

function isOwnReactionResponse(value: unknown): value is { kind: string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'kind') &&
    ((value as { kind?: unknown }).kind === null || typeof (value as { kind?: unknown }).kind === 'string')
  );
}

const admitted = new Set<string>(subjectReactionKinds);
const nativeReactionKinds = new Set<string>([...subjectReactionKinds, 'upvote', 'downvote']);

type NativeReactionCountPage = {
  counts: { kind: string; count: number }[];
  watermark: { epoch: number; position: string } | null;
};

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isNativeReactionCountPage(value: unknown): value is NativeReactionCountPage {
  if (!hasExactKeys(value, ['counts', 'watermark']) || !Array.isArray(value.counts)) return false;
  if (
    value.watermark !== null &&
    (!hasExactKeys(value.watermark, ['epoch', 'position']) ||
      typeof value.watermark.epoch !== 'number' ||
      !Number.isSafeInteger(value.watermark.epoch) ||
      value.watermark.epoch < 1 ||
      typeof value.watermark.position !== 'string' ||
      !/^[1-9][0-9]*$/.test(value.watermark.position))
  )
    return false;

  const seen = new Set<string>();
  for (const row of value.counts) {
    if (
      !hasExactKeys(row, ['kind', 'count']) ||
      typeof row.kind !== 'string' ||
      !nativeReactionKinds.has(row.kind) ||
      seen.has(row.kind) ||
      typeof row.count !== 'number' ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1
    )
      return false;
    seen.add(row.kind);
  }
  return true;
}

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
  expectedReader?: string | null,
): Promise<SubjectReactions | null> {
  const [counts, own] = await Promise.all([
    readReactionCounts(client, id),
    readOwnReaction(client, request, sessionEnv, id, expectedReader),
  ]);
  return counts ? { ...counts, value: own?.value ?? null, ...(own ? { reader: own.reader } : {}) } : null;
}
