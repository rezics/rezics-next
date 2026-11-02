export { createImportTransport } from '../src/import-client.ts';
import { isDeepStrictEqual } from 'node:util';
import { createImportTransport } from '../src/import-client.ts';
import { isImportSourceRecord } from '../src/source-record-runtime.ts';
import {
  type ImportSourceRecordMetadataCommand,
  type ImportSourceRecordMetadataResult,
} from '../src/import-contract.ts';

/** Local protocol double only. Real authorization/selection proof uses the kernel API fixture. */
export function sourceRecordMetadataFixture() {
  const records = new Map<string, ImportSourceRecordMetadataResult>();
  const receipts = new Map<string, { bytes: string; result: ImportSourceRecordMetadataResult; status: number }>();
  const requests: { command: ImportSourceRecordMetadataCommand; key: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname !== '/v1/source-records:setMetadata' || request.method !== 'POST')
      throw new Error('Unexpected metadata fixture request');
    const command = (await request.json()) as ImportSourceRecordMetadataCommand;
    const key = JSON.parse(request.headers.get('idempotency-key')!) as string;
    requests.push({ command: structuredClone(command), key });
    if (!isImportSourceRecord(command.metadata)) return Response.json({}, { status: 422 });
    const bytes = JSON.stringify(command);
    const receipt = receipts.get(key);
    if (receipt)
      return receipt.bytes === bytes
        ? Response.json(receipt.result, { status: receipt.status })
        : Response.json({}, { status: 422 });
    const tuple = JSON.stringify([command.source, command.external_id]);
    const previous = records.get(tuple);
    let record = structuredClone(command.metadata);
    const expected = command.expected_metadata_revision;
    if (expected === null && previous) {
      const leaves = (value: typeof record) => ({
        name: value.name,
        url: value.url,
        ...(value.attribution === undefined ? {} : { attribution: value.attribution }),
        ...(value.licence
          ? { id: value.licence.id, ...(value.licence.url ? { licenceUrl: value.licence.url } : {}) }
          : {}),
      });
      const prior = leaves(previous.record),
        next = leaves(record);
      if (Object.entries(next).some(([key, value]) => key in prior && Reflect.get(prior, key) !== value))
        return Response.json({}, { status: 409 });
      record = {
        ...previous.record,
        ...record,
        ...(previous.record.licence || record.licence
          ? { licence: { ...previous.record.licence, ...record.licence } as NonNullable<typeof record.licence> }
          : {}),
      };
    } else if (expected !== null && expected !== previous?.metadata_revision) return Response.json({}, { status: 409 });
    const changed = !isDeepStrictEqual(record, previous?.record);
    const result: ImportSourceRecordMetadataResult = {
      record,
      metadata_revision: (previous?.metadata_revision ?? 0) + (changed ? 1 : 0),
      effect: changed ? (expected === null ? 'filled' : 'corrected') : 'noEffect',
    };
    const status = previous ? 200 : 201;
    if (changed) records.set(tuple, structuredClone(result));
    receipts.set(key, { bytes, result: structuredClone(result), status });
    return Response.json(result, { status, headers: { 'rezics-session-token': 'metadata-session' } });
  }) as typeof globalThis.fetch;
  const transport = createImportTransport({
    origin: 'https://metadata.test',
    tokenProvider: async () => 'local-fixture',
    fetch,
  });
  return { records, receipts, requests, fetch, setSourceRecordMetadata: transport.setSourceRecordMetadata };
}
