import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  importDataset,
  intakeChunks,
  reconstructIntake,
  semanticBatches,
  projectionLanguage,
  nativeBatchSize,
} from '../../../scripts/datasets/import.ts';
import { localDatasetSession, type DatasetApi } from '../../../scripts/datasets/auth.ts';
import { repository, sha256 } from '../../../scripts/datasets/store.ts';
import { datasetStackMarker } from '../../../scripts/datasets/bootstrap.ts';
import { acquireDatasetImportLock, datasetImportLockPath } from '../../../scripts/datasets/lock.ts';
import type { DatasetRecord, DatasetSnapshot } from '../../../scripts/datasets/types.ts';

const roots: string[] = [];
const root = () => {
  const directory = resolve('.temp/dataset-import-tests', crypto.randomUUID());
  mkdirSync(directory, { recursive: true });
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const iri = (value: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const record = (key: string, native: DatasetRecord['native'] = 'source-only'): DatasetRecord => ({
  key,
  provider: 'vndb',
  kind: 'vn',
  externalId: key,
  title: `${key}\n[Title]`,
  language: 'ja',
  sourceUrl: 'https://vndb.org/v11',
  native,
  data: { nested: { empty: null }, flags: ['x', 'y'] },
});
const snapshot = (records: DatasetRecord[]): DatasetSnapshot => ({
  format: 'rezics-local-dataset-v1',
  id: 'test-snapshot',
  digest: 'a'.repeat(64),
  createdAt: '2026-10-02T00:00:00Z',
  sources: [
    {
      provider: 'vndb',
      roots: [records[0]?.key ?? ''],
      records,
      edges:
        records.length > 1
          ? [
              {
                from: records[0]!.key,
                to: records[1]!.key,
                kind: 'character',
                data: { spoiler: 2, order: 1 },
              },
            ]
          : [],
      images: [],
      scope: { complete: true },
    },
  ],
  images: [],
  captures: [],
});
function apiFixture() {
  const requests: { path: string; key?: string; body: unknown }[] = [],
    receipts = new Map<string, Record<string, unknown>>();
  let id = 1,
    lost = false,
    loseAfterCommit = false;
  const api: DatasetApi = {
    async request(_method, path, body, key) {
      requests.push({ path, body, key });
      if (path === '/v1/catalogue/candidates')
        return {
          status: 200,
          body: {
            candidateReceipt: '00000000-0000-4000-8000-999999999999',
            sourcePosition: { dataEpoch: 'epoch-1' },
            candidates: [],
          },
        };
      if (!key) throw new Error('Every product mutation requires an idempotency key');
      if (receipts.has(key)) return { status: 200, body: receipts.get(key)! };
      let receipt: Record<string, unknown>;
      if (path === '/v1/sources/intakes')
        receipt = { observation: { observation: iri(id++), record: iri(id++) }, replayed: false };
      else if (path === '/v1/works') {
        expect(body).not.toHaveProperty('authoring');
        expect(body).toHaveProperty('candidateReceipt');
        receipt = {
          work: iri(id++),
          mainVersion: iri(id++),
          workRevision: iri(id++),
          mainRevision: iri(id++),
        };
      } else if (path === '/v1/work-imports/bulk') {
        const items = (body as { items: { key: string; input: unknown }[] }).items;
        receipt = { complete: true, partial: false, items: items.map(item => ({ key: item.key, status: 'succeeded',
          receipt: { outcome: 'succeeded', work: iri(id++), mainVersion: iri(id++), workRevision: iri(id++), mainRevision: iri(id++) } })) };
      } else if (path === '/v1/semantic/changes/bulk') {
        expect(body).not.toHaveProperty('target');
        const states = (body as { items: { properties: unknown[] }[] }).items;
        receipt = {
          items: states.map(() => ({ component: iri(id++), revision: iri(id++) })),
          receipt: iri(id++),
        };
      } else throw new Error(`Unexpected public route ${path}`);
      receipts.set(key, receipt);
      if (loseAfterCommit && !lost) {
        lost = true;
        throw new Error('closed socket after commit');
      }
      return { status: 201, body: receipt };
    },
  };
  return {
    api,
    requests,
    receipts,
    loseNextResponse: () => {
      loseAfterCommit = true;
    },
  };
}
const options = (api: DatasetApi) => ({
  api,
  actingSubject: iri(9000),
  mainOrigin: 'http://127.0.0.1:3001',
  webOrigin: 'http://127.0.0.1:3000',
});

describe('independent public-API dataset import', () => {
  test('lossless JSON parts respect intake byte bounds and detect missing/corrupt/reordered parts', () => {
    const source = {
      title: '命運'.repeat(50_000),
      nested: ['x', null, { roles: ['voice', 'staff'] }],
    };
    const parts = intakeChunks(source);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(65_536);
      expect(() => JSON.parse(part.toString())).not.toThrow();
    }
    expect(reconstructIntake(parts)).toEqual(source);
    expect(() => reconstructIntake(parts.slice(1))).toThrow();
    expect(() => reconstructIntake([...parts].reverse())).toThrow();
    const corrupted = JSON.parse(parts[0]!.toString());
    corrupted.bytes = Buffer.from('changed').toString('base64');
    expect(() =>
      reconstructIntake([Buffer.from(JSON.stringify(corrupted)), ...parts.slice(1)]),
    ).toThrow('Corrupt');
    expect(reconstructIntake(intakeChunks({ x: 1 }))).toEqual({ x: 1 });
  });

  test('replays exact committed request after lost response and resumes without duplicating records', async () => {
    const fixture = apiFixture(),
      directory = root(),
      source = snapshot([record('v11')]);
    fixture.loseNextResponse();
    const first = await importDataset(directory, source, {
      ...options(fixture.api),
      native: false,
    });
    expect(first.observations).toBe(2);
    const mutations = fixture.requests.filter((call) => call.path === '/v1/sources/intakes');
    expect(mutations[0]?.key).toBe(mutations[1]?.key);
    expect(mutations[0]?.body).toEqual(mutations[1]?.body);
    const count = fixture.receipts.size;
    await importDataset(directory, source, { ...options(fixture.api), native: false });
    expect(fixture.receipts.size).toBe(count);
    expect(fixture.requests.filter((call) => call.path === '/v1/sources/intakes')).toHaveLength(
      mutations.length,
    );
  });

  test('keeps complete relationships, API-allocated IDs, and useful Markdown headings/URLs', async () => {
    const fixture = apiFixture(),
      work = record('v11', 'work'),
      character = record('c22', 'character');
    work.title = 'Fate/stay night';
    character.title = 'Saber\n[Artoria]';
    const result = await importDataset(root(), snapshot([work, character]), options(fixture.api));
    expect(result.nativeRecords).toBe(2);
    const firstIntake = fixture.requests.find((call) => call.path === '/v1/sources/intakes')!
      .body as { rawBytesBase64: string };
    const evidence = JSON.parse(Buffer.from(firstIntake.rawBytesBase64, 'base64').toString());
    expect(evidence.edges[0].data).toEqual({ spoiler: 2, order: 1 });
    const creation = fixture.requests.find((call) => call.path === '/v1/work-imports/bulk')!;
    expect(creation.body).not.toHaveProperty('id');
    const semantic = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { properties: unknown[] }[] };
    expect(
      semantic.items[0]!.properties.some((property) =>
        JSON.stringify(property).includes('semanticWork'),
      ),
    ).toBe(true);
    const markdown = readFileSync(result.urlsFile, 'utf8');
    expect(markdown).toContain('### Saber Artoria (c22)');
    expect(markdown).toContain('http://127.0.0.1:3000/zh-Hant/w/');
    expect(markdown).toContain('http://127.0.0.1:3000/zh-Hant/e/');
    expect(markdown).toContain('/v1/sources/observations/');
    expect(markdown).not.toContain('3000/zh-Hant/sources/'); // source observations have API paths only
  });

  test('catalogue people stay source-qualified resources and never become controlled Agent identities', async () => {
    const fixture = apiFixture(),
      work = record('v11', 'work'),
      person = record('staff-1', 'person');
    work.title = 'Fate/stay night';
    person.title = 'Kinoko Nasu';
    const result = await importDataset(root(), snapshot([work, person]), options(fixture.api));
    expect(result.nativeRecords).toBe(2);
    expect(fixture.requests.some((call) => call.path === '/v1/agents')).toBe(false);
    const semantic = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { types: string[] }[] };
    expect(semantic.items[0]!.types).toEqual(['https://schema.org/Person']);
  });

  test('keeps partial URL receipts after a rejected write and aggregates later snapshots', async () => {
    const fixture = apiFixture(),
      directory = root(),
      source = snapshot([record('v11'), record('c22')]);
    const api: DatasetApi = {
      request(method, path, body, key) {
        if (
          path === '/v1/sources/intakes' &&
          (body as { externalId: string }).externalId === 'c22'
        ) {
          return Promise.resolve({ status: 403, body: { code: 'authority_denied' } });
        }
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(
      importDataset(directory, source, { ...options(api), native: false }),
    ).rejects.toThrow('HTTP 403');
    const partial = readFileSync(join(directory, 'urls.md'), 'utf8');
    expect(partial).toContain('### v11 Title (v11)');
    expect(partial).not.toContain('### c22 Title (c22)');
    await importDataset(directory, source, { ...options(fixture.api), native: false });
    const second = snapshot([record('other')]);
    second.id = 'another-snapshot';
    second.digest = 'b'.repeat(64);
    await importDataset(directory, second, { ...options(fixture.api), native: false });
    const combined = readFileSync(join(directory, 'urls.md'), 'utf8');
    expect(combined).toContain('## Snapshot test-snapshot');
    expect(combined).toContain('## Snapshot another-snapshot');
    expect(combined).toContain('### c22 Title (c22)');
    expect(combined).toContain('### other Title (other)');
  });

  test('bulk projections stay within API page bounds and rehydrate returned child identities after a crash', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work');
    work.title = 'Fate/stay night';
    const children = Array.from({ length: 140 }, (_, index) =>
      record(`character-${index}`, 'character'),
    );
    const source = snapshot([work, ...children]);
    source.sources[0]!.edges = children.map((child) => ({
      from: work.key,
      to: child.key,
      kind: 'appearance',
      data: { role: 'main' },
    }));
    let lost = false;
    const api: DatasetApi = {
      async request(method, path, body, key) {
        const response = await fixture.api.request(method, path, body, key);
        if (path === '/v1/semantic/changes/bulk' && !lost) {
          lost = true;
          throw new Error('batch response lost after commit');
        }
        return response;
      },
    };
    const first = await importDataset(directory, source, { ...options(api), nativeBatchItems: 64 });
    expect(first.nativeRecords).toBe(141);
    const bulkCalls = fixture.requests.filter((call) => call.path === '/v1/semantic/changes/bulk');
    expect(bulkCalls).toHaveLength(4); // first64 replays once, then the remaining bounded batches
    expect(bulkCalls[0]!.key).toBe(bulkCalls[1]!.key);
    expect(bulkCalls[0]!.body).toEqual(bulkCalls[1]!.body);
    const journal = JSON.parse(readFileSync(first.receiptFile, 'utf8'));
    journal.native = {};
    // Simulate interruption between the atomic API result and summary checkpoint.
    writeFileSync(first.receiptFile, JSON.stringify(journal));
    const count = fixture.receipts.size;
    const resumed = await importDataset(directory, source, {
      ...options(fixture.api),
      nativeBatchItems: 128,
    });
    expect(resumed.nativeRecords).toBe(141);
    expect(fixture.receipts.size).toBe(count);
    const large = Array.from({ length: 40 }, (_, index) => ({
      key: String(index),
      state: { label: 'x'.repeat(10_000) },
    }));
    const batches = semanticBatches(large);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches)
      for (let start = 0; start < batch.length; start += 16) {
        expect(
          batch
            .slice(start, start + 16)
            .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.state)) + 512, 0),
        ).toBeLessThanOrEqual(60_000);
      }
  });

  test('native batch size is bounded/configurable and128-item pages retain allocation margins', () => {
    expect(nativeBatchSize(undefined)).toBe(16);
    expect(nativeBatchSize('16')).toBe(16);
    expect(nativeBatchSize('128')).toBe(128);
    for (const invalid of ['0', '129', '1.5', '01', '-1', 'all'])
      expect(() => nativeBatchSize(invalid)).toThrow('integer');
    const items = Array.from({ length: 180 }, (_, index) => ({
      key: String(index),
      state: {
        component: 'resource',
        lifecycle: 'active',
        types: ['https://schema.org/Person'],
        properties: [
          {
            predicate: 'https://schema.org/name',
            value: { kind: 'language-string', language: 'ja', lexical: `Fixture${index}` },
          },
        ],
      },
    }));
    const batches = semanticBatches(items, 128);
    expect(batches.map((batch) => batch.length)).toEqual([128, 52]);
    for (const batch of batches) {
      let total = 0;
      for (let start = 0; start < batch.length; start += 16) {
        const page = batch
          .slice(start, start + 16)
          .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.state)) + 512, 0);
        expect(page).toBeLessThanOrEqual(60_000);
        total += page;
      }
      expect(total).toBeLessThanOrEqual(524_288);
    }
  });

  test('large cancelled batches reduce to16 only after immutable cancellation proof, preserving all source nodes', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work');
    work.title = 'Fate/stay night';
    const children = Array.from({ length: 40 }, (_, i) => record(`character-${i}`, 'character'));
    const source = snapshot([work, ...children]);
    source.sources[0]!.edges = children.map((child) => ({
      from: work.key,
      to: child.key,
      kind: 'appearance',
      data: { role: 'main' },
    }));
    const pending: DatasetApi = {
      wait: async () => {},
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk')
          return Promise.resolve({ status: 202, body: { status: 'reconciling', result: null } });
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(
      importDataset(directory, source, { ...options(pending), nativeBatchItems: 64 }),
    ).rejects.toThrow('remains pending');
    const proven: DatasetApi = {
      ...fixture.api,
      bulkStatus: async () => ({
        state: 'cancelled',
        admission: 'terminal-owner',
        receipt: `urn:rezics:receipt:${'b'.repeat(64)}`,
        dataEpoch: 'epoch-1',
        stageCount: 1,
      }),
    };
    const completed = await importDataset(directory, source, {
      ...options(proven),
      nativeBatchItems: 64,
    });
    expect(completed.nativeRecords).toBe(41);
    const activated = fixture.requests
      .filter((call) => call.path === '/v1/semantic/changes/bulk')
      .map((call) => (call.body as { items: unknown[] }).items.length);
    expect(activated).toEqual([16, 16, 8]);
  });

  test('rejected atomic semantic batches publish no invented native child IDs', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      person = record('person', 'person');
    work.title = 'Fate/stay night';
    const api: DatasetApi = {
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk')
          return Promise.resolve({ status: 422, body: { code: 'semantic_stage_nonconforming' } });
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(importDataset(directory, snapshot([work, person]), options(api))).rejects.toThrow(
      'HTTP 422',
    );
    const markdown = readFileSync(join(directory, 'urls.md'), 'utf8');
    expect(markdown).toContain('/zh-Hant/w/');
    expect(markdown).not.toContain('/zh-Hant/e/');
    expect(markdown).toContain('/v1/sources/observations/');
  });

  test('exhausted202 replies stay pending and never enter native registry or completion', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      person = record('person', 'person');
    work.title = 'Fate/stay night';
    let attempts = 0;
    const api: DatasetApi = {
      wait: async () => {},
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk') {
          attempts++;
          return Promise.resolve({
            status: 202,
            body: { operationId: 'urn:pending', status: 'reconciling', result: null },
          });
        }
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(importDataset(directory, snapshot([work, person]), options(api))).rejects.toThrow(
      'remains pending',
    );
    expect(attempts).toBe(8);
    const journals = readdirSync(join(directory, 'imports')).filter((name) =>
      name.endsWith('.json'),
    );
    const journal = JSON.parse(readFileSync(join(directory, 'imports', journals[0]!), 'utf8'));
    expect(journal.completed).toBe(false);
    expect(Object.keys(journal.native)).toEqual(['work']);
    const context = journals[0]!.slice(0, -5),
      files = readdirSync(join(directory, 'imports', context, 'requests')).filter((name) =>
        name.endsWith('.json'),
      );
    const pending = files
      .map((name) => ({
        name,
        saved: JSON.parse(
          readFileSync(join(directory, 'imports', context, 'requests', name), 'utf8'),
        ),
      }))
      .find((item) => item.saved.label.startsWith('native-bulk:'))!;
    expect(pending.saved.entry).not.toHaveProperty('result');
    // Older clients' false pending cache is recognized and replayed exactly.
    pending.saved.entry.result = {
      operationId: 'urn:pending',
      status: 'reconciling',
      result: null,
    };
    writeFileSync(
      join(directory, 'imports', context, 'requests', pending.name),
      JSON.stringify(pending.saved),
    );
    const resumed = await importDataset(directory, snapshot([work, person]), options(fixture.api));
    expect(resumed.nativeRecords).toBe(2);
  });

  test('replacement bulk keys require an immutable sameepoch cancellation proof', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      person = record('person', 'person');
    work.title = 'Fate/stay night';
    const keys: string[] = [];
    const pending: DatasetApi = {
      wait: async () => {},
      bulkStatus: async () => ({
        state: 'unknown',
        admission: null,
        receipt: null,
        dataEpoch: null,
        stageCount: 0,
      }),
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk') {
          keys.push(key!);
          return Promise.resolve({ status: 202, body: { status: 'reconciling', result: null } });
        }
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(
      importDataset(directory, snapshot([work, person]), options(pending)),
    ).rejects.toThrow('remains pending');
    await expect(
      importDataset(directory, snapshot([work, person]), options(pending)),
    ).rejects.toThrow('remains pending');
    expect(new Set(keys).size).toBe(1);
    const proven: DatasetApi = {
      ...fixture.api,
      bulkStatus: async () => ({
        state: 'cancelled',
        admission: 'owner-admission',
        receipt: `urn:rezics:receipt:${'a'.repeat(64)}`,
        dataEpoch: 'epoch-1',
        stageCount: 0,
      }),
    };
    const complete = await importDataset(directory, snapshot([work, person]), options(proven));
    expect(complete.nativeRecords).toBe(2);
    const actual = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!;
    expect(actual.key).not.toBe(keys[0]);
    expect(complete.limitations.some((note) => note.includes('sealed cancellation'))).toBe(true);
  });

  test('canonicalizes real VNDB pt-br only in native labels and safely replaces unadmitted invalid projections', async () => {
    const fixture = apiFixture(),
      directory = root(),
      work = record('work', 'work'),
      producer = record('producer:p1074', 'organization');
    work.title = 'Fate/stay night';
    producer.language = 'pt-br';
    producer.data = { lang: 'pt-br', original: 'complete provider payload' };
    const source = snapshot([work, producer]);
    const neverAdmitted: DatasetApi = {
      wait: async () => {},
      bulkStatus: async () => ({
        state: 'unknown',
        admission: null,
        receipt: null,
        dataEpoch: null,
        stageCount: 0,
      }),
      request(method, path, body, key) {
        if (path === '/v1/semantic/changes/bulk')
          return Promise.resolve({ status: 400, body: { code: 'invalid_semantic_value' } });
        return fixture.api.request(method, path, body, key);
      },
    };
    await expect(importDataset(directory, source, options(neverAdmitted))).rejects.toThrow(
      'HTTP 400',
    );
    const journalName = readdirSync(join(directory, 'imports')).find((name) =>
      name.endsWith('.json'),
    )!;
    const folder = join(directory, 'imports', journalName.slice(0, -5), 'requests');
    const failed = readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        path: join(folder, name),
        saved: JSON.parse(readFileSync(join(folder, name), 'utf8')),
      }))
      .find((item) => item.saved.label.startsWith('native-bulk:'))!;
    failed.saved.entry.body.items[0].properties.find(
      (property: { predicate: string }) => property.predicate === 'https://schema.org/name',
    ).value.language = 'pt-br';
    writeFileSync(failed.path, JSON.stringify(failed.saved));
    const canonicalApi: DatasetApi = {
      ...neverAdmitted,
      request(method, path, body, key) {
        if (
          path === '/v1/semantic/changes/bulk' &&
          (
            body as {
              items: { properties: { predicate: string; value: { language?: string } }[] }[];
            }
          ).items[0]!.properties.some((property) => property.value.language === 'pt-br')
        )
          return Promise.resolve({ status: 400, body: { code: 'invalid_semantic_value' } });
        return fixture.api.request(method, path, body, key);
      },
    };
    const complete = await importDataset(directory, source, options(canonicalApi));
    expect(complete.nativeRecords).toBe(2);
    expect(
      JSON.parse(readFileSync(failed.path, 'utf8')).entry.body.items[0].properties[0].value
        .language,
    ).toBe('pt-br');
    expect(JSON.parse(readFileSync(failed.path, 'utf8')).entry.rejectionProof.status).toBe(400);
    const accepted = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { properties: { predicate: string; value: { language?: string } }[] }[] };
    expect(
      accepted.items[0]!.properties.find(
        (property) => property.predicate === 'https://schema.org/name',
      )!.value.language,
    ).toBe('pt-BR');
    const sourceIntake = fixture.requests.find(
      (call) =>
        call.path === '/v1/sources/intakes' &&
        (call.body as { externalId: string }).externalId === producer.externalId,
    )!.body as { rawBytesBase64: string };
    const retained = JSON.parse(Buffer.from(sourceIntake.rawBytesBase64, 'base64').toString());
    expect(retained.record.language).toBe('pt-br');
    expect(retained.record.data.lang).toBe('pt-br');
    expect(projectionLanguage('eng')).toBe('en');
    expect(projectionLanguage('{ja,en}')).toBe('und');
    expect(projectionLanguage('mul')).toBe('und');
  });

  test('catalogue imports keep stable item keys and retain partial successes for retry', async () => {
    const fixture = apiFixture(), directory = root(), works = [record('first','work'), record('second','work')];
    let once = true;
    const api: DatasetApi = { async request(method,path,body,key) {
      const response = await fixture.api.request(method,path,body,key);
      if (path === '/v1/work-imports/bulk' && once) {
        once = false;
        const result = structuredClone(response.body) as { items: { status: string; receipt?: unknown }[]; complete: boolean; partial: boolean };
        result.items[1]!.status = 'pending'; delete result.items[1]!.receipt; result.complete = false; result.partial = true;
        return { status: 200, body: result };
      }
      return response;
    } };
    await expect(importDataset(directory,snapshot(works),options(api))).rejects.toThrow('pending');
    await importDataset(directory,snapshot(works),options(api));
    const attempts = fixture.requests.filter(row => row.path === '/v1/work-imports/bulk');
    expect(attempts).toHaveLength(2); expect(attempts[0]!.body).toEqual(attempts[1]!.body);
  });

  test('one context has one writer, distinct contexts stay independent and released locks are reusable', () => {
    const first = sha256(crypto.randomUUID()),
      second = sha256(crypto.randomUUID());
    const releaseFirst = acquireDatasetImportLock(first),
      releaseSecond = acquireDatasetImportLock(second);
    try {
      expect(() => acquireDatasetImportLock(first)).toThrow('active writer');
    } finally {
      releaseFirst();
      releaseSecond();
    }
    const releaseAgain = acquireDatasetImportLock(first);
    releaseAgain();
    const stale = datasetImportLockPath(first);
    mkdirSync(stale);
    writeFileSync(join(stale, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    const releaseStale = acquireDatasetImportLock(first);
    releaseStale();
    expect(existsSync(stale)).toBe(false);
  });

  test('generic visibility uses one source-identity anchor while every qualified source relationship remains retained', async () => {
    const fixture = apiFixture(),
      z = record('work-z', 'work'),
      a = record('work-a', 'work'),
      tag = record('tag', 'concept');
    z.title = 'Z';
    a.title = 'A';
    tag.title = 'Shared trait';
    const source = snapshot([z, a, tag]);
    source.sources[0]!.edges = [
      { from: tag.key, to: z.key, kind: 'tagged-work', data: { spoiler: 2, score: 0.8 } },
      { from: tag.key, to: a.key, kind: 'tagged-work', data: { spoiler: 0, score: 0.9 } },
    ];
    const imported = await importDataset(root(), source, options(fixture.api));
    const aRequest = fixture.requests.find(
      (call) => call.path === '/v1/work-imports/bulk',
    )!;
    const aItems = fixture.receipts.get(aRequest.key!)!.items as { receipt: { work: string } }[];
    const aIndex = (aRequest.body as { items: { input: { title: string } }[] }).items.findIndex(item => item.input.title === 'A');
    const aIdentity = aItems[aIndex]!.receipt.work;
    const semantic = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { properties: { predicate: string; value: { ref?: string } }[] }[] };
    const anchors = semantic.items[0]!.properties.filter(
      (property) => property.predicate === 'https://rezics.com/vocab/semanticWork',
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.value.ref).toBe(aIdentity);
    const intake = fixture.requests.find(
      (call) =>
        call.path === '/v1/sources/intakes' &&
        (call.body as { externalId: string }).externalId === 'tag',
    )!.body as { rawBytesBase64: string };
    const retained = JSON.parse(Buffer.from(intake.rawBytesBase64, 'base64').toString());
    expect(retained.edges).toEqual(source.sources[0]!.edges);
    expect(imported.limitations.some((note) => note.includes('one representative Work'))).toBe(
      true,
    );
  });

  test('music and book source episodes do not acquire a television episode classification', async () => {
    const fixture = apiFixture(),
      work = record('book', 'work'),
      chapter = record('chapter', 'episode');
    work.title = 'A novel';
    work.semanticTypes = ['https://schema.org/Book'];
    await importDataset(root(), snapshot([work, chapter]), options(fixture.api));
    const bulk = fixture.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!
      .body as { items: { types: string[] }[] };
    expect(bulk.items[0]!.types).toEqual(['https://rezics.com/vocab/SourceDatasetEpisode']);
    const tv = apiFixture(),
      series = record('series', 'work'),
      episode = record('episode', 'episode');
    series.title = 'An anime series';
    series.semanticTypes = ['https://schema.org/TVSeries'];
    await importDataset(root(), snapshot([series, episode]), options(tv.api));
    const tvBulk = tv.requests.find((call) => call.path === '/v1/semantic/changes/bulk')!.body as {
      items: { types: string[] }[];
    };
    expect(tvBulk.items[0]!.types).toEqual(['https://schema.org/TVEpisode']);
  });

  test('rejects missing graph endpoints before writes and reports bounded partial imports', async () => {
    const fixture = apiFixture(),
      source = snapshot([record('v11'), record('c22')]);
    source.sources[0]!.edges[0]!.to = 'missing';
    await expect(importDataset(root(), source, options(fixture.api))).rejects.toThrow(
      'missing relationship endpoint',
    );
    expect(fixture.requests).toHaveLength(0);
    const partial = await importDataset(root(), snapshot([record('v11'), record('c22')]), {
      ...options(fixture.api),
      maxRecords: 1,
      native: false,
    });
    expect(partial.completed).toBe(false);
  });
});

