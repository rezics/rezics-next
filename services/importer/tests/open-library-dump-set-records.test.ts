import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { admitOpenLibraryDumpSet } from '../src/open-library-dump-set.ts';
import { OpenLibraryDumpSetError } from '../src/open-library-dump-set.ts';
import { readOpenLibraryDumpSet } from '../src/open-library-dump-set-records.ts';
import { readDump } from '../src/dumps.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import workSource from '../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};

function row(record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } }) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return [record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t');
}

async function* bytes(text: string, size = 32) {
  const encoded = new TextEncoder().encode(text);
  for (let offset = 0; offset < encoded.length; offset += size) yield encoded.slice(offset, offset + size);
}

async function collect(text: string) {
  const records = [];
  for await (const record of readDump('openlibrary', bytes(text))) records.push(record.key);
  return records;
}

async function writeSet(
  root: string,
  files: { authors: string; works: string; editions: string },
  order: ('author' | 'work' | 'edition')[] = ['author', 'work', 'edition'],
) {
  const names = { author: 'authors.txt', work: 'works.txt', edition: 'editions.txt' } as const;
  await writeFile(join(root, names.author), files.authors, { mode: 0o600 });
  await writeFile(join(root, names.work), files.works, { mode: 0o600 });
  await writeFile(join(root, names.edition), files.editions, { mode: 0o600 });
  const path = join(root, 'manifest.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      source: 'openlibrary',
      members: order.map((family) => ({ family, path: names[family] })),
    }),
    { mode: 0o600 },
  );
  return path;
}

async function drain(root: string, manifest: string) {
  const admission = await admitOpenLibraryDumpSet(manifest);
  const handles = { value: 0 };
  const stream = readOpenLibraryDumpSet(admission, { signal: new AbortController().signal, handleCount: handles });
  const records = [];
  for await (const record of stream.records) records.push(record);
  expect(handles.value).toBe(0);
  return { records, stream };
}

