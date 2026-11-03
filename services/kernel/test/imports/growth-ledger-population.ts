import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';

/** Disjoint setup keys in the measured source, independent of native catalogue placement. */
export function createGrowthLedgerPopulation(db: Database) {
  const sizes = new Map<string, { catalogueRecords: number; historyRows: number }>();
  return (input: { catalogueRecords: number; historyRows: number }, measuredSource: string) => {
    for (const source of new Set([measuredSource, 'seed-other'])) {
      const prior = sizes.get(source) ?? { catalogueRecords: 0, historyRows: 0 };
      const registration = createSourceRegistration('bangumi', { source, converterRevision: 'seed-v1' });
      db.transaction(() => {
        for (let ordinal = input.catalogueRecords; ordinal < prior.catalogueRecords; ordinal++)
          db.query('DELETE FROM run_members WHERE source=? AND record_key=?').run(source, String(1000000 + ordinal));
        for (let ordinal = input.historyRows; ordinal < prior.historyRows; ordinal++)
          db.query('DELETE FROM run_generations WHERE source=? AND id=?').run(source, String(1000000 + ordinal));
        for (let ordinal = prior.catalogueRecords; ordinal < input.catalogueRecords; ordinal++) {
          const id = 1000000 + ordinal;
          const converted = registration.convert(
            { external_id: String(id), record_revision: null, record: { id, type: 1, name: `Unrelated ${id}` } },
            { source },
          );
          const row = {
            source,
            recordKey: String(id),
            recordRevision: 'unversioned',
            digest: converted.digest,
            converter_revision: 'seed-v1',
            state: 'vanished',
          };
          db.query('INSERT INTO run_members(source,record_key,active,seen,row_json) VALUES(?,?,?,?,?)').run(
            source,
            row.recordKey,
            0,
            0,
            JSON.stringify(row),
          );
        }
        for (let ordinal = prior.historyRows; ordinal < input.historyRows; ordinal++)
          db.query('INSERT INTO run_generations(source,id,seq,lease,status,threshold,prior) VALUES(?,?,?,?,?,?,?)').run(
            source,
            String(1000000 + ordinal),
            1000000 + ordinal,
            createHash('sha256').update(String(ordinal)).digest('hex').slice(0, 48),
            'abandoned',
            0.2,
            0,
          );
      })();
      sizes.set(source, { ...input });
    }
    db.exec('ANALYZE');
  };
}
