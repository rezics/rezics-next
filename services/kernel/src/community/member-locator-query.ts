import type { PoolClient, QueryResultRow } from 'pg';

/** Bind the analysed statement while keeping row cardinality explicit at the call site. */
export function memberLocatorQuery<Row extends QueryResultRow = QueryResultRow>(
  client: Pick<PoolClient, 'query'>,
  statement: { sql: string; params: readonly string[] },
  args: Readonly<Record<string, unknown>>,
) {
  return client.query<Row>(
    statement.sql,
    statement.params.map((name) => args[name]),
  );
}