test('composes members without fusing a missing trailing newline and matches single-stream keys', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-records-');
  try {
    const works = row(workSource);
    const editions = row(editionSource);
    const manifest = await writeSet(root, { authors: row(author), works, editions });
    await expect(collect(`${works}${editions}\n`)).rejects.toThrow();
    const separated = await collect(`${works}\n${editions}\n`);
    const { records, stream } = await drain(root, manifest);
    expect(records.map((record) => record.key)).toEqual(separated);
    expect(stream.digestHex()).toMatch(/^[a-f0-9]{64}$/);
    const files = [
      new TextEncoder().encode(row(author)),
      new TextEncoder().encode(works),
      new TextEncoder().encode(editions),
    ];
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file);
      const prefix = new Uint8Array(8);
      new DataView(prefix.buffer).setBigUint64(0, BigInt(file.byteLength));
      hash.update(prefix);
    }
    expect(stream.digestHex()).toBe(hash.digest('hex'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UTF-8 split chunks inside a member still decode and reverse member order keeps keys', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-utf8-');
  try {
    const works = `${row(workSource)}\n`;
    const editions = `${row(editionSource)}\n`;
    const manifest = await writeSet(root, { authors: `${row(author)}\n`, works, editions }, [
      'edition',
      'work',
      'author',
    ]);
    const { records } = await drain(root, manifest);
    expect(records.map((record) => record.key)).toEqual(['/books/OL900000002M', '/works/OL900000001W']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('declared-family mismatch, duplicate keys and a malformed final member invalidate the capture', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-invalid-');
  try {
    const mismatch = await writeSet(root, {
      authors: `${row(workSource)}\n`,
      works: `${row(workSource)}\n`,
      editions: `${row(editionSource)}\n`,
    });
    await expect(drain(root, mismatch)).rejects.toBeInstanceOf(OpenLibraryDumpSetError);

    const duplicate = await writeSet(root, {
      authors: `${row(author)}\n`,
      works: `${row(workSource)}\n${row(workSource)}\n`,
      editions: `${row(editionSource)}\n`,
    });
    const handles = { value: 0 };
    const admission = await admitOpenLibraryDumpSet(duplicate);
    const stream = readOpenLibraryDumpSet(admission, { signal: new AbortController().signal, handleCount: handles });
    const keys = [];
    for await (const record of stream.records) keys.push(record.key);
    expect(keys).toEqual(['/works/OL900000001W', '/works/OL900000001W', '/books/OL900000002M']);
    expect(handles.value).toBe(0);

    const broken = await writeSet(root, {
      authors: `${row(author)}\n`,
      works: `${row(workSource)}\n`,
      editions: '/type/edition\t/books/OL1M\t1\t2025-01-01\t{"key":',
    });
    await expect(drain(root, broken)).rejects.toMatchObject({ memberIndex: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized member record invalidates the capture', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-oversize-');
  try {
    const huge = {
      ...workSource,
      title: 'x'.repeat(200),
    };
    const manifest = await writeSet(root, {
      authors: `${row(author)}\n`,
      works: `${row(huge)}\n`,
      editions: `${row(editionSource)}\n`,
    });
    const admission = await admitOpenLibraryDumpSet(manifest);
    const handles = { value: 0 };
    const stream = readOpenLibraryDumpSet(admission, {
      signal: new AbortController().signal,
      handleCount: handles,
      maxRecordBytes: 64,
    });
    await expect(
      (async () => {
        for await (const _record of stream.records) {
          /* drain */
        }
      })(),
    ).rejects.toBeInstanceOf(OpenLibraryDumpSetError);
    expect(handles.value).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation closes the active member handle', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-cancel-');
  try {
    const manifest = await writeSet(root, {
      authors: `${row(author)}\n`,
      works: `${row(workSource)}\n`,
      editions: `${row(editionSource)}\n`,
    });
    const admission = await admitOpenLibraryDumpSet(manifest);
    const handles = { value: 0 };
    const controller = new AbortController();
    const stream = readOpenLibraryDumpSet(admission, { signal: controller.signal, handleCount: handles });
    const iterator = stream.records[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    controller.abort(new DOMException('Import interrupted', 'AbortError'));
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(handles.value).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function native() {
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  const requests: BatchWriteRequest[] = [];
  return {
    requests,
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        requests.push(structuredClone(request));
        return {
          results: request.commands.map((command) => {
            const bytes = JSON.stringify(command);
            const prior = receipts.get(command.key);
            if (prior) {
              expect(bytes).toBe(prior.bytes);
              return structuredClone(prior.result);
            }
            const result = {
              key: command.key,
              status: 201 as const,
              value:
                command.op === 'create'
                  ? { id: randomUUID(), revision: 1 }
                  : command.op === 'propose'
                    ? { candidate: randomUUID(), revision: 1 }
                    : { revision: 1 },
            };
            receipts.set(command.key, { bytes, result });
            return result;
          }),
        };
      },
    },
  };
}

test('same generation resolves an edition work link for both member orders', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-link-');
  try {
    for (const order of [
      ['author', 'work', 'edition'],
      ['edition', 'work', 'author'],
    ] as const) {
      const manifest = await writeSet(
        root,
        { authors: `${row(author)}\n`, works: `${row(workSource)}\n`, editions: `${row(editionSource)}\n` },
        [...order],
      );
      const admission = await admitOpenLibraryDumpSet(manifest);
      const handles = { value: 0 };
      const stream = readOpenLibraryDumpSet(admission, {
        signal: new AbortController().signal,
        handleCount: handles,
      });
      const host = native();
      const importer = new Importer({
        path: join(root, `${order.join('-')}.sqlite`),
        transport: host.transport,
        mediaResolver: {
          async resolve() {
            return { status: 'rejected' };
          },
        },
      });
      const registration = createSourceRegistration('openlibrary', { source: `books-${order[0]}` });
      try {
        expect((await importer.runDumpSet(registration, stream.records)).status).toBe('committed');
        expect(handles.value).toBe(0);
        const work = importer.session.bindings.claim({ source: registration.source, external_id: workSource.key });
        expect(work?.state).toBe('bound');
        if (work?.state !== 'bound') throw new Error('missing work');
        const relation = host.requests
          .flatMap((request) => request.commands)
          .find(
            (command) =>
              command.op === 'propose' &&
              command.source.external_id === editionSource.key &&
              command.statement.property.id === 'schema:exampleOfWork' &&
              command.statement.value.type === 'value',
          );
        expect(relation?.op === 'propose' ? relation.statement.value : undefined).toEqual({
          type: 'value',
          content: work.subject,
        });
      } finally {
        await importer.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate keys across members do not publish a partial capture', async () => {
  const root = await mkdtemp('/dev/shm/ol-dump-set-dup-');
  try {
    await writeFile(join(root, 'authors.txt'), `${row(author)}\n`, { mode: 0o600 });
    await writeFile(join(root, 'works-a.txt'), `${row(workSource)}\n`, { mode: 0o600 });
    await writeFile(join(root, 'works-b.txt'), `${row(workSource)}\n`, { mode: 0o600 });
    await writeFile(join(root, 'editions.txt'), `${row(editionSource)}\n`, { mode: 0o600 });
    const manifest = join(root, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        source: 'openlibrary',
        members: [
          { family: 'author', path: 'authors.txt' },
          { family: 'work', path: 'works-a.txt' },
          { family: 'work', path: 'works-b.txt' },
          { family: 'edition', path: 'editions.txt' },
        ],
      }),
      { mode: 0o600 },
    );
    const admission = await admitOpenLibraryDumpSet(manifest);
    const handles = { value: 0 };
    const stream = readOpenLibraryDumpSet(admission, { signal: new AbortController().signal, handleCount: handles });
    const host = native();
    const importer = new Importer({ path: join(root, 'state.sqlite'), transport: host.transport });
    try {
      const result = await importer.runDumpSet(createSourceRegistration('openlibrary'), stream.records);
      expect(result.status).toBe('invalid-dump');
      expect(host.requests).toEqual([]);
      expect(handles.value).toBe(0);
    } finally {
      await importer.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
