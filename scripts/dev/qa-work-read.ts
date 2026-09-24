import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../..');
const runIdPattern = /^[a-z0-9][a-z0-9-]{0,30}$/;
const workPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface QaWorkReadInput {
  runId: string;
  privateConfigPath: string;
  accessDatabaseUrl: string;
  fusekiUrl: string;
  work: string;
}

/** Grant one newly created Work to the isolated browser fixture's actor. */
export async function grantQaWorkRead(input: QaWorkReadInput): Promise<void> {
  if (!runIdPattern.test(input.runId) || !workPattern.test(input.work)) {
    throw new Error('QA Work read grant requires an isolated run and exact Work URI');
  }
  const expectedPath = join(root, '.temp', 'stack', `rezics-qa-${input.runId}`, 'web-auth', 'private.json');
  if (resolve(input.privateConfigPath) !== expectedPath) {
    throw new Error('QA Work read grant requires this run’s private web fixture');
  }
  for (const value of [input.accessDatabaseUrl, input.fusekiUrl]) {
    const url = new URL(value);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
      throw new Error('QA Work read grant requires loopback owners');
    }
  }
  const fixture = JSON.parse(readFileSync(expectedPath, 'utf8')) as {
    principalId?: string; actingSubject?: string;
  };
  if (!fixture.principalId || !/^[0-9a-f-]{36}$/i.test(fixture.principalId)
    || !fixture.actingSubject || !workPattern.test(fixture.actingSubject)) {
    throw new Error('QA web fixture has no registered actor');
  }
  const fuseki = new FusekiClient(input.fusekiUrl);
  const current = await fuseki.query(`PREFIX schema: <https://schema.org/> ASK {
    GRAPH <urn:rezics:graph:current> { <${input.work}> a schema:CreativeWork }
  }`);
  if (current.boolean !== true) throw new Error('Work does not exist in this QA graph');
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const actor = await client.query(`SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.create'
        AND active = true AND valid_until > now() FOR SHARE`,
    [fixture.principalId, fixture.actingSubject]);
    if (actor.rowCount !== 1) throw new Error('QA actor is not registered for Work creation');
    const scope = `work:read:${input.work}`;
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
    const gate = await client.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
    if (gate.rows[0]?.open !== true) throw new Error('Work read gate is closed');
    await client.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', now() + interval '8 hours')`,
    [randomUUID(), fixture.principalId, fixture.actingSubject]);
    await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', now() + interval '8 hours')`,
    [randomUUID(), fixture.actingSubject, scope]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
