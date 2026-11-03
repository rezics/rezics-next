import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { DEFAULT_DECODED_DUMP_BYTES } from '../src/compressed-dump.ts';
import { Importer } from '../src/importer.ts';
import { admitOpenLibraryDumpSet } from '../src/open-library-dump-set.ts';
import { fingerprintOpenLibraryDumpSet, readOpenLibraryDumpSet } from '../src/open-library-dump-set-records.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import {
  STAGING_DECODER_DUMP_SET_ID,
  STAGING_DECODER_GZIP_ID,
  STAGING_DECODER_ZSTD_ID,
  STAGING_INCOMPATIBLE,
  captureDumpSetIdentity,
  captureFileIdentity,
  captureIdentity,
  emptyPrefixDigest,
  extendPrefixDigest,
  identitiesMatch,
  resumeStagingInvocation,
} from '../src/staging-checkpoint.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import workSource from '../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);

function wiki(id: number, title = `Title ${id}`) {
  const record = structuredClone(fixture);
  record.id = `Q${id}`;
  record.labels.en.value = title;
  for (const claims of Object.values(record.claims) as { id: string }[][])
    for (const claim of claims) claim.id = claim.id.replace(/^Q1\$/, `${record.id}$`);
  return record;
}

function wikiDump(records: ReturnType<typeof wiki>[]) {
  return `[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`;
}

function olLine(id: number, title: string) {
  const key = `/works/OL${id}W`;
  return `/type/work\t${key}\t1\t2020-01-01T00:00:00.000000\t${JSON.stringify({
    type: { key: '/type/work' },
    key,
    revision: 1,
    title,
  })}\n`;
}

function sha(bytes: string | Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fake() {
  const requests: BatchWriteRequest[] = [];
  return {
    requests,
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
        requests.push(structuredClone(request));
        return {
          results: request.commands.map((command) => ({
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          })),
        };
      },
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
    },
  };
}

function wrap(kind: 'wikidata' | 'openlibrary', convert: (n: number) => void) {
  const inner = createSourceRegistration(kind);
  let n = 0;
  return {
    registration: inner,
    observer: {
      onStagingConversion() {
        convert(++n);
      },
    },
    conversions: () => n,
  };
}

async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}

const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};

function row(
  record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } } & Record<string, unknown>,
) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

function extraWork(n: number) {
  return {
    ...workSource,
    key: `/works/OL90000001${n}W`,
    title: `Retained work ${n}`,
    covers: [],
  };
}

function rejectMedia() {
  return {
    async resolve() {
      return { status: 'rejected' as const };
    },
  };
}

async function mixedSet(root: string, works = [{ ...workSource, covers: [] }, extraWork(1), extraWork(2)]) {
  await writeFile(join(root, 'authors.txt.gz'), gzipSync(Buffer.from(row(author))), { mode: 0o600 });
  await writeFile(join(root, 'works.txt'), works.map(row).join(''), { mode: 0o600 });
  await writeFile(join(root, 'editions.txt.gz'), gzipSync(Buffer.from(row({ ...editionSource, covers: [] }))), { mode: 0o600 });
  const path = join(root, 'manifest.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      source: 'openlibrary',
      members: [
        { family: 'author', path: 'authors.txt.gz', compression: 'gzip' },
        { family: 'work', path: 'works.txt', compression: 'none' },
        { family: 'edition', path: 'editions.txt.gz', compression: 'gzip' },
      ],
    }),
    { mode: 0o600 },
  );
  return path;
}

