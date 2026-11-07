import type { PoolClient } from 'pg';
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
): Promise<Output> {
  const statement = query['~standard'].query;
  const result = await db.query<(string | null)[]>({
    text: query.sql,
    values: [...statement.encode(input)],
    rowMode: 'array',
    types: { getTypeParser: () => (value: string) => value },
  });
  return statement.decode(result.rows);
}
