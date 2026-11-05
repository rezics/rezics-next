import {
  runCommand,
  authoritativeTimeValue,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandEvent,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Access } from '../request/access.ts';
import { resolveSubject } from '../semantic/subject-anchor.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { Pool } from 'pg';
import readPage from './subject-reaction-merge-page.sql';
import readSlots from './subject-reaction-merge-slots.sql';
import slotStatement from './reaction-slot.sql';

export const SUBJECT_REACTION_MERGE_PAGE_SIZE = 100;
const FIRST_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export type SubjectReactionMergeInput = Readonly<{ id: string; survivor: string }>;
export type SubjectReactionMergePage = Readonly<{ cursor: string | null; complete: boolean }>;

type Dependencies = Readonly<{ pool: Pool; access: Access }>;

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid subject reaction merge identity');
  return value;
}

class Unchanged extends Error {}

async function mergeActorReaction(
  deps: Dependencies,
  actorId: string,
  mergedId: string,
  eventSurvivor: string,
): Promise<void> {
  const actorRoute = route(actorId);
  const mergedRoute = route(mergedId);
  route(eventSurvivor);
  if (mergedId === eventSurvivor) throw new TypeError('A merged subject cannot survive itself');

  let resolvedSurvivor: string | null = null;
  const authorization = {
    action: 'content:subject-reaction-merge',
    resource: { route: actorRoute, id: actorId },
    denied: () => new Error('Subject reaction merge is unavailable'),
    async prepare(attempt: { time: AuthoritativeTime }) {
      const resolved = await resolveSubject(
        { pool: deps.pool, access: deps.access },
        { kind: 'anonymous' },
        mergedId,
        attempt.time,
      );
      if (!resolved || resolved.subjectId === mergedId) throw new Error('Merged subject has no visible survivor');
      resolvedSurvivor = resolved.subjectId;
      return resolved.subjectId;
    },
    async authorize(_tx: CommandTransaction, _attempt: CommandAttempt, evidence: unknown) {
      if (typeof evidence !== 'string' || evidence !== resolvedSurvivor)
        throw new Error('Subject reaction merge resolution changed');
      return 'execute' as const;
    },
  };

  try {
    await runCommand(deps.pool, { partition: partitionOf(actorRoute), authorization }, async (tx, command) => {
      const survivorId = resolvedSurvivor;
      if (!survivorId) throw new Error('Subject reaction merge has no resolved survivor');
      const survivorRoute = route(survivorId);
      const slots = await readSlots.run(tx, {
        route: actorRoute,
        actor_id: actorId,
        merged_id: mergedId,
        survivor_id: survivorId,
      });
      const merged = slots.find((slot) => slot.target_id === mergedId);
      if (!merged) throw new Unchanged();
      if (slots.some((slot) => slot.target_id === survivorId && slot.kind === null))
        throw new TypeError('Invalid survivor reaction slot');
      const kept = slots.find((slot) => slot.target_id === survivorId);
      const at = authoritativeTimeValue(command.time);
      await slotStatement.run(tx, {
        route: actorRoute,
        actor_id: actorId,
        target_kind: 'subject',
        target_route: mergedRoute,
        target_id: mergedId,
        kind: null,
        at,
      });
      const events: CommandEvent[] = [
        {
          type: 'com.rezics.content.reaction.changed.v1',
          subject: mergedId,
          data: {
            actorId,
            targetKind: 'subject',
            targetId: mergedId,
            previousKind: merged.kind,
            kind: null,
          },
        },
      ];
      if (!kept) {
        await slotStatement.run(tx, {
          route: actorRoute,
          actor_id: actorId,
          target_kind: 'subject',
          target_route: survivorRoute,
          target_id: survivorId,
          kind: merged.kind,
          at,
        });
        events.push({
          type: 'com.rezics.content.reaction.changed.v1',
          subject: survivorId,
          data: {
            actorId,
            targetKind: 'subject',
            targetId: survivorId,
            previousKind: null,
            kind: merged.kind,
          },
        });
      }
      return { value: null, events };
    });
  } catch (error) {
    if (error instanceof Unchanged) return;
    throw error;
  }
}

/** Move one bounded keyset page of subject reactors. The source index is relay-owned;
 * actor slot commands are independently serialized in their actor partitions.
 */
export async function processSubjectReactionMergePage(
  deps: Dependencies,
  input: SubjectReactionMergeInput & Readonly<{ cursor: string | null }>,
): Promise<SubjectReactionMergePage> {
  const sourceRoute = route(input.id);
  route(input.survivor);
  if (input.id === input.survivor || (input.cursor !== null && routeOf(input.cursor) === null))
    throw new TypeError('Invalid subject reaction merge cursor');
  const page = await withConnection(deps.pool, (client) =>
    readPage.run(client, {
      route: sourceRoute,
      subject_id: input.id,
      cursor: input.cursor ?? FIRST_ACTOR_ID,
    }),
  );
  const row = (Array.isArray(page) ? page[0] : page) as { actors: string[] } | undefined;
  if (!row) throw new Error('Subject reaction merge page is unavailable');
  const actors = row.actors as string[];
  if (actors.length > SUBJECT_REACTION_MERGE_PAGE_SIZE) throw new Error('Subject reaction merge page overflowed');
  for (const actorId of actors) await mergeActorReaction(deps, actorId, input.id, input.survivor);
  return {
    cursor: actors.at(-1) ?? input.cursor,
    complete: actors.length < SUBJECT_REACTION_MERGE_PAGE_SIZE,
  };
}

/** DBOS stores each page result as step state; replay starts from its last completed cursor. */
export async function runSubjectReactionMerge(
  input: SubjectReactionMergeInput,
  page: (cursor: string | null) => Promise<SubjectReactionMergePage>,
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const next = await page(cursor);
    if (next.complete) return;
    if (next.cursor === null || (cursor !== null && next.cursor <= cursor))
      throw new Error('Subject reaction merge cursor did not advance');
    cursor = next.cursor;
  }
}
