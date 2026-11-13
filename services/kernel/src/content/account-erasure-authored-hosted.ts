import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { deadlineClient, within } from './access-port.ts';
import {
  pageHostedLifecycleRevisions,
  redactHostedLifecyclePlacements,
  redactHostedLifecycleStream,
  type HostedLifecycleAnchor,
  type HostedLifecycleContext,
  type HostedLifecyclePlacementCursor,
  type HostedLifecycleRevisionCursor,
  type HostedLifecycleStreamCursor,
} from './hosted-append-lifecycle.ts';

export type HostedDispositionStep = <T>(name: string, action: () => Promise<T>) => Promise<T>;

const direct: HostedDispositionStep = (_name, action) => action();

/** Resolve one catalogue through its exact Post key. The receiving page rechecks
 * terminal native authority and the author under the catalogue command lock.
 */
export async function hostedLifecycleAnchor(
  pool: Pool,
  catalogueId: string,
  deadline: () => number,
): Promise<HostedLifecycleAnchor | null> {
  const route = routeOf(catalogueId);
  if (route === null) throw new TypeError('Invalid hosted catalogue identity');
  const end = deadline();
  return within(end, () =>
    withConnection(pool, async (connection) => {
      const { rows } = await deadlineClient(connection, end).query<{ author_account_id: string | null }>(
        `SELECT p.author_account_id::text
         FROM content.hosted_catalogue c JOIN content.post p
           ON p.route=c.route AND p.post_id=c.catalogue_id AND p.thread_id=c.thread_id
         WHERE c.route=$1 AND c.catalogue_id=$2`,
        [route, catalogueId],
      );
      const authorAccountId = rows[0]?.author_account_id;
      return authorAccountId ? { catalogueId, authorAccountId } : null;
    }),
  );
}

function receiptKey(anchor: HostedLifecycleAnchor, kind: string, cursor: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([anchor.catalogueId, anchor.authorAccountId, kind, cursor]))
    .digest('hex');
}

/** Drain the producer's immutable, receipt-backed pages before a native locator
 * is acknowledged. Each command owns one bounded transaction and connection.
 */
export async function disposeHostedTitles(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  deadline: () => number,
  step: HostedDispositionStep = direct,
): Promise<void> {
  const page = <T>(kind: string, cursor: unknown, run: (context: HostedLifecycleContext) => Promise<T>) => {
    const idempotencyKey = receiptKey(anchor, kind, cursor);
    return step(`hosted:${anchor.catalogueId}:${kind}:${idempotencyKey}`, () =>
      run({ deadline: deadline(), idempotencyKey }),
    );
  };

  let afterRevision: string | null = null;
  for (;;) {
    const cursor: HostedLifecycleRevisionCursor = { afterRevision };
    const inventory: Awaited<ReturnType<typeof pageHostedLifecycleRevisions>> = await page(
      'revisions',
      cursor,
      (context) => pageHostedLifecycleRevisions(pool, anchor, cursor, context),
    );

    for (const revision of inventory.value.items) {
      const selfBase = revision.descriptor?.baseRevisionId === revision.revisionId;
      if (revision.kind === 'structure' && (revision.descriptor === null || selfBase)) {
        let afterOccurrence: string | null = null;
        for (;;) {
          const placementCursor: HostedLifecyclePlacementCursor = { revisionId: revision.revisionId, afterOccurrence };
          const result: Awaited<ReturnType<typeof redactHostedLifecyclePlacements>> = await page(
            'placements',
            placementCursor,
            (context) => redactHostedLifecyclePlacements(pool, anchor, placementCursor, context),
          );
          if (!result.value.next) break;
          afterOccurrence = result.value.next.afterOccurrence;
        }
      }

      if (revision.streamHighWater !== null && revision.streamHighWater !== '-1') {
        let afterOffset = '-1';
        for (;;) {
          const streamCursor: HostedLifecycleStreamCursor = {
            streamId: revision.revisionId,
            highWater: revision.streamHighWater,
            afterOffset,
          };
          const result: Awaited<ReturnType<typeof redactHostedLifecycleStream>> = await page(
            'stream',
            streamCursor,
            (context) => redactHostedLifecycleStream(pool, anchor, streamCursor, context),
          );
          if (!result.value.next) break;
          afterOffset = result.value.next.afterOffset;
        }
      }
    }

    if (!inventory.value.next) break;
    afterRevision = inventory.value.next.afterRevision;
  }
}

/** Account erasure already knows the author. Resolve only the exact catalogue
 * and reject an unexpected author mismatch before issuing any disposition page.
 */
export async function disposeHostedAccountItem(
  pool: Pool,
  catalogueId: string,
  authorAccountId: string,
  deadline: () => number,
  step: HostedDispositionStep = direct,
): Promise<void> {
  const anchor = await hostedLifecycleAnchor(pool, catalogueId, deadline);
  if (!anchor) return;
  if (anchor.authorAccountId !== authorAccountId) throw new Error('Hosted catalogue author changed during erasure');
  await disposeHostedTitles(pool, anchor, deadline, step);
}
