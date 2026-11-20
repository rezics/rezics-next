/** PostgreSQL JSON stores every exact market integer as a tagged decimal. */
export function encodeMarketRecord(value: object): string {
  return JSON.stringify(value, (_, field: unknown) =>
    typeof field === 'bigint' ? { $marketInteger: field.toString() } : field,
  );
}

export function decodeMarketRecord<Value>(value: string): Value {
  return JSON.parse(value, (_, field: unknown) => {
    if (typeof field !== 'object' || field === null || !('$marketInteger' in field)) return field;
    const integer = field.$marketInteger;
    if (
      Object.keys(field).length !== 1 ||
      typeof integer !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(integer) ||
      BigInt(integer) > (1n << 63n) - 1n
    ) {
      throw new Error('Invalid exact integer in stored market record');
    }
    return BigInt(integer);
  }) as Value;
}
