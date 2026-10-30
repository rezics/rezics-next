import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import { runImportCli } from '../src/cli.ts';
import { ImportSession } from '../src/import-session.ts';
import { readArchive } from '../src/archive.ts';
import { readDump } from '../src/dumps.ts';
import { DEFAULT_DUMP_CHUNK_BYTES } from '../src/dumps-bytes.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, VndbTablesStore } from '../src/vndb-tables.ts';

// Keep the importer compiler independent of the kernel's native SQL compiler.
// This URL loads the exact caller bytes at test runtime without starting its world.
const fixture = new URL('../../kernel/test/imports/cli-reviewed-source-reduction-fixture.ts', import.meta.url);
const { reviewedProviderInput } = (await import(fixture.href)) as {
  reviewedProviderInput(source: 'vndb' | 'openlibrary' | 'wikidata', count: number): Uint8Array;
};

// Pure preflight of the exact native input bytes used by the connected caller.
// No Auth/application database/worker starts, and this is not native acceptance.
for (const source of ['vndb', 'openlibrary', 'wikidata'] as const) {
  test(`${source} reviewed CLI input retains native revisions and converter digests through five/three acquisition and the empty input policy`, async () => {
    const registration = createSourceRegistration(source, { source });
    const acquire = async (count: number) => {
      const bytes = reviewedProviderInput(source, count);
      let eof = false;
      const input = (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 127) yield bytes.slice(offset, offset + 127);
        eof = true;
      })();
      const records: SourceRecord[] = [];
      if (source === 'vndb') {
        const database = new Database(':memory:');
        try {
          const store = new VndbTablesStore(database);
          await store.begin(source, 'pure-reviewed-input');
          const staging = store.stage(
            source,
            'pure-reviewed-input',
            readArchive(input, {
              maxTotalBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
              maxChunkBytes: DEFAULT_DUMP_CHUNK_BYTES,
              maxMetadataBytes: 4096,
              onProgress() {},
            }),
          );
          if (count === 0) {
            await expect(staging).rejects.toThrow('VNDB table staging failed');
            expect(eof).toBe(true);
            return [];
          }
          await staging;
          const page = store.page(source, 'pure-reviewed-input', { after: null, limit: 16 });
          expect(page.next).toBeNull();
          for (const row of page.records)
            records.push({ source, key: row.key, revision: String(row.revision), payload: row.record });
        } finally {
          database.close();
        }
      } else {
        for await (const record of readDump(source, input)) records.push(record);
      }
      expect(eof).toBe(true);
      expect(records).toHaveLength(count);
      return records.map((record, i) => {
        const revision =
          source === 'vndb' ? String(7 + i) : source === 'openlibrary' ? String(11 + i) : String(24681012 + i);
        expect(record.revision).toBe(revision);
        const converted = registration.convert(
          { external_id: record.key, record_revision: record.revision!, record: record.payload },
          { source },
        );
        const reopened = registration.convert(
          {
            external_id: record.key,
            record_revision: record.revision!,
            record: JSON.parse(JSON.stringify(converted.normalized)),
          },
          { source },
        );
        expect(reopened.digest).toBe(converted.digest);
        expect(reopened.proposals).toEqual(converted.proposals);
        expect(converted.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(converted.proposals.length).toBeGreaterThan(0);
        for (const command of converted.proposals) {
          expect(command.source.external_id).toBe(record.key);
          expect(command.source.record_revision).toBe(revision);
          expect(command.source.converter_revision).toBe(registration.converter_revision);
        }
        return {
          key: record.key,
          revision: record.revision,
          digest: converted.digest,
          proposals: converted.proposals,
          normalized: converted.normalized,
        };
      });
    };
    const five = await acquire(5);
    expect(new Set(five.map((r) => r.key)).size).toBe(5);
    expect(await acquire(3)).toEqual(five.slice(0, 3));
    expect(await acquire(0)).toEqual([]);
    if (source !== 'vndb') return;

    const directory = await mkdtemp('/dev/shm/reviewed-reduction-local-');
    try {
      const state = join(directory, 'state.sqlite');
      const session = new ImportSession(state);
      let baseline;
      try {
        const run = session.store.begin(source);
        if (run === 'busy') throw new Error('Unexpected fresh-state lease');
        for (const row of five.slice(0, 3))
          session.store.stage(run, {
            row: {
              source,
              recordKey: row.key,
              recordRevision: row.revision!,
              digest: row.digest,
              converter_revision: registration.converter_revision,
              state: 'present',
            },
            projection: { sourceKind: source, normalizedRecord: row.normalized },
          });
        expect(session.store.seal(run, { complete: true }).status).toBe('ready');
        for (const row of five.slice(0, 3)) {
          session.store.classify(run, row.key, { commands: [] });
          expect(session.bindings.candidates({ source, external_id: row.key }, 'facts', { limit: 100 })).toEqual([]);
          session.store.acknowledgeNoEffects(run, row.key, { reason: 'no-owned-candidates' });
        }
        expect(session.store.finalize(run, 100)).toBe('complete');
        baseline = session.store.source(source);
      } finally {
        session.close();
      }
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const key = join(directory, 'account.jwk');
      await writeFile(
        key,
        JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256' }),
        { mode: 0o600 },
      );
      const empty = reviewedProviderInput(source, 0);
      // The second archive is hostile: a complete empty prefix followed by junk.
      // Neither complete loss nor malformed acquisition may reach Auth or effects.
      for (const [input, code] of [
        [empty, 3],
        [Buffer.concat([empty, new Uint8Array([1])]), 2],
      ] as const) {
        const requests: string[] = [];
        const result = await runImportCli(
          [
            '--source',
            source,
            '--dump',
            '-',
            '--state',
            state,
            '--api',
            'https://api.import.test',
            '--auth',
            'https://auth.import.test',
            '--account-key',
            key,
            '--account',
            randomUUID(),
            '--client',
            'reviewed-reduction-local',
            '--disappearance-threshold',
            '1',
          ],
          {
            stdin: (async function* () {
              yield input;
            })(),
            fetch: (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
              const request = input instanceof Request ? input : new Request(input, init);
              requests.push(request.url);
              throw new Error('Stopped acquisition reached network');
            }) as typeof fetch,
          },
        );
        expect(result.code, JSON.stringify(result)).toBe(code);
        expect(result.openHandles).toBe(0);
        expect(requests).toEqual([]);
        const reopened = new ImportSession(state);
        try {
          expect(reopened.store.source(source)).toEqual(baseline);
        } finally {
          reopened.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
