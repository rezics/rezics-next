import type { PoolClient, QueryConfig } from 'pg';
import type { StandardQueryV1 } from 'reylo';

/** Execute the declared statement inside an already admitted native work plan.
 * Schema analysis belongs to the compiler, rather than an undeclared runtime
 * catalog probe. Reylo still owns parameter binding, wire decoding and result
 * cardinality; pg supplies each selected value in PostgreSQL's text format.
 */
export async function nativeSourceQuery<Input, Output>(
  db: Pick<PoolClient, 'query'>,
  query: StandardQueryV1<Input, Output, 'postgres'> & { readonly sql: string },
  input: Input,
  transport?: 'compiled' | Readonly<{ name: string }>,
): Promise<Output> {
  const statement = query['~standard'].query;
  const result = await db.query<(string | null)[]>({
    ...(typeof transport === 'object' && { name: transport.name }),
    text: transport === 'compiled' ? statement.text : query.sql,
    values: [...statement.encode(input)],
    rowMode: 'array',
    types: { getTypeParser: () => (value: string) => value },
  });
  return statement.decode(result.rows);
}

/** Reuse only the declared statement's native plan. Schema checks and every parameter still go through the caller's client. */
export function preparedStatementClient<T extends Pick<PoolClient, 'query'>>(client: T, text: string, name: string): T {
  const transport = Object.create(client) as T;
  transport.query = ((query: QueryConfig | string, values?: unknown[]) =>
    client.query(typeof query === 'object' && query.text === text ? { ...query, name } : query, values)) as T['query'];
  return transport;
}
