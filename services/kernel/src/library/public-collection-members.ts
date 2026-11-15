import { randomUUID } from 'node:crypto';
import { repeatBound, sumBounds } from '@rezics/bounds';
import { systemClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  readSelectedPublicIdentityOutput,
  type PublicOutputOriginalKey,
} from '../semantic/identity-public-output-capture.ts';
import { publicOutputReadWork } from '../semantic/identity-public-output-work.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import { authorizeNativeCollectionMetadata, readNativeCollectionMetadata } from './collection-source-native.ts';
import { ordinaryCollectionPagePlan, ordinaryPageWorkDimensions } from './ordinary-read-bounds.ts';
import { withCollectionReadConnection } from './collection-read-connection.ts';
import { requireLibraryDomain } from './domain-binding.ts';
import { mapPresentationBounded } from './application/presentation-bounds.ts';
import { resolveSubject, SubjectIdentityUnavailableError } from './subject-anchor.ts';

const lastOriginal = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const refillRounds = 3;

/** The public branch pages only the selected, sealed output. Its original witnesses still require live disclosure. */
export async function readPublicCollectionMembers(
  deps: OwnerQueryDependencies & { tokens: KeyRing },
  input: {
    actor: Actor;
    collectionId: string;
    sourceGeneration: string;
    limit: number;
    cursor?: string | null;
    deadline: number;
    view?: 'BASIC' | 'FULL';
    languages?: readonly string[];
    revalidate: () => Promise<void>;
  },
) {
  const route = routeOf(input.collectionId);
  if (route === null) throw new ProblemError('not_found');
  const nativeOutput = requireLibraryDomain().nativePublicOutput;
  if (!nativeOutput) throw new ProblemError('dependency_unavailable');
  const clock = deps.clock ?? systemClock;
  const binding = {
    route: 'GET /v1/collections/:collectionId/members',
    viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
    query: { collectionId: input.collectionId, limit: input.limit, order: 'id', source: 'activated_output' },
  };
  const position = input.cursor == null ? null : await decodeListCursor(deps.tokens, binding, input.cursor, clock());
  if (
    position &&
    (!position.ok ||
      position.after.length !== 4 ||
      position.after.some((value) => typeof value !== 'string') ||
      routeOf(String(position.after[3])) === null)
  )
    throw new ProblemError('invalid_cursor');

  const ordinary = ordinaryCollectionPagePlan(input.limit, input.view);
  const publicRead = publicOutputReadWork(refillRounds + 1);
  const work = new NativeCollectionWork(
    {
      reservationId: randomUUID(),
      remaining: ordinaryPageWorkDimensions(
        sumBounds({ ...publicRead, engineRequests: 0 }, repeatBound(ordinary.sourceBound, 4)),
      ),
    },
    input.deadline,
  );
  const authorize = async (at: AuthoritativeTime) => {
    const { metadata } = await work.compose((allowance) =>
      readNativeCollectionMetadata(
        deps.pool,
        { route, collectionId: input.collectionId },
        { deadline: input.deadline, allowance },
      ),
    );
    if (!metadata || metadata.visibility === 'private') throw new ProblemError('not_found');
    const { authorized } = await work.compose((allowance) =>
      authorizeNativeCollectionMetadata(deps.pool, metadata, {
        deadline: input.deadline,
        allowance,
        access: deps.access,
        actor: input.actor,
        at,
      }),
    );
    if (!authorized) throw new ProblemError('not_found');
    // The exact selected seal is resolved independently by seek, including an account-free frozen successor.
    if (metadata.sourceGeneration !== input.sourceGeneration)
      throw new ProblemError(position ? 'stale_cursor' : 'dependency_unavailable');
  };
  const seek = async (after: PublicOutputOriginalKey | null, limit: number) => {
    const result = await work.compose((allowance) =>
      readSelectedPublicIdentityOutput(
        deps.pool,
        { collectionId: input.collectionId, sourceGeneration: input.sourceGeneration, after, limit },
        { deadline: input.deadline, allowance },
        nativeOutput,
      ),
    );
    if (result.status !== 'ready')
      throw new ProblemError(position ? 'stale_cursor' : 'dependency_unavailable');
    return result;
  };
  const versionOf = (page: Awaited<ReturnType<typeof seek>>) =>
    JSON.stringify([page.epoch, page.generation, page.digest, input.sourceGeneration]);
  let after: PublicOutputOriginalKey | null = position
    ? { terminal: String(position.after[3]), original: lastOriginal }
    : null;
  const mintTime = () =>
    withCollectionReadConnection(deps.pool, input.deadline, (client) => mintReadTime(client, clock));
  const at = await mintTime();
  const disclose = (rows: readonly PublicOutputOriginalKey[], time: AuthoritativeTime) =>
    mapPresentationBounded(rows, async ({ original, terminal }) => {
      const resolved = await resolveSubject(deps, input.actor, original, time, {
        pool: deps.pool,
        deadline: input.deadline,
      }).catch((error: unknown) => {
        if (error instanceof SubjectIdentityUnavailableError) throw new ProblemError('dependency_unavailable');
        throw error;
      });
      if (resolved && resolved.subjectId !== terminal) throw new ProblemError('semantic_not_ready');
      return resolved !== null;
    });
  const disclosed: { rows: readonly PublicOutputOriginalKey[]; readable: boolean[] }[] = [];
  const members: { kind: 'dynamic'; subjectId: string }[] = [];
  let terminal: string | null = null;
  let visible = false;
  let exhausted = false;
  const append = () => {
    if (terminal !== null && visible) members.push({ kind: 'dynamic', subjectId: terminal });
  };
  let first: Awaited<ReturnType<typeof seek>>;
  let version: string;
  const rawLimit = Math.min(100, 2 * input.limit + 1);
  try {
    await authorize(at);
    first = await seek(after, rawLimit);
    version = versionOf(first);
    if (
      position &&
      (position.epoch !== first.epoch ||
        position.after[0] !== first.generation ||
        position.after[1] !== first.digest ||
        position.after[2] !== input.sourceGeneration)
    )
      throw new ProblemError('stale_cursor');

    for (let round = 0; round < refillRounds; round++) {
      const page = round === 0 ? first : await seek(after, rawLimit);
      if (versionOf(page) !== version) throw new ProblemError('stale_cursor');
      if (page.more && page.rows.length === 0) throw new ProblemError('dependency_unavailable');
      const readable = await disclose(page.rows, at);
      disclosed.push({ rows: page.rows, readable });
      for (const [index, row] of page.rows.entries()) {
        if (row.terminal !== terminal) {
          append();
          if (members.length > input.limit) break;
          terminal = row.terminal;
          visible = false;
        }
        if (readable[index]) visible = true;
      }
      if (members.length > input.limit) break;
      if (!page.more) {
        append();
        exhausted = true;
        break;
      }
      after = page.rows.at(-1)!;
    }
  } finally {
    releaseOperationalTime(at);
  }
  if (!exhausted && members.length <= input.limit) throw new ProblemError('dependency_unavailable');
  const shown = members.slice(0, input.limit);
  const revalidate = async () => {
    const finalAt = await mintTime();
    try {
      await authorize(finalAt);
      for (const { rows, readable } of disclosed) {
        const current = await disclose(rows, finalAt);
        if (current.some((value, index) => value !== readable[index])) throw new ProblemError('semantic_not_ready');
      }
    } finally {
      releaseOperationalTime(finalAt);
    }
    if (versionOf(await seek(null, 0)) !== version) throw new ProblemError('stale_cursor');
    await input.revalidate();
  };
  let result: readonly { kind: 'dynamic'; subjectId: string }[] = shown;
  if (input.view === 'FULL') {
    if (!deps.routeKey) throw new ProblemError('dependency_unavailable');
    result = await attachCollectionListFacts(
      { ...deps, routeKey: deps.routeKey, actor: input.actor, deadline: input.deadline },
      shown,
      { revalidate, ...(input.languages === undefined ? {} : { languages: input.languages }) },
    );
    if (result.length !== shown.length) throw new ProblemError('semantic_not_ready');
  } else await revalidate();
  const next =
    members.length > input.limit
      ? await encodeListCursor(
          deps.tokens,
          binding,
          {
            epoch: first.epoch,
            after: [first.generation, first.digest, input.sourceGeneration, shown.at(-1)!.subjectId],
          },
          clock(),
        )
      : null;
  return { members: [...result], next };
}
