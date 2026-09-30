import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readWorkTerminalReceipt } from '../work/receipt.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { CATALOGUE_COST, CatalogueInvalid, CataloguePendingLimit, CatalogueUnavailable, type CandidateInput } from './schema.ts';

export class CatalogueIntakeStore {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (!fence.rows[0]?.open) throw new CatalogueUnavailable('Access recovery is held');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new CatalogueUnavailable('Catalogue intake is busy; retry with the same key');
      }
      throw error;
    } finally { client.release(); }
  }

  async recordSearch(principalId: string, input: CandidateInput, candidates: unknown,
    position: { dataEpoch: string; sequence: string }): Promise<string> {
    const id = randomUUID();
    await this.transaction(async client => {
      await client.query(`INSERT INTO quota.catalogue_search
        (id, principal_id, data_epoch, sequence, input, candidates, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp() + interval '30 minutes')`,
      [id, principalId, position.dataEpoch, position.sequence, JSON.stringify(input), JSON.stringify(candidates)]);
    });
    return id;
  }

  /** A receipt is evidence of searching this title, not an assertion of uniqueness.
   * Successful retries retain the original receipt even after its intake expiry. */
  async reserve(admission: RegisteredAdmission, searchId: string, title: string, language: string,
    alternatives: readonly { value: string; language: string }[] = []): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(searchId)) throw new CatalogueInvalid('Candidate receipt is invalid');
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    await this.transaction(async client => {
      const principal = await client.query('SELECT id FROM access.principal WHERE id = $1 AND active FOR UPDATE', [admission.principalId]);
      if (!principal.rowCount) throw new CatalogueUnavailable('Contributor is inactive');
      const prior = (await client.query<{ search_id: string; data_epoch: string }>(
        'SELECT search_id, data_epoch FROM quota.catalogue_creation WHERE admission_id = $1', [admission.id])).rows[0];
      if (prior) {
        if (prior.search_id !== searchId || prior.data_epoch !== this.env.lineage.dataEpoch) {
          throw new CatalogueInvalid('Creation belongs to another candidate receipt or data epoch');
        }
        return;
      }
      const search = (await client.query<{ input: CandidateInput; data_epoch: string }>(`SELECT input, data_epoch
        FROM quota.catalogue_search WHERE id = $1 AND principal_id = $2 AND expires_at > clock_timestamp()`,
      [searchId, admission.principalId])).rows[0];
      const proposed = [{ value: title, language }, ...alternatives];
      if (!search || search.data_epoch !== this.env.lineage.dataEpoch
        || proposed.some(text => ![search.input.originalTitle, ...search.input.aliases, ...search.input.romanizations]
          .some(value => value.value === text.value.normalize('NFC').trim() && value.language === canonicalLanguage(text.language)))) {
        throw new CatalogueInvalid('Search this title and language before creating the Work');
      }
      const qualified = (await client.query(`SELECT g.id FROM access.permission_grant g
        JOIN access.scope_gate s ON s.id = g.scope_id AND s.open AND s.dispatch_open
        JOIN access.authority_subject a ON a.id = g.recipient_subject AND a.active
        JOIN access.representation r ON r.subject_id = a.id AND r.principal_id = $1
          AND r.action = 'catalogue.verify' AND r.active AND r.valid_until > clock_timestamp()
        WHERE g.recipient_subject = $2 AND g.scope_id = 'catalogue:verify:root'
          AND g.action = 'catalogue.verify' AND g.active AND g.valid_until > clock_timestamp()
        ORDER BY g.id LIMIT 1 FOR SHARE OF g, s, a, r`, [admission.principalId, admission.actingSubject])).rowCount === 1;
      // A grant exempts reviewer throughput; it does not silently verify the
      // submitted facts. Review is an explicit evidence-backed owner command.
      if (qualified) {
        await client.query(`INSERT INTO quota.catalogue_creation
          (admission_id,principal_id,search_id,quota_exempt,data_epoch) VALUES ($1,$2,$3,true,$4)`,
        [admission.id, admission.principalId, searchId, this.env.lineage.dataEpoch]);
        return;
      }
      // https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS
      // The principal lock serializes all its pending-slot allocations. The PK
      // and slot CHECK are the independent backstop; no historic Work count.
      const pending = (await client.query<{ slot: number; admission_id: string }>(`SELECT slot, admission_id
        FROM quota.catalogue_pending WHERE principal_id = $1 ORDER BY slot LIMIT 3`, [admission.principalId])).rows;
      for (const row of pending) {
        const terminal = await readWorkTerminalReceipt(this.env.fuseki, row.admission_id);
        if (!terminal || terminal.dataEpoch !== this.env.lineage.dataEpoch) continue;
        const verified = terminal.work && (await this.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} .
            FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
          GRAPH ${iri(GRAPHS.current)} { ${iri(terminal.work)} rv:provisional false } }`, 1024)).boolean;
        if (terminal.outcome === 'cancelled' || verified) {
          await client.query('DELETE FROM quota.catalogue_pending WHERE admission_id = $1', [row.admission_id]);
        }
      }
      const occupied = (await client.query<{ slot: number }>(
        'SELECT slot FROM quota.catalogue_pending WHERE principal_id = $1 ORDER BY slot LIMIT 3', [admission.principalId])).rows;
      const slot = [1, 2, 3].find(value => !occupied.some(row => row.slot === value));
      if (!slot) throw new CataloguePendingLimit('Three creations await verification');
      await client.query(`INSERT INTO quota.catalogue_creation
        (admission_id, principal_id, search_id, quota_exempt, data_epoch) VALUES ($1,$2,$3,false,$4)`,
      [admission.id, admission.principalId, searchId, this.env.lineage.dataEpoch]);
      await client.query('INSERT INTO quota.catalogue_pending(principal_id,slot,admission_id) VALUES ($1,$2,$3)',
      [admission.principalId, slot, admission.id]);
    });
  }
}

/** One bounded live probe shared by trusted consumers, including scored rows.
 * Absence of a provisional flag preserves pre-intake records' existing policy. */
export async function unverifiedWorks(env: WorkActivationEnvironment, works: readonly string[]): Promise<Set<string>> {
  if (works.length > CATALOGUE_COST.candidates) throw new CatalogueInvalid('Trust probe exceeds its batch bound');
  if (!works.length) return new Set();
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:provisional true } } LIMIT ${works.length + 1}`,
  CATALOGUE_COST.graphBytes)).results?.bindings ?? [];
  return new Set(rows.map(row => row.work!.value));
}
