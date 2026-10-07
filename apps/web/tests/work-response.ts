type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { tag: 'J' | 'I' | 'E' | 'T'; value: Json };

/**
 * Flight framing/reference rules follow the pinned react-server-dom-webpack client:
 * parseModelString, resolveModule and startReadingFromStream in client.browser.production.js.
 * Keep every value and graph edge; only allocation IDs and emission order are request noise.
 */
export function canonicalFlight(stream: string): string {
  const bytes = new TextEncoder().encode(stream);
  const decode = new TextDecoder('utf-8', { fatal: true });
  const records = new Map<string, RecordValue>();
  const hints: { tag: string; value: Json }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes[offset] === 10) { offset++; continue; }
    const colon = bytes.indexOf(58, offset);
    if (colon < 0) throw new Error('Unterminated Flight record ID');
    const id = decode.decode(bytes.subarray(offset, colon));
    if (!/^[0-9a-f]*$/.test(id)) throw new Error('Invalid Flight record ID');
    offset = colon + 1;
    const lead = String.fromCharCode(bytes[offset]!);
    let tag: RecordValue['tag'] = 'J';
    let value: Json;
    if (lead === 'T') {
      const comma = bytes.indexOf(44, offset);
      if (comma < 0) throw new Error('Unterminated Flight text length');
      const length = decode.decode(bytes.subarray(offset + 1, comma));
      if (!/^[0-9a-f]+$/.test(length)) throw new Error('Invalid Flight text length');
      const end = comma + 1 + Number.parseInt(length, 16);
      if (end > bytes.length) throw new Error('Truncated Flight text');
      value = decode.decode(bytes.subarray(comma + 1, end));
      tag = 'T';
      offset = end;
    } else {
      if (lead !== 'H' && lead !== 'I' && lead !== 'E' && /^[A-Z#rx]$/.test(lead))
        throw new Error(`Unsupported Flight record tag ${lead}`);
      const newline = bytes.indexOf(10, offset);
      if (newline < 0) throw new Error('Unterminated Flight model');
      if (lead === 'H') {
        hints.push({ tag: String.fromCharCode(bytes[offset + 1]!),
          value: JSON.parse(decode.decode(bytes.subarray(offset + 2, newline))) as Json });
        offset = newline + 1;
        continue;
      }
      if (lead === 'I' || lead === 'E') { tag = lead; offset++; }
      value = JSON.parse(decode.decode(bytes.subarray(offset, newline))) as Json;
      offset = newline + 1;
    }
    if (!id || records.has(id)) throw new Error('Missing or duplicate Flight model ID');
    records.set(id, { tag, value });
  }
  if (!records.has('0')) throw new Error('Missing Flight root');
  const ids = new Map<string, number>([['0', 0]]);
  const queue = ['0'];
  const visit = (value: Json): Json => {
    if (typeof value === 'string') {
      // Symbols, scalar encodings and escaped $$ strings are values, not allocation IDs.
      const reference = value.match(/^\$(L|@|h|Q|W|B|K|i)?([0-9a-f]+)(:.*)?$/);
      if (!reference) return value;
      const id = reference[2]!;
      if (!records.has(id)) throw new Error(`Missing Flight reference ${id}`);
      if (!ids.has(id)) { ids.set(id, ids.size); queue.push(id); }
      return `$${reference[1] ?? ''}${ids.get(id)!.toString(16)}${reference[3] ?? ''}`;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  const models: RecordValue[] = [];
  for (let index = 0; index < queue.length; index++) {
    const record = records.get(queue[index]!)!;
    models.push({ tag: record.tag, value: record.tag === 'J' || record.tag === 'I' ? visit(record.value) : record.value });
  }
  const effects = hints.map(hint => ({ tag: hint.tag, value: visit(hint.value) }))
    .map(hint => JSON.stringify(hint)).sort();
  if (queue.length !== models.length || queue.length !== records.size)
    throw new Error('Flight contains data outside the root graph');
  return JSON.stringify({ models, effects });
}
