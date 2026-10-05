import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendContentEvent, contentEventPosition } from './event-sequencer.ts';

export class ContentModerationConflict extends Error {}
export class ContentModerationStale extends Error {}

export interface ContentModerationTarget {
  operationId: string;
  ordinal: number;
  resource: string;
  revision: string;
  locator: string | null;
  expectedHead: string;
  effect: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One variant row, one receipt and one effect anchor; O(1) indexed owner work.
 * Returns after the receipt is numbered, so the effect is in the ordered event log. */
export class ContentModeration {
  constructor(private readonly pool: Pool) {}

  async apply(target: ContentModerationTarget): Promise<{ replayed: boolean }> {
    if (!target.operationId || target.operationId.length > 160 || !Number.isInteger(target.ordinal)
      || target.ordinal < 1 || target.ordinal > 64 || !uuid.test(target.revision)
      || !uuid.test(target.expectedHead) || target.resource.length > 300) {
      throw new ContentModerationConflict('invalid moderation target');
    }
    const operationId = `${target.operationId}:${target.ordinal}`;
    const requestDigest = digest(target);
    const client = await this.pool.connect();
    let replayed: boolean;
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationId]);
      const prior = (await client.query<{ request_digest: string; action: string; outcome: string }>(
        `SELECT request_digest, action, outcome FROM content.receipt WHERE operation_id = $1`, [operationId])).rows[0];
      if (prior) {
        if (prior.request_digest !== requestDigest || prior.action !== 'moderation.apply'
          || prior.outcome !== 'succeeded') {
          throw new ContentModerationConflict('moderation operation differs');
        }
        await client.query('COMMIT');
        replayed = true;
      } else {
        await this.record(client, target, operationId, requestDigest);
        replayed = false;
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    await contentEventPosition(this.pool, operationId);
    return { replayed };
  }

  private async record(client: PoolClient, target: ContentModerationTarget, operationId: string,
    requestDigest: string): Promise<void> {
    const row = (await client.query<{ id: string; draft_head: string | null }>(`SELECT v.id, v.draft_head::text
      FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
      WHERE r.id = $1 AND v.resource_id = $2 AND ($3::text IS NULL OR v.id = $3)
      FOR UPDATE OF v`, [target.revision, target.resource, target.locator])).rows[0];
    if (!row || row.draft_head !== target.expectedHead) throw new ContentModerationStale('draft head changed');
    await appendContentEvent(client, { operationId, requestDigest, action: 'moderation.apply',
      outcome: 'succeeded', variantId: row.id, revisionId: target.revision,
      eventType: 'content.moderation.applied', recipe: 'governance-moderation-v1',
      payload: { decisionOperationId: target.operationId, ordinal: target.ordinal,
        resource: target.resource, variant: row.id, expectedHead: target.expectedHead,
        effect: target.effect } });
    await client.query(`INSERT INTO content.moderation_effect
      (operation_id, decision_operation_id, target_ordinal, resource_id, variant_id, expected_head, effect, request_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [operationId, target.operationId, target.ordinal, target.resource, row.id, target.expectedHead,
      target.effect, requestDigest]);
    await client.query('COMMIT');
  }
}
