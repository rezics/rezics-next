import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import type { SessionOwner } from './store.ts';
import { editionChoice, InvalidEditionPreference, StaleEditionPreference, EditionPreferenceConflict,
  type EditionChoice, type EditionPreference } from './preference-contract.ts';
import { readId } from '../work/read-contract.ts';

export class EditionPreferenceStore {
  constructor(private readonly pool: Pool) {}
  async read(owner: SessionOwner, work: string): Promise<EditionPreference | null> {
    return (await this.batch(owner, [work])).get(work) ?? null;
  }
  async batch(owner: SessionOwner, works: string[]) {
    const result = await this.pool.query<{ work: string; choice: EditionChoice; version: string }>(
      `SELECT work, choice, version::text FROM reader.edition_preference
       WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND work = ANY($4::text[])`,
      [owner.principal.issuer, owner.principal.subject, owner.agent, works]);
    return new Map(result.rows.map(row => [row.work, { work: row.work, ...row.choice, version: Number(row.version) }]));
  }
  async write(owner: SessionOwner, work: string, choice: EditionChoice, expectedVersion: number,
    key: string, assertOwner: () => Promise<void>) {
    if (!owner.principal.issuer || !owner.principal.subject || !Value.Check(readId, owner.agent)
      || !Value.Check(readId, work) || !Value.Check(editionChoice, choice)
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) {
      throw new InvalidEditionPreference('Invalid edition preference');
    }
    const identity = [owner.principal.issuer, owner.principal.subject, owner.agent, work];
    const digest = createHash('sha256').update(JSON.stringify([...identity, choice.language,
      choice.edition?.kind ?? null, choice.edition?.resource ?? null, choice.edition?.revision ?? null,
      expectedVersion])).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['edition-key', ...identity.slice(0, 2), key])]);
      const prior = await client.query<{ request_digest: string; result: EditionPreference }>(
        `SELECT request_digest, result FROM reader.edition_preference_command
         WHERE principal_issuer = $1 AND principal_subject = $2 AND idempotency_key = $3`,
        [...identity.slice(0, 2), key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest) throw new EditionPreferenceConflict('Idempotency key has another preference intent');
        await assertOwner();
        await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['edition-work', ...identity])]);
      const saved = await client.query<{ choice: EditionChoice; version: string }>(
        `SELECT choice, version::text FROM reader.edition_preference
         WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND work = $4 FOR UPDATE`, identity);
      const current = saved.rows[0];
      const version = Number(current?.version ?? 0);
      if (version !== expectedVersion) {
        await assertOwner();
        throw new StaleEditionPreference(current ? { work, ...current.choice, version } : null);
      }
      const result = { work, ...choice, version: version + 1 };
      await client.query(`INSERT INTO reader.edition_preference
        (principal_issuer, principal_subject, agent, work, choice, version) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (principal_issuer, principal_subject, agent, work)
        DO UPDATE SET choice = EXCLUDED.choice, version = EXCLUDED.version`,
      [...identity, JSON.stringify(choice), result.version]);
      await client.query(`INSERT INTO reader.edition_preference_command
        (principal_issuer, principal_subject, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4,$5)`,
      [...identity.slice(0, 2), key, digest, JSON.stringify(result)]);
      await assertOwner();
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
