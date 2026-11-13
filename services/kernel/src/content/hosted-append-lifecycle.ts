import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import authority from './hosted-append-lifecycle-authority.sql';
import revisions from './hosted-append-lifecycle-revisions.sql';
import placements from './hosted-append-lifecycle-placements.sql';
import stream from './hosted-append-lifecycle-stream.sql';

/** Internal native-work receiving seam. No scheduler, HTTP or erasure initiation.
 * An exact author/anchor pair is required even when the account home differs.
 * A late authored item uses the same pages before its locator is acknowledged.
 */
export type HostedLifecycleAnchor = Readonly<{ catalogueId: string; authorAccountId: string }>;
export type HostedLifecycleContext = Readonly<{ deadline: number; idempotencyKey: string }>;
export type HostedLifecycleRevisionCursor = Readonly<{ afterRevision: string | null }>;
export type HostedLifecyclePlacementCursor = Readonly<{
  revisionId: string;
  afterOccurrence: string | null;
}>;
export type HostedLifecycleStreamCursor = Readonly<{
  streamId: string;
  /** Captured only by the self-base inventory, never a dependent watermark. */
  highWater: string;
  afterOffset: string;
}>;

export type HostedLifecycleRevision = Readonly<{
  revisionId: string;
  kind: 'structure' | 'publication';
  sourceRevisionId: string | null;
  descriptor: Readonly<{
    baseRevisionId: string;
    basePlacementCount: string;
    baseRootCount: string;
    highWater: string;
  }> | null;
  /** Non-null only for the stream's self-base. '-1' means an empty stream. */
  streamHighWater: string | null;
}>;
export type HostedLifecyclePage<T, C> = Readonly<{
  items: readonly T[];
  /** A full page requires another range, including an empty exhaustion proof. */
  next: C | null;
}>;
export type HostedLifecyclePlacement = Readonly<{ occurrenceId: string; changed: boolean }>;
export type HostedLifecycleAppend = HostedLifecyclePlacement & Readonly<{ offset: string }>;

type RevisionRow = {
  revision_id: string;
  kind: 'structure' | 'publication';
  source_revision_id: string | null;
  base_revision_id: string | null;
  base_placement_count: string | null;
  base_root_count: string | null;
  high_water: string | null;
  stream_high_water: string | null;
};
type PlacementRow = { occurrence_id: string; changed: boolean };
type AppendRow = PlacementRow & { append_offset: string };
type PageRequest =
  | { kind: 'revisions'; cursor: HostedLifecycleRevisionCursor }
  | { kind: 'placements'; cursor: HostedLifecyclePlacementCursor }
  | { kind: 'stream'; cursor: HostedLifecycleStreamCursor };

/** Each call owns one catalogue-home command and releases its connection before
 * returning. Native partition epoch, deadline, retry and receipt semantics apply.
 * Authorization precedes even receipt replay; a caller cannot invent eligibility
 * with an account-erasure boolean or a changed hosted head. No title is returned.
 */
function executePage<T>(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  request: PageRequest,
  context: HostedLifecycleContext,
  body: (tx: CommandTransaction, route: number) => Promise<{ value: T; changed: boolean }>,
) {
  // Freeze the exact request before asynchronous admission/receipt lookup.
  const selected = structuredClone({ anchor, request });
  const route = routeOf(selected.anchor.catalogueId)!;
  let threadId: string;
  return runCommand<T>(
    pool,
    {
      partition: partitionOf(route),
      deadline: context.deadline,
      receipt: {
        actorAccountId: selected.anchor.authorAccountId,
        kind: 'content.hosted-catalogue.private-title-disposition',
        key: context.idempotencyKey,
        digest: createHash('sha256').update(JSON.stringify(selected)).digest(),
      },
      authorization: {
        async authorize(tx) {
          const parameters = {
            route,
            catalogue_id: selected.anchor.catalogueId,
            author_account_id: selected.anchor.authorAccountId,
          };
          const row = (
            await tx.query<{ thread_id: string }>(
              authority.sql,
              authority.params.map((name) => parameters[name as keyof typeof parameters]),
            )
          ).rows[0];
          if (!row) throw new Error('Hosted title disposition requires terminal native authority');
          threadId = row.thread_id;
          return 'execute';
        },
      },
    },
    async (tx) => {
      const result = await body(tx, route);
      return result.changed
        ? {
            value: result.value,
            // Existing mechanical cleanup event; no title, target or new wire.
            events: [
              {
                type: 'com.rezics.content.moderation.erasure.v1',
                data: { threadId, postIds: [], mediaIds: [] },
              },
            ],
          }
        : noEffect(result.value);
    },
  );
}