test('development auth registers and installs a public client, consents and exchanges PKCE without owner-store access', async () => {
  const directory = root(),
    userId = crypto.randomUUID();
  mkdirSync(join(directory, 'web-auth'));
  writeFileSync(
    join(directory, 'dev.env'),
    'MAIN_ORIGIN=http://127.0.0.1:3301\nACCOUNT_ORIGIN=http://127.0.0.1:3304\nACCOUNT_SERVICE_ORIGIN=http://127.0.0.1:3302\nMAIN_DATA_EPOCH=00000000-0000-4000-8000-000000000111\n',
  );
  writeFileSync(
    join(directory, 'web-auth/public.json'),
    JSON.stringify({
      clientId: 'old-web-client',
      redirectUris: ['http://127.0.0.1:3300/auth/callback'],
      resource: 'https://main.rezics.test',
    }),
  );
  writeFileSync(
    join(directory, 'web-auth/private.json'),
    JSON.stringify({
      operator: { id: userId, email: 'test-operator@example.test', password: 'mock-password-only' },
    }),
  );
  const prior = globalThis.fetch,
    paths: string[] = [];
  const response = (body: unknown, status = 200, headers?: HeadersInit) =>
    Response.json(body, { status, headers });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === '/api/auth/sign-in/email')
      return response({ user: { id: userId } }, 200, { 'set-cookie': 'session=mock-fixture' });
    if (url.pathname === '/api/auth/oauth2/create-client') {
      expect(new Headers(init?.headers).get('x-account-reason')).toBeTruthy();
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('skip_consent');
      return response({ client_id: 'public-dataset-client' }, 201);
    }
    if (url.pathname === '/api/account/installations/public-dataset-client')
      return response({ error: 'not_found' }, 404);
    if (url.pathname === '/api/account/installation-changes') {
      expect(JSON.parse(String(init?.body))).toHaveProperty('change', 'install');
      return response({ state: 'active' });
    }
    if (url.pathname === '/api/account/policies')
      return response({ acceptanceRequired: false, policies: [] });
    if (url.pathname === '/api/auth/oauth2/authorize') {
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      return new Response(null, {
        status: 302,
        headers: {
          location: 'http://127.0.0.1:3304/consent?sig=mock-signed-query&scope=source%3Aintake',
        },
      });
    }
    if (url.pathname === '/api/account/consent') {
      expect(JSON.parse(String(init?.body))).toHaveProperty('accept', true);
      return response({
        redirect: true,
        url: 'http://127.0.0.1:3300/auth/callback?code=mock-code',
      });
    }
    if (url.pathname === '/api/auth/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code_verifier')?.length).toBeGreaterThan(30);
      return response({ access_token: 'mock-access-token-not-written' });
    }
    if (url.pathname === '/v1/agents') return response({ agent: iri(7777), state: 'active' }, 201);
    throw new Error(`Unexpected auth route ${url.pathname}`);
  }) as typeof fetch;
  const scope =
    'openid agent:create work:create work:edit work:read source:intake source:read classification:define classification:decide statement:write semantic:read';
  const clientPath = join(
    repository,
    '.temp/datasets',
    `oauth-${sha256(`http://127.0.0.1:3304:${userId}:${scope}:${datasetStackMarker('00000000-0000-4000-8000-000000000111', userId)}`)}.json`,
  );
  try {
    const session = await localDatasetSession(directory, 'operator');
    expect(session.actingSubject).toBe(iri(7777));
    expect(paths).not.toContain('/api/auth/admin/oauth2/create-client');
    expect(readFileSync(clientPath, 'utf8')).not.toContain('mock-access-token-not-written');
    expect(readFileSync(clientPath, 'utf8')).not.toContain('mock-password-only');
  } finally {
    globalThis.fetch = prior;
    rmSync(clientPath, { force: true });
  }
});
