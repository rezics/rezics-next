import { BACKGROUND_GRANTS_UNTIL, type Corpus, RecordDigest, agentAt, corpusWorks, fixtureUuid,
  stable } from '../corpus.ts';
import { countRows, countRowsByIds, insertColumns, ownerTransaction } from './postgres.ts';
import type { FixtureOwner } from './types.ts';

/**
 * Background Agents and their current Work read grants. Principals and
 * representations bind run-local Account issuers, so each restored run adds
 * them for its own fresh cohort instead of carrying stale ones in the backup.
 */
function* agents(corpus: Corpus): Generator<[string, string]> {
  for (let index = 0; index < corpus.agents; index++) yield [agentAt(corpus, index), 'agent'];
}

function* gates(corpus: Corpus): Generator<[string]> {
  for (const work of corpusWorks(corpus)) yield [`work:read:${work.work}`];
}

function* grants(corpus: Corpus): Generator<[string, string, string, string, string, string]> {
  for (const work of corpusWorks(corpus)) {
    yield [fixtureUuid(corpus.seed, `grant:work-read:${work.index}`), work.agent, work.agent,
      `work:read:${work.work}`, 'work.read', BACKGROUND_GRANTS_UNTIL];
  }
}

export const accessOwner: FixtureOwner = {
  name: 'access',
  generator: 'access-agent-work-read-v1',
  phase: 'online',
  compatibilityInputs: () => ({}),
  summarize(corpus) {
    const digest = new RecordDigest();
    for (const row of agents(corpus)) digest.add('access.authority_subject', stable(row));
    for (const row of gates(corpus)) digest.add('access.scope_gate', stable(row));
    for (const row of grants(corpus)) digest.add('access.permission_grant', stable(row));
    return digest.finish();
  },
  async load(corpus, target) {
    const started = performance.now();
    const rows = await ownerTransaction(target.pools.access, async client => ({
      agents: await insertColumns(client, `INSERT INTO access.authority_subject (id, kind)
        SELECT * FROM unnest($1::text[], $2::text[])`, agents(corpus), 2),
      gates: await insertColumns(client, `INSERT INTO access.scope_gate (id)
        SELECT * FROM unnest($1::text[]) ON CONFLICT (id) DO NOTHING`, gates(corpus), 1),
      grants: await insertColumns(client, `INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::timestamptz[])`, grants(corpus), 6),
    }));
    return { elapsedMs: performance.now() - started, detail: rows };
  },
  async verify(corpus, target) {
    const pool = target.pools.access;
    // Imported authority carries no fabricated admissions or receipts.
    for (const table of ['access.admission', 'access.admission_receipt', 'access.grant_change_receipt']) {
      if (await countRows(pool, table) !== 0) throw new Error(`${table} must stay empty after import`);
    }
    return { 'access.authority_subject': await countRowsByIds(pool, 'access.authority_subject', 'id',
      Array.from(agents(corpus), ([id]) => id)),
      'access.scope_gate': await countRowsByIds(pool, 'access.scope_gate', 'id',
        Array.from(gates(corpus), ([id]) => id)),
      'access.permission_grant': await countRowsByIds(pool, 'access.permission_grant', 'id',
        Array.from(grants(corpus), ([id]) => id), 'uuid') };
  },
};