test('version-2 identity binds gzip, zstd, dump-set members and the whole-set budget', () => {
  const gzipBytes = gzipSync(Buffer.from(olLine(1, 'Harbor')));
  const gzip = captureFileIdentity({
    sha256: sha(gzipBytes),
    bytes: gzipBytes.byteLength,
    sourceAlias: 'openlibrary',
    sourceKind: 'openlibrary',
    converterRevision: 'ol@1',
    disappearanceThreshold: 0.2,
    compression: 'gzip',
  });
  expect(gzip.checkpointVersion).toBe(2);
  expect(gzip.decoderId).toBe(STAGING_DECODER_GZIP_ID);
  expect(gzip.decodeBudget).toBe(DEFAULT_DECODED_DUMP_BYTES);
  expect(gzip.members).toEqual([
    { index: 0, family: null, compression: 'gzip', sha256: gzip.sha256, bytes: gzip.bytes },
  ]);
  const zstd = captureFileIdentity({
    sha256: 'a'.repeat(64),
    bytes: 12,
    sourceAlias: 'wikidata',
    sourceKind: 'wikidata',
    converterRevision: 'wd@1',
    disappearanceThreshold: 0.2,
    compression: 'zstd',
    decodeBudget: 1024,
  });
  expect(zstd.decoderId).toBe(STAGING_DECODER_ZSTD_ID);
  expect(zstd.decodeBudget).toBe(1024);
  const members = [
    { index: 0, family: 'author' as const, compression: 'gzip' as const, sha256: 'b'.repeat(64), bytes: 10 },
    { index: 1, family: 'work' as const, compression: 'none' as const, sha256: 'c'.repeat(64), bytes: 20 },
  ];
  const set = captureDumpSetIdentity({
    members,
    sourceAlias: 'openlibrary',
    converterRevision: 'ol@1',
    disappearanceThreshold: 0.2,
    manifestVersion: 2,
  });
  expect(set.decoderId).toBe(STAGING_DECODER_DUMP_SET_ID);
  expect(set.inputKind).toBe('dump-set');
  expect(set.bytes).toBe(30);
  expect(identitiesMatch(gzip, { ...gzip, decodeBudget: 1 })).toBe(false);
  expect(
    identitiesMatch(
      set,
      captureDumpSetIdentity({
        members: [
          { index: 0, family: 'work', compression: 'none', sha256: 'c'.repeat(64), bytes: 20 },
          { index: 1, family: 'author', compression: 'gzip', sha256: 'b'.repeat(64), bytes: 10 },
        ],
        sourceAlias: 'openlibrary',
        converterRevision: 'ol@1',
        disappearanceThreshold: 0.2,
        manifestVersion: 2,
      }),
    ),
  ).toBe(false);
  expect(resumeStagingInvocation('wikidata', '1', gzip)).toContain('--compression gzip');
  expect(resumeStagingInvocation('wikidata', '1', zstd)).toContain('--compression zstd');
  expect(resumeStagingInvocation('openlibrary', '1', set)).toContain('--dump-set');
  const v1 = extendPrefixDigest(emptyPrefixDigest(), { ordinal: 1, recordKey: 'Q1', digest: 'a'.repeat(64) });
  expect(extendPrefixDigest(emptyPrefixDigest(), { ordinal: 1, recordKey: 'Q1', digest: 'a'.repeat(64), memberIndex: 7 })).toBe(
    v1,
  );
  expect(
    extendPrefixDigest(emptyPrefixDigest(), { ordinal: 1, recordKey: 'Q1', digest: 'a'.repeat(64), memberIndex: 1 }, 2),
  ).not.toBe(extendPrefixDigest(emptyPrefixDigest(), { ordinal: 1, recordKey: 'Q1', digest: 'a'.repeat(64), memberIndex: 0 }, 2));
  expect(() =>
    captureDumpSetIdentity({
      members: [{ index: 0, family: 'author', compression: 'zstd', sha256: 'd'.repeat(64), bytes: 1 }],
      sourceAlias: 'openlibrary',
      converterRevision: 'ol@1',
      disappearanceThreshold: 0.2,
      manifestVersion: 2,
    }),
  ).toThrow(/Checkpointed staging admits/);
  expect(captureIdentity({ sha256: 'e'.repeat(64), bytes: 1, sourceAlias: 'wikidata', sourceKind: 'wikidata', converterRevision: 'wd@1', disappearanceThreshold: 0.2 }).checkpointVersion).toBe(1);
});

