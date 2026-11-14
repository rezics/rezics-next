import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import scrubListingHistory from '../../src/library/erasure-owned-listing-history.sql';
import { OWNED_PHASES, purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';

const pool = new Pool();
afterAll(() => pool.end());

function uuidForRoute(route: number): string {
  const bytes = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  bytes[10] = route >> 8;
  bytes[11] = route & 0xff;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('scrubs only exact curator links from parentless listing history and replays safely', async () => {
  const client = await pool.connect();
  const route = Math.floor(Math.random() * 65536);
  const owner = uuidForRoute(route);
  const foreign = uuidForRoute(route);
  const prior = uuidForRoute(route);
  const later = uuidForRoute(route);
  const late = uuidForRoute(route);
  const cleared = uuidForRoute(route);
  const foreignCollection = uuidForRoute(route);
  const applyPage = (accountId: string) =>
    scrubListingHistory.run(client as unknown as Parameters<typeof scrubListingHistory.run>[0], {
      route,
      account_id: accountId,
    });
  const insertPublicCollection = async (collectionId: string, curatorId: string) => {
    await client.query(
      `INSERT INTO library.collection
         (route, collection_id, curator_account_id, title, description, visibility, state, revision,
          created_at, updated_at, transaction_id)
       VALUES ($1, $2, $3, 'Public history fixture', NULL, 'public', 'active', 1, now(), now(), $4)`,
      [route, collectionId, curatorId, randomUUID()],
    );
  };
  const deletePublicCollection = async (collectionId: string, curatorId: string) => {
    await insertPublicCollection(collectionId, curatorId);
    await client.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=$2', [route, collectionId]);
  };

  try {
    expect(OWNED_PHASES.at(-1)).toBe('collection_listing_history');
    await client.query('BEGIN');
    await deletePublicCollection(prior, owner);
    await deletePublicCollection(later, owner);
    await deletePublicCollection(foreignCollection, foreign);
    expect(
      (
        await client.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=ANY($2::uuid[])', [
          route,
          [prior, later, foreignCollection],
        ])
      ).rowCount,
    ).toBe(0);
    const recorded = await client.query<{ collection_id: string; curator_account_id: string }>(
      `SELECT collection_id::text, curator_account_id::text FROM library.collection_listing_history WHERE route=$1`,
      [route],
    );
    const recordedByCollection = new Map(recorded.rows.map((row) => [row.collection_id, row.curator_account_id]));
    expect(recordedByCollection.get(prior)).toBe(owner);
    expect(recordedByCollection.get(later)).toBe(owner);
    expect(recordedByCollection.get(foreignCollection)).toBe(foreign);

    expect((await applyPage(owner)).length).toBe(2);
    expect((await applyPage(owner)).length).toBe(0);

    // A parent deletion that commits after an earlier page remains discoverable by the same owner key.
    await deletePublicCollection(late, owner);
    expect((await applyPage(owner)).length).toBe(1);

    // A curator clear removes a matching locator, and the later delete cannot restore it.
    await insertPublicCollection(cleared, owner);
    await client.query(
      `INSERT INTO library.collection_listing_history (route, collection_id, ever_public, curator_account_id)
       VALUES ($1, $2, true, $3)`,
      [route, cleared, owner],
    );
    await client.query('UPDATE library.collection SET curator_account_id=NULL WHERE route=$1 AND collection_id=$2', [
      route,
      cleared,
    ]);
    await client.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=$2', [route, cleared]);

    const rows = await client.query<{ collection_id: string; ever_public: boolean; curator_account_id: string | null }>(
      `SELECT collection_id::text, ever_public, curator_account_id::text
       FROM library.collection_listing_history WHERE route=$1 ORDER BY collection_id`,
      [route],
    );
    const byCollection = new Map(rows.rows.map((row) => [row.collection_id, row]));
    expect(byCollection.size).toBe(5);
    expect(byCollection.get(foreignCollection)).toMatchObject({ ever_public: true, curator_account_id: foreign });
    expect(byCollection.get(prior)).toMatchObject({ ever_public: true, curator_account_id: null });
    expect(byCollection.get(later)).toMatchObject({ ever_public: true, curator_account_id: null });
    expect(byCollection.get(late)).toMatchObject({ ever_public: true, curator_account_id: null });
    expect(byCollection.get(cleared)).toMatchObject({ ever_public: true, curator_account_id: null });
    await expect(
      purgeOwnedGraphPage(pool, {
        accountId: owner,
        kind: 'collection_listing_history',
        parent: null,
        after: null,
        ordinal: 0,
        segment: OWNED_PHASES.length - 1,
      }),
    ).rejects.toThrow();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
