import type { Json } from 'reylo';

/** Materialize the JSON wire value for SQL parameters, including readonly domain records. */
export function jsonParameter(value: unknown): Json {
  return JSON.parse(JSON.stringify(value));
}
