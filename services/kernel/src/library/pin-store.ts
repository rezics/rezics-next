import type { PoolClient } from 'pg';

type Client = Pick<PoolClient, 'query'>;
export type PinPreference = { ids: string[]; revision: number };

export const PIN_PREFERENCE_READ_SQL =
  'SELECT collection_ids AS ids, revision::text AS revision FROM library.collection_pins WHERE route=$1 AND account_id=$2';
export const PIN_PREFERENCE_INSERT_SQL = `INSERT INTO library.collection_pins (route, account_id, collection_ids, revision)
     SELECT $1, $2, $3::uuid[], 1 WHERE $4::bigint=0
     ON CONFLICT (route, account_id) DO NOTHING RETURNING revision`;
export const PIN_PREFERENCE_UPDATE_SQL = `UPDATE library.collection_pins SET collection_ids=$3::uuid[], revision=revision+1
     WHERE route=$1 AND account_id=$2 AND revision=$4::bigint RETURNING revision`;

export type PinStoreStatement = Readonly<
  | { kind: 'read'; sql: string; values: readonly [number, string] }
  | {
      kind: 'insert' | 'update';
      sql: string;
      values: readonly [number, string, readonly string[], number];
      before: number;
    }
>;
export type PinStoreExecutor = <T>(statement: PinStoreStatement, dispatch: () => Promise<T>) => Promise<T>;
const direct: PinStoreExecutor = (_statement, dispatch) => dispatch();

/** One owner point, bounded by the table's 100-ID constraint. Empty reads never initialize storage. */
export async function readPins(
  client: Client,
  route: number,
  accountId: string,
  execute: PinStoreExecutor = direct,
): Promise<PinPreference> {
  const values = Object.freeze([route, accountId] as const);
  const result = await execute(Object.freeze({ kind: 'read', sql: PIN_PREFERENCE_READ_SQL, values }), () =>
    client.query<{ ids: string[]; revision: string }>(PIN_PREFERENCE_READ_SQL, [...values]),
  );
  const row = result.rows[0];
  return row ? { ids: row.ids, revision: Number(row.revision) } : { ids: [], revision: 0 };
}

/** CAS includes absent-row arbitration; caller supplies the native owner transaction. */
export async function writePins(
  client: Client,
  route: number,
  accountId: string,
  before: number,
  ids: string[],
  execute: PinStoreExecutor = direct,
) {
  const originalIds = Object.freeze([...ids]);
  const values = Object.freeze([route, accountId, originalIds, before] as const);
  const result = await execute(Object.freeze({ kind: 'insert', sql: PIN_PREFERENCE_INSERT_SQL, values, before }), () =>
    client.query(PIN_PREFERENCE_INSERT_SQL, [...values]),
  );
  if (result.rowCount) return true;
  const updated = await execute(Object.freeze({ kind: 'update', sql: PIN_PREFERENCE_UPDATE_SQL, values, before }), () =>
    client.query(PIN_PREFERENCE_UPDATE_SQL, [...values]),
  );
  return updated.rowCount === 1;
}
