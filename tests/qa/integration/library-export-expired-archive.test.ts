import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { emptyRow, type CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';

type ExportPage = { profile: 'rezics-library-export-v1'; rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };

test('an expired archive row does not export the clean live row of the same source', async () => {
  const home = await startHomeStack('library-export-expired-archive');
  try {
    const login = await home.deps.account.verify(new Request('http://main.local/login', {
      headers: { authorization: `Bearer ${home.reader.token}` } }));
    const stored = await login.currentAssertion?.();
    if (!stored) throw new Error('Library reader has no login principal');
    const agent = await home.provision('Library export expired archive', home.reader.token);
    Object.assign(stored, { accountScopes: ['work:read', 'library:write'] });
    const sourceId = 'expired-archive-entry';
    const entry = emptyRow(sourceId, 'Shared title', {});
    entry.kind = 'entry';
    const call = (method: string, path: string, body?: object) => home.app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${home.reader.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const expired = await home.json<{ id: string }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: agent, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: [entry] }) }), 201);
    await home.stack.contentPool.query(
      `UPDATE reader.library_import_file SET expires_at=clock_timestamp() - interval '1 minute' WHERE agent=$1 AND id=$2`,
      [agent, expired.id]);
    const source = await home.stack.contentPool.query<{ digest: string; exportable: boolean }>(
      `SELECT digest, exportable FROM reader.library_import_source WHERE agent=$1 AND source->>'sourceId'=$2`,
      [agent, sourceId]);
    const digest = source.rows[0]?.digest;
    if (!digest) throw new Error('Expired upload did not keep its source');
    // The same bytes cannot be uploaded again after expiry. This is the live
    // file of that source, applied cleanly, while the expired file is still present.
    const liveId = randomUUID();
    const liveKey = `live-${liveId}`;
    await home.stack.contentPool.query(
      `INSERT INTO reader.library_import_batch(agent,import_key,request_digest,row_count) VALUES ($1,$2,$3,1)`,
      [agent, liveKey, 'ab'.repeat(32)]);
    await home.stack.contentPool.query(
      `INSERT INTO reader.library_import_file(agent,id,import_key,format,file_digest) VALUES ($1,$2,$3,'rezics',$4)`,
      [agent, liveId, liveKey, 'cd'.repeat(32)]);
    await home.stack.contentPool.query(
      `INSERT INTO reader.library_import_source_row(agent,file_id,row_number,source_digest,resolution,outcome)
       VALUES ($1,$2,0,$3,'{"choice":"apply"}'::jsonb,'{"applied":[],"issues":[]}'::jsonb)`,
      [agent, liveId, digest]);
    const rows = await home.stack.contentPool.query<{ expired: boolean; archive_needed: boolean }>(
      `SELECT f.expires_at<=clock_timestamp() AS expired, r.archive_needed
       FROM reader.library_import_source_row r
       JOIN reader.library_import_file f ON f.agent=r.agent AND f.id=r.file_id
       WHERE r.agent=$1 AND r.source_digest=$2 ORDER BY expired`, [agent, digest]);
    expect(rows.rows).toEqual([{ expired: false, archive_needed: false }, { expired: true, archive_needed: true }]);
    const marked = await home.stack.contentPool.query<{ exportable: boolean }>(
      `SELECT exportable FROM reader.library_import_source WHERE agent=$1 AND digest=$2`, [agent, digest]);
    expect(marked.rows[0]?.exportable).toBe(true);

    const exported: CanonicalRow[] = [];
    let cursor: string | null = null;
    let snapshot: string | undefined;
    do {
      const query = new URLSearchParams({ actingSubject: agent, ...(cursor ? { cursor } : {}), ...(snapshot ? { snapshot } : {}) });
      const page = await home.json<ExportPage>(await call('GET', `/v1/me/library-export?${query}`));
      exported.push(...page.rows);
      snapshot = page.snapshot;
      cursor = page.nextCursor;
    } while (cursor);
    expect(exported.some(row => JSON.stringify(row).includes(sourceId))).toBe(false);
  } finally {
    await home.stop();
  }
}, 180_000);
