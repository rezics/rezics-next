import { Pool } from 'pg';
import type { PublicationFixture } from '../../../../specs/web-publication-driver';

const seconds = (time: Date) => `${time.toISOString().slice(0, 19)}Z`;

/** Read fixture registration and write facts from their owners before walking the sitemap feeds. */
export async function observePublicationSitemap(
  databaseUrl: string,
  publicOrigin: string,
  locales: readonly string[],
  subjectIds: readonly string[],
  threadIds: readonly string[],
) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1_000,
    options: '-c default_transaction_read_only=on -c statement_timeout=2000',
  });
  try {
    const { rows } = await pool.query<{
      handle: string | null;
      state: string;
      fenced: boolean;
      publicChangedAt: Date | null;
    }>('SELECT handle, state, authn_fenced AS fenced, public_changed_at AS "publicChangedAt" FROM access.account');
    const subjects = await pool.query<{ id: string; at: Date | null }>(
      `SELECT subject_id AS id, max(effective_at) AS at FROM semantic.subject_page_change
       WHERE subject_id = ANY($1::uuid[]) GROUP BY subject_id`,
      [subjectIds],
    );
    const threads = await pool.query<{ id: string; board: string; created: Date; activity: Date }>(
      `SELECT thread_id AS id, board_id AS board, created_at AS created, last_activity_at AS activity
       FROM content.thread WHERE thread_id = ANY($1::uuid[])`,
      [threadIds],
    );
    const inventory: PublicationFixture['sitemap']['agent'] = { eligible: [], excluded: [] };
    const handles: string[] = [];
    for (const { handle, state, fenced, publicChangedAt } of rows) {
      if (handle === null) continue;
      const urls = locales.map((locale) => new URL(`/${locale}/@${encodeURIComponent(handle)}`, publicOrigin).href);
      if (state === 'active' && !fenced) {
        if (!publicChangedAt) throw new Error(`Native Agent fixture ${handle} has no public change time`);
        const lastmod = seconds(publicChangedAt);
        handles.push(handle);
        inventory.eligible.push(...urls.map((url) => ({ url, lastmod })));
      } else {
        inventory.excluded.push(...urls);
      }
    }
    return {
      agents: { inventory, handles },
      subjectTimes: new Map(subjects.rows.map(({ id, at }) => [id, at && seconds(at)])),
      boardTimes: new Map(threads.rows.map(({ board, created }) => [board, seconds(created)])),
      threadTimes: new Map(threads.rows.map(({ id, activity }) => [id, seconds(activity)])),
    };
  } finally {
    await pool.end();
  }
}
