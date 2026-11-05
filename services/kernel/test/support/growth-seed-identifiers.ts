/** The supported PostgreSQL build reserves one byte of NAMEDATALEN=64 for the identifier terminator. */
export const POSTGRES_IDENTIFIER_BYTE_LIMIT = 63;

const TABLE_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const MAX_QUALIFIED_TABLE_NAME_LENGTH = POSTGRES_IDENTIFIER_BYTE_LIMIT * 2 + 1;
const IDENTIFIER_PREVIEW_LENGTH = POSTGRES_IDENTIFIER_BYTE_LIMIT + 1;

function describeIdentifier(identifier: string): string {
  if (identifier.length <= IDENTIFIER_PREVIEW_LENGTH) return JSON.stringify(identifier);
  const preview = JSON.stringify(identifier.slice(0, IDENTIFIER_PREVIEW_LENGTH));
  return `${preview}… (${identifier.length} UTF-16 code units)`;
}

export function seedTableTarget(name: string): { readonly schema: string; readonly table: string } {
  if (name.length > MAX_QUALIFIED_TABLE_NAME_LENGTH)
    throw new RangeError(
      `Growth seed table target ${describeIdentifier(name)} exceeds PostgreSQL's maximum qualified name length`,
    );
  if (!TABLE_NAME.test(name))
    throw new TypeError(`Invalid table name ${describeIdentifier(name)}; expected lowercase schema.table identifiers`);

  const separator = name.indexOf('.');
  const schema = name.slice(0, separator);
  const table = name.slice(separator + 1);
  if (schema.length > POSTGRES_IDENTIFIER_BYTE_LIMIT)
    throw new RangeError(
      `Growth seed schema identifier ${describeIdentifier(schema)} in table ${describeIdentifier(name)} exceeds ` +
        `PostgreSQL's ${POSTGRES_IDENTIFIER_BYTE_LIMIT}-byte identifier limit`,
    );
  if (table.length > POSTGRES_IDENTIFIER_BYTE_LIMIT)
    throw new RangeError(
      `Growth seed table identifier ${describeIdentifier(table)} in table ${describeIdentifier(name)} exceeds ` +
        `PostgreSQL's ${POSTGRES_IDENTIFIER_BYTE_LIMIT}-byte identifier limit`,
    );
  return { schema, table };
}

function invalidColumn(column: string, table: string, reason: string): never {
  throw new TypeError(
    `Invalid growth seed column identifier ${describeIdentifier(column)} for table ${describeIdentifier(table)}: ${reason}`,
  );
}

export function validateSeedColumnIdentifier(column: string, table: string): void {
  if (column.length === 0) invalidColumn(column, table, 'PostgreSQL identifiers must not be empty');
  if (column.length > POSTGRES_IDENTIFIER_BYTE_LIMIT)
    invalidColumn(column, table, `exceeds PostgreSQL's ${POSTGRES_IDENTIFIER_BYTE_LIMIT}-byte UTF-8 identifier limit`);

  let bytes = 0;
  for (let index = 0; index < column.length; index++) {
    const code = column.charCodeAt(index);
    if (code === 0) invalidColumn(column, table, 'PostgreSQL identifiers cannot contain NUL');

    let extra: number;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= column.length) invalidColumn(column, table, 'contains an unpaired UTF-16 surrogate');
      const next = column.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        invalidColumn(column, table, 'contains an unpaired UTF-16 surrogate');
      }
      extra = 4;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalidColumn(column, table, 'contains an unpaired UTF-16 surrogate');
    } else if (code <= 0x7f) extra = 1;
    else if (code <= 0x7ff) extra = 2;
    else extra = 3;

    bytes += extra;
    if (bytes > POSTGRES_IDENTIFIER_BYTE_LIMIT)
      invalidColumn(
        column,
        table,
        `exceeds PostgreSQL's ${POSTGRES_IDENTIFIER_BYTE_LIMIT}-byte UTF-8 identifier limit`,
      );
  }
}
