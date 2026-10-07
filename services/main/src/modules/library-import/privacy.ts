import type { Pool, PoolClient } from 'pg';

/** Delete upload evidence and its replay plans. Applied Library state and
 * actual attempts remain under their owners when the reader deletes an upload. */
export async function deleteLibraryUploads(client: PoolClient, agent: string, ids: string[]) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`reader-library-import:${agent}:library-file-agent-apply`]);
  const files = (await client.query<{ import_key: string; id: string }>(`SELECT id,import_key FROM reader.library_import_file
    WHERE agent=$1 AND id=ANY($2::uuid[]) FOR UPDATE`,[agent,ids])).rows;
  if (!files.length) return;
  const keys = files.map(file => file.import_key);
  keys.push(...(await client.query<{ import_key: string }>(`SELECT import_key FROM reader.library_import_file_batch
    WHERE agent=$1 AND file_id=ANY($2::uuid[])`,[agent,ids])).rows.map(row => row.import_key));
  const digests = (await client.query<{ source_digest: string }>(`SELECT DISTINCT source_digest FROM reader.library_import_source_row
    WHERE agent=$1 AND file_id=ANY($2::uuid[])`,[agent,ids])).rows.map(row => row.source_digest);
  await client.query(`UPDATE reader.library_import_upload_command SET file_id=NULL WHERE agent=$1 AND file_id=ANY($2::uuid[])`,[agent,ids]);
  await client.query(`DELETE FROM reader.library_import_file WHERE agent=$1 AND id=ANY($2::uuid[])`,[agent,ids]);
  for (const table of ['library_import_step','library_import_row_outcome','library_import_batch']) {
    await client.query(`DELETE FROM reader.${table} WHERE agent=$1 AND import_key=ANY($2::text[])`,[agent,keys]);
  }
  await client.query(`DELETE FROM reader.library_import_source s WHERE agent=$1 AND digest=ANY($2::text[])
    AND NOT EXISTS (SELECT 1 FROM reader.library_import_source_row r WHERE r.agent=s.agent AND r.source_digest=s.digest)`,[agent,digests]);
}

/** Ten indexed expired-file seeks per poll; deletion work is bounded by ten
 * upload byte/row budgets. Expired evidence is excluded from all reader APIs. */
export async function expireLibraryUploads(content: Pool, now = new Date()): Promise<number> {
  const files = (await content.query<{ agent: string; id: string }>(`SELECT agent,id FROM reader.library_import_file
    WHERE expires_at<=$1 ORDER BY expires_at,agent,id LIMIT 10`,[now])).rows;
  const client = await content.connect();
  try {
    for (const agent of new Set(files.map(file => file.agent))) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['library-upload',agent])]);
        await deleteLibraryUploads(client,agent,files.filter(file => file.agent===agent).map(file => file.id));
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK');throw error; }
    }
  } finally { client.release(); }
  return files.length;
}

/** Account deletion uses original own-Person provisions, never delegated
 * Agent authority. Pages avoid making a request bound a person-count limit. */
export async function eraseLibraryImportsForPrincipals(content: Pool, access: Pool | PoolClient, principals: string[]) {
  let after = '';
  while (true) {
    const agents = (await access.query<{ agent_id: string }>(`SELECT DISTINCT a.agent_id FROM access.agent_provision a
      JOIN access.principal p ON p.id=a.principal_id WHERE a.principal_id=ANY($1::uuid[])
      AND a.agent_kind='person' AND NOT p.active
      AND EXISTS (SELECT 1 FROM access.outbox o WHERE o.principal_id=p.id AND o.kind='account.deletion_fenced') AND a.agent_id>$2 ORDER BY a.agent_id LIMIT 100`,[principals,after])).rows;
    for (const { agent_id: agent } of agents) {
      const client = await content.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['library-upload',agent])]);
        while (true) {
          const ids = (await client.query<{ id: string }>(`SELECT id FROM reader.library_import_file WHERE agent=$1 ORDER BY id LIMIT 10`,[agent])).rows.map(row => row.id);
          if (!ids.length) break;
          await deleteLibraryUploads(client,agent,ids);
        }
        for (const table of ['library_import_session_effect','library_import_upload_command','library_import_review_command',
          'library_import_step','library_import_row_outcome','library_import_batch','library_import_placement','library_import_daily_budget']) {
          await client.query(`DELETE FROM reader.${table} WHERE agent=$1`,[agent]);
        }
        // Copy deletion cascades its loans. Remove receipts too: they contain
        // private counterparties and must not resurrect records after restore.
        await client.query('DELETE FROM reader.library_copy WHERE agent=$1', [agent]);
        await client.query('DELETE FROM reader.library_copy_loan_command WHERE agent=$1', [agent]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
      after = agent;
    }
    if (agents.length < 100) return;
  }
}
