// Typed column catalogs for the commerce, quota, site and Realm reply owners.
// SQL migrations remain the DDL owner. Each catalog names every column's
// PostgreSQL udt and nullability; the schema migration test compares it with
// the installed catalog. Owner adapters type selected rows as
// `OwnerRow<typeof catalog.table>`, following the default node-postgres parsers.

type PgColumn = 'uuid' | 'text' | 'int8' | 'int2' | 'int4' | 'bool' | 'timestamptz' | 'jsonb' | 'interval';
export type OwnerColumns = Record<string, Record<string, PgColumn | `${PgColumn}?`>>;

/** node-postgres parses interval values into this shape. */
interface PgInterval {
  years?: number; months?: number; days?: number;
  hours?: number; minutes?: number; seconds?: number; milliseconds?: number;
}

interface PgValues {
  uuid: string;
  text: string;
  int8: string;
  int2: number;
  int4: number;
  bool: boolean;
  timestamptz: Date;
  jsonb: Record<string, unknown>;
  interval: PgInterval;
}

type Value<C> = C extends `${infer T extends PgColumn}?` ? PgValues[T] | null
  : C extends PgColumn ? PgValues[C] : never;

/** One selected row of a catalog table, with snake_case column names. */
export type OwnerRow<Columns extends Record<string, string>> = { [K in keyof Columns]: Value<Columns[K]> };
