import type { Pool } from 'pg';
import { controlRead, controlTransaction } from '../access/topology-control.ts';
import type { ProjectionKey } from './schema.ts';

const native = (id: string) => `https://rezics.com/id/${id}`;

/** The Access-owned identity of each projection: one row per subject and sorted frame set. Both
 * statements are single indexed probes on the primary key, whatever the number of projections. */
export class ProjectionStore {
  constructor(private readonly pool: Pool) {}

  /** The projection already reserved for a key, if any. Its graph Resource may still be absent. */
  lookup(key: string): Promise<string | null> {
    return controlRead(this.pool, async client => {
      const row = (await client.query<{ projection: string }>(
        'SELECT projection FROM access.projection_identity WHERE key = $1', [key])).rows[0];
      return row ? native(row.projection) : null;
    });
  }

  /** One page of a subject's reserved projections after a cursor, oldest first. One index range scan of
   * `limit` rows, however many projections the subject has. Graph availability is checked by the caller. */
  list(subject: string, after: string | null, limit: number): Promise<string[]> {
    return controlRead(this.pool, async client => (await client.query<{ projection: string }>(
      `SELECT projection FROM access.projection_identity
       WHERE subject = $1 AND ($2::uuid IS NULL OR projection > $2) ORDER BY projection LIMIT $3`,
      [subject, after, limit])).rows.map(row => native(row.projection)));
  }

  /** Reserve the one identity of a key. Concurrent callers all receive the first caller's identity;
   * the losing insert waits for the winner's commit (ON CONFLICT) and adopts it. */
  reserve(input: ProjectionKey & { admission: string }): Promise<{ projection: string; reserved: boolean }> {
    const candidate = Bun.randomUUIDv7();
    return controlTransaction(this.pool, async client => {
      const inserted = await client.query<{ projection: string }>(
        `INSERT INTO access.projection_identity (key, projection, subject, frames, admission_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING projection`,
        [input.key, candidate, input.subject, input.frames, input.admission]);
      if (inserted.rows[0]) return { projection: native(inserted.rows[0].projection), reserved: true };
      const existing = await client.query<{ projection: string }>(
        'SELECT projection FROM access.projection_identity WHERE key = $1', [input.key]);
      return { projection: native(existing.rows[0]!.projection), reserved: false };
    });
  }
}