test('gzip Wikidata resume converts only the uncommitted suffix and a same-size unread rewrite stays incompatible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-gz-wd-'));
  const dump = wikiDump([wiki(11), wiki(12), wiki(13), wiki(14)]);
  const compressed = gzipSync(Buffer.from(dump));
  const identity = captureFileIdentity({
    sha256: sha(compressed),
    bytes: compressed.byteLength,
    sourceAlias: 'wikidata',
    sourceKind: 'wikidata',
    converterRevision: createSourceRegistration('wikidata').converter_revision,
    disappearanceThreshold: 0.2,
    compression: 'gzip',
  });
  const f = fake();
  const stop = new AbortController();
  const first = wrap('wikidata', (n) => {
    if (n === 3) {
      stop.abort(new DOMException('stop', 'AbortError'));
      throw stop.signal.reason;
    }
  });
  const importer = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: first.observer });
  try {
    const interrupted = await importer.runDump(first.registration, bytes(dump), {
      signal: stop.signal,
      checkpoint: { action: 'acquire', identity },
    });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.committedPrefix).toBe(2);
    expect(f.requests).toHaveLength(0);
    const rewritten = wikiDump([wiki(11), wiki(12), wiki(13), wiki(14, 'Title 99')]);
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(dump));
    const changed = await importer.runDump(createSourceRegistration('wikidata'), bytes(rewritten), {
      checkpoint: {
        action: 'resume',
        generation: '1',
        identity: captureFileIdentity({
          sha256: sha(gzipSync(Buffer.from(rewritten))),
          bytes: gzipSync(Buffer.from(rewritten)).byteLength,
          sourceAlias: identity.sourceAlias,
          sourceKind: identity.sourceKind,
          converterRevision: identity.converterRevision,
          disappearanceThreshold: identity.disappearanceThreshold,
          compression: 'gzip',
        }),
      },
    });
    expect(changed.status).toBe('invalid-dump');
    expect(changed.diagnostic).toBe(STAGING_INCOMPATIBLE);
    expect(importer.session.store.stagingCheckpoint('wikidata', '1')?.committedOrdinal).toBe(2);
  } finally {
    await importer.close();
  }
  const second = wrap('wikidata', () => {});
  const resumed = new Importer({ path: `${dir}/state.sqlite`, transport: f.transport, observer: second.observer });
  try {
    const result = await resumed.runDump(second.registration, bytes(dump), {
      checkpoint: { action: 'resume', generation: '1', identity },
    });
    expect(result.status).toBe('committed');
    expect(second.conversions()).toBe(2);
    expect(f.requests.length).toBeGreaterThan(0);
  } finally {
    await resumed.close();
    rmSync(dir, { recursive: true });
  }
});