/** Headers only. The caller persists this page before processing each private
 * revision, and starts a stream exactly once, at its self-base. Publications are
 * classified here and retained, even if no longer the current release.
 */
export function pageHostedLifecycleRevisions(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  cursor: HostedLifecycleRevisionCursor,
  context: HostedLifecycleContext,
) {
  anchor = structuredClone(anchor);
  cursor = structuredClone(cursor);
  return executePage<HostedLifecyclePage<HostedLifecycleRevision, HostedLifecycleRevisionCursor>>(
    pool,
    anchor,
    { kind: 'revisions', cursor },
    context,
    async (tx, route) => {
      const parameters = { route, catalogue_id: anchor.catalogueId, after_revision: cursor.afterRevision };
      const rows = (
        await tx.query<RevisionRow>(
          revisions.sql,
          revisions.params.map((name) => parameters[name as keyof typeof parameters]),
        )
      ).rows;
      return {
        changed: false,
        value: {
          items: rows.map((row) => ({
            revisionId: row.revision_id,
            kind: row.kind,
            sourceRevisionId: row.source_revision_id,
            descriptor:
              row.base_revision_id === null
                ? null
                : {
                    baseRevisionId: row.base_revision_id,
                    basePlacementCount: row.base_placement_count!,
                    baseRootCount: row.base_root_count!,
                    highWater: row.high_water!,
                  },
            streamHighWater: row.stream_high_water,
          })),
          next: rows.length === 100 ? { afterRevision: rows.at(-1)!.revision_id } : null,
        },
      };
    },
  );
}

/** One private revision's primary-key range. Publication requests select zero
 * candidates. Already redacted rows still advance the occurrence frontier.
 */
export function redactHostedLifecyclePlacements(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  cursor: HostedLifecyclePlacementCursor,
  context: HostedLifecycleContext,
) {
  anchor = structuredClone(anchor);
  cursor = structuredClone(cursor);
  return executePage<HostedLifecyclePage<HostedLifecyclePlacement, HostedLifecyclePlacementCursor>>(
    pool,
    anchor,
    { kind: 'placements', cursor },
    context,
    async (tx, route) => {
      const parameters = {
        route,
        catalogue_id: anchor.catalogueId,
        revision_id: cursor.revisionId,
        after_occurrence: cursor.afterOccurrence,
      };
      const rows = (
        await tx.query<PlacementRow>(
          placements.sql,
          placements.params.map((name) => parameters[name as keyof typeof parameters]),
        )
      ).rows;
      return {
        changed: rows.some((row) => row.changed),
        value: {
          items: rows.map((row) => ({ occurrenceId: row.occurrence_id, changed: row.changed })),
          next: rows.length === 100 ? { ...cursor, afterOccurrence: rows.at(-1)!.occurrence_id } : null,
        },
      };
    },
  );
}

/** One self-base stream's primary-key range within its captured upper bound.
 * Offsets stay decimal text through SQL, response, receipt and next request.
 * Keep this active cursor beside the durable revision frontier; do not restart
 * the stream for each descriptor that shares it. Duplicate keys replay exactly;
 * a new key over the same range returns unchanged candidates and the same next.
 */
export function redactHostedLifecycleStream(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  cursor: HostedLifecycleStreamCursor,
  context: HostedLifecycleContext,
) {
  anchor = structuredClone(anchor);
  cursor = structuredClone(cursor);
  return executePage<HostedLifecyclePage<HostedLifecycleAppend, HostedLifecycleStreamCursor>>(
    pool,
    anchor,
    { kind: 'stream', cursor },
    context,
    async (tx, route) => {
      const parameters = {
        route,
        catalogue_id: anchor.catalogueId,
        stream_id: cursor.streamId,
        high_water: cursor.highWater,
        after_offset: cursor.afterOffset,
      };
      const rows = (
        await tx.query<AppendRow>(
          stream.sql,
          stream.params.map((name) => parameters[name as keyof typeof parameters]),
        )
      ).rows;
      return {
        changed: rows.some((row) => row.changed),
        value: {
          items: rows.map((row) => ({
            occurrenceId: row.occurrence_id,
            offset: row.append_offset,
            changed: row.changed,
          })),
          next: rows.length === 100 ? { ...cursor, afterOffset: rows.at(-1)!.append_offset } : null,
        },
      };
    },
  );
}
