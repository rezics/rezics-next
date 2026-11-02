import { isDeepStrictEqual } from 'node:util';
import { resolveSubject } from './subject-anchor.ts';
import type { AccountActor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import { ProblemError } from '../http/problem.ts';
import { systemClock } from '../clock.ts';
import { routeOf } from '../route/route.ts';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import { zeroScopeWork } from '../search/scope-execution.ts';
import type { PoolClient } from 'pg';
import { builtinCollectionId } from './builtin-identity.ts';
import { openOwnerQuery, ownerQueryWork, type OwnerQueryDependencies } from './builtin-runtime-query.ts';
import { readOwnerOriginalActivityPrefix, type OwnerActivitySeek } from './owner-index-continue.ts';
import { evaluateContinueGroup, readContinueOriginalFacts } from './continue-source.ts';
import type { ContinuePage, ContinueSubject } from './continue-reads.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';
import type { SpaceSubjectPopulation } from '../content/feed-subject-scope.ts';

type Snapshot = <T>(read: (client: Pick<PoolClient, 'query'>) => Promise<T>) => Promise<T>;
const unavailable = () => new ProblemError('dependency_unavailable');
const compare = (a: OwnerActivitySeek, b: OwnerActivitySeek) =>
  a.lastActivityAt === b.lastActivityAt
    ? a.subjectId < b.subjectId
      ? -1
      : a.subjectId > b.subjectId
        ? 1
        : 0
    : a.lastActivityAt > b.lastActivityAt
      ? -1
      : 1;

/** Native chronological input plus the SAME complete canonical Source used by Collection members.
 * Equal-time original keys are completed before canonical ordering; a raw window is never a useful page.
 */
export async function readContinueOwnerPage(
  deps: OwnerQueryDependencies & { tokens: KeyRing },
  input: {
    actor: AccountActor;
    limit: number;
    cursor?: string;
    view?: 'BASIC' | 'FULL';
    languages?: readonly string[];
    spacePopulation?: SpaceSubjectPopulation;
    kind?: string;
    deadline: number;
    snapshot: Snapshot;
    readVersion: () => Promise<string>;
  },
): Promise<ContinuePage> {
  const clock = deps.clock ?? systemClock;
  const binding = {
    route: 'GET /v1/libraryContinue',
    viewer: input.actor.accountId,
    query: {
      limit: input.limit,
      source: 'owner-active-state-session',
      ...(input.spacePopulation
        ? {
            spaceId: input.spacePopulation.observation.spaceId,
            spaceObservation: JSON.stringify(input.spacePopulation.observation),
          }
        : {}),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    },
  };
  const cursor =
    input.cursor === undefined ? null : await decodeListCursor(deps.tokens, binding, input.cursor, clock());
  if (
    cursor &&
    (!cursor.ok ||
      cursor.after.length !== 4 ||
      cursor.after.some((value) => typeof value !== 'string') ||
      routeOf(String(cursor.after[3])) === null)
  )
    throw new ProblemError('invalid_cursor');
  const work = ownerQueryWork(input.limit);
  const collectionId = builtinCollectionId(input.actor.accountId, {
    kind: 'everything',
  });
  const query = await openOwnerQuery(deps, {
    actor: input.actor,
    collectionId,
    deadline: input.deadline,
    work,
    logical: true,
  });
  try {
    const observation = query.source.observation;
    const version = await input.readVersion();
    let floor: OwnerActivitySeek | null = null;
    if (cursor?.ok) {
      if (
        cursor.epoch !== observation.stamp.epoch ||
        cursor.after[0] !== observation.basis.digest ||
        cursor.after[1] !== version
      )
        throw new ProblemError('stale_cursor');
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(String(cursor.after[2])))
        throw new ProblemError('invalid_cursor');
      floor = {
        lastActivityAt: String(cursor.after[2]),
        subjectId: String(cursor.after[3]),
      };
    }
    const rows = new Map<string, ContinueSubject>();
    const selectionSummaries = new Map<string, SubjectSummary | null>();
    const zero = '00000000-0000-0000-0000-000000000000';
    // Resume at the timestamp boundary: original order cannot substitute for canonical tie order.
    let after: OwnerActivitySeek | null = floor ? { lastActivityAt: floor.lastActivityAt, subjectId: zero } : null;
    let exhausted = false;
    let completed: ContinueSubject[] = [];
    async function selectPopulation(values: readonly ContinueSubject[]) {
      let selected = [...values];
      if (input.spacePopulation && selected.length) {
        const members = await input.spacePopulation.contains(selected.map((row) => row.subjectId));
        selected = selected.filter((_row, index) => members[index]);
      }
      if (input.kind !== undefined && selected.length) {
        if (!deps.routeKey || deps.routeKey.byteLength < 32) throw unavailable();
        const missing = selected.filter((row) => !selectionSummaries.has(row.subjectId));
        if (missing.length) {
          const current = await readSubjectSummaries(
            {
              pool: deps.pool,
              access: deps.access,
              actor: input.actor,
              routeKey: deps.routeKey,
              deadline: input.deadline,
            },
            missing.map((row) => row.subjectId),
            { languages: input.languages ?? [] },
          );
          for (const row of missing) selectionSummaries.set(row.subjectId, current.get(row.subjectId) ?? null);
        }
        selected = selected.filter((row) => selectionSummaries.get(row.subjectId)?.type === input.kind);
      }
      return selected;
    }
    async function readGroup(runtime: typeof query, subjectId: string) {
      const membership = await runtime.native.containsSubject({
        ...runtime.context,
        source: runtime.source,
        subjectId,
        allowance: work.remaining(),
      });
      work.native(membership.work);
      if (membership.result === 'not_proven') throw unavailable();
      if (!membership.result) return null;
      const complete = await runtime.originals(subjectId);
      if (!complete.length) throw unavailable();
      const originals: string[] = [];
      for (const original of complete) {
        work.consume({
          ...zeroScopeWork(),
          nativeRows: 8192,
          nativePoints: 128,
          statements: 128,
          bytes: 1024 * 1024,
        });
        const resolved = await resolveSubject(deps, input.actor, original, runtime.context.at, {
          pool: deps.pool,
          deadline: input.deadline,
        });
        if (resolved?.subjectId === subjectId) originals.push(original);
      }
      if (!originals.length) return null;
      // The existing native helpers bound each original's truth and top active session. Immutable release reads
      // run only after this owner snapshot is released, and use the same finite request ledger.
      work.consume({
        ...zeroScopeWork(),
        candidateKeys: originals.length,
        nativePoints: 12 * originals.length,
        nativeRows: 128 * originals.length,
        statements: 8 * originals.length,
        bytes: 32768 * originals.length,
      });
      const facts = await input.snapshot(async (client) => {
        const facts = [];
        for (const original of originals)
          facts.push(await readContinueOriginalFacts(client, input.actor.accountId, original));
        return facts;
      });
      work.consume({
        ...zeroScopeWork(),
        nativePoints: 2 * originals.length,
        nativeRows: 2 * originals.length,
        statements: 2 * originals.length,
        bytes: 262144 * 2 * originals.length,
      });
      return evaluateContinueGroup(deps.pool, subjectId, facts);
    }
    for (let round = 0; round < 3; round++) {
      const quota = Math.min(100, 2 * (input.limit - completed.length) + 1, work.remaining().remaining.candidateKeys);
      if (quota < 1) throw unavailable();
      work.consume({
        ...zeroScopeWork(),
        candidateKeys: quota,
        nativeRows: 8 * quota + 16,
        nativePoints: 3,
        statements: 3,
        bytes: 256 * quota + 4096,
      });
      const raw = await input.snapshot((client) =>
        readOwnerOriginalActivityPrefix(client, input.actor.accountId, after, quota),
      );
      exhausted = raw.length < quota;
      if (raw.length) {
        // Known-ID mapping locates a candidate only. Source membership and the complete group above establish coverage.
        work.consume({
          ...zeroScopeWork(),
          identityMetadataRows: 16 * raw.length,
          nativePoints: 8 * raw.length,
          statements: 32 * raw.length,
          bytes: 8192 * raw.length,
        });
        const mappings = await readIdentityMappings(
          deps.pool,
          raw.map((row) => row.subjectId),
        );
        for (let i = 0; i < raw.length; i++) {
          const mapping = mappings[i];
          if (!mapping || mapping.state === 'pending' || mapping.state === 'unavailable') throw unavailable();
          if (mapping.state === 'absent') continue;
          const subjectId = mapping.terminal;
          if (rows.has(subjectId)) continue;
          const value = await readGroup(query, subjectId);
          if (!value || (floor && compare(value, floor) <= 0)) continue;
          // Older alias activity does not create another canonical occurrence.
          if (value.lastActivityAt !== raw[i]!.lastActivityAt) continue;
          rows.set(subjectId, value);
        }
        after = raw.at(-1)!;
      }
      completed = await selectPopulation(
        [...rows.values()].filter((value) => exhausted || (after !== null && value.lastActivityAt > after.lastActivityAt)),
      );
      completed.sort(compare);
      if (exhausted || completed.length > input.limit) break;
    }
    if (!exhausted && completed.length <= input.limit) throw unavailable();
    const shown = completed.slice(0, input.limit);
    let summaries: Awaited<ReturnType<typeof readSubjectSummaries>> | null = null;
    if (input.view === 'FULL') {
      if (!deps.routeKey || deps.routeKey.byteLength < 32) throw unavailable();
      summaries = await readSubjectSummaries(
        {
          pool: deps.pool,
          access: deps.access,
          actor: input.actor,
          routeKey: deps.routeKey,
          deadline: input.deadline,
        },
        shown.map((row) => row.subjectId),
        { languages: input.languages ?? [] },
      );
    }
    const final = await openOwnerQuery(deps, {
      actor: input.actor,
      collectionId,
      deadline: input.deadline,
      work,
      logical: true,
    });
    try {
      if (!isDeepStrictEqual(final.source.observation, observation)) throw new ProblemError('semantic_not_ready');
      for (const row of shown) {
        const current = await readGroup(final, row.subjectId);
        if (JSON.stringify(current) !== JSON.stringify(row)) throw new ProblemError('semantic_not_ready');
      }
      if ((await input.readVersion()) !== version) throw new ProblemError('semantic_not_ready');
    } finally {
      final.close();
    }
    if (input.kind !== undefined && shown.length) {
      const finalSummaries = await readSubjectSummaries(
        {
          pool: deps.pool,
          access: deps.access,
          actor: input.actor,
          routeKey: deps.routeKey!,
          deadline: input.deadline,
        },
        shown.map((row) => row.subjectId),
        { languages: input.languages ?? [] },
      );
      for (const row of shown)
        if (
          finalSummaries.get(row.subjectId)?.type !== input.kind ||
          selectionSummaries.get(row.subjectId)?.type !== input.kind
        )
          throw new ProblemError('semantic_not_ready');
      summaries = finalSummaries;
    }
    await input.spacePopulation?.finish();
    return {
      subjects:
        summaries === null ? shown : shown.map((row) => ({ ...row, subject: summaries.get(row.subjectId) ?? null })),
      next:
        completed.length > input.limit
          ? await encodeListCursor(
              deps.tokens,
              binding,
              {
                epoch: observation.stamp.epoch,
                after: [observation.basis.digest, version, shown.at(-1)!.lastActivityAt, shown.at(-1)!.subjectId],
              },
              clock(),
            )
          : null,
    };
  } finally {
    query.close();
  }
}