test('dump-set frames complete authors without records, resume skips the prefix, and a truncated final member keeps the baseline', async () => {
  const root = await mkdtemp('/dev/shm/staging-ol-set-');
  try {
    const manifest = await mixedSet(root);
    const admission = await admitOpenLibraryDumpSet(manifest);
    const handles = { value: 0 };
    const members = await fingerprintOpenLibraryDumpSet(admission, {
      signal: new AbortController().signal,
      handleCount: handles,
    });
    expect(members.map((member) => member.compression)).toEqual(['gzip', 'none', 'gzip']);
    const identity = captureDumpSetIdentity({
      members,
      sourceAlias: 'openlibrary',
      converterRevision: createSourceRegistration('openlibrary').converter_revision,
      disappearanceThreshold: 0.2,
      manifestVersion: 2,
    });
    const frames = [];
    for await (const event of readOpenLibraryDumpSet(admission, {
      signal: new AbortController().signal,
      handleCount: handles,
    }).frames)
      frames.push(event.kind === 'member-end' ? event : { kind: event.kind, memberIndex: event.memberIndex, key: event.record.key });
    expect(frames.filter((event) => event.kind === 'member-end').map((event) => event.memberIndex)).toEqual([0, 1, 2]);
    expect(frames.filter((event) => event.kind === 'record' && event.memberIndex === 0)).toEqual([]);

    const edgeStop = new AbortController();
    const edgeWrap = wrap('openlibrary', (n) => {
      if (n === 1) {
        edgeStop.abort(new DOMException('stop', 'AbortError'));
        throw edgeStop.signal.reason;
      }
    });
    const edgeHost = fake();
    const edge = new Importer({
      path: join(root, 'edge.sqlite'),
      transport: edgeHost.transport,
      observer: edgeWrap.observer,
      mediaResolver: rejectMedia(),
    });
    try {
      const interrupted = await edge.runDumpSet(
        edgeWrap.registration,
        readOpenLibraryDumpSet(admission, { signal: edgeStop.signal, handleCount: handles }).frames,
        { signal: edgeStop.signal, checkpoint: { action: 'acquire', identity } },
      );
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.committedPrefix).toBe(0);
      expect(interrupted.runId).toBe('1');
      expect(edge.session.store.stagingCheckpoint(edgeWrap.registration.source, interrupted.runId!)?.completedMembers).toBe(1);
      expect(edgeHost.requests).toHaveLength(0);
    } finally {
      await edge.close();
    }

    const f = fake();
    const stop = new AbortController();
    const first = wrap('openlibrary', (n) => {
      if (n === 2) {
        stop.abort(new DOMException('stop', 'AbortError'));
        throw stop.signal.reason;
      }
    });
    const importer = new Importer({
      path: join(root, 'state.sqlite'),
      transport: f.transport,
      observer: first.observer,
      mediaResolver: rejectMedia(),
    });
    try {
      const interrupted = await importer.runDumpSet(
        first.registration,
        readOpenLibraryDumpSet(admission, { signal: stop.signal, handleCount: handles }).frames,
        { signal: stop.signal, checkpoint: { action: 'acquire', identity } },
      );
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.committedPrefix).toBe(1);
      expect(importer.session.store.stagingCheckpoint(first.registration.source, '1')?.completedMembers).toBe(1);
      expect(f.requests).toHaveLength(0);
    } finally {
      await importer.close();
    }
    const second = wrap('openlibrary', () => {});
    const resumed = new Importer({
      path: join(root, 'state.sqlite'),
      transport: f.transport,
      observer: second.observer,
      mediaResolver: rejectMedia(),
    });
    try {
      const result = await resumed.runDumpSet(
        second.registration,
        readOpenLibraryDumpSet(admission, { signal: new AbortController().signal, handleCount: handles }).frames,
        { checkpoint: { action: 'resume', generation: '1', identity } },
      );
      expect(result.status).toBe('committed');
      expect(second.conversions()).toBe(3);
      expect(f.requests.length).toBeGreaterThan(0);
    } finally {
      await resumed.close();
    }

    await writeFile(join(root, 'editions.txt.gz'), gzipSync(Buffer.from(row(editionSource))).subarray(0, 8), { mode: 0o600 });
    const broken = await admitOpenLibraryDumpSet(manifest);
    const brokenMembers = await fingerprintOpenLibraryDumpSet(broken, {
      signal: new AbortController().signal,
      handleCount: handles,
    });
    const late = fake();
    const failing = new Importer({
      path: join(root, 'late.sqlite'),
      transport: late.transport,
      mediaResolver: rejectMedia(),
    });
    try {
      const result = await failing.runDumpSet(
        createSourceRegistration('openlibrary'),
        readOpenLibraryDumpSet(broken, { signal: new AbortController().signal, handleCount: handles }).frames,
        {
          checkpoint: {
            action: 'acquire',
            identity: captureDumpSetIdentity({
              members: brokenMembers,
              sourceAlias: 'openlibrary',
              converterRevision: createSourceRegistration('openlibrary').converter_revision,
              disappearanceThreshold: 0.2,
              manifestVersion: 2,
            }),
          },
        },
      );
      expect(result.status).toBe('invalid-dump');
      expect(result.committedPrefix).toBeGreaterThan(0);
      expect(late.requests).toHaveLength(0);
      expect(failing.session.store.peekActive(createSourceRegistration('openlibrary').source)?.status).not.toBe('ready');
    } finally {
      await failing.close();
    }
    expect(handles.value).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
