import { expect, test } from 'bun:test';
import type { SubjectRead } from '@rezics/client';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import { Importer } from '../../../importer/src/importer.ts';
import type { SourceRegistration } from '../../../importer/src/import-contract.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openProviderCli } from './provider-cli-native-fixture.ts';

// Existing ordinary Auth/Access/CLI fixture, real native selected support and original receipts.
test('a real ordinary importer fills reviewed SourceRecords after validated input and actual selected Sources gains truthful attribution without changing bootstrap or semantic receipt identity', async () => {
  const registration = createSourceRegistration('bangumi');
  const cli = await openProviderCli('bangumi', registration.converter_revision);
  const text = JSON.stringify({ id: 17, type: 1, name: 'A sourced book' }) + '\n';
  const original: BatchWriteRequest[] = [];
  const transport = cli.runtime.importTransport;
  const oldRegistration: SourceRegistration = {
    source: registration.source,
    sourceKind: registration.sourceKind,
    converter_revision: registration.converter_revision,
    convert: registration.convert,
  };
  const importer = new Importer({
    path: cli.state,
    transport: {
      setSourceRecordMetadata: transport.setSourceRecordMetadata,
      readFence: (tuple) =>
        transport.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
      async batchWrite(body) {
        original.push(structuredClone(body));
        return transport.batch(body);
      },
    },
  });
  try {
    const imported = await importer.runDump(
      oldRegistration,
      (async function* () {
        yield new TextEncoder().encode(text);
      })(),
    );
    expect(imported.status).toBe('committed');
    await importer.close();
    const before = cli.inspect(['17']);
    const claim = before.records[0]!.claim;
    if (claim?.state !== 'bound') throw new Error('Expected an actual imported subject');
    const id = claim.subject;
    const selected = (await cli.candidates(id, 'wdt:P5732'))[0]!;
    expect(selected.source.external_id).toBe('17');
    await cli.select(id, selected);
    const read = async () => {
      const response = await cli.runtime.request(`/v1/subjects/${id}`);
      expect(response.status).toBe(200);
      return (await response.json()) as SubjectRead;
    };
    const initial = await read();
    expect(initial.subject.sourceRecords).toEqual([]);
    const bootstrap = original.find((body) => body.commands[0]?.op === 'create')!;
    const replay = async () => {
      const response = await cli.runtime.replay(
        new Request('https://kernel.import.test/v1/subjects:batchWrite', {
          method: 'POST',
          headers: { authorization: `Bearer ${cli.runtime.bulk.bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(bootstrap),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const receipt = await replay();
    const caughtUp = await cli.invoke(text);
    expect(caughtUp.code).toBe(0);
    expect(caughtUp.writes).toEqual([]);
    expect(caughtUp.metadataWrites).toHaveLength(1);
    const write = caughtUp.metadataWrites[0]!;
    expect(write.status).toBe(201);
    expect(write.headers.get('idempotency-key')).toBeTruthy();
    expect(write.responseHeaders.get('rezics-session-token')).toBeTruthy();
    expect(JSON.parse(write.bytes)).toEqual({
      source: 'bangumi',
      external_id: '17',
      metadata: registration.describeSourceRecord!('17'),
      expected_metadata_revision: null,
    });
    expect(JSON.parse(write.responseBytes)).toMatchObject({ metadata_revision: 1, effect: 'filled' });
    const current = await read();
    expect(current.subject.sourceRecords).toEqual([registration.describeSourceRecord!('17')]);
    expect(current.subject.statements).toEqual(initial.subject.statements);
    expect(current.subject.revision).toBe(initial.subject.revision);
    expect(cli.inspect(['17'])).toEqual(before);
    expect(await replay()).toEqual(receipt);
    const reopened = await cli.invoke(text);
    expect(reopened.code).toBe(0);
    expect(reopened.writes).toEqual([]);
    expect(reopened.metadataWrites).toEqual([]);
    expect(await read()).toEqual(current);
  } finally {
    await importer.close();
    await cli.close();
  }
}, 300_000);
