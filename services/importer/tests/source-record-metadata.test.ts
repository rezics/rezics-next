import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { ImportTransportError } from '../src/import-client.ts';
import type { ImportTransport, SourceRegistration } from '../src/import-contract.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const bytes = (input: string) =>
  (async function* () {
    yield new TextEncoder().encode(input);
  })();
const record = (id: number, name = 'Book') => JSON.stringify({ id, type: 1, name }) + '\n';

function fixture() {
  const metadata = sourceRecordMetadataFixture();
  const batches: unknown[] = [];
  const transport: ImportTransport = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async batchWrite(request) {
      batches.push(structuredClone(request));
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
  };
  return { metadata, transport, batches };
}

test('reviewed descriptors use canonical provider identity even under another provider alias', () => {
  for (const [kind, id, name, url, licence] of [
    ['bangumi', '17', 'Bangumi', 'https://bgm.tv/subject/17', 'CC-BY-SA-3.0'],
    ['vndb', 'v17', 'VNDB', 'https://vndb.org/v17', 'ODbL-1.0'],
    ['openlibrary', '/books/OL17M', 'Open Library', 'https://openlibrary.org/books/OL17M', 'CC0-1.0'],
    ['wikidata', 'Q17', 'Wikidata', 'https://www.wikidata.org/wiki/Q17', 'CC0-1.0'],
  ] as const) {
    const registration = createSourceRegistration(kind, { source: 'community-feed' });
    expect(registration.describeSourceRecord!(id)).toMatchObject({ name, url, licence: { id: licence } });
    expect(() => registration.describeSourceRecord!('https://untrusted.test/')).toThrow();
  }
});

test('unchanged catch-up and changed descriptors use distinct durable metadata intents and actual CAS revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-record-metadata-'));
  const f = fixture();
  let importer = new Importer({ path: `${directory}/state.sqlite`, transport: f.transport });
  const native = createSourceRegistration('bangumi', { source: 'reviewed-feed' });
  // A previously ordinary community registration has no default metadata writer.
  const community: SourceRegistration = {
    source: native.source,
    sourceKind: native.sourceKind,
    converter_revision: native.converter_revision,
    convert: native.convert,
  };
  const run = (registration: SourceRegistration, text = record(17)) => importer.runDump(registration, bytes(text));
  try {
    expect((await run(community)).status).toBe('committed');
    expect(f.metadata.requests).toHaveLength(0);
    const baseline = importer.session.store.source(native.source);
    const originalBatches = structuredClone(f.batches);
    const owner = { source: native.source, external_id: '17' };
    expect((await run(native)).status).toBe('committed');
    expect(f.batches).toEqual(originalBatches);
    expect(importer.session.store.source(native.source)).toEqual(baseline);
    expect(f.metadata.requests).toHaveLength(1);
    const originalMetadata = importer.session.bindings.metadata(owner)!;
    expect(originalMetadata.result?.metadata_revision).toBe(1);
    expect(JSON.parse(originalMetadata.bytes)).toMatchObject({ ...owner, expected_metadata_revision: null });
    await importer.close();
    importer = new Importer({ path: `${directory}/state.sqlite`, transport: f.transport });
    expect((await run(native)).status).toBe('committed');
    expect(f.metadata.requests).toHaveLength(1);
    const corrected: SourceRegistration = {
      ...native,
      describeSourceRecord: (id) => ({
        ...native.describeSourceRecord!(id),
        attribution: 'Reviewed Bangumi contributors',
      }),
    };
    const server = f.transport.setSourceRecordMetadata!;
    let lose = true;
    f.transport.setSourceRecordMetadata = async (...args) => {
      const result = await server(...args);
      if (lose) {
        lose = false;
        throw new ImportTransportError();
      }
      return result;
    };
    expect((await run(corrected)).status).toBe('bulk-failed');
    const pending = importer.session.bindings.metadata(owner)!;
    expect(pending.result).toBeNull();
    expect(JSON.parse(pending.bytes).expected_metadata_revision).toBe(1);
    expect(importer.session.store.source(native.source)).toEqual(baseline);
    await importer.close();
    importer = new Importer({ path: `${directory}/state.sqlite`, transport: f.transport });
    f.transport.setSourceRecordMetadata = async () => {
      throw new ImportTransportError(403);
    };
    let acquired = false;
    const replacement = (async function* () {
      acquired = true;
      yield new TextEncoder().encode(record(18));
    })();
    expect((await importer.runDump(corrected, replacement)).status).toBe('bulk-failed');
    expect(acquired).toBe(false);
    expect(importer.session.bindings.metadata(owner)).toEqual(pending);
    f.transport.setSourceRecordMetadata = server;
    expect((await run(corrected, 'corrupt replacement')).status).toBe('committed');
    expect(importer.session.bindings.metadata(owner)?.result?.metadata_revision).toBe(2);
    expect(f.metadata.requests.at(-1)).toEqual(f.metadata.requests.at(-2));
    const count = f.metadata.requests.length;
    expect((await run(corrected)).status).toBe('committed');
    expect(f.metadata.requests).toHaveLength(count);
    expect(f.batches).toEqual(originalBatches);
    expect(
      importer.session.store.database
        .query('SELECT bytes,acknowledgement FROM binding_metadata_journal WHERE key=?')
        .get(originalMetadata.key),
    ).toEqual({ bytes: originalMetadata.bytes, acknowledgement: JSON.stringify(originalMetadata.result) });
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid, incomplete and mass-aborted acquisition cannot write metadata; partial fills and stale CAS stay explicit', async () => {
  const f = fixture();
  const importer = new Importer({ path: ':memory:', transport: f.transport });
  const registration = createSourceRegistration('bangumi');
  try {
    expect((await importer.runDump(registration, bytes(record(1) + record(2) + record(3)))).status).toBe('committed');
    const baseline = importer.session.store.source('bangumi');
    const count = f.metadata.requests.length;
    expect((await importer.runDump(registration, bytes(record(4) + '{broken'))).status).toBe('invalid-dump');
    const incomplete = (async function* () {
      yield new TextEncoder().encode(record(4));
      throw new Error('incomplete');
    })();
    expect((await importer.runDump(registration, incomplete)).status).toBe('invalid-dump');
    expect((await importer.runDump(registration, bytes(record(4)))).status).toBe('mass-disappearance');
    expect(f.metadata.requests).toHaveLength(count);
    expect(importer.session.store.source('bangumi')).toEqual(baseline);
    const command = {
      source: 'another-feed',
      external_id: '17',
      metadata: { name: 'Provider', url: 'https://provider.test/17' },
      expected_metadata_revision: null,
    };
    const first = await f.metadata.setSourceRecordMetadata({ command, idempotencyKey: 'partial-1' });
    expect(first.metadata_revision).toBe(1);
    const second = await f.metadata.setSourceRecordMetadata({
      command: { ...command, metadata: { ...command.metadata, attribution: 'Contributors' } },
      idempotencyKey: 'partial-2',
    });
    expect(second).toMatchObject({ effect: 'filled', metadata_revision: 2 });
    await expect(
      f.metadata.setSourceRecordMetadata({
        command: { ...command, expected_metadata_revision: 1, metadata: { ...command.metadata, name: 'Changed' } },
        idempotencyKey: 'stale',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.metadata.setSourceRecordMetadata({
        command: { ...command, metadata: { ...command.metadata, name: 'Changed' } },
        idempotencyKey: 'conflict',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.metadata.records.get(JSON.stringify(['another-feed', '17']))).toEqual(second);
  } finally {
    await importer.close();
  }
});
