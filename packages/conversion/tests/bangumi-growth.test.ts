import { expect, spyOn, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { checkMediaImportRequest } from '@rezics/definitions/media-import';
import { documentText, parseDocument, serializeDocument } from '@rezics/document';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as childProcess from 'node:child_process';
import { convertBangumi, converter_revision } from '../src/bangumi.ts';
import { ConversionError } from '../src/index.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const mediaId = '00000000-0000-4000-8000-000000000002';
const url = 'https://lain.bgm.tv/pic/cover/l/ab/cd/42.jpg';

// One seed varies source fields, without a catalogue fixture or growing converter cache.
function seed(count: number) {
  const record = {
    id: 42,
    type: 1,
    name: 'Original title',
    name_cn: '中文名',
    summary: '**Literal**\r\nFull summary.\nEND',
    images: { large: url },
    platform: 'Book',
    tags: Array.from({ length: count }, (_, i) => ({ name: `tag-${i.toString().padStart(3, '0')}` })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(record));
  let visits = 0;
  const track = <T extends object>(value: T): T =>
    new Proxy(value, {
      get(target, key, receiver) {
        visits++;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        visits++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        visits++;
        return Reflect.ownKeys(target);
      },
    });
  const observed = track({
    ...record,
    images: track(record.images),
    tags: track(record.tags.map(track)),
  });
  return {
    record,
    bytes,
    input: { external_id: '42', record_revision: 'native:7', record: observed },
    visits: () => visits,
  };
}

test('pure converter growth stays within its declared field and byte cap', () => {
  const observations = [1, 8, 64].map((count) => {
    const sample = seed(count);
    const output = convertBangumi(sample.input, { subjectId });
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
    expect(output.proposals.length).toBeGreaterThan(0);
    expect(output.proposals.length).toBeLessThanOrEqual(100);
    expect(sample.visits()).toBeGreaterThanOrEqual(count);
    expect(sample.visits()).toBeLessThanOrEqual(100 + count * 12);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16_384 + sample.bytes * 8);
    return { bytes: sample.bytes, visits: sample.visits(), count: output.proposals.length, digest: output.digest };
  });
  expect(observations[1]!.bytes).toBeGreaterThan(observations[0]!.bytes);
  expect(observations[2]!.bytes).toBeGreaterThan(observations[1]!.bytes);
  expect(observations[2]!.visits).toBeGreaterThan(observations[1]!.visits);
  expect(new Set(observations.map((value) => value.digest)).size).toBe(3);
  expect(new Set(observations.map((value) => value.count)).size).toBe(1);
  expect(() => convertBangumi(seed(65).input)).toThrow(ConversionError);
  const sample = seed(1);
  expect(() => convertBangumi({ ...sample.input, record: { ...sample.record, infobox: 'x'.repeat(65_537) } })).toThrow(
    ConversionError,
  );
});

test('fixed source conversion intercepts I/O at every unrelated population scale', () => {
  const spies: { mockRestore(): void }[] = [];
  const attempts: string[] = [];
  function deny<T extends object>(target: T, key: keyof T) {
    spies.push(
      spyOn(target, key as never).mockImplementation((() => {
        attempts.push(String(key));
        throw new Error('Unexpected source I/O');
      }) as never),
    );
  }
  try {
    deny(globalThis, 'fetch');
    for (const key of ['SQL', 'file', 'write', 'spawn', 'spawnSync', 'connect', 'listen'] as const) deny(Bun, key);
    for (const key of ['readFileSync', 'writeFileSync', 'openSync', 'readdirSync'] as const) deny(fs, key);
    for (const key of ['connect', 'createConnection'] as const) deny(net, key);
    for (const boundary of [http, https]) for (const key of ['get', 'request'] as const) deny(boundary, key);
    for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] as const)
      deny(childProcess, key);
    let baseline: unknown;
    for (const scale of [1, 8, 64]) {
      // Unrelated N and U x t are deliberately inaccessible to the converter.
      const unrelated = { N: Array.from({ length: scale }, (_, id) => id), history: new Uint8Array(scale * scale) };
      expect(unrelated.history.length).toBe(scale * scale);
      const output = convertBangumi(seed(8).input, { subjectId });
      if (baseline === undefined) baseline = output;
      else expect(output).toEqual(baseline);
      expect(() => convertBangumi({ external_id: '42', record_revision: null, record: { id: -1 } })).toThrow(
        ConversionError,
      );
    }
    expect(attempts).toEqual([]);
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
});

test('source digest excludes target bindings and registration while sanitized data can be rebound', () => {
  const sample = seed(8);
  const bootstrap = convertBangumi(sample.input);
  const resolved = convertBangumi(sample.input, { subjectId, mediaIds: { [url]: mediaId } });
  const registered = convertBangumi(sample.input, { subjectId }, { converterRevision: 'bangumi-next' });
  expect(bootstrap.converter_revision).toBe(converter_revision);
  expect(registered.converter_revision).toBe('bangumi-next');
  expect(registered.digest).toBe(bootstrap.digest);
  expect(resolved.digest).toBe(bootstrap.digest);
  expect(
    convertBangumi(
      { ...sample.input, record: bootstrap.normalizedRecord },
      { subjectId, mediaIds: { [url]: mediaId } },
    ),
  ).toEqual(resolved);
  const changed = convertBangumi({ ...sample.input, record: { ...sample.record, platform: 'Paperback' } });
  expect(changed.digest).not.toBe(bootstrap.digest);
  expect(convertBangumi({ ...sample.input, record: { ...sample.record, unknown: { secret: 'PRIVATE' } } })).toEqual(
    bootstrap,
  );
  expect(convertBangumi({ ...sample.input, record_revision: null }).record_revision).toBe('unversioned');
  expect(bootstrap.proposals).toHaveLength(1);
  expect(bootstrap.proposals[0]!.op).toBe('create');
  expect(bootstrap.mediaImportIntents).toEqual([]);
  expect(bootstrap.coverAssets[0]).not.toHaveProperty('containerId');
  expect(resolved.mediaImportIntents).toHaveLength(1);
  expect(checkMediaImportRequest(resolved.mediaImportIntents[0])).toEqual([]);
  expect(resolved.mediaImportIntents[0]!.containerId).toBe(subjectId);
  expect(resolved.mediaImportIntents[0]!.credit.license).toBe('LicenseRef-unknown');
});

test('full literal text is bounded by the serialized document budget and malformed public fields reject safely', () => {
  const sample = seed(1);
  const output = convertBangumi(sample.input, { subjectId });
  const summary = output.proposals.find(
    (command) => command.op === 'propose' && command.source.field_group === 'summary',
  );
  expect(summary?.op).toBe('propose');
  if (summary?.op !== 'propose' || summary.statement.value.type !== 'value') throw new Error('Expected real summary');
  const content = summary.statement.value.content as { document: unknown };
  const document = parseDocument(content.document);
  expect(documentText(document)).toBe(sample.record.summary);
  expect(Buffer.byteLength(serializeDocument(document))).toBeLessThanOrEqual(32_768);
  for (const patch of [
    { summary: 'x'.repeat(32_768) },
    { name_cn: 7 },
    { tags: [{ name: '' }] },
    { tags: [{ name: 'x'.repeat(201) }] },
    { images: { large: 'https://lain.bgm.tv:443/a.jpg' } },
  ]) {
    try {
      convertBangumi({ ...sample.input, record: { ...sample.record, ...patch } });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionError);
      expect((error as Error).message).not.toContain('x'.repeat(200));
    }
  }
});
