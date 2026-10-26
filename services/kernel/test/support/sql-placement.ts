import { Glob } from 'bun';

/** A quoted string. The capture is the text inside one pair of quotes. */
export const literal = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs;

// COPY is matched in upper or lower case only. Title case is a word, as in "Copy revision conflicts",
// and is not a statement. Other keywords stay case-insensitive.
const keyword =
  'SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|VALUES|TABLE|CALL|DO|TRUNCATE|LOCK|EXPLAIN|CREATE|ALTER|DROP|GRANT|REVOKE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LISTEN|NOTIFY';

export const statement = new RegExp(`^\\s*(?:(?i:${keyword})|(?-i:COPY|copy))\\s+\\S`);

/** Transaction control TypeScript may send inline. `BEGIN READ ONLY` is not this form. */
export const transactionControl = /^(?:BEGIN ISOLATION LEVEL |SET LOCAL )/;

/** Every string literal under `directory` that reads as SQL, except transaction control, as `file:line text`. */
export async function inlineStatements(directory: string): Promise<string[]> {
  const root = directory.endsWith('/') ? directory : `${directory}/`;
  const found: string[] = [];
  for await (const file of new Glob('**/*.ts').scan(root)) {
    const text = await Bun.file(`${root}${file}`).text();
    for (const match of text.matchAll(literal)) {
      const sql = match[2]!;
      if (!statement.test(sql) || transactionControl.test(sql)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      found.push(`${file}:${line} ${sql.split('\n')[0]!.trim()}`);
    }
  }
  return found.sort();
}
